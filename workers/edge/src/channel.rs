//! `ChannelDo`: one Durable Object per channel.
//!
//! It owns three things:
//! 1. The event log, in the object's SQLite storage. Every event gets the next
//!    sequence number (1, 2, 3, ... with no gaps) and is written before it is
//!    sent anywhere. The runtime's output gate holds outgoing frames and the HTTP
//!    response until that write is durable, so a client can never see an event
//!    the log does not have.
//! 2. The alert queue, also in SQLite, so pause, mute, the alert on screen and
//!    the queue length are readable state that survives restarts.
//! 3. The realtime sockets (overlays, dashboard, Cortex), accepted with the
//!    hibernation API so idle overlays cost nothing.
//!
//! An alarm guards the alert on screen: if no overlay acknowledges it within
//! [`ALERT_TIMEOUT_MS`], it is put back in the queue when no overlay is
//! connected, or marked timed out when one is (a broken widget should not block
//! every alert after it).

use std::cell::Cell;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sylva_core::protocol::{
    AlertAction, AlertState, ClientFrame, Role, ServerFrame, PING, PONG, REPLAY_LIMIT,
};
use sylva_core::{Event, StoredEvent};
use worker::*;

/// How long an overlay may take to acknowledge an alert before the queue moves on.
pub const ALERT_TIMEOUT_MS: i64 = 30_000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS events (
    seq         INTEGER PRIMARY KEY,
    event_id    TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    body        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_seq  INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued',
    priority   INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    ended_at   INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status, priority DESC, id);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
";

/// What we keep on each socket. It survives hibernation.
#[derive(Serialize, Deserialize)]
struct SocketInfo {
    role: Role,
}

#[derive(Deserialize)]
struct EventRow {
    seq: f64,
    received_at: f64,
    body: String,
}

#[derive(Deserialize)]
struct AlertRow {
    id: f64,
    event_seq: f64,
    started_at: Option<f64>,
}

#[derive(Deserialize)]
struct CountRow {
    n: f64,
}

#[derive(Deserialize)]
struct ValueRow {
    value: f64,
}

/// The reply to `POST /ingest`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    pub seq: u64,
    pub duplicate: bool,
}

#[durable_object]
pub struct ChannelDo {
    state: State,
    sql: SqlStorage,
    /// Highest seq in the log. Kept in memory so assigning the next one needs no read.
    head: Cell<u64>,
}

impl DurableObject for ChannelDo {
    fn new(state: State, _env: Env) -> Self {
        let sql = state.storage().sql();
        for stmt in SCHEMA.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            sql.exec(stmt, None).expect("schema");
        }
        let head = sql
            .exec("SELECT COALESCE(MAX(seq), 0) AS value FROM events", None)
            .and_then(|c| c.one::<ValueRow>())
            .map(|r| r.value as u64)
            .unwrap_or(0);
        // Keepalive pings are answered by the runtime without waking us.
        if let Ok(pair) = WebSocketRequestResponsePair::new(PING, PONG) {
            state.set_websocket_auto_response(&pair);
        }
        Self {
            state,
            sql,
            head: Cell::new(head),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        let path = url.path().to_string();
        let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
        match (req.method(), segs.as_slice()) {
            (Method::Post, ["ingest"]) => {
                let event: Event = req.json().await?;
                Response::from_json(&self.ingest(event).await?)
            }
            (Method::Post, ["ingest-batch"]) => {
                let events: Vec<Event> = req.json().await?;
                let mut results = Vec::with_capacity(events.len());
                for e in events {
                    results.push(self.ingest(e).await?);
                }
                Response::from_json(&results)
            }
            (Method::Get, ["ws"]) => {
                let is_upgrade = req
                    .headers()
                    .get("Upgrade")?
                    .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
                if !is_upgrade {
                    return Response::error("Expected a websocket upgrade", 426);
                }
                let pair = WebSocketPair::new()?;
                self.state.accept_web_socket(&pair.server);
                Response::from_websocket(pair.client)
            }
            (Method::Get, ["state"]) => Response::from_json(&self.alert_state()?),
            (Method::Get, ["events"]) => {
                let q: std::collections::HashMap<String, String> =
                    url.query_pairs().into_owned().collect();
                let after = q.get("after").and_then(|v| v.parse().ok()).unwrap_or(0u64);
                let limit = q
                    .get("limit")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(100u64)
                    .min(REPLAY_LIMIT);
                Response::from_json(&self.events_after(after, limit)?)
            }
            (Method::Post, ["alerts", "replay", seq]) => {
                let seq: u64 = seq
                    .parse()
                    .map_err(|_| Error::RustError("bad seq".into()))?;
                self.replay(seq).await?;
                Response::from_json(&self.alert_state()?)
            }
            (Method::Post, ["alerts", "play-next", id]) => {
                let id: u64 = id.parse().map_err(|_| Error::RustError("bad id".into()))?;
                self.sql.exec(
                    "UPDATE alerts SET priority = 1 WHERE id = ? AND status = 'queued'",
                    vec![(id as i64).into()],
                )?;
                self.broadcast_state()?;
                Response::from_json(&self.alert_state()?)
            }
            (Method::Post, ["alerts", action]) => {
                let action: AlertAction =
                    serde_json::from_value(serde_json::Value::String(action.to_string()))
                        .map_err(|_| Error::RustError("unknown action".into()))?;
                self.control(action).await?;
                Response::from_json(&self.alert_state()?)
            }
            _ => Response::error("Not found", 404),
        }
    }

    async fn alarm(&self) -> Result<Response> {
        let now = Date::now().as_millis() as i64;
        if let Some(p) = self.playing()? {
            let started = p.started_at.unwrap_or(0.0) as i64;
            if now - started >= ALERT_TIMEOUT_MS {
                if self.sockets(Role::Overlay).is_empty() {
                    // Nobody is watching: keep it for when OBS comes back.
                    self.sql.exec(
                        "UPDATE alerts SET status = 'queued', started_at = NULL WHERE id = ?",
                        vec![(p.id as i64).into()],
                    )?;
                } else {
                    self.finish(p.id as u64, "timeout")?;
                }
            } else {
                let left = (started + ALERT_TIMEOUT_MS - now).max(1) as u64;
                self.state
                    .storage()
                    .set_alarm(Duration::from_millis(left))
                    .await?;
                return Response::ok("waiting");
            }
        }
        if self.dispatch().await?.is_none() {
            self.broadcast_state()?;
        }
        Response::ok("ok")
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let WebSocketIncomingMessage::String(text) = message else {
            return Ok(());
        };
        let frame: ClientFrame = match serde_json::from_str(&text) {
            Ok(f) => f,
            Err(e) => {
                let _ = send(
                    &ws,
                    &ServerFrame::Error {
                        message: e.to_string(),
                    },
                );
                return Ok(());
            }
        };
        match frame {
            ClientFrame::Hello { role, last_seq } => {
                ws.serialize_attachment(SocketInfo { role })?;
                let mut truncated = false;
                if let Some(after) = last_seq {
                    let missed = self.head.get().saturating_sub(after);
                    truncated = missed > REPLAY_LIMIT;
                    for ev in self.events_after(after, REPLAY_LIMIT)? {
                        send(&ws, &ServerFrame::Event(ev))?;
                    }
                }
                send(
                    &ws,
                    &ServerFrame::Ready {
                        head_seq: self.head.get(),
                        replay_truncated: truncated,
                        state: self.alert_state()?,
                    },
                )?;
                if role == Role::Overlay {
                    // An OBS reload lands here: show the alert it was in the middle of.
                    if let Some(p) = self.playing()? {
                        self.send_play(&ws, p.id as u64, p.event_seq as u64)?;
                    } else if self.dispatch().await?.is_some() {
                        return Ok(());
                    }
                    self.broadcast_state()?;
                }
            }
            ClientFrame::Ack { alert_id } => {
                if self.playing()?.is_some_and(|p| p.id as u64 == alert_id) {
                    self.finish(alert_id, "done")?;
                    if self.dispatch().await?.is_none() {
                        self.broadcast_state()?;
                    }
                }
            }
            ClientFrame::Ping => {
                ws.send_with_str(PONG)?;
            }
        }
        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        // Complete the close handshake. 1005 and 1006 are reserved and cannot be sent.
        let code = if code == 1005 || code == 1006 {
            1000
        } else {
            code as u16
        };
        let _ = ws.close(Some(code), Some("bye"));
        Ok(())
    }

    async fn websocket_error(&self, _ws: WebSocket, _error: Error) -> Result<()> {
        Ok(())
    }
}

fn send(ws: &WebSocket, frame: &ServerFrame) -> Result<()> {
    ws.send_with_str(serde_json::to_string(frame)?)
}

impl ChannelDo {
    /// Store an event, then fan it out. Everything here is synchronous, so no
    /// other request can run in between and sequence numbers stay in order.
    async fn ingest(&self, event: Event) -> Result<IngestResult> {
        // Twitch retries a delivery with the same message id: keep the first.
        let existing = self
            .sql
            .exec(
                "SELECT seq AS value FROM events WHERE event_id = ?",
                vec![event.id.as_str().into()],
            )?
            .to_array::<ValueRow>()?;
        if let Some(row) = existing.first() {
            return Ok(IngestResult {
                seq: row.value as u64,
                duplicate: true,
            });
        }

        let seq = self.head.get() + 1;
        let received_at = Date::now().as_millis() as i64;
        let body = serde_json::to_string(&event)?;
        let kind = serde_json::to_value(event.kind)?
            .as_str()
            .unwrap_or("other")
            .to_string();
        self.sql.exec(
            "INSERT INTO events (seq, event_id, kind, received_at, body) VALUES (?, ?, ?, ?, ?)",
            vec![
                (seq as i64).into(),
                event.id.as_str().into(),
                kind.into(),
                received_at.into(),
                body.into(),
            ],
        )?;
        self.head.set(seq);
        let is_alert = event.kind.is_alert();
        if is_alert {
            self.sql.exec(
                "INSERT INTO alerts (event_seq) VALUES (?)",
                vec![(seq as i64).into()],
            )?;
        }

        let stored = StoredEvent {
            seq,
            received_at,
            event,
        };
        let text = serde_json::to_string(&ServerFrame::Event(stored))?;
        for ws in self.state.get_websockets() {
            if ws
                .deserialize_attachment::<SocketInfo>()
                .ok()
                .flatten()
                .is_some()
            {
                let _ = ws.send_with_str(&text);
            }
        }
        if is_alert && self.dispatch().await?.is_none() {
            // Feeds show the queue length, so tell them it grew.
            self.broadcast_state()?;
        }
        Ok(IngestResult {
            seq,
            duplicate: false,
        })
    }

    fn events_after(&self, after: u64, limit: u64) -> Result<Vec<StoredEvent>> {
        let rows = self
            .sql
            .exec(
                "SELECT seq, received_at, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
                vec![(after as i64).into(), (limit as i64).into()],
            )?
            .to_array::<EventRow>()?;
        rows.into_iter()
            .map(|r| {
                Ok(StoredEvent {
                    seq: r.seq as u64,
                    received_at: r.received_at as i64,
                    event: serde_json::from_str(&r.body)?,
                })
            })
            .collect()
    }

    fn event(&self, seq: u64) -> Result<StoredEvent> {
        self.events_after(seq - 1, 1)?
            .into_iter()
            .next()
            .filter(|e| e.seq == seq)
            .ok_or_else(|| Error::RustError(format!("no event {seq}")))
    }

    fn sockets(&self, role: Role) -> Vec<WebSocket> {
        self.state
            .get_websockets()
            .into_iter()
            .filter(|ws| {
                ws.deserialize_attachment::<SocketInfo>()
                    .ok()
                    .flatten()
                    .is_some_and(|i| i.role == role)
            })
            .collect()
    }

    fn setting(&self, key: &str) -> Result<bool> {
        let rows = self
            .sql
            .exec("SELECT value FROM settings WHERE key = ?", vec![key.into()])?
            .to_array::<ValueRow>()?;
        Ok(rows.first().is_some_and(|r| r.value != 0.0))
    }

    fn set_setting(&self, key: &str, on: bool) -> Result<()> {
        self.sql.exec(
            "INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            vec![key.into(), (on as i64).into()],
        )?;
        Ok(())
    }

    fn playing(&self) -> Result<Option<AlertRow>> {
        Ok(self
            .sql
            .exec(
                "SELECT id, event_seq, started_at FROM alerts WHERE status = 'playing' LIMIT 1",
                None,
            )?
            .to_array::<AlertRow>()?
            .into_iter()
            .next())
    }

    fn alert_state(&self) -> Result<AlertState> {
        let queued = self
            .sql
            .exec(
                "SELECT COUNT(*) AS n FROM alerts WHERE status = 'queued'",
                None,
            )?
            .one::<CountRow>()?
            .n as u64;
        Ok(AlertState {
            paused: self.setting("paused")?,
            muted: self.setting("muted")?,
            playing: self.playing()?.map(|p| p.id as u64),
            queued,
            overlays_connected: self.sockets(Role::Overlay).len() as u64,
        })
    }

    fn broadcast_state(&self) -> Result<()> {
        let text = serde_json::to_string(&ServerFrame::State(self.alert_state()?))?;
        for ws in self.state.get_websockets() {
            if ws
                .deserialize_attachment::<SocketInfo>()
                .ok()
                .flatten()
                .is_some()
            {
                let _ = ws.send_with_str(&text);
            }
        }
        Ok(())
    }

    fn finish(&self, alert_id: u64, status: &str) -> Result<()> {
        self.sql.exec(
            "UPDATE alerts SET status = ?, ended_at = ? WHERE id = ?",
            vec![
                status.into(),
                (Date::now().as_millis() as i64).into(),
                (alert_id as i64).into(),
            ],
        )?;
        Ok(())
    }

    fn send_play(&self, ws: &WebSocket, alert_id: u64, event_seq: u64) -> Result<()> {
        let frame = ServerFrame::Play {
            alert_id,
            muted: self.setting("muted")?,
            event: self.event(event_seq)?,
        };
        send(ws, &frame)
    }

    /// Start the next alert if nothing is playing, the queue is not paused and
    /// an overlay is there to show it. Returns the alert started, if any.
    /// [`Self::start_next`], then arm the timeout alarm for the alert it started.
    /// All state changes happen before the first await.
    async fn dispatch(&self) -> Result<Option<u64>> {
        let started = self.start_next()?;
        if started.is_some() {
            self.state
                .storage()
                // Careful: an i64 here is an offset from now, not a timestamp.
                .set_alarm(Duration::from_millis(ALERT_TIMEOUT_MS as u64))
                .await?;
        }
        Ok(started)
    }

    fn start_next(&self) -> Result<Option<u64>> {
        if self.setting("paused")? || self.playing()?.is_some() {
            return Ok(None);
        }
        let overlays = self.sockets(Role::Overlay);
        if overlays.is_empty() {
            return Ok(None);
        }
        let next = self
            .sql
            .exec(
                "SELECT id, event_seq, started_at FROM alerts WHERE status = 'queued'
                 ORDER BY priority DESC, id LIMIT 1",
                None,
            )?
            .to_array::<AlertRow>()?;
        let Some(next) = next.into_iter().next() else {
            return Ok(None);
        };
        let now = Date::now().as_millis() as i64;
        self.sql.exec(
            "UPDATE alerts SET status = 'playing', started_at = ? WHERE id = ?",
            vec![now.into(), (next.id as i64).into()],
        )?;
        for ws in &overlays {
            let _ = self.send_play(ws, next.id as u64, next.event_seq as u64);
        }
        self.broadcast_state()?;
        Ok(Some(next.id as u64))
    }

    async fn replay(&self, seq: u64) -> Result<()> {
        // Check the event exists, then queue it to play next.
        self.event(seq)?;
        self.sql.exec(
            "INSERT INTO alerts (event_seq, priority) VALUES (?, 1)",
            vec![(seq as i64).into()],
        )?;
        if self.dispatch().await?.is_none() {
            self.broadcast_state()?;
        }
        Ok(())
    }

    async fn control(&self, action: AlertAction) -> Result<()> {
        match action {
            AlertAction::Pause => self.set_setting("paused", true)?,
            AlertAction::Resume => self.set_setting("paused", false)?,
            AlertAction::Mute => self.set_setting("muted", true)?,
            AlertAction::Unmute => self.set_setting("muted", false)?,
            AlertAction::Skip => {
                if let Some(p) = self.playing()? {
                    self.finish(p.id as u64, "skipped")?;
                    let stop = serde_json::to_string(&ServerFrame::Stop {
                        alert_id: p.id as u64,
                    })?;
                    for ws in self.sockets(Role::Overlay) {
                        let _ = ws.send_with_str(&stop);
                    }
                }
            }
        }
        if self.dispatch().await?.is_none() {
            self.broadcast_state()?;
        }
        Ok(())
    }
}

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

use std::cell::{Cell, RefCell};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sylva_core::alerts::{AlertSettings, Invalid};
use sylva_core::protocol::{
    AlertAction, AlertState, ClientFrame, Role, ServerFrame, PING, PONG, REPLAY_LIMIT,
};
use sylva_core::scene::{Published, Scene, SceneState, TopEntry, VersionInfo, KEPT_VERSIONS};
use sylva_core::widgets::{
    GoalKind, GoalView, WidgetData, WidgetSettings, CHAT_LIMIT, LATEST_KINDS, LIST_KINDS,
    RECENT_LIMIT,
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
CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scene_versions (
    version      INTEGER PRIMARY KEY,
    published_at INTEGER NOT NULL,
    body         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_cooldowns (
    key TEXT PRIMARY KEY,
    at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mod_strikes (
    user_id TEXT PRIMARY KEY,
    count   INTEGER NOT NULL,
    last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mod_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    user_id   TEXT NOT NULL,
    user      TEXT NOT NULL,
    rule      TEXT NOT NULL,
    message   TEXT NOT NULL,
    action    TEXT NOT NULL,
    seconds   INTEGER NOT NULL,
    result    TEXT NOT NULL,
    detail    TEXT,
    undone_at INTEGER
);
CREATE TABLE IF NOT EXISTS quotes (
    id      INTEGER PRIMARY KEY,
    text    TEXT NOT NULL,
    said_by TEXT NOT NULL,
    game    TEXT NOT NULL,
    at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS timer_state (
    id    TEXT PRIMARY KEY,
    last  INTEGER NOT NULL,
    lines INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_sent (
    at   INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS points (
    user_id    TEXT PRIMARY KEY,
    login      TEXT NOT NULL,
    name       TEXT NOT NULL,
    balance    INTEGER NOT NULL DEFAULT 0,
    earned     INTEGER NOT NULL DEFAULT 0,
    followed   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS points_balance ON points(balance DESC);
CREATE INDEX IF NOT EXISTS points_login ON points(login);
CREATE TABLE IF NOT EXISTS points_ledger (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    delta   INTEGER NOT NULL,
    reason  TEXT NOT NULL,
    at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS points_ledger_user ON points_ledger(user_id, id);
CREATE TABLE IF NOT EXISTS points_active (
    user_id TEXT PRIMARY KEY,
    login   TEXT NOT NULL,
    name    TEXT NOT NULL,
    at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS redemptions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id   TEXT NOT NULL,
    item_name TEXT NOT NULL,
    cost      INTEGER NOT NULL,
    user_id   TEXT NOT NULL,
    login     TEXT NOT NULL,
    name      TEXT NOT NULL,
    input     TEXT NOT NULL,
    at        INTEGER NOT NULL,
    status    TEXT NOT NULL,
    done_at   INTEGER
);
CREATE INDEX IF NOT EXISTS redemptions_status ON redemptions(status, id);
CREATE INDEX IF NOT EXISTS redemptions_user ON redemptions(item_id, user_id, id);
CREATE TABLE IF NOT EXISTS giveaways (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    prize     TEXT NOT NULL,
    keyword   TEXT NOT NULL,
    level     TEXT NOT NULL,
    cost      INTEGER NOT NULL,
    sub_luck  INTEGER NOT NULL,
    seed      TEXT NOT NULL,
    seed_hash TEXT NOT NULL,
    status    TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    ended_at  INTEGER,
    winners   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    giveaway_id INTEGER NOT NULL,
    user_id     TEXT NOT NULL,
    login       TEXT NOT NULL,
    name        TEXT NOT NULL,
    tickets     INTEGER NOT NULL,
    at          INTEGER NOT NULL,
    UNIQUE (giveaway_id, user_id)
);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, seq);
CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
";

/// Set by the Worker on every request it forwards (it strips any copy a
/// client sent). `owner` means the channel's signed in owner or the admin
/// token; `token` means the client only showed `X-Sylva-Token`, which must be
/// the channel's overlay token.
pub const ACCESS_HEADER: &str = "X-Sylva-Access";
pub const TOKEN_HEADER: &str = "X-Sylva-Token";
/// Set by the Worker to the channel key, so the object knows whose it is.
pub const CHANNEL_HEADER: &str = "X-Sylva-Channel";

/// What a request or socket may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Access {
    /// Everything: read the log, control alerts, connect as feed or overlay.
    Owner,
    /// Only connect as an overlay. Overlay links live in OBS and get shared by
    /// accident, so they cannot read the event log or chat.
    Overlay,
}

/// Close code sent to overlays when their link is replaced.
const CLOSE_LINK_REPLACED: u16 = 4001;
/// Close code for a socket that asked for more than its link allows.
const CLOSE_NOT_ALLOWED: u16 = 4003;

/// What we keep on each socket. It survives hibernation. `role` is set by
/// the client's `hello`; sockets without one yet get no broadcasts.
#[derive(Serialize, Deserialize)]
struct SocketInfo {
    access: Access,
    role: Option<Role>,
}

fn socket_info(ws: &WebSocket) -> Option<SocketInfo> {
    ws.deserialize_attachment::<SocketInfo>().ok().flatten()
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

#[derive(Deserialize)]
struct TextRow {
    value: String,
}

#[derive(Deserialize)]
struct TopRow {
    name: String,
    amount: f64,
}

#[derive(Deserialize)]
struct VersionRow {
    version: f64,
    published_at: f64,
    body: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftRecord {
    scene: Scene,
    saved_at: i64,
}

#[derive(Deserialize)]
struct SummaryRow {
    kind: String,
    n: f64,
    amount: f64,
}

/// The reply to `GET /history`: newest first.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct History {
    head_seq: u64,
    events: Vec<StoredEvent>,
}

/// The reply to `GET /summary`: what happened since a time, by kind.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    since: i64,
    counts: std::collections::BTreeMap<String, u64>,
    bits: u64,
}

/// The reply to `POST /ingest`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    pub seq: u64,
    pub duplicate: bool,
    /// Whether it went into the alert queue, after the channel's alert settings.
    #[serde(default)]
    pub alert: bool,
}

#[durable_object]
pub struct ChannelDo {
    pub(crate) state: State,
    pub(crate) sql: SqlStorage,
    pub(crate) env: Env,
    /// The bot settings, read once and kept while the object is awake.
    pub(crate) bot: RefCell<Option<sylva_core::bot::BotSettings>>,
    /// The streamer's tokens per grant and when to stop using each. Memory only.
    pub(crate) tokens: RefCell<std::collections::HashMap<String, (String, i64)>>,
    /// When the last moderation notice went to chat.
    pub(crate) last_notice: Cell<i64>,
    /// Highest seq in the log. Kept in memory so assigning the next one needs no read.
    head: Cell<u64>,
    /// The alert settings, read once and kept while the object is awake.
    alert_settings: RefCell<Option<AlertSettings>>,
}

impl DurableObject for ChannelDo {
    fn new(state: State, env: Env) -> Self {
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
            alert_settings: RefCell::new(None),
            env,
            bot: RefCell::new(None),
            tokens: RefCell::new(std::collections::HashMap::new()),
            last_notice: Cell::new(0),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        let path = url.path().to_string();
        let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
        let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
        // Ingest comes from the Worker's webhook route only; clients never
        // reach it because the Worker forwards a fixed list of routes.
        let internal = matches!(
            segs.as_slice(),
            ["ingest"] | ["ingest-batch"] | ["public"] | ["public", "commands"]
        );
        let access = self.access(&req)?;
        if let Some(k) = req.headers().get(CHANNEL_HEADER)? {
            self.remember_key(&k)?;
        }
        if !internal {
            match (access, segs.as_slice()) {
                (Some(Access::Owner), _) | (Some(Access::Overlay), ["ws"]) => {}
                _ => return Response::error("Unauthorized", 401),
            }
        }
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
                pair.server.serialize_attachment(SocketInfo {
                    access: access.unwrap_or(Access::Overlay),
                    role: None,
                })?;
                Response::from_websocket(pair.client)
            }
            (Method::Get, ["state"]) => Response::from_json(&self.alert_state()?),
            (Method::Get, ["history"]) => {
                let before = q
                    .get("before")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(u64::MAX / 2);
                let limit = q
                    .get("limit")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(100u64)
                    .clamp(1, 500);
                let filter = q.get("filter").map(String::as_str).unwrap_or("all");
                let search = q.get("q").map(|s| s.trim()).filter(|s| !s.is_empty());
                Response::from_json(&History {
                    head_seq: self.head.get(),
                    events: self.history(before, limit, filter, search)?,
                })
            }
            (Method::Get, ["summary"]) => {
                let since = q
                    .get("since")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| Date::now().as_millis() as i64 - 86_400_000);
                Response::from_json(&self.summary(since)?)
            }
            (Method::Get, ["alert-settings"]) => Response::from_json(&self.alert_settings()?),
            (Method::Post, ["alert-settings"]) => {
                let Ok(body) = req.json::<AlertSettings>().await else {
                    return Response::error("Those settings could not be read", 400);
                };
                match body.validated() {
                    Ok(settings) => {
                        self.sql.exec(
                            "INSERT INTO config (key, value) VALUES ('alert_settings', ?)
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            vec![serde_json::to_string(&settings)?.into()],
                        )?;
                        self.alert_settings.replace(Some(settings.clone()));
                        Response::from_json(&settings)
                    }
                    Err(Invalid(message)) => Response::error(message, 400),
                }
            }
            (Method::Get, ["widget-settings"]) => Response::from_json(&self.widget_settings()?),
            (Method::Post, ["widget-settings"]) => {
                let Ok(body) = req.json::<WidgetSettings>().await else {
                    return Response::error("Those settings could not be read", 400);
                };
                match body.validated() {
                    Ok(settings) => {
                        self.sql.exec(
                            "INSERT INTO config (key, value) VALUES ('widget_settings', ?)
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            vec![serde_json::to_string(&settings)?.into()],
                        )?;
                        // Widgets on screen pick up the new goal at once.
                        self.send_widget_data()?;
                        Response::from_json(&settings)
                    }
                    Err(Invalid(message)) => Response::error(message, 400),
                }
            }
            (Method::Get, ["bot"]) => {
                // `!commands` links to the commands page on this site.
                self.remember_site(&url)?;
                Response::from_json(&self.bot_view().await?)
            }
            (Method::Get, ["public", "commands"]) => match self.public_commands()? {
                Some(p) => Response::from_json(&p),
                None => Response::error("This channel's bot is off", 404),
            },
            (Method::Post, ["bot"]) => {
                let Ok(body) = req.json::<sylva_core::bot::BotSettings>().await else {
                    return Response::error("Those bot settings could not be read", 400);
                };
                match body.validated(&self.bot_settings()?) {
                    Ok(s) => {
                        self.save_bot_settings(&s)?;
                        self.schedule().await?;
                        Response::from_json(&self.bot_view().await?)
                    }
                    Err(Invalid(message)) => Response::error(message, 400),
                }
            }
            (Method::Post, ["bot", "timers", id, "send"]) => match self.send_timer_now(id).await? {
                Ok(()) => Response::from_json(&self.bot_view().await?),
                Err((status, message)) => Response::error(message, status),
            },
            (Method::Get, ["bot", "quotes"]) => Response::from_json(&crate::community::QuoteList {
                quotes: self.quotes()?,
            }),
            (Method::Post, ["bot", "quotes"]) => {
                let Ok(body) = req.json::<crate::community::QuoteInput>().await else {
                    return Response::error("That quote could not be read", 400);
                };
                match self.add_quote(body)? {
                    Ok(q) => Response::from_json(&q),
                    Err(message) => Response::error(message, 400),
                }
            }
            (Method::Post, ["bot", "quotes", id]) => {
                let Ok(id) = id.parse::<i64>() else {
                    return Response::error("There is no such quote", 404);
                };
                let Ok(body) = req.json::<crate::community::QuoteInput>().await else {
                    return Response::error("That quote could not be read", 400);
                };
                match self.edit_quote(id, body)? {
                    Ok(q) => Response::from_json(&q),
                    Err((status, message)) => Response::error(message, status),
                }
            }
            (Method::Post, ["bot", "quotes", id, "delete"]) => {
                let id = id.parse::<i64>().unwrap_or(0);
                match self.delete_quote(id)? {
                    Some(q) => Response::from_json(&q),
                    None => Response::error(format!("There is no quote #{id}"), 404),
                }
            }
            (Method::Post, ["bot", "counters", name, "set"]) => {
                #[derive(serde::Deserialize)]
                struct SetValue {
                    value: i64,
                }
                let Ok(body) = req.json::<SetValue>().await else {
                    return Response::error("That number could not be read", 400);
                };
                if self.set_counter(name, body.value)? {
                    Response::from_json(&self.bot_view().await?)
                } else {
                    Response::error("That counter no longer exists", 404)
                }
            }
            (Method::Post, ["bot", "try"]) => {
                let Ok(body) = req.json::<crate::bot::TryRequest>().await else {
                    return Response::error("That test could not be read", 400);
                };
                match self.try_bot(body).await? {
                    Ok(r) => Response::from_json(&r),
                    Err(message) => Response::error(message, 400),
                }
            }
            (Method::Get, ["moderation"]) => Response::from_json(&self.mod_view().await?),
            (Method::Post, ["moderation"]) => {
                let Ok(body) = req.json::<sylva_core::moderation::ModSettings>().await else {
                    return Response::error("Those moderation settings could not be read", 400);
                };
                match body.validated() {
                    Ok(s) => {
                        self.save_mod_settings(&s)?;
                        Response::from_json(&self.mod_view().await?)
                    }
                    Err(Invalid(message)) => Response::error(message, 400),
                }
            }
            (Method::Post, ["moderation", "try"]) => {
                let Ok(body) = req.json::<crate::moderation::TryRequest>().await else {
                    return Response::error("That test could not be read", 400);
                };
                match self.try_moderation(body)? {
                    Ok(r) => Response::from_json(&r),
                    Err(message) => Response::error(message, 400),
                }
            }
            (Method::Get, ["moderation", "log"]) => {
                let before = q
                    .get("before")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(i64::MAX);
                let limit = q
                    .get("limit")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(50i64)
                    .clamp(1, 200);
                Response::from_json(&serde_json::json!({ "entries": self.mod_log(before, limit)? }))
            }
            (Method::Post, ["moderation", "log", id, "undo"]) => {
                let Ok(id) = id.parse::<i64>() else {
                    return Response::error("That entry is no longer in the log", 404);
                };
                match self.undo_mod_action(id).await? {
                    Ok(entry) => Response::from_json(&entry),
                    Err((status, message)) => Response::error(message, status),
                }
            }
            (Method::Get, ["loyalty"]) => Response::from_json(&self.loyalty_view().await?),
            (Method::Post, ["loyalty"]) => {
                let Ok(body) = req.json::<serde_json::Value>().await else {
                    return Response::error("Those points settings could not be read", 400);
                };
                match crate::loyalty::parse_settings(body) {
                    Ok(s) => {
                        self.save_loyalty_settings(&s).await?;
                        Response::from_json(&self.loyalty_view().await?)
                    }
                    Err(message) => Response::error(message, 400),
                }
            }
            (Method::Get, ["public"]) => {
                match self.public_store(q.get("viewer").map(String::as_str))? {
                    Some(p) => Response::from_json(&p),
                    None => Response::error("This channel has no points", 404),
                }
            }
            (Method::Get, ["loyalty", "store"]) => {
                self.remember_site(&url)?;
                Response::from_json(&self.store_view()?)
            }
            (Method::Post, ["loyalty", "store"]) => {
                self.remember_site(&url)?;
                let Ok(body) = req.json::<sylva_core::store::StoreSettings>().await else {
                    return Response::error("Those store settings could not be read", 400);
                };
                match self.save_store_settings(body)? {
                    Ok(()) => Response::from_json(&self.store_view()?),
                    Err(message) => Response::error(message, 400),
                }
            }
            (Method::Get, ["loyalty", "redemptions"]) => {
                let num =
                    |k: &str, d: i64| q.get(k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(d);
                Response::from_json(&serde_json::json!({ "redemptions": self.redemptions(
                    q.get("status").map_or("pending", String::as_str),
                    num("before", i64::MAX),
                    num("limit", 50).clamp(1, 200),
                )? }))
            }
            (Method::Post, ["loyalty", "redemptions", id, action]) => {
                let Ok(id) = id.parse::<i64>() else {
                    return Response::error("That redemption is no longer kept", 404);
                };
                match self.settle(id, action)? {
                    Ok(r) => Response::from_json(&r),
                    Err((status, message)) => Response::error(message, status),
                }
            }
            (Method::Get, ["giveaways"]) => Response::from_json(&self.giveaways_view()?),
            (Method::Post, ["giveaways"]) => {
                let Ok(body) = req.json::<sylva_core::giveaway::GiveawaySettings>().await else {
                    return Response::error("That giveaway could not be read", 400);
                };
                match self.start_giveaway(body).await? {
                    Ok(()) => Response::from_json(&self.giveaways_view()?),
                    Err((status, message)) => Response::error(message, status),
                }
            }
            (Method::Post, ["giveaways", id, action]) => {
                let Ok(id) = id.parse::<i64>() else {
                    return Response::error("That giveaway is over", 409);
                };
                match self.giveaway_action(id, action).await? {
                    Ok(()) => Response::from_json(&self.giveaways_view()?),
                    Err((status, message)) => Response::error(message, status),
                }
            }
            (Method::Get, ["loyalty", "viewers"]) => {
                let num =
                    |k: &str, d: i64| q.get(k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(d);
                Response::from_json(&self.loyalty_viewers(
                    q.get("q").map_or("", String::as_str),
                    num("limit", 50).clamp(1, 200),
                    num("offset", 0).max(0),
                )?)
            }
            (Method::Get, ["loyalty", "viewers", id, "ledger"]) => {
                Response::from_json(&serde_json::json!({ "entries": self.ledger(id)? }))
            }
            (Method::Post, ["loyalty", "viewers", id, "adjust"]) => {
                let Ok(body) = req.json::<crate::loyalty::Adjust>().await else {
                    return Response::error("That change could not be read", 400);
                };
                match self.adjust_points(id, body)? {
                    Ok(v) => Response::from_json(&v),
                    Err((status, message)) => Response::error(message, status),
                }
            }
            (Method::Get, ["scene"]) => Response::from_json(&self.scene_state()?),
            (Method::Post, ["scene"]) => {
                let Ok(body) = req.json::<Scene>().await else {
                    return Response::error("That layout could not be read", 400);
                };
                match body.validated() {
                    Ok(scene) => {
                        self.save_draft(&scene)?;
                        Response::from_json(&self.scene_state()?)
                    }
                    Err(Invalid(message)) => Response::error(message, 400),
                }
            }
            (Method::Post, ["scene", "publish"]) => {
                let (draft, _) = self.draft()?;
                let version = self.published()?.map_or(0, |p| p.version) + 1;
                self.sql.exec(
                    "INSERT INTO scene_versions (version, published_at, body) VALUES (?, ?, ?)",
                    vec![
                        (version as i64).into(),
                        (Date::now().as_millis() as i64).into(),
                        serde_json::to_string(&draft)?.into(),
                    ],
                )?;
                self.sql.exec(
                    "DELETE FROM scene_versions WHERE version <= ?",
                    vec![(version as i64 - KEPT_VERSIONS as i64).into()],
                )?;
                // Every overlay on screen switches to the new layout at once.
                self.send_widget_data()?;
                Response::from_json(&self.scene_state()?)
            }
            (Method::Post, ["scene", "restore", version]) => {
                let Ok(v) = version.parse::<i64>() else {
                    return Response::error("Unknown version", 404);
                };
                let rows = self
                    .sql
                    .exec(
                        "SELECT body AS value FROM scene_versions WHERE version = ?",
                        vec![v.into()],
                    )?
                    .to_array::<TextRow>()?;
                let Some(row) = rows.first() else {
                    return Response::error("That version is no longer kept", 404);
                };
                // Back into the draft, so it can be checked before publishing.
                self.save_draft(&serde_json::from_str(&row.value)?)?;
                Response::from_json(&self.scene_state()?)
            }
            (Method::Post, ["erase"]) => {
                // The owner deleted their account. Only the Worker sends this
                // (it is not in the list it forwards for clients).
                for ws in self.state.get_websockets() {
                    let _ = ws.close(Some(CLOSE_LINK_REPLACED), Some("channel deleted"));
                }
                for table in [
                    "alerts",
                    "events",
                    "settings",
                    "config",
                    "secrets",
                    "scene_versions",
                    "bot_cooldowns",
                    "bot_sent",
                    "timer_state",
                    "mod_strikes",
                    "mod_log",
                    "quotes",
                    "points",
                    "points_ledger",
                    "points_active",
                    "redemptions",
                    "giveaways",
                    "giveaway_entries",
                ] {
                    self.sql.exec(&format!("DELETE FROM {table}"), None)?;
                }
                self.state.storage().delete_alarm().await?;
                self.head.set(0);
                *self.alert_settings.borrow_mut() = None;
                *self.bot.borrow_mut() = None;
                self.tokens.borrow_mut().clear();
                self.last_notice.set(0);
                Response::empty().map(|r| r.with_status(204))
            }
            (Method::Get, ["overlay-token"]) => {
                Response::from_json(&serde_json::json!({ "token": self.overlay_token()? }))
            }
            (Method::Post, ["overlay-token", "rotate"]) => {
                let token = crate::util::random_hex(24)?;
                self.sql.exec(
                    "INSERT INTO secrets (key, value) VALUES ('overlay_token', ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    vec![token.as_str().into()],
                )?;
                // The old link stops working right away, even for open overlays.
                for ws in self.state.get_websockets() {
                    if socket_info(&ws).is_some_and(|i| i.access == Access::Overlay) {
                        let _ = ws.close(Some(CLOSE_LINK_REPLACED), Some("link replaced"));
                    }
                }
                Response::from_json(&serde_json::json!({ "token": token }))
            }
            (Method::Get, ["events"]) => {
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
                if self.dispatch().await?.is_none() {
                    self.broadcast_state()?;
                }
            }
        }
        if let Err(e) = self.run_timers(now).await {
            console_error!("A timer could not post: {e}");
        }
        if let Err(e) = self.run_loyalty(now).await {
            console_error!("Points could not be paid: {e}");
        }
        if let Err(e) = self.run_filesay(now).await {
            console_error!("A !filesay line could not post: {e}");
        }
        self.schedule().await?;
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
                let access = socket_info(&ws).map_or(Access::Overlay, |i| i.access);
                if access == Access::Overlay && role == Role::Feed {
                    let _ = send(
                        &ws,
                        &ServerFrame::Error {
                            message: "This link only works as an overlay or a widget.".into(),
                        },
                    );
                    let _ = ws.close(Some(CLOSE_NOT_ALLOWED), Some("overlay link"));
                    return Ok(());
                }
                ws.serialize_attachment(SocketInfo {
                    access,
                    role: Some(role),
                })?;
                // Overlay links do not get to read the log.
                let last_seq = if access == Access::Owner {
                    last_seq
                } else {
                    None
                };
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
                if role == Role::Widget {
                    send(&ws, &ServerFrame::Widgets(self.widget_data()?))?;
                }
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
                alert: false,
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
        let is_alert = self.alert_settings()?.plays(&event);
        if is_alert {
            self.sql.exec(
                "INSERT INTO alerts (event_seq) VALUES (?)",
                vec![(seq as i64).into()],
            )?;
        }

        self.remember_key(&event.channel)?;
        self.remember_channel_name(&event)?;
        let stored_kind = event.kind;
        let stored_raw = event.raw_type.clone();
        let is_chat = stored_kind == sylva_core::EventKind::Chat
            && event.platform == sylva_core::Platform::Twitch;
        let stored = StoredEvent {
            seq,
            received_at,
            event,
        };
        let text = serde_json::to_string(&ServerFrame::Event(stored.clone()))?;
        for ws in self.state.get_websockets() {
            if socket_info(&ws).is_some_and(|i| i.role.is_some()) {
                let _ = ws.send_with_str(&text);
            }
        }
        // Top labels move with cheers and gifts, and start over when the
        // stream goes live.
        let tops_changed = matches!(
            stored_kind,
            sylva_core::EventKind::Cheer | sylva_core::EventKind::CommunityGift
        ) || stored_raw == "stream.online";
        if tops_changed {
            let sockets = self.sockets(Role::Widget);
            if !sockets.is_empty() {
                let text = serde_json::to_string(&ServerFrame::Top { top: self.top()? })?;
                for ws in sockets {
                    let _ = ws.send_with_str(&text);
                }
            }
        }
        if is_alert && self.dispatch().await?.is_none() {
            // Feeds show the queue length, so tell them it grew.
            self.broadcast_state()?;
        }
        if let Err(e) = self.loyalty_event(&stored.event) {
            console_error!("Points could not be added: {e}");
        }
        if stored_raw == "stream.online" {
            self.restart_timers(received_at)?;
            self.restart_loyalty(received_at)?;
            self.schedule().await?;
        }
        if is_chat {
            // A line that breaks the chat rules gets no answer from the bot
            // and earns nothing.
            if !self.run_moderation(&stored).await {
                if let Err(e) = self.mark_active(&stored.event) {
                    console_error!("Could not note the chatter: {e}");
                }
                self.run_bot(&stored).await;
            }
            // Chat can make a timer due; only then does the alarm need moving.
            let bot = self.bot_settings()?;
            if bot.enabled && !bot.timers.is_empty() {
                self.schedule().await?;
            }
        }
        Ok(IngestResult {
            seq,
            duplicate: false,
            alert: is_alert,
        })
    }

    fn access(&self, req: &Request) -> Result<Option<Access>> {
        let h = req.headers();
        match h.get(ACCESS_HEADER)?.as_deref() {
            Some("owner") => Ok(Some(Access::Owner)),
            Some("token") => {
                let got = h.get(TOKEN_HEADER)?.unwrap_or_default();
                let want = self.stored_overlay_token()?;
                Ok(want
                    .filter(|w| {
                        !got.is_empty() && crate::constant_time_eq(w.as_bytes(), got.as_bytes())
                    })
                    .map(|_| Access::Overlay))
            }
            _ => Ok(None),
        }
    }

    fn stored_overlay_token(&self) -> Result<Option<String>> {
        Ok(self
            .sql
            .exec(
                "SELECT value FROM secrets WHERE key = 'overlay_token'",
                None,
            )?
            .to_array::<TextRow>()?
            .into_iter()
            .next()
            .map(|r| r.value))
    }

    /// The token in this channel's overlay link, made on first use.
    fn overlay_token(&self) -> Result<String> {
        if let Some(t) = self.stored_overlay_token()? {
            return Ok(t);
        }
        let token = crate::util::random_hex(24)?;
        self.sql.exec(
            "INSERT INTO secrets (key, value) VALUES ('overlay_token', ?)",
            vec![token.as_str().into()],
        )?;
        Ok(token)
    }

    /// Events before `before`, newest first. `filter` is `alerts` (everything
    /// but chat), `chat`, or `all`. `search` matches the name of who did it or
    /// the message, ignoring case.
    fn history(
        &self,
        before: u64,
        limit: u64,
        filter: &str,
        search: Option<&str>,
    ) -> Result<Vec<StoredEvent>> {
        let kind_clause = match filter {
            "chat" => "AND kind = 'chat'",
            "alerts" => "AND kind != 'chat'",
            _ => "",
        };
        let mut args: Vec<SqlStorageValue> = vec![(before as i64).into()];
        let search_clause = match search {
            Some(text) => {
                // Treat the text literally: escape LIKE's wildcards.
                let escaped = text
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                let pattern = format!("%{escaped}%");
                args.push(pattern.clone().into());
                args.push(pattern.clone().into());
                args.push(pattern.into());
                "AND (json_extract(body, '$.actor.displayName') LIKE ? ESCAPE '\\'
                      OR json_extract(body, '$.actor.login') LIKE ? ESCAPE '\\'
                      OR json_extract(body, '$.message') LIKE ? ESCAPE '\\')"
            }
            None => "",
        };
        args.push((limit as i64).into());
        let rows = self
            .sql
            .exec(
                &format!(
                    "SELECT seq, received_at, body FROM events WHERE seq < ? {kind_clause} {search_clause}
                     ORDER BY seq DESC LIMIT ?"
                ),
                args,
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

    /// Counts by kind since `since` (Unix ms, by when Sylva received them),
    /// plus the bits cheered.
    fn summary(&self, since: i64) -> Result<Summary> {
        let rows = self
            .sql
            .exec(
                "SELECT kind, COUNT(*) AS n,
                        COALESCE(SUM(CASE WHEN kind = 'cheer'
                                     THEN json_extract(body, '$.amount') END), 0) AS amount
                 FROM events WHERE received_at >= ? GROUP BY kind",
                vec![since.into()],
            )?
            .to_array::<SummaryRow>()?;
        let mut counts = std::collections::BTreeMap::new();
        let mut bits = 0;
        for r in rows {
            if r.kind == "cheer" {
                bits = r.amount as u64;
            }
            counts.insert(r.kind, r.n as u64);
        }
        Ok(Summary {
            since,
            counts,
            bits,
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
            .filter(|ws| socket_info(ws).is_some_and(|i| i.role == Some(role)))
            .collect()
    }

    fn widget_settings(&self) -> Result<WidgetSettings> {
        let rows = self
            .sql
            .exec(
                "SELECT value FROM config WHERE key = 'widget_settings'",
                None,
            )?
            .to_array::<TextRow>()?;
        Ok(rows
            .first()
            .and_then(|r| serde_json::from_str(&r.value).ok())
            .unwrap_or_default())
    }

    fn kind_list(kinds: &[sylva_core::EventKind]) -> Result<String> {
        let names: Vec<String> = kinds
            .iter()
            .map(|k| {
                Ok(format!(
                    "'{}'",
                    serde_json::to_value(k)?.as_str().unwrap_or("other")
                ))
            })
            .collect::<Result<_>>()?;
        Ok(names.join(", "))
    }

    fn rows_to_events(rows: Vec<EventRow>) -> Result<Vec<StoredEvent>> {
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

    /// What a widget shows when it connects.
    fn widget_data(&self) -> Result<WidgetData> {
        let recent = self
            .sql
            .exec(
                &format!(
                    "SELECT seq, received_at, body FROM events WHERE kind IN ({})
                     ORDER BY seq DESC LIMIT ?",
                    Self::kind_list(&LIST_KINDS)?
                ),
                vec![(RECENT_LIMIT as i64).into()],
            )?
            .to_array::<EventRow>()?;
        let mut latest = Vec::new();
        for kind in LATEST_KINDS {
            let name = serde_json::to_value(kind)?;
            let rows = self
                .sql
                .exec(
                    "SELECT seq, received_at, body FROM events WHERE kind = ?
                     ORDER BY seq DESC LIMIT 1",
                    vec![name.as_str().unwrap_or("other").into()],
                )?
                .to_array::<EventRow>()?;
            latest.extend(Self::rows_to_events(rows)?);
        }
        let mut chat = Self::rows_to_events(
            self.sql
                .exec(
                    "SELECT seq, received_at, body FROM events WHERE kind = 'chat'
                     ORDER BY seq DESC LIMIT ?",
                    vec![(CHAT_LIMIT as i64).into()],
                )?
                .to_array::<EventRow>()?,
        )?;
        chat.reverse();
        let goal = match self.widget_settings()?.goal {
            Some(g) => {
                let sum = self.summary(g.since)?;
                let n = |k: &str| sum.counts.get(k).copied().unwrap_or(0) as f64;
                let current = match g.kind {
                    GoalKind::Follows => n("follow"),
                    GoalKind::Subs => n("subscriber") + n("giftedSub"),
                    GoalKind::Bits => sum.bits as f64,
                };
                Some(GoalView {
                    title: g.title,
                    kind: g.kind,
                    target: g.target,
                    current,
                    since: g.since,
                })
            }
            None => None,
        };
        Ok(WidgetData {
            recent: Self::rows_to_events(recent)?,
            latest,
            chat,
            goal,
            top: self.top()?,
            scene: self.published()?,
        })
    }

    /// Send every widget socket what it shows, after a change to it.
    fn send_widget_data(&self) -> Result<()> {
        let sockets = self.sockets(Role::Widget);
        if !sockets.is_empty() {
            let text = serde_json::to_string(&ServerFrame::Widgets(self.widget_data()?))?;
            for ws in sockets {
                let _ = ws.send_with_str(&text);
            }
        }
        Ok(())
    }

    /// The top cheerer and top gifter since the stream went live (the latest
    /// `stream.online`), or in the last 24 hours when Sylva has not seen one.
    fn top(&self) -> Result<Vec<TopEntry>> {
        let online = self
            .sql
            .exec(
                "SELECT COALESCE(MAX(received_at), 0) AS value FROM events
                 WHERE kind = 'other' AND json_extract(body, '$.rawType') = 'stream.online'",
                None,
            )?
            .one::<ValueRow>()?
            .value as i64;
        let since = if online > 0 {
            online
        } else {
            Date::now().as_millis() as i64 - 24 * 3600 * 1000
        };
        let mut out = Vec::new();
        for kind in sylva_core::scene::TOP_LABEL_KINDS {
            let rows = self
                .sql
                .exec(
                    "SELECT json_extract(body, '$.actor.displayName') AS name,
                            SUM(COALESCE(json_extract(body, '$.amount'), 0)) AS amount
                     FROM events
                     WHERE kind = ? AND received_at >= ? AND json_extract(body, '$.actor') IS NOT NULL
                     GROUP BY json_extract(body, '$.actor.login')
                     ORDER BY amount DESC, MIN(seq) ASC LIMIT 1",
                    vec![kind.into(), since.into()],
                )?
                .to_array::<TopRow>()?;
            if let Some(r) = rows.into_iter().next().filter(|r| r.amount > 0.0) {
                out.push(TopEntry {
                    kind: kind.into(),
                    name: r.name,
                    amount: r.amount,
                });
            }
        }
        Ok(out)
    }

    fn draft(&self) -> Result<(Scene, i64)> {
        let rows = self
            .sql
            .exec("SELECT value FROM config WHERE key = 'scene_draft'", None)?
            .to_array::<TextRow>()?;
        let saved: Option<DraftRecord> = rows
            .first()
            .and_then(|r| serde_json::from_str(&r.value).ok());
        Ok(saved.map_or((Scene::default(), 0), |d| (d.scene, d.saved_at)))
    }

    fn save_draft(&self, scene: &Scene) -> Result<()> {
        let record = DraftRecord {
            scene: scene.clone(),
            saved_at: Date::now().as_millis() as i64,
        };
        self.sql.exec(
            "INSERT INTO config (key, value) VALUES ('scene_draft', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            vec![serde_json::to_string(&record)?.into()],
        )?;
        Ok(())
    }

    fn published(&self) -> Result<Option<Published>> {
        let rows = self
            .sql
            .exec(
                "SELECT version, published_at, body FROM scene_versions ORDER BY version DESC LIMIT 1",
                None,
            )?
            .to_array::<VersionRow>()?;
        rows.into_iter()
            .next()
            .map(|r| {
                Ok(Published {
                    version: r.version as u64,
                    published_at: r.published_at as i64,
                    scene: serde_json::from_str(&r.body)?,
                })
            })
            .transpose()
    }

    fn scene_state(&self) -> Result<SceneState> {
        let (draft, draft_saved_at) = self.draft()?;
        let versions = self
            .sql
            .exec(
                "SELECT version, published_at, body FROM scene_versions ORDER BY version DESC",
                None,
            )?
            .to_array::<VersionRow>()?
            .into_iter()
            .map(|r| VersionInfo {
                version: r.version as u64,
                published_at: r.published_at as i64,
                items: serde_json::from_str::<Scene>(&r.body)
                    .map(|s| s.items.len())
                    .unwrap_or(0),
            })
            .collect();
        Ok(SceneState {
            draft,
            draft_saved_at,
            published: self.published()?,
            versions,
        })
    }

    pub(crate) fn config(&self, key: &str) -> Result<Option<String>> {
        let rows = self
            .sql
            .exec("SELECT value FROM config WHERE key = ?", vec![key.into()])?
            .to_array::<TextRow>()?;
        Ok(rows.into_iter().next().map(|r| r.value))
    }

    pub(crate) fn set_config(&self, key: &str, value: &str) -> Result<()> {
        self.sql.exec(
            "INSERT INTO config (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            vec![key.into(), value.into()],
        )?;
        Ok(())
    }

    /// This object's channel key, such as `twitch:12826`, once it has seen it.
    pub(crate) fn key(&self) -> Option<String> {
        self.config("channel_key").ok().flatten()
    }

    fn remember_key(&self, key: &str) -> Result<()> {
        if self.key().is_none() && !key.is_empty() {
            self.set_config("channel_key", key)?;
        }
        Ok(())
    }

    fn alert_settings(&self) -> Result<AlertSettings> {
        if let Some(s) = self.alert_settings.borrow().as_ref() {
            return Ok(s.clone());
        }
        let rows = self
            .sql
            .exec(
                "SELECT value FROM config WHERE key = 'alert_settings'",
                None,
            )?
            .to_array::<TextRow>()?;
        // Settings saved by an older version fill in their missing kinds.
        let settings = rows
            .first()
            .and_then(|r| serde_json::from_str::<AlertSettings>(&r.value).ok())
            .and_then(|s| s.validated().ok())
            .unwrap_or_default();
        self.alert_settings.replace(Some(settings.clone()));
        Ok(settings)
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
            if socket_info(&ws).is_some_and(|i| i.role.is_some()) {
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
        let event = self.event(event_seq)?;
        let frame = ServerFrame::Play {
            alert_id,
            muted: self.setting("muted")?,
            view: self.alert_settings()?.view(&event.event),
            event,
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
            self.schedule().await?;
        }
        Ok(started)
    }

    /// Set the one alarm a Durable Object has to the earliest thing waiting:
    /// the timeout of the alert on screen, the next timer message, points or
    /// `!filesay` line.
    pub(crate) async fn schedule(&self) -> Result<()> {
        let now = Date::now().as_millis() as i64;
        let alert = self
            .playing()?
            .map(|p| p.started_at.unwrap_or(0.0) as i64 + ALERT_TIMEOUT_MS);
        let timer = self.next_timer_at(now)?;
        let points = self.next_loyalty_at()?;
        let filesay = self.next_filesay_at()?;
        let storage = self.state.storage();
        match alert
            .into_iter()
            .chain(timer)
            .chain(points)
            .chain(filesay)
            .min()
        {
            // Careful: a Duration here is an offset from now, not a timestamp.
            Some(at) => {
                storage
                    .set_alarm(Duration::from_millis((at - now).max(1) as u64))
                    .await?
            }
            None => storage.delete_alarm().await?,
        }
        Ok(())
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

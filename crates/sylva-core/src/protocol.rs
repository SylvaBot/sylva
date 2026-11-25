//! Frames on the realtime websocket that overlays, the dashboard and Cortex use.
//!
//! Every frame is one JSON object with a `type` field.
//!
//! Client to server:
//! * `hello { role, lastSeq }` first, after the socket opens. When `lastSeq` is
//!   given the server replays every event after it (`event` frames, oldest
//!   first, at most [`REPLAY_LIMIT`]), then sends `ready`. Without `lastSeq`
//!   the client starts live from the head of the log. Overlays
//!   then also get the alert that is playing, if any, so an OBS reload never
//!   loses it.
//! * `ack { alertId }` when an overlay finished showing an alert.
//! * `ping` keeps a connection alive without waking a hibernating object (the
//!   server answers `pong` automatically).
//!
//! Server to client:
//! * `event { seq, ... }` for each new or replayed event, in `seq` order.
//! * `ready { headSeq, state }` once replay is finished.
//! * `play { alertId, muted, event }` tells overlays to show one alert.
//! * `stop { alertId }` tells overlays to hide an alert that was skipped.
//! * `state { ... }` whenever pause, mute or the current alert changes.

use serde::{Deserialize, Serialize};

use crate::event::StoredEvent;

/// The most events replayed over the socket after a reconnect.
pub const REPLAY_LIMIT: u64 = 1000;

/// Sent as a plain text frame. The runtime answers it with [`PONG`] without
/// waking the channel's Durable Object, so keepalives cost nothing.
pub const PING: &str = r#"{"type":"ping"}"#;
pub const PONG: &str = r#"{"type":"pong"}"#;

/// What kind of client is connected. Overlays receive `play` frames and their
/// acks drive the alert queue; feeds (dashboard, Cortex) only watch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Overlay,
    Feed,
}

impl Role {
    pub fn tag(self) -> &'static str {
        match self {
            Role::Overlay => "overlay",
            Role::Feed => "feed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientFrame {
    #[serde(rename_all = "camelCase")]
    Hello {
        role: Role,
        #[serde(default)]
        last_seq: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Ack {
        alert_id: u64,
    },
    Ping,
}

/// Readable alert queue state. This is what Cortex could never get from SE.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertState {
    pub paused: bool,
    pub muted: bool,
    /// The alert on screen now, if any.
    pub playing: Option<u64>,
    /// How many alerts wait behind it.
    pub queued: u64,
    pub overlays_connected: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerFrame {
    Event(StoredEvent),
    #[serde(rename_all = "camelCase")]
    Ready {
        head_seq: u64,
        /// True when more than [`REPLAY_LIMIT`] events were missed. The client
        /// should page through `GET /v1/channels/{key}/events?after=` instead.
        replay_truncated: bool,
        state: AlertState,
    },
    #[serde(rename_all = "camelCase")]
    Play {
        alert_id: u64,
        muted: bool,
        event: StoredEvent,
        /// What to show, from the channel's alert settings.
        view: crate::alerts::AlertView,
    },
    #[serde(rename_all = "camelCase")]
    Stop {
        alert_id: u64,
    },
    State(AlertState),
    #[serde(rename_all = "camelCase")]
    Error {
        message: String,
    },
}

/// Commands from the dashboard or Cortex (`POST /v1/channels/{key}/alerts/{action}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlertAction {
    Pause,
    Resume,
    Mute,
    Unmute,
    Skip,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_parses_with_and_without_last_seq() {
        let f: ClientFrame =
            serde_json::from_str(r#"{"type":"hello","role":"overlay","lastSeq":42}"#).unwrap();
        assert_eq!(
            f,
            ClientFrame::Hello {
                role: Role::Overlay,
                last_seq: Some(42)
            }
        );
        let f: ClientFrame = serde_json::from_str(r#"{"type":"hello","role":"feed"}"#).unwrap();
        assert_eq!(
            f,
            ClientFrame::Hello {
                role: Role::Feed,
                last_seq: None
            }
        );
    }

    #[test]
    fn ping_constant_parses() {
        assert_eq!(
            serde_json::from_str::<ClientFrame>(PING).unwrap(),
            ClientFrame::Ping
        );
    }

    #[test]
    fn ack_parses() {
        let f: ClientFrame = serde_json::from_str(r#"{"type":"ack","alertId":7}"#).unwrap();
        assert_eq!(f, ClientFrame::Ack { alert_id: 7 });
    }

    #[test]
    fn state_frame_is_flat() {
        let s = serde_json::to_value(ServerFrame::State(AlertState {
            paused: true,
            ..Default::default()
        }))
        .unwrap();
        assert_eq!(s["type"], "state");
        assert_eq!(s["paused"], true);
    }

    #[test]
    fn actions_are_kebab_case() {
        let a: AlertAction = serde_json::from_str(r#""unmute""#).unwrap();
        assert_eq!(a, AlertAction::Unmute);
    }
}

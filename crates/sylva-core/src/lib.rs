//! Platform independent core of Sylva.
//!
//! Nothing in here knows about Cloudflare, HTTP frameworks or UI. That keeps it
//! fast to test with plain `cargo test` and lets Cortex depend on the same model.

pub mod alerts;
pub mod apps;
pub mod auth;
pub mod event;
pub mod protocol;
pub mod scene;
pub mod twitch;
pub mod widgets;

pub use event::{Actor, Event, EventKind, Platform, StoredEvent};

/// Re-exported so the Worker uses the same hex code.
pub use hex;

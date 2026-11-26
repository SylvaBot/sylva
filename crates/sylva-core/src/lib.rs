//! Platform independent core of Sylva.
//!
//! Nothing in here knows about Cloudflare, HTTP frameworks or UI. That keeps it
//! fast to test with plain `cargo test` and lets Cortex depend on the same model.

pub mod alerts;
pub mod apps;
pub mod auth;
pub mod bot;
pub mod builtins;
pub mod community;
pub mod event;
pub mod giveaway;
pub mod import;
pub mod loyalty;
pub mod moderation;
pub mod protocol;
pub mod scene;
pub mod store;
pub mod team;
pub mod twitch;
pub mod widgets;

pub use event::{Actor, Event, EventKind, Platform, StoredEvent};

/// Re-exported so the Worker uses the same hex code.
pub use hex;

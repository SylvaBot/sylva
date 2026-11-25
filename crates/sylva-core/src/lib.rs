//! Platform independent core of Sylva.
//!
//! Nothing in here knows about Cloudflare, HTTP frameworks or UI. That keeps it
//! fast to test with plain `cargo test` and lets Cortex depend on the same model.

pub mod auth;
pub mod event;
pub mod protocol;
pub mod twitch;

pub use event::{Actor, Event, EventKind, Platform, StoredEvent};

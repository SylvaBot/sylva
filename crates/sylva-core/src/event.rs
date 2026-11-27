//! The normalized event model.
//!
//! Every platform adapter turns its own payloads into [`Event`]. The shape follows
//! Cortex's `Activity` (same kind names, same optional fields) so Cortex can read
//! Sylva events with almost no mapping, and adds what Sylva needs on top: the
//! platform, a dedupe id, an actor and the original payload.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where an event came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Twitch,
    /// Events made by Sylva itself, such as the "Try it" test button.
    Sylva,
    /// Tips paid on Sylva's tip page, through the streamer's own Stripe.
    Stripe,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Twitch => "twitch",
            Platform::Sylva => "sylva",
            Platform::Stripe => "stripe",
        }
    }
}

/// The feed categories. Names match Cortex's `ActivityKind`, plus `Chat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    Follow,
    Subscriber,
    GiftedSub,
    CommunityGift,
    Cheer,
    Tip,
    Redemption,
    Raid,
    Chat,
    Other,
}

impl EventKind {
    /// Whether this kind of event goes into the alert queue by default.
    /// Chat lines and unknown events only go to the feed.
    ///
    /// `GiftedSub` is feed only too: Twitch sends one `channel.subscription.gift`
    /// (our `CommunityGift`, even for a single gift) plus one `channel.subscribe`
    /// per recipient. Alerting on both would play 11 alerts for 10 gifted subs.
    pub fn is_alert(self) -> bool {
        !matches!(
            self,
            EventKind::Chat | EventKind::Other | EventKind::GiftedSub
        )
    }
}

/// The person who caused an event. `None` on the event when it was anonymous.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub id: String,
    pub login: String,
    pub display_name: String,
}

/// One normalized event, before it has a sequence number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Globally unique and stable across platform retries, for example
    /// `twitch:<eventsub message id>`. Used to drop duplicates.
    pub id: String,
    /// The channel this event belongs to, for example `twitch:12826`.
    /// This is the name of the channel's Durable Object.
    pub channel: String,
    pub platform: Platform,
    pub kind: EventKind,
    /// The platform's own name for the event, such as `channel.follow`.
    pub raw_type: String,
    /// RFC 3339 time the platform says the event happened.
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<Actor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `1000`, `2000`, `3000` or `prime`, as Twitch sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(default)]
    pub gifted: bool,
    /// Who gave a gifted sub, when that is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    /// The reward title for channel point redemptions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redemption: Option<String>,
    /// The original payload, so nothing the platform sent is lost.
    #[serde(default)]
    pub raw: Value,
}

/// An event after the channel log stored it. `seq` starts at 1 and has no gaps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub seq: u64,
    pub received_at: i64,
    #[serde(flatten)]
    pub event: Event,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gift_alerts_once_per_gift_not_per_recipient() {
        assert!(EventKind::CommunityGift.is_alert());
        assert!(!EventKind::GiftedSub.is_alert());
        assert!(!EventKind::Chat.is_alert());
        assert!(EventKind::Follow.is_alert());
        assert!(EventKind::Cheer.is_alert());
    }
}

//! Twitch EventSub over webhooks (used as conduit webhook shards).
//!
//! Twitch POSTs JSON to our callback with these headers:
//! `Twitch-Eventsub-Message-Id`, `-Timestamp`, `-Signature`, `-Type`.
//! The signature is `sha256=` + hex(HMAC-SHA256(secret, id + timestamp + raw body)).
//! Three message types exist: `webhook_callback_verification` (answer with the
//! challenge as plain text), `notification` and `revocation`.
//!
//! Reference: <https://dev.twitch.tv/docs/eventsub/handling-webhook-events/>

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::event::{Actor, Event, EventKind, Platform};

/// Twitch asks receivers to drop messages older than this.
pub const MAX_MESSAGE_AGE_MS: i64 = 10 * 60 * 1000;
/// How far in the future a timestamp may be before we treat it as bad (clock skew).
pub const MAX_CLOCK_SKEW_MS: i64 = 60 * 1000;

/// The EventSub headers we need, read out by the HTTP layer.
#[derive(Debug, Clone, Default)]
pub struct WebhookHeaders {
    pub message_id: String,
    pub timestamp: String,
    pub signature: String,
    pub message_type: String,
}

#[derive(Debug, PartialEq)]
pub enum WebhookError {
    MissingHeader(&'static str),
    BadSignature,
    BadTimestamp,
    TooOld,
    BadBody(String),
    UnknownMessageType(String),
}

impl std::fmt::Display for WebhookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WebhookError::MissingHeader(h) => write!(f, "missing header {h}"),
            WebhookError::BadSignature => write!(f, "signature does not match"),
            WebhookError::BadTimestamp => write!(f, "timestamp is not RFC 3339"),
            WebhookError::TooOld => write!(f, "message is too old or too far in the future"),
            WebhookError::BadBody(e) => write!(f, "body is not a valid EventSub payload: {e}"),
            WebhookError::UnknownMessageType(t) => write!(f, "unknown message type {t}"),
        }
    }
}

/// What a verified webhook asks us to do.
#[derive(Debug, PartialEq)]
pub enum WebhookMessage {
    /// Reply 200 with `challenge` as the plain text body.
    Verification { challenge: String },
    /// A normalized event for the channel named in `event.channel`.
    Notification(Box<Event>),
    /// Twitch stopped a subscription. `status` says why, e.g. `authorization_revoked`.
    Revocation {
        subscription_type: String,
        status: String,
    },
}

#[derive(Deserialize)]
struct Envelope {
    /// A conduit shard's verification message may carry no subscription.
    #[serde(default)]
    subscription: Subscription,
    #[serde(default)]
    event: Option<Value>,
    #[serde(default)]
    challenge: Option<String>,
}

#[derive(Deserialize, Default)]
struct Subscription {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    condition: Value,
}

/// Compute the signature header value Twitch would send. Used by tests and the
/// local load generator.
pub fn sign(secret: &[u8], message_id: &str, timestamp: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(message_id.as_bytes());
    mac.update(timestamp.as_bytes());
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

/// Check the HMAC in constant time.
pub fn verify_signature(secret: &[u8], h: &WebhookHeaders, body: &[u8]) -> bool {
    let Some(hex_sig) = h.signature.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(expected) = hex::decode(hex_sig) else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(h.message_id.as_bytes());
    mac.update(h.timestamp.as_bytes());
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

/// Parse an RFC 3339 timestamp (Twitch sends nanoseconds) into Unix milliseconds.
pub fn timestamp_ms(ts: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Verify and parse one webhook request. `now_ms` is the current Unix time in ms.
pub fn handle_webhook(
    secret: &[u8],
    h: &WebhookHeaders,
    body: &[u8],
    now_ms: i64,
) -> Result<WebhookMessage, WebhookError> {
    if h.message_id.is_empty() {
        return Err(WebhookError::MissingHeader("Twitch-Eventsub-Message-Id"));
    }
    if h.timestamp.is_empty() {
        return Err(WebhookError::MissingHeader(
            "Twitch-Eventsub-Message-Timestamp",
        ));
    }
    if h.signature.is_empty() {
        return Err(WebhookError::MissingHeader(
            "Twitch-Eventsub-Message-Signature",
        ));
    }
    if !verify_signature(secret, h, body) {
        return Err(WebhookError::BadSignature);
    }
    let sent = timestamp_ms(&h.timestamp).ok_or(WebhookError::BadTimestamp)?;
    if now_ms - sent > MAX_MESSAGE_AGE_MS || sent - now_ms > MAX_CLOCK_SKEW_MS {
        return Err(WebhookError::TooOld);
    }

    let env: Envelope =
        serde_json::from_slice(body).map_err(|e| WebhookError::BadBody(e.to_string()))?;

    match h.message_type.as_str() {
        "webhook_callback_verification" => Ok(WebhookMessage::Verification {
            challenge: env
                .challenge
                .ok_or_else(|| WebhookError::BadBody("no challenge".into()))?,
        }),
        "revocation" => Ok(WebhookMessage::Revocation {
            subscription_type: env.subscription.kind,
            status: env.subscription.status,
        }),
        "notification" => {
            let event = env
                .event
                .ok_or_else(|| WebhookError::BadBody("no event".into()))?;
            let channel_id = channel_for(&env.subscription.condition, &event)
                .ok_or_else(|| WebhookError::BadBody("no broadcaster in condition".into()))?;
            Ok(WebhookMessage::Notification(Box::new(normalize(
                &h.message_id,
                &env.subscription.kind,
                &channel_id,
                &h.timestamp,
                event,
            ))))
        }
        other => Err(WebhookError::UnknownMessageType(other.to_string())),
    }
}

/// The Twitch user id of the channel an event belongs to. For raids this is
/// whichever side the subscription was made for.
fn channel_for(condition: &Value, event: &Value) -> Option<String> {
    for key in [
        "broadcaster_user_id",
        "to_broadcaster_user_id",
        "from_broadcaster_user_id",
    ] {
        if let Some(id) = str_field(condition, key) {
            return Some(id);
        }
    }
    str_field(event, "broadcaster_user_id")
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn num_field(v: &Value, key: &str) -> Option<f64> {
    match v.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn bool_field(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Read `{prefix}_id`, `{prefix}_login`, `{prefix}_name` as an actor.
fn actor(v: &Value, prefix: &str) -> Option<Actor> {
    let id = str_field(v, &format!("{prefix}_id"))?;
    let login = str_field(v, &format!("{prefix}_login")).unwrap_or_default();
    let display_name = str_field(v, &format!("{prefix}_name")).unwrap_or_else(|| login.clone());
    Some(Actor {
        id,
        login,
        display_name,
    })
}

/// What a streamer sees an EventSub subscription as on the dashboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    Follows,
    Subs,
    Cheers,
    Chat,
    Raids,
    Stream,
    /// Charity, ad breaks, hype trains, predictions and polls, which only
    /// chat alerts use. They need the `alerts` grant.
    ChatAlerts,
}

/// One EventSub subscription Sylva makes for a channel.
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionSpec {
    pub kind: &'static str,
    pub version: &'static str,
    pub condition: Value,
    pub feature: Feature,
    /// True when Twitch needs the broadcaster's permission (granted at sign in).
    pub needs_sign_in: bool,
    /// The extra permission (`auth::GRANTS`) it needs, when the scopes asked
    /// at sign in are not enough. Without it Twitch refuses with 403.
    pub grant: Option<&'static str>,
}

/// Every subscription a signed in channel gets. Chat is read as the
/// broadcaster (`user_id` is the broadcaster too), which the `user:read:chat`,
/// `user:bot` and `channel:bot` scopes allow with Sylva's app token.
pub fn channel_subscriptions(broadcaster_user_id: &str) -> Vec<SubscriptionSpec> {
    let b = broadcaster_user_id;
    let spec = |kind, version, condition, feature, needs_sign_in| SubscriptionSpec {
        kind,
        version,
        condition,
        feature,
        needs_sign_in,
        grant: None,
    };
    let alerts = |kind| SubscriptionSpec {
        kind,
        version: if kind.starts_with("channel.hype_train") {
            "2"
        } else {
            "1"
        },
        condition: json!({ "broadcaster_user_id": b }),
        feature: Feature::ChatAlerts,
        needs_sign_in: true,
        grant: Some("alerts"),
    };
    let own = json!({ "broadcaster_user_id": b });
    vec![
        spec(
            "channel.follow",
            "2",
            json!({ "broadcaster_user_id": b, "moderator_user_id": b }),
            Feature::Follows,
            true,
        ),
        spec("channel.subscribe", "1", own.clone(), Feature::Subs, true),
        spec(
            "channel.subscription.message",
            "1",
            own.clone(),
            Feature::Subs,
            true,
        ),
        spec(
            "channel.subscription.gift",
            "1",
            own.clone(),
            Feature::Subs,
            true,
        ),
        spec("channel.cheer", "1", own.clone(), Feature::Cheers, true),
        spec(
            "channel.chat.message",
            "1",
            json!({ "broadcaster_user_id": b, "user_id": b }),
            Feature::Chat,
            true,
        ),
        spec(
            "channel.raid",
            "1",
            json!({ "to_broadcaster_user_id": b }),
            Feature::Raids,
            false,
        ),
        spec("stream.online", "1", own.clone(), Feature::Stream, false),
        spec("stream.offline", "1", own.clone(), Feature::Stream, false),
        spec("channel.update", "2", own, Feature::Stream, false),
        // Subs, gifts and watch streaks as chat shows them, for chat alerts.
        spec(
            "channel.chat.notification",
            "1",
            json!({ "broadcaster_user_id": b, "user_id": b }),
            Feature::Chat,
            true,
        ),
        alerts("channel.charity_campaign.donate"),
        alerts("channel.ad_break.begin"),
        alerts("channel.hype_train.begin"),
        alerts("channel.hype_train.progress"),
        alerts("channel.hype_train.end"),
        alerts("channel.prediction.begin"),
        alerts("channel.prediction.lock"),
        alerts("channel.prediction.end"),
        alerts("channel.poll.begin"),
        alerts("channel.poll.end"),
    ]
}

/// The feature an EventSub subscription type belongs to, if Sylva makes it.
pub fn feature_of(subscription_type: &str) -> Option<Feature> {
    channel_subscriptions("0")
        .into_iter()
        .find(|s| s.kind == subscription_type)
        .map(|s| s.feature)
}

/// The Twitch channel key used to name a Durable Object.
pub fn channel_key(broadcaster_user_id: &str) -> String {
    format!("twitch:{broadcaster_user_id}")
}

/// Turn one EventSub notification into a normalized event. Unknown types still
/// produce an event (kind `Other`) so nothing is silently dropped.
pub fn normalize(
    message_id: &str,
    subscription_type: &str,
    broadcaster_user_id: &str,
    message_timestamp: &str,
    raw: Value,
) -> Event {
    let e = &raw;
    let mut ev = Event {
        id: format!("twitch:{message_id}"),
        channel: channel_key(broadcaster_user_id),
        platform: Platform::Twitch,
        kind: EventKind::Other,
        raw_type: subscription_type.to_string(),
        created_at: message_timestamp.to_string(),
        actor: None,
        amount: None,
        currency: None,
        message: None,
        tier: None,
        gifted: false,
        sender: None,
        redemption: None,
        raw: Value::Null,
    };

    match subscription_type {
        "channel.follow" => {
            ev.kind = EventKind::Follow;
            ev.actor = actor(e, "user");
            if let Some(t) = str_field(e, "followed_at") {
                ev.created_at = t;
            }
        }
        "channel.subscribe" => {
            ev.gifted = bool_field(e, "is_gift");
            ev.kind = if ev.gifted {
                EventKind::GiftedSub
            } else {
                EventKind::Subscriber
            };
            ev.actor = actor(e, "user");
            ev.tier = str_field(e, "tier");
        }
        "channel.subscription.message" => {
            ev.kind = EventKind::Subscriber;
            ev.actor = actor(e, "user");
            ev.tier = str_field(e, "tier");
            ev.amount = num_field(e, "cumulative_months");
            ev.message = e.get("message").and_then(|m| str_field(m, "text"));
        }
        "channel.subscription.gift" => {
            ev.kind = EventKind::CommunityGift;
            ev.gifted = true;
            if !bool_field(e, "is_anonymous") {
                ev.actor = actor(e, "user");
            }
            ev.sender = ev.actor.as_ref().map(|a| a.display_name.clone());
            ev.tier = str_field(e, "tier");
            ev.amount = num_field(e, "total");
        }
        "channel.cheer" => {
            ev.kind = EventKind::Cheer;
            if !bool_field(e, "is_anonymous") {
                ev.actor = actor(e, "user");
            }
            ev.amount = num_field(e, "bits");
            ev.currency = Some("bits".into());
            ev.message = str_field(e, "message");
        }
        "channel.raid" => {
            // Only an incoming raid is an alert. An outgoing one is kept as Other.
            let incoming =
                str_field(e, "to_broadcaster_user_id").as_deref() == Some(broadcaster_user_id);
            ev.kind = if incoming {
                EventKind::Raid
            } else {
                EventKind::Other
            };
            ev.actor = actor(e, "from_broadcaster_user");
            ev.amount = num_field(e, "viewers");
        }
        "channel.channel_points_custom_reward_redemption.add" => {
            ev.kind = EventKind::Redemption;
            ev.actor = actor(e, "user");
            ev.message = str_field(e, "user_input");
            if let Some(r) = e.get("reward") {
                ev.redemption = str_field(r, "title");
                ev.amount = num_field(r, "cost");
            }
            if let Some(t) = str_field(e, "redeemed_at") {
                ev.created_at = t;
            }
        }
        "channel.chat.message" => {
            ev.kind = EventKind::Chat;
            ev.actor = actor(e, "chatter_user");
            ev.message = e.get("message").and_then(|m| str_field(m, "text"));
        }
        _ => {}
    }
    ev.raw = raw;
    ev
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &[u8] = b"s3cr3t-at-least-10-chars";
    const NOW: &str = "2026-11-25T12:00:00.123456789Z";

    fn now_ms() -> i64 {
        timestamp_ms(NOW).unwrap()
    }

    fn signed(kind: &str, body: &Value) -> (WebhookHeaders, Vec<u8>) {
        let body = serde_json::to_vec(body).unwrap();
        let h = WebhookHeaders {
            message_id: "msg-1".into(),
            timestamp: NOW.into(),
            signature: sign(SECRET, "msg-1", NOW, &body),
            message_type: kind.into(),
        };
        (h, body)
    }

    fn notification(sub_type: &str, condition: Value, event: Value) -> Event {
        let body = json!({
            "subscription": {"id": "sub", "type": sub_type, "version": "1", "status": "enabled",
                              "condition": condition, "transport": {"method": "conduit"}},
            "event": event
        });
        let (h, b) = signed("notification", &body);
        match handle_webhook(SECRET, &h, &b, now_ms()).unwrap() {
            WebhookMessage::Notification(e) => *e,
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn signature_matches_twitch_example_shape() {
        let sig = sign(b"secret", "id", "ts", b"{}");
        assert!(sig.starts_with("sha256="));
        assert_eq!(sig.len(), 7 + 64);
    }

    #[test]
    fn verification_returns_challenge() {
        let body = json!({"challenge": "pogchamp-kappa-360noscope",
                          "subscription": {"type": "channel.follow", "condition": {}}});
        let (h, b) = signed("webhook_callback_verification", &body);
        assert_eq!(
            handle_webhook(SECRET, &h, &b, now_ms()).unwrap(),
            WebhookMessage::Verification {
                challenge: "pogchamp-kappa-360noscope".into()
            }
        );
    }

    #[test]
    fn conduit_shard_verification_without_subscription() {
        let body = json!({"challenge": "shard-check"});
        let (h, b) = signed("webhook_callback_verification", &body);
        assert_eq!(
            handle_webhook(SECRET, &h, &b, now_ms()).unwrap(),
            WebhookMessage::Verification {
                challenge: "shard-check".into()
            }
        );
    }

    #[test]
    fn tampered_body_is_rejected() {
        let body = json!({"challenge": "x", "subscription": {"type": "t", "condition": {}}});
        let (h, mut b) = signed("webhook_callback_verification", &body);
        b.push(b' ');
        assert_eq!(
            handle_webhook(SECRET, &h, &b, now_ms()),
            Err(WebhookError::BadSignature)
        );
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let body = json!({"challenge": "x", "subscription": {"type": "t", "condition": {}}});
        let (h, b) = signed("webhook_callback_verification", &body);
        assert_eq!(
            handle_webhook(b"other-secret", &h, &b, now_ms()),
            Err(WebhookError::BadSignature)
        );
    }

    #[test]
    fn old_messages_are_rejected() {
        let body = json!({"challenge": "x", "subscription": {"type": "t", "condition": {}}});
        let (h, b) = signed("webhook_callback_verification", &body);
        let later = now_ms() + MAX_MESSAGE_AGE_MS + 1;
        assert_eq!(
            handle_webhook(SECRET, &h, &b, later),
            Err(WebhookError::TooOld)
        );
        let earlier = now_ms() - MAX_CLOCK_SKEW_MS - 1;
        assert_eq!(
            handle_webhook(SECRET, &h, &b, earlier),
            Err(WebhookError::TooOld)
        );
    }

    #[test]
    fn missing_signature_is_reported() {
        let mut h = WebhookHeaders {
            message_id: "a".into(),
            timestamp: NOW.into(),
            ..Default::default()
        };
        h.message_type = "notification".into();
        assert_eq!(
            handle_webhook(SECRET, &h, b"{}", now_ms()),
            Err(WebhookError::MissingHeader(
                "Twitch-Eventsub-Message-Signature"
            ))
        );
    }

    #[test]
    fn revocation_is_parsed() {
        let body = json!({"subscription": {"type": "channel.follow", "status": "authorization_revoked",
                                           "condition": {"broadcaster_user_id": "1"}}});
        let (h, b) = signed("revocation", &body);
        assert_eq!(
            handle_webhook(SECRET, &h, &b, now_ms()).unwrap(),
            WebhookMessage::Revocation {
                subscription_type: "channel.follow".into(),
                status: "authorization_revoked".into()
            }
        );
    }

    #[test]
    fn follow() {
        let e = notification(
            "channel.follow",
            json!({"broadcaster_user_id": "1337", "moderator_user_id": "1337"}),
            json!({"user_id": "1234", "user_login": "cool_user", "user_name": "Cool_User",
                   "broadcaster_user_id": "1337", "broadcaster_user_login": "cooler_user",
                   "broadcaster_user_name": "Cooler_User", "followed_at": "2026-11-25T11:59:59Z"}),
        );
        assert_eq!(e.id, "twitch:msg-1");
        assert_eq!(e.channel, "twitch:1337");
        assert_eq!(e.kind, EventKind::Follow);
        assert_eq!(e.actor.unwrap().display_name, "Cool_User");
        assert_eq!(e.created_at, "2026-11-25T11:59:59Z");
        assert_eq!(e.raw["user_login"], "cool_user");
    }

    #[test]
    fn gifted_sub_and_community_gift() {
        let e = notification(
            "channel.subscribe",
            json!({"broadcaster_user_id": "1"}),
            json!({"user_id": "2", "user_login": "a", "user_name": "A", "tier": "1000", "is_gift": true}),
        );
        assert_eq!(e.kind, EventKind::GiftedSub);
        assert!(e.gifted);
        assert_eq!(e.tier.as_deref(), Some("1000"));

        let anon = notification(
            "channel.subscription.gift",
            json!({"broadcaster_user_id": "1"}),
            json!({"user_id": null, "user_login": null, "user_name": null, "total": 5,
                   "tier": "1000", "cumulative_total": null, "is_anonymous": true}),
        );
        assert_eq!(anon.kind, EventKind::CommunityGift);
        assert_eq!(anon.actor, None);
        assert_eq!(anon.amount, Some(5.0));
    }

    #[test]
    fn resub_message() {
        let e = notification(
            "channel.subscription.message",
            json!({"broadcaster_user_id": "1"}),
            json!({"user_id": "2", "user_login": "a", "user_name": "A", "tier": "2000",
                   "message": {"text": "Love the stream!", "emotes": []},
                   "cumulative_months": 15, "streak_months": 1, "duration_months": 6}),
        );
        assert_eq!(e.kind, EventKind::Subscriber);
        assert_eq!(e.message.as_deref(), Some("Love the stream!"));
        assert_eq!(e.amount, Some(15.0));
    }

    #[test]
    fn cheer_anonymous() {
        let e = notification(
            "channel.cheer",
            json!({"broadcaster_user_id": "1"}),
            json!({"is_anonymous": true, "user_id": null, "user_login": null, "user_name": null,
                   "message": "pogchamp", "bits": 1000}),
        );
        assert_eq!(e.kind, EventKind::Cheer);
        assert_eq!(e.actor, None);
        assert_eq!(e.amount, Some(1000.0));
        assert_eq!(e.currency.as_deref(), Some("bits"));
    }

    #[test]
    fn raid_incoming_and_outgoing() {
        let raid = json!({"from_broadcaster_user_id": "9", "from_broadcaster_user_login": "raider",
                          "from_broadcaster_user_name": "Raider", "to_broadcaster_user_id": "1",
                          "to_broadcaster_user_login": "me", "to_broadcaster_user_name": "Me",
                          "viewers": 9001});
        let incoming = notification(
            "channel.raid",
            json!({"to_broadcaster_user_id": "1"}),
            raid.clone(),
        );
        assert_eq!(incoming.channel, "twitch:1");
        assert_eq!(incoming.kind, EventKind::Raid);
        assert_eq!(incoming.actor.unwrap().login, "raider");
        assert_eq!(incoming.amount, Some(9001.0));

        let outgoing = notification(
            "channel.raid",
            json!({"from_broadcaster_user_id": "9"}),
            raid,
        );
        assert_eq!(outgoing.channel, "twitch:9");
        assert_eq!(outgoing.kind, EventKind::Other);
    }

    #[test]
    fn redemption() {
        let e = notification(
            "channel.channel_points_custom_reward_redemption.add",
            json!({"broadcaster_user_id": "1"}),
            json!({"id": "r1", "user_id": "2", "user_login": "a", "user_name": "A",
                   "user_input": "pick me", "status": "unfulfilled",
                   "reward": {"id": "x", "title": "Hydrate", "cost": 500, "prompt": ""},
                   "redeemed_at": "2026-11-25T11:00:00Z"}),
        );
        assert_eq!(e.kind, EventKind::Redemption);
        assert_eq!(e.redemption.as_deref(), Some("Hydrate"));
        assert_eq!(e.amount, Some(500.0));
        assert_eq!(e.message.as_deref(), Some("pick me"));
    }

    #[test]
    fn chat_is_not_an_alert() {
        let e = notification(
            "channel.chat.message",
            json!({"broadcaster_user_id": "1", "user_id": "bot"}),
            json!({"broadcaster_user_id": "1", "chatter_user_id": "3", "chatter_user_login": "c",
                   "chatter_user_name": "C", "message_id": "m", "message": {"text": "hi", "fragments": []}}),
        );
        assert_eq!(e.kind, EventKind::Chat);
        assert!(!e.kind.is_alert());
        assert_eq!(e.message.as_deref(), Some("hi"));
    }

    #[test]
    fn unknown_type_is_kept_as_other() {
        let e = notification(
            "channel.hype_train.begin",
            json!({"broadcaster_user_id": "1"}),
            json!({"level": 2}),
        );
        assert_eq!(e.kind, EventKind::Other);
        assert_eq!(e.raw["level"], 2);
    }

    #[test]
    fn channel_subscriptions_cover_phase_one() {
        let subs = channel_subscriptions("42");
        assert_eq!(subs.len(), 21);
        let hype = subs
            .iter()
            .find(|s| s.kind == "channel.hype_train.begin")
            .unwrap();
        assert_eq!((hype.version, hype.grant), ("2", Some("alerts")));
        let follow = &subs[0];
        assert_eq!(follow.kind, "channel.follow");
        assert_eq!(follow.version, "2");
        assert_eq!(follow.condition["moderator_user_id"], "42");
        let chat = subs
            .iter()
            .find(|s| s.kind == "channel.chat.message")
            .unwrap();
        assert_eq!(chat.condition["user_id"], "42");
        assert!(chat.needs_sign_in);
        assert_eq!(feature_of("channel.subscription.gift"), Some(Feature::Subs));
        assert_eq!(feature_of("channel.raid"), Some(Feature::Raids));
        assert_eq!(
            feature_of("channel.hype_train.begin"),
            Some(Feature::ChatAlerts)
        );
        assert_eq!(feature_of("channel.shield_mode.begin"), None);
        // Each kind is subscribed once.
        let mut kinds: Vec<_> = subs.iter().map(|s| s.kind).collect();
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds.len(), subs.len());
    }
}

//! Per channel alert settings, and how an event looks as an alert.
//!
//! The streamer chooses, for each kind of alert: whether it plays, the least
//! amount that plays it (bits, raid viewers, gifted subs, tip amount), how long
//! it stays on screen, the label over the name and the line under it. The
//! channel applies these when an event arrives and when an alert plays, so
//! every overlay shows the same thing.

use serde::{Deserialize, Serialize};

use crate::event::{Event, EventKind};

/// The kinds that can play as alerts, in the order the dashboard lists them.
pub const ALERT_KINDS: [EventKind; 7] = [
    EventKind::Follow,
    EventKind::Subscriber,
    EventKind::CommunityGift,
    EventKind::Cheer,
    EventKind::Raid,
    EventKind::Tip,
    EventKind::Redemption,
];

pub const MIN_DURATION_MS: u32 = 2_000;
pub const MAX_DURATION_MS: u32 = 20_000;
pub const DEFAULT_DURATION_MS: u32 = 5_000;
pub const MAX_LABEL: usize = 40;
pub const MAX_TEMPLATE: usize = 120;

/// Settings for one kind of alert.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindSettings {
    pub kind: EventKind,
    pub enabled: bool,
    /// Events with a smaller amount go to the feed only. 0 plays every one.
    /// Only used by kinds that have an amount (see [`has_minimum`]).
    #[serde(default)]
    pub min_amount: f64,
    pub duration_ms: u32,
    /// The small line above the name, such as "New follower".
    pub label: String,
    /// The line under the name. `{name}` and `{amount}` are filled in.
    pub template: String,
    /// Show what the viewer wrote with their cheer, sub or tip.
    #[serde(default = "yes")]
    pub show_message: bool,
    /// An uploaded sound to play (see [`crate::media`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
    /// An uploaded image or GIF to show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// The sound's loudness, 0 to 100.
    #[serde(default = "loud")]
    pub volume: u8,
}

fn yes() -> bool {
    true
}

fn loud() -> u8 {
    70
}

/// Every alert kind's settings. Missing kinds take their defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertSettings {
    pub kinds: Vec<KindSettings>,
}

/// Whether a kind has an amount worth a minimum.
pub fn has_minimum(kind: EventKind) -> bool {
    matches!(
        kind,
        EventKind::CommunityGift | EventKind::Cheer | EventKind::Raid | EventKind::Tip
    )
}

pub fn default_for(kind: EventKind) -> KindSettings {
    let (label, template) = match kind {
        EventKind::Follow => ("New follower", "Thanks for the follow!"),
        EventKind::Subscriber => ("New subscriber", "Thanks for subscribing!"),
        EventKind::CommunityGift => ("Gifted subs", "Gifted {amount} subs to the community"),
        EventKind::Cheer => ("Cheer", "Cheered {amount} bits"),
        EventKind::Raid => ("Raid", "Raiding with {amount} viewers"),
        EventKind::Tip => ("Tip", "Tipped {amount}"),
        EventKind::Redemption => ("Redemption", "Redeemed {reward}"),
        _ => ("Alert", ""),
    };
    KindSettings {
        kind,
        enabled: true,
        min_amount: 0.0,
        duration_ms: DEFAULT_DURATION_MS,
        label: label.into(),
        template: template.into(),
        show_message: true,
        sound: None,
        image: None,
        volume: loud(),
    }
}

impl Default for AlertSettings {
    fn default() -> Self {
        AlertSettings {
            kinds: ALERT_KINDS.iter().map(|k| default_for(*k)).collect(),
        }
    }
}

/// Why settings were refused, in words for the dashboard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid(pub String);

impl AlertSettings {
    /// Settings for one kind, or its defaults.
    pub fn get(&self, kind: EventKind) -> KindSettings {
        self.kinds
            .iter()
            .find(|k| k.kind == kind)
            .cloned()
            .unwrap_or_else(|| default_for(kind))
    }

    /// Check settings from the dashboard and put them in canonical form: one
    /// entry per alert kind in [`ALERT_KINDS`] order, text trimmed.
    pub fn validated(self) -> Result<AlertSettings, Invalid> {
        let mut out = Vec::with_capacity(ALERT_KINDS.len());
        for kind in ALERT_KINDS {
            let mut k = self.get(kind);
            if self.kinds.iter().filter(|x| x.kind == kind).count() > 1 {
                return Err(Invalid(format!("{kind:?} is listed twice")));
            }
            if !(MIN_DURATION_MS..=MAX_DURATION_MS).contains(&k.duration_ms) {
                return Err(Invalid(format!(
                    "Alerts stay on screen for {} to {} seconds",
                    MIN_DURATION_MS / 1000,
                    MAX_DURATION_MS / 1000
                )));
            }
            if !k.min_amount.is_finite() || k.min_amount < 0.0 || k.min_amount > 1_000_000.0 {
                return Err(Invalid(
                    "The minimum must be between 0 and 1,000,000".into(),
                ));
            }
            if !has_minimum(kind) {
                k.min_amount = 0.0;
            }
            k.sound = k.sound.filter(|v| !v.is_empty());
            k.image = k.image.filter(|v| !v.is_empty());
            if k.sound
                .as_deref()
                .is_some_and(|v| !crate::media::valid_id(v) || !crate::media::is_sound(v))
            {
                return Err(Invalid("Pick a sound you uploaded".into()));
            }
            if k.image
                .as_deref()
                .is_some_and(|v| !crate::media::valid_id(v) || crate::media::is_sound(v))
            {
                return Err(Invalid("Pick an image you uploaded".into()));
            }
            k.volume = k.volume.min(100);
            k.label = k.label.trim().to_string();
            k.template = k.template.trim().to_string();
            if k.label.chars().count() > MAX_LABEL {
                return Err(Invalid(format!(
                    "Labels can be up to {MAX_LABEL} characters"
                )));
            }
            if k.template.chars().count() > MAX_TEMPLATE {
                return Err(Invalid(format!(
                    "Messages can be up to {MAX_TEMPLATE} characters"
                )));
            }
            out.push(k);
        }
        if let Some(stray) = self.kinds.iter().find(|k| !ALERT_KINDS.contains(&k.kind)) {
            return Err(Invalid(format!("{:?} cannot play as an alert", stray.kind)));
        }
        Ok(AlertSettings { kinds: out })
    }

    /// Whether this event should go into the alert queue.
    pub fn plays(&self, event: &Event) -> bool {
        if !event.kind.is_alert() {
            return false;
        }
        let k = self.get(event.kind);
        if !k.enabled {
            return false;
        }
        if has_minimum(event.kind) && k.min_amount > 0.0 {
            return event.amount.unwrap_or(0.0) >= k.min_amount;
        }
        true
    }

    /// What the overlay shows for this event.
    pub fn view(&self, event: &Event) -> AlertView {
        let k = self.get(event.kind);
        let name = event
            .actor
            .as_ref()
            .map(|a| a.display_name.clone())
            .unwrap_or_else(|| "Anonymous".into());
        let detail = fill(&k.template, &name, event);
        let message = if k.show_message {
            event.message.clone().filter(|m| !m.trim().is_empty())
        } else {
            None
        };
        AlertView {
            label: k.label,
            name,
            detail,
            message,
            duration_ms: k.duration_ms,
            sound: k.sound,
            image: k.image,
            volume: k.volume,
        }
    }
}

/// The text of one alert, ready to show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertView {
    pub label: String,
    pub name: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub duration_ms: u32,
    /// Uploaded media ids, served at `/media/{channel}/{id}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default = "loud")]
    pub volume: u8,
}

fn amount_text(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        let digits = format!("{}", n as i64);
        // Group thousands: 12000 -> 12,000.
        let (sign, digits) = digits
            .strip_prefix('-')
            .map_or(("", digits.as_str()), |d| ("-", d));
        let mut out = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        format!("{sign}{out}")
    } else {
        format!("{n:.2}")
    }
}

/// Fill `{name}`, `{amount}` and `{reward}` in a template. Unknown braces stay as written.
pub fn fill(template: &str, name: &str, event: &Event) -> String {
    let amount = event.amount.map(amount_text).unwrap_or_default();
    let amount = match (&event.currency, event.kind) {
        (Some(c), EventKind::Tip) if !amount.is_empty() => format!("{amount} {c}"),
        _ => amount,
    };
    template
        .replace("{name}", name)
        .replace("{amount}", &amount)
        .replace(
            "{reward}",
            event.redemption.as_deref().unwrap_or("a reward"),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Actor, Platform};

    fn ev(kind: EventKind, amount: Option<f64>) -> Event {
        Event {
            id: "t".into(),
            channel: "twitch:1".into(),
            platform: Platform::Twitch,
            kind,
            raw_type: "x".into(),
            created_at: "2026-11-25T00:00:00Z".into(),
            actor: Some(Actor {
                id: "1".into(),
                login: "rowan".into(),
                display_name: "Rowan".into(),
            }),
            amount,
            currency: None,
            message: Some("hello".into()),
            tier: None,
            gifted: false,
            sender: None,
            redemption: None,
            raw: serde_json::Value::Null,
        }
    }

    #[test]
    fn defaults_play_every_alert_kind_and_nothing_else() {
        let s = AlertSettings::default();
        assert_eq!(s.kinds.len(), ALERT_KINDS.len());
        assert!(s.plays(&ev(EventKind::Cheer, Some(1.0))));
        assert!(s.plays(&ev(EventKind::Follow, None)));
        assert!(!s.plays(&ev(EventKind::Chat, None)));
        assert!(!s.plays(&ev(EventKind::GiftedSub, None)));
    }

    #[test]
    fn minimums_and_switches_apply() {
        let mut s = AlertSettings::default();
        s.kinds.iter_mut().for_each(|k| {
            if k.kind == EventKind::Cheer {
                k.min_amount = 100.0;
            }
            if k.kind == EventKind::Follow {
                k.enabled = false;
            }
        });
        assert!(!s.plays(&ev(EventKind::Cheer, Some(99.0))));
        assert!(s.plays(&ev(EventKind::Cheer, Some(100.0))));
        assert!(!s.plays(&ev(EventKind::Cheer, None)));
        assert!(!s.plays(&ev(EventKind::Follow, None)));
    }

    #[test]
    fn view_fills_the_template() {
        let s = AlertSettings::default();
        let v = s.view(&ev(EventKind::Cheer, Some(12000.0)));
        assert_eq!(v.label, "Cheer");
        assert_eq!(v.name, "Rowan");
        assert_eq!(v.detail, "Cheered 12,000 bits");
        assert_eq!(v.message.as_deref(), Some("hello"));
        assert_eq!(v.duration_ms, DEFAULT_DURATION_MS);
        let mut tip = ev(EventKind::Tip, Some(5.5));
        tip.currency = Some("USD".into());
        assert_eq!(s.view(&tip).detail, "Tipped 5.50 USD");
        assert_eq!(fill("{name} {nope}", "A", &tip), "A {nope}");
    }

    #[test]
    fn validation_canonicalizes_and_refuses_bad_values() {
        let partial = AlertSettings {
            kinds: vec![KindSettings {
                label: "  Hi  ".into(),
                min_amount: 5.0,
                ..default_for(EventKind::Follow)
            }],
        };
        let v = partial.validated().unwrap();
        assert_eq!(v.kinds.len(), ALERT_KINDS.len());
        assert_eq!(v.get(EventKind::Follow).label, "Hi");
        assert_eq!(
            v.get(EventKind::Follow).min_amount,
            0.0,
            "follows have no amount"
        );

        let long = AlertSettings {
            kinds: vec![KindSettings {
                duration_ms: 60_000,
                ..default_for(EventKind::Raid)
            }],
        };
        assert!(long.validated().is_err());
        let chat = AlertSettings {
            kinds: vec![default_for(EventKind::Chat)],
        };
        assert!(chat.validated().is_err());
        let neg = AlertSettings {
            kinds: vec![KindSettings {
                min_amount: -1.0,
                ..default_for(EventKind::Cheer)
            }],
        };
        assert!(neg.validated().is_err());
    }

    #[test]
    fn settings_round_trip_as_camel_case_json() {
        let json = serde_json::to_string(&AlertSettings::default()).unwrap();
        assert!(json.contains("\"minAmount\":0.0") && json.contains("\"durationMs\":5000"));
        let back: AlertSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, AlertSettings::default());
    }
}

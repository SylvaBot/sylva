//! Overlay widgets besides the alert box: a list of recent events, "latest"
//! labels, a goal bar and a chat box. Each is its own OBS Browser Source on
//! the channel's overlay link (`?widget=...`), connecting with
//! [`Role::Widget`](crate::protocol::Role::Widget): it sees events live but
//! never plays or acknowledges alerts.

use serde::{Deserialize, Serialize};

use crate::event::{EventKind, StoredEvent};

/// What a goal counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GoalKind {
    Follows,
    Subs,
    Bits,
}

impl GoalKind {
    /// How much one event moves this goal.
    pub fn counts(self, kind: EventKind, amount: Option<f64>) -> f64 {
        match (self, kind) {
            (GoalKind::Follows, EventKind::Follow) => 1.0,
            // Each gifted sub arrives as its own GiftedSub event.
            (GoalKind::Subs, EventKind::Subscriber | EventKind::GiftedSub) => 1.0,
            (GoalKind::Bits, EventKind::Cheer) => amount.unwrap_or(0.0).max(0.0),
            _ => 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub title: String,
    pub kind: GoalKind,
    pub target: f64,
    /// Counting starts here (ms since the epoch). Reset moves it to now.
    pub since: i64,
}

pub const MAX_GOAL_TITLE: usize = 60;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSettings {
    #[serde(default)]
    pub goal: Option<Goal>,
}

impl WidgetSettings {
    pub fn validated(mut self) -> Result<WidgetSettings, crate::alerts::Invalid> {
        use crate::alerts::Invalid;
        if let Some(g) = self.goal.as_mut() {
            g.title = g.title.trim().to_string();
            if g.title.is_empty() {
                return Err(Invalid("Give the goal a title".into()));
            }
            if g.title.chars().count() > MAX_GOAL_TITLE {
                return Err(Invalid(format!(
                    "Goal titles can be up to {MAX_GOAL_TITLE} characters"
                )));
            }
            if !g.target.is_finite() || g.target < 1.0 || g.target > 10_000_000.0 {
                return Err(Invalid(
                    "The target must be between 1 and 10,000,000".into(),
                ));
            }
            g.target = g.target.round();
            if g.since < 0 {
                return Err(Invalid("The goal start is not a valid time".into()));
            }
        }
        Ok(self)
    }
}

/// A goal with its progress, as widgets show it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalView {
    pub title: String,
    pub kind: GoalKind,
    pub target: f64,
    pub current: f64,
    pub since: i64,
}

/// Everything a widget needs when it connects. After this, it follows live
/// `event` frames itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetData {
    /// Recent alert kind events, newest first.
    pub recent: Vec<StoredEvent>,
    /// The newest event of each kind in [`LATEST_KINDS`], when there is one.
    pub latest: Vec<StoredEvent>,
    /// Recent chat lines, oldest first.
    pub chat: Vec<StoredEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<GoalView>,
}

/// Kinds that the event list widget shows.
pub const LIST_KINDS: [EventKind; 7] = [
    EventKind::Follow,
    EventKind::Subscriber,
    EventKind::CommunityGift,
    EventKind::Cheer,
    EventKind::Raid,
    EventKind::Tip,
    EventKind::Redemption,
];

/// Kinds a "latest" label can show.
pub const LATEST_KINDS: [EventKind; 5] = [
    EventKind::Follow,
    EventKind::Subscriber,
    EventKind::CommunityGift,
    EventKind::Cheer,
    EventKind::Raid,
];

pub const RECENT_LIMIT: u64 = 20;
pub const CHAT_LIMIT: u64 = 30;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goals_count_the_right_events() {
        assert_eq!(GoalKind::Follows.counts(EventKind::Follow, None), 1.0);
        assert_eq!(GoalKind::Follows.counts(EventKind::Cheer, Some(5.0)), 0.0);
        assert_eq!(GoalKind::Subs.counts(EventKind::GiftedSub, None), 1.0);
        assert_eq!(
            GoalKind::Subs.counts(EventKind::CommunityGift, Some(5.0)),
            0.0,
            "the gift's recipients count, not the gift"
        );
        assert_eq!(GoalKind::Bits.counts(EventKind::Cheer, Some(250.0)), 250.0);
        assert_eq!(GoalKind::Bits.counts(EventKind::Cheer, Some(-3.0)), 0.0);
    }

    #[test]
    fn goal_validation() {
        let ok = WidgetSettings {
            goal: Some(Goal {
                title: "  Sub goal ".into(),
                kind: GoalKind::Subs,
                target: 49.6,
                since: 1,
            }),
        }
        .validated()
        .unwrap();
        let g = ok.goal.unwrap();
        assert_eq!((g.title.as_str(), g.target), ("Sub goal", 50.0));
        let bad = |target: f64, title: &str| {
            WidgetSettings {
                goal: Some(Goal {
                    title: title.into(),
                    kind: GoalKind::Bits,
                    target,
                    since: 0,
                }),
            }
            .validated()
            .is_err()
        };
        assert!(bad(0.0, "x"));
        assert!(bad(f64::NAN, "x"));
        assert!(bad(10.0, "   "));
        assert!(WidgetSettings::default().validated().is_ok());
    }
}

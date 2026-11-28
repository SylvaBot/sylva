//! Team access: people the owner lets help run a channel.
//!
//! Each teammate signs in with their own Twitch account and gets one role:
//!
//! * **Editor** changes everything the owner can, except the team itself and
//!   the overlay link (a new link would break the owner's OBS).
//! * **Moderator** runs the live parts: the alert queue, moderation's log,
//!   viewers' points, the store queue, giveaways, quotes and counters.
//!   Everything else is read only.
//! * **Viewer** sees every page and changes nothing.
//!
//! [`allows`] is the single rule the Worker checks on every channel request,
//! so the dashboard hiding a button is a courtesy, never the protection.

use serde::{Deserialize, Serialize};

/// The most people a channel can add to its team.
pub const MAX_TEAM: usize = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Moderator,
    Editor,
    Owner,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "viewer" => Some(Role::Viewer),
            "moderator" => Some(Role::Moderator),
            "editor" => Some(Role::Editor),
            "owner" => Some(Role::Owner),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Moderator => "moderator",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }
}

/// Whether `role` may make a request to the channel API. `rest` is the path
/// after `/v1/channels/{key}/`, split on `/`.
pub fn allows(role: Role, post: bool, rest: &[&str]) -> bool {
    if role == Role::Owner {
        return true;
    }
    match rest {
        // Only the owner manages the team.
        ["team", ..] => false,
        // An import uses the owner's own StreamElements account.
        ["import", ..] => false,
        // The overlay link is a secret that shows the channel's alerts.
        ["overlay"] => role >= Role::Editor && !post,
        ["overlay", "rotate"] => false,
        // Only the owner decides where their money goes and how tips work.
        ["tips", "connect" | "disconnect" | "settings"] => false,
        // `!ask` spends the owner's own AI credit.
        ["bot", "ask"] => false,
        // The Spotify sign in plays on the owner's own account.
        ["songs", "spotify", ..] => false,
        _ if !post => true,
        _ if role == Role::Editor => true,
        _ if role == Role::Moderator => matches!(
            rest,
            ["alerts", ..]
                | ["moderation", "log", _, "undo"]
                | ["loyalty", "viewers", _, "adjust"]
                | ["loyalty", "redemptions", ..]
                | ["giveaways", ..]
                // Moderators can let a held tip through or turn it back.
                | ["tips", _, "approve" | "reject"]
                | ["bot", "quotes", ..]
                // Moderators run the song queue; settings stay with editors.
                | ["songs", "next" | "control" | "add" | "clear"]
                | ["songs", _, "remove" | "move"]
                | ["bot", "counters", _, "set"]
                // Trying a message changes nothing.
                | ["bot", "try"]
                | ["moderation", "try"]
        ),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn can(role: Role, post: bool, path: &str) -> bool {
        let rest: Vec<&str> = path.split('/').collect();
        allows(role, post, &rest)
    }

    #[test]
    fn roles() {
        for r in ["viewer", "moderator", "editor", "owner"] {
            assert_eq!(Role::parse(r).unwrap().as_str(), r);
        }
        assert_eq!(Role::parse("admin"), None);

        assert!(can(Role::Owner, true, "team"));
        assert!(can(Role::Owner, true, "overlay/rotate"));
        for r in [Role::Viewer, Role::Moderator, Role::Editor] {
            assert!(!can(r, false, "team"), "{r:?}");
            assert!(!can(r, true, "team/123/remove"), "{r:?}");
            assert!(!can(r, true, "overlay/rotate"), "{r:?}");
            assert!(can(r, false, "history"), "{r:?}");
            assert!(can(r, false, "ws"), "{r:?}");
        }
        assert!(can(Role::Editor, false, "overlay"));
        assert!(!can(Role::Moderator, false, "overlay"));
        assert!(can(Role::Editor, true, "alert-settings"));
        assert!(can(Role::Editor, true, "scene/publish"));

        assert!(can(Role::Moderator, true, "alerts/pause"));
        assert!(can(Role::Moderator, true, "giveaways/3/draw"));
        assert!(can(Role::Moderator, true, "loyalty/redemptions/9/refund"));
        assert!(can(Role::Moderator, true, "loyalty/viewers/77/adjust"));
        assert!(can(Role::Moderator, true, "moderation/log/4/undo"));
        assert!(can(Role::Moderator, true, "bot/quotes"));
        assert!(can(Role::Moderator, true, "bot/counters/deaths/set"));
        assert!(can(Role::Moderator, true, "bot/try"));
        assert!(!can(Role::Editor, true, "bot/ask"));
        assert!(!can(Role::Moderator, true, "bot/timers/t1/send"));
        assert!(!can(Role::Moderator, true, "bot"));
        assert!(!can(Role::Moderator, true, "loyalty"));
        assert!(!can(Role::Moderator, true, "loyalty/store"));
        assert!(!can(Role::Moderator, true, "moderation"));
        assert!(!can(Role::Moderator, true, "test-event"));
        assert!(!can(Role::Moderator, true, "twitch/subscribe"));

        assert!(!can(Role::Viewer, true, "alerts/pause"));
        assert!(!can(Role::Viewer, true, "giveaways"));
    }
}

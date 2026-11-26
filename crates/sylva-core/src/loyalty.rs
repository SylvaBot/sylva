//! Loyalty points: what viewers earn, and the chat commands to see them.
//!
//! Points are a ledger (every change has a reason) plus a cached balance per
//! viewer, so disputes are easy to settle and imports can be checked. While
//! the stream is live, every [`TICK_MS`] each viewer in chat earns
//! [`LoyaltySettings::watch`] points, and those who chatted in that window
//! earn [`LoyaltySettings::active`] more. Follows, subs, gifts and cheers add
//! one-off bonuses.
//!
//! Viewers who watch without chatting can only be seen with Twitch's chatter
//! list, which needs the `moderator:read:chatters` scope. Without it, Sylva
//! counts the viewers who chatted.

use serde::{Deserialize, Serialize};

use crate::alerts::Invalid;

/// How often watch points are paid while live.
pub const TICK_MS: i64 = 300_000;
pub const MAX_NAME: usize = 20;
/// The most a single rule may pay.
pub const MAX_RULE: u32 = 100_000;
/// The most a single change from chat or the dashboard may move.
pub const MAX_ADJUST: i64 = 10_000_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoyaltySettings {
    /// Off until the streamer turns it on.
    pub enabled: bool,
    /// What the points are called, such as `leaves`. Plural, lower case.
    pub name: String,
    /// Points every 5 minutes for being in chat while live.
    pub watch: u32,
    /// Extra points every 5 minutes for chatting.
    pub active: u32,
    pub follow: u32,
    /// For a sub or resub, to the subscriber.
    pub sub: u32,
    /// For each gifted sub, to the gifter.
    pub gift: u32,
    /// For every 100 bits cheered.
    pub cheer: u32,
    /// Viewers may give their own points with `!give @name 100`.
    #[serde(default)]
    pub give: bool,
    /// The points games in chat, all on by default.
    #[serde(default)]
    pub games: crate::games::GameSettings,
    /// `!raffle`, on by default.
    #[serde(default)]
    pub raffle: crate::games::RaffleSettings,
}

impl Default for LoyaltySettings {
    fn default() -> Self {
        LoyaltySettings {
            enabled: false,
            name: "points".into(),
            watch: 10,
            active: 5,
            follow: 50,
            sub: 250,
            gift: 100,
            cheer: 50,
            give: false,
            games: Default::default(),
            raffle: Default::default(),
        }
    }
}

impl LoyaltySettings {
    pub fn validated(mut self) -> Result<LoyaltySettings, Invalid> {
        let name = self.name.trim().to_lowercase();
        if name.is_empty()
            || name.chars().count() > MAX_NAME
            || !name
                .chars()
                .all(|c| c.is_alphanumeric() || c == ' ' || c == '-')
        {
            return Err(Invalid(format!(
                "Call your points something of up to {MAX_NAME} letters, such as leaves."
            )));
        }
        self.name = name;
        self.games = self.games.validated();
        self.raffle = self.raffle.validated()?;
        for v in [
            &mut self.watch,
            &mut self.active,
            &mut self.follow,
            &mut self.sub,
            &mut self.gift,
            &mut self.cheer,
        ] {
            *v = (*v).min(MAX_RULE);
        }
        Ok(self)
    }

    /// Points for a cheer of `bits`, rounded down to whole hundreds.
    pub fn for_cheer(&self, bits: f64) -> i64 {
        (bits.max(0.0) as i64 / 100) * i64::from(self.cheer)
    }
}

/// What a points command asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PointsCommand {
    /// `!points` or `!points @name`.
    Balance(Option<String>),
    /// `!top`: the five with the most.
    Top,
    /// `!give @name 100`.
    Give(String, i64),
    /// `!addpoints @name 100` or `!addpoints @name -100`, moderators only.
    Add(String, i64),
}

/// The login a viewer typed, without `@`, lower case.
pub fn login_arg(s: &str) -> Option<String> {
    let l = s.trim().trim_start_matches('@').to_lowercase();
    (!l.is_empty() && l.chars().all(|c| c.is_alphanumeric() || c == '_')).then_some(l)
}

fn amount(s: &str) -> Option<i64> {
    let n: i64 = s.replace(',', "").parse().ok()?;
    (n != 0 && n.abs() <= MAX_ADJUST).then_some(n)
}

/// The command in a chat line, given its trigger and words. `name` is what
/// the points are called, so `!leaves` works as well as `!points`.
pub fn points_command(trigger: &str, args: &[String], name: &str) -> Option<PointsCommand> {
    let named = name.replace(' ', "");
    match trigger {
        t if t == "points" || t == named => Some(PointsCommand::Balance(
            args.first().and_then(|a| login_arg(a)),
        )),
        "top" | "leaderboard" => Some(PointsCommand::Top),
        "give" => {
            let who = login_arg(args.first()?)?;
            let n = amount(args.get(1)?)?;
            (n > 0).then_some(PointsCommand::Give(who, n))
        }
        "addpoints" => Some(PointsCommand::Add(
            login_arg(args.first()?)?,
            amount(args.get(1)?)?,
        )),
        _ => None,
    }
}

/// The chat words loyalty answers to, besides the points' own name.
pub const TRIGGERS: [&str; 5] = ["points", "top", "leaderboard", "give", "addpoints"];

/// `1,240`.
pub fn grouped(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn commands() {
        use PointsCommand::*;
        assert_eq!(
            points_command("points", &args(""), "points"),
            Some(Balance(None))
        );
        assert_eq!(
            points_command("leaves", &args("@Rowan"), "leaves"),
            Some(Balance(Some("rowan".into())))
        );
        assert_eq!(points_command("top", &args(""), "points"), Some(Top));
        assert_eq!(
            points_command("give", &args("@Rowan 1,000"), "points"),
            Some(Give("rowan".into(), 1000))
        );
        assert_eq!(points_command("give", &args("@Rowan -5"), "points"), None);
        assert_eq!(points_command("give", &args("@Rowan"), "points"), None);
        assert_eq!(
            points_command("addpoints", &args("rowan -50"), "points"),
            Some(Add("rowan".into(), -50))
        );
        assert_eq!(
            points_command("addpoints", &args("rowan 0"), "points"),
            None
        );
        assert_eq!(points_command("lurk", &args(""), "points"), None);
    }

    #[test]
    fn settings_and_numbers() {
        let s = LoyaltySettings {
            name: "  Golden Leaves ".into(),
            watch: 999_999,
            ..Default::default()
        }
        .validated()
        .unwrap();
        assert_eq!(s.name, "golden leaves");
        assert_eq!(s.watch, MAX_RULE);
        assert!(LoyaltySettings {
            name: "<b>".into(),
            ..Default::default()
        }
        .validated()
        .is_err());
        assert_eq!(s.for_cheer(250.0), 100);
        assert_eq!(s.for_cheer(99.0), 0);
        assert_eq!(grouped(1_240), "1,240");
        assert_eq!(grouped(-1_000_000), "-1,000,000");
        assert_eq!(grouped(12), "12");
    }
}

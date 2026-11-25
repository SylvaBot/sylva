//! The chat bot: commands, who may use them, cooldowns and how a reply is
//! written.
//!
//! A command is a trigger such as `!lurk`, a reply with variables in it, and
//! a few rules. Variables use StreamElements' `${...}` style so commands
//! imported from StreamElements keep working:
//!
//! | Variable | Becomes |
//! | --- | --- |
//! | `${user}` | The viewer who used the command |
//! | `${touser}` | The first word after the command without `@`, or the viewer |
//! | `${1}` to `${9}` | That word after the command, or nothing |
//! | `${args}` | Everything after the command |
//! | `${channel}` | The streamer's name |
//! | `${count}` | How many times the command has been used, this time included |
//! | `${uptime}` | How long the stream has been live |
//! | `${random.1-100}` | A whole number in that range |
//! | `${commands}` | Every command anyone may use |
//!
//! Nothing here sends chat. The channel's Durable Object decides when a reply
//! goes out and sends it through Twitch.

use serde::{Deserialize, Serialize};

use crate::alerts::Invalid;

pub const MAX_COMMANDS: usize = 100;
pub const MAX_NAME: usize = 25;
pub const MAX_ALIASES: usize = 5;
/// Twitch refuses chat messages longer than 500 characters.
pub const MAX_REPLY: usize = 500;
pub const MAX_COOLDOWN_S: u32 = 3600;

/// Who may use a command. Each level includes the ones above it in rank, so a
/// moderator may use a subscriber command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserLevel {
    Everyone,
    Subscriber,
    Vip,
    Moderator,
    Broadcaster,
}

impl UserLevel {
    /// The level of a chatter from their Twitch badges (`set_id`s).
    pub fn from_badges<'a>(
        badges: impl IntoIterator<Item = &'a str>,
        is_broadcaster: bool,
    ) -> Self {
        if is_broadcaster {
            return UserLevel::Broadcaster;
        }
        let mut level = UserLevel::Everyone;
        for b in badges {
            let l = match b {
                "broadcaster" => UserLevel::Broadcaster,
                "moderator" | "lead_moderator" => UserLevel::Moderator,
                "vip" => UserLevel::Vip,
                "subscriber" | "founder" => UserLevel::Subscriber,
                _ => UserLevel::Everyone,
            };
            level = level.max(l);
        }
        level
    }
}

/// One command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    /// The trigger without `!`, in lower case, such as `lurk`.
    pub name: String,
    /// Other triggers for the same command.
    #[serde(default)]
    pub aliases: Vec<String>,
    pub reply: String,
    #[serde(default = "everyone")]
    pub level: UserLevel,
    /// Seconds before anyone may use it again. Moderators skip cooldowns.
    #[serde(default)]
    pub cooldown: u32,
    /// Seconds before the same viewer may use it again.
    #[serde(default)]
    pub user_cooldown: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// How many times it has been used. Kept by the server; a save keeps the
    /// stored count.
    #[serde(default)]
    pub count: u64,
}

fn everyone() -> UserLevel {
    UserLevel::Everyone
}
fn yes() -> bool {
    true
}

/// Everything the bot is set to do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotSettings {
    /// Off until the streamer turns the bot on.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub commands: Vec<Command>,
    #[serde(default)]
    pub timers: Vec<Timer>,
}

impl Default for BotSettings {
    fn default() -> Self {
        BotSettings {
            enabled: false,
            commands: default_commands(),
            timers: Vec::new(),
        }
    }
}

pub const MAX_TIMERS: usize = 20;
pub const MAX_TIMER_NAME: usize = 40;
pub const MIN_INTERVAL_MIN: u32 = 5;
pub const MAX_INTERVAL_MIN: u32 = 180;
pub const MAX_TIMER_LINES: u32 = 100;

/// A message the bot posts on a schedule, such as a reminder to follow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    /// Given by the server: `t1`, `t2`, ...
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub message: String,
    /// Minutes between messages.
    pub interval: u32,
    /// Chat lines needed since the last message, so the bot never talks to
    /// an empty room. 0 posts on time whatever chat does.
    #[serde(default)]
    pub lines: u32,
    /// Only post while the stream is live.
    #[serde(default = "yes")]
    pub live_only: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// Variables a timer may use: there is no viewer behind a timer.
fn timer_variable(name: &str) -> bool {
    matches!(name, "channel" | "uptime" | "commands") || parse_random(name).is_some()
}

impl Timer {
    /// When it may post next, given when it last posted, the chat lines since
    /// and whether the stream is live. `None` while it waits for something
    /// other than time (chat lines, going live, being turned on).
    pub fn due_at(&self, last: i64, lines: u32, live: bool) -> Option<i64> {
        if !self.enabled || (self.live_only && !live) || lines < self.lines {
            return None;
        }
        Some(last + self.interval as i64 * 60_000)
    }
}

/// The commands every channel starts with. They are ordinary commands the
/// streamer can change or delete.
pub fn default_commands() -> Vec<Command> {
    let c = |name: &str, reply: &str, level: UserLevel, cooldown: u32| Command {
        name: name.into(),
        aliases: Vec::new(),
        reply: reply.into(),
        level,
        cooldown,
        user_cooldown: 0,
        enabled: true,
        count: 0,
    };
    vec![
        c("commands", "Commands: ${commands}", UserLevel::Everyone, 30),
        c(
            "uptime",
            "${channel} has been live for ${uptime}.",
            UserLevel::Everyone,
            30,
        ),
        c(
            "lurk",
            "${user} is lurking. Enjoy the stream!",
            UserLevel::Everyone,
            0,
        ),
        c(
            "so",
            "Go give ${touser} a follow at twitch.tv/${touser}",
            UserLevel::Moderator,
            0,
        ),
    ]
}

/// Variable names a reply may use (without `${` and `}`).
fn known_variable(name: &str) -> bool {
    matches!(
        name,
        "user" | "touser" | "args" | "channel" | "count" | "uptime" | "commands"
    ) || (name.len() == 1 && (b'1'..=b'9').contains(&name.as_bytes()[0]))
        || parse_random(name).is_some()
}

/// `random.1-100` gives `(1, 100)`.
fn parse_random(name: &str) -> Option<(i64, i64)> {
    let (lo, hi) = name.strip_prefix("random.")?.split_once('-')?;
    let (lo, hi) = (
        lo.trim().parse::<i64>().ok()?,
        hi.trim().parse::<i64>().ok()?,
    );
    (lo <= hi && hi - lo <= 1_000_000_000).then_some((lo, hi))
}

/// A trigger is 1 to 25 letters, digits or `_`, stored in lower case.
fn clean_trigger(raw: &str) -> Result<String, Invalid> {
    let t = raw.trim().trim_start_matches('!').to_lowercase();
    let ok = !t.is_empty()
        && t.chars().count() <= MAX_NAME
        && t.chars().all(|c| c.is_alphanumeric() || c == '_');
    if ok {
        Ok(t)
    } else {
        Err(Invalid(format!(
            "\"{}\" cannot be a command. Use up to {MAX_NAME} letters, numbers or _.",
            raw.trim()
        )))
    }
}

/// The `${...}` names in a reply, in order, or an error for an unclosed one.
fn variables(reply: &str) -> Result<Vec<&str>, Invalid> {
    let mut out = Vec::new();
    let mut rest = reply;
    while let Some(i) = rest.find("${") {
        let after = &rest[i + 2..];
        let Some(end) = after.find('}') else {
            return Err(Invalid("A ${ in the reply is not closed with }".into()));
        };
        out.push(after[..end].trim());
        rest = &after[end + 1..];
    }
    Ok(out)
}

impl BotSettings {
    /// Check settings from the dashboard and tidy them. `stored` gives each
    /// command's use count back, so a save never resets or forges counts.
    pub fn validated(mut self, stored: &BotSettings) -> Result<BotSettings, Invalid> {
        if self.commands.len() > MAX_COMMANDS {
            return Err(Invalid(format!(
                "A channel can have up to {MAX_COMMANDS} commands"
            )));
        }
        let mut seen: Vec<String> = Vec::new();
        for c in &mut self.commands {
            c.name = clean_trigger(&c.name)?;
            let mut aliases = Vec::new();
            for a in &c.aliases {
                if a.trim().is_empty() {
                    continue;
                }
                let a = clean_trigger(a)?;
                if a != c.name && !aliases.contains(&a) {
                    aliases.push(a);
                }
            }
            if aliases.len() > MAX_ALIASES {
                return Err(Invalid(format!(
                    "!{} can have up to {MAX_ALIASES} other names",
                    c.name
                )));
            }
            c.aliases = aliases;
            for t in std::iter::once(&c.name).chain(c.aliases.iter()) {
                if seen.contains(t) {
                    return Err(Invalid(format!("!{t} is used by two commands")));
                }
                seen.push(t.clone());
            }
            c.reply = c.reply.trim().to_string();
            if c.reply.is_empty() {
                return Err(Invalid(format!("!{} needs a reply", c.name)));
            }
            if c.reply.chars().count() > MAX_REPLY {
                return Err(Invalid(format!(
                    "The reply for !{} is longer than {MAX_REPLY} characters",
                    c.name
                )));
            }
            for v in variables(&c.reply)? {
                if !known_variable(v) {
                    return Err(Invalid(format!(
                        "!{} uses ${{{v}}}, which Sylva does not know",
                        c.name
                    )));
                }
            }
            c.cooldown = c.cooldown.min(MAX_COOLDOWN_S);
            c.user_cooldown = c.user_cooldown.min(MAX_COOLDOWN_S);
            c.count = stored
                .commands
                .iter()
                .find(|s| s.name == c.name)
                .map_or(0, |s| s.count);
        }
        self.validate_timers(stored)?;
        Ok(self)
    }

    fn validate_timers(&mut self, stored: &BotSettings) -> Result<(), Invalid> {
        if self.timers.len() > MAX_TIMERS {
            return Err(Invalid(format!(
                "A channel can have up to {MAX_TIMERS} timers"
            )));
        }
        // Ids are the server's: keep the stored ones, number new ones after them.
        let number = |id: &str| id.strip_prefix('t').and_then(|n| n.parse::<u32>().ok());
        let mut next = stored
            .timers
            .iter()
            .chain(self.timers.iter())
            .filter_map(|t| number(&t.id))
            .max()
            .unwrap_or(0)
            + 1;
        let mut ids: Vec<String> = Vec::new();
        for t in &mut self.timers {
            let known = stored.timers.iter().any(|s| s.id == t.id);
            if !known || ids.contains(&t.id) {
                t.id = format!("t{next}");
                next += 1;
            }
            ids.push(t.id.clone());
            t.name = t.name.split_whitespace().collect::<Vec<_>>().join(" ");
            if t.name.is_empty() || t.name.chars().count() > MAX_TIMER_NAME {
                return Err(Invalid(format!(
                    "Each timer needs a name of up to {MAX_TIMER_NAME} characters"
                )));
            }
            t.message = t.message.trim().to_string();
            if t.message.is_empty() {
                return Err(Invalid(format!("The timer \"{}\" needs a message", t.name)));
            }
            if t.message.chars().count() > MAX_REPLY {
                return Err(Invalid(format!(
                    "The message for \"{}\" is longer than {MAX_REPLY} characters",
                    t.name
                )));
            }
            for v in variables(&t.message)? {
                if !timer_variable(v) {
                    return Err(Invalid(format!(
                        "The timer \"{}\" uses ${{{v}}}, which a timer cannot fill in. Timers can use ${{channel}}, ${{uptime}}, ${{commands}} and ${{random.1-100}}.",
                        t.name
                    )));
                }
            }
            t.interval = t.interval.clamp(MIN_INTERVAL_MIN, MAX_INTERVAL_MIN);
            t.lines = t.lines.min(MAX_TIMER_LINES);
        }
        Ok(())
    }

    /// The command a trigger names, enabled or not.
    pub fn find(&self, trigger: &str) -> Option<usize> {
        let t = trigger.to_lowercase();
        self.commands
            .iter()
            .position(|c| c.name == t || c.aliases.contains(&t))
    }
}

/// A chat line read as a command: `!so @Maple thanks` gives trigger `so` and
/// args `["@Maple", "thanks"]`.
pub fn parse(text: &str) -> Option<(String, Vec<String>)> {
    let rest = text.trim().strip_prefix('!')?;
    if rest.starts_with(char::is_whitespace) {
        return None;
    }
    let mut words = rest.split_whitespace();
    let trigger = words.next()?.to_lowercase();
    if trigger.is_empty() {
        return None;
    }
    Some((trigger, words.map(String::from).collect()))
}

/// What a reply is written from.
pub struct ReplyContext<'a> {
    pub user: &'a str,
    pub args: &'a [String],
    pub channel: &'a str,
    pub count: u64,
    /// Milliseconds live, or `None` when offline.
    pub uptime_ms: Option<i64>,
    /// Every command, for `${commands}`.
    pub commands: &'a [Command],
    /// A random number from 0 to 1, for `${random}`.
    pub random: f64,
}

/// "2 hours 5 minutes", "12 minutes", "40 seconds".
pub fn duration_words(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    let (h, m) = (s / 3600, (s % 3600) / 60);
    let unit = |n: i64, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    match (h, m) {
        (0, 0) => unit(s, "second"),
        (0, m) => unit(m, "minute"),
        (h, 0) => unit(h, "hour"),
        (h, m) => format!("{} {}", unit(h, "hour"), unit(m, "minute")),
    }
}

/// Write a reply. The result is one line of at most [`MAX_REPLY`] characters.
///
/// A reply that uses `${uptime}` while the stream is offline becomes
/// "<channel> is offline right now." instead of a sentence about live time.
pub fn render(reply: &str, ctx: &ReplyContext) -> String {
    let mut offline = false;
    let mut out = String::new();
    let mut rest = reply;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[i..]);
            rest = "";
            break;
        };
        let name = after[..end].trim();
        let arg = |n: usize| ctx.args.get(n).cloned().unwrap_or_default();
        let value = match name {
            "user" => ctx.user.to_string(),
            "touser" => {
                let t = arg(0);
                let t = t.trim_start_matches('@');
                if t.is_empty() {
                    ctx.user.to_string()
                } else {
                    t.to_string()
                }
            }
            "args" => ctx.args.join(" "),
            "channel" => ctx.channel.to_string(),
            "count" => ctx.count.to_string(),
            "uptime" => match ctx.uptime_ms {
                Some(ms) => duration_words(ms),
                None => {
                    offline = true;
                    String::new()
                }
            },
            "commands" => {
                let list: Vec<String> = ctx
                    .commands
                    .iter()
                    .filter(|c| c.enabled && c.level == UserLevel::Everyone)
                    .map(|c| format!("!{}", c.name))
                    .collect();
                list.join(", ")
            }
            n if n.len() == 1 && (b'1'..=b'9').contains(&n.as_bytes()[0]) => {
                arg((n.as_bytes()[0] - b'1') as usize)
            }
            n => match parse_random(n) {
                Some((lo, hi)) => {
                    let span = (hi - lo + 1) as f64;
                    (lo + ((ctx.random.clamp(0.0, 0.999_999_999) * span) as i64)).to_string()
                }
                None => format!("${{{n}}}"),
            },
        };
        out.push_str(&value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    if offline {
        out = format!("{} is offline right now.", ctx.channel);
    }
    let line = out.split_whitespace().collect::<Vec<_>>().join(" ");
    line.chars().take(MAX_REPLY).collect()
}

/// Why a command did not reply, for the sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Skip {
    NotACommand,
    Unknown,
    Off,
    Level,
    Cooldown,
}

/// Whether a command may run now. `last_any` and `last_user` are when it last
/// ran for anyone and for this viewer, in milliseconds.
pub fn allowed(
    c: &Command,
    level: UserLevel,
    now: i64,
    last_any: Option<i64>,
    last_user: Option<i64>,
) -> Result<(), Skip> {
    if !c.enabled {
        return Err(Skip::Off);
    }
    if level < c.level {
        return Err(Skip::Level);
    }
    if level >= UserLevel::Moderator {
        return Ok(());
    }
    let waiting = |last: Option<i64>, secs: u32| last.is_some_and(|t| now - t < secs as i64 * 1000);
    if waiting(last_any, c.cooldown) || waiting(last_user, c.user_cooldown) {
        return Err(Skip::Cooldown);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(args: &'a [String], commands: &'a [Command]) -> ReplyContext<'a> {
        ReplyContext {
            user: "Maple",
            args,
            channel: "Haruxee",
            count: 7,
            uptime_ms: Some(2 * 3_600_000 + 5 * 60_000),
            commands,
            random: 0.5,
        }
    }

    #[test]
    fn levels_come_from_badges() {
        assert_eq!(UserLevel::from_badges([], false), UserLevel::Everyone);
        assert_eq!(
            UserLevel::from_badges(["subscriber", "vip"], false),
            UserLevel::Vip
        );
        assert_eq!(
            UserLevel::from_badges(["moderator"], false),
            UserLevel::Moderator
        );
        assert_eq!(
            UserLevel::from_badges(["founder"], false),
            UserLevel::Subscriber
        );
        assert_eq!(UserLevel::from_badges([], true), UserLevel::Broadcaster);
        assert!(UserLevel::Moderator > UserLevel::Vip);
    }

    #[test]
    fn replies_fill_variables() {
        let cmds = default_commands();
        let args: Vec<String> = vec!["@Juniper".into(), "two".into()];
        let c = ctx(&args, &cmds);
        assert_eq!(
            render(
                "Hi ${user}, ${touser}! ${1}/${2}/${3} [${args}] ${count}",
                &c
            ),
            "Hi Maple, Juniper! @Juniper/two/ [@Juniper two] 7"
        );
        assert_eq!(
            render("${channel} live ${uptime}", &c),
            "Haruxee live 2 hours 5 minutes"
        );
        let off = ReplyContext {
            uptime_ms: None,
            ..ctx(&args, &cmds)
        };
        assert_eq!(
            render("${channel} has been live for ${uptime}.", &off),
            "Haruxee is offline right now."
        );
        assert_eq!(render("${random.1-10}", &c), "6");
        assert_eq!(render("${commands}", &c), "!commands, !uptime, !lurk");
        assert_eq!(render("${nope} ${unclosed", &c), "${nope} ${unclosed");
        let none: Vec<String> = vec![];
        assert_eq!(render("${touser}", &ctx(&none, &cmds)), "Maple");
        let long = "x".repeat(600);
        assert_eq!(render(&long, &c).len(), MAX_REPLY);
        assert_eq!(render("a\nb   c", &c), "a b c");
    }

    #[test]
    fn durations_read_well() {
        assert_eq!(duration_words(40_000), "40 seconds");
        assert_eq!(duration_words(60_000), "1 minute");
        assert_eq!(duration_words(3_600_000), "1 hour");
        assert_eq!(duration_words(3_600_000 + 60_000), "1 hour 1 minute");
    }

    #[test]
    fn parsing_chat() {
        assert_eq!(
            parse("!SO @maple hi"),
            Some(("so".into(), vec!["@maple".into(), "hi".into()]))
        );
        assert_eq!(parse("  !lurk"), Some(("lurk".into(), vec![])));
        assert_eq!(parse("hello !lurk"), None);
        assert_eq!(parse("!"), None);
        assert_eq!(parse("! lurk"), None);
    }

    #[test]
    fn settings_are_checked_and_counts_kept() {
        let mut stored = BotSettings::default();
        stored.commands[2].count = 41;
        let mut s = BotSettings::default();
        s.commands[2].count = 9999;
        s.commands[2].name = " !LURK ".into();
        s.commands[2].aliases = vec!["away".into(), "AWAY".into(), "lurk".into(), " ".into()];
        s.commands[2].cooldown = 99_999;
        let ok = s.validated(&stored).unwrap();
        assert_eq!(ok.commands[2].name, "lurk");
        assert_eq!(ok.commands[2].aliases, vec!["away".to_string()]);
        assert_eq!(ok.commands[2].count, 41);
        assert_eq!(ok.commands[2].cooldown, MAX_COOLDOWN_S);
        assert_eq!(ok.find("AWAY"), Some(2));

        let bad = |f: &dyn Fn(&mut BotSettings)| {
            let mut s = BotSettings::default();
            f(&mut s);
            s.validated(&stored).is_err()
        };
        assert!(bad(&|s| s.commands[0].name = "two words".into()));
        assert!(bad(&|s| s.commands[0].name = "".into()));
        assert!(bad(&|s| s.commands[1].aliases = vec!["commands".into()]));
        assert!(bad(&|s| s.commands[0].reply = "  ".into()));
        assert!(bad(&|s| s.commands[0].reply = "${what}".into()));
        assert!(bad(&|s| s.commands[0].reply = "${user".into()));
        assert!(bad(&|s| s.commands[0].reply = "x".repeat(501)));
        assert!(!bad(&|s| s.commands[0].reply = "${random.5-9} ${9}".into()));
    }

    fn timer(id: &str) -> Timer {
        Timer {
            id: id.into(),
            name: " Follow   reminder ".into(),
            message: "Enjoying ${channel}? Follow!".into(),
            interval: 2,
            lines: 500,
            live_only: true,
            enabled: true,
        }
    }

    #[test]
    fn timers_are_checked_and_numbered() {
        let stored = BotSettings {
            timers: vec![timer("t3")],
            ..Default::default()
        };
        let s = BotSettings {
            timers: vec![timer("t3"), timer("forged"), timer("t3")],
            ..Default::default()
        };
        let ok = s.validated(&stored).unwrap();
        let ids: Vec<&str> = ok.timers.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["t3", "t4", "t5"]);
        assert_eq!(ok.timers[0].name, "Follow reminder");
        assert_eq!(ok.timers[0].interval, MIN_INTERVAL_MIN);
        assert_eq!(ok.timers[0].lines, MAX_TIMER_LINES);

        let bad = |f: &dyn Fn(&mut Timer)| {
            let mut t = timer("");
            f(&mut t);
            let s = BotSettings {
                timers: vec![t],
                ..BotSettings::default()
            };
            s.validated(&stored).is_err()
        };
        assert!(bad(&|t| t.message = "Hi ${user}".into()));
        assert!(bad(&|t| t.message = " ".into()));
        assert!(bad(&|t| t.name = "".into()));
        assert!(!bad(
            &|t| t.message = "${uptime} ${random.1-3} ${commands}".into()
        ));
    }

    #[test]
    fn timers_wait_for_time_chat_and_going_live() {
        let mut t = timer("t1");
        t.interval = 10;
        t.lines = 5;
        assert_eq!(t.due_at(1_000, 5, true), Some(1_000 + 600_000));
        assert_eq!(t.due_at(1_000, 4, true), None, "needs chat");
        assert_eq!(t.due_at(1_000, 9, false), None, "offline");
        t.live_only = false;
        assert_eq!(t.due_at(1_000, 9, false), Some(601_000));
        t.enabled = false;
        assert_eq!(t.due_at(1_000, 9, true), None);
    }

    #[test]
    fn who_may_use_a_command_and_when() {
        let mut c = default_commands().remove(0);
        c.cooldown = 30;
        c.user_cooldown = 60;
        let now = 1_000_000;
        assert_eq!(allowed(&c, UserLevel::Everyone, now, None, None), Ok(()));
        assert_eq!(
            allowed(&c, UserLevel::Everyone, now, Some(now - 10_000), None),
            Err(Skip::Cooldown)
        );
        assert_eq!(
            allowed(&c, UserLevel::Everyone, now, Some(now - 31_000), None),
            Ok(())
        );
        assert_eq!(
            allowed(&c, UserLevel::Everyone, now, None, Some(now - 59_000)),
            Err(Skip::Cooldown)
        );
        assert_eq!(
            allowed(&c, UserLevel::Moderator, now, Some(now), Some(now)),
            Ok(())
        );
        c.level = UserLevel::Vip;
        assert_eq!(
            allowed(&c, UserLevel::Subscriber, now, None, None),
            Err(Skip::Level)
        );
        c.enabled = false;
        assert_eq!(
            allowed(&c, UserLevel::Broadcaster, now, None, None),
            Err(Skip::Off)
        );
    }
}

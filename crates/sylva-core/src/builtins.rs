//! Built-in chat commands: the ones every channel has without writing a
//! reply, such as `!followage`, `!clip` or `!addcmd`.
//!
//! Each one has its own switch, the lowest level of chatter who may use it
//! and a cooldown, kept in [`BuiltinSetting`]s inside the bot's settings. A
//! command the streamer writes with the same name replaces the built-in one,
//! so `!uptime` can say anything they like.
//!
//! This module holds the list and everything that needs no network: how
//! arguments are read, how ages and dates are written, the 8-ball's answers.
//! The channel's Durable Object runs them (see the Worker's `builtins`).

use chrono::{DateTime, Datelike, Months, Utc};
use serde::{Deserialize, Serialize};

use crate::bot::{UserLevel, MAX_COOLDOWN_S, MAX_REPLY};

/// Which part of the dashboard list a command sits in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    Info,
    Fun,
    Commands,
    Quotes,
    Stream,
    Moderation,
}

/// A permission the streamer gives on the Bot page before a command works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Needs {
    Nothing,
    /// The `commands` grant: clips, title and category, followers.
    Commands,
    /// The `moderation` grant: deleting messages and timeouts.
    Moderation,
}

/// One built-in command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Builtin {
    pub name: &'static str,
    /// Other words for it, such as `delquote` for `deletequote`.
    pub aliases: &'static [&'static str],
    pub group: Group,
    /// What it does, for the dashboard and the public commands page.
    pub about: &'static str,
    /// How to type it, such as `!followage @name`.
    pub usage: &'static str,
    /// Who may use it until the streamer changes it.
    pub level: UserLevel,
    /// The lowest level it may be set to. Commands that change the channel
    /// or remove messages never go below moderators.
    pub min: UserLevel,
    /// Seconds between uses, for chatters below moderator.
    pub cooldown: u32,
    /// On for a new channel.
    pub on: bool,
    pub needs: Needs,
}

const fn b(
    name: &'static str,
    group: Group,
    about: &'static str,
    usage: &'static str,
    level: UserLevel,
    cooldown: u32,
) -> Builtin {
    Builtin {
        name,
        aliases: &[],
        group,
        about,
        usage,
        level,
        min: UserLevel::Everyone,
        cooldown,
        on: true,
        needs: Needs::Nothing,
    }
}

use Group::*;
use UserLevel::{Broadcaster, Everyone, Moderator};

/// "3 days 4 hours", "2 hours 5 minutes", "12 minutes": watch time, in minutes.
pub fn watch_words(minutes: i64) -> String {
    let m = minutes.max(0);
    let (d, h, m) = (m / 1440, (m % 1440) / 60, m % 60);
    let unit = |n: i64, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    match (d, h, m) {
        (0, 0, m) => unit(m, "minute"),
        (0, h, 0) => unit(h, "hour"),
        (0, h, m) => format!("{} {}", unit(h, "hour"), unit(m, "minute")),
        (d, 0, _) => unit(d, "day"),
        (d, h, _) => format!("{} {}", unit(d, "day"), unit(h, "hour")),
    }
}

/// Words for a WMO weather code, as Open-Meteo sends it.
pub fn weather_words(code: i64) -> &'static str {
    match code {
        0 => "Clear",
        1 => "Mostly clear",
        2 => "Partly cloudy",
        3 => "Overcast",
        45 | 48 => "Foggy",
        51 | 53 | 55 => "Drizzle",
        56 | 57 => "Freezing drizzle",
        61 => "Light rain",
        63 => "Rain",
        65 => "Heavy rain",
        66 | 67 => "Freezing rain",
        71 => "Light snow",
        73 => "Snow",
        75 => "Heavy snow",
        77 => "Snow grains",
        80 | 81 => "Rain showers",
        82 => "Heavy rain showers",
        85 | 86 => "Snow showers",
        95 => "Thunderstorms",
        96 | 99 => "Thunderstorms with hail",
        _ => "Unsettled",
    }
}

/// The compass point a wind comes from.
pub fn compass(degrees: f64) -> &'static str {
    const POINTS: [&str; 8] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    let i = ((degrees.rem_euclid(360.0) + 22.5) / 45.0) as usize % 8;
    POINTS[i]
}

/// The place a viewer asked about, split into the name to look up and the
/// words that narrow it down ("Austin, Texas" or "Paris France" style).
pub fn weather_query(args: &[String]) -> Option<(String, Vec<String>)> {
    let text = args.join(" ");
    let mut parts = text
        .split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let name: String = parts.next()?.chars().take(80).collect();
    Some((name, parts.map(|p| p.to_lowercase()).collect()))
}

/// The best match from Open-Meteo's place search: the first (largest) one
/// whose region, country or country code fits every narrowing word.
pub fn pick_place<'a>(
    results: &'a [serde_json::Value],
    narrow: &[String],
) -> Option<&'a serde_json::Value> {
    let fits = |r: &serde_json::Value, w: &str| {
        ["admin1", "admin2", "country", "country_code"]
            .iter()
            .any(|k| {
                r[*k].as_str().is_some_and(|v| {
                    let v = v.to_lowercase();
                    v == w || (w.len() >= 3 && v.starts_with(w))
                })
            })
            || state_code(w).is_some_and(|s| r["admin1"].as_str() == Some(s))
    };
    results
        .iter()
        .find(|r| narrow.iter().all(|w| fits(r, w)))
        .or_else(|| results.first().filter(|_| narrow.is_empty()))
}

/// US state names for their two letter codes, so "Austin, TX" works.
fn state_code(w: &str) -> Option<&'static str> {
    const STATES: [(&str, &str); 51] = [
        ("al", "Alabama"),
        ("ak", "Alaska"),
        ("az", "Arizona"),
        ("ar", "Arkansas"),
        ("ca", "California"),
        ("co", "Colorado"),
        ("ct", "Connecticut"),
        ("de", "Delaware"),
        ("dc", "District of Columbia"),
        ("fl", "Florida"),
        ("ga", "Georgia"),
        ("hi", "Hawaii"),
        ("id", "Idaho"),
        ("il", "Illinois"),
        ("in", "Indiana"),
        ("ia", "Iowa"),
        ("ks", "Kansas"),
        ("ky", "Kentucky"),
        ("la", "Louisiana"),
        ("me", "Maine"),
        ("md", "Maryland"),
        ("ma", "Massachusetts"),
        ("mi", "Michigan"),
        ("mn", "Minnesota"),
        ("ms", "Mississippi"),
        ("mo", "Missouri"),
        ("mt", "Montana"),
        ("ne", "Nebraska"),
        ("nv", "Nevada"),
        ("nh", "New Hampshire"),
        ("nj", "New Jersey"),
        ("nm", "New Mexico"),
        ("ny", "New York"),
        ("nc", "North Carolina"),
        ("nd", "North Dakota"),
        ("oh", "Ohio"),
        ("ok", "Oklahoma"),
        ("or", "Oregon"),
        ("pa", "Pennsylvania"),
        ("ri", "Rhode Island"),
        ("sc", "South Carolina"),
        ("sd", "South Dakota"),
        ("tn", "Tennessee"),
        ("tx", "Texas"),
        ("ut", "Utah"),
        ("vt", "Vermont"),
        ("va", "Virginia"),
        ("wa", "Washington"),
        ("wv", "West Virginia"),
        ("wi", "Wisconsin"),
        ("wy", "Wyoming"),
    ];
    STATES.iter().find(|(c, _)| *c == w).map(|(_, n)| *n)
}

/// One line about the weather now, in Celsius and Fahrenheit.
pub fn weather_line(place: &str, current: &serde_json::Value) -> Option<String> {
    let t = current["temperature_2m"].as_f64()?;
    let feels = current["apparent_temperature"].as_f64().unwrap_or(t);
    let f = |c: f64| (c * 9.0 / 5.0 + 32.0).round() as i64;
    let mut line = format!(
        "Weather in {place}: {}, {}°C ({}°F), feels like {}°C ({}°F).",
        weather_words(current["weather_code"].as_i64().unwrap_or(-1)),
        t.round() as i64,
        f(t),
        feels.round() as i64,
        f(feels)
    );
    if let Some(h) = current["relative_humidity_2m"].as_f64() {
        line.push_str(&format!(" Humidity {}%.", h.round() as i64));
    }
    if let Some(w) = current["wind_speed_10m"].as_f64() {
        line.push_str(&format!(
            " Wind {} km/h ({} mph)",
            w.round() as i64,
            (w / 1.609_344).round() as i64
        ));
        match current["wind_direction_10m"].as_f64() {
            Some(d) if w >= 1.0 => line.push_str(&format!(" from the {}.", compass(d))),
            _ => line.push('.'),
        }
    }
    Some(line)
}

/// Every built-in command, in the order the dashboard lists them.
pub const BUILTINS: &[Builtin] = &[
    b(
        "commands",
        Info,
        "Links to this channel's list of commands",
        "!commands",
        Everyone,
        10,
    ),
    b(
        "uptime",
        Info,
        "How long the stream has been live, or offline",
        "!uptime",
        Everyone,
        10,
    ),
    b(
        "game",
        Info,
        "The category the stream is in",
        "!game",
        Everyone,
        10,
    ),
    b(
        "title",
        Info,
        "The stream's title",
        "!title",
        Everyone,
        10,
    ),
    b(
        "gamesplayed",
        Info,
        "Every category of the current or latest stream",
        "!gamesplayed",
        Everyone,
        10,
    ),
    Builtin {
        needs: Needs::Commands,
        ..b(
            "followage",
            Info,
            "How long someone has followed the channel",
            "!followage or !followage @name",
            Everyone,
            5,
        )
    },
    Builtin {
        needs: Needs::Commands,
        ..b(
            "followsince",
            Info,
            "The date someone followed the channel",
            "!followsince or !followsince @name",
            Everyone,
            5,
        )
    },
    b(
        "watchtime",
        Info,
        "How long someone has watched the channel while points were on",
        "!watchtime or !watchtime @name",
        Everyone,
        5,
    ),
    b(
        "accountage",
        Info,
        "How old someone's Twitch account is",
        "!accountage or !accountage @name",
        Everyone,
        5,
    ),
    b(
        "accountsince",
        Info,
        "The date someone made their Twitch account",
        "!accountsince or !accountsince @name",
        Everyone,
        5,
    ),
    b(
        "ping",
        Info,
        "Checks that the bot is listening",
        "!ping",
        Everyone,
        10,
    ),
    b(
        "8ball",
        Fun,
        "Ask the mystery 8-ball a question",
        "!8ball will it rain?",
        Everyone,
        5,
    ),
    b(
        "ask",
        Fun,
        "An AI answers a viewer's question in chat, using the streamer's own API key from the Bot page",
        "!ask why is the sky blue?",
        Everyone,
        30,
    ),
    b(
        "dadjoke",
        Fun,
        "Tells an unfunny dad joke",
        "!dadjoke",
        Everyone,
        10,
    ),
    b(
        "fact",
        Fun,
        "A useless random fact",
        "!fact",
        Everyone,
        10,
    ),
    b(
        "weather",
        Info,
        "The weather right now in a place",
        "!weather Paris or !weather Austin, Texas",
        Everyone,
        5,
    ),
    b(
        "dictionary",
        Fun,
        "The dictionary meaning of a word",
        "!dictionary word",
        Everyone,
        5,
    ),
    Builtin {
        on: false,
        ..b(
            "urbandictionary",
            Fun,
            "The top Urban Dictionary meaning. Off at first, since its answers can be rude.",
            "!urbandictionary word",
            Everyone,
            10,
        )
    },
    b(
        "emotes",
        Fun,
        "The channel's Twitch, 7TV, BetterTTV and FrankerFaceZ emotes. Moderators reload them with !emotes reload.",
        "!emotes",
        Everyone,
        30,
    ),
    Builtin {
        min: Moderator,
        ..b(
            "addcmd",
            Commands,
            "Adds a command",
            "!addcmd !discord Join us at discord.gg/...",
            Moderator,
            0,
        )
    },
    Builtin {
        min: Moderator,
        ..b(
            "editcmd",
            Commands,
            "Changes a command's reply",
            "!editcmd !discord New reply",
            Moderator,
            0,
        )
    },
    Builtin {
        min: Moderator,
        ..b(
            "setcmd",
            Commands,
            "Changes a command, or adds it when it is new",
            "!setcmd !discord Reply",
            Moderator,
            0,
        )
    },
    Builtin {
        min: Moderator,
        ..b(
            "delcmd",
            Commands,
            "Deletes a command",
            "!delcmd !discord",
            Moderator,
            0,
        )
    },
    Builtin {
        min: Moderator,
        ..b(
            "command",
            Commands,
            "Manages commands: add, edit, set, delete, on, off or show",
            "!command off !discord",
            Moderator,
            0,
        )
    },
    b(
        "count",
        Commands,
        "Shows a counter. Moderators change it with + - or =.",
        "!count deaths +1",
        Everyone,
        5,
    ),
    b(
        "quote",
        Quotes,
        "A random quote, quote #12 with !quote 12, or one that mentions a word",
        "!quote or !quote 12",
        Everyone,
        5,
    ),
    Builtin {
        min: UserLevel::Vip,
        ..b(
            "addquote",
            Quotes,
            "Adds a quote",
            "!addquote words worth keeping",
            Moderator,
            0,
        )
    },
    Builtin {
        min: UserLevel::Vip,
        ..b(
            "editquote",
            Quotes,
            "Changes a quote's words",
            "!editquote 12 new words",
            Moderator,
            0,
        )
    },
    Builtin {
        aliases: &["delquote"],
        min: UserLevel::Vip,
        ..b(
            "deletequote",
            Quotes,
            "Removes a quote",
            "!deletequote 12",
            Moderator,
            0,
        )
    },
    Builtin {
        needs: Needs::Commands,
        ..b(
            "clip",
            Stream,
            "Makes a clip of the live stream and posts the link",
            "!clip",
            Everyone,
            30,
        )
    },
    Builtin {
        needs: Needs::Commands,
        min: Moderator,
        ..b(
            "settitle",
            Stream,
            "Changes the stream's title",
            "!settitle New title",
            Moderator,
            0,
        )
    },
    Builtin {
        needs: Needs::Commands,
        min: Moderator,
        ..b(
            "setgame",
            Stream,
            "Changes the stream's category",
            "!setgame Minecraft",
            Moderator,
            0,
        )
    },
    Builtin {
        needs: Needs::Moderation,
        min: Moderator,
        ..b(
            "permit",
            Moderation,
            "Lets someone skip the chat rules for 60 seconds",
            "!permit @name",
            Moderator,
            0,
        )
    },
    Builtin {
        needs: Needs::Moderation,
        min: Moderator,
        ..b(
            "nuke",
            Moderation,
            "Like Fossabot: acts on every message in the scrollback that has the phrase or matches /regex/, by deleting it or timing out or banning its sender. -r= keeps catching new ones for a while",
            "!nuke bad phrase 3m 10m, !nuke /regex/ 2m ban or !nuke phrase -r=5m 3m delete",
            Moderator,
            0,
        )
    },
    Builtin {
        needs: Needs::Moderation,
        ..b(
            "vanish",
            Moderation,
            "Removes your own messages",
            "!vanish",
            Everyone,
            0,
        )
    },
    Builtin {
        needs: Needs::Moderation,
        on: false,
        ..b(
            "votekick",
            Moderation,
            "Chat votes to time someone out for 5 minutes: 5 votes within a minute. Off at first.",
            "!votekick @name",
            Everyone,
            0,
        )
    },
    Builtin {
        min: Moderator,
        ..b(
            "filesay",
            Moderation,
            "Posts each line of a text file at a web address, one every 2 seconds, up to 25",
            "!filesay https://example.com/list.txt",
            Broadcaster,
            0,
        )
    },
    Builtin {
        min: Moderator,
        ..b(
            "filesaystop",
            Moderation,
            "Stops a running !filesay",
            "!filesaystop",
            Moderator,
            0,
        )
    },
];

/// The built-in command a trigger names, by name or alias.
pub fn builtin(trigger: &str) -> Option<&'static Builtin> {
    BUILTINS
        .iter()
        .find(|b| b.name == trigger || b.aliases.contains(&trigger))
}

/// A channel's choices for one built-in command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinSetting {
    pub name: String,
    pub enabled: bool,
    pub level: UserLevel,
    #[serde(default)]
    pub cooldown: u32,
}

impl Builtin {
    pub fn default_setting(&self) -> BuiltinSetting {
        BuiltinSetting {
            name: self.name.into(),
            enabled: self.on,
            level: self.level,
            cooldown: self.cooldown,
        }
    }
}

/// Every built-in command's settings in list order: the stored choice where
/// there is one (kept within each command's limits), else its default.
pub fn normalize(stored: &[BuiltinSetting]) -> Vec<BuiltinSetting> {
    BUILTINS
        .iter()
        .map(|b| match stored.iter().find(|s| s.name == b.name) {
            Some(s) => BuiltinSetting {
                name: b.name.into(),
                enabled: s.enabled,
                level: s.level.max(b.min),
                cooldown: s.cooldown.min(MAX_COOLDOWN_S),
            },
            None => b.default_setting(),
        })
        .collect()
}

/// What `!command` was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandEdit {
    Add(String, String),
    Edit(String, String),
    Set(String, String),
    Delete(String),
    Enable(String, bool),
    Show(String),
}

/// `!discord Join us` gives `("discord", "Join us")`. The name loses its `!`
/// and is lower case; the reply keeps its words as typed.
pub fn name_and_reply(args: &[String]) -> Option<(String, String)> {
    let name = args.first()?.trim_start_matches('!').to_lowercase();
    if name.is_empty() {
        return None;
    }
    Some((name, args[1..].join(" ")))
}

/// `!command add|edit|set|delete|on|off|show !name ...`.
pub fn command_edit(args: &[String]) -> Option<CommandEdit> {
    let action = args.first()?.to_lowercase();
    let rest = &args[1..];
    let (name, reply) = name_and_reply(rest)?;
    Some(match action.as_str() {
        "add" | "new" | "create" => CommandEdit::Add(name, reply),
        "edit" | "change" => CommandEdit::Edit(name, reply),
        "set" => CommandEdit::Set(name, reply),
        "delete" | "del" | "remove" => CommandEdit::Delete(name),
        "on" | "enable" => CommandEdit::Enable(name, true),
        "off" | "disable" => CommandEdit::Enable(name, false),
        "show" | "view" | "info" => CommandEdit::Show(name),
        _ => return None,
    })
}

/// A Twitch login from a chat word: `@Maple` gives `maple`. `None` when the
/// word cannot be a Twitch name.
pub fn target_login(word: Option<&String>) -> Option<String> {
    let w = word?.trim().trim_start_matches('@').to_lowercase();
    let ok =
        !w.is_empty() && w.len() <= 25 && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then_some(w)
}

/// What `!nuke` looks for: a phrase (any case) or `/a regex/flags`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum NukeMatch {
    /// In lower case.
    Phrase {
        text: String,
    },
    Regex {
        pattern: String,
        flags: String,
    },
}

impl NukeMatch {
    pub fn label(&self) -> String {
        match self {
            NukeMatch::Phrase { text } => text.clone(),
            NukeMatch::Regex { pattern, flags } => format!("/{pattern}/{flags}"),
        }
    }
}

/// What `!nuke` does to each match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum NukeAction {
    Delete,
    Timeout { seconds: u32 },
    Ban,
}

/// `!nuke <phrase|/regex/> [-r=<radiation>] <scrollback> <timeout|delete|ban>`,
/// as Fossabot has it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Nuke {
    pub what: NukeMatch,
    /// Seconds of chat before the nuke that it covers.
    pub scrollback: u32,
    pub action: NukeAction,
    /// Seconds after the nuke that new messages are caught too.
    pub radiation: u32,
}

pub const NUKE_USAGE: &str =
    "Use !nuke <phrase or /regex/> [-r=5m] <scrollback> <timeout, delete or ban>, such as !nuke bad phrase 3m 10m";
/// The most scrollback one `!nuke` covers.
pub const NUKE_MAX_SCROLLBACK_S: u32 = 600;
/// The longest radiation.
pub const NUKE_MAX_RADIATION_S: u32 = 3600;
/// The longest timeout Twitch gives: two weeks.
pub const MAX_TIMEOUT_S: u32 = 1_209_600;
/// The most messages one `!nuke` looks through.
pub const NUKE_MAX: usize = 500;

/// A length such as `30s`, `10m`, `1h`, `2d`, `1h30m` or a bare number of
/// seconds.
pub fn duration_s(word: &str) -> Option<u32> {
    let w = word.trim().to_lowercase();
    if w.is_empty() {
        return None;
    }
    if let Ok(n) = w.parse::<u64>() {
        return u32::try_from(n).ok();
    }
    let mut total: u64 = 0;
    let mut num = String::new();
    for c in w.chars() {
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let unit = match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86_400,
            'w' => 604_800,
            _ => return None,
        };
        let n: u64 = num.parse().ok()?;
        num.clear();
        total = total.checked_add(n.checked_mul(unit)?)?;
    }
    if !num.is_empty() {
        return None;
    }
    u32::try_from(total).ok()
}

pub fn nuke(args: &[String]) -> Option<Nuke> {
    let mut radiation = 0;
    let mut rest: Vec<&str> = Vec::new();
    for a in args {
        match a.strip_prefix("-r=") {
            Some(r) => radiation = duration_s(r)?.min(NUKE_MAX_RADIATION_S),
            None => rest.push(a),
        }
    }
    if rest.len() < 3 {
        return None;
    }
    let action = match rest.pop()?.to_lowercase().as_str() {
        "delete" => NukeAction::Delete,
        "ban" => NukeAction::Ban,
        t => NukeAction::Timeout {
            seconds: duration_s(t).filter(|s| *s > 0)?.min(MAX_TIMEOUT_S),
        },
    };
    let scrollback = duration_s(rest.pop()?)?.min(NUKE_MAX_SCROLLBACK_S);
    let text = rest.join(" ");
    let text = text.trim();
    let what = match text
        .strip_prefix('/')
        .and_then(|t| t.rfind('/').map(|i| (t, i)))
    {
        Some((t, i)) if i > 0 => {
            let flags: String = t[i + 1..]
                .chars()
                .filter(|c| matches!(c, 'i' | 'm' | 's' | 'u'))
                .collect();
            NukeMatch::Regex {
                pattern: t[..i].to_string(),
                flags,
            }
        }
        _ => {
            let text = text.to_lowercase();
            // Two letters at least, so a slip cannot wipe the whole chat.
            if text.chars().count() < 2 {
                return None;
            }
            NukeMatch::Phrase { text }
        }
    };
    Some(Nuke {
        what,
        scrollback,
        action,
        radiation,
    })
}

/// Votes `!votekick` needs, inside [`VOTEKICK_WINDOW_MS`].
pub const VOTEKICK_VOTES: usize = 5;
pub const VOTEKICK_WINDOW_MS: i64 = 60_000;
/// Seconds a vote kick times someone out for.
pub const VOTEKICK_TIMEOUT_S: u32 = 300;
/// Seconds `!permit` lets someone skip the chat rules.
pub const PERMIT_S: i64 = 60;

/// `!filesay` posts at most this many lines, this far apart.
pub const FILESAY_MAX_LINES: usize = 25;
pub const FILESAY_GAP_MS: i64 = 2_000;
/// The largest file `!filesay` reads.
pub const FILESAY_MAX_BYTES: usize = 64 * 1024;

/// The lines `!filesay` posts from a file: trimmed, blank ones skipped, each
/// cut to what Twitch accepts, at most [`FILESAY_MAX_LINES`].
pub fn filesay_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(MAX_REPLY).collect())
        .take(FILESAY_MAX_LINES)
        .collect()
}

/// A web address `!filesay` may read: http or https, nothing else.
pub fn filesay_url(arg: Option<&String>) -> Option<String> {
    let a = arg?.trim();
    let lower = a.to_lowercase();
    ((lower.starts_with("https://") || lower.starts_with("http://")) && a.len() <= 2000)
        .then(|| a.to_string())
}

/// The 8-ball's answers.
pub const EIGHT_BALL: &[&str] = &[
    "It is certain.",
    "It is decidedly so.",
    "Without a doubt.",
    "Yes, definitely.",
    "You may rely on it.",
    "As I see it, yes.",
    "Most likely.",
    "Outlook good.",
    "Yes.",
    "Signs point to yes.",
    "Reply hazy, try again.",
    "Ask again later.",
    "Better not tell you now.",
    "Cannot predict now.",
    "Concentrate and ask again.",
    "Don't count on it.",
    "My reply is no.",
    "My sources say no.",
    "Outlook not so good.",
    "Very doubtful.",
];

/// Used when the joke service does not answer.
pub const DAD_JOKES: &[&str] = &[
    "I'm reading a book about anti-gravity. It's impossible to put down.",
    "Why don't skeletons fight each other? They don't have the guts.",
    "I used to hate facial hair, but then it grew on me.",
    "What do you call a fake noodle? An impasta.",
    "I only know 25 letters of the alphabet. I don't know y.",
    "Why did the scarecrow win an award? He was outstanding in his field.",
    "I would tell you a construction joke, but I'm still working on it.",
    "What do you call a bear with no teeth? A gummy bear.",
    "Why can't a nose be 12 inches long? Because then it would be a foot.",
    "I'm on a seafood diet. I see food and I eat it.",
    "What did the ocean say to the beach? Nothing, it just waved.",
    "Why do cows wear bells? Because their horns don't work.",
    "How does a penguin build its house? Igloos it together.",
    "Did you hear about the restaurant on the moon? Great food, no atmosphere.",
    "Why did the coffee file a police report? It got mugged.",
    "What do you call cheese that isn't yours? Nacho cheese.",
    "Why don't eggs tell jokes? They'd crack each other up.",
    "I told my wife she was drawing her eyebrows too high. She looked surprised.",
    "What do you call a factory that makes okay products? A satisfactory.",
    "Why did the math book look sad? It had too many problems.",
];

/// Used when the fact service does not answer.
pub const FACTS: &[&str] = &[
    "Honey never spoils. Edible honey has been found in ancient Egyptian tombs.",
    "Octopuses have three hearts.",
    "A group of flamingos is called a flamboyance.",
    "Bananas are berries, but strawberries are not.",
    "Wombat droppings are cube shaped.",
    "A day on Venus is longer than a year on Venus.",
    "Sea otters hold hands while they sleep so they don't drift apart.",
    "The Eiffel Tower can be about 15 cm taller in summer, as the metal expands.",
    "Cows have best friends and get stressed when they are apart.",
    "A shrimp's heart is in its head.",
    "Sloths can hold their breath longer than dolphins can.",
    "The unicorn is the national animal of Scotland.",
    "Hot water can freeze faster than cold water. It is called the Mpemba effect.",
    "There are more possible games of chess than atoms in the observable universe.",
    "Butterflies taste with their feet.",
    "An ostrich's eye is bigger than its brain.",
    "The dot over a lowercase i or j is called a tittle.",
    "Koalas have fingerprints that are almost impossible to tell from human ones.",
    "Snails can sleep for up to three years.",
    "The first oranges were not orange. They were green.",
];

/// A Twitch time such as `2018-04-28T14:03:11Z`.
pub fn parse_time(ts: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// A time in milliseconds since 1970, as the Worker's clock gives it.
pub fn utc_from_ms(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

/// `28 April 2018`.
pub fn date_words(t: DateTime<Utc>) -> String {
    t.format("%-d %B %Y").to_string()
}

/// How long from `from` to `now`, in the two largest units: "2 years and 3
/// months", "5 days and 4 hours", "12 minutes".
pub fn age_words(from: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let unit = |n: i64, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    if now <= from {
        return unit(0, "minute");
    }
    // Whole calendar months first, so 28 April to 28 July is 3 months.
    let mut months =
        (now.year() as i64 - from.year() as i64) * 12 + now.month() as i64 - from.month() as i64;
    let after = |m: i64| from.checked_add_months(Months::new(m.max(0) as u32));
    while months > 0 && after(months).is_none_or(|t| t > now) {
        months -= 1;
    }
    let rest = now - after(months).unwrap_or(from);
    let (years, months) = (months / 12, months % 12);
    let (days, hours, minutes) = (
        rest.num_days(),
        rest.num_hours() % 24,
        rest.num_minutes() % 60,
    );
    let parts: Vec<String> = [
        (years, "year"),
        (months, "month"),
        (days, "day"),
        (hours, "hour"),
        (minutes, "minute"),
    ]
    .iter()
    .skip_while(|(n, _)| *n == 0)
    .take(2)
    .filter(|(n, _)| *n > 0)
    .map(|(n, u)| unit(*n, u))
    .collect();
    match parts.len() {
        0 => unit(0, "minute"),
        1 => parts[0].clone(),
        _ => format!("{} and {}", parts[0], parts[1]),
    }
}

/// One line of emote names by provider, cut to fit a chat message with "and
/// N more" when there are too many. Providers with none are left out.
pub fn emote_line(groups: &[(&str, Vec<String>)]) -> String {
    let total: usize = groups.iter().map(|(_, e)| e.len()).sum();
    if total == 0 {
        return "This channel has no emotes yet.".into();
    }
    let mut out = String::new();
    let mut shown = 0;
    'outer: for (provider, emotes) in groups.iter().filter(|(_, e)| !e.is_empty()) {
        let head = if out.is_empty() {
            format!("{provider}: ")
        } else {
            format!(" | {provider}: ")
        };
        let mut first = true;
        for e in emotes {
            let piece = if first {
                format!("{head}{e}")
            } else {
                format!(" {e}")
            };
            // Keep room for " and 9999 more".
            if out.chars().count() + piece.chars().count() > MAX_REPLY - 16 {
                break 'outer;
            }
            out.push_str(&piece);
            shown += 1;
            first = false;
        }
    }
    if shown < total {
        out.push_str(&format!(" and {} more", total - shown));
    }
    out
}

/// A dictionary or Urban Dictionary meaning, tidied for chat: Urban
/// Dictionary's `[link]` brackets dropped, one line, cut to fit.
pub fn meaning_line(prefix: &str, text: &str) -> String {
    let clean: String = text.chars().filter(|c| *c != '[' && *c != ']').collect();
    let line = format!(
        "{prefix}{}",
        clean.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    if line.chars().count() <= MAX_REPLY {
        return line;
    }
    let mut cut: String = line.chars().take(MAX_REPLY - 3).collect();
    if let Some(i) = cut.rfind(' ') {
        cut.truncate(i);
    }
    cut + "..."
}

#[cfg(test)]
mod tests {
    #[test]
    fn weather_reply() {
        let q = weather_query(&["Austin,".into(), "TX".into()]).unwrap();
        assert_eq!(q, ("Austin".to_string(), vec!["tx".to_string()]));
        let results = vec![
            serde_json::json!({"name": "Austin", "admin1": "Minnesota", "country": "United States", "country_code": "US"}),
            serde_json::json!({"name": "Austin", "admin1": "Texas", "country": "United States", "country_code": "US"}),
        ];
        assert_eq!(pick_place(&results, &q.1).unwrap()["admin1"], "Texas");
        assert_eq!(pick_place(&results, &[]).unwrap()["admin1"], "Minnesota");
        assert!(pick_place(&results, &["france".into()]).is_none());
        let line = weather_line(
            "Austin, Texas, United States",
            &serde_json::json!({"temperature_2m": 21.4, "apparent_temperature": 20.0, "relative_humidity_2m": 55,
                                "weather_code": 2, "wind_speed_10m": 16.1, "wind_direction_10m": 200}),
        )
        .unwrap();
        assert_eq!(
            line,
            "Weather in Austin, Texas, United States: Partly cloudy, 21°C (71°F), feels like 20°C (68°F). Humidity 55%. Wind 16 km/h (10 mph) from the S."
        );
        assert_eq!(compass(350.0), "N");
    }

    #[test]
    fn watch_time_words() {
        assert_eq!(watch_words(0), "0 minutes");
        assert_eq!(watch_words(1), "1 minute");
        assert_eq!(watch_words(125), "2 hours 5 minutes");
        assert_eq!(watch_words(60), "1 hour");
        assert_eq!(watch_words(1440 * 3 + 245), "3 days 4 hours");
        assert_eq!(watch_words(1440 + 5), "1 day");
    }

    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn list_is_sound() {
        let mut seen: Vec<&str> = Vec::new();
        for b in BUILTINS {
            for t in std::iter::once(&b.name).chain(b.aliases.iter()) {
                assert!(!seen.contains(t), "{t} twice");
                seen.push(t);
            }
            assert!(b.level >= b.min, "{}", b.name);
            assert!(!b.about.contains('\u{2014}'), "{}", b.name);
        }
        for media in [
            "sr",
            "song",
            "songqueue",
            "skip",
            "clear",
            "volume",
            "voteskip",
            "wrongsong",
        ] {
            assert!(builtin(media).is_none(), "{media}");
        }
        assert_eq!(builtin("delquote").unwrap().name, "deletequote");
    }

    #[test]
    fn normalize_keeps_limits() {
        let stored = vec![
            BuiltinSetting {
                name: "nuke".into(),
                enabled: false,
                level: UserLevel::Everyone,
                cooldown: 99_999,
            },
            BuiltinSetting {
                name: "nonsense".into(),
                enabled: true,
                level: UserLevel::Everyone,
                cooldown: 0,
            },
        ];
        let all = normalize(&stored);
        assert_eq!(all.len(), BUILTINS.len());
        let nuke = all.iter().find(|s| s.name == "nuke").unwrap();
        assert!(!nuke.enabled);
        assert_eq!(nuke.level, UserLevel::Moderator);
        assert_eq!(nuke.cooldown, MAX_COOLDOWN_S);
        assert!(all.iter().all(|s| s.name != "nonsense"));
        let kick = all.iter().find(|s| s.name == "votekick").unwrap();
        assert!(!kick.enabled);
    }

    #[test]
    fn reading_arguments() {
        assert_eq!(
            name_and_reply(&s(&["!Discord", "Join", "us"])),
            Some(("discord".into(), "Join us".into()))
        );
        assert_eq!(name_and_reply(&s(&["!"])), None);
        assert_eq!(
            command_edit(&s(&["off", "!lurk"])),
            Some(CommandEdit::Enable("lurk".into(), false))
        );
        assert_eq!(
            command_edit(&s(&["ADD", "hi", "hello", "there"])),
            Some(CommandEdit::Add("hi".into(), "hello there".into()))
        );
        assert_eq!(command_edit(&s(&["frob", "hi"])), None);
        assert_eq!(command_edit(&s(&["add"])), None);
        assert_eq!(
            target_login(Some(&"@Maple_1".into())),
            Some("maple_1".into())
        );
        assert_eq!(target_login(Some(&"no way".into())), None);
        assert_eq!(
            nuke(&s(&["my", "Bad", "phrase", "3m", "10m"])),
            Some(Nuke {
                what: NukeMatch::Phrase {
                    text: "my bad phrase".into()
                },
                scrollback: 180,
                action: NukeAction::Timeout { seconds: 600 },
                radiation: 0,
            })
        );
        assert_eq!(
            nuke(&s(&["/some.+bad(regex)?here/", "2m", "ban"])).map(|n| (n.what, n.action)),
            Some((
                NukeMatch::Regex {
                    pattern: "some.+bad(regex)?here".into(),
                    flags: String::new()
                },
                NukeAction::Ban
            ))
        );
        let r = nuke(&s(&["my", "bad", "phrase", "-r=5m", "3m", "delete"])).unwrap();
        assert_eq!((r.radiation, r.action), (300, NukeAction::Delete));
        assert_eq!(
            nuke(&s(&["spam", "words"])),
            None,
            "needs scrollback and action"
        );
        assert_eq!(nuke(&s(&["x", "1m", "1m"])), None);
        assert_eq!(nuke(&s(&["spam", "1m", "nope"])), None);
        assert_eq!(nuke(&[]), None);
        assert_eq!(duration_s("1h30m"), Some(5400));
        assert_eq!(duration_s("45"), Some(45));
        assert_eq!(duration_s("5x"), None);
    }

    #[test]
    fn filesay() {
        let lines = filesay_lines("one\n\n  two   words \r\nthree");
        assert_eq!(lines, s(&["one", "two words", "three"]));
        let many = "x\n".repeat(100);
        assert_eq!(filesay_lines(&many).len(), FILESAY_MAX_LINES);
        assert!(filesay_url(Some(&"https://a.b/c.txt".into())).is_some());
        assert!(filesay_url(Some(&"file:///etc/passwd".into())).is_none());
        assert!(filesay_url(None).is_none());
    }

    #[test]
    fn ages_and_dates() {
        let t = |s: &str| parse_time(s).unwrap();
        assert_eq!(date_words(t("2018-04-28T14:03:11Z")), "28 April 2018");
        assert_eq!(
            age_words(t("2018-04-28T00:00:00Z"), t("2020-07-28T04:00:00Z")),
            "2 years and 3 months"
        );
        assert_eq!(
            age_words(t("2024-01-31T00:00:00Z"), t("2024-03-01T00:00:00Z")),
            "1 month and 1 day"
        );
        assert_eq!(
            age_words(t("2024-05-01T10:00:00Z"), t("2024-05-03T15:30:00Z")),
            "2 days and 5 hours"
        );
        assert_eq!(
            age_words(t("2024-05-01T10:00:00Z"), t("2024-05-01T10:12:00Z")),
            "12 minutes"
        );
        assert_eq!(
            age_words(t("2024-05-01T10:00:00Z"), t("2025-05-01T10:00:00Z")),
            "1 year"
        );
        assert_eq!(
            age_words(t("2024-05-01T10:00:00Z"), t("2024-05-01T10:00:00Z")),
            "0 minutes"
        );
    }

    #[test]
    fn emotes_fit() {
        assert_eq!(emote_line(&[]), "This channel has no emotes yet.");
        let line = emote_line(&[
            ("Twitch", s(&["mapleHi", "mapleGG"])),
            ("7TV", vec![]),
            ("BetterTTV", s(&["catJAM"])),
        ]);
        assert_eq!(line, "Twitch: mapleHi mapleGG | BetterTTV: catJAM");
        let lots: Vec<String> = (0..200).map(|i| format!("emote{i}")).collect();
        let line = emote_line(&[("7TV", lots)]);
        assert!(line.chars().count() <= MAX_REPLY);
        assert!(line.ends_with(" more"));
    }

    #[test]
    fn meanings() {
        assert_eq!(
            meaning_line("(noun) kappa: ", "A [Greek]  letter"),
            "(noun) kappa: A Greek letter"
        );
        let long = meaning_line("", &"word ".repeat(200));
        assert!(long.chars().count() <= MAX_REPLY);
        assert!(long.ends_with("..."));
    }
}

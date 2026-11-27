//! Moving from bots other than StreamElements (which has its own module,
//! `import`): Nightbot and Fossabot commands read from their public command
//! lists, and commands, points, watch time and tips from a file a streamer
//! exported from Streamlabs or anywhere else.
//!
//! Every source arrives here as the same `Incoming` command, so one set of
//! rules decides what Sylva keeps and why it skips the rest.

use serde::Deserialize;
use serde_json::Value;

use crate::bot::{BotSettings, Command, UserLevel, MAX_COMMANDS};
use crate::import::Skipped;

pub const NIGHTBOT_API: &str = "https://api.nightbot.tv/1";
pub const FOSSABOT_API: &str = "https://fossabot.com/api/v2/cached";
/// The most rows one file import reads.
pub const MAX_FILE_ROWS: usize = 5000;

/// One command from another bot, already in Sylva's terms.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Incoming {
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub reply: String,
    #[serde(default = "everyone")]
    pub level: UserLevel,
    #[serde(default)]
    pub cooldown: u32,
    #[serde(default)]
    pub user_cooldown: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn everyone() -> UserLevel {
    UserLevel::Everyone
}
fn yes() -> bool {
    true
}

/// Variables other bots use, as Sylva writes them. Nightbot and Fossabot
/// use `$(user)`; Streamlabs Cloudbot uses `{user}`; Streamlabs Chatbot
/// uses `$user`. Longer names come first so `$username` is not read as
/// `$user` plus `name`.
const VARIABLES: [(&str, &str); 34] = [
    ("$(user)", "${user}"),
    ("$(touser)", "${touser}"),
    ("$(query)", "${args}"),
    ("$(querystring)", "${args}"),
    ("$(channel)", "${channel}"),
    ("$(count)", "${count}"),
    ("$(uptime)", "${uptime}"),
    ("$(1)", "${1}"),
    ("$(2)", "${2}"),
    ("$(3)", "${3}"),
    ("$(arg1)", "${1}"),
    ("$(arg2)", "${2}"),
    ("$(arg3)", "${3}"),
    ("{user.name}", "${user}"),
    ("{user}", "${user}"),
    ("{touser}", "${touser}"),
    ("{target}", "${touser}"),
    ("{channel}", "${channel}"),
    ("{count}", "${count}"),
    ("{uptime}", "${uptime}"),
    ("{1}", "${1}"),
    ("{2}", "${2}"),
    ("{3}", "${3}"),
    ("{args}", "${args}"),
    ("$username", "${user}"),
    ("$targetname", "${touser}"),
    ("$touser", "${touser}"),
    ("$user", "${user}"),
    ("$mychannel", "${channel}"),
    ("$uptime", "${uptime}"),
    ("$msg", "${args}"),
    ("$arg1", "${1}"),
    ("$arg2", "${2}"),
    ("$count", "${count}"),
];

/// A reply with other bots' variables written Sylva's way, in one pass so
/// a variable already in Sylva's `${user}` form stays as it is.
pub fn translate(reply: &str) -> String {
    let mut out = String::with_capacity(reply.len());
    let mut i = 0;
    'scan: while i < reply.len() {
        let rest = &reply[i..];
        let after_dollar = out.ends_with('$');
        for (from, to) in VARIABLES {
            if rest.starts_with(from) && !(after_dollar && from.starts_with('{')) {
                out.push_str(to);
                i += from.len();
                continue 'scan;
            }
        }
        let ch = rest.chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// The first `$(...)` a reply still holds after `translate`, which Sylva
/// has nothing to match (Nightbot's `$(urlfetch ...)`, Fossabot's
/// `$(count.increment ...)` and so on).
pub fn unknown_variable(reply: &str) -> Option<String> {
    let i = reply.find("$(")?;
    let rest = &reply[i..];
    let end = rest.find(')').map_or(rest.len(), |e| e + 1);
    Some(rest[..end].chars().take(40).collect())
}

/// Nightbot's user levels.
pub fn nightbot_level(level: &str) -> UserLevel {
    match level {
        "subscriber" | "regular" => UserLevel::Subscriber,
        "twitch_vip" => UserLevel::Vip,
        "moderator" | "admin" => UserLevel::Moderator,
        "owner" => UserLevel::Broadcaster,
        _ => UserLevel::Everyone,
    }
}

/// The channel id from `GET /channels/t/{login}` on Nightbot.
pub fn nightbot_channel(v: &Value) -> Option<String> {
    v["channel"]["_id"].as_str().map(String::from)
}

/// Commands from Nightbot's `GET /commands`.
pub fn nightbot_commands(v: &Value) -> Vec<Incoming> {
    v["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| Incoming {
            name: c["name"].as_str().unwrap_or_default().to_string(),
            aliases: Vec::new(),
            reply: c["message"].as_str().unwrap_or_default().to_string(),
            level: nightbot_level(c["userLevel"].as_str().unwrap_or("everyone")),
            cooldown: c["coolDown"].as_u64().unwrap_or(0).min(86_400) as u32,
            user_cooldown: 0,
            enabled: true,
        })
        .collect()
}

/// The channel id from Fossabot's `GET /channels/by-slug/{login}`.
pub fn fossabot_channel(v: &Value) -> Option<String> {
    v["channel"]["id"]
        .as_str()
        .map(String::from)
        .or_else(|| v["channel"]["id"].as_i64().map(|n| n.to_string()))
}

/// Commands from Fossabot's `GET /channels/{id}/commands`. A command with
/// no roles is for everyone; otherwise the lowest role it allows decides.
pub fn fossabot_commands(v: &Value) -> Vec<Incoming> {
    let role = |id: &str| -> UserLevel {
        let name = v["roles"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["id"].as_str() == Some(id))
            .and_then(|r| r["name"].as_str())
            .unwrap_or_default()
            .to_lowercase();
        match name.as_str() {
            n if n.contains("sub") => UserLevel::Subscriber,
            "vip" => UserLevel::Vip,
            "broadcaster" | "owner" => UserLevel::Broadcaster,
            "" => UserLevel::Everyone,
            _ => UserLevel::Moderator,
        }
    };
    v["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["type"].as_str().map_or(true, |t| t == "custom"))
        .map(|c| {
            let roles: Vec<UserLevel> = c["role_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r.as_str())
                .map(role)
                .collect();
            Incoming {
                name: c["name"].as_str().unwrap_or_default().to_string(),
                aliases: c["aliases"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a.as_str().map(String::from))
                    .collect(),
                reply: c["response"].as_str().unwrap_or_default().to_string(),
                level: roles.into_iter().min().unwrap_or(UserLevel::Everyone),
                cooldown: 0,
                user_cooldown: 0,
                enabled: c["enabled_online"].as_bool().unwrap_or(true)
                    || c["enabled_offline"].as_bool().unwrap_or(true),
            }
        })
        .collect()
}

/// Add commands to `settings` one at a time, so a bad one is skipped with
/// its reason rather than failing them all. Names Sylva already uses are
/// left as they are.
pub fn add_commands(settings: &mut BotSettings, list: &[Incoming]) -> (usize, Vec<Skipped>) {
    let mut added = 0;
    let mut skipped = Vec::new();
    for c in list {
        let name = c.name.trim().trim_start_matches('!').to_lowercase();
        if name.is_empty() {
            continue;
        }
        let what = format!("!{name}");
        let reply = translate(c.reply.trim());
        let why = if settings.find(&name).is_some() {
            Some("Sylva already has a command with this name".to_string())
        } else if settings.commands.len() >= MAX_COMMANDS {
            Some(format!("A channel can have up to {MAX_COMMANDS} commands"))
        } else if reply.is_empty() {
            Some("It has no reply text".to_string())
        } else {
            unknown_variable(&reply)
                .map(|v| format!("It uses {v}, which Sylva has no match for. Add it by hand."))
        };
        if let Some(why) = why {
            skipped.push(Skipped { what, why });
            continue;
        }
        let aliases = c
            .aliases
            .iter()
            .map(|a| a.trim().trim_start_matches('!').to_lowercase())
            .filter(|a| !a.is_empty() && *a != name && settings.find(a).is_none())
            .collect();
        let mut next = settings.clone();
        next.commands.push(Command {
            name,
            aliases,
            reply,
            level: c.level,
            cooldown: c.cooldown.min(86_400),
            user_cooldown: c.user_cooldown.min(86_400),
            enabled: c.enabled,
            count: 0,
        });
        match next.validated(settings) {
            Ok(ok) => {
                *settings = ok;
                added += 1;
            }
            Err(e) => skipped.push(Skipped { what, why: e.0 }),
        }
    }
    (added, skipped)
}

/// A Twitch login as other bots write it: no `@`, lower case, and only
/// the characters Twitch allows.
pub fn clean_login(raw: &str) -> Option<String> {
    let l = raw.trim().trim_start_matches('@').to_lowercase();
    (!l.is_empty() && l.len() <= 25 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .then_some(l)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn variables_translate() {
        assert_eq!(translate("hi $(user), $(query)"), "hi ${user}, ${args}");
        assert_eq!(translate("{user} hugs {touser}"), "${user} hugs ${touser}");
        assert_eq!(translate("$username lurks"), "${user} lurks");
        assert_eq!(
            unknown_variable("x $(urlfetch https://a.b) y").as_deref(),
            Some("$(urlfetch https://a.b)")
        );
        assert_eq!(unknown_variable("${user}"), None);
    }

    #[test]
    fn reads_nightbot_and_fossabot() {
        let nb = json!({"commands":[{"name":"!Discord","message":"join $(user)","userLevel":"moderator","coolDown":5}]});
        let c = &nightbot_commands(&nb)[0];
        assert_eq!((c.level, c.cooldown), (UserLevel::Moderator, 5));
        let fb = json!({"roles":[{"id":"a","name":"VIP"},{"id":"b","name":"Moderator"}],
            "commands":[{"name":"x","response":"y","type":"custom","aliases":["z"],"role_ids":["b","a"]}]});
        let c = &fossabot_commands(&fb)[0];
        assert_eq!((c.level, c.aliases.len()), (UserLevel::Vip, 1));
        let mut s = BotSettings::default();
        let before = s.commands.len();
        let (n, skipped) = add_commands(&mut s, &nightbot_commands(&nb));
        assert_eq!((n, skipped.len(), s.commands.len()), (1, 0, before + 1));
        assert_eq!(s.commands.last().unwrap().reply, "join ${user}");
    }
}

//! Moving from StreamElements: their bot's commands, timers and loyalty
//! points, read with the streamer's own StreamElements JWT (it is used for
//! the one import and never stored).
//!
//! StreamElements' API is not part of Sylva, so everything here reads it
//! loosely: a missing field gets a sensible default, and anything Sylva
//! cannot keep is skipped with a reason the dashboard shows.

use serde::Serialize;
use serde_json::Value;

use crate::bot::{BotSettings, Command, Timer, UserLevel, MAX_COMMANDS, MAX_TIMERS};

pub const SE_API: &str = "https://api.streamelements.com/kappa/v2";
/// The most viewers whose points one import brings over, the top first.
pub const MAX_POINT_USERS: usize = 1000;

/// One thing the import left out, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub what: String,
    pub why: String,
}

/// StreamElements' access levels: 100 everyone, 250 subscriber, 300
/// regular, 400 VIP, 500 moderator, 1000 super moderator, 1500 broadcaster.
pub fn level(access: i64) -> UserLevel {
    match access {
        ..=249 => UserLevel::Everyone,
        250..=399 => UserLevel::Subscriber,
        400..=499 => UserLevel::Vip,
        500..=1499 => UserLevel::Moderator,
        _ => UserLevel::Broadcaster,
    }
}

/// StreamElements variables Sylva has under another name.
pub fn translate(reply: &str) -> String {
    [
        ("${user.name}", "${user}"),
        ("${sender}", "${user}"),
        ("${source}", "${user}"),
        ("${user.display_name}", "${user}"),
        ("${touser.name}", "${touser}"),
        ("${channel.display_name}", "${channel}"),
        ("${channel.name}", "${channel}"),
        ("${0}", "${args}"),
        ("${1:}", "${args}"),
    ]
    .iter()
    .fold(reply.to_string(), |s, (from, to)| s.replace(from, to))
}

fn num(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(0)
}

/// Add StreamElements commands to `settings`, one at a time so a bad one
/// is skipped rather than failing them all. Commands Sylva already has by
/// that name are left as they are.
pub fn add_commands(settings: &mut BotSettings, list: &Value) -> (usize, Vec<Skipped>) {
    let mut added = 0;
    let mut skipped = Vec::new();
    for c in list.as_array().into_iter().flatten() {
        let name = c["command"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .trim_start_matches('!')
            .to_lowercase();
        let what = format!("!{name}");
        if name.is_empty() {
            continue;
        }
        if settings.find(&name).is_some() {
            skipped.push(Skipped {
                what,
                why: "Sylva already has a command with this name".into(),
            });
            continue;
        }
        if settings.commands.len() >= MAX_COMMANDS {
            skipped.push(Skipped {
                what,
                why: format!("A channel can have up to {MAX_COMMANDS} commands"),
            });
            continue;
        }
        let aliases = c["aliases"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str())
            .map(|a| a.trim_start_matches('!').to_lowercase())
            .filter(|a| settings.find(a).is_none())
            .collect();
        let mut next = settings.clone();
        next.commands.push(Command {
            name,
            aliases,
            reply: translate(c["reply"].as_str().unwrap_or_default()),
            level: level(num(&c["accessLevel"])),
            cooldown: num(&c["cooldown"]["global"]).max(0) as u32,
            user_cooldown: num(&c["cooldown"]["user"]).max(0) as u32,
            enabled: c["enabled"].as_bool().unwrap_or(true),
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

/// Add StreamElements timers. A StreamElements timer can rotate several
/// messages; each becomes its own Sylva timer.
pub fn add_timers(settings: &mut BotSettings, list: &Value) -> (usize, Vec<Skipped>) {
    let mut added = 0;
    let mut skipped = Vec::new();
    for t in list.as_array().into_iter().flatten() {
        let name = t["name"].as_str().unwrap_or("Timer").trim().to_string();
        let messages: Vec<&str> = t["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m.as_str())
            .filter(|m| !m.trim().is_empty())
            .collect();
        let many = messages.len() > 1;
        for (i, m) in messages.iter().enumerate() {
            let label = if many {
                format!("{name} {}", i + 1)
            } else {
                name.clone()
            };
            if settings.timers.len() >= MAX_TIMERS {
                skipped.push(Skipped {
                    what: label,
                    why: format!("A channel can have up to {MAX_TIMERS} timers"),
                });
                continue;
            }
            let interval = num(&t["onlineInterval"]).max(num(&t["interval"]));
            let mut next = settings.clone();
            next.timers.push(Timer {
                id: String::new(),
                name: label.chars().take(crate::bot::MAX_TIMER_NAME).collect(),
                message: translate(m),
                interval: interval.max(1) as u32,
                lines: num(&t["chatLines"]).max(0) as u32,
                live_only: true,
                enabled: t["enabled"].as_bool().unwrap_or(true),
            });
            match next.validated(settings) {
                Ok(ok) => {
                    *settings = ok;
                    added += 1;
                }
                Err(e) => skipped.push(Skipped {
                    what: label,
                    why: e.0,
                }),
            }
        }
    }
    (added, skipped)
}

/// `(login, points)` from a page of StreamElements' points list.
pub fn point_rows(page: &Value) -> Vec<(String, i64)> {
    rows(page, "points")
}

/// `(login, minutes)` from a page of StreamElements' watch time list.
pub fn watch_rows(page: &Value) -> Vec<(String, i64)> {
    rows(page, "minutes")
}

fn rows(page: &Value, field: &str) -> Vec<(String, i64)> {
    page["users"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| {
            let login = u["username"].as_str()?.trim().to_lowercase();
            let points = num(&u[field]);
            (!login.is_empty() && points > 0).then_some((login, points))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn levels_map() {
        assert_eq!(level(100), UserLevel::Everyone);
        assert_eq!(level(250), UserLevel::Subscriber);
        assert_eq!(level(300), UserLevel::Subscriber);
        assert_eq!(level(400), UserLevel::Vip);
        assert_eq!(level(500), UserLevel::Moderator);
        assert_eq!(level(1000), UserLevel::Moderator);
        assert_eq!(level(1500), UserLevel::Broadcaster);
    }

    #[test]
    fn commands_come_over_one_by_one() {
        let mut s = BotSettings::default();
        let list = json!([
            {"command": "!Discord", "reply": "Join us, ${user.name}!", "accessLevel": 100,
             "cooldown": {"global": 30, "user": 60}, "aliases": ["dc", "lurk"], "enabled": true},
            {"command": "lurk", "reply": "dup"},
            {"command": "odd", "reply": "${random.pick 'a' 'b'}"},
            {"command": "mods", "reply": "hi", "accessLevel": "500", "enabled": false}
        ]);
        let (added, skipped) = add_commands(&mut s, &list);
        assert_eq!(added, 2);
        assert_eq!(skipped.len(), 2);
        let d = &s.commands[s.find("discord").unwrap()];
        assert_eq!(d.reply, "Join us, ${user}!");
        assert_eq!(
            d.aliases,
            vec!["dc".to_string()],
            "an alias Sylva uses is dropped"
        );
        assert_eq!((d.cooldown, d.user_cooldown), (30, 60));
        let m = &s.commands[s.find("mods").unwrap()];
        assert_eq!(m.level, UserLevel::Moderator);
        assert!(!m.enabled);
        assert!(skipped.iter().any(|x| x.what == "!odd"));
    }

    #[test]
    fn timers_split_messages() {
        let mut s = BotSettings::default();
        let list = json!([{"name": "Socials", "messages": ["Follow!", "Discord!", ""],
                            "onlineInterval": 15, "chatLines": 10, "enabled": true}]);
        let (added, skipped) = add_timers(&mut s, &list);
        assert_eq!((added, skipped.len()), (2, 0));
        assert_eq!(s.timers[0].name, "Socials 1");
        assert_eq!(s.timers[1].message, "Discord!");
        assert_eq!(s.timers[0].interval, 15);
        assert_eq!(s.timers[0].lines, 10);
    }

    #[test]
    fn watch_time_rows() {
        let page = json!({"users": [{"username": "Maple", "minutes": 90}, {"username": "x", "minutes": 0}]});
        assert_eq!(watch_rows(&page), vec![("maple".to_string(), 90)]);
    }

    #[test]
    fn points_rows() {
        let page = json!({"_total": 3, "users": [
            {"username": "Maple", "points": 1200},
            {"username": "zero", "points": 0},
            {"points": 5}
        ]});
        assert_eq!(point_rows(&page), vec![("maple".to_string(), 1200)]);
    }
}

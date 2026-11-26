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

/// One follow, sub, gift, cheer, raid or tip from StreamElements' activity
/// history, kept so the Stats page can show streams from before Sylva.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HistoryRow {
    /// `se:<activity id>`, so importing twice keeps one copy.
    pub id: String,
    /// Sylva's event kind: `follow`, `subscriber`, `communityGift`,
    /// `cheer`, `raid` or `tip`.
    pub kind: &'static str,
    /// Unix milliseconds.
    pub at: i64,
    pub amount: f64,
    pub name: Option<String>,
}

/// The activity types asked for, as StreamElements names them.
pub const HISTORY_TYPES: [&str; 5] = ["follow", "subscriber", "cheer", "raid", "tip"];
/// Activities per page; StreamElements allows up to 500.
pub const HISTORY_PAGE: usize = 500;

fn list(page: &Value) -> &[Value] {
    page.as_array()
        .or_else(|| page["docs"].as_array())
        .map_or(&[], |v| v.as_slice())
}

fn ms(v: &Value) -> Option<i64> {
    crate::twitch::timestamp_ms(v.as_str()?)
}

fn amount(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0)
}

/// Rows from one page of `GET /activities/{channel}`. A sub gifted to one
/// person counts as their sub plus one gifted sub for the giver; a bundle
/// of gifts counts once as gifted subs, since each person who got one has
/// their own row.
pub fn history_rows(page: &Value) -> Vec<HistoryRow> {
    let mut out = Vec::new();
    for a in list(page) {
        let (Some(id), Some(at)) = (a["_id"].as_str(), ms(&a["createdAt"])) else {
            continue;
        };
        let d = &a["data"];
        let name = d["displayName"]
            .as_str()
            .or_else(|| d["username"].as_str())
            .map(String::from);
        let row = |kind, amount, name| HistoryRow {
            id: format!("se:{id}"),
            kind,
            at,
            amount,
            name,
        };
        match a["type"].as_str().unwrap_or("") {
            "follow" => out.push(row("follow", 0.0, name)),
            "cheer" => out.push(row("cheer", amount(&d["amount"]), name)),
            "raid" => out.push(row("raid", amount(&d["amount"]), name)),
            "tip" => out.push(row("tip", amount(&d["amount"]), name)),
            "subscriber" => {
                let sender = d["sender"].as_str().map(String::from);
                if d["bulkGifted"].as_bool() == Some(true) {
                    out.push(row(
                        "communityGift",
                        amount(&d["amount"]).max(1.0),
                        sender.or(name),
                    ));
                    continue;
                }
                out.push(row("subscriber", 0.0, name));
                if d["gifted"].as_bool() == Some(true)
                    && d["communityGifted"].as_bool() != Some(true)
                {
                    let mut gift = row("communityGift", 1.0, sender);
                    gift.id.push_str(":gift");
                    out.push(gift);
                }
            }
            _ => {}
        }
    }
    out
}

/// The time span one page of activities covers, oldest first, and whether
/// it came newest first. `None` for an empty page.
pub fn history_span(page: &Value) -> Option<(i64, i64, bool)> {
    let times: Vec<i64> = list(page)
        .iter()
        .filter_map(|a| ms(&a["createdAt"]))
        .collect();
    let (first, last) = (*times.first()?, *times.last()?);
    let lo = times.iter().copied().min()?;
    let hi = times.iter().copied().max()?;
    Some((lo, hi, first >= last))
}

/// Ways to ask for activities, tried in order until StreamElements takes
/// one: (page size, `types` as a JSON list, dates as ISO text). Their docs
/// allow both forms, but the API has been strict about some of them.
pub const HISTORY_ASKS: [(usize, bool, bool); 5] = [
    (HISTORY_PAGE, false, false),
    (HISTORY_PAGE, true, false),
    (100, true, true),
    (100, false, true),
    (25, true, true),
];

/// The query for `GET /activities/{channel}`, from `after` to `before`
/// (Unix milliseconds).
pub fn activities_query(after: i64, before: i64, ask: (usize, bool, bool)) -> String {
    let (limit, json_types, iso) = ask;
    let date = |ms: i64| {
        if iso {
            chrono::DateTime::from_timestamp_millis(ms)
                .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
                .unwrap_or_else(|| ms.to_string())
        } else {
            ms.to_string()
        }
    };
    let types = if json_types {
        let list: Vec<String> = HISTORY_TYPES.iter().map(|t| format!("%22{t}%22")).collect();
        format!("&types=%5B{}%5D", list.join("%2C"))
    } else {
        HISTORY_TYPES
            .iter()
            .map(|t| format!("&types={t}"))
            .collect()
    };
    format!(
        "after={}&before={}&limit={limit}{types}",
        date(after),
        date(before)
    )
}

/// When a StreamElements account was made, from its id (a MongoDB object
/// id starts with its creation time in seconds).
pub fn created_ms(id: &str) -> Option<i64> {
    let secs = i64::from_str_radix(id.get(..8)?, 16).ok()?;
    (id.len() == 24).then_some(secs * 1000)
}

/// How many activities a page holds, counted the way StreamElements does.
pub fn history_len(page: &Value) -> usize {
    list(page).len()
}

/// Finished streams from `GET /streams/{channel}`: start and end in Unix
/// milliseconds, and how many people chatted.
pub fn past_streams(page: &Value) -> Vec<(i64, i64, u64)> {
    let mut out: Vec<(i64, i64, u64)> = list(page)
        .iter()
        .filter_map(|s| {
            let (start, end) = (ms(&s["start"])?, ms(&s["end"])?);
            (end > start).then_some((start, end, num(&s["totalChatters"]).max(0) as u64))
        })
        .collect();
    out.sort_unstable();
    out.dedup_by_key(|s| s.0);
    out
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

    #[test]
    fn history_maps_activities() {
        let page = json!([
            {"_id": "a", "type": "follow", "createdAt": "2024-12-10T23:35:27.941Z", "data": {"username": "mrsim", "displayName": "MrSim"}},
            {"_id": "b", "type": "cheer", "createdAt": "2024-12-09T02:12:05.009Z", "data": {"amount": 100, "username": "MrSim"}},
            {"_id": "c", "type": "subscriber", "createdAt": "2024-12-08T00:00:00Z", "data": {"username": "x", "gifted": true, "sender": "Giver"}},
            {"_id": "d", "type": "subscriber", "createdAt": "2024-12-07T00:00:00Z", "data": {"username": "y", "gifted": true, "communityGifted": true, "sender": "Giver"}},
            {"_id": "e", "type": "subscriber", "createdAt": "2024-12-06T00:00:00Z", "data": {"username": "Giver", "amount": 5, "bulkGifted": true}},
            {"_id": "f", "type": "redemption", "createdAt": "2024-12-05T00:00:00Z", "data": {}},
            {"_id": "g", "type": "raid", "createdAt": "nope", "data": {"amount": 3}}
        ]);
        let rows = history_rows(&page);
        let kinds: Vec<(&str, &str, f64)> = rows
            .iter()
            .map(|r| (r.id.as_str(), r.kind, r.amount))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("se:a", "follow", 0.0),
                ("se:b", "cheer", 100.0),
                ("se:c", "subscriber", 0.0),
                ("se:c:gift", "communityGift", 1.0),
                ("se:d", "subscriber", 0.0),
                ("se:e", "communityGift", 5.0),
            ]
        );
        assert_eq!(rows[0].name.as_deref(), Some("MrSim"));
        assert_eq!(rows[3].name.as_deref(), Some("Giver"));
        assert_eq!(rows[0].at, 1733873727941);
        let (lo, hi, newest_first) = history_span(&page).unwrap();
        assert!(newest_first && lo == 1733356800000 && hi == 1733873727941);
        assert_eq!(
            history_rows(&json!({"total": 1, "docs": [page[0].clone()]})).len(),
            1
        );
    }

    #[test]
    fn activity_queries() {
        assert_eq!(
            activities_query(1, 2, HISTORY_ASKS[0]),
            "after=1&before=2&limit=500&types=follow&types=subscriber&types=cheer&types=raid&types=tip"
        );
        assert_eq!(
            activities_query(1733873727941, 1733873727942, HISTORY_ASKS[2]),
            "after=2024-12-10T23:35:27.941Z&before=2024-12-10T23:35:27.942Z&limit=100&types=%5B%22follow%22%2C%22subscriber%22%2C%22cheer%22%2C%22raid%22%2C%22tip%22%5D"
        );
        assert_eq!(created_ms("68c25f6fc41e0d0d7c530984"), Some(1757568879000));
        assert_eq!(created_ms("nope"), None);
    }

    #[test]
    fn past_streams_need_an_end() {
        let page = json!([
            {"start": "2024-12-16T00:44:41.599Z", "end": "2024-12-16T06:56:56.719Z", "totalChatters": 1251},
            {"start": "2024-12-13T00:58:52.088Z", "end": "2024-12-13T06:28:44.613Z", "totalChatters": 2704},
            {"start": "2024-12-17T02:21:11.311Z", "end": null, "online": true}
        ]);
        let s = past_streams(&page);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], (1734051532088, 1734071324613, 2704));
    }
}

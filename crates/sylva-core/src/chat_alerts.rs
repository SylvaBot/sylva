//! Chat alerts: the bot posts a line in chat when something happens on the
//! stream (a sub, a raid, a hype train, a prediction and so on).
//!
//! Each alert has an on/off switch and a message of at most [`MAX_MESSAGE`]
//! characters. Messages use Sylva's variable syntax, `${user}`, and each
//! alert lists the variables it fills. Everything starts off, so nothing is
//! posted in a streamer's chat until they turn it on.
//!
//! Subs, resubs and gifted subs come from Twitch's `channel.chat.notification`
//! (it is the only Twitch event that tells Prime from Tier 1 and links a gift
//! to the community gift it is part of). Watch streaks come from it too.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{Event, EventKind, Platform};
use crate::alerts::Invalid;

/// Twitch's limit for one chat message.
pub const MAX_MESSAGE: usize = 500;

/// One alert's place on the page and its default message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub default: &'static str,
    pub variables: &'static [&'static str],
}

/// A section of the page, such as Subscription Alerts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: &'static str,
    pub title: &'static str,
    pub desc: &'static str,
    pub alerts: &'static [AlertInfo],
}

const fn a(
    id: &'static str,
    label: &'static str,
    default: &'static str,
    variables: &'static [&'static str],
) -> AlertInfo {
    AlertInfo {
        id,
        label,
        default,
        variables,
    }
}

const USER: &[&str] = &["user"];
const RESUB: &[&str] = &["user", "months"];
const GIFT: &[&str] = &["user", "recipient"];
const MASS: &[&str] = &["user", "amount"];
const HYPE: &[&str] = &[
    "current_level",
    "next_level",
    "level_percent",
    "top_contributor_name",
    "top_contributor_total",
    "top_contributor_type",
];
const STREAM: &[&str] = &["channel", "game", "title"];

/// Every alert, in the order the page shows them.
pub const GROUPS: &[Group] = &[
    Group {
        id: "subs",
        title: "Subscription alerts",
        desc: "",
        alerts: &[
            a("sub_1", "Tier 1", "/me ${user} just subscribed!", USER),
            a("sub_2", "Tier 2", "/me ${user} just subscribed with Tier 2!", USER),
            a("sub_3", "Tier 3", "/me ${user} just subscribed with Tier 3!", USER),
            a(
                "sub_prime",
                "Prime Gaming",
                "/me ${user} just subscribed with Prime Gaming!",
                USER,
            ),
        ],
    },
    Group {
        id: "resubs",
        title: "Resubscription alerts",
        desc: "",
        alerts: &[
            a(
                "resub_1",
                "Tier 1",
                "/me ${user} just resubscribed for ${months} months!",
                RESUB,
            ),
            a(
                "resub_2",
                "Tier 2",
                "/me ${user} just resubscribed for ${months} months with Tier 2!",
                RESUB,
            ),
            a(
                "resub_3",
                "Tier 3",
                "/me ${user} just resubscribed for ${months} months with Tier 3!",
                RESUB,
            ),
            a(
                "resub_prime",
                "Prime Gaming",
                "/me ${user} just resubscribed for ${months} months with Prime!",
                RESUB,
            ),
        ],
    },
    Group {
        id: "gifts",
        title: "Gifted subscription alerts",
        desc: "This alert sends individual gifted sub alerts per recipient.",
        alerts: &[
            a(
                "gift_1",
                "Tier 1",
                "/me ${user} just gifted a sub to ${recipient}!",
                GIFT,
            ),
            a(
                "gift_2",
                "Tier 2",
                "/me ${user} just gifted a Tier 2 sub to ${recipient}!",
                GIFT,
            ),
            a(
                "gift_3",
                "Tier 3",
                "/me ${user} just gifted a Tier 3 sub to ${recipient}!",
                GIFT,
            ),
        ],
    },
    Group {
        id: "mass",
        title: "Mass gift subscription alerts",
        desc: "If an alert is triggered, it will not send individual gifted sub alerts.",
        alerts: &[
            a("mass_1", "Tier 1", "/me ${user} just gifted ${amount} subs!", MASS),
            a(
                "mass_2",
                "Tier 2",
                "/me ${user} just gifted ${amount} Tier 2 subs!",
                MASS,
            ),
            a(
                "mass_3",
                "Tier 3",
                "/me ${user} just gifted ${amount} Tier 3 subs!",
                MASS,
            ),
        ],
    },
    Group {
        id: "raids",
        title: "Raid alerts",
        desc: "",
        alerts: &[a(
            "raid",
            "Raid",
            "/me ${user} is raiding the stream with ${viewers} viewers! TombRaid",
            &["user", "viewers"],
        )],
    },
    Group {
        id: "bits",
        title: "Bits alerts",
        desc: "",
        alerts: &[a(
            "bits",
            "Cheer",
            "${user} just cheered ${bits} bits! PogChamp",
            &["user", "bits"],
        )],
    },
    Group {
        id: "charity",
        title: "Twitch charity alerts",
        desc: "Sylva works with Twitch's charity platform.",
        alerts: &[a(
            "charity",
            "Donation",
            "bleedPurple ${user} just donated ${amount} to ${charity_name}! Learn more about ${charity_name} at ${charity_website} bleedPurple",
            &["user", "amount", "charity_name", "charity_website"],
        )],
    },
    Group {
        id: "ads",
        title: "Twitch ad breaks",
        desc: "Automatically announce ad breaks in chat.",
        alerts: &[a(
            "ad",
            "Ad break",
            "/me ${length_seconds} second ad break now running. Be right back! FrankerZ",
            &["length_seconds"],
        )],
    },
    Group {
        id: "hype",
        title: "Hype train alerts",
        desc: "",
        alerts: &[
            a(
                "hype_start",
                "Started",
                "🚂 Hype Train STARTED! Progress: ${level_percent}% towards Level ${next_level}! Thanks to ${top_contributor_name} for contributing ${top_contributor_total} ${top_contributor_type}! <3",
                HYPE,
            ),
            a(
                "hype_level",
                "New level",
                "🚂 Hype Train LEVEL ${current_level}! Progress: ${level_percent}% towards Level ${next_level}! Thanks to ${top_contributor_name} for contributing ${top_contributor_total} ${top_contributor_type}! <3",
                HYPE,
            ),
            a(
                "hype_end",
                "Ended",
                "🚂 Hype Train ENDED! We reached Level ${current_level}! Thanks to ${top_contributor_name} for contributing ${top_contributor_total} ${top_contributor_type}! <3",
                &[
                    "current_level",
                    "top_contributor_name",
                    "top_contributor_total",
                    "top_contributor_type",
                ],
            ),
        ],
    },
    Group {
        id: "stream",
        title: "Stream alerts",
        desc: "",
        alerts: &[
            a(
                "live",
                "Went live",
                "/me ${channel} just went live! They're playing ${game}!",
                STREAM,
            ),
            a(
                "game",
                "Game changed",
                "${channel} changed their game to ${game}! PogChamp",
                STREAM,
            ),
            a(
                "title",
                "Title changed",
                "${channel} changed their title to \"${title}\"! PogChamp",
                STREAM,
            ),
        ],
    },
    Group {
        id: "predictions",
        title: "Prediction alerts",
        desc: "",
        alerts: &[
            a(
                "prediction_start",
                "Started",
                "New Prediction! PogChamp \"${title}\", outcomes are ${outcomes}!",
                &["title", "outcomes"],
            ),
            a(
                "prediction_lock",
                "Locked",
                "Prediction Locked! 🔒 👀 - the choice with most wagered points is \"${highest_vote}\" with ${highest_vote_count} points out of ${total_votes} points total. Good luck!",
                &["title", "highest_vote", "highest_vote_count", "total_votes"],
            ),
            a(
                "prediction_cancel",
                "Canceled",
                "Prediction Canceled! BibleThump - All points will be returned to viewers.",
                &["title"],
            ),
            a(
                "prediction_end",
                "Ended",
                "\"${winner}\" won the prediction! PogChamp ${winner_percentage}% of people voted correctly, meaning ${votes_pool} points will be distributed among ${winner_users} users.",
                &[
                    "title",
                    "winner",
                    "winner_percentage",
                    "votes_pool",
                    "winner_users",
                ],
            ),
        ],
    },
    Group {
        id: "polls",
        title: "Poll alerts",
        desc: "",
        alerts: &[
            a(
                "poll_start",
                "Started",
                "[NEW POLL] :: \"${title}\" - choices: ${choices}",
                &["title", "choices"],
            ),
            a(
                "poll_end",
                "Ended",
                "[POLL ENDED] :: \"${title}\" - result is ${result}!",
                &["title", "result"],
            ),
        ],
    },
    Group {
        id: "follows",
        title: "Follower alerts",
        desc: "",
        alerts: &[a(
            "follow",
            "Follow",
            "/me ${user} just followed the stream!",
            USER,
        )],
    },
    Group {
        id: "streaks",
        title: "Watch streak alerts",
        desc: "",
        alerts: &[a(
            "watch_streak",
            "Watch streak",
            "${user} has been here for ${amount} consecutive streams! PogChamp",
            &["user", "amount"],
        )],
    },
];

/// The alert with this id.
pub fn info(id: &str) -> Option<&'static AlertInfo> {
    GROUPS
        .iter()
        .flat_map(|g| g.alerts.iter())
        .find(|a| a.id == id)
}

/// One alert's switch and message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAlert {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub message: String,
}

fn five() -> u32 {
    5
}
fn hundred() -> u32 {
    100
}
fn two() -> u32 {
    2
}
fn yes() -> bool {
    true
}

/// A channel's chat alert settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAlertSettings {
    #[serde(default)]
    pub alerts: BTreeMap<String, ChatAlert>,
    /// Fewest raiders that make a raid alert.
    #[serde(default = "five")]
    pub raid_min: u32,
    /// Fewest bits in one cheer that make a bits alert.
    #[serde(default = "hundred")]
    pub bits_min: u32,
    /// Smallest charity donation, in the donation's currency, that makes an alert.
    #[serde(default)]
    pub charity_min: f64,
    /// Fewest streams in a row that make a watch streak alert.
    #[serde(default = "two")]
    pub watch_streak_min: u32,
    /// Also announce the ad breaks Twitch runs on a schedule.
    #[serde(default = "yes")]
    pub ad_automatic: bool,
}

impl Default for ChatAlertSettings {
    fn default() -> Self {
        ChatAlertSettings {
            alerts: BTreeMap::new(),
            raid_min: 5,
            bits_min: 100,
            charity_min: 0.0,
            watch_streak_min: 2,
            ad_automatic: true,
        }
        .upgraded()
    }
}

/// The `${name}` variables in a message, in order.
fn variables(message: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = message;
    while let Some(i) = rest.find("${") {
        let after = &rest[i + 2..];
        let Some(end) = after.find('}') else { break };
        out.push(after[..end].trim());
        rest = &after[end + 1..];
    }
    out
}

impl ChatAlertSettings {
    /// Fill in every alert the stored settings do not have yet, off and with
    /// its default message.
    pub fn upgraded(mut self) -> Self {
        for g in GROUPS {
            for a in g.alerts {
                self.alerts.entry(a.id.to_string()).or_insert(ChatAlert {
                    enabled: false,
                    message: a.default.to_string(),
                });
            }
        }
        self.alerts.retain(|id, _| info(id).is_some());
        self
    }

    /// Check settings from the dashboard.
    pub fn validated(self) -> Result<Self, Invalid> {
        let mut s = self.upgraded();
        for (id, alert) in s.alerts.iter_mut() {
            let i = info(id).expect("upgraded keeps known ids only");
            let name = alert_name(id);
            alert.message = alert.message.trim().to_string();
            if alert.message.is_empty() {
                return Err(Invalid(format!("{name} needs a message")));
            }
            let len = alert.message.chars().count();
            if len > MAX_MESSAGE {
                return Err(Invalid(format!(
                    "{name} is {len} characters. The most is {MAX_MESSAGE}."
                )));
            }
            if alert.message.chars().any(|c| c.is_control()) {
                return Err(Invalid(format!("{name} must be one line")));
            }
            for v in variables(&alert.message) {
                if !i.variables.contains(&v) {
                    return Err(Invalid(format!(
                        "{name} cannot use ${{{v}}}. It can use {}.",
                        i.variables
                            .iter()
                            .map(|v| format!("${{{v}}}"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
            }
        }
        if s.raid_min > 1_000_000 || s.bits_min > 1_000_000 || s.watch_streak_min > 10_000 {
            return Err(Invalid("That minimum is too high".into()));
        }
        if !s.charity_min.is_finite() || s.charity_min < 0.0 || s.charity_min > 1_000_000.0 {
            return Err(Invalid(
                "The charity minimum must be between 0 and 1,000,000".into(),
            ));
        }
        s.charity_min = (s.charity_min * 100.0).round() / 100.0;
        Ok(s)
    }

    fn on(&self, id: &str) -> Option<&str> {
        self.alerts
            .get(id)
            .filter(|a| a.enabled)
            .map(|a| a.message.as_str())
    }
}

/// "Hype train alerts: Started", for error messages.
fn alert_name(id: &str) -> String {
    for g in GROUPS {
        if let Some(a) = g.alerts.iter().find(|a| a.id == id) {
            return format!("{} ({})", g.title, a.label);
        }
    }
    id.to_string()
}

/// Fill a message's variables. Twitch's chat API has no `/me`, so a message
/// that starts with it is sent as a plain line. The result is one line of at
/// most [`MAX_MESSAGE`] characters.
pub fn render(message: &str, vars: &[(&str, String)]) -> String {
    let mut out = String::new();
    let mut rest = message;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[i..]);
            rest = "";
            break;
        };
        let name = after[..end].trim();
        match vars.iter().find(|(k, _)| *k == name) {
            Some((_, v)) => out.push_str(v),
            None => out.push_str(&rest[i..i + 2 + end + 1]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    let mut line = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.get(..3).is_some_and(|h| h.eq_ignore_ascii_case("/me")) {
        let tail = &line[3..];
        if tail.is_empty() || tail.starts_with(' ') {
            line = tail.trim_start().to_string();
        }
    }
    line.chars().take(MAX_MESSAGE).collect()
}

/// What the channel knows that an event alone does not say.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    /// The streamer's display name.
    pub channel: String,
    /// The category and title Sylva last saw, before this event.
    pub game: Option<String>,
    pub title: Option<String>,
    /// The highest level already announced for the hype train in this event.
    pub hype_level: Option<i64>,
}

/// A line to post: the alert and its message filled in.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub alert: &'static str,
    pub text: String,
}

fn s(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn n(v: &Value, key: &str) -> i64 {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(n.as_f64().unwrap_or(0.0) as i64),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

/// `1000` is tier 1, and so on. Anything else counts as tier 1.
fn tier(raw: &str) -> &'static str {
    match raw {
        "2000" => "2",
        "3000" => "3",
        _ => "1",
    }
}

/// "a, b or c".
fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} or {last}", init.join(", ")),
    }
}

fn money(amount: &Value) -> (f64, String) {
    let places = n(amount, "decimal_places").clamp(0, 6) as i32;
    let value = n(amount, "value") as f64 / 10f64.powi(places);
    let currency = s(amount, "currency");
    let shown = format!("{value:.prec$}", prec = places as usize);
    let text = match currency.as_str() {
        "USD" => format!("${shown}"),
        "EUR" => format!("€{shown}"),
        "GBP" => format!("£{shown}"),
        "" => shown,
        c => format!("{shown} {c}"),
    };
    (value, text)
}

/// The biggest contributor of a hype train: name, total and kind.
fn top_contributor(e: &Value) -> (String, String, String) {
    let best = e["top_contributions"]
        .as_array()
        .and_then(|list| list.iter().max_by_key(|c| n(c, "total")));
    let Some(c) = best else {
        return ("everyone".into(), String::new(), String::new());
    };
    let total = n(c, "total");
    let name = s(c, "user_name");
    match c["type"].as_str() {
        Some("bits") => (name, total.to_string(), "bits".into()),
        // Twitch counts a Tier 1 sub as 500, Tier 2 as 1000, Tier 3 as 2500.
        Some("subscription") => {
            let subs = (total / 500).max(1);
            let kind = if subs == 1 { "sub" } else { "subs" };
            (name, subs.to_string(), kind.into())
        }
        _ => (name, total.to_string(), "points".into()),
    }
}

fn hype_vars(e: &Value) -> Vec<(&'static str, String)> {
    let level = n(e, "level").max(1);
    let goal = n(e, "goal");
    let percent = if goal > 0 {
        (n(e, "progress") * 100 / goal).clamp(0, 100)
    } else {
        0
    };
    let (name, total, kind) = top_contributor(e);
    vec![
        ("current_level", level.to_string()),
        ("next_level", (level + 1).to_string()),
        ("level_percent", percent.to_string()),
        ("top_contributor_name", name),
        ("top_contributor_total", total),
        ("top_contributor_type", kind),
    ]
}

fn titles(v: &Value, key: &str) -> Vec<String> {
    v[key]
        .as_array()
        .map(|a| a.iter().map(|o| s(o, "title")).collect())
        .unwrap_or_default()
}

/// The lines an event should post, given the settings. Only Twitch events
/// count, so a "Try it" test alert never reaches chat.
pub fn lines_for(settings: &ChatAlertSettings, ev: &Event, facts: &Facts) -> Vec<Line> {
    if ev.platform != Platform::Twitch {
        return Vec::new();
    }
    let e = &ev.raw;
    let user = || {
        ev.actor
            .as_ref()
            .map(|a| a.display_name.clone())
            .unwrap_or_else(|| "Anonymous".into())
    };
    let mut out = Vec::new();
    let mut push = |id: &'static str, vars: Vec<(&str, String)>| {
        if let Some(m) = settings.on(id) {
            let text = render(m, &vars);
            if !text.is_empty() {
                out.push(Line { alert: id, text });
            }
        }
    };
    let channel = facts.channel.clone();
    match ev.raw_type.as_str() {
        "channel.chat.notification" => {
            let chatter = if e["chatter_is_anonymous"].as_bool().unwrap_or(false) {
                "An anonymous gifter".to_string()
            } else {
                let name = s(e, "chatter_user_name");
                if name.is_empty() {
                    s(e, "chatter_user_login")
                } else {
                    name
                }
            };
            let pick = |base: &str, t: &str, prime: bool| -> Option<&'static str> {
                let id = if prime {
                    format!("{base}_prime")
                } else {
                    format!("{base}_{t}")
                };
                info(&id).map(|i| i.id)
            };
            match e["notice_type"].as_str().unwrap_or("") {
                "sub" => {
                    let sub = &e["sub"];
                    let prime = sub["is_prime"].as_bool().unwrap_or(false);
                    if let Some(id) = pick("sub", tier(&s(sub, "sub_tier")), prime) {
                        push(id, vec![("user", chatter)]);
                    }
                }
                "resub" => {
                    let r = &e["resub"];
                    let prime = r["is_prime"].as_bool().unwrap_or(false);
                    if let Some(id) = pick("resub", tier(&s(r, "sub_tier")), prime) {
                        push(
                            id,
                            vec![
                                ("user", chatter),
                                ("months", n(r, "cumulative_months").max(1).to_string()),
                            ],
                        );
                    }
                }
                "sub_gift" => {
                    let g = &e["sub_gift"];
                    let t = tier(&s(g, "sub_tier"));
                    // Part of a community gift: that gift's alert speaks for it,
                    // unless the streamer turned that one off.
                    let in_mass = !s(g, "community_gift_id").is_empty();
                    let mass_on = settings.on(&format!("mass_{t}")).is_some();
                    if !(in_mass && mass_on) {
                        if let Some(id) = pick("gift", t, false) {
                            let mut recipient = s(g, "recipient_user_name");
                            if recipient.is_empty() {
                                recipient = s(g, "recipient_user_login");
                            }
                            push(id, vec![("user", chatter), ("recipient", recipient)]);
                        }
                    }
                }
                "community_sub_gift" => {
                    let g = &e["community_sub_gift"];
                    if let Some(id) = pick("mass", tier(&s(g, "sub_tier")), false) {
                        push(
                            id,
                            vec![("user", chatter), ("amount", n(g, "total").to_string())],
                        );
                    }
                }
                "watch_streak" => {
                    let w = &e["watch_streak"];
                    let count = n(w, "streak_count");
                    if count >= settings.watch_streak_min as i64 {
                        push(
                            "watch_streak",
                            vec![("user", chatter), ("amount", count.to_string())],
                        );
                    }
                }
                _ => {}
            }
        }
        "channel.raid" if ev.kind == EventKind::Raid => {
            let viewers = ev.amount.unwrap_or(0.0) as i64;
            if viewers >= settings.raid_min as i64 {
                push(
                    "raid",
                    vec![("user", user()), ("viewers", viewers.to_string())],
                );
            }
        }
        "channel.cheer" => {
            let bits = ev.amount.unwrap_or(0.0) as i64;
            if bits >= settings.bits_min as i64 {
                push("bits", vec![("user", user()), ("bits", bits.to_string())]);
            }
        }
        "channel.follow" => push("follow", vec![("user", user())]),
        "channel.charity_campaign.donate" => {
            let (value, shown) = money(&e["amount"]);
            if value + 1e-9 >= settings.charity_min {
                let mut who = s(e, "user_name");
                if who.is_empty() {
                    who = "Someone".into();
                }
                push(
                    "charity",
                    vec![
                        ("user", who),
                        ("amount", shown),
                        ("charity_name", s(e, "charity_name")),
                        ("charity_website", s(e, "charity_website")),
                    ],
                );
            }
        }
        "channel.ad_break.begin" => {
            let automatic = e["is_automatic"].as_bool().unwrap_or(false);
            if !automatic || settings.ad_automatic {
                push(
                    "ad",
                    vec![("length_seconds", n(e, "duration_seconds").to_string())],
                );
            }
        }
        "channel.hype_train.begin" => push("hype_start", hype_vars(e)),
        "channel.hype_train.progress" => {
            // Progress arrives with every contribution: speak only when a new
            // level is reached.
            let level = n(e, "level");
            if level > 1 && facts.hype_level.is_some_and(|seen| level > seen) {
                push("hype_level", hype_vars(e));
            }
        }
        "channel.hype_train.end" => push("hype_end", hype_vars(e)),
        "stream.online" => {
            let game = facts.game.clone().unwrap_or_default();
            push(
                "live",
                vec![
                    ("channel", channel.clone()),
                    ("game", if game.is_empty() { "something".into() } else { game }),
                    ("title", facts.title.clone().unwrap_or_default()),
                ],
            );
        }
        "channel.update" => {
            let game = s(e, "category_name");
            let title = s(e, "title");
            let vars = vec![
                ("channel", channel.clone()),
                ("game", game.clone()),
                ("title", title.clone()),
            ];
            if facts.game.as_ref().is_some_and(|g| *g != game) && !game.is_empty() {
                push("game", vars.clone());
            }
            if facts.title.as_ref().is_some_and(|t| *t != title) && !title.is_empty() {
                push("title", vars);
            }
        }
        "channel.prediction.begin" => push(
            "prediction_start",
            vec![
                ("title", s(e, "title")),
                ("outcomes", list(&titles(e, "outcomes"))),
            ],
        ),
        "channel.prediction.lock" => {
            let outcomes = e["outcomes"].as_array().cloned().unwrap_or_default();
            let total: i64 = outcomes.iter().map(|o| n(o, "channel_points")).sum();
            let best = outcomes.iter().max_by_key(|o| n(o, "channel_points"));
            push(
                "prediction_lock",
                vec![
                    ("title", s(e, "title")),
                    ("highest_vote", best.map(|o| s(o, "title")).unwrap_or_default()),
                    (
                        "highest_vote_count",
                        best.map(|o| n(o, "channel_points")).unwrap_or(0).to_string(),
                    ),
                    ("total_votes", total.to_string()),
                ],
            );
        }
        "channel.prediction.end" => {
            if e["status"] == "canceled" {
                push("prediction_cancel", vec![("title", s(e, "title"))]);
            } else if e["status"] == "resolved" {
                let outcomes = e["outcomes"].as_array().cloned().unwrap_or_default();
                let winner_id = s(e, "winning_outcome_id");
                let users: i64 = outcomes.iter().map(|o| n(o, "users")).sum();
                let pool: i64 = outcomes.iter().map(|o| n(o, "channel_points")).sum();
                if let Some(w) = outcomes.iter().find(|o| s(o, "id") == winner_id) {
                    let wu = n(w, "users");
                    let pct = if users > 0 {
                        ((wu as f64) * 100.0 / users as f64).round() as i64
                    } else {
                        0
                    };
                    push(
                        "prediction_end",
                        vec![
                            ("title", s(e, "title")),
                            ("winner", s(w, "title")),
                            ("winner_percentage", pct.to_string()),
                            ("votes_pool", pool.to_string()),
                            ("winner_users", wu.to_string()),
                        ],
                    );
                }
            }
        }
        "channel.poll.begin" => push(
            "poll_start",
            vec![
                ("title", s(e, "title")),
                ("choices", titles(e, "choices").join(", ")),
            ],
        ),
        // Twitch sends `archived` after `completed` or `terminated` for the
        // same poll; only the first one is announced.
        "channel.poll.end" if e["status"] == "completed" || e["status"] == "terminated" => {
            let choices = e["choices"].as_array().cloned().unwrap_or_default();
            let top = choices.iter().map(|c| n(c, "votes")).max().unwrap_or(0);
            let winners: Vec<String> = choices
                .iter()
                .filter(|c| n(c, "votes") == top)
                .map(|c| s(c, "title"))
                .collect();
            let votes = if top == 1 { "vote" } else { "votes" };
            let result = match winners.as_slice() {
                [] => "no votes".to_string(),
                [one] => format!("\"{one}\" with {top} {votes}"),
                many => format!(
                    "a tie between {} with {top} {votes} each",
                    many.iter()
                        .map(|w| format!("\"{w}\""))
                        .collect::<Vec<_>>()
                        .join(" and ")
                ),
            };
            push(
                "poll_end",
                vec![("title", s(e, "title")), ("result", result)],
            );
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Actor;
    use serde_json::json;

    fn all_on() -> ChatAlertSettings {
        let mut s = ChatAlertSettings::default();
        for a in s.alerts.values_mut() {
            a.enabled = true;
        }
        s
    }

    fn ev(raw_type: &str, raw: Value) -> Event {
        Event {
            id: "twitch:1".into(),
            channel: "twitch:1".into(),
            platform: Platform::Twitch,
            kind: EventKind::Other,
            raw_type: raw_type.into(),
            created_at: String::new(),
            actor: None,
            amount: None,
            currency: None,
            message: None,
            tier: None,
            gifted: false,
            sender: None,
            redemption: None,
            raw,
        }
    }

    fn texts(s: &ChatAlertSettings, e: &Event, f: &Facts) -> Vec<String> {
        lines_for(s, e, f).into_iter().map(|l| l.text).collect()
    }

    #[test]
    fn defaults_are_off_short_and_valid() {
        let s = ChatAlertSettings::default();
        assert_eq!(s.alerts.len(), 32);
        assert!(s.alerts.values().all(|a| !a.enabled));
        assert_eq!((s.raid_min, s.bits_min, s.watch_streak_min), (5, 100, 2));
        assert_eq!(s.charity_min, 0.0);
        assert!(s.clone().validated().is_ok());
        let e = ev(
            "channel.chat.notification",
            json!({"notice_type": "sub", "chatter_user_name": "A", "sub": {"sub_tier": "1000", "is_prime": false}}),
        );
        assert!(lines_for(&s, &e, &Facts::default()).is_empty());
    }

    #[test]
    fn checks_length_and_variables() {
        let mut s = ChatAlertSettings::default();
        s.alerts.get_mut("raid").unwrap().message = "x".repeat(501);
        assert!(s.clone().validated().is_err());
        s.alerts.get_mut("raid").unwrap().message = "${user} brought ${bits}".into();
        let err = s.clone().validated().unwrap_err().0;
        assert!(err.contains("${bits}"), "{err}");
        s.alerts.get_mut("raid").unwrap().message = "  ${user} with ${viewers}  ".into();
        assert_eq!(s.validated().unwrap().alerts["raid"].message, "${user} with ${viewers}");
    }

    #[test]
    fn me_is_dropped_and_variables_filled() {
        assert_eq!(
            render("/me ${user}  hi ${nope}", &[("user", "Ann".into())]),
            "Ann hi ${nope}"
        );
        assert_eq!(render("/meow", &[]), "/meow");
    }

    #[test]
    fn subs_tiers_prime_and_resubs() {
        let s = all_on();
        let f = Facts::default();
        let prime = ev(
            "channel.chat.notification",
            json!({"notice_type": "sub", "chatter_user_name": "Ann", "sub": {"sub_tier": "1000", "is_prime": true}}),
        );
        assert_eq!(texts(&s, &prime, &f), ["Ann just subscribed with Prime Gaming!"]);
        let t3 = ev(
            "channel.chat.notification",
            json!({"notice_type": "resub", "chatter_user_name": "Bo",
                   "resub": {"sub_tier": "3000", "is_prime": false, "cumulative_months": 7}}),
        );
        assert_eq!(
            texts(&s, &t3, &f),
            ["Bo just resubscribed for 7 months with Tier 3!"]
        );
    }

    #[test]
    fn mass_gifts_hide_single_gifts_only_when_on() {
        let mut s = all_on();
        let f = Facts::default();
        let one = ev(
            "channel.chat.notification",
            json!({"notice_type": "sub_gift", "chatter_user_name": "Gus",
                   "sub_gift": {"sub_tier": "1000", "recipient_user_name": "Rae", "community_gift_id": "c1"}}),
        );
        let mass = ev(
            "channel.chat.notification",
            json!({"notice_type": "community_sub_gift", "chatter_user_name": "Gus",
                   "community_sub_gift": {"sub_tier": "1000", "total": 5, "id": "c1"}}),
        );
        assert_eq!(texts(&s, &mass, &f), ["Gus just gifted 5 subs!"]);
        assert!(texts(&s, &one, &f).is_empty());
        s.alerts.get_mut("mass_1").unwrap().enabled = false;
        assert_eq!(texts(&s, &one, &f), ["Gus just gifted a sub to Rae!"]);
        let direct = ev(
            "channel.chat.notification",
            json!({"notice_type": "sub_gift", "chatter_is_anonymous": true,
                   "sub_gift": {"sub_tier": "2000", "recipient_user_name": "Rae", "community_gift_id": null}}),
        );
        assert_eq!(
            texts(&all_on(), &direct, &f),
            ["An anonymous gifter just gifted a Tier 2 sub to Rae!"]
        );
    }

    #[test]
    fn minimums() {
        let s = all_on();
        let f = Facts::default();
        let mut raid = ev("channel.raid", json!({}));
        raid.kind = EventKind::Raid;
        raid.actor = Some(Actor {
            id: "9".into(),
            login: "r".into(),
            display_name: "Raider".into(),
        });
        raid.amount = Some(4.0);
        assert!(texts(&s, &raid, &f).is_empty());
        raid.amount = Some(5.0);
        assert_eq!(
            texts(&s, &raid, &f),
            ["Raider is raiding the stream with 5 viewers! TombRaid"]
        );
        let mut cheer = ev("channel.cheer", json!({}));
        cheer.amount = Some(99.0);
        assert!(texts(&s, &cheer, &f).is_empty());
        cheer.amount = Some(100.0);
        assert_eq!(
            texts(&s, &cheer, &f),
            ["Anonymous just cheered 100 bits! PogChamp"]
        );
        let streak = |c: i64| {
            ev(
                "channel.chat.notification",
                json!({"notice_type": "watch_streak", "chatter_user_name": "W",
                       "watch_streak": {"streak_count": c, "channel_points_awarded": 350}}),
            )
        };
        assert!(texts(&s, &streak(1), &f).is_empty());
        assert_eq!(
            texts(&s, &streak(3), &f),
            ["W has been here for 3 consecutive streams! PogChamp"]
        );
    }

    #[test]
    fn charity_and_ads() {
        let mut s = all_on();
        let f = Facts::default();
        let d = ev(
            "channel.charity_campaign.donate",
            json!({"user_name": "Kim", "charity_name": "Good", "charity_website": "https://good.org",
                   "amount": {"value": 550, "decimal_places": 2, "currency": "USD"}}),
        );
        assert_eq!(
            texts(&s, &d, &f),
            ["bleedPurple Kim just donated $5.50 to Good! Learn more about Good at https://good.org bleedPurple"]
        );
        s.charity_min = 10.0;
        assert!(texts(&s, &d, &f).is_empty());
        let ad = ev(
            "channel.ad_break.begin",
            json!({"duration_seconds": 90, "is_automatic": true}),
        );
        assert_eq!(
            texts(&s, &ad, &f),
            ["90 second ad break now running. Be right back! FrankerZ"]
        );
        s.ad_automatic = false;
        assert!(texts(&s, &ad, &f).is_empty());
    }

    #[test]
    fn hype_train_levels() {
        let s = all_on();
        let raw = json!({"level": 2, "progress": 150, "goal": 600,
            "top_contributions": [{"user_name": "Bit", "type": "bits", "total": 300},
                                   {"user_name": "Sub", "type": "subscription", "total": 1500}]});
        let begin = ev("channel.hype_train.begin", raw.clone());
        assert_eq!(
            texts(&s, &begin, &Facts::default()),
            ["🚂 Hype Train STARTED! Progress: 25% towards Level 3! Thanks to Sub for contributing 3 subs! <3"]
        );
        let progress = ev("channel.hype_train.progress", raw);
        let seen = |l| Facts {
            hype_level: Some(l),
            ..Default::default()
        };
        assert!(texts(&s, &progress, &seen(2)).is_empty());
        assert_eq!(texts(&s, &progress, &seen(1)).len(), 1);
    }

    #[test]
    fn stream_changes() {
        let s = all_on();
        let f = Facts {
            channel: "Haru".into(),
            game: Some("Chess".into()),
            title: Some("old".into()),
            hype_level: None,
        };
        let up = ev(
            "channel.update",
            json!({"category_name": "Chess", "title": "new"}),
        );
        assert_eq!(
            texts(&s, &up, &f),
            ["Haru changed their title to \"new\"! PogChamp"]
        );
        let unknown = Facts {
            channel: "Haru".into(),
            ..Default::default()
        };
        assert!(texts(&s, &up, &unknown).is_empty());
        let live = ev("stream.online", json!({}));
        assert_eq!(
            texts(&s, &live, &f),
            ["Haru just went live! They're playing Chess!"]
        );
    }

    #[test]
    fn predictions_and_polls() {
        let s = all_on();
        let f = Facts::default();
        let outcomes = json!([
            {"id": "a", "title": "Yes", "users": 3, "channel_points": 300},
            {"id": "b", "title": "No", "users": 1, "channel_points": 900}
        ]);
        let begin = ev(
            "channel.prediction.begin",
            json!({"title": "Win?", "outcomes": outcomes}),
        );
        assert_eq!(
            texts(&s, &begin, &f),
            ["New Prediction! PogChamp \"Win?\", outcomes are Yes or No!"]
        );
        let lock = ev(
            "channel.prediction.lock",
            json!({"title": "Win?", "outcomes": outcomes}),
        );
        assert_eq!(texts(&s, &lock, &f), ["Prediction Locked! 🔒 👀 - the choice with most wagered points is \"No\" with 900 points out of 1200 points total. Good luck!"]);
        let end = ev(
            "channel.prediction.end",
            json!({"title": "Win?", "status": "resolved", "winning_outcome_id": "a", "outcomes": outcomes}),
        );
        assert_eq!(texts(&s, &end, &f), ["\"Yes\" won the prediction! PogChamp 75% of people voted correctly, meaning 1200 points will be distributed among 3 users."]);
        let cancel = ev(
            "channel.prediction.end",
            json!({"status": "canceled", "outcomes": outcomes}),
        );
        assert_eq!(texts(&s, &cancel, &f).len(), 1);

        let choices = json!([{"title": "A", "votes": 4}, {"title": "B", "votes": 2}]);
        let pb = ev(
            "channel.poll.begin",
            json!({"title": "Pick", "choices": [{"title": "A"}, {"title": "B"}]}),
        );
        assert_eq!(
            texts(&s, &pb, &f),
            ["[NEW POLL] :: \"Pick\" - choices: A, B"]
        );
        let pe = ev(
            "channel.poll.end",
            json!({"title": "Pick", "status": "completed", "choices": choices}),
        );
        assert_eq!(
            texts(&s, &pe, &f),
            ["[POLL ENDED] :: \"Pick\" - result is \"A\" with 4 votes!"]
        );
        let archived = ev(
            "channel.poll.end",
            json!({"title": "Pick", "status": "archived", "choices": choices}),
        );
        assert!(texts(&s, &archived, &f).is_empty());
    }

    #[test]
    fn test_alerts_never_reach_chat() {
        let mut e = ev("channel.follow", json!({}));
        e.platform = Platform::Sylva;
        assert!(lines_for(&all_on(), &e, &Facts::default()).is_empty());
    }
}

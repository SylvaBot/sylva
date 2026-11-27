//! Chat stats for the public page at /c/{login}: how many messages a channel's
//! chat has sent, how fast it moves while live, the top chatters, the top
//! Twitch, 7TV, BetterTTV and FrankerFaceZ emotes and the top commands.
//!
//! Counting starts the first time a chat line arrives after this shipped. Test
//! events never count, lines the chat rules removed never count, and neither
//! does the bot.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::*;

use crate::channel::ChannelDo;
use sylva_core::StoredEvent;

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS chat_meta (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    since         INTEGER NOT NULL,
    total         INTEGER NOT NULL DEFAULT 0,
    live_messages INTEGER NOT NULL DEFAULT 0,
    live_ms       INTEGER NOT NULL DEFAULT 0,
    live_started  INTEGER
);
CREATE TABLE IF NOT EXISTS chat_users (
    user_id  TEXT PRIMARY KEY,
    login    TEXT NOT NULL,
    name     TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chat_users_top ON chat_users(messages);
CREATE TABLE IF NOT EXISTS chat_emotes (
    provider TEXT NOT NULL,
    id       TEXT NOT NULL,
    name     TEXT NOT NULL,
    uses     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, id)
);
CREATE TABLE IF NOT EXISTS chat_commands (
    name TEXT PRIMARY KEY,
    uses INTEGER NOT NULL DEFAULT 0
)
"#;

/// How long the channel's third party emote list is trusted.
const EMOTES_KEEP_MS: f64 = 3_600_000.0;
/// Rows per list on the page.
const TOP: i64 = 10;
const TOP_CHATTERS: i64 = 25;

/// Third party emote names to (provider, id), and when they were fetched.
pub(crate) type EmoteMap = RefCell<Option<(f64, HashMap<String, (String, String)>)>>;

#[derive(Deserialize)]
struct MetaRow {
    since: f64,
    total: f64,
    live_messages: f64,
    live_ms: f64,
    live_started: Option<f64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatterRow {
    login: String,
    name: String,
    messages: f64,
}

#[derive(Deserialize)]
struct EmoteRow {
    id: String,
    name: String,
    uses: f64,
}

#[derive(Deserialize)]
struct CommandRow {
    name: String,
    uses: f64,
}

fn emote_url(provider: &str, id: &str) -> String {
    match provider {
        "twitch" => format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0"),
        "7tv" => format!("https://cdn.7tv.app/emote/{id}/2x.webp"),
        "bttv" => format!("https://cdn.betterttv.net/emote/{id}/2x.webp"),
        _ => format!("https://cdn.frankerfacez.com/emote/{id}/2"),
    }
}

impl ChannelDo {
    fn chat_meta(&self) -> Result<Option<MetaRow>> {
        Ok(self
            .sql
            .exec(
                "SELECT since, total, live_messages, live_ms, live_started FROM chat_meta WHERE id = 1",
                None,
            )?
            .to_array::<MetaRow>()?
            .into_iter()
            .next())
    }

    /// The stream went live or offline: keeps the live time that messages
    /// per second is worked out over.
    pub(crate) fn chat_stream(&self, raw_type: &str, at: i64) -> Result<()> {
        match raw_type {
            "stream.online" => {
                self.sql.exec(
                    "UPDATE chat_meta SET live_started = ? WHERE id = 1",
                    vec![(at as f64).into()],
                )?;
            }
            "stream.offline" => {
                self.sql.exec(
                    "UPDATE chat_meta SET live_ms = live_ms + MAX(0, ? - live_started), live_started = NULL
                     WHERE id = 1 AND live_started IS NOT NULL",
                    vec![(at as f64).into()],
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    async fn emote_names(&self, user_id: &str) -> HashMap<String, (String, String)> {
        let now = Date::now().as_millis() as f64;
        if let Some((at, map)) = self.emote_map.borrow().as_ref() {
            if now - at < EMOTES_KEEP_MS {
                return map.clone();
            }
        }
        let all = crate::chat_assets::build(&self.env, user_id).await;
        let mut map = HashMap::new();
        if let Some(e) = all["emotes"].as_object() {
            for (name, v) in e {
                if let (Some(p), Some(id)) = (v["provider"].as_str(), v["id"].as_str()) {
                    map.insert(name.clone(), (p.to_string(), id.to_string()));
                }
            }
        }
        *self.emote_map.borrow_mut() = Some((now, map.clone()));
        map
    }

    /// Counts one chat line. Called after the bot had its turn, so replies
    /// never wait on the emote lists. Problems are logged, never raised.
    pub(crate) async fn count_chat(&self, line: &StoredEvent, command: Option<String>) {
        if let Err(e) = self.count_chat_inner(line, command).await {
            console_error!("Chat stats could not be counted: {e}");
        }
    }

    async fn count_chat_inner(&self, line: &StoredEvent, command: Option<String>) -> Result<()> {
        let e = &line.event;
        if e.id.starts_with("sylva:test:") {
            return Ok(());
        }
        let Some(actor) = e.actor.as_ref() else {
            return Ok(());
        };
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(());
        };
        if actor.id == crate::bot::sender(&self.env, &broadcaster).id && actor.id != broadcaster {
            return Ok(());
        }
        let now = line.received_at as f64;
        if self.chat_meta()?.is_none() {
            let live = self.uptime_ms()?.is_some().then_some(now);
            self.sql.exec(
                "INSERT INTO chat_meta (id, since, live_started) VALUES (1, ?, ?)",
                vec![now.into(), live.into()],
            )?;
        }
        self.sql.exec(
            "UPDATE chat_meta SET total = total + 1,
               live_messages = live_messages + (CASE WHEN live_started IS NULL THEN 0 ELSE 1 END)
             WHERE id = 1",
            None,
        )?;
        self.sql.exec(
            "INSERT INTO chat_users (user_id, login, name, messages) VALUES (?, ?, ?, 1)
             ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, name = excluded.name,
               messages = messages + 1",
            vec![
                actor.id.as_str().into(),
                actor.login.as_str().into(),
                actor.display_name.as_str().into(),
            ],
        )?;
        if let Some(name) = command {
            self.sql.exec(
                "INSERT INTO chat_commands (name, uses) VALUES (?, 1)
                 ON CONFLICT(name) DO UPDATE SET uses = uses + 1",
                vec![name.into()],
            )?;
        }

        // Twitch marks its own emotes; the rest are words matched against
        // the channel's 7TV, BetterTTV and FrankerFaceZ emotes.
        let mut found: Vec<(String, String, String)> = Vec::new();
        let mut words: Vec<String> = Vec::new();
        match e.raw["message"]["fragments"].as_array() {
            Some(fragments) => {
                for f in fragments {
                    let text = f["text"].as_str().unwrap_or_default();
                    match (f["type"].as_str(), f["emote"]["id"].as_str()) {
                        (Some("emote"), Some(id)) => {
                            found.push(("twitch".into(), id.to_string(), text.to_string()))
                        }
                        (Some("text"), _) => {
                            words.extend(text.split_whitespace().map(String::from))
                        }
                        _ => {}
                    }
                }
            }
            None => {
                if let Some(text) = e.message.as_deref() {
                    words.extend(text.split_whitespace().map(String::from));
                }
            }
        }
        if !words.is_empty() {
            let map = self.emote_names(&broadcaster).await;
            for w in words {
                if let Some((p, id)) = map.get(&w) {
                    found.push((p.clone(), id.clone(), w));
                }
            }
        }
        for (provider, id, name) in found.into_iter().take(50) {
            if id.is_empty() || id.len() > 64 || name.len() > 100 {
                continue;
            }
            self.sql.exec(
                "INSERT INTO chat_emotes (provider, id, name, uses) VALUES (?, ?, ?, 1)
                 ON CONFLICT(provider, id) DO UPDATE SET name = excluded.name, uses = uses + 1",
                vec![provider.into(), id.into(), name.into()],
            )?;
        }
        Ok(())
    }

    fn top_emotes(&self, provider: &str) -> Result<Vec<Value>> {
        Ok(self
            .sql
            .exec(
                "SELECT id, name, uses FROM chat_emotes WHERE provider = ? ORDER BY uses DESC, name LIMIT ?",
                vec![provider.into(), (TOP as f64).into()],
            )?
            .to_array::<EmoteRow>()?
            .into_iter()
            .map(|r| json!({ "id": r.id, "name": r.name, "uses": r.uses, "url": emote_url(provider, &r.id) }))
            .collect())
    }

    /// `GET /public/chatstats`: everything the chat stats page shows.
    pub(crate) fn chat_stats(&self) -> Result<Value> {
        let now = Date::now().as_millis() as f64;
        let meta = self.chat_meta()?;
        let (since, total, per_second) = match &meta {
            Some(m) => {
                let live_ms = m.live_ms + m.live_started.map_or(0.0, |s| (now - s).max(0.0));
                let rate = if live_ms >= 60_000.0 {
                    Some(m.live_messages / (live_ms / 1000.0))
                } else {
                    None
                };
                (Some(m.since), m.total, rate)
            }
            None => (None, 0.0, None),
        };
        let chatters = self
            .sql
            .exec(
                "SELECT login, name, messages FROM chat_users ORDER BY messages DESC, name LIMIT ?",
                vec![(TOP_CHATTERS as f64).into()],
            )?
            .to_array::<ChatterRow>()?;
        let commands: Vec<Value> = self
            .sql
            .exec(
                "SELECT name, uses FROM chat_commands ORDER BY uses DESC, name LIMIT ?",
                vec![(TOP as f64).into()],
            )?
            .to_array::<CommandRow>()?
            .into_iter()
            .map(|r| json!({ "name": r.name, "uses": r.uses }))
            .collect();
        Ok(json!({
            "since": since,
            "total": total,
            "perSecond": per_second,
            "live": meta.as_ref().is_some_and(|m| m.live_started.is_some()),
            "chatters": chatters,
            "emotes": {
                "twitch": self.top_emotes("twitch")?,
                "7tv": self.top_emotes("7tv")?,
                "bttv": self.top_emotes("bttv")?,
                "ffz": self.top_emotes("ffz")?,
            },
            "commands": commands,
        }))
    }

    /// The command a chat line used, by its main name, when it is one the bot
    /// knows: the streamer's own, a built-in, a counter or a points game.
    pub(crate) fn chat_command(&self, text: Option<&str>) -> Option<String> {
        let (trigger, _) = sylva_core::bot::parse(text?)?;
        let settings = self.bot_settings().ok()?;
        if let Some(i) = settings.find(&trigger) {
            return Some(settings.commands[i].name.clone());
        }
        if let Some((b, _)) = settings.builtin(&trigger) {
            return Some(b.name.to_string());
        }
        if settings.counter(&trigger).is_some()
            || sylva_core::games::TRIGGERS.contains(&trigger.as_str())
        {
            return Some(trigger);
        }
        None
    }

    /// `GET /public/profile`: which parts of the channel page have something
    /// to show.
    pub(crate) async fn public_profile(&self) -> Result<Value> {
        let tips = self.tip_settings()?.enabled
            && self.stripe_account()?.is_some_and(|a| a.charges_enabled);
        Ok(json!({
            "bot": self.public_commands()?.is_some(),
            "points": self.loyalty_settings()?.enabled,
            "tips": tips,
            "live": self.uptime_ms()?.is_some(),
        }))
    }
}

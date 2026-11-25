//! The chat bot inside each channel's Durable Object.
//!
//! When a chat line arrives and the bot is on, the channel reads it as a
//! command (see `sylva_core::bot`), checks who may use it and its cooldowns,
//! counts it, writes the reply and sends it with Twitch's Send Chat Message
//! API and Sylva's app token. The streamer granted `user:bot` and
//! `channel:bot` at sign in, which is what Twitch asks for to show the Chat
//! Bot badge.
//!
//! Who the reply comes from: the shared Sylva bot account when
//! `SYLVA_BOT_USER_ID` is set (that account must have approved Sylva once at
//! `/auth/twitch/bot`), otherwise the streamer's own account.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sylva_core::bot::{self, BotSettings, ReplyContext, Skip, UserLevel};
use sylva_core::StoredEvent;
use worker::*;

use crate::channel::ChannelDo;
use crate::twitch_api::App;

/// How long a sent reply is remembered, so its echo in chat is not read as a
/// new command.
const ECHO_MS: i64 = 60_000;

/// Who the bot speaks as, for the dashboard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sender {
    /// `sylva` for the shared bot, `streamer` for the streamer's own account.
    pub kind: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
}

/// `GET /bot`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotView {
    pub settings: BotSettings,
    pub sender: Sender,
}

/// `POST /bot/try`: run a chat line through the bot without sending anything.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TryRequest {
    pub message: String,
    pub level: UserLevel,
    /// Unsaved settings from the editor. The stored ones when left out.
    #[serde(default)]
    pub settings: Option<BotSettings>,
    /// The name to use for `${user}`.
    #[serde(default)]
    pub user: Option<String>,
    /// The streamer's name, used for `${channel}` until Twitch has sent one.
    #[serde(default)]
    pub channel: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TryResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip: Option<Skip>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// A name from the dashboard, trimmed and kept short.
fn short(name: Option<&str>, fallback: &str) -> String {
    let n: String = name.unwrap_or("").trim().chars().take(25).collect();
    if n.is_empty() {
        fallback.to_string()
    } else {
        n
    }
}

#[derive(Deserialize)]
struct AtRow {
    at: f64,
}

pub fn sender(env: &Env, broadcaster_id: &str) -> Sender {
    let var = |n: &str| {
        env.var(n)
            .map(|v| v.to_string().trim().to_string())
            .ok()
            .filter(|v| !v.is_empty())
    };
    match var("SYLVA_BOT_USER_ID") {
        Some(id) if id != broadcaster_id => Sender {
            kind: "sylva",
            id,
            login: var("SYLVA_BOT_LOGIN"),
        },
        _ => Sender {
            kind: "streamer",
            id: broadcaster_id.to_string(),
            login: None,
        },
    }
}

/// The chatter's badge set ids from a `channel.chat.message` payload.
fn badges(raw: &serde_json::Value) -> Vec<String> {
    raw["badges"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|b| b["set_id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

impl ChannelDo {
    pub(crate) fn broadcaster_id(&self) -> Option<String> {
        self.key()
            .and_then(|k| k.strip_prefix("twitch:").map(String::from))
    }

    pub(crate) fn bot_settings(&self) -> Result<BotSettings> {
        if let Some(s) = self.bot.borrow().as_ref() {
            return Ok(s.clone());
        }
        let s = self
            .config("bot")?
            .and_then(|v| serde_json::from_str::<BotSettings>(&v).ok())
            .unwrap_or_default();
        self.bot.replace(Some(s.clone()));
        Ok(s)
    }

    pub(crate) fn save_bot_settings(&self, s: &BotSettings) -> Result<()> {
        self.set_config("bot", &serde_json::to_string(s)?)?;
        self.bot.replace(Some(s.clone()));
        Ok(())
    }

    pub(crate) fn bot_view(&self) -> Result<BotView> {
        let id = self.broadcaster_id().unwrap_or_default();
        Ok(BotView {
            settings: self.bot_settings()?,
            sender: sender(&self.env, &id),
        })
    }

    /// Milliseconds since the stream went live, or `None` when it is offline.
    pub(crate) fn uptime_ms(&self) -> Result<Option<i64>> {
        let rows = self
            .sql
            .exec(
                "SELECT received_at AS at, json_extract(body, '$.rawType') AS raw_type FROM events
                 WHERE kind = 'other' AND json_extract(body, '$.rawType') IN ('stream.online', 'stream.offline')
                 ORDER BY seq DESC LIMIT 1",
                None,
            )?
            .to_array::<StreamRow>()?;
        Ok(rows
            .first()
            .filter(|r| r.raw_type == "stream.online")
            .map(|r| Date::now().as_millis() as i64 - r.at as i64))
    }

    fn last_used(&self, key: &str) -> Result<Option<i64>> {
        let rows = self
            .sql
            .exec(
                "SELECT at FROM bot_cooldowns WHERE key = ?",
                vec![key.into()],
            )?
            .to_array::<AtRow>()?;
        Ok(rows.first().map(|r| r.at as i64))
    }

    fn mark_used(&self, key: &str, now: i64) -> Result<()> {
        self.sql.exec(
            "INSERT INTO bot_cooldowns (key, at) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET at = excluded.at",
            vec![key.into(), now.into()],
        )?;
        Ok(())
    }

    /// Run the sandbox: the reply a chat line would get, sending nothing and
    /// ignoring cooldowns.
    pub(crate) fn try_bot(&self, t: TryRequest) -> Result<std::result::Result<TryResult, String>> {
        let stored = self.bot_settings()?;
        let settings = match t.settings {
            Some(s) => match s.validated(&stored) {
                Ok(s) => s,
                Err(e) => return Ok(Err(e.0)),
            },
            None => stored,
        };
        let skip = |s: Skip, c: Option<String>| TryResult {
            reply: None,
            skip: Some(s),
            command: c,
        };
        let Some((trigger, args)) = bot::parse(&t.message) else {
            return Ok(Ok(skip(Skip::NotACommand, None)));
        };
        let Some(i) = settings.find(&trigger) else {
            return Ok(Ok(skip(Skip::Unknown, None)));
        };
        let c = &settings.commands[i];
        if let Err(s) = bot::allowed(c, t.level, 0, None, None) {
            return Ok(Ok(skip(s, Some(c.name.clone()))));
        }
        let reply = bot::render(
            &c.reply,
            &ReplyContext {
                user: &short(t.user.as_deref(), "Maple"),
                args: &args,
                channel: &match self.config("channel_name")? {
                    Some(n) => n,
                    None => short(t.channel.as_deref(), "This channel"),
                },
                count: c.count + 1,
                uptime_ms: self.uptime_ms()?,
                commands: &settings.commands,
                random: js_sys::Math::random(),
            },
        );
        Ok(Ok(TryResult {
            reply: Some(reply),
            skip: None,
            command: Some(c.name.clone()),
        }))
    }

    /// The streamer's display name, from the newest event Twitch sent about
    /// the channel.
    pub(crate) fn channel_name(&self) -> Result<String> {
        Ok(self
            .config("channel_name")?
            .unwrap_or_else(|| "This channel".into()))
    }

    /// Keep the streamer's display name current from Twitch's payloads.
    pub(crate) fn remember_channel_name(&self, e: &sylva_core::Event) -> Result<()> {
        if e.platform != sylva_core::Platform::Twitch {
            return Ok(());
        }
        let name = e.raw["broadcaster_user_name"]
            .as_str()
            .or_else(|| e.raw["to_broadcaster_user_name"].as_str())
            .filter(|n| !n.is_empty());
        if let Some(n) = name {
            if self.config("channel_name")?.as_deref() != Some(n) {
                self.set_config("channel_name", n)?;
            }
        }
        Ok(())
    }

    /// Answer a chat line if it is a command. Called after the line is stored
    /// and sent to the dashboard. Problems are logged, never raised: chat
    /// must keep flowing whatever happens to a reply.
    pub(crate) async fn run_bot(&self, line: &StoredEvent) {
        if let Err(e) = self.run_bot_inner(line).await {
            console_error!("The bot could not answer: {e}");
        }
    }

    async fn run_bot_inner(&self, line: &StoredEvent) -> Result<()> {
        let e = &line.event;
        let (Some(text), Some(actor)) = (e.message.as_deref(), e.actor.as_ref()) else {
            return Ok(());
        };
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(());
        };
        let mut settings = self.bot_settings()?;
        if !settings.enabled {
            return Ok(());
        }
        let from = sender(&self.env, &broadcaster);
        let now = Date::now().as_millis() as i64;
        if actor.id == from.id && self.is_echo(text, now)? {
            return Ok(());
        }
        let Some((trigger, args)) = bot::parse(text) else {
            return Ok(());
        };
        let Some(i) = settings.find(&trigger) else {
            return Ok(());
        };
        let level = UserLevel::from_badges(
            badges(&e.raw).iter().map(String::as_str),
            actor.id == broadcaster,
        );
        let name = settings.commands[i].name.clone();
        let any_key = format!("c:{name}");
        let user_key = format!("u:{name}:{}", actor.id);
        if bot::allowed(
            &settings.commands[i],
            level,
            now,
            self.last_used(&any_key)?,
            self.last_used(&user_key)?,
        )
        .is_err()
        {
            return Ok(());
        }
        settings.commands[i].count += 1;
        self.save_bot_settings(&settings)?;
        self.mark_used(&any_key, now)?;
        self.mark_used(&user_key, now)?;
        let c = &settings.commands[i];
        let reply = bot::render(
            &c.reply,
            &ReplyContext {
                user: &actor.display_name,
                args: &args,
                channel: &self.channel_name()?,
                count: c.count,
                uptime_ms: self.uptime_ms()?,
                commands: &settings.commands,
                random: js_sys::Math::random(),
            },
        );
        if reply.is_empty() {
            return Ok(());
        }
        self.say(&broadcaster, &from, &reply, now).await
    }

    fn is_echo(&self, text: &str, now: i64) -> Result<bool> {
        let rows = self
            .sql
            .exec(
                "SELECT at FROM bot_sent WHERE text = ? AND at > ?",
                vec![text.trim().into(), (now - ECHO_MS).into()],
            )?
            .to_array::<AtRow>()?;
        Ok(!rows.is_empty())
    }

    /// Send a line to chat as the bot.
    pub(crate) async fn say(
        &self,
        broadcaster: &str,
        from: &Sender,
        text: &str,
        now: i64,
    ) -> Result<()> {
        // Remember it first: Twitch may deliver the echo before it answers.
        self.sql.exec(
            "DELETE FROM bot_sent WHERE at < ?",
            vec![(now - ECHO_MS).into()],
        )?;
        self.sql.exec(
            "INSERT INTO bot_sent (at, text) VALUES (?, ?)",
            vec![now.into(), text.trim().into()],
        )?;
        let app = App::new(&self.env).await?;
        let (status, v) = app
            .helix(
                Method::Post,
                "/chat/messages",
                Some(json!({
                    "broadcaster_id": broadcaster,
                    "sender_id": from.id,
                    "message": text,
                })),
            )
            .await?;
        let sent = status == 200 && v["data"][0]["is_sent"].as_bool().unwrap_or(false);
        if !sent {
            console_error!(
                "Twitch did not send the bot's reply ({status}): {}",
                v["data"][0]["drop_reason"]
            );
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct StreamRow {
    at: f64,
    raw_type: String,
}

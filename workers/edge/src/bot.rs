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
    /// When each timer posts next, in the same order as `settings.timers`.
    pub timers: Vec<TimerStatus>,
    pub live: bool,
}

/// When a timer posts next, or what it waits for.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerStatus {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_at: Option<i64>,
    /// `off`, `bot` (the bot is off), `live` (waits for the stream) or `chat`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<&'static str>,
    /// Chat lines still needed, when waiting for chat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_needed: Option<u32>,
}

/// Timer messages are at least this far apart, so several due at once do not
/// arrive as a burst.
const TIMER_GAP_MS: i64 = 30_000;

#[derive(Deserialize)]
struct TimerRow {
    id: String,
    last: f64,
    lines: f64,
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
pub(crate) fn badges(raw: &serde_json::Value) -> Vec<String> {
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
        // Keep one row per timer: a new timer starts counting from now.
        let now = Date::now().as_millis() as i64;
        let ids: Vec<&str> = s.timers.iter().map(|t| t.id.as_str()).collect();
        for row in self.timer_rows()? {
            if !ids.contains(&row.id.as_str()) {
                self.sql
                    .exec("DELETE FROM timer_state WHERE id = ?", vec![row.id.into()])?;
            }
        }
        for id in ids {
            self.sql.exec(
                "INSERT INTO timer_state (id, last, lines) VALUES (?, ?, 0)
                 ON CONFLICT(id) DO NOTHING",
                vec![id.into(), now.into()],
            )?;
        }
        Ok(())
    }

    fn timer_rows(&self) -> Result<Vec<TimerRow>> {
        self.sql
            .exec("SELECT id, last, lines FROM timer_state", None)?
            .to_array::<TimerRow>()
    }

    pub(crate) fn bot_view(&self) -> Result<BotView> {
        let id = self.broadcaster_id().unwrap_or_default();
        let settings = self.bot_settings()?;
        let live = self.uptime_ms()?.is_some();
        let rows = self.timer_rows()?;
        let timers = settings
            .timers
            .iter()
            .map(|t| {
                let (last, lines) = rows
                    .iter()
                    .find(|r| r.id == t.id)
                    .map_or((0, 0), |r| (r.last as i64, r.lines as u32));
                let wait = |w: &'static str| TimerStatus {
                    id: t.id.clone(),
                    next_at: None,
                    waiting: Some(w),
                    lines_needed: (w == "chat").then(|| t.lines.saturating_sub(lines)),
                };
                if !t.enabled {
                    wait("off")
                } else if !settings.enabled {
                    wait("bot")
                } else if t.live_only && !live {
                    wait("live")
                } else if lines < t.lines {
                    wait("chat")
                } else {
                    TimerStatus {
                        id: t.id.clone(),
                        next_at: t.due_at(last, lines, live),
                        waiting: None,
                        lines_needed: None,
                    }
                }
            })
            .collect();
        Ok(BotView {
            settings,
            sender: sender(&self.env, &id),
            timers,
            live,
        })
    }

    /// The earliest time a timer may post, for the channel's alarm.
    pub(crate) fn next_timer_at(&self, now: i64) -> Result<Option<i64>> {
        let settings = self.bot_settings()?;
        if !settings.enabled || settings.timers.is_empty() {
            return Ok(None);
        }
        let live = self.uptime_ms()?.is_some();
        let rows = self.timer_rows()?;
        let last_any = rows.iter().map(|r| r.last as i64).max().unwrap_or(0);
        Ok(settings
            .timers
            .iter()
            .filter_map(|t| {
                let r = rows.iter().find(|r| r.id == t.id)?;
                t.due_at(r.last as i64, r.lines as u32, live)
            })
            .min()
            .map(|due| due.max(last_any + TIMER_GAP_MS).max(now + 1_000)))
    }

    /// Post the timer that is most overdue, if any. One per call, so timers
    /// due together are spaced by the alarm.
    pub(crate) async fn run_timers(&self, now: i64) -> Result<()> {
        let settings = self.bot_settings()?;
        if !settings.enabled || settings.timers.is_empty() {
            return Ok(());
        }
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(());
        };
        let uptime = self.uptime_ms()?;
        let rows = self.timer_rows()?;
        let last_any = rows.iter().map(|r| r.last as i64).max().unwrap_or(0);
        if now - last_any < TIMER_GAP_MS {
            return Ok(());
        }
        let due = settings
            .timers
            .iter()
            .filter_map(|t| {
                let r = rows.iter().find(|r| r.id == t.id)?;
                let at = t.due_at(r.last as i64, r.lines as u32, uptime.is_some())?;
                (at <= now).then_some((at, t))
            })
            .min_by_key(|(at, _)| *at);
        let Some((_, t)) = due else {
            return Ok(());
        };
        self.sql.exec(
            "UPDATE timer_state SET last = ?, lines = 0 WHERE id = ?",
            vec![now.into(), t.id.as_str().into()],
        )?;
        let text = bot::render(
            &t.message,
            &ReplyContext {
                user: "",
                args: &[],
                channel: &self.channel_name()?,
                count: 0,
                uptime_ms: uptime,
                commands: &settings.commands,
                random: js_sys::Math::random(),
            },
        );
        if text.is_empty() {
            return Ok(());
        }
        let from = sender(&self.env, &broadcaster);
        self.say(&broadcaster, &from, &text, now).await
    }

    /// "Send now" on the dashboard: post a timer's message at once, and start
    /// its wait again.
    pub(crate) async fn send_timer_now(
        &self,
        id: &str,
    ) -> Result<std::result::Result<(), (u16, &'static str)>> {
        let settings = self.bot_settings()?;
        let Some(t) = settings.timers.iter().find(|t| t.id == id) else {
            return Ok(Err((404, "That timer no longer exists")));
        };
        if !settings.enabled {
            return Ok(Err((409, "Turn the bot on first")));
        }
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(Err((409, "Sylva has not heard from this channel yet")));
        };
        let now = Date::now().as_millis() as i64;
        self.sql.exec(
            "UPDATE timer_state SET last = ?, lines = 0 WHERE id = ?",
            vec![now.into(), id.into()],
        )?;
        let text = bot::render(
            &t.message,
            &ReplyContext {
                user: "",
                args: &[],
                channel: &self.channel_name()?,
                count: 0,
                uptime_ms: self.uptime_ms()?,
                commands: &settings.commands,
                random: js_sys::Math::random(),
            },
        );
        let from = sender(&self.env, &broadcaster);
        self.say(&broadcaster, &from, &text, now).await?;
        self.schedule().await?;
        Ok(Ok(()))
    }

    /// The stream went live: every timer starts counting again.
    pub(crate) fn restart_timers(&self, now: i64) -> Result<()> {
        self.sql.exec(
            "UPDATE timer_state SET last = ?, lines = 0",
            vec![now.into()],
        )?;
        Ok(())
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

    pub(crate) fn last_used(&self, key: &str) -> Result<Option<i64>> {
        let rows = self
            .sql
            .exec(
                "SELECT at FROM bot_cooldowns WHERE key = ?",
                vec![key.into()],
            )?
            .to_array::<AtRow>()?;
        Ok(rows.first().map(|r| r.at as i64))
    }

    pub(crate) fn mark_used(&self, key: &str, now: i64) -> Result<()> {
        self.sql.exec(
            "INSERT INTO bot_cooldowns (key, at) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET at = excluded.at",
            vec![key.into(), now.into()],
        )?;
        Ok(())
    }

    /// Run the sandbox: the reply a chat line would get, sending nothing and
    /// ignoring cooldowns.
    pub(crate) async fn try_bot(
        &self,
        t: TryRequest,
    ) -> Result<std::result::Result<TryResult, String>> {
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
            let mut settings = settings;
            let now = Date::now().as_millis() as i64;
            let channel = match self.config("channel_name")? {
                Some(n) => n,
                None => short(t.channel.as_deref(), "This channel"),
            };
            let ask = crate::community::Ask {
                level: t.level,
                channel: &channel,
                now,
                dry: true,
            };
            let user = short(t.user.as_deref(), "Maple");
            let reply = match self.community_reply(&mut settings, &trigger, &args, &ask)? {
                Some(r) => Some(r),
                None => {
                    self.loyalty_reply(&trigger, &args, &ask, None, &user)
                        .await?
                }
            };
            return Ok(Ok(match reply {
                Some(reply) => TryResult {
                    reply: Some(reply),
                    skip: None,
                    command: Some(trigger),
                },
                None => {
                    let level_too_low = (settings.quotes.enabled
                        && matches!(trigger.as_str(), "addquote" | "delquote"))
                        || (trigger == "addpoints" && self.loyalty_settings()?.enabled);
                    skip(
                        if level_too_low {
                            Skip::Level
                        } else {
                            Skip::Unknown
                        },
                        level_too_low.then(|| trigger.clone()),
                    )
                }
            }));
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
        let now = Date::now().as_millis() as i64;
        if let Err(e) = self.run_timers(now).await {
            console_error!("A timer could not post: {e}");
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
        let from = sender(&self.env, &broadcaster);
        let now = Date::now().as_millis() as i64;
        if actor.id == from.id && self.is_echo(text, now)? {
            return Ok(());
        }
        // Timers count what viewers say, not what the bot says.
        self.sql
            .exec("UPDATE timer_state SET lines = lines + 1", None)?;
        let mut settings = self.bot_settings()?;
        if !settings.enabled {
            return Ok(());
        }
        let Some((trigger, args)) = bot::parse(text) else {
            return Ok(());
        };
        let level = UserLevel::from_badges(
            badges(&e.raw).iter().map(String::as_str),
            actor.id == broadcaster,
        );
        let Some(i) = settings.find(&trigger) else {
            // Not a command: maybe a counter, a quote or points.
            let channel = self.channel_name()?;
            let ask = crate::community::Ask {
                level,
                channel: &channel,
                now,
                dry: false,
            };
            let reply = match self.community_reply(&mut settings, &trigger, &args, &ask)? {
                Some(r) => Some(r),
                None => {
                    self.loyalty_reply(&trigger, &args, &ask, Some(actor), &actor.display_name)
                        .await?
                }
            };
            if let Some(reply) = reply {
                self.say(&broadcaster, &from, &reply, now).await?;
            }
            return Ok(());
        };
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

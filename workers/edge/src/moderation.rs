//! Chat moderation in the channel's Durable Object: checking each chat line
//! against the channel's rules (see `sylva_core::moderation`), deleting the
//! message or timing out the chatter through Twitch, the action log, and
//! lifting a timeout from the log.
//!
//! Twitch only lets a moderator, with a user token, delete messages and time
//! people out. Sylva acts as the streamer with the tokens from the
//! `moderation` grant, which the streamer gives on the Moderation page
//! (`/auth/twitch/start?scopes=moderation`). The token lives only in memory
//! here, is refreshed when it runs out, and the refreshed one is saved back
//! to the account, sealed.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sylva_core::bot::UserLevel;
use sylva_core::moderation::{
    self, check, duration_text, penalty, preset, ModSettings, Preset, Rule, Rules, STRIKE_RESET_MS,
};
use sylva_core::StoredEvent;
use worker::*;

use crate::bot::{badges, sender};
use crate::channel::ChannelDo;
use crate::grants::{Permission, Token};
use crate::twitch_api::App;

const PURPOSE: &str = "moderation";

/// Log entries kept per channel.
const LOG_KEEP: i64 = 500;
/// At most one notice in chat this often, so a raid of spam bots does not
/// turn into a wall of notices.
const NOTICE_GAP_MS: i64 = 10_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInfo {
    pub rules: Rules,
    pub exempt: UserLevel,
    pub steps: [u32; 3],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModView {
    pub settings: ModSettings,
    pub permission: Permission,
    pub presets: [(Preset, PresetInfo); 3],
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: i64,
    pub at: i64,
    pub user_id: String,
    pub user: String,
    pub rule: Rule,
    pub message: String,
    /// `delete` or `timeout`.
    pub action: String,
    pub seconds: u32,
    /// `done`, or `failed` with `detail` saying why.
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undone_at: Option<i64>,
}

#[derive(Deserialize)]
struct LogRow {
    id: f64,
    at: f64,
    user_id: String,
    user: String,
    rule: String,
    message: String,
    action: String,
    seconds: f64,
    result: String,
    detail: Option<String>,
    undone_at: Option<f64>,
}

impl LogRow {
    fn entry(self) -> Option<LogEntry> {
        Some(LogEntry {
            id: self.id as i64,
            at: self.at as i64,
            user_id: self.user_id,
            user: self.user,
            rule: serde_json::from_value(json!(self.rule)).ok()?,
            message: self.message,
            action: self.action,
            seconds: self.seconds as u32,
            result: self.result,
            detail: self.detail,
            undone_at: self.undone_at.map(|v| v as i64),
        })
    }
}

#[derive(Deserialize)]
struct StrikeRow {
    count: f64,
    last_at: f64,
}

/// `POST .../moderation/try`: what would happen to a message.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TryRequest {
    pub message: String,
    #[serde(default = "everyone")]
    pub level: UserLevel,
    /// Unsaved settings to try instead of the saved ones.
    #[serde(default)]
    pub settings: Option<ModSettings>,
}

fn everyone() -> UserLevel {
    UserLevel::Everyone
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TryResult {
    /// The rule it breaks, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<Rule>,
    /// True when the chatter's level is skipped.
    pub skipped: bool,
    /// What happens the first, second and third time, in seconds of timeout
    /// (0 deletes the message only).
    pub steps: [u32; 3],
}

/// The text without emotes and the number of emotes, from the fragments
/// Twitch sends with each chat message.
fn split_emotes(raw: &serde_json::Value, text: &str) -> (String, u32) {
    let Some(fragments) = raw["message"]["fragments"].as_array() else {
        return (text.to_string(), 0);
    };
    if fragments.is_empty() {
        return (text.to_string(), 0);
    }
    let mut words = String::new();
    let mut emotes = 0;
    for f in fragments {
        if f["type"] == "emote" {
            emotes += 1;
            words.push(' ');
        } else {
            words.push_str(f["text"].as_str().unwrap_or_default());
        }
    }
    (words, emotes)
}

impl ChannelDo {
    pub(crate) fn mod_settings(&self) -> Result<ModSettings> {
        Ok(self
            .config("moderation")?
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    pub(crate) fn save_mod_settings(&self, s: &ModSettings) -> Result<()> {
        self.set_config("moderation", &serde_json::to_string(s)?)
    }

    pub(crate) async fn mod_view(&self) -> Result<ModView> {
        let info = |p| {
            let (rules, exempt, steps) = preset(p);
            (
                p,
                PresetInfo {
                    rules,
                    exempt,
                    steps,
                },
            )
        };
        Ok(ModView {
            settings: self.mod_settings()?,
            permission: match self.user_token(PURPOSE).await? {
                Token::Ok(_) => Permission::Ok,
                Token::No(p) => p,
            },
            presets: [
                info(Preset::Relaxed),
                info(Preset::Standard),
                info(Preset::Strict),
            ],
        })
    }

    /// Check a chat line and act on it. True when the line broke a rule, so
    /// the bot leaves it alone. Problems are logged, never raised.
    pub(crate) async fn run_moderation(&self, line: &StoredEvent) -> bool {
        match self.moderate(line).await {
            Ok(acted) => acted,
            Err(e) => {
                console_error!("Moderation failed: {e}");
                false
            }
        }
    }

    async fn moderate(&self, line: &StoredEvent) -> Result<bool> {
        let e = &line.event;
        let (Some(text), Some(actor)) = (e.message.as_deref(), e.actor.as_ref()) else {
            return Ok(false);
        };
        let settings = self.mod_settings()?;
        if settings.preset == Preset::Off {
            return Ok(false);
        }
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(false);
        };
        let from = sender(&self.env, &broadcaster);
        if actor.id == from.id {
            return Ok(false);
        }
        let level = UserLevel::from_badges(
            badges(&e.raw).iter().map(String::as_str),
            actor.id == broadcaster,
        );
        if !settings.applies_to(level) {
            return Ok(false);
        }
        let (words_only, emotes) = split_emotes(&e.raw, text);
        let Some(rule) = check(
            &settings,
            &moderation::Message {
                text,
                words_only: &words_only,
                emotes,
            },
        ) else {
            return Ok(false);
        };

        let now = Date::now().as_millis() as i64;
        let strikes = self
            .sql
            .exec(
                "SELECT count, last_at FROM mod_strikes WHERE user_id = ?",
                vec![actor.id.clone().into()],
            )?
            .to_array::<StrikeRow>()?
            .into_iter()
            .next()
            .filter(|r| (r.last_at as i64) > now - STRIKE_RESET_MS)
            .map_or(0, |r| r.count as u32);
        let seconds = penalty(&settings.steps, strikes);
        let message_id = e.raw["message_id"].as_str().unwrap_or_default();

        let outcome = match self.user_token(PURPOSE).await? {
            Token::No(Permission::Expired) => Err(
                "Twitch no longer accepts Sylva's permission. Allow moderation again.".to_string(),
            ),
            Token::No(_) => Err(
                "Sylva is not allowed to moderate yet. Allow moderation on this page.".to_string(),
            ),
            Token::Ok(token) => {
                let user = App::user(&self.env, &token)?;
                let (status, v) = if seconds == 0 {
                    user.helix(
                        Method::Delete,
                        &format!(
                            "/moderation/chat?broadcaster_id={broadcaster}&moderator_id={broadcaster}&message_id={}",
                            sylva_core::auth::encode(message_id)
                        ),
                        None,
                    )
                    .await?
                } else {
                    user.helix(
                        Method::Post,
                        &format!("/moderation/bans?broadcaster_id={broadcaster}&moderator_id={broadcaster}"),
                        Some(json!({ "data": {
                            "user_id": actor.id,
                            "duration": seconds,
                            "reason": format!("Sylva: {}", rule.notice()),
                        }})),
                    )
                    .await?
                };
                if status == 401 {
                    self.forget_token(PURPOSE);
                }
                if (200..300).contains(&status) {
                    Ok(())
                } else {
                    Err(format!(
                        "Twitch said no ({status}): {}",
                        v["message"].as_str().unwrap_or("no reason given")
                    ))
                }
            }
        };

        // Only a strike that reached Twitch counts towards the next step.
        if outcome.is_ok() {
            self.sql.exec(
                "INSERT INTO mod_strikes (user_id, count, last_at) VALUES (?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET count = excluded.count, last_at = excluded.last_at",
                vec![
                    actor.id.clone().into(),
                    i64::from(strikes + 1).into(),
                    now.into(),
                ],
            )?;
        }
        let message: String = text.chars().take(500).collect();
        self.sql.exec(
            "INSERT INTO mod_log (at, user_id, user, rule, message, action, seconds, result, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            vec![
                now.into(),
                actor.id.clone().into(),
                actor.display_name.clone().into(),
                serde_json::to_value(rule)?
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                message.into(),
                if seconds == 0 { "delete" } else { "timeout" }.into(),
                i64::from(seconds).into(),
                if outcome.is_ok() { "done" } else { "failed" }.into(),
                outcome.as_ref().err().cloned().into(),
            ],
        )?;
        self.sql.exec(
            "DELETE FROM mod_log WHERE id <= (SELECT MAX(id) FROM mod_log) - ?",
            vec![LOG_KEEP.into()],
        )?;

        if outcome.is_ok() && settings.notice && now - self.last_notice.get() >= NOTICE_GAP_MS {
            self.last_notice.set(now);
            let what = if seconds == 0 {
                "message removed".to_string()
            } else {
                format!("timed out for {}", duration_text(seconds))
            };
            let text = format!("@{}, {} ({what}).", actor.display_name, rule.notice());
            if let Err(e) = self.say(&broadcaster, &from, &text, now).await {
                console_error!("Could not post the moderation notice: {e}");
            }
        }
        Ok(true)
    }

    pub(crate) fn mod_log(&self, before: i64, limit: i64) -> Result<Vec<LogEntry>> {
        Ok(self
            .sql
            .exec(
                "SELECT id, at, user_id, user, rule, message, action, seconds, result, detail, undone_at
                 FROM mod_log WHERE id < ? ORDER BY id DESC LIMIT ?",
                vec![before.into(), limit.into()],
            )?
            .to_array::<LogRow>()?
            .into_iter()
            .filter_map(LogRow::entry)
            .collect())
    }

    /// Lift a timeout from the log. Deleted messages cannot come back.
    pub(crate) async fn undo_mod_action(
        &self,
        id: i64,
    ) -> Result<std::result::Result<LogEntry, (u16, String)>> {
        let Some(entry) = self
            .sql
            .exec(
                "SELECT id, at, user_id, user, rule, message, action, seconds, result, detail, undone_at
                 FROM mod_log WHERE id = ?",
                vec![id.into()],
            )?
            .to_array::<LogRow>()?
            .into_iter()
            .next()
            .and_then(LogRow::entry)
        else {
            return Ok(Err((404, "That entry is no longer in the log".into())));
        };
        let now = Date::now().as_millis() as i64;
        if entry.action != "timeout" {
            return Ok(Err((
                409,
                "Twitch cannot bring back a deleted message".into(),
            )));
        }
        if entry.result != "done" {
            return Ok(Err((
                409,
                "That timeout never happened, so there is nothing to lift".into(),
            )));
        }
        if entry.undone_at.is_some() {
            return Ok(Err((409, "That timeout was already lifted".into())));
        }
        if entry.at + i64::from(entry.seconds) * 1000 <= now {
            return Ok(Err((409, "That timeout has already ended".into())));
        }
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(Err((
                409,
                "Sylva has not heard from this channel yet".into(),
            )));
        };
        let token = match self.user_token(PURPOSE).await? {
            Token::Ok(t) => t,
            Token::No(_) => {
                return Ok(Err((409, "Allow moderation first".into())));
            }
        };
        let (status, v) = App::user(&self.env, &token)?
            .helix(
                Method::Delete,
                &format!(
                    "/moderation/bans?broadcaster_id={broadcaster}&moderator_id={broadcaster}&user_id={}",
                    sylva_core::auth::encode(&entry.user_id)
                ),
                None,
            )
            .await?;
        // Twitch answers 400 when the timeout already ran out or a moderator
        // lifted it. Either way the chatter can talk again.
        let gone = status == 400
            && v["message"]
                .as_str()
                .is_some_and(|m| m.to_lowercase().contains("not banned"));
        if !(200..300).contains(&status) && !gone {
            return Ok(Err((
                502,
                format!(
                    "Twitch said no ({status}): {}",
                    v["message"].as_str().unwrap_or("no reason given")
                ),
            )));
        }
        self.sql.exec(
            "UPDATE mod_log SET undone_at = ? WHERE id = ?",
            vec![now.into(), id.into()],
        )?;
        // Lifting a timeout also forgives the strike behind it.
        self.sql.exec(
            "UPDATE mod_strikes SET count = MAX(count - 1, 0) WHERE user_id = ?",
            vec![entry.user_id.clone().into()],
        )?;
        Ok(Ok(LogEntry {
            undone_at: Some(now),
            ..entry
        }))
    }

    pub(crate) fn try_moderation(
        &self,
        t: TryRequest,
    ) -> Result<std::result::Result<TryResult, String>> {
        let settings = match t.settings {
            Some(s) => match s.validated() {
                Ok(s) => s,
                Err(e) => return Ok(Err(e.0)),
            },
            None => self.mod_settings()?,
        };
        let msg: String = t.message.chars().take(500).collect();
        let skipped = settings.preset != Preset::Off && !settings.applies_to(t.level);
        let rule = if skipped {
            None
        } else {
            // The test box has no emotes: everything typed counts as words.
            check(
                &settings,
                &moderation::Message {
                    text: &msg,
                    words_only: &msg,
                    emotes: 0,
                },
            )
        };
        Ok(Ok(TryResult {
            rule,
            skipped,
            steps: settings.steps,
        }))
    }
}

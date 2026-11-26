//! `!nuke`, as Fossabot runs it: every message in the scrollback that
//! matches a phrase or `/regex/` is deleted, or its sender timed out or
//! banned, and with `-r=` new matching messages get the same for a while
//! ("radiation"). Chat hears nothing; each action goes to the Moderation
//! log, where timeouts and bans can be undone.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sylva_core::bot::UserLevel;
use sylva_core::builtins::{Nuke, NukeAction, NukeMatch, NUKE_MAX};
use sylva_core::event::{Actor, StoredEvent};
use sylva_core::moderation::Rule;
use worker::js_sys::{self, Function, Reflect, RegExp};
use worker::wasm_bindgen::JsCast;
use worker::*;

use crate::bot::{badges, sender};
use crate::channel::ChannelDo;
use crate::community::Ask;
use crate::grants::{Permission, Token};
use crate::twitch_api::App;

const PURPOSE: &str = "moderation";
const LOG_KEEP: i64 = 500;

/// A nuke whose radiation still catches new messages.
#[derive(Serialize, Deserialize)]
struct Radiation {
    nuke: Nuke,
    until: i64,
}

enum Matcher {
    Phrase(String),
    Regex(RegExp),
}

impl Matcher {
    /// `None` when the regex does not compile.
    fn new(what: &NukeMatch) -> Option<Matcher> {
        Some(match what {
            NukeMatch::Phrase { text } => Matcher::Phrase(text.clone()),
            NukeMatch::Regex { pattern, flags } => {
                // Built through Reflect so a bad pattern is an error, not a crash.
                let ctor: Function = Reflect::get(&js_sys::global(), &"RegExp".into())
                    .ok()?
                    .dyn_into()
                    .ok()?;
                let args = js_sys::Array::of2(&pattern.as_str().into(), &flags.as_str().into());
                Matcher::Regex(Reflect::construct(&ctor, &args).ok()?.dyn_into().ok()?)
            }
        })
    }

    fn hits(&self, text: &str) -> bool {
        match self {
            Matcher::Phrase(p) => text.to_lowercase().contains(p.as_str()),
            Matcher::Regex(r) => r.test(text),
        }
    }
}

/// One chatter or message a nuke acts on.
struct Target {
    user_id: String,
    user: String,
    message_id: String,
    text: String,
}

impl ChannelDo {
    /// Delete, time out or ban one target, and log it.
    async fn nuke_one(
        &self,
        app: &App,
        broadcaster: &str,
        t: &Target,
        n: &Nuke,
        now: i64,
    ) -> Result<u16> {
        let reason = format!("Nuked: {}", n.what.label());
        let (status, v) = match n.action {
            NukeAction::Delete => {
                app.helix(
                    Method::Delete,
                    &format!(
                        "/moderation/chat?broadcaster_id={broadcaster}&moderator_id={broadcaster}&message_id={}",
                        sylva_core::auth::encode(&t.message_id)
                    ),
                    None,
                )
                .await?
            }
            NukeAction::Timeout { seconds } => {
                app.helix(
                    Method::Post,
                    &format!("/moderation/bans?broadcaster_id={broadcaster}&moderator_id={broadcaster}"),
                    Some(json!({ "data": { "user_id": t.user_id, "duration": seconds, "reason": reason } })),
                )
                .await?
            }
            NukeAction::Ban => {
                app.helix(
                    Method::Post,
                    &format!("/moderation/bans?broadcaster_id={broadcaster}&moderator_id={broadcaster}"),
                    Some(json!({ "data": { "user_id": t.user_id, "reason": reason } })),
                )
                .await?
            }
        };
        if status == 401 {
            self.forget_token(PURPOSE);
        }
        let ok = (200..300).contains(&status);
        let (action, seconds) = match n.action {
            NukeAction::Delete => ("delete", 0),
            NukeAction::Timeout { seconds } => ("timeout", seconds),
            NukeAction::Ban => ("ban", 0),
        };
        let detail = (!ok).then(|| {
            format!(
                "Twitch said no ({status}): {}",
                v["message"].as_str().unwrap_or("no reason given")
            )
        });
        let message: String = t.text.chars().take(500).collect();
        self.sql.exec(
            "INSERT INTO mod_log (at, user_id, user, rule, message, action, seconds, result, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            vec![
                now.into(),
                t.user_id.as_str().into(),
                t.user.as_str().into(),
                serde_json::to_value(Rule::Nuke)?
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                message.into(),
                action.into(),
                i64::from(seconds).into(),
                if ok { "done" } else { "failed" }.into(),
                detail.into(),
            ],
        )?;
        Ok(status)
    }

    fn trim_mod_log(&self) -> Result<()> {
        self.sql.exec(
            "DELETE FROM mod_log WHERE id <= (SELECT MAX(id) FROM mod_log) - ?",
            vec![LOG_KEEP.into()],
        )?;
        Ok(())
    }

    async fn mod_app(&self) -> Result<std::result::Result<App, String>> {
        Ok(match self.user_token(PURPOSE).await? {
            Token::Ok(t) => Ok(App::user(&self.env, &t)?),
            Token::No(Permission::Expired) => Err(
                "Twitch no longer accepts Sylva's permission to moderate. Allow it again on the Moderation page."
                    .into(),
            ),
            Token::No(_) => Err(
                "Sylva is not allowed to moderate yet. Allow moderation on the Moderation page."
                    .into(),
            ),
        })
    }

    /// Run a `!nuke`. Says nothing in chat when it worked, like Fossabot.
    pub(crate) async fn run_nuke(
        &self,
        n: Nuke,
        ask: &Ask<'_>,
        by: Option<&Actor>,
    ) -> Result<String> {
        let Some(m) = Matcher::new(&n.what) else {
            return Ok("That regex does not work. Check it and try again.".into());
        };
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok("Sylva has not heard from this channel yet.".into());
        };
        let bot_id = sender(&self.env, &broadcaster).id;
        let since = ask.now - i64::from(n.scrollback) * 1000;
        let rows = if n.scrollback == 0 {
            Vec::new()
        } else {
            self.recent_chat(since)?
        };
        let mut targets: Vec<Target> = Vec::new();
        let per_user = n.action != NukeAction::Delete;
        for r in &rows {
            let (Some(user_id), Some(message_id), Some(text)) =
                (r.user_id.as_ref(), r.message_id.as_ref(), r.text.as_deref())
            else {
                continue;
            };
            if *user_id == bot_id
                || by.is_some_and(|b| b.id == *user_id)
                || self.row_level(r) >= UserLevel::Moderator
                || text.trim_start().starts_with("!nuke")
                || !m.hits(text)
            {
                continue;
            }
            if per_user && targets.iter().any(|t| t.user_id == *user_id) {
                continue;
            }
            targets.push(Target {
                user_id: user_id.clone(),
                user: r.login.clone().unwrap_or_default(),
                message_id: message_id.clone(),
                text: text.to_string(),
            });
            if targets.len() >= NUKE_MAX {
                break;
            }
        }
        let doing = match n.action {
            NukeAction::Delete => "deleted".to_string(),
            NukeAction::Timeout { seconds } => {
                format!(
                    "timed out for {}",
                    sylva_core::moderation::duration_text(seconds)
                )
            }
            NukeAction::Ban => "banned".to_string(),
        };
        if ask.dry {
            let what = if per_user { "chatter" } else { "message" };
            let count = targets.len();
            return Ok(format!(
                "{count} {what}{} would be {doing}{}. The test chat sends nothing to Twitch.",
                if count == 1 { "" } else { "s" },
                if n.radiation > 0 {
                    format!(
                        ", and new matches for {}",
                        sylva_core::moderation::duration_text(n.radiation)
                    )
                } else {
                    String::new()
                }
            ));
        }
        let app = match self.mod_app().await? {
            Ok(a) => a,
            Err(words) => return Ok(words),
        };
        if n.radiation > 0 {
            let mut list: Vec<Radiation> = self
                .config("radiation")?
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_default();
            list.retain(|r| r.until > ask.now);
            list.push(Radiation {
                until: ask.now + i64::from(n.radiation) * 1000,
                nuke: n.clone(),
            });
            self.set_config("radiation", &serde_json::to_string(&list)?)?;
        }
        for t in &targets {
            // A refused token stops the rest; other refusals are logged.
            if self.nuke_one(&app, &broadcaster, t, &n, ask.now).await? == 401 {
                break;
            }
        }
        self.trim_mod_log()?;
        Ok(String::new())
    }

    /// Catch a new chat line under an active nuke's radiation. True when it
    /// was acted on.
    pub(crate) async fn run_radiation(&self, line: &StoredEvent) -> Result<bool> {
        let Some(raw) = self.config("radiation")? else {
            return Ok(false);
        };
        let now = Date::now().as_millis() as i64;
        let mut list: Vec<Radiation> = serde_json::from_str(&raw).unwrap_or_default();
        let before = list.len();
        list.retain(|r| r.until > now);
        if list.is_empty() {
            self.sql
                .exec("DELETE FROM config WHERE key = 'radiation'", None)?;
            return Ok(false);
        }
        if list.len() != before {
            self.set_config("radiation", &serde_json::to_string(&list)?)?;
        }
        let e = &line.event;
        let (Some(text), Some(actor), Some(broadcaster)) = (
            e.message.as_deref(),
            e.actor.as_ref(),
            self.broadcaster_id(),
        ) else {
            return Ok(false);
        };
        if actor.id == sender(&self.env, &broadcaster).id {
            return Ok(false);
        }
        let level = UserLevel::from_badges(
            badges(&e.raw).iter().map(String::as_str),
            actor.id == broadcaster,
        );
        if level >= UserLevel::Moderator {
            return Ok(false);
        }
        let Some(r) = list
            .iter()
            .find(|r| Matcher::new(&r.nuke.what).is_some_and(|m| m.hits(text)))
        else {
            return Ok(false);
        };
        let Ok(app) = self.mod_app().await? else {
            return Ok(false);
        };
        let t = Target {
            user_id: actor.id.clone(),
            user: actor.display_name.clone(),
            message_id: e.raw["message_id"].as_str().unwrap_or_default().to_string(),
            text: text.to_string(),
        };
        self.nuke_one(&app, &broadcaster, &t, &r.nuke, now).await?;
        self.trim_mod_log()?;
        Ok(true)
    }
}

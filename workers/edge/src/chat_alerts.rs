//! Chat alerts in the channel's Durable Object (see `sylva_core::chat_alerts`):
//! the settings, the dashboard view, and posting the lines when Twitch
//! events arrive. Lines are sent by the same account as the chat bot.

use serde::Serialize;
use sylva_core::chat_alerts::{lines_for, ChatAlertSettings, Facts, Group, GROUPS};
use sylva_core::Event;
use worker::*;

use crate::channel::ChannelDo;
use crate::grants::{Permission, Token};
use crate::twitch_api::App;

const PURPOSE: &str = "alerts";
/// Alerts that need the `alerts` grant, for the page's Allow notice.
const NEEDS_GRANT: &[&str] = &["charity", "ads", "hype", "predictions", "polls"];

/// `GET /chat-alerts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAlertsView {
    pub settings: ChatAlertSettings,
    pub groups: &'static [Group],
    /// Groups that need the extra Twitch permission.
    pub needs_grant: &'static [&'static str],
    pub permission: Permission,
    pub sender: crate::bot::Sender,
}

impl ChannelDo {
    pub(crate) fn chat_alert_settings(&self) -> Result<ChatAlertSettings> {
        Ok(match self.config("chat_alerts")? {
            Some(v) => serde_json::from_str::<ChatAlertSettings>(&v)
                .map(ChatAlertSettings::upgraded)
                .unwrap_or_default(),
            None => ChatAlertSettings::default(),
        })
    }

    pub(crate) async fn save_chat_alerts(&self, s: &ChatAlertSettings) -> Result<()> {
        self.set_config("chat_alerts", &serde_json::to_string(s)?)?;
        // Game and title alerts compare with what was there before, so learn
        // it now rather than staying quiet on the first change.
        let wants = |id: &str| s.alerts.get(id).is_some_and(|a| a.enabled);
        if (wants("game") || wants("title") || wants("live"))
            && self.config("stream_game")?.is_none()
        {
            if let Err(e) = self.learn_channel_info().await {
                console_warn!("Could not read the channel's game and title: {e}");
            }
        }
        Ok(())
    }

    pub(crate) async fn chat_alerts_view(&self) -> Result<ChatAlertsView> {
        let broadcaster = self.broadcaster_id().unwrap_or_default();
        Ok(ChatAlertsView {
            settings: self.chat_alert_settings()?,
            groups: GROUPS,
            needs_grant: NEEDS_GRANT,
            permission: match self.user_token(PURPOSE).await? {
                Token::Ok(_) => Permission::Ok,
                Token::No(p) => p,
            },
            sender: crate::bot::sender(&self.env, &broadcaster),
        })
    }

    /// Read the channel's current category and title from Twitch and keep them.
    async fn learn_channel_info(&self) -> Result<()> {
        let Some(id) = self.broadcaster_id() else {
            return Ok(());
        };
        let app = App::new(&self.env).await?;
        let (status, v) = app
            .helix(
                Method::Get,
                &format!("/channels?broadcaster_id={id}"),
                None,
            )
            .await?;
        if status != 200 {
            return Err(Error::RustError(format!("Twitch answered {status}")));
        }
        let c = &v["data"][0];
        if let Some(game) = c["game_name"].as_str() {
            self.set_config("stream_game", game)?;
        }
        if let Some(title) = c["title"].as_str() {
            self.set_config("stream_title", title)?;
        }
        Ok(())
    }

    /// Post the chat alerts an event calls for. Problems are logged, never
    /// raised: an event must be stored whatever happens to its chat line.
    pub(crate) async fn run_chat_alerts(&self, ev: &Event) {
        if let Err(e) = self.run_chat_alerts_inner(ev).await {
            console_error!("A chat alert could not be sent: {e}");
        }
    }

    async fn run_chat_alerts_inner(&self, ev: &Event) -> Result<()> {
        let settings = self.chat_alert_settings()?;
        let raw = &ev.raw;
        let t = ev.raw_type.as_str();
        if t == "stream.online" && settings.alerts.get("live").is_some_and(|a| a.enabled) {
            // The going live event does not name the game: ask Twitch.
            if let Err(e) = self.learn_channel_info().await {
                console_warn!("Could not read the channel's game: {e}");
            }
        }
        let train = raw["id"].as_str().unwrap_or("").to_string();
        let hype_level = match self.config("hype_level")? {
            Some(v) => v
                .split_once(' ')
                .filter(|(id, _)| *id == train)
                .and_then(|(_, l)| l.parse().ok()),
            None => None,
        };
        let facts = Facts {
            channel: self.channel_name()?,
            game: self.config("stream_game")?,
            title: self.config("stream_title")?,
            hype_level,
        };
        let lines = lines_for(&settings, ev, &facts);

        // Remember what the next event will be compared with.
        if t == "channel.update" {
            if let Some(g) = raw["category_name"].as_str() {
                self.set_config("stream_game", g)?;
            }
            if let Some(title) = raw["title"].as_str() {
                self.set_config("stream_title", title)?;
            }
        }
        if t.starts_with("channel.hype_train.") && !train.is_empty() {
            let level = raw["level"].as_i64().unwrap_or(1);
            if hype_level.is_none_or(|seen| level > seen) {
                self.set_config("hype_level", &format!("{train} {level}"))?;
            }
        }

        if lines.is_empty() {
            return Ok(());
        }
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(());
        };
        let from = crate::bot::sender(&self.env, &broadcaster);
        let now = Date::now().as_millis() as i64;
        for line in lines {
            self.say(&broadcaster, &from, &line.text, now).await?;
        }
        Ok(())
    }

    /// `channel.chat.notification` only feeds chat alerts: the same subs and
    /// gifts already reach the log through their own events. Twitch retries a
    /// delivery with the same id, so each id is handled once.
    pub(crate) async fn chat_notification(&self, ev: &Event) -> Result<bool> {
        let now = Date::now().as_millis() as i64;
        self.sql.exec(
            "DELETE FROM chat_alert_seen WHERE at < ?",
            vec![(now - 3_600_000).into()],
        )?;
        let seen = self
            .sql
            .exec(
                "SELECT id FROM chat_alert_seen WHERE id = ?",
                vec![ev.id.as_str().into()],
            )?
            .to_array::<serde_json::Value>()?;
        if !seen.is_empty() {
            return Ok(true);
        }
        self.sql.exec(
            "INSERT INTO chat_alert_seen (id, at) VALUES (?, ?)",
            vec![ev.id.as_str().into(), now.into()],
        )?;
        self.run_chat_alerts(ev).await;
        Ok(false)
    }
}

//! Tokens for the extra permissions a streamer gives one feature at a time
//! (`sylva_core::auth::GRANTS`), such as moderation. The channel finds its
//! owner's account, opens the sealed grant, refreshes it when it runs out and
//! saves the refreshed one back, sealed. Plain tokens live only in memory.

use serde::Serialize;
use sylva_core::auth::{can_moderate, has_grant, open, parse_key, seal};
use worker::*;

use crate::account::{Grant, Lookup};
use crate::channel::ChannelDo;
use crate::twitch_api;
use crate::util::random_bytes;

/// Whether Sylva has a feature's permission for this channel.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    /// Sylva has the scopes and a working token.
    Ok,
    /// The streamer has not allowed moderation yet.
    Missing,
    /// They had, but Twitch no longer accepts the token. Allowing again fixes it.
    Expired,
    /// Sylva_Bot moderates, and it is not a moderator in this chat yet.
    NotMod,
    /// Sylva_Bot has not given Sylva its moderation permission yet.
    BotMissing,
}

/// Where Sylva_Bot's own permission is kept, sealed like a streamer's grant.
pub(crate) const BOT_ACCOUNT: &str = "sylva-bot";
pub(crate) const BOT_PURPOSE: &str = "bot";
/// The cache name for whichever token moderates this channel.
const MOD_CACHE: &str = "moderation";

pub(crate) enum Token {
    Ok(String),
    No(Permission),
}

impl ChannelDo {
    fn grant_key(&self, purpose: &str) -> Option<Grant> {
        Some(Grant {
            purpose: purpose.into(),
            platform: "twitch".into(),
            platform_user_id: self.broadcaster_id()?,
            scopes: Vec::new(),
            access_token: String::new(),
            refresh_token: String::new(),
            expires_at: 0,
        })
    }

    async fn owner_account(&self) -> Result<Option<Stub>> {
        let Some(id) = self.broadcaster_id() else {
            return Ok(None);
        };
        let dir = self
            .env
            .durable_object("DIRECTORY")?
            .get_by_name("directory")?;
        let mut res = crate::auth::post(
            &dir,
            "/lookup",
            &Lookup {
                platform: "twitch".into(),
                platform_user_id: id,
            },
        )
        .await?;
        if res.status_code() != 200 {
            return Ok(None);
        }
        let v: serde_json::Value = res.json().await?;
        let Some(account) = v["accountId"].as_str() else {
            return Ok(None);
        };
        Ok(Some(crate::auth::account(&self.env, account)?))
    }

    /// The streamer's token for `purpose` (see `sylva_core::auth::GRANTS`),
    /// refreshed when needed.
    pub(crate) async fn user_token(&self, purpose: &str) -> Result<Token> {
        if let Some(t) = self.cached_token(purpose) {
            return Ok(Token::Ok(t));
        }
        let (Some(account), Some(key)) = (self.owner_account().await?, self.grant_key(purpose))
        else {
            return Ok(Token::No(Permission::Missing));
        };
        self.sealed_token(
            purpose,
            &account,
            key,
            |s| has_grant(purpose, s),
            Permission::Missing,
        )
        .await
    }

    /// Who moderates this chat: Sylva_Bot, or the streamer only when Sylva
    /// has no shared bot account at all.
    pub(crate) fn moderator_id(&self) -> String {
        let broadcaster = self.broadcaster_id().unwrap_or_default();
        crate::bot::sender(&self.env, &broadcaster).id
    }

    fn bot_moderates(&self) -> Option<String> {
        let broadcaster = self.broadcaster_id()?;
        let s = crate::bot::sender(&self.env, &broadcaster);
        (s.kind == "sylva").then_some(s.id)
    }

    /// The token moderation acts with: Sylva_Bot's own, so deletes, timeouts
    /// and bans show as the bot and never as the streamer.
    pub(crate) async fn mod_token(&self) -> Result<Token> {
        let Some(bot) = self.bot_moderates() else {
            return self.user_token(MOD_CACHE).await;
        };
        if let Some(t) = self.cached_token(MOD_CACHE) {
            return Ok(Token::Ok(t));
        }
        let account = crate::auth::account(&self.env, BOT_ACCOUNT)?;
        let key = Grant {
            purpose: BOT_PURPOSE.into(),
            platform: "twitch".into(),
            platform_user_id: bot,
            scopes: Vec::new(),
            access_token: String::new(),
            refresh_token: String::new(),
            expires_at: 0,
        };
        self.sealed_token(
            MOD_CACHE,
            &account,
            key,
            can_moderate,
            Permission::BotMissing,
        )
        .await
    }

    /// Whether moderation works here, for the dashboard. With Sylva_Bot that
    /// also means the bot is one of the channel's moderators.
    pub(crate) async fn mod_permission(&self) -> Result<Permission> {
        let token = match self.mod_token().await? {
            Token::Ok(t) => t,
            Token::No(p) => return Ok(p),
        };
        let (Some(bot), Some(broadcaster)) = (self.bot_moderates(), self.broadcaster_id()) else {
            return Ok(Permission::Ok);
        };
        // Reading the chatter list needs the bot to be a moderator here.
        let (status, _) = twitch_api::App::user(&self.env, &token)?
            .helix(
                Method::Get,
                &format!("/chat/chatters?broadcaster_id={broadcaster}&moderator_id={bot}&first=1"),
                None,
            )
            .await?;
        Ok(match status {
            403 => Permission::NotMod,
            401 => {
                self.forget_token(MOD_CACHE);
                Permission::BotMissing
            }
            _ => Permission::Ok,
        })
    }

    fn cached_token(&self, cache: &str) -> Option<String> {
        let now = Date::now().as_millis() as i64;
        self.tokens
            .borrow()
            .get(cache)
            .filter(|(_, expires)| *expires > now)
            .map(|(t, _)| t.clone())
    }

    /// Open a sealed grant from `account`, refreshing it with Twitch and
    /// saving it back when it ran out.
    async fn sealed_token(
        &self,
        cache: &str,
        account: &Stub,
        key: Grant,
        enough: impl Fn(&[String]) -> bool,
        missing: Permission,
    ) -> Result<Token> {
        let now = Date::now().as_millis() as i64;
        let mut res = crate::auth::post(account, "/grant", &key).await?;
        if res.status_code() != 200 {
            return Ok(Token::No(missing));
        }
        let grant: Grant = res.json().await?;
        if !enough(&grant.scopes) {
            return Ok(Token::No(missing));
        }
        let seal_key = parse_key(&self.env.secret("SYLVA_TOKEN_KEY")?.to_string())
            .ok_or_else(|| Error::RustError("SYLVA_TOKEN_KEY must be 64 hex characters".into()))?;
        // A minute of margin, so a call never starts with a token about to lapse.
        if grant.expires_at > now + 60_000 {
            if let Some(token) = open(&seal_key, &grant.access_token) {
                self.tokens.borrow_mut().insert(
                    cache.to_string(),
                    (token.clone(), grant.expires_at - 60_000),
                );
                return Ok(Token::Ok(token));
            }
        }
        let expired = if missing == Permission::BotMissing {
            Permission::BotMissing
        } else {
            Permission::Expired
        };
        let Some(refresh) = open(&seal_key, &grant.refresh_token) else {
            return Ok(Token::No(expired));
        };
        let Some(fresh) = twitch_api::refresh(&self.env, &refresh).await? else {
            return Ok(Token::No(expired));
        };
        let expires_at = now + fresh.expires_in * 1000;
        let refresh_token = if fresh.refresh_token.is_empty() {
            refresh
        } else {
            fresh.refresh_token
        };
        crate::auth::post(
            account,
            "/grant/save",
            &Grant {
                access_token: seal(&seal_key, random_bytes()?, &fresh.access_token),
                refresh_token: seal(&seal_key, random_bytes()?, &refresh_token),
                expires_at,
                scopes: grant.scopes,
                ..key
            },
        )
        .await?;
        self.tokens.borrow_mut().insert(
            cache.to_string(),
            (fresh.access_token.clone(), expires_at - 60_000),
        );
        Ok(Token::Ok(fresh.access_token))
    }

    /// Drop a cached token, such as after Twitch refused it.
    pub(crate) fn forget_token(&self, purpose: &str) {
        self.tokens.borrow_mut().remove(purpose);
    }
}

/// Why moderation cannot act, in words for chat and the dashboard.
pub(crate) fn mod_words(p: Permission) -> String {
    match p {
        Permission::Expired => "Twitch no longer accepts Sylva's permission to moderate. Allow it again on the Moderation page.",
        Permission::BotMissing => "Sylva_Bot is not set up to moderate yet.",
        Permission::NotMod => "Sylva_Bot is not a moderator here. Type /mod sylva_bot in chat.",
        _ => "Sylva is not allowed to moderate yet. Allow moderation on the Moderation page.",
    }
    .into()
}

/// Twitch's refusal of a moderation call, in words. A 403 means the bot is
/// not one of the channel's moderators.
pub(crate) fn mod_refusal(status: u16, v: &serde_json::Value) -> String {
    if status == 403 {
        return mod_words(Permission::NotMod);
    }
    format!(
        "Twitch said no: {}",
        v["message"].as_str().unwrap_or("no reason given")
    )
}

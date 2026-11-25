//! Tokens for the extra permissions a streamer gives one feature at a time
//! (`sylva_core::auth::GRANTS`), such as moderation. The channel finds its
//! owner's account, opens the sealed grant, refreshes it when it runs out and
//! saves the refreshed one back, sealed. Plain tokens live only in memory.

use serde::Serialize;
use sylva_core::auth::{has_grant, open, parse_key, seal};
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
}

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
        let now = Date::now().as_millis() as i64;
        if let Some((token, expires)) = self.tokens.borrow().get(purpose).cloned() {
            if expires > now {
                return Ok(Token::Ok(token));
            }
        }
        let (Some(account), Some(key)) = (self.owner_account().await?, self.grant_key(purpose))
        else {
            return Ok(Token::No(Permission::Missing));
        };
        let mut res = crate::auth::post(&account, "/grant", &key).await?;
        if res.status_code() != 200 {
            return Ok(Token::No(Permission::Missing));
        }
        let grant: Grant = res.json().await?;
        if !has_grant(purpose, &grant.scopes) {
            return Ok(Token::No(Permission::Missing));
        }
        let seal_key = parse_key(&self.env.secret("SYLVA_TOKEN_KEY")?.to_string())
            .ok_or_else(|| Error::RustError("SYLVA_TOKEN_KEY must be 64 hex characters".into()))?;
        // A minute of margin, so a call never starts with a token about to lapse.
        if grant.expires_at > now + 60_000 {
            if let Some(token) = open(&seal_key, &grant.access_token) {
                self.tokens.borrow_mut().insert(
                    purpose.to_string(),
                    (token.clone(), grant.expires_at - 60_000),
                );
                return Ok(Token::Ok(token));
            }
        }
        let Some(refresh) = open(&seal_key, &grant.refresh_token) else {
            return Ok(Token::No(Permission::Expired));
        };
        let Some(fresh) = twitch_api::refresh(&self.env, &refresh).await? else {
            return Ok(Token::No(Permission::Expired));
        };
        let expires_at = now + fresh.expires_in * 1000;
        let refresh_token = if fresh.refresh_token.is_empty() {
            refresh
        } else {
            fresh.refresh_token
        };
        crate::auth::post(
            &account,
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
            purpose.to_string(),
            (fresh.access_token.clone(), expires_at - 60_000),
        );
        Ok(Token::Ok(fresh.access_token))
    }

    /// Drop a cached token, such as after Twitch refused it.
    pub(crate) fn forget_token(&self, purpose: &str) {
        self.tokens.borrow_mut().remove(purpose);
    }
}

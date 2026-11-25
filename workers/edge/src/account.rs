//! Sylva accounts.
//!
//! * `AccountDo`, one per account (named `account:<id>`), holds the linked
//!   platform identities with their tokens encrypted, the web sessions (only
//!   a hash of each session secret) and the channels the account manages.
//! * `DirectoryDo`, a single object named `directory`, maps a platform
//!   identity such as Twitch user 12826 to its account id. It is only asked
//!   at sign in.
//!
//! Neither object is reachable from outside: only the Worker calls them, with
//! the internal routes below. Accounts move to Postgres when Sylva needs to
//! query across accounts; until then a Durable Object per account needs no
//! extra service.

use serde::{Deserialize, Serialize};
use worker::*;

const ACCOUNT_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
    platform         TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    login            TEXT NOT NULL,
    display_name     TEXT NOT NULL,
    avatar           TEXT NOT NULL,
    scopes           TEXT NOT NULL,
    access_token     TEXT NOT NULL,
    refresh_token    TEXT NOT NULL,
    expires_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (platform, platform_user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
    hash       TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
    channel  TEXT PRIMARY KEY,
    role     TEXT NOT NULL,
    added_at INTEGER NOT NULL
);
";

const DIRECTORY_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS identities (
    platform         TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    account_id       TEXT NOT NULL,
    PRIMARY KEY (platform, platform_user_id)
);
";

fn apply_schema(sql: &SqlStorage, schema: &str) {
    for stmt in schema.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        sql.exec(stmt, None).expect("schema");
    }
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// A platform identity as stored. Tokens arrive already encrypted.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRecord {
    pub platform: String,
    pub platform_user_id: String,
    pub login: String,
    pub display_name: String,
    pub avatar: String,
    pub scopes: Vec<String>,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRequest {
    pub account_id: String,
    pub identity: IdentityRecord,
    /// The channel this identity owns, such as `twitch:12826`.
    pub channel: String,
}

/// The public view of an identity: never the tokens.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub platform: String,
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub avatar: String,
    pub scopes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRole {
    pub key: String,
    pub role: String,
}

/// `GET /v1/me`: who is signed in and which channels they manage.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub account_id: String,
    pub identities: Vec<Identity>,
    pub channels: Vec<ChannelRole>,
}

impl Me {
    pub fn owns(&self, channel: &str) -> bool {
        self.channels
            .iter()
            .any(|c| c.key == channel && c.role == "owner")
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub hash: String,
    #[serde(default)]
    pub expires_at: i64,
}

#[derive(Deserialize)]
struct IdentityRow {
    platform: String,
    platform_user_id: String,
    login: String,
    display_name: String,
    avatar: String,
    scopes: String,
}

#[derive(Deserialize)]
struct ChannelRow {
    channel: String,
    role: String,
}

#[derive(Deserialize)]
struct TextRow {
    value: String,
}

#[durable_object]
pub struct AccountDo {
    sql: SqlStorage,
}

impl DurableObject for AccountDo {
    fn new(state: State, _env: Env) -> Self {
        let sql = state.storage().sql();
        apply_schema(&sql, ACCOUNT_SCHEMA);
        Self { sql }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/link") => {
                let link: LinkRequest = req.json().await?;
                self.link(link)?;
                Response::from_json(&self.me()?)
            }
            (Method::Post, "/sessions") => {
                let s: SessionRequest = req.json().await?;
                let now = now_ms();
                self.sql.exec(
                    "DELETE FROM sessions WHERE expires_at < ?",
                    vec![now.into()],
                )?;
                self.sql.exec(
                    "INSERT INTO sessions (hash, created_at, expires_at) VALUES (?, ?, ?)",
                    vec![s.hash.into(), now.into(), s.expires_at.into()],
                )?;
                Response::empty().map(|r| r.with_status(204))
            }
            (Method::Post, "/sessions/check") => {
                let s: SessionRequest = req.json().await?;
                let live = self
                    .sql
                    .exec(
                        "SELECT hash AS value FROM sessions WHERE hash = ? AND expires_at > ?",
                        vec![s.hash.into(), now_ms().into()],
                    )?
                    .to_array::<TextRow>()?;
                if live.is_empty() {
                    return Response::error("No session", 401);
                }
                Response::from_json(&self.me()?)
            }
            (Method::Post, "/sessions/delete") => {
                let s: SessionRequest = req.json().await?;
                self.sql
                    .exec("DELETE FROM sessions WHERE hash = ?", vec![s.hash.into()])?;
                Response::empty().map(|r| r.with_status(204))
            }
            _ => Response::error("Not found", 404),
        }
    }
}

impl AccountDo {
    fn link(&self, link: LinkRequest) -> Result<()> {
        let now = now_ms();
        self.sql.exec(
            "INSERT INTO meta (key, value) VALUES ('id', ?) ON CONFLICT(key) DO NOTHING",
            vec![link.account_id.into()],
        )?;
        self.sql.exec(
            "INSERT INTO meta (key, value) VALUES ('created_at', ?) ON CONFLICT(key) DO NOTHING",
            vec![now.to_string().into()],
        )?;
        let i = link.identity;
        self.sql.exec(
            "INSERT INTO identities (platform, platform_user_id, login, display_name, avatar, scopes,
                                     access_token, refresh_token, expires_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(platform, platform_user_id) DO UPDATE SET
                login = excluded.login, display_name = excluded.display_name,
                avatar = excluded.avatar, scopes = excluded.scopes,
                access_token = excluded.access_token, refresh_token = excluded.refresh_token,
                expires_at = excluded.expires_at, updated_at = excluded.updated_at",
            vec![
                i.platform.into(),
                i.platform_user_id.into(),
                i.login.into(),
                i.display_name.into(),
                i.avatar.into(),
                i.scopes.join(" ").into(),
                i.access_token.into(),
                i.refresh_token.into(),
                i.expires_at.into(),
                now.into(),
            ],
        )?;
        self.sql.exec(
            "INSERT INTO channels (channel, role, added_at) VALUES (?, 'owner', ?)
             ON CONFLICT(channel) DO UPDATE SET role = 'owner'",
            vec![link.channel.into(), now.into()],
        )?;
        Ok(())
    }

    fn me(&self) -> Result<Me> {
        let account_id = self
            .sql
            .exec("SELECT value FROM meta WHERE key = 'id'", None)?
            .to_array::<TextRow>()?
            .into_iter()
            .next()
            .map(|r| r.value)
            .unwrap_or_default();
        let identities = self
            .sql
            .exec(
                "SELECT platform, platform_user_id, login, display_name, avatar, scopes
                 FROM identities ORDER BY updated_at DESC",
                None,
            )?
            .to_array::<IdentityRow>()?
            .into_iter()
            .map(|r| Identity {
                platform: r.platform,
                id: r.platform_user_id,
                login: r.login,
                display_name: r.display_name,
                avatar: r.avatar,
                scopes: r.scopes.split_whitespace().map(String::from).collect(),
            })
            .collect();
        let channels = self
            .sql
            .exec("SELECT channel, role FROM channels ORDER BY added_at", None)?
            .to_array::<ChannelRow>()?
            .into_iter()
            .map(|r| ChannelRole {
                key: r.channel,
                role: r.role,
            })
            .collect();
        Ok(Me {
            account_id,
            identities,
            channels,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    pub platform: String,
    pub platform_user_id: String,
    /// Used as the account id when this identity has never signed in.
    pub new_account_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub account_id: String,
    pub created: bool,
}

#[durable_object]
pub struct DirectoryDo {
    sql: SqlStorage,
}

impl DurableObject for DirectoryDo {
    fn new(state: State, _env: Env) -> Self {
        let sql = state.storage().sql();
        apply_schema(&sql, DIRECTORY_SCHEMA);
        Self { sql }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        if req.method() != Method::Post || req.path() != "/resolve" {
            return Response::error("Not found", 404);
        }
        let r: ResolveRequest = req.json().await?;
        // Both statements run with no await in between, so two sign ins at
        // once cannot create two accounts for one identity.
        self.sql.exec(
            "INSERT INTO identities (platform, platform_user_id, account_id) VALUES (?, ?, ?)
             ON CONFLICT(platform, platform_user_id) DO NOTHING",
            vec![
                r.platform.clone().into(),
                r.platform_user_id.clone().into(),
                r.new_account_id.clone().into(),
            ],
        )?;
        let account_id = self
            .sql
            .exec(
                "SELECT account_id AS value FROM identities WHERE platform = ? AND platform_user_id = ?",
                vec![r.platform.into(), r.platform_user_id.into()],
            )?
            .one::<TextRow>()?
            .value;
        Response::from_json(&ResolveResult {
            created: account_id == r.new_account_id,
            account_id,
        })
    }
}

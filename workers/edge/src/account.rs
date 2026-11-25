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
use sylva_core::apps::AppToken;
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
CREATE TABLE IF NOT EXISTS api_tokens (
    hash         TEXT PRIMARY KEY,
    id           TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
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
CREATE TABLE IF NOT EXISTS devices (
    device_hash  TEXT PRIMARY KEY,
    user_code    TEXT NOT NULL UNIQUE,
    app_name     TEXT NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_poll_at INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'pending',
    account_id   TEXT,
    sealed_token TEXT
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

#[derive(Serialize, Deserialize)]
pub struct TokenCreate {
    pub hash: String,
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize)]
pub struct TokenDelete {
    pub id: String,
}

/// What an account held that the Worker still has to clean up elsewhere.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Erased {
    pub sealed_tokens: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forget {
    pub account_id: String,
}

#[derive(Deserialize)]
struct TokenRow {
    id: String,
    name: String,
    created_at: f64,
    last_used_at: Option<f64>,
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
            (Method::Post, "/tokens") => {
                let t: TokenCreate = req.json().await?;
                self.sql.exec(
                    "INSERT INTO api_tokens (hash, id, name, created_at) VALUES (?, ?, ?, ?)",
                    vec![t.hash.into(), t.id.into(), t.name.into(), now_ms().into()],
                )?;
                Response::empty().map(|r| r.with_status(204))
            }
            (Method::Post, "/tokens/check") => {
                let s: SessionRequest = req.json().await?;
                let now = now_ms();
                let found = self
                    .sql
                    .exec(
                        "SELECT id AS value FROM api_tokens WHERE hash = ?",
                        vec![s.hash.clone().into()],
                    )?
                    .to_array::<TextRow>()?;
                if found.is_empty() {
                    return Response::error("No token", 401);
                }
                // Note when it was last used, at most once a minute.
                self.sql.exec(
                    "UPDATE api_tokens SET last_used_at = ?
                     WHERE hash = ? AND COALESCE(last_used_at, 0) < ?",
                    vec![now.into(), s.hash.into(), (now - 60_000).into()],
                )?;
                Response::from_json(&self.me()?)
            }
            (Method::Get, "/tokens") => {
                let rows = self
                    .sql
                    .exec(
                        "SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC",
                        None,
                    )?
                    .to_array::<TokenRow>()?;
                let list: Vec<AppToken> = rows
                    .into_iter()
                    .map(|r| AppToken {
                        id: r.id,
                        name: r.name,
                        created_at: r.created_at as i64,
                        last_used_at: r.last_used_at.map(|v| v as i64),
                    })
                    .collect();
                Response::from_json(&list)
            }
            (Method::Post, "/tokens/delete") => {
                let t: TokenDelete = req.json().await?;
                self.sql
                    .exec("DELETE FROM api_tokens WHERE id = ?", vec![t.id.into()])?;
                Response::empty().map(|r| r.with_status(204))
            }
            (Method::Post, "/erase") => {
                // Hand back the sealed Twitch tokens so the Worker can revoke
                // them, then forget everything.
                let tokens: Vec<String> = self
                    .sql
                    .exec("SELECT access_token AS value FROM identities", None)?
                    .to_array::<TextRow>()?
                    .into_iter()
                    .map(|r| r.value)
                    .collect();
                for table in ["identities", "sessions", "api_tokens", "channels", "meta"] {
                    self.sql.exec(&format!("DELETE FROM {table}"), None)?;
                }
                Response::from_json(&Erased {
                    sealed_tokens: tokens,
                })
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
        if req.method() != Method::Post {
            return Response::error("Not found", 404);
        }
        match req.path().as_str() {
            "/resolve" => self.resolve(req.json().await?),
            "/device/start" => self.device_start(req.json().await?),
            "/device/lookup" => self.device_lookup(req.json().await?),
            "/device/decide" => self.device_decide(req.json().await?),
            "/device/poll" => self.device_poll(req.json().await?),
            "/forget" => {
                // A deleted account: its identities can sign up afresh, and
                // its pending app approvals are dropped.
                let f: Forget = req.json().await?;
                self.sql.exec(
                    "DELETE FROM identities WHERE account_id = ?",
                    vec![f.account_id.clone().into()],
                )?;
                self.sql.exec(
                    "DELETE FROM devices WHERE account_id = ?",
                    vec![f.account_id.into()],
                )?;
                Response::empty().map(|r| r.with_status(204))
            }
            _ => Response::error("Not found", 404),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub device_hash: String,
    pub user_code: String,
    pub app_name: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLookup {
    pub user_code: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePending {
    pub app_name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDecide {
    pub user_code: String,
    pub approve: bool,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub sealed_token: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePoll {
    pub device_hash: String,
}

/// `status` is `pending`, `slow_down`, `denied`, `expired` or `approved`
/// (with the account and the sealed token, handed out once).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollResult {
    pub status: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub sealed_token: Option<String>,
}

#[derive(Deserialize)]
struct DeviceRow {
    app_name: String,
    expires_at: f64,
    last_poll_at: f64,
    status: String,
    account_id: Option<String>,
    sealed_token: Option<String>,
}

impl DirectoryDo {
    fn device_start(&self, d: DeviceStart) -> Result<Response> {
        let now = now_ms();
        // Codes nobody finished are useless after they expire.
        self.sql
            .exec("DELETE FROM devices WHERE expires_at < ?", vec![now.into()])?;
        let taken = self
            .sql
            .exec(
                "SELECT user_code AS value FROM devices WHERE user_code = ?",
                vec![d.user_code.clone().into()],
            )?
            .to_array::<TextRow>()?;
        if !taken.is_empty() {
            return Response::error("That code is in use", 409);
        }
        self.sql.exec(
            "INSERT INTO devices (device_hash, user_code, app_name, expires_at) VALUES (?, ?, ?, ?)",
            vec![
                d.device_hash.into(),
                d.user_code.into(),
                d.app_name.into(),
                d.expires_at.into(),
            ],
        )?;
        Response::empty().map(|r| r.with_status(204))
    }

    fn pending(&self, user_code: &str) -> Result<Option<DeviceRow>> {
        let rows = self
            .sql
            .exec(
                "SELECT app_name, expires_at, last_poll_at, status, account_id, sealed_token
                 FROM devices WHERE user_code = ?",
                vec![user_code.into()],
            )?
            .to_array::<DeviceRow>()?;
        Ok(rows
            .into_iter()
            .next()
            .filter(|r| r.status == "pending" && (r.expires_at as i64) > now_ms()))
    }

    fn device_lookup(&self, d: DeviceLookup) -> Result<Response> {
        match self.pending(&d.user_code)? {
            Some(r) => Response::from_json(&DevicePending {
                app_name: r.app_name,
            }),
            None => Response::error("That code has expired or was already used", 404),
        }
    }

    fn device_decide(&self, d: DeviceDecide) -> Result<Response> {
        if self.pending(&d.user_code)?.is_none() {
            return Response::error("That code has expired or was already used", 404);
        }
        if d.approve {
            self.sql.exec(
                "UPDATE devices SET status = 'approved', account_id = ?, sealed_token = ?
                 WHERE user_code = ?",
                vec![
                    d.account_id.unwrap_or_default().into(),
                    d.sealed_token.unwrap_or_default().into(),
                    d.user_code.into(),
                ],
            )?;
        } else {
            self.sql.exec(
                "UPDATE devices SET status = 'denied' WHERE user_code = ?",
                vec![d.user_code.into()],
            )?;
        }
        Response::empty().map(|r| r.with_status(204))
    }

    fn device_poll(&self, d: DevicePoll) -> Result<Response> {
        let now = now_ms();
        let rows = self
            .sql
            .exec(
                "SELECT app_name, expires_at, last_poll_at, status, account_id, sealed_token
                 FROM devices WHERE device_hash = ?",
                vec![d.device_hash.clone().into()],
            )?
            .to_array::<DeviceRow>()?;
        let result = |status: &str| DevicePollResult {
            status: status.into(),
            account_id: None,
            sealed_token: None,
        };
        let Some(row) = rows.into_iter().next() else {
            return Response::from_json(&result("expired"));
        };
        let gone = |s: &Self| {
            s.sql.exec(
                "DELETE FROM devices WHERE device_hash = ?",
                vec![d.device_hash.clone().into()],
            )
        };
        match row.status.as_str() {
            "approved" => {
                // The token is handed out once, then forgotten.
                gone(self)?;
                Response::from_json(&DevicePollResult {
                    status: "approved".into(),
                    account_id: row.account_id,
                    sealed_token: row.sealed_token,
                })
            }
            "denied" => {
                gone(self)?;
                Response::from_json(&result("denied"))
            }
            _ if (row.expires_at as i64) <= now => {
                gone(self)?;
                Response::from_json(&result("expired"))
            }
            _ => {
                let too_soon =
                    now - (row.last_poll_at as i64) < (sylva_core::apps::POLL_SECS - 1) * 1000;
                self.sql.exec(
                    "UPDATE devices SET last_poll_at = ? WHERE device_hash = ?",
                    vec![now.into(), d.device_hash.into()],
                )?;
                Response::from_json(&result(if too_soon { "slow_down" } else { "pending" }))
            }
        }
    }

    fn resolve(&self, r: ResolveRequest) -> Result<Response> {
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

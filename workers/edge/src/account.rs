//! Sylva accounts.
//!
//! * `AccountDo`, one per account (named `account:<id>`), holds the linked
//!   platform identities with their tokens encrypted, the web sessions (only
//!   a hash of each session secret) and the channels the account manages.
//! * `DirectoryDo`, a single object named `directory`, maps a platform
//!   identity such as Twitch user 12826 to its account id, and holds each
//!   channel's team (see `sylva_core::team`). It is asked at sign in and when
//!   an owner changes their team, never on ordinary requests: a teammate's
//!   roles are copied into their own `AccountDo` as memberships.
//!
//! Neither object is reachable from outside: only the Worker calls them, with
//! the internal routes below. Accounts move to Postgres when Sylva needs to
//! query across accounts; until then a Durable Object per account needs no
//! extra service.

use serde::{Deserialize, Serialize};
use sylva_core::apps::AppToken;
use sylva_core::team::Role;
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
CREATE TABLE IF NOT EXISTS memberships (
    channel  TEXT PRIMARY KEY,
    role     TEXT NOT NULL,
    name     TEXT NOT NULL,
    login    TEXT NOT NULL,
    avatar   TEXT NOT NULL,
    added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
    purpose          TEXT NOT NULL,
    platform         TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    scopes           TEXT NOT NULL,
    access_token     TEXT NOT NULL,
    refresh_token    TEXT NOT NULL,
    expires_at       INTEGER NOT NULL,
    PRIMARY KEY (purpose, platform, platform_user_id)
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
CREATE TABLE IF NOT EXISTS team (
    channel          TEXT NOT NULL,
    platform         TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    login            TEXT NOT NULL,
    name             TEXT NOT NULL,
    avatar           TEXT NOT NULL,
    role             TEXT NOT NULL,
    added_at         INTEGER NOT NULL,
    channel_name     TEXT NOT NULL,
    channel_login    TEXT NOT NULL,
    channel_avatar   TEXT NOT NULL,
    PRIMARY KEY (channel, platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS team_member ON team (platform, platform_user_id);
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

/// A channel the account can open, with its role there and how to show it.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRole {
    pub key: String,
    pub role: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub login: String,
    #[serde(default)]
    pub avatar: String,
}

/// A channel someone else owns that this account helps run.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub channel: String,
    pub role: String,
    pub name: String,
    pub login: String,
    pub avatar: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelOnly {
    pub channel: String,
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
    /// This account's role on `channel`, if it has one.
    pub fn role(&self, channel: &str) -> Option<Role> {
        self.channels
            .iter()
            .find(|c| c.key == channel)
            .and_then(|c| Role::parse(&c.role))
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

/// Tokens kept for one purpose, such as `moderation`, separate from the sign
/// in tokens. A later sign in that asks for fewer scopes replaces the sign in
/// tokens but leaves these alone, so moderation keeps working. Tokens are
/// sealed with `SYLVA_TOKEN_KEY`.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub purpose: String,
    pub platform: String,
    pub platform_user_id: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_at: i64,
}

#[derive(Deserialize)]
struct GrantRow {
    scopes: String,
    access_token: String,
    refresh_token: String,
    expires_at: f64,
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
    /// The channels the account owned: their teams go too.
    #[serde(default)]
    pub channels: Vec<String>,
}

/// A teammate's account that lost access to a channel.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dropped {
    pub account_id: String,
    pub channel: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forgotten {
    pub dropped: Vec<Dropped>,
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
struct MembershipRow {
    channel: String,
    role: String,
    name: String,
    login: String,
    avatar: String,
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
            (Method::Post, "/grant") => {
                let g: Grant = req.json().await?;
                let row = self
                    .sql
                    .exec(
                        "SELECT scopes, access_token, refresh_token, expires_at FROM grants
                         WHERE purpose = ? AND platform = ? AND platform_user_id = ?",
                        vec![
                            g.purpose.clone().into(),
                            g.platform.clone().into(),
                            g.platform_user_id.clone().into(),
                        ],
                    )?
                    .to_array::<GrantRow>()?
                    .into_iter()
                    .next();
                match row {
                    Some(r) => Response::from_json(&Grant {
                        scopes: r.scopes.split_whitespace().map(String::from).collect(),
                        access_token: r.access_token,
                        refresh_token: r.refresh_token,
                        expires_at: r.expires_at as i64,
                        ..g
                    }),
                    None => Response::error("No grant", 404),
                }
            }
            (Method::Post, "/grant/save") => {
                let g: Grant = req.json().await?;
                self.save_grant(&g)?;
                Response::empty().map(|r| r.with_status(204))
            }
            (Method::Post, "/grant/delete") => {
                let g: Grant = req.json().await?;
                self.sql.exec(
                    "DELETE FROM grants WHERE purpose = ? AND platform = ? AND platform_user_id = ?",
                    vec![
                        g.purpose.into(),
                        g.platform.into(),
                        g.platform_user_id.into(),
                    ],
                )?;
                Response::empty().map(|r| r.with_status(204))
            }
            (Method::Post, "/erase") => {
                // Hand back the sealed Twitch tokens so the Worker can revoke
                // them, then forget everything.
                let tokens: Vec<String> = self
                    .sql
                    .exec(
                        "SELECT access_token AS value FROM identities
                         UNION SELECT access_token AS value FROM grants",
                        None,
                    )?
                    .to_array::<TextRow>()?
                    .into_iter()
                    .map(|r| r.value)
                    .collect();
                for table in [
                    "identities",
                    "grants",
                    "sessions",
                    "api_tokens",
                    "channels",
                    "memberships",
                    "meta",
                ] {
                    self.sql.exec(&format!("DELETE FROM {table}"), None)?;
                }
                Response::from_json(&Erased {
                    sealed_tokens: tokens,
                })
            }
            (Method::Post, "/memberships/put") => {
                let m: Membership = req.json().await?;
                self.put_membership(&m)?;
                Response::empty().map(|r| r.with_status(204))
            }
            (Method::Post, "/memberships/remove") => {
                let c: ChannelOnly = req.json().await?;
                self.sql.exec(
                    "DELETE FROM memberships WHERE channel = ?",
                    vec![c.channel.into()],
                )?;
                Response::empty().map(|r| r.with_status(204))
            }
            (Method::Post, "/memberships/sync") => {
                // At sign in: the directory's list is the truth.
                let list: Vec<Membership> = req.json().await?;
                self.sql.exec("DELETE FROM memberships", None)?;
                for m in &list {
                    self.put_membership(m)?;
                }
                Response::empty().map(|r| r.with_status(204))
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
    fn put_membership(&self, m: &Membership) -> Result<()> {
        // Never over an owned channel, and never as owner.
        if Role::parse(&m.role).is_none_or(|r| r == Role::Owner) {
            return Ok(());
        }
        self.sql.exec(
            "INSERT INTO memberships (channel, role, name, login, avatar, added_at)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM channels WHERE channel = ?)
             ON CONFLICT(channel) DO UPDATE SET role = excluded.role, name = excluded.name,
                login = excluded.login, avatar = excluded.avatar",
            vec![
                m.channel.clone().into(),
                m.role.clone().into(),
                m.name.clone().into(),
                m.login.clone().into(),
                m.avatar.clone().into(),
                now_ms().into(),
                m.channel.clone().into(),
            ],
        )?;
        Ok(())
    }

    fn save_grant(&self, g: &Grant) -> Result<()> {
        self.sql.exec(
            "INSERT INTO grants (purpose, platform, platform_user_id, scopes, access_token,
                                 refresh_token, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(purpose, platform, platform_user_id) DO UPDATE SET
                scopes = excluded.scopes, access_token = excluded.access_token,
                refresh_token = excluded.refresh_token, expires_at = excluded.expires_at",
            vec![
                g.purpose.clone().into(),
                g.platform.clone().into(),
                g.platform_user_id.clone().into(),
                g.scopes.join(" ").into(),
                g.access_token.clone().into(),
                g.refresh_token.clone().into(),
                g.expires_at.into(),
            ],
        )?;
        Ok(())
    }

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
        for (purpose, _) in sylva_core::auth::GRANTS {
            if !sylva_core::auth::has_grant(purpose, &i.scopes) {
                continue;
            }
            self.save_grant(&Grant {
                purpose: (*purpose).into(),
                platform: i.platform.clone(),
                platform_user_id: i.platform_user_id.clone(),
                scopes: i.scopes.clone(),
                access_token: i.access_token.clone(),
                refresh_token: i.refresh_token.clone(),
                expires_at: i.expires_at,
            })?;
        }
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
        let identities: Vec<Identity> = self
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
        let mut channels: Vec<ChannelRole> = self
            .sql
            .exec("SELECT channel, role FROM channels ORDER BY added_at", None)?
            .to_array::<ChannelRow>()?
            .into_iter()
            .map(|r| {
                // An owned channel is shown as the identity it belongs to.
                let own = identities
                    .iter()
                    .find(|i| r.channel == format!("{}:{}", i.platform, i.id));
                ChannelRole {
                    name: own.map(|i| i.display_name.clone()).unwrap_or_default(),
                    login: own.map(|i| i.login.clone()).unwrap_or_default(),
                    avatar: own.map(|i| i.avatar.clone()).unwrap_or_default(),
                    key: r.channel,
                    role: r.role,
                }
            })
            .collect();
        let shared = self
            .sql
            .exec(
                "SELECT channel, role, name, login, avatar FROM memberships
                 WHERE channel NOT IN (SELECT channel FROM channels)
                 ORDER BY added_at",
                None,
            )?
            .to_array::<MembershipRow>()?;
        channels.extend(shared.into_iter().map(|r| ChannelRole {
            key: r.channel,
            role: r.role,
            name: r.name,
            login: r.login,
            avatar: r.avatar,
        }));
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

/// Which account holds a platform identity, without making one.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub platform: String,
    pub platform_user_id: String,
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
            "/lookup" => {
                let r: Lookup = req.json().await?;
                let found = self
                    .sql
                    .exec(
                        "SELECT account_id AS value FROM identities
                         WHERE platform = ? AND platform_user_id = ?",
                        vec![r.platform.into(), r.platform_user_id.into()],
                    )?
                    .to_array::<TextRow>()?
                    .into_iter()
                    .next();
                match found {
                    Some(row) => {
                        Response::from_json(&serde_json::json!({ "accountId": row.value }))
                    }
                    None => Response::error("No account", 404),
                }
            }
            "/device/start" => self.device_start(req.json().await?),
            "/device/lookup" => self.device_lookup(req.json().await?),
            "/device/decide" => self.device_decide(req.json().await?),
            "/device/poll" => self.device_poll(req.json().await?),
            "/forget" => self.forget(req.json().await?),
            "/team/list" => {
                let c: ChannelOnly = req.json().await?;
                Response::from_json(&self.team_list(&c.channel)?)
            }
            "/team/put" => self.team_put(req.json().await?),
            "/team/remove" => self.team_remove(req.json().await?),
            "/team/sign-in" => self.team_sign_in(req.json().await?),
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

/// One teammate, as the owner sees them.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub id: String,
    pub login: String,
    pub name: String,
    pub avatar: String,
    pub role: String,
    pub added_at: i64,
    /// They have signed in to Sylva, so the channel shows for them.
    pub joined: bool,
}

/// A Twitch user as Helix describes them.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub login: String,
    pub name: String,
    pub avatar: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPut {
    pub channel: String,
    pub owner: Person,
    pub member: Person,
    pub role: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRemove {
    pub channel: String,
    pub id: String,
}

/// The teammate's account, if they have one, to update their memberships.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamChange {
    pub account_id: Option<String>,
    pub membership: Membership,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSignIn {
    pub person: Person,
    /// The channel this person owns.
    pub channel: String,
}

#[derive(Deserialize)]
struct TeamRow {
    platform_user_id: String,
    login: String,
    name: String,
    avatar: String,
    role: String,
    added_at: f64,
    joined: f64,
}

#[derive(Deserialize)]
struct MemberOfRow {
    channel: String,
    role: String,
    channel_name: String,
    channel_login: String,
    channel_avatar: String,
}

#[derive(Deserialize)]
struct DroppedRow {
    account_id: String,
    channel: String,
}

impl DirectoryDo {
    fn account_of(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .sql
            .exec(
                "SELECT account_id AS value FROM identities
                 WHERE platform = 'twitch' AND platform_user_id = ?",
                vec![id.into()],
            )?
            .to_array::<TextRow>()?
            .into_iter()
            .next()
            .map(|r| r.value))
    }

    fn team_list(&self, channel: &str) -> Result<Vec<TeamMember>> {
        Ok(self
            .sql
            .exec(
                "SELECT t.platform_user_id, t.login, t.name, t.avatar, t.role, t.added_at,
                        CASE WHEN i.account_id IS NULL THEN 0 ELSE 1 END AS joined
                 FROM team t LEFT JOIN identities i
                   ON i.platform = t.platform AND i.platform_user_id = t.platform_user_id
                 WHERE t.channel = ? ORDER BY t.added_at",
                vec![channel.into()],
            )?
            .to_array::<TeamRow>()?
            .into_iter()
            .map(|r| TeamMember {
                id: r.platform_user_id,
                login: r.login,
                name: r.name,
                avatar: r.avatar,
                role: r.role,
                added_at: r.added_at as i64,
                joined: r.joined > 0.0,
            })
            .collect())
    }

    /// Add a teammate or change their role.
    fn team_put(&self, t: TeamPut) -> Result<Response> {
        if Role::parse(&t.role).is_none_or(|r| r == Role::Owner) {
            return Response::error("Pick Editor, Moderator or Viewer", 400);
        }
        let known = self.sql.exec(
            "SELECT login AS value FROM team WHERE channel = ? AND platform = 'twitch'
             AND platform_user_id = ?",
            vec![t.channel.clone().into(), t.member.id.clone().into()],
        )?;
        let is_new = known.to_array::<TextRow>()?.is_empty();
        if is_new && self.team_list(&t.channel)?.len() >= sylva_core::team::MAX_TEAM {
            return Response::error(
                format!(
                    "A team can have up to {} people",
                    sylva_core::team::MAX_TEAM
                ),
                409,
            );
        }
        self.sql.exec(
            "INSERT INTO team (channel, platform, platform_user_id, login, name, avatar, role,
                               added_at, channel_name, channel_login, channel_avatar)
             VALUES (?, 'twitch', ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(channel, platform, platform_user_id) DO UPDATE SET
                login = excluded.login, name = excluded.name, avatar = excluded.avatar,
                role = excluded.role, channel_name = excluded.channel_name,
                channel_login = excluded.channel_login, channel_avatar = excluded.channel_avatar",
            vec![
                t.channel.clone().into(),
                t.member.id.clone().into(),
                t.member.login.into(),
                t.member.name.into(),
                t.member.avatar.into(),
                t.role.clone().into(),
                now_ms().into(),
                t.owner.name.clone().into(),
                t.owner.login.clone().into(),
                t.owner.avatar.clone().into(),
            ],
        )?;
        Response::from_json(&TeamChange {
            account_id: self.account_of(&t.member.id)?,
            membership: Membership {
                channel: t.channel,
                role: t.role,
                name: t.owner.name,
                login: t.owner.login,
                avatar: t.owner.avatar,
            },
        })
    }

    fn team_remove(&self, t: TeamRemove) -> Result<Response> {
        let gone = self
            .sql
            .exec(
                "DELETE FROM team WHERE channel = ? AND platform = 'twitch'
                 AND platform_user_id = ? RETURNING login AS value",
                vec![t.channel.clone().into(), t.id.clone().into()],
            )?
            .to_array::<TextRow>()?;
        if gone.is_empty() {
            return Response::error("They are not on the team", 404);
        }
        Response::from_json(&TeamChange {
            account_id: self.account_of(&t.id)?,
            membership: Membership {
                channel: t.channel,
                role: String::new(),
                name: String::new(),
                login: String::new(),
                avatar: String::new(),
            },
        })
    }

    /// At sign in: refresh how this person and their channel are shown on
    /// teams, and list the channels they help run.
    fn team_sign_in(&self, t: TeamSignIn) -> Result<Response> {
        let p = &t.person;
        self.sql.exec(
            "UPDATE team SET login = ?, name = ?, avatar = ?
             WHERE platform = 'twitch' AND platform_user_id = ?",
            vec![
                p.login.clone().into(),
                p.name.clone().into(),
                p.avatar.clone().into(),
                p.id.clone().into(),
            ],
        )?;
        self.sql.exec(
            "UPDATE team SET channel_login = ?, channel_name = ?, channel_avatar = ?
             WHERE channel = ?",
            vec![
                p.login.clone().into(),
                p.name.clone().into(),
                p.avatar.clone().into(),
                t.channel.into(),
            ],
        )?;
        let list: Vec<Membership> = self
            .sql
            .exec(
                "SELECT channel, role, channel_name, channel_login, channel_avatar FROM team
                 WHERE platform = 'twitch' AND platform_user_id = ? ORDER BY added_at",
                vec![p.id.clone().into()],
            )?
            .to_array::<MemberOfRow>()?
            .into_iter()
            .map(|r| Membership {
                channel: r.channel,
                role: r.role,
                name: r.channel_name,
                login: r.channel_login,
                avatar: r.channel_avatar,
            })
            .collect();
        Response::from_json(&list)
    }

    /// A deleted account: its identities can sign up afresh, its pending app
    /// approvals are dropped, it leaves every team, and the teams of the
    /// channels it owned are removed. Answers which other accounts lost a
    /// channel, so the Worker can update them.
    fn forget(&self, f: Forget) -> Result<Response> {
        self.sql.exec(
            "DELETE FROM team WHERE (platform, platform_user_id) IN
               (SELECT platform, platform_user_id FROM identities WHERE account_id = ?)",
            vec![f.account_id.clone().into()],
        )?;
        let mut dropped = Vec::new();
        for channel in &f.channels {
            let rows = self
                .sql
                .exec(
                    "SELECT i.account_id, t.channel FROM team t JOIN identities i
                       ON i.platform = t.platform AND i.platform_user_id = t.platform_user_id
                     WHERE t.channel = ?",
                    vec![channel.clone().into()],
                )?
                .to_array::<DroppedRow>()?;
            dropped.extend(rows.into_iter().map(|r| Dropped {
                account_id: r.account_id,
                channel: r.channel,
            }));
            self.sql.exec(
                "DELETE FROM team WHERE channel = ?",
                vec![channel.clone().into()],
            )?;
        }
        self.sql.exec(
            "DELETE FROM identities WHERE account_id = ?",
            vec![f.account_id.clone().into()],
        )?;
        self.sql.exec(
            "DELETE FROM devices WHERE account_id = ?",
            vec![f.account_id.into()],
        )?;
        Response::from_json(&Forgotten { dropped })
    }

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

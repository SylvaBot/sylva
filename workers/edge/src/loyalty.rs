//! Loyalty points in the channel's Durable Object (see
//! `sylva_core::loyalty`): paying viewers while the stream is live, the
//! one-off bonuses for follows, subs, gifts and cheers, the chat commands,
//! and the dashboard's viewer list.
//!
//! Each viewer has a row in `points` with their balance. Every change also
//! goes in `points_ledger` with a reason. Watch points arrive every few
//! minutes, so they are added to the viewer's newest ledger row while it is
//! a watch row, instead of a new row every time.

use serde::{Deserialize, Serialize};
use sylva_core::alerts::Invalid;
use sylva_core::bot::UserLevel;
use sylva_core::loyalty::{
    grouped, points_command, LoyaltySettings, PointsCommand, MAX_ADJUST, TICK_MS,
};
use sylva_core::{Actor, Event, EventKind, Platform};
use worker::*;

use crate::channel::ChannelDo;
use crate::community::Ask;
use crate::grants::{Permission, Token};
use crate::twitch_api::App;

const PURPOSE: &str = "loyalty";
/// The ledger keeps this many of the newest rows.
const LEDGER_KEEP: i64 = 20_000;
/// Twitch's chatter list is read in pages of 1,000; at most this many pages.
const CHATTER_PAGES: usize = 5;
const WATCH_REASON: &str = "Watching";
const MAX_REASON: usize = 60;

#[derive(Deserialize)]
struct ViewerRow {
    user_id: String,
    login: String,
    name: String,
    balance: f64,
    earned: f64,
}

/// One viewer, for the dashboard.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub id: String,
    pub login: String,
    pub name: String,
    pub balance: i64,
    pub earned: i64,
}

impl From<ViewerRow> for Viewer {
    fn from(r: ViewerRow) -> Viewer {
        Viewer {
            id: r.user_id,
            login: r.login,
            name: r.name,
            balance: r.balance as i64,
            earned: r.earned as i64,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerList {
    pub viewers: Vec<Viewer>,
    pub total: i64,
}

#[derive(Deserialize)]
struct LedgerRow {
    id: f64,
    delta: f64,
    reason: String,
    at: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub id: i64,
    pub delta: i64,
    pub reason: String,
    pub at: i64,
}

/// `GET /loyalty`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoyaltyView {
    pub settings: LoyaltySettings,
    /// Whether Sylva may read the chatter list, which pays viewers who do not chat.
    pub permission: Permission,
    pub live: bool,
    /// Chat commands need the chat bot on.
    pub bot_on: bool,
    pub viewers: i64,
    /// Minutes between watch payments.
    pub every_minutes: i64,
}

/// `POST /loyalty/viewers/{id}/adjust`.
#[derive(Deserialize)]
pub struct Adjust {
    pub delta: i64,
    #[serde(default)]
    pub reason: String,
}

#[derive(Deserialize)]
struct NumRow {
    n: Option<f64>,
}

#[derive(Deserialize)]
struct ActiveRow {
    user_id: String,
    login: String,
    name: String,
}

impl ChannelDo {
    pub(crate) fn loyalty_settings(&self) -> Result<LoyaltySettings> {
        Ok(self
            .config("loyalty")?
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    /// How often watch points are paid. Tests shorten it with
    /// `SYLVA_LOYALTY_TICK_MS`.
    fn tick_ms(&self) -> i64 {
        self.env
            .var("SYLVA_LOYALTY_TICK_MS")
            .ok()
            .and_then(|v| v.to_string().trim().parse::<i64>().ok())
            .filter(|v| *v >= 1_000)
            .unwrap_or(TICK_MS)
    }

    pub(crate) async fn save_loyalty_settings(&self, s: &LoyaltySettings) -> Result<()> {
        let was = self.loyalty_settings()?.enabled;
        self.set_config("loyalty", &serde_json::to_string(s)?)?;
        if s.enabled && !was {
            // Turned on mid-stream: the first payment is one full period away.
            let now = Date::now().as_millis() as i64;
            self.set_config("loyalty_tick", &(now + self.tick_ms()).to_string())?;
            self.sql.exec("DELETE FROM points_active", None)?;
            self.schedule().await?;
        }
        Ok(())
    }

    pub(crate) async fn loyalty_view(&self) -> Result<LoyaltyView> {
        Ok(LoyaltyView {
            settings: self.loyalty_settings()?,
            permission: match self.user_token(PURPOSE).await? {
                Token::Ok(_) => Permission::Ok,
                Token::No(p) => p,
            },
            live: self.uptime_ms()?.is_some(),
            bot_on: self.bot_settings()?.enabled,
            viewers: self.count("SELECT COUNT(*) AS n FROM points", vec![])?,
            every_minutes: (self.tick_ms() / 60_000).max(1),
        })
    }

    pub(crate) fn count(&self, sql: &str, args: Vec<SqlStorageValue>) -> Result<i64> {
        Ok(self
            .sql
            .exec(sql, args)?
            .to_array::<NumRow>()?
            .first()
            .and_then(|r| r.n)
            .map_or(0, |n| n as i64))
    }

    /// When the next watch payment is due: only while live and turned on.
    pub(crate) fn next_loyalty_at(&self) -> Result<Option<i64>> {
        if !self.loyalty_settings()?.enabled || self.uptime_ms()?.is_none() {
            return Ok(None);
        }
        Ok(self.config("loyalty_tick")?.and_then(|v| v.parse().ok()))
    }

    /// The stream went live: start the payment clock and forget who chatted
    /// while it was offline.
    pub(crate) fn restart_loyalty(&self, now: i64) -> Result<()> {
        self.set_config("loyalty_tick", &(now + self.tick_ms()).to_string())?;
        self.sql.exec("DELETE FROM points_active", None)?;
        Ok(())
    }

    pub(crate) fn viewer(&self, user_id: &str) -> Result<Option<Viewer>> {
        Ok(self
            .sql
            .exec(
                "SELECT user_id, login, name, balance, earned FROM points WHERE user_id = ?",
                vec![user_id.into()],
            )?
            .to_array::<ViewerRow>()?
            .into_iter()
            .next()
            .map(Viewer::from))
    }

    pub(crate) fn viewer_by_login(&self, login: &str) -> Result<Option<Viewer>> {
        Ok(self
            .sql
            .exec(
                "SELECT user_id, login, name, balance, earned FROM points WHERE login = ?
                 ORDER BY updated_at DESC LIMIT 1",
                vec![login.into()],
            )?
            .to_array::<ViewerRow>()?
            .into_iter()
            .next()
            .map(Viewer::from))
    }

    /// Change a balance and write why. A balance never goes below zero, so
    /// the change made can be smaller than asked. Returns the change made.
    pub(crate) fn credit(&self, who: &Actor, delta: i64, reason: &str, now: i64) -> Result<i64> {
        let balance = self.viewer(&who.id)?.map_or(0, |v| v.balance);
        let delta = delta.max(-balance);
        if delta == 0 {
            return Ok(0);
        }
        let earned = delta.max(0);
        self.sql.exec(
            "INSERT INTO points (user_id, login, name, balance, earned, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, name = excluded.name,
               balance = balance + excluded.balance, earned = earned + excluded.earned,
               updated_at = excluded.updated_at",
            vec![
                who.id.as_str().into(),
                who.login.as_str().into(),
                who.display_name.as_str().into(),
                delta.into(),
                earned.into(),
                now.into(),
            ],
        )?;
        if reason == WATCH_REASON {
            // Grow the viewer's newest row if it is already a watch row.
            let last = self
                .sql
                .exec(
                    "SELECT id, delta, reason, at FROM points_ledger WHERE user_id = ?
                     ORDER BY id DESC LIMIT 1",
                    vec![who.id.as_str().into()],
                )?
                .to_array::<LedgerRow>()?;
            if let Some(row) = last.first().filter(|r| r.reason == WATCH_REASON) {
                self.sql.exec(
                    "UPDATE points_ledger SET delta = delta + ?, at = ? WHERE id = ?",
                    vec![delta.into(), now.into(), (row.id as i64).into()],
                )?;
                return Ok(delta);
            }
        }
        self.sql.exec(
            "INSERT INTO points_ledger (user_id, delta, reason, at) VALUES (?, ?, ?, ?)",
            vec![
                who.id.as_str().into(),
                delta.into(),
                reason.into(),
                now.into(),
            ],
        )?;
        Ok(delta)
    }

    fn trim_ledger(&self) -> Result<()> {
        self.sql.exec(
            "DELETE FROM points_ledger WHERE id <= (SELECT MAX(id) FROM points_ledger) - ?",
            vec![LEDGER_KEEP.into()],
        )?;
        Ok(())
    }

    /// The broadcaster and the bot never earn.
    pub(crate) fn earns(&self, user_id: &str) -> bool {
        let Some(broadcaster) = self.broadcaster_id() else {
            return false;
        };
        user_id != broadcaster && user_id != crate::bot::sender(&self.env, &broadcaster).id
    }

    /// A chat line: its sender counts as active until the next payment.
    pub(crate) fn mark_active(&self, e: &Event) -> Result<()> {
        let Some(a) = e.actor.as_ref() else {
            return Ok(());
        };
        if e.platform != Platform::Twitch || !self.earns(&a.id) || !self.loyalty_settings()?.enabled
        {
            return Ok(());
        }
        self.sql.exec(
            "INSERT INTO points_active (user_id, login, name, at) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, name = excluded.name,
               at = excluded.at",
            vec![
                a.id.as_str().into(),
                a.login.as_str().into(),
                a.display_name.as_str().into(),
                (Date::now().as_millis() as i64).into(),
            ],
        )?;
        Ok(())
    }

    /// Bonuses for follows, subs, gifts and cheers.
    pub(crate) fn loyalty_event(&self, e: &Event) -> Result<()> {
        if e.platform != Platform::Twitch {
            return Ok(());
        }
        let Some(a) = e.actor.as_ref().filter(|a| !a.id.is_empty()) else {
            return Ok(());
        };
        let s = self.loyalty_settings()?;
        if !s.enabled || !self.earns(&a.id) {
            return Ok(());
        }
        let now = Date::now().as_millis() as i64;
        let (points, reason) = match e.kind {
            EventKind::Follow => {
                // Only the first follow pays, so unfollowing and following
                // again earns nothing.
                let first = self.count(
                    "SELECT COUNT(*) AS n FROM points WHERE user_id = ? AND followed = 1",
                    vec![a.id.as_str().into()],
                )? == 0;
                if !first {
                    return Ok(());
                }
                (i64::from(s.follow), "Followed")
            }
            // A gifted sub pays the gifter, not the one who received it.
            EventKind::Subscriber if !e.gifted => (i64::from(s.sub), "Subscribed"),
            EventKind::CommunityGift => (
                i64::from(s.gift) * e.amount.unwrap_or(1.0).max(1.0) as i64,
                "Gifted subs",
            ),
            EventKind::Cheer => (s.for_cheer(e.amount.unwrap_or(0.0)), "Cheered"),
            _ => return Ok(()),
        };
        self.credit(a, points, reason, now)?;
        if e.kind == EventKind::Follow {
            self.sql.exec(
                "UPDATE points SET followed = 1 WHERE user_id = ?",
                vec![a.id.as_str().into()],
            )?;
        }
        Ok(())
    }

    /// Pay everyone watching, if a payment is due. Called from the alarm.
    pub(crate) async fn run_loyalty(&self, now: i64) -> Result<()> {
        let Some(due) = self.next_loyalty_at()? else {
            return Ok(());
        };
        if now < due {
            return Ok(());
        }
        // Move the clock first, so a failure below cannot pay twice.
        self.set_config("loyalty_tick", &(now + self.tick_ms()).to_string())?;
        let s = self.loyalty_settings()?;
        let active: Vec<ActiveRow> = self
            .sql
            .exec("SELECT user_id, login, name FROM points_active", None)?
            .to_array()?;
        self.sql.exec("DELETE FROM points_active", None)?;
        let mut watching: Vec<Actor> = self.chatters().await.unwrap_or_else(|e| {
            console_error!("Could not read the chatter list: {e}");
            Vec::new()
        });
        for a in &active {
            if !watching.iter().any(|w| w.id == a.user_id) {
                watching.push(Actor {
                    id: a.user_id.clone(),
                    login: a.login.clone(),
                    display_name: a.name.clone(),
                });
            }
        }
        let now = Date::now().as_millis() as i64;
        for w in watching.iter().filter(|w| self.earns(&w.id)) {
            let chatted = active.iter().any(|a| a.user_id == w.id);
            let pay = i64::from(s.watch) + if chatted { i64::from(s.active) } else { 0 };
            if pay > 0 {
                self.credit(w, pay, WATCH_REASON, now)?;
            }
        }
        self.trim_ledger()
    }

    /// Everyone in chat, from Twitch, when the streamer allowed it.
    async fn chatters(&self) -> Result<Vec<Actor>> {
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(Vec::new());
        };
        let Token::Ok(token) = self.user_token(PURPOSE).await? else {
            return Ok(Vec::new());
        };
        let user = App::user(&self.env, &token)?;
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..CHATTER_PAGES {
            let mut path = format!(
                "/chat/chatters?broadcaster_id={broadcaster}&moderator_id={broadcaster}&first=1000"
            );
            if let Some(c) = &cursor {
                path.push_str(&format!("&after={}", sylva_core::auth::encode(c)));
            }
            let (status, v) = user.helix(Method::Get, &path, None).await?;
            if status == 401 {
                self.forget_token(PURPOSE);
            }
            if status != 200 {
                break;
            }
            for c in v["data"].as_array().into_iter().flatten() {
                if let (Some(id), Some(login)) = (c["user_id"].as_str(), c["user_login"].as_str()) {
                    out.push(Actor {
                        id: id.into(),
                        login: login.into(),
                        display_name: c["user_name"].as_str().unwrap_or(login).into(),
                    });
                }
            }
            cursor = v["pagination"]["cursor"]
                .as_str()
                .filter(|c| !c.is_empty())
                .map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok(out)
    }

    /// A viewer by login: from the points table, or else from Twitch.
    pub(crate) async fn find_viewer(&self, login: &str) -> Result<Option<Actor>> {
        if let Some(v) = self.viewer_by_login(login)? {
            return Ok(Some(Actor {
                id: v.id,
                login: v.login,
                display_name: v.name,
            }));
        }
        let app = App::new(&self.env).await?;
        let (status, v) = app
            .helix(
                Method::Get,
                &format!("/users?login={}", sylva_core::auth::encode(login)),
                None,
            )
            .await?;
        if status != 200 {
            return Ok(None);
        }
        let u = &v["data"][0];
        Ok(match (u["id"].as_str(), u["login"].as_str()) {
            (Some(id), Some(l)) => Some(Actor {
                id: id.into(),
                login: l.into(),
                display_name: u["display_name"].as_str().unwrap_or(l).into(),
            }),
            _ => None,
        })
    }

    pub(crate) fn rank(&self, balance: i64) -> Result<i64> {
        Ok(self.count(
            "SELECT COUNT(*) AS n FROM points WHERE balance > ?",
            vec![balance.into()],
        )? + 1)
    }

    fn top_line(&self, name: &str) -> Result<String> {
        let top: Vec<ViewerRow> = self
            .sql
            .exec(
                "SELECT user_id, login, name, balance, earned FROM points WHERE balance > 0
                 ORDER BY balance DESC, updated_at LIMIT 5",
                None,
            )?
            .to_array()?;
        if top.is_empty() {
            return Ok(format!("Nobody has any {name} yet."));
        }
        let list: Vec<String> = top
            .iter()
            .enumerate()
            .map(|(i, v)| format!("{}. {} {}", i + 1, v.name, grouped(v.balance as i64)))
            .collect();
        Ok(format!("Most {name}: {}", list.join(", ")))
    }

    /// The answer to a points command, if `trigger` is one. `who` is the
    /// viewer asking (`None` in the test chat, which saves nothing and
    /// answers for `user`).
    pub(crate) async fn loyalty_reply(
        &self,
        trigger: &str,
        args: &[String],
        ask: &Ask<'_>,
        who: Option<&Actor>,
        user: &str,
    ) -> Result<Option<String>> {
        let s = self.loyalty_settings()?;
        if !s.enabled {
            return Ok(None);
        }
        let Some(cmd) = points_command(trigger, args, &s.name) else {
            return Ok(None);
        };
        let Ask {
            level, now, dry, ..
        } = *ask;
        let name = &s.name;
        let key = who.map_or("test", |w| w.id.as_str());
        match cmd {
            PointsCommand::Balance(other) => {
                if !self.cooled(&format!("p:{key}"), level, now, dry)? {
                    return Ok(None);
                }
                let (label, viewer) = match &other {
                    Some(login) => (login.clone(), self.viewer_by_login(login)?),
                    None => (
                        user.to_string(),
                        match who {
                            Some(w) => self.viewer(&w.id)?,
                            None => self.viewer_by_login(&user.to_lowercase())?,
                        },
                    ),
                };
                Ok(Some(match viewer.filter(|v| v.balance > 0) {
                    Some(v) => format!(
                        "{} has {} {name} (rank {}).",
                        if other.is_some() { &v.name } else { user },
                        grouped(v.balance),
                        self.rank(v.balance)?
                    ),
                    None => format!("{label} has no {name} yet."),
                }))
            }
            PointsCommand::Top => {
                if !self.cooled("p:top", level, now, dry)? {
                    return Ok(None);
                }
                Ok(Some(self.top_line(name)?))
            }
            PointsCommand::Give(login, n) => {
                if !s.give {
                    return Ok(None);
                }
                if dry {
                    return Ok(Some(format!(
                        "{user} gave {} {name} to {login}.",
                        grouped(n)
                    )));
                }
                let Some(from) = who else {
                    return Ok(None);
                };
                if login == from.login {
                    return Ok(None);
                }
                let have = self.viewer(&from.id)?.map_or(0, |v| v.balance);
                if have < n {
                    return Ok(Some(format!(
                        "{}, you have {} {name}.",
                        from.display_name,
                        grouped(have)
                    )));
                }
                let Some(to) = self.find_viewer(&login).await? else {
                    return Ok(Some(format!("There is no viewer called {login}.")));
                };
                if !self.earns(&to.id) {
                    return Ok(None);
                }
                self.credit(from, -n, &format!("Gave to {}", to.display_name), now)?;
                self.credit(&to, n, &format!("Gift from {}", from.display_name), now)?;
                Ok(Some(format!(
                    "{} gave {} {name} to {}.",
                    from.display_name,
                    grouped(n),
                    to.display_name
                )))
            }
            PointsCommand::Add(login, n) => {
                if level < UserLevel::Moderator {
                    return Ok(None);
                }
                if dry {
                    let had = self.viewer_by_login(&login)?.map_or(0, |v| v.balance);
                    return Ok(Some(format!(
                        "{login} now has {} {name}.",
                        grouped((had + n).max(0))
                    )));
                }
                let Some(to) = self.find_viewer(&login).await? else {
                    return Ok(Some(format!("There is no viewer called {login}.")));
                };
                let by = who.map_or("a moderator", |w| w.display_name.as_str());
                self.credit(&to, n, &format!("Changed by {by}"), now)?;
                let balance = self.viewer(&to.id)?.map_or(0, |v| v.balance);
                Ok(Some(format!(
                    "{} now has {} {name}.",
                    to.display_name,
                    grouped(balance)
                )))
            }
        }
    }

    pub(crate) fn loyalty_viewers(&self, q: &str, limit: i64, offset: i64) -> Result<ViewerList> {
        let pattern = format!(
            "%{}%",
            q.trim()
                .to_lowercase()
                .trim_start_matches('@')
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let viewers = self
            .sql
            .exec(
                "SELECT user_id, login, name, balance, earned FROM points
                 WHERE login LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\'
                 ORDER BY balance DESC, updated_at LIMIT ? OFFSET ?",
                vec![
                    pattern.as_str().into(),
                    pattern.as_str().into(),
                    limit.into(),
                    offset.into(),
                ],
            )?
            .to_array::<ViewerRow>()?
            .into_iter()
            .map(Viewer::from)
            .collect();
        let total = self.count(
            "SELECT COUNT(*) AS n FROM points
             WHERE login LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\'",
            vec![pattern.as_str().into(), pattern.as_str().into()],
        )?;
        Ok(ViewerList { viewers, total })
    }

    pub(crate) fn adjust_points(
        &self,
        id: &str,
        a: Adjust,
    ) -> Result<std::result::Result<Viewer, (u16, String)>> {
        let Some(v) = self.viewer(id)? else {
            return Ok(Err((404, "That viewer has no points yet".into())));
        };
        if a.delta == 0 || a.delta.abs() > MAX_ADJUST {
            return Ok(Err((
                400,
                format!("Change by a whole number up to {}", grouped(MAX_ADJUST)),
            )));
        }
        let reason: String = a.reason.trim().chars().take(MAX_REASON).collect();
        let reason = if reason.is_empty() {
            "Changed by the streamer".to_string()
        } else {
            reason
        };
        let now = Date::now().as_millis() as i64;
        self.credit(
            &Actor {
                id: v.id.clone(),
                login: v.login,
                display_name: v.name,
            },
            a.delta,
            &reason,
            now,
        )?;
        Ok(Ok(self.viewer(id)?.expect("the row was just written")))
    }

    pub(crate) fn ledger(&self, id: &str) -> Result<Vec<LedgerEntry>> {
        Ok(self
            .sql
            .exec(
                "SELECT id, delta, reason, at FROM points_ledger WHERE user_id = ?
                 ORDER BY id DESC LIMIT 100",
                vec![id.into()],
            )?
            .to_array::<LedgerRow>()?
            .into_iter()
            .map(|r| LedgerEntry {
                id: r.id as i64,
                delta: r.delta as i64,
                reason: r.reason,
                at: r.at as i64,
            })
            .collect())
    }
}

/// Settings from the dashboard, checked.
pub(crate) fn parse_settings(
    body: serde_json::Value,
) -> std::result::Result<LoyaltySettings, String> {
    let s: LoyaltySettings = serde_json::from_value(body)
        .map_err(|_| "Those points settings could not be read".to_string())?;
    s.validated().map_err(|Invalid(m)| m)
}

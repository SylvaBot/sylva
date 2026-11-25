//! Giveaways in the channel's Durable Object (see `sylva_core::giveaway`):
//! entering from chat, closing, drawing with a shown seed, and the history.
//!
//! One giveaway runs at a time. It is `open` (taking entries), `closed`
//! (entries stopped, ready to draw), and then `ended` or `cancelled`.
//! Drawing works while open or closed and closes entries first. Each draw
//! adds a winner; earlier winners cannot win again.

use serde::{Deserialize, Serialize};
use sylva_core::alerts::Invalid;
use sylva_core::bot::UserLevel;
use sylva_core::giveaway::{pick, seed_hash, GiveawaySettings};
use sylva_core::loyalty::grouped;
use sylva_core::Actor;
use worker::*;

use crate::channel::ChannelDo;
use crate::util::random_hex;

/// Giveaways kept in the history, besides the current one.
const KEEP: i64 = 50;
/// Entries a giveaway takes, so a huge chat cannot fill the object.
const MAX_ENTRIES: i64 = 50_000;
/// Entries the dashboard is sent at once.
const SHOW_ENTRIES: i64 = 500;

#[derive(Deserialize)]
struct GiveawayRow {
    id: f64,
    prize: String,
    keyword: String,
    level: String,
    cost: f64,
    sub_luck: f64,
    seed: String,
    seed_hash: String,
    status: String,
    opened_at: f64,
    closed_at: Option<f64>,
    ended_at: Option<f64>,
    winners: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Winner {
    pub user_id: String,
    pub name: String,
    pub round: u32,
    pub at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Giveaway {
    pub id: i64,
    pub settings: GiveawaySettings,
    /// `open`, `closed`, `ended` or `cancelled`.
    pub status: String,
    pub seed_hash: String,
    /// Shown once the first winner is drawn, or the giveaway is over.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
    pub opened_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    pub winners: Vec<Winner>,
    pub entries: i64,
    pub tickets: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub user_id: String,
    pub name: String,
    pub tickets: i64,
    pub at: i64,
}

#[derive(Deserialize)]
struct EntryRow {
    user_id: String,
    name: String,
    tickets: f64,
    at: f64,
}

#[derive(Deserialize)]
struct SumRow {
    n: Option<f64>,
    t: Option<f64>,
}

/// `GET /giveaways`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiveawaysView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<Giveaway>,
    /// The newest entries of the current giveaway, newest first.
    pub entries: Vec<Entry>,
    pub past: Vec<Giveaway>,
    pub points_on: bool,
    pub points_name: String,
    pub bot_on: bool,
}

fn level_name(l: UserLevel) -> &'static str {
    match l {
        UserLevel::Everyone => "everyone",
        UserLevel::Subscriber => "subscriber",
        UserLevel::Vip => "vip",
        UserLevel::Moderator => "moderator",
        UserLevel::Broadcaster => "broadcaster",
    }
}

fn level_of(s: &str) -> UserLevel {
    serde_json::from_value(serde_json::Value::String(s.into())).unwrap_or(UserLevel::Everyone)
}

impl ChannelDo {
    fn giveaway_from(&self, r: GiveawayRow) -> Result<Giveaway> {
        let id = r.id as i64;
        let sums = self
            .sql
            .exec(
                "SELECT COUNT(*) AS n, SUM(tickets) AS t FROM giveaway_entries WHERE giveaway_id = ?",
                vec![id.into()],
            )?
            .to_array::<SumRow>()?;
        let (entries, tickets) = sums.first().map_or((0, 0), |s| {
            (s.n.unwrap_or(0.0) as i64, s.t.unwrap_or(0.0) as i64)
        });
        let winners: Vec<Winner> = serde_json::from_str(&r.winners).unwrap_or_default();
        let revealed = !winners.is_empty() || matches!(r.status.as_str(), "ended" | "cancelled");
        Ok(Giveaway {
            id,
            settings: GiveawaySettings {
                prize: r.prize,
                keyword: r.keyword,
                level: level_of(&r.level),
                cost: r.cost as u32,
                sub_luck: r.sub_luck as u32,
            },
            status: r.status,
            seed_hash: r.seed_hash,
            seed: revealed.then_some(r.seed),
            opened_at: r.opened_at as i64,
            closed_at: r.closed_at.map(|v| v as i64),
            ended_at: r.ended_at.map(|v| v as i64),
            winners,
            entries,
            tickets,
        })
    }

    fn giveaway_rows(&self, filter: &str, limit: i64) -> Result<Vec<GiveawayRow>> {
        self.sql
            .exec(
                &format!(
                    "SELECT id, prize, keyword, level, cost, sub_luck, seed, seed_hash, status,
                            opened_at, closed_at, ended_at, winners
                     FROM giveaways WHERE {filter} ORDER BY id DESC LIMIT ?"
                ),
                vec![limit.into()],
            )?
            .to_array::<GiveawayRow>()
    }

    fn current_row(&self) -> Result<Option<GiveawayRow>> {
        Ok(self
            .giveaway_rows("status IN ('open', 'closed')", 1)?
            .into_iter()
            .next())
    }

    /// Whether a giveaway is taking entries or waiting to be drawn.
    pub(crate) fn giveaway_running(&self) -> Result<bool> {
        Ok(self.current_row()?.is_some())
    }

    pub(crate) fn giveaways_view(&self) -> Result<GiveawaysView> {
        let current = self.current_row()?;
        let entries = match &current {
            Some(c) => self
                .sql
                .exec(
                    "SELECT user_id, name, tickets, at FROM giveaway_entries WHERE giveaway_id = ?
                     ORDER BY seq DESC LIMIT ?",
                    vec![(c.id as i64).into(), SHOW_ENTRIES.into()],
                )?
                .to_array::<EntryRow>()?
                .into_iter()
                .map(|e| Entry {
                    user_id: e.user_id,
                    name: e.name,
                    tickets: e.tickets as i64,
                    at: e.at as i64,
                })
                .collect(),
            None => Vec::new(),
        };
        let past = self
            .giveaway_rows("status IN ('ended', 'cancelled')", 20)?
            .into_iter()
            .map(|r| self.giveaway_from(r))
            .collect::<Result<Vec<_>>>()?;
        let points = self.loyalty_settings()?;
        Ok(GiveawaysView {
            current: current.map(|r| self.giveaway_from(r)).transpose()?,
            entries,
            past,
            points_on: points.enabled,
            points_name: points.name,
            bot_on: self.bot_settings()?.enabled,
        })
    }

    /// Say something in chat when the bot is on. Never fails the caller.
    async fn announce(&self, text: &str) {
        let Ok(bot) = self.bot_settings() else { return };
        let Some(broadcaster) = self.broadcaster_id() else {
            return;
        };
        if !bot.enabled {
            return;
        }
        let from = crate::bot::sender(&self.env, &broadcaster);
        let now = Date::now().as_millis() as i64;
        if let Err(e) = self.say(&broadcaster, &from, text, now).await {
            console_error!("The giveaway could not post: {e}");
        }
    }

    pub(crate) async fn start_giveaway(
        &self,
        body: GiveawaySettings,
    ) -> Result<std::result::Result<(), (u16, String)>> {
        if self.current_row()?.is_some() {
            return Ok(Err((
                409,
                "A giveaway is already running. End it first.".into(),
            )));
        }
        let s = match body.validated() {
            Ok(s) => s,
            Err(Invalid(m)) => return Ok(Err((400, m))),
        };
        let bot = self.bot_settings()?;
        if bot.find(&s.keyword).is_some() || bot.counter(&s.keyword).is_some() {
            return Ok(Err((
                400,
                format!(
                    "!{} is already a command or a counter. Pick another word.",
                    s.keyword
                ),
            )));
        }
        let points = self.loyalty_settings()?;
        let taken = sylva_core::community::QUOTE_TRIGGERS
            .iter()
            .chain(sylva_core::loyalty::TRIGGERS.iter())
            .chain(sylva_core::store::TRIGGERS.iter())
            .any(|t| *t == s.keyword)
            || s.keyword == points.name.replace(' ', "");
        if taken {
            return Ok(Err((
                400,
                format!(
                    "!{} is one of Sylva's own chat words. Pick another word.",
                    s.keyword
                ),
            )));
        }
        if s.cost > 0 && !points.enabled {
            return Ok(Err((
                400,
                "Turn loyalty points on to charge for entries".into(),
            )));
        }
        let seed = random_hex(32)?;
        let now = Date::now().as_millis() as i64;
        self.sql.exec(
            "INSERT INTO giveaways (prize, keyword, level, cost, sub_luck, seed, seed_hash, status, opened_at, winners)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, '[]')",
            vec![
                s.prize.as_str().into(),
                s.keyword.as_str().into(),
                level_name(s.level).into(),
                i64::from(s.cost).into(),
                i64::from(s.sub_luck).into(),
                seed.as_str().into(),
                seed_hash(&seed).into(),
                now.into(),
            ],
        )?;
        // Keep the newest giveaways and their entries.
        self.sql.exec(
            "DELETE FROM giveaway_entries WHERE giveaway_id IN (
               SELECT id FROM giveaways ORDER BY id DESC LIMIT -1 OFFSET ?)",
            vec![(KEEP + 1).into()],
        )?;
        self.sql.exec(
            "DELETE FROM giveaways WHERE id IN (
               SELECT id FROM giveaways ORDER BY id DESC LIMIT -1 OFFSET ?)",
            vec![(KEEP + 1).into()],
        )?;
        let who = match s.level {
            UserLevel::Everyone => String::new(),
            UserLevel::Subscriber => " Subscribers only.".into(),
            UserLevel::Vip => " VIPs and moderators only.".into(),
            _ => " Moderators only.".into(),
        };
        let cost = if s.cost > 0 {
            format!(" It costs {} {}.", grouped(i64::from(s.cost)), points.name)
        } else {
            String::new()
        };
        self.announce(&format!(
            "Giveaway: {}! Type !{} to enter.{cost}{who}",
            s.prize, s.keyword
        ))
        .await;
        Ok(Ok(()))
    }

    /// Enter from chat. Silent unless the viewer cannot pay.
    pub(crate) fn giveaway_entry(
        &self,
        trigger: &str,
        level: UserLevel,
        who: &Actor,
        now: i64,
    ) -> Result<Option<String>> {
        let Some(row) = self.current_row()? else {
            return Ok(None);
        };
        if row.status != "open" || row.keyword != trigger {
            return Ok(None);
        }
        let id = row.id as i64;
        let g = self.giveaway_from(row)?;
        if level < g.settings.level || Some(who.id.as_str()) == self.broadcaster_id().as_deref() {
            return Ok(None);
        }
        let entered = self.count(
            "SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?",
            vec![id.into(), who.id.as_str().into()],
        )? > 0;
        if entered || g.entries >= MAX_ENTRIES {
            return Ok(None);
        }
        let cost = i64::from(g.settings.cost);
        if cost > 0 {
            let points = self.loyalty_settings()?;
            let have = self.viewer(&who.id)?.map_or(0, |v| v.balance);
            if have < cost {
                // Say it once per viewer per giveaway, not on every try.
                let key = format!("g:{id}:{}", who.id);
                if self.last_used(&key)?.is_some() {
                    return Ok(None);
                }
                self.mark_used(&key, now)?;
                return Ok(Some(format!(
                    "{}, entering costs {} {} and you have {}.",
                    who.display_name,
                    grouped(cost),
                    points.name,
                    grouped(have)
                )));
            }
            self.credit(
                who,
                -cost,
                &format!("Entered the giveaway for {}", g.settings.prize),
                now,
            )?;
        }
        self.sql.exec(
            "INSERT INTO giveaway_entries (giveaway_id, user_id, login, name, tickets, at)
             VALUES (?, ?, ?, ?, ?, ?)",
            vec![
                id.into(),
                who.id.as_str().into(),
                who.login.as_str().into(),
                who.display_name.as_str().into(),
                i64::from(g.settings.tickets(level)).into(),
                now.into(),
            ],
        )?;
        Ok(None)
    }

    /// Close, draw, end or cancel the current giveaway.
    pub(crate) async fn giveaway_action(
        &self,
        id: i64,
        action: &str,
    ) -> Result<std::result::Result<(), (u16, String)>> {
        let Some(row) = self.current_row()?.filter(|r| r.id as i64 == id) else {
            return Ok(Err((409, "That giveaway is over".into())));
        };
        let now = Date::now().as_millis() as i64;
        let seed = row.seed.clone();
        let g = self.giveaway_from(row)?;
        let close = |status: &str| -> Result<()> {
            self.sql.exec(
                "UPDATE giveaways SET status = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?",
                vec![status.into(), now.into(), id.into()],
            )?;
            Ok(())
        };
        match action {
            "close" => {
                if g.status != "open" {
                    return Ok(Err((409, "Entries are already closed".into())));
                }
                close("closed")?;
                self.announce(&format!(
                    "Entries are closed for {}. Good luck!",
                    g.settings.prize
                ))
                .await;
            }
            "draw" => {
                close("closed")?;
                let entries: Vec<EntryRow> = self
                    .sql
                    .exec(
                        "SELECT user_id, name, tickets, at FROM giveaway_entries
                         WHERE giveaway_id = ? ORDER BY seq",
                        vec![id.into()],
                    )?
                    .to_array()?;
                let tickets: Vec<u32> = entries
                    .iter()
                    .map(|e| {
                        if g.winners.iter().any(|w| w.user_id == e.user_id) {
                            0
                        } else {
                            e.tickets as u32
                        }
                    })
                    .collect();
                let round = g.winners.len() as u32 + 1;
                let Some(i) = pick(&seed, round, &tickets) else {
                    return Ok(Err((
                        409,
                        if entries.is_empty() {
                            "Nobody has entered yet".into()
                        } else {
                            "Everyone who entered has already won".into()
                        },
                    )));
                };
                let mut winners = g.winners.clone();
                winners.push(Winner {
                    user_id: entries[i].user_id.clone(),
                    name: entries[i].name.clone(),
                    round,
                    at: now,
                });
                self.sql.exec(
                    "UPDATE giveaways SET winners = ? WHERE id = ?",
                    vec![serde_json::to_string(&winners)?.into(), id.into()],
                )?;
                self.announce(&format!(
                    "@{} won {}! Congratulations!",
                    entries[i].name, g.settings.prize
                ))
                .await;
            }
            "end" => {
                self.sql.exec(
                    "UPDATE giveaways SET status = 'ended', closed_at = COALESCE(closed_at, ?), ended_at = ?
                     WHERE id = ?",
                    vec![now.into(), now.into(), id.into()],
                )?;
            }
            "cancel" => {
                if !g.winners.is_empty() {
                    return Ok(Err((409, "A winner was drawn, so end it instead".into())));
                }
                self.sql.exec(
                    "UPDATE giveaways SET status = 'cancelled', closed_at = COALESCE(closed_at, ?), ended_at = ?
                     WHERE id = ?",
                    vec![now.into(), now.into(), id.into()],
                )?;
                // Entries that cost points get them back.
                if g.settings.cost > 0 {
                    let entries: Vec<EntryRow> = self
                        .sql
                        .exec(
                            "SELECT user_id, name, tickets, at FROM giveaway_entries WHERE giveaway_id = ?",
                            vec![id.into()],
                        )?
                        .to_array()?;
                    for e in entries {
                        let login = self
                            .viewer(&e.user_id)?
                            .map_or_else(String::new, |v| v.login);
                        self.credit(
                            &Actor {
                                id: e.user_id,
                                login,
                                display_name: e.name,
                            },
                            i64::from(g.settings.cost),
                            &format!("Refund: giveaway for {} cancelled", g.settings.prize),
                            now,
                        )?;
                    }
                }
                self.announce(&format!(
                    "The giveaway for {} was cancelled.",
                    g.settings.prize
                ))
                .await;
            }
            _ => return Ok(Err((404, "Not found".into()))),
        }
        Ok(Ok(()))
    }
}

//! The points store in the channel's Durable Object (see
//! `sylva_core::store`): redeeming rewards from chat, the redemption queue
//! on the dashboard, and the public page viewers open to see the rewards.

use serde::{Deserialize, Serialize};
use sylva_core::alerts::Invalid;
use sylva_core::loyalty::grouped;
use sylva_core::store::{clean_input, StoreItem, StoreSettings, MAX_INPUT};
use sylva_core::Actor;
use worker::*;

use crate::channel::ChannelDo;
use crate::community::Ask;

/// Done and refunded redemptions kept, besides every pending one.
const KEEP_FINISHED: i64 = 5_000;
/// Twitch chat lines can be 500 characters; the reward list stays well under.
const LIST_CHARS: usize = 300;

#[derive(Deserialize)]
struct RedemptionRow {
    id: f64,
    item_id: String,
    item_name: String,
    cost: f64,
    user_id: String,
    login: String,
    name: String,
    input: String,
    at: f64,
    status: String,
    done_at: Option<f64>,
}

/// One redemption, for the dashboard's queue.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Redemption {
    pub id: i64,
    pub item_id: String,
    pub item_name: String,
    pub cost: i64,
    pub user_id: String,
    pub login: String,
    pub name: String,
    pub input: String,
    pub at: i64,
    /// `pending`, `done` or `refunded`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<i64>,
}

impl From<RedemptionRow> for Redemption {
    fn from(r: RedemptionRow) -> Redemption {
        Redemption {
            id: r.id as i64,
            item_id: r.item_id,
            item_name: r.item_name,
            cost: r.cost as i64,
            user_id: r.user_id,
            login: r.login,
            name: r.name,
            input: r.input,
            at: r.at as i64,
            status: r.status,
            done_at: r.done_at.map(|d| d as i64),
        }
    }
}

/// `GET /loyalty/store`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreView {
    pub settings: StoreSettings,
    /// Points must be on for the store to work.
    pub points_on: bool,
    pub points_name: String,
    pub bot_on: bool,
    /// The streamer's Twitch login, once Twitch has sent it, for the public page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    pub pending: i64,
}

/// The public page: what anyone may see.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicStore {
    pub channel: String,
    pub points_name: String,
    pub items: Vec<PublicItem>,
    pub top: Vec<PublicViewer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer: Option<PublicViewer>,
    /// True when the store is off and only the leaderboard is shown.
    pub store_on: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicItem {
    /// What to type after `!redeem`.
    pub number: usize,
    pub name: String,
    pub description: String,
    pub cost: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stock: Option<u32>,
    pub cooldown: u32,
    pub input: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicViewer {
    pub name: String,
    pub balance: i64,
    pub rank: i64,
}

#[derive(Deserialize)]
struct BalanceRow {
    name: String,
    balance: f64,
}

#[derive(Deserialize)]
struct AtRow {
    at: f64,
}

impl ChannelDo {
    pub(crate) fn store_settings(&self) -> Result<StoreSettings> {
        Ok(self
            .config("store")?
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    /// The site's address, for the public link in chat. Requests from the
    /// dashboard carry it.
    pub(crate) fn remember_site(&self, url: &Url) -> Result<()> {
        let site = url.origin().ascii_serialization();
        if site.starts_with("http") && self.config("site")?.as_deref() != Some(&site) {
            self.set_config("site", &site)?;
        }
        Ok(())
    }

    fn save_store(&self, s: &StoreSettings) -> Result<()> {
        self.set_config("store", &serde_json::to_string(s)?)
    }

    /// Check and save the store from the dashboard.
    pub(crate) fn save_store_settings(
        &self,
        body: StoreSettings,
    ) -> Result<std::result::Result<(), String>> {
        match body.validated(&self.store_settings()?) {
            Ok(s) => {
                self.save_store(&s)?;
                Ok(Ok(()))
            }
            Err(Invalid(m)) => Ok(Err(m)),
        }
    }

    pub(crate) fn store_view(&self) -> Result<StoreView> {
        let points = self.loyalty_settings()?;
        Ok(StoreView {
            settings: self.store_settings()?,
            points_on: points.enabled,
            points_name: points.name,
            bot_on: self.bot_settings()?.enabled,
            login: self.config("channel_login")?,
            pending: self.count(
                "SELECT COUNT(*) AS n FROM redemptions WHERE status = 'pending'",
                vec![],
            )?,
        })
    }

    /// The public page's link, when Sylva knows the site and the login.
    fn store_link(&self) -> Result<Option<String>> {
        Ok(
            match (self.config("site")?, self.config("channel_login")?) {
                (Some(site), Some(login)) => Some(format!("{site}/s/{login}")),
                _ => None,
            },
        )
    }

    fn list_line(&self, s: &StoreSettings, name: &str) -> Result<String> {
        let shown = s.shown();
        if shown.is_empty() {
            return Ok("The store has no rewards yet.".into());
        }
        let mut parts: Vec<String> = Vec::new();
        let mut len = 0;
        for (i, item) in shown.iter().enumerate() {
            let part = format!(
                "{}. {} ({})",
                i + 1,
                item.name,
                grouped(i64::from(item.cost))
            );
            if len + part.len() > LIST_CHARS {
                parts.push(format!("and {} more", shown.len() - i));
                break;
            }
            len += part.len() + 2;
            parts.push(part);
        }
        let mut line = format!(
            "Rewards for {name}: {}. Redeem with !redeem and a number.",
            parts.join(", ")
        );
        if let Some(link) = self.store_link()? {
            line.push_str(&format!(" All rewards: {link}"));
        }
        Ok(line)
    }

    /// The answer to `!store` or `!redeem`, if `trigger` is one. With
    /// `ask.dry` (the test chat) nothing is bought.
    pub(crate) fn store_reply(
        &self,
        trigger: &str,
        args: &[String],
        ask: &Ask<'_>,
        who: Option<&Actor>,
        user: &str,
    ) -> Result<Option<String>> {
        let points = self.loyalty_settings()?;
        let mut s = self.store_settings()?;
        if !points.enabled || !s.enabled {
            return Ok(None);
        }
        let name = points.name.as_str();
        match trigger {
            "store" | "rewards" => {
                if !self.cooled("s:list", ask.level, ask.now, ask.dry)? {
                    return Ok(None);
                }
                Ok(Some(self.list_line(&s, name)?))
            }
            "redeem" => {
                if args.is_empty() {
                    return Ok(Some(
                        "Redeem with !redeem and a reward's number or name. See them with !store."
                            .into(),
                    ));
                }
                let Some((item, input)) = s.find(args).map(|(i, rest)| (i.clone(), rest)) else {
                    return Ok(Some(
                        "There is no reward like that. See them with !store.".into(),
                    ));
                };
                let number = s
                    .shown()
                    .iter()
                    .position(|i| i.id == item.id)
                    .map_or(1, |p| p + 1);
                if item.stock == Some(0) {
                    return Ok(Some(format!("{} is sold out.", item.name)));
                }
                let Some(input) = clean_input(&input) else {
                    return Ok(Some(format!(
                        "Keep your message to {MAX_INPUT} characters."
                    )));
                };
                if item.input && input.is_empty() {
                    return Ok(Some(format!(
                        "{} needs a message: !redeem {number} and your message.",
                        item.name
                    )));
                }
                let cost = i64::from(item.cost);
                let Some(who) = who else {
                    // The test chat: say what would happen.
                    return Ok(Some(format!(
                        "{user} redeemed {} for {} {name}.",
                        item.name,
                        grouped(cost)
                    )));
                };
                if let Some(wait) = self.wait_left(&item, &who.id, ask.now)? {
                    return Ok(Some(format!(
                        "{}, you can redeem {} again in {}.",
                        who.display_name,
                        item.name,
                        minutes(wait)
                    )));
                }
                let have = self.viewer(&who.id)?.map_or(0, |v| v.balance);
                if have < cost {
                    return Ok(Some(format!(
                        "{}, {} costs {} {name} and you have {}.",
                        who.display_name,
                        item.name,
                        grouped(cost),
                        grouped(have)
                    )));
                }
                self.credit(who, -cost, &format!("Redeemed {}", item.name), ask.now)?;
                if let Some(stored) = s.items.iter_mut().find(|i| i.id == item.id) {
                    if let Some(left) = stored.stock.as_mut() {
                        *left = left.saturating_sub(1);
                        self.save_store(&s)?;
                    }
                }
                self.sql.exec(
                    "INSERT INTO redemptions (item_id, item_name, cost, user_id, login, name, input, at, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
                    vec![
                        item.id.as_str().into(),
                        item.name.as_str().into(),
                        cost.into(),
                        who.id.as_str().into(),
                        who.login.as_str().into(),
                        who.display_name.as_str().into(),
                        input.into(),
                        ask.now.into(),
                    ],
                )?;
                self.trim_redemptions()?;
                Ok(Some(format!(
                    "{} redeemed {} for {} {name}.",
                    who.display_name,
                    item.name,
                    grouped(cost)
                )))
            }
            _ => Ok(None),
        }
    }

    /// Milliseconds before `user_id` may redeem `item` again, if they must wait.
    fn wait_left(&self, item: &StoreItem, user_id: &str, now: i64) -> Result<Option<i64>> {
        if item.cooldown == 0 {
            return Ok(None);
        }
        let last = self
            .sql
            .exec(
                "SELECT at FROM redemptions WHERE item_id = ? AND user_id = ? AND status != 'refunded'
                 ORDER BY id DESC LIMIT 1",
                vec![item.id.as_str().into(), user_id.into()],
            )?
            .to_array::<AtRow>()?;
        let wait = i64::from(item.cooldown) * 60_000;
        Ok(last
            .first()
            .map(|r| r.at as i64 + wait - now)
            .filter(|left| *left > 0))
    }

    fn trim_redemptions(&self) -> Result<()> {
        self.sql.exec(
            "DELETE FROM redemptions WHERE status != 'pending' AND id <= (
               SELECT id FROM redemptions WHERE status != 'pending' ORDER BY id DESC LIMIT 1 OFFSET ?
             )",
            vec![KEEP_FINISHED.into()],
        )?;
        Ok(())
    }

    pub(crate) fn redemptions(
        &self,
        status: &str,
        before: i64,
        limit: i64,
    ) -> Result<Vec<Redemption>> {
        let filter = match status {
            "pending" => "status = 'pending'",
            "done" => "status != 'pending'",
            _ => "1 = 1",
        };
        Ok(self
            .sql
            .exec(
                &format!(
                    "SELECT id, item_id, item_name, cost, user_id, login, name, input, at, status, done_at
                     FROM redemptions WHERE {filter} AND id < ? ORDER BY id {} LIMIT ?",
                    // The queue reads oldest first; history newest first.
                    if status == "pending" { "ASC" } else { "DESC" }
                ),
                vec![before.into(), limit.into()],
            )?
            .to_array::<RedemptionRow>()?
            .into_iter()
            .map(Redemption::from)
            .collect())
    }

    fn redemption(&self, id: i64) -> Result<Option<Redemption>> {
        Ok(self
            .sql
            .exec(
                "SELECT id, item_id, item_name, cost, user_id, login, name, input, at, status, done_at
                 FROM redemptions WHERE id = ?",
                vec![id.into()],
            )?
            .to_array::<RedemptionRow>()?
            .into_iter()
            .next()
            .map(Redemption::from))
    }

    /// Mark done, put back in the queue, or refund. `Err` holds a status
    /// and words for the dashboard.
    pub(crate) fn settle(
        &self,
        id: i64,
        action: &str,
    ) -> Result<std::result::Result<Redemption, (u16, String)>> {
        let Some(r) = self.redemption(id)? else {
            return Ok(Err((404, "That redemption is no longer kept".into())));
        };
        let now = Date::now().as_millis() as i64;
        match (action, r.status.as_str()) {
            ("done", "pending") => {
                self.sql.exec(
                    "UPDATE redemptions SET status = 'done', done_at = ? WHERE id = ?",
                    vec![now.into(), id.into()],
                )?;
            }
            ("reopen", "done") => {
                self.sql.exec(
                    "UPDATE redemptions SET status = 'pending', done_at = NULL WHERE id = ?",
                    vec![id.into()],
                )?;
            }
            ("refund", "pending" | "done") => {
                self.sql.exec(
                    "UPDATE redemptions SET status = 'refunded', done_at = ? WHERE id = ?",
                    vec![now.into(), id.into()],
                )?;
                self.credit(
                    &Actor {
                        id: r.user_id.clone(),
                        login: r.login.clone(),
                        display_name: r.name.clone(),
                    },
                    r.cost,
                    &format!("Refund for {}", r.item_name),
                    now,
                )?;
                // A limited reward gets its place back.
                let mut s = self.store_settings()?;
                if let Some(left) = s
                    .items
                    .iter_mut()
                    .find(|i| i.id == r.item_id)
                    .and_then(|i| i.stock.as_mut())
                {
                    *left += 1;
                    self.save_store(&s)?;
                }
            }
            ("done" | "reopen" | "refund", _) => {
                return Ok(Err((
                    409,
                    match r.status.as_str() {
                        "refunded" => "That redemption was already refunded".into(),
                        "done" => "That redemption is already done".into(),
                        _ => "That redemption is still waiting".into(),
                    },
                )));
            }
            _ => return Ok(Err((404, "Not found".into()))),
        }
        Ok(Ok(self.redemption(id)?.expect("the row was just read")))
    }

    /// What anyone may see: the rewards and the leaderboard, and one
    /// viewer's balance when asked. `None` while points are off.
    pub(crate) fn public_store(&self, viewer: Option<&str>) -> Result<Option<PublicStore>> {
        let points = self.loyalty_settings()?;
        if !points.enabled {
            return Ok(None);
        }
        let s = self.store_settings()?;
        let items = if s.enabled {
            s.shown()
                .into_iter()
                .enumerate()
                .map(|(i, item)| PublicItem {
                    number: i + 1,
                    name: item.name.clone(),
                    description: item.description.clone(),
                    cost: item.cost,
                    stock: item.stock,
                    cooldown: item.cooldown,
                    input: item.input,
                })
                .collect()
        } else {
            Vec::new()
        };
        let top: Vec<BalanceRow> = self
            .sql
            .exec(
                "SELECT name, balance FROM points WHERE balance > 0
                 ORDER BY balance DESC, updated_at LIMIT 10",
                None,
            )?
            .to_array()?;
        let mut rank = 0;
        let top = top
            .into_iter()
            .map(|r| {
                rank += 1;
                PublicViewer {
                    name: r.name,
                    balance: r.balance as i64,
                    rank,
                }
            })
            .collect();
        let viewer = match viewer.and_then(sylva_core::loyalty::login_arg) {
            Some(login) => match self.viewer_by_login(&login)? {
                Some(v) => Some(PublicViewer {
                    rank: self.rank(v.balance)?,
                    name: v.name,
                    balance: v.balance,
                }),
                None => Some(PublicViewer {
                    name: login,
                    balance: 0,
                    rank: 0,
                }),
            },
            None => None,
        };
        Ok(Some(PublicStore {
            channel: self.channel_name()?,
            points_name: points.name,
            items,
            top,
            viewer,
            store_on: s.enabled,
        }))
    }
}

/// `5 minutes`, `1 hour`, `2 hours`, rounded up.
fn minutes(ms: i64) -> String {
    let m = (ms + 59_999) / 60_000;
    if m < 60 {
        format!("{m} minute{}", if m == 1 { "" } else { "s" })
    } else {
        let h = (m + 59) / 60;
        format!("{h} hour{}", if h == 1 { "" } else { "s" })
    }
}

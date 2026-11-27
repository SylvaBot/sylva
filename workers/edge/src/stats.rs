//! Channel stats over time: day by day totals, the period before for
//! comparison, leaderboards, command usage, when chat is busiest, viewer
//! counts and each stream in the range. Everything is worked out from the
//! event log when asked, except viewer counts, which the channel samples
//! from Twitch every few minutes while live.

use serde::{Deserialize, Serialize};
use worker::*;

use crate::channel::{ChannelDo, REAL_EVENTS};
use crate::streams::Recap;
use crate::twitch_api::App;

const DAY: i64 = 86_400_000;
/// How often viewer counts are sampled while live.
const VIEWER_EVERY_MS: i64 = 5 * 60_000;
/// Viewer samples older than this are dropped.
const VIEWER_KEEP_MS: i64 = 400 * DAY;

/// What happened in one day, or in a whole period.
#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Totals {
    pub follows: u64,
    pub subs: u64,
    pub gifted: u64,
    pub bits: u64,
    pub raids: u64,
    pub raiders: u64,
    pub tips: f64,
    pub redemptions: u64,
    pub chat: u64,
    pub chatters: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Day {
    /// Local midnight, in UTC milliseconds.
    start: i64,
    #[serde(flatten)]
    totals: Totals,
}

#[derive(Serialize, Deserialize)]
struct Ranked {
    name: String,
    amount: f64,
}

#[derive(Serialize, Deserialize)]
struct Sample {
    at: f64,
    viewers: f64,
}

#[derive(Deserialize)]
struct KindRow {
    d: f64,
    kind: String,
    n: f64,
    amount: f64,
}

#[derive(Deserialize)]
struct CountRow {
    d: f64,
    n: f64,
}

#[derive(Deserialize)]
struct CellRow {
    w: f64,
    h: f64,
    n: f64,
}

#[derive(Deserialize)]
struct NameRow {
    name: Option<String>,
    amount: f64,
}

#[derive(Deserialize)]
struct BodyRow {
    body: String,
}

#[derive(Deserialize)]
struct FirstRow {
    now: f64,
    before: f64,
}

#[derive(Deserialize)]
struct PeakRow {
    peak: Option<f64>,
    avg: Option<f64>,
}

fn add(t: &mut Totals, kind: &str, n: u64, amount: f64) {
    match kind {
        "follow" => t.follows += n,
        "subscriber" => t.subs += n,
        "communityGift" => t.gifted += amount.max(n as f64) as u64,
        "cheer" => t.bits += amount as u64,
        "raid" => {
            t.raids += n;
            t.raiders += amount as u64;
        }
        "tip" => t.tips += amount,
        "redemption" => t.redemptions += n,
        "chat" => t.chat += n,
        _ => {}
    }
}

/// Add one day's counts to a total. Chatters are left out: people who
/// chatted on two days count once, so totals take their own query.
fn sum_into(t: &mut Totals, d: &Totals) {
    t.follows += d.follows;
    t.subs += d.subs;
    t.gifted += d.gifted;
    t.bits += d.bits;
    t.raids += d.raids;
    t.raiders += d.raiders;
    t.tips += d.tips;
    t.redemptions += d.redemptions;
    t.chat += d.chat;
}

impl ChannelDo {
    /// How many different people chatted between two times.
    fn distinct_chatters(&self, from: i64, to: i64) -> Result<u64> {
        Ok(self
            .sql
            .exec(
                &format!("SELECT 0 AS d, COUNT(DISTINCT json_extract(body, '$.actor.id')) AS n
                 FROM {REAL_EVENTS} WHERE kind = 'chat' AND received_at >= ? AND received_at < ?"),
                vec![(from as f64).into(), (to as f64).into()],
            )?
            .to_array::<CountRow>()?
            .first()
            .map_or(0, |c| c.n as u64))
    }

    /// `GET .../stats?days=30&tz=300`. `tz` is the browser's
    /// `getTimezoneOffset()`, so days and hours follow the streamer's clock.
    pub(crate) fn stats(&self, days: i64, tz: i64) -> Result<serde_json::Value> {
        let days = days.clamp(1, 365);
        let tz_ms = tz.clamp(-24 * 60, 24 * 60) * 60_000;
        let now = Date::now().as_millis() as i64;
        let today = (now - tz_ms).div_euclid(DAY) * DAY + tz_ms;
        let from = today - (days - 1) * DAY;
        let prev = from - days * DAY;
        let to = now + 1;

        // Day by day, counted from the start of the period before: days
        // 0..days are the period before, days..2*days this one.
        let rows: Vec<KindRow> = self
            .sql
            .exec(
                &format!("SELECT CAST((received_at - ?1) / 86400000 AS INTEGER) AS d,
                        kind, COUNT(*) AS n, COALESCE(SUM(COALESCE(json_extract(body, '$.raw.sylvaBase'), json_extract(body, '$.amount'))), 0) AS amount
                 FROM {REAL_EVENTS} WHERE received_at >= ?1 AND received_at < ?2
                   AND kind IN ('follow', 'subscriber', 'communityGift', 'cheer', 'raid', 'tip', 'redemption', 'chat')
                 GROUP BY d, kind"),
                vec![(prev as f64).into(), (to as f64).into()],
            )?
            .to_array()?;
        // Both periods in one list (from = prev + days * DAY), split below.
        let mut all: Vec<Day> = (0..2 * days)
            .map(|i| Day {
                start: prev + i * DAY,
                totals: Totals::default(),
            })
            .collect();
        // Activity brought over from StreamElements, from before Sylva.
        let history: Vec<KindRow> = self
            .sql
            .exec(
                "SELECT CAST((at - ?1) / 86400000 AS INTEGER) AS d,
                        kind, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
                 FROM history_events WHERE at >= ?1 AND at < ?2
                 GROUP BY d, kind",
                vec![(prev as f64).into(), (to as f64).into()],
            )?
            .to_array()?;
        for r in rows.iter().chain(&history) {
            if let Some(d) = all.get_mut(r.d.max(0.0) as usize) {
                add(&mut d.totals, &r.kind, r.n as u64, r.amount);
            }
        }
        let chatters: Vec<CountRow> = self
            .sql
            .exec(
                &format!("SELECT CAST((received_at - ?1) / 86400000 AS INTEGER) AS d,
                        COUNT(DISTINCT json_extract(body, '$.actor.id')) AS n
                 FROM {REAL_EVENTS} WHERE kind = 'chat' AND received_at >= ?1 AND received_at < ?2
                 GROUP BY d"),
                vec![(prev as f64).into(), (to as f64).into()],
            )?
            .to_array()?;
        for c in &chatters {
            if let Some(d) = all.get_mut(c.d.max(0.0) as usize) {
                d.totals.chatters = c.n as u64;
            }
        }
        let series = all.split_off(days as usize);
        let before = all;
        let mut previous = Totals::default();
        for d in &before {
            sum_into(&mut previous, &d.totals);
        }
        previous.chatters = self.distinct_chatters(prev, from)?;
        let mut totals = Totals::default();
        for d in &series {
            sum_into(&mut totals, &d.totals);
        }
        totals.chatters = self.distinct_chatters(from, to)?;

        let range = || vec![(from as f64).into(), (to as f64).into()];
        let ranked = |kind: &str, sum: bool, limit: u32| -> Result<Vec<Ranked>> {
            let what = if sum {
                "SUM(COALESCE(json_extract(body, '$.raw.sylvaBase'), json_extract(body, '$.amount')))"
            } else {
                "COUNT(*)"
            };
            let rows: Vec<NameRow> = self
                .sql
                .exec(
                    &format!(
                        "SELECT MAX(json_extract(body, '$.actor.displayName')) AS name, {what} AS amount
                         FROM {REAL_EVENTS} WHERE kind = ? AND received_at >= ? AND received_at < ?
                           AND json_extract(body, '$.actor.id') IS NOT NULL
                         GROUP BY json_extract(body, '$.actor.id') ORDER BY amount DESC LIMIT {limit}"
                    ),
                    vec![kind.into(), (from as f64).into(), (to as f64).into()],
                )?
                .to_array()?;
            Ok(rows
                .into_iter()
                .filter_map(|r| {
                    Some(Ranked {
                        name: r.name?,
                        amount: r.amount,
                    })
                })
                .filter(|r| r.amount > 0.0)
                .collect())
        };

        // The first word of chat lines that start with "!".
        let commands: Vec<Ranked> = self
            .sql
            .exec(
                &format!("SELECT lower(CASE WHEN instr(m, ' ') > 0 THEN substr(m, 1, instr(m, ' ') - 1) ELSE m END) AS name,
                        COUNT(*) AS amount
                 FROM (SELECT ltrim(json_extract(body, '$.message')) AS m FROM {REAL_EVENTS}
                       WHERE kind = 'chat' AND received_at >= ? AND received_at < ?)
                 WHERE m LIKE '!_%'
                 GROUP BY name ORDER BY amount DESC LIMIT 12"),
                range(),
            )?
            .to_array::<NameRow>()?
            .into_iter()
            .filter_map(|r| {
                Some(Ranked {
                    name: r.name?,
                    amount: r.amount,
                })
            })
            .collect();

        // Chat lines by local weekday (0 is Sunday) and hour.
        let cells: Vec<CellRow> = self
            .sql
            .exec(
                &format!("SELECT (CAST((received_at - ?1) / 86400000 AS INTEGER) + 4) % 7 AS w,
                        CAST((received_at - ?1) / 3600000 AS INTEGER) % 24 AS h, COUNT(*) AS n
                 FROM {REAL_EVENTS} WHERE kind = 'chat' AND received_at >= ?2 AND received_at < ?3
                 GROUP BY w, h"),
                vec![
                    (tz_ms as f64).into(),
                    (from as f64).into(),
                    (to as f64).into(),
                ],
            )?
            .to_array()?;
        let mut heat = vec![vec![0u64; 24]; 7];
        for c in cells {
            let (w, h) = (c.w as usize, c.h as usize);
            if w < 7 && h < 24 {
                heat[w][h] = c.n as u64;
            }
        }

        // First time chatters: people whose first message ever falls in the range.
        let firsts: Vec<FirstRow> = self
            .sql
            .exec(
                &format!("SELECT COALESCE(SUM(first >= ?1), 0) AS now, COALESCE(SUM(first >= ?2 AND first < ?1), 0) AS before
                 FROM (SELECT MIN(received_at) AS first FROM {REAL_EVENTS} WHERE kind = 'chat'
                       AND json_extract(body, '$.actor.id') IS NOT NULL
                       GROUP BY json_extract(body, '$.actor.id'))"),
                vec![(from as f64).into(), (prev as f64).into()],
            )?
            .to_array()?;
        let (new_chatters, prev_new_chatters) = firsts
            .first()
            .map_or((0, 0), |f| (f.now as u64, f.before as u64));

        // The period before, for streams and viewers.
        let prev_viewers = self
            .sql
            .exec(
                "SELECT MAX(viewers) AS peak, AVG(viewers) AS avg FROM viewer_samples WHERE at >= ? AND at < ?",
                vec![(prev as f64).into(), (from as f64).into()],
            )?
            .to_array::<PeakRow>()?;
        let prev_streams: Vec<Recap> = self
            .sql
            .exec(
                "SELECT body FROM stream_recaps WHERE started_at >= ? AND started_at < ?",
                vec![(prev as f64).into(), (from as f64).into()],
            )?
            .to_array::<BodyRow>()?
            .into_iter()
            .filter_map(|b| serde_json::from_str(&b.body).ok())
            .collect();
        let prev_ms: i64 = prev_streams
            .iter()
            .map(|r| r.ended_at.unwrap_or(r.started_at) - r.started_at)
            .sum();

        let viewers: Vec<Sample> = self
            .sql
            .exec(
                "SELECT at, viewers FROM viewer_samples WHERE at >= ? AND at < ? ORDER BY at",
                range(),
            )?
            .to_array()?;

        let mut streams: Vec<Recap> = self
            .sql
            .exec(
                "SELECT body FROM stream_recaps WHERE started_at >= ? ORDER BY started_at DESC LIMIT 500",
                vec![(from as f64).into()],
            )?
            .to_array::<BodyRow>()?
            .into_iter()
            .filter_map(|b| serde_json::from_str(&b.body).ok())
            .collect();
        if let Some(ms) = self.uptime_ms()? {
            streams.insert(0, self.recap(now - ms, None)?);
        }
        for s in streams.iter_mut().filter(|s| s.peak_viewers.is_none()) {
            self.add_viewers(s)?;
        }

        Ok(serde_json::json!({
            "days": days,
            "from": from,
            "series": series,
            "totals": totals,
            "previous": previous,
            "previousSeries": before,
            "topChatters": ranked("chat", false, 10)?,
            "topCheerers": ranked("cheer", true, 10)?,
            "topGifters": ranked("communityGift", true, 10)?,
            "topRaiders": ranked("raid", true, 10)?,
            "commands": commands,
            "heatmap": heat,
            "viewers": viewers,
            "streams": streams,
            "newChatters": new_chatters,
            "before": {
                "newChatters": prev_new_chatters,
                "streams": prev_streams.len(),
                "liveMs": prev_ms,
                "peakViewers": prev_viewers.first().and_then(|p| p.peak),
                "avgViewers": prev_viewers.first().and_then(|p| p.avg.map(f64::round)),
            },
        }))
    }

    /// Peak and average viewers for a stream, from the samples.
    pub(crate) fn add_viewers(&self, r: &mut Recap) -> Result<()> {
        let end = r.ended_at.unwrap_or(i64::MAX / 2);
        let row = self
            .sql
            .exec(
                "SELECT MAX(viewers) AS peak, AVG(viewers) AS avg FROM viewer_samples
                 WHERE at >= ? AND at <= ?",
                vec![(r.started_at as f64).into(), (end as f64).into()],
            )?
            .to_array::<PeakRow>()?;
        if let Some(p) = row.first() {
            r.peak_viewers = p.peak.map(|v| v as u64);
            r.avg_viewers = p.avg.map(|v| v.round() as u64);
        }
        Ok(())
    }

    /// When the next viewer count is due, while live.
    pub(crate) fn next_viewers_at(&self) -> Result<Option<i64>> {
        if self.uptime_ms()?.is_none() || self.broadcaster_id().is_none() {
            return Ok(None);
        }
        Ok(Some(
            self.config("viewers_tick")?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
        ))
    }

    /// The stream went live: take the first count a minute in.
    pub(crate) fn restart_viewers(&self, now: i64) -> Result<()> {
        self.set_config("viewers_tick", &(now + 60_000).to_string())
    }

    /// Ask Twitch how many people are watching, and keep it.
    pub(crate) async fn run_viewers(&self, now: i64) -> Result<()> {
        let Some(due) = self.next_viewers_at()? else {
            return Ok(());
        };
        if now < due {
            return Ok(());
        }
        // Move the clock first, so a failure cannot retry in a tight loop.
        self.set_config("viewers_tick", &(now + VIEWER_EVERY_MS).to_string())?;
        let Some(id) = self.broadcaster_id() else {
            return Ok(());
        };
        let app = App::new(&self.env).await?;
        let (status, v) = app
            .helix(Method::Get, &format!("/streams?user_id={id}"), None)
            .await?;
        if status != 200 {
            return Err(Error::RustError(format!("Twitch answered {status}")));
        }
        let Some(count) = v["data"][0]["viewer_count"].as_f64() else {
            return Ok(());
        };
        self.sql.exec(
            "INSERT OR REPLACE INTO viewer_samples (at, viewers) VALUES (?, ?)",
            vec![(now as f64).into(), count.into()],
        )?;
        self.sql.exec(
            "DELETE FROM viewer_samples WHERE at < ?",
            vec![((now - VIEWER_KEEP_MS) as f64).into()],
        )?;
        Ok(())
    }
}

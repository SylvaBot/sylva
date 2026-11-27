//! Post-stream summaries: what happened between `stream.online` and
//! `stream.offline`. Each one is worked out from the event log when the
//! stream ends and kept, so it outlives the log's own trimming.

use serde::{Deserialize, Serialize};
use worker::*;

use crate::channel::{ChannelDo, REAL_EVENTS};

/// Summaries kept, newest first.
const KEEP: i64 = 1000;

/// The person who did the most of something in one stream.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Leader {
    pub name: String,
    pub amount: f64,
}

/// One stream, start to end.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recap {
    pub started_at: i64,
    /// `None` while still live.
    pub ended_at: Option<i64>,
    pub follows: u64,
    pub subs: u64,
    pub gifted: u64,
    pub bits: u64,
    pub raids: u64,
    pub raiders: u64,
    pub tips: f64,
    pub redemptions: u64,
    pub chat_lines: u64,
    pub chatters: u64,
    pub top_chatter: Option<Leader>,
    pub top_cheerer: Option<Leader>,
    pub top_gifter: Option<Leader>,
    /// From the viewer samples; `None` when none were taken.
    #[serde(default)]
    pub peak_viewers: Option<u64>,
    #[serde(default)]
    pub avg_viewers: Option<u64>,
    /// `streamelements` for a stream brought over from there, whose chat
    /// lines and viewer counts are not known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Deserialize)]
struct KindRow {
    kind: String,
    n: f64,
    amount: f64,
}

#[derive(Deserialize)]
struct LeaderRow {
    name: Option<String>,
    amount: f64,
}

#[derive(Deserialize)]
struct CountRow {
    n: f64,
}

#[derive(Deserialize)]
struct BodyRow {
    body: String,
}

#[derive(Deserialize)]
struct AtRow {
    at: f64,
    raw_type: String,
}

impl ChannelDo {
    /// Work out a stream's summary from the event log.
    pub(crate) fn recap(&self, from: i64, to: Option<i64>) -> Result<Recap> {
        let end = to.unwrap_or(i64::MAX / 2);
        let range = || vec![(from as f64).into(), (end as f64).into()];
        let rows: Vec<KindRow> = self
            .sql
            .exec(
                &format!("SELECT kind, COUNT(*) AS n, COALESCE(SUM(COALESCE(json_extract(body, '$.raw.sylvaBase'), json_extract(body, '$.amount'))), 0) AS amount
                 FROM {REAL_EVENTS} WHERE received_at >= ? AND received_at <= ? GROUP BY kind"),
                range(),
            )?
            .to_array()?;
        let mut r = Recap {
            started_at: from,
            ended_at: to,
            ..Recap::default()
        };
        for k in rows {
            let (n, amount) = (k.n as u64, k.amount);
            match k.kind.as_str() {
                "follow" => r.follows = n,
                "subscriber" => r.subs = n,
                "communityGift" => r.gifted = amount.max(n as f64) as u64,
                "cheer" => r.bits = amount as u64,
                "raid" => {
                    r.raids = n;
                    r.raiders = amount as u64;
                }
                "tip" => r.tips = amount,
                "redemption" => r.redemptions = n,
                "chat" => r.chat_lines = n,
                _ => {}
            }
        }
        r.chatters = self
            .sql
            .exec(
                &format!("SELECT COUNT(DISTINCT json_extract(body, '$.actor.id')) AS n FROM {REAL_EVENTS}
                 WHERE kind = 'chat' AND received_at >= ? AND received_at <= ?"),
                range(),
            )?
            .to_array::<CountRow>()?
            .first()
            .map_or(0, |c| c.n as u64);
        let leader = |kind: &str, sum: bool| -> Result<Option<Leader>> {
            let what = if sum {
                "SUM(COALESCE(json_extract(body, '$.raw.sylvaBase'), json_extract(body, '$.amount')))"
            } else {
                "COUNT(*)"
            };
            let rows: Vec<LeaderRow> = self
                .sql
                .exec(
                    &format!(
                        "SELECT json_extract(body, '$.actor.displayName') AS name, {what} AS amount
                         FROM {REAL_EVENTS} WHERE kind = ? AND received_at >= ? AND received_at <= ?
                           AND json_extract(body, '$.actor.id') IS NOT NULL
                         GROUP BY json_extract(body, '$.actor.id') ORDER BY amount DESC LIMIT 1"
                    ),
                    vec![kind.into(), (from as f64).into(), (end as f64).into()],
                )?
                .to_array()?;
            Ok(rows
                .into_iter()
                .next()
                .and_then(|l| {
                    Some(Leader {
                        name: l.name?,
                        amount: l.amount,
                    })
                })
                .filter(|l| l.amount > 0.0))
        };
        r.top_chatter = leader("chat", false)?;
        r.top_cheerer = leader("cheer", true)?;
        r.top_gifter = leader("communityGift", true)?;
        self.add_viewers(&mut r)?;
        Ok(r)
    }

    /// The stream that just ended, kept. Called on `stream.offline`.
    pub(crate) fn save_recap(&self, ended_at: i64) -> Result<()> {
        let starts: Vec<AtRow> = self
            .sql
            .exec(
                "SELECT received_at AS at, json_extract(body, '$.rawType') AS raw_type FROM events
                 WHERE kind = 'other' AND json_extract(body, '$.rawType') IN ('stream.online', 'stream.offline')
                   AND received_at < ?
                 ORDER BY seq DESC LIMIT 1",
                vec![(ended_at as f64).into()],
            )?
            .to_array()?;
        let Some(start) = starts.first().filter(|s| s.raw_type == "stream.online") else {
            return Ok(());
        };
        let recap = self.recap(start.at as i64, Some(ended_at))?;
        self.sql.exec(
            "INSERT INTO stream_recaps (started_at, body) VALUES (?, ?)
             ON CONFLICT(started_at) DO UPDATE SET body = excluded.body",
            vec![start.at.into(), serde_json::to_string(&recap)?.into()],
        )?;
        self.sql.exec(
            "DELETE FROM stream_recaps WHERE started_at NOT IN
               (SELECT started_at FROM stream_recaps ORDER BY started_at DESC LIMIT ?)",
            vec![(KEEP as f64).into()],
        )?;
        Ok(())
    }

    /// Works out again every stream summary Sylva saved itself, from the log
    /// as it is now. Imported StreamElements streams are left alone, and so
    /// are viewer numbers whose samples are gone.
    pub(crate) fn redo_recaps(&self) -> Result<()> {
        let saved: Vec<Recap> = self
            .sql
            .exec("SELECT body FROM stream_recaps", None)?
            .to_array::<BodyRow>()?
            .into_iter()
            .filter_map(|b| serde_json::from_str(&b.body).ok())
            .collect();
        for old in saved {
            if old.source.is_some() {
                continue;
            }
            let Some(ended_at) = old.ended_at else {
                continue;
            };
            let mut r = self.recap(old.started_at, Some(ended_at))?;
            r.peak_viewers = r.peak_viewers.or(old.peak_viewers);
            r.avg_viewers = r.avg_viewers.or(old.avg_viewers);
            self.sql.exec(
                "UPDATE stream_recaps SET body = ? WHERE started_at = ?",
                vec![serde_json::to_string(&r)?.into(), old.started_at.into()],
            )?;
        }
        Ok(())
    }

    /// `GET .../streams`: the live stream so far, then past ones.
    pub(crate) fn streams_view(&self) -> Result<serde_json::Value> {
        let live = match self.uptime_ms()? {
            Some(ms) => {
                let now = Date::now().as_millis() as i64;
                Some(self.recap(now - ms, None)?)
            }
            None => None,
        };
        let past: Vec<Recap> = self
            .sql
            .exec(
                "SELECT body FROM stream_recaps ORDER BY started_at DESC LIMIT 20",
                None,
            )?
            .to_array::<BodyRow>()?
            .into_iter()
            .filter_map(|b| serde_json::from_str(&b.body).ok())
            .collect();
        Ok(serde_json::json!({ "live": live, "past": past }))
    }
}

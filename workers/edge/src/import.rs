//! `POST .../import/streamelements`: bring a channel's commands, timers and
//! loyalty points over from StreamElements (see `sylva_core::import`). The
//! owner's StreamElements JWT is used for this one request and never kept.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sylva_core::event::Actor;
use sylva_core::import::{
    activities_query, add_commands, add_timers, created_ms, history_len, history_rows,
    history_span, past_streams, point_rows, stream_detail, watch_rows, Skipped, HISTORY_ASKS,
    MAX_POINT_USERS, SE_API,
};
use worker::*;

use crate::channel::ChannelDo;
use crate::streams::{Leader, Recap};
use crate::twitch_api::App;

#[derive(Deserialize)]
pub(crate) struct ImportRequest {
    token: String,
    #[serde(default)]
    commands: bool,
    #[serde(default)]
    timers: bool,
    #[serde(default)]
    points: bool,
    #[serde(default)]
    watchtime: bool,
    /// Past streams and their follows, subs, bits, raids and tips.
    #[serde(default)]
    history: bool,
    #[serde(default)]
    counters: bool,
    /// Points name, earning rate and bonuses.
    #[serde(default)]
    loyalty: bool,
    /// Store items as rewards.
    #[serde(default)]
    store: bool,
    /// All time chat stats: messages, chatters, emotes, commands, hashtags.
    #[serde(default)]
    chatstats: bool,
}

/// Activity older than this is not asked for (StreamElements began in 2015).
const EARLIEST: i64 = 1_420_070_400_000;
/// Pages of activity one import reads, so a request stays well inside the
/// Worker's limit on outgoing requests.
const MAX_HISTORY_PAGES: usize = 40;

#[derive(Deserialize)]
struct MaybeRow {
    v: Option<f64>,
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

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    counters: usize,
    rewards: usize,
    loyalty: bool,
    chat_messages: i64,
    commands: usize,
    timers: usize,
    points: usize,
    watchtime: usize,
    streams: usize,
    activities: usize,
    skipped: Vec<Skipped>,
}

impl ChannelDo {
    async fn se_get(&self, token: &str, path: &str) -> Result<(u16, Value)> {
        let base = self
            .env
            .var("SYLVA_SE_URL")
            .map(|v| v.to_string().trim().trim_end_matches('/').to_string())
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| SE_API.to_string());
        let headers = Headers::new();
        headers.set("Authorization", &format!("Bearer {token}"))?;
        headers.set("Accept", "application/json")?;
        let mut init = RequestInit::new();
        init.with_method(Method::Get).with_headers(headers);
        let req = Request::new_with_init(&format!("{base}{path}"), &init)?;
        let mut res = Fetch::Request(req).send().await?;
        let status = res.status_code();
        let text = res.text().await?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    /// Run the import. `Err` holds words for the dashboard.
    pub(crate) async fn import_streamelements(
        &self,
        r: ImportRequest,
    ) -> Result<std::result::Result<ImportResult, String>> {
        let token = r.token.trim().to_string();
        if token.is_empty() || token.len() > 4000 || token.contains(char::is_whitespace) {
            return Ok(Err("Paste your StreamElements JWT token".into()));
        }
        if !(r.commands
            || r.timers
            || r.points
            || r.watchtime
            || r.history
            || r.counters
            || r.loyalty
            || r.store
            || r.chatstats)
        {
            return Ok(Err("Choose what to bring over".into()));
        }
        let (status, me) = self.se_get(&token, "/channels/me").await?;
        let Some(se) = me["_id"]
            .as_str()
            .filter(|_| status == 200)
            .map(String::from)
        else {
            return Ok(Err(if status == 401 || status == 403 {
                "StreamElements did not accept that token. Copy it again from your StreamElements account page.".into()
            } else {
                format!("StreamElements did not answer ({status}). Try again in a minute.")
            }));
        };
        let mut out = ImportResult::default();
        if r.commands || r.timers || r.counters {
            let mut settings = self.bot_settings()?;
            if r.counters {
                let (status, list) = self.se_get(&token, &format!("/bot/{se}/counters")).await?;
                if status != 200 {
                    return Ok(Err(format!(
                        "StreamElements did not send your counters ({status})."
                    )));
                }
                let (n, skipped) = sylva_core::import::add_counters(&mut settings, &list);
                out.counters = n;
                out.skipped.extend(skipped);
            }
            if r.commands {
                let (status, list) = self.se_get(&token, &format!("/bot/commands/{se}")).await?;
                if status != 200 {
                    return Ok(Err(format!(
                        "StreamElements did not send your commands ({status})."
                    )));
                }
                let (n, skipped) = add_commands(&mut settings, &list);
                out.commands = n;
                out.skipped.extend(skipped);
            }
            if r.timers {
                let (status, list) = self.se_get(&token, &format!("/bot/timers/{se}")).await?;
                if status != 200 {
                    return Ok(Err(format!(
                        "StreamElements did not send your timers ({status})."
                    )));
                }
                let (n, skipped) = add_timers(&mut settings, &list);
                out.timers = n;
                out.skipped.extend(skipped);
            }
            self.save_bot_settings(&settings)?;
            self.schedule().await?;
        }
        if r.points {
            let (status, page) = self
                .se_get(
                    &token,
                    &format!("/points/{se}/top?limit={MAX_POINT_USERS}&offset=0"),
                )
                .await?;
            if status != 200 {
                return Ok(Err(format!(
                    "StreamElements did not send your points ({status})."
                )));
            }
            let rows = point_rows(&page);
            out.points = self.import_points(&rows).await?;
            let missing = rows.len() - out.points;
            if missing > 0 {
                out.skipped.push(Skipped {
                    what: format!("Points for {missing} viewer{}", if missing == 1 { "" } else { "s" }),
                    why: "Their Twitch name no longer exists, or they already have more points in Sylva".into(),
                });
            }
        }
        if r.watchtime {
            let (status, page) = self
                .se_get(
                    &token,
                    &format!("/points/{se}/watchtime?limit={MAX_POINT_USERS}&offset=0"),
                )
                .await?;
            if status != 200 {
                return Ok(Err(format!(
                    "StreamElements did not send your watch time ({status})."
                )));
            }
            let rows = watch_rows(&page);
            for (who, minutes) in self.twitch_users(&rows).await? {
                if self.add_watch(&who, minutes, true)? {
                    out.watchtime += 1;
                }
            }
            let missing = rows.len() - out.watchtime;
            if missing > 0 {
                out.skipped.push(Skipped {
                    what: format!("Watch time for {missing} viewer{}", if missing == 1 { "" } else { "s" }),
                    why: "Their Twitch name no longer exists, or they already have more watch time in Sylva".into(),
                });
            }
        }
        if r.loyalty {
            let (status, v) = self.se_get(&token, &format!("/loyalty/{se}")).await?;
            if status != 200 {
                return Ok(Err(format!(
                    "StreamElements did not send your points settings ({status})."
                )));
            }
            let s = sylva_core::import::loyalty_from_se(&v, self.loyalty_settings()?);
            self.save_loyalty_settings(&s).await?;
            out.loyalty = true;
            out.skipped.push(Skipped {
                what: "The subscriber multiplier and the tip bonus".into(),
                why: "Sylva pays subs and tips with its own bonuses instead".into(),
            });
        }
        if r.store {
            let (status, list) = self.se_get(&token, &format!("/store/{se}/items")).await?;
            if status != 200 {
                return Ok(Err(format!(
                    "StreamElements did not send your store items ({status})."
                )));
            }
            let mut store = self.store_settings()?;
            let (n, skipped) = sylva_core::import::add_store_items(&mut store, &list);
            out.skipped.extend(skipped);
            if n > 0 {
                if let Err(m) = self.save_store_settings(store)? {
                    return Ok(Err(m));
                }
            }
            out.rewards = n;
        }
        if r.chatstats {
            let login = self
                .channel_login()?
                .or_else(|| me["username"].as_str().map(String::from))
                .unwrap_or_default();
            let (status, v) = self
                .se_get(&token, &format!("/chatstats/{}/stats", sylva_core::auth::encode(&login)))
                .await?;
            if status != 200 || login.is_empty() {
                return Ok(Err(format!(
                    "StreamElements did not send your chat stats ({status})."
                )));
            }
            let stats = sylva_core::import::se_chat_stats(&v);
            out.chat_messages = stats.total;
            self.import_chat_stats(&stats).await?;
        }
        if r.history {
            match self.import_history(&token, &se).await? {
                Ok((activities, streams)) => {
                    out.activities = activities;
                    out.streams = streams;
                }
                Err(e) => return Ok(Err(e)),
            }
        }
        Ok(Ok(out))
    }

    /// Bring over StreamElements' activity history and past streams, up to
    /// the first thing Sylva itself recorded, so nothing counts twice.
    /// Returns how many activities and streams were added or refreshed.
    async fn import_history(
        &self,
        token: &str,
        se: &str,
    ) -> Result<std::result::Result<(usize, usize), String>> {
        let now = Date::now().as_millis() as i64;
        let cutoff = self
            .sql
            .exec("SELECT MIN(received_at) AS v FROM events", None)?
            .to_array::<MaybeRow>()?
            .first()
            .and_then(|r| r.v)
            .map_or(now, |v| v as i64);
        let before_count = self.history_count()?;
        // A day before the StreamElements account was made is early enough.
        let earliest = created_ms(se).map_or(EARLIEST, |c| (c - 86_400_000).max(EARLIEST));
        let (mut after, mut before) = (earliest.min(cutoff - 1), cutoff);
        let mut ask: Option<(usize, bool, bool)> = None;
        let mut pages = 0;
        while pages < MAX_HISTORY_PAGES {
            let tries: Vec<_> = match ask {
                Some(a) => vec![a],
                None => HISTORY_ASKS.to_vec(),
            };
            let first = ask.is_none();
            let mut got: Option<(Value, (usize, bool, bool))> = None;
            let mut refused = (0u16, String::new());
            for a in tries {
                pages += 1;
                let path = format!("/activities/{se}?{}", activities_query(after, before, a));
                let (status, page) = self.se_get(token, &path).await?;
                if status == 200 {
                    let n = history_len(&page);
                    console_log!(
                        "StreamElements activities 200 (limit {}, json types {}, iso {}): {n} items",
                        a.0,
                        a.1,
                        a.2
                    );
                    // An empty first page may mean StreamElements read the
                    // ask wrong, so try the other forms before believing it.
                    if got.is_none() || n > 0 {
                        got = Some((page, a));
                    }
                    if n > 0 || !first {
                        break;
                    }
                    continue;
                }
                let why = page["message"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect::<String>();
                console_log!(
                    "StreamElements activities {status} (limit {}, json types {}, iso {}): {why}",
                    a.0,
                    a.1,
                    a.2
                );
                refused = (status, why);
                if status != 400 {
                    break;
                }
            }
            if let Some((_, a)) = &got {
                ask = Some(*a);
            }
            let Some((page, _)) = got else {
                let (status, why) = refused;
                return Ok(Err(if why.is_empty() {
                    format!("StreamElements did not send your activity history ({status}).")
                } else {
                    format!("StreamElements did not send your activity history ({status}: {why}).")
                }));
            };
            let limit = ask.map_or(0, |a| a.0);
            for row in history_rows(&page).into_iter().filter(|r| r.at < cutoff) {
                self.sql.exec(
                    "INSERT OR IGNORE INTO history_events (id, kind, at, amount, name) VALUES (?, ?, ?, ?, ?)",
                    vec![
                        row.id.as_str().into(),
                        row.kind.into(),
                        (row.at as f64).into(),
                        row.amount.into(),
                        row.name.as_deref().into(),
                    ],
                )?;
            }
            if history_len(&page) < limit {
                break;
            }
            let Some((lo, hi, newest_first)) = history_span(&page) else {
                break;
            };
            // Step past this page. One millisecond of overlap keeps
            // activities that share the edge; the id drops the repeats.
            if newest_first {
                if lo + 1 >= before {
                    break;
                }
                before = lo + 1;
            } else {
                if hi - 1 <= after {
                    break;
                }
                after = hi - 1;
            }
        }
        let activities = self.history_count()? - before_count;

        let (status, page) = self.se_get(token, &format!("/streams/{se}")).await?;
        if status != 200 {
            return Ok(Err(format!(
                "StreamElements did not send your past streams ({status})."
            )));
        }
        if let Some(first) = page.as_array().and_then(|l| l.first()) {
            let keys: Vec<&String> = first
                .as_object()
                .map(|o| o.keys().collect())
                .unwrap_or_default();
            console_log!(
                "StreamElements streams: {} listed, fields {keys:?}",
                page.as_array().map_or(0, |l| l.len())
            );
        }
        let mut streams = 0;
        let mut logged = false;
        for s in past_streams(&page) {
            if s.start >= cutoff || self.recorded_overlap(s.start, s.end)? {
                continue;
            }
            // The stream's own page may hold viewer and chat numbers the
            // list leaves out.
            let mut detail = s.detail;
            if let Some(id) = &s.id {
                let (status, one) = self.se_get(token, &format!("/streams/{se}/{id}")).await?;
                if !logged {
                    logged = true;
                    let text = one.to_string();
                    let cut: String = text.chars().take(1500).collect();
                    console_log!("StreamElements stream detail {status}: {cut}");
                }
                if status == 200 {
                    detail = detail.or(stream_detail(&one));
                }
            }
            let mut recap = self.history_recap(s.start, s.end, s.chatters)?;
            recap.peak_viewers = detail.peak_viewers;
            recap.avg_viewers = detail.avg_viewers;
            if let Some(m) = detail.messages {
                recap.chat_lines = m;
            }
            let start = s.start;
            self.sql.exec(
                "INSERT INTO stream_recaps (started_at, body) VALUES (?, ?)
                 ON CONFLICT(started_at) DO UPDATE SET body = excluded.body",
                vec![(start as f64).into(), serde_json::to_string(&recap)?.into()],
            )?;
            streams += 1;
        }
        Ok(Ok((activities, streams)))
    }

    fn history_count(&self) -> Result<usize> {
        Ok(self
            .sql
            .exec("SELECT COUNT(*) AS v FROM history_events", None)?
            .to_array::<MaybeRow>()?
            .first()
            .and_then(|r| r.v)
            .unwrap_or(0.0) as usize)
    }

    /// Whether Sylva recorded a stream of its own over this time.
    fn recorded_overlap(&self, start: i64, end: i64) -> Result<bool> {
        Ok(self
            .sql
            .exec(
                "SELECT COUNT(*) AS v FROM stream_recaps
                 WHERE started_at <= ? AND COALESCE(json_extract(body, '$.endedAt'), started_at) >= ?
                   AND json_extract(body, '$.source') IS NULL",
                vec![(end as f64).into(), (start as f64).into()],
            )?
            .to_array::<MaybeRow>()?
            .first()
            .and_then(|r| r.v)
            .unwrap_or(0.0)
            > 0.0)
    }

    /// One StreamElements stream's summary, from the history brought over.
    fn history_recap(&self, start: i64, end: i64, chatters: u64) -> Result<Recap> {
        let range = || vec![(start as f64).into(), (end as f64).into()];
        let rows: Vec<KindRow> = self
            .sql
            .exec(
                "SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
                 FROM history_events WHERE at >= ? AND at <= ? GROUP BY kind",
                range(),
            )?
            .to_array()?;
        let mut r = Recap {
            started_at: start,
            ended_at: Some(end),
            chatters,
            source: Some("streamelements".into()),
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
                _ => {}
            }
        }
        let leader = |kind: &str| -> Result<Option<Leader>> {
            let mut v = vec![kind.into()];
            v.extend(range());
            Ok(self
                .sql
                .exec(
                    "SELECT name, SUM(amount) AS amount FROM history_events
                     WHERE kind = ? AND at >= ? AND at <= ? AND name IS NOT NULL
                     GROUP BY lower(name) ORDER BY amount DESC LIMIT 1",
                    v,
                )?
                .to_array::<LeaderRow>()?
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
        r.top_cheerer = leader("cheer")?;
        r.top_gifter = leader("communityGift")?;
        Ok(r)
    }

    /// The Twitch viewer behind each StreamElements login, with its number.
    async fn twitch_users(&self, rows: &[(String, i64)]) -> Result<Vec<(Actor, i64)>> {
        let app = App::new(&self.env).await?;
        let mut out = Vec::new();
        for chunk in rows.chunks(100) {
            let q: Vec<String> = chunk.iter().map(|(l, _)| format!("login={l}")).collect();
            let (status, v) = app
                .helix(Method::Get, &format!("/users?{}", q.join("&")), None)
                .await?;
            if status != 200 {
                continue;
            }
            for u in v["data"].as_array().into_iter().flatten() {
                let (Some(id), Some(login)) = (u["id"].as_str(), u["login"].as_str()) else {
                    continue;
                };
                let Some((_, n)) = chunk.iter().find(|(l, _)| l == login) else {
                    continue;
                };
                out.push((
                    Actor {
                        id: id.into(),
                        login: login.into(),
                        display_name: u["display_name"].as_str().unwrap_or(login).into(),
                    },
                    *n,
                ));
            }
        }
        Ok(out)
    }

    /// Give each viewer their StreamElements points, when that is more than
    /// they have in Sylva, so running the import twice changes nothing.
    async fn import_points(&self, rows: &[(String, i64)]) -> Result<usize> {
        let now = Date::now().as_millis() as i64;
        let mut done = 0;
        for (who, points) in self.twitch_users(rows).await? {
            let have = self.viewer(&who.id)?.map_or(0, |v| v.balance);
            if points <= have {
                continue;
            }
            self.credit(&who, points - have, "Imported from StreamElements", now)?;
            done += 1;
        }
        Ok(done)
    }
}

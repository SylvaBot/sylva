//! `POST .../import/other`: bring commands, points, watch time and past tips
//! over from Nightbot, Fossabot, Streamlabs or a file exported from any
//! other bot (see `sylva_core::migrate`). StreamElements has its own route
//! in `import`.
//!
//! Nightbot and Fossabot publish each channel's commands, so those need
//! only the channel name. Everything else comes from a file the dashboard
//! reads in the browser and sends here as rows.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sylva_core::event::Actor;
use sylva_core::import::Skipped;
use sylva_core::migrate::{
    add_commands, clean_login, fossabot_channel, fossabot_commands, nightbot_channel,
    nightbot_commands, Incoming, FOSSABOT_API, MAX_FILE_ROWS, NIGHTBOT_API,
};
use worker::*;

use crate::channel::ChannelDo;
use crate::twitch_api::App;

#[derive(Deserialize)]
pub(crate) struct MigrateRequest {
    /// `nightbot`, `fossabot` or `file`.
    source: String,
    /// The service's name, for the dashboard's words and point reasons.
    #[serde(default)]
    label: String,
    /// The channel's name on Nightbot or Fossabot.
    #[serde(default)]
    login: String,
    #[serde(default)]
    commands: Vec<Incoming>,
    #[serde(default)]
    points: Vec<LoginNumber>,
    #[serde(default)]
    watchtime: Vec<LoginNumber>,
    #[serde(default)]
    tips: Vec<PastTip>,
}

#[derive(Deserialize)]
struct LoginNumber {
    login: String,
    n: f64,
}

#[derive(Deserialize)]
struct PastTip {
    #[serde(default)]
    name: String,
    amount: f64,
    /// Unix milliseconds.
    at: f64,
}

#[derive(Deserialize)]
struct MaybeRow {
    v: Option<f64>,
}

#[derive(Serialize, Default)]
pub(crate) struct MigrateResult {
    commands: usize,
    points: usize,
    watchtime: usize,
    tips: usize,
    skipped: Vec<Skipped>,
}

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

async fn get_json(url: &str, headers: &[(&str, &str)]) -> Result<(u16, Value)> {
    let h = Headers::new();
    h.set("Accept", "application/json")?;
    h.set(
        "User-Agent",
        "Sylva import (+https://sylva-edge.haruxe.workers.dev)",
    )?;
    for (k, v) in headers {
        h.set(k, v)?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(h);
    let mut res = Fetch::Request(Request::new_with_init(url, &init)?)
        .send()
        .await?;
    let status = res.status_code();
    let text = res.text().await?;
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

/// Commands a channel has on Nightbot or Fossabot, or words for the
/// dashboard when they cannot be read.
async fn public_commands(
    source: &str,
    login: &str,
) -> Result<std::result::Result<Vec<Incoming>, String>> {
    let (name, found, list) = match source {
        "nightbot" => {
            let (s, ch) = get_json(&format!("{NIGHTBOT_API}/channels/t/{login}"), &[]).await?;
            let id = nightbot_channel(&ch).filter(|_| s == 200);
            let Some(id) = id else {
                return Ok(Err(format!("Nightbot has no channel named {login}.")));
            };
            let (s, v) = get_json(
                &format!("{NIGHTBOT_API}/commands"),
                &[("Nightbot-Channel", &id)],
            )
            .await?;
            ("Nightbot", s == 200, nightbot_commands(&v))
        }
        _ => {
            let (s, ch) =
                get_json(&format!("{FOSSABOT_API}/channels/by-slug/{login}"), &[]).await?;
            let id = fossabot_channel(&ch).filter(|_| s == 200);
            let Some(id) = id else {
                return Ok(Err(format!("Fossabot has no channel named {login}.")));
            };
            let (s, v) = get_json(&format!("{FOSSABOT_API}/channels/{id}/commands"), &[]).await?;
            ("Fossabot", s == 200, fossabot_commands(&v))
        }
    };
    if !found {
        return Ok(Err(format!(
            "{name} did not send the commands. Try again in a minute."
        )));
    }
    Ok(Ok(list))
}

impl ChannelDo {
    /// Run the import. `Err` holds words for the dashboard.
    pub(crate) async fn import_other(
        &self,
        mut r: MigrateRequest,
    ) -> Result<std::result::Result<MigrateResult, String>> {
        let label = match r.source.as_str() {
            "nightbot" => "Nightbot".to_string(),
            "fossabot" => "Fossabot".to_string(),
            "file" => r.label.trim().chars().take(30).collect::<String>(),
            _ => return Ok(Err("Choose a service to bring things over from".into())),
        };
        let label = if label.is_empty() {
            "your old bot".to_string()
        } else {
            label
        };
        if r.source != "file" {
            let Some(login) = clean_login(&r.login) else {
                return Ok(Err(format!("Type your channel name on {label}")));
            };
            match public_commands(&r.source, &login).await? {
                Ok(list) => r.commands = list,
                Err(e) => return Ok(Err(e)),
            }
            if r.commands.is_empty() {
                return Ok(Err(format!("{label} has no commands for {login}.")));
            }
        }
        let rows = r.commands.len() + r.points.len() + r.watchtime.len() + r.tips.len();
        if rows == 0 {
            return Ok(Err("There was nothing to bring over in that file".into()));
        }
        if rows > MAX_FILE_ROWS * 3 {
            return Ok(Err(format!("That is more than Sylva reads at once. Split it into files of up to {MAX_FILE_ROWS} rows.")));
        }
        let mut out = MigrateResult::default();
        if !r.commands.is_empty() {
            let mut settings = self.bot_settings()?;
            let (n, skipped) = add_commands(&mut settings, &r.commands);
            out.commands = n;
            out.skipped.extend(skipped);
            if n > 0 {
                self.save_bot_settings(&settings)?;
            }
        }
        if !r.points.is_empty() {
            let rows = self.login_rows(&r.points);
            let now = Date::now().as_millis() as i64;
            let reason = format!("Imported from {label}");
            for (who, points) in self.viewers_by_login(&rows).await? {
                let have = self.viewer(&who.id)?.map_or(0, |v| v.balance);
                if points > have {
                    self.credit(&who, points - have, &reason, now)?;
                    out.points += 1;
                }
            }
            let missing = rows.len().saturating_sub(out.points);
            if missing > 0 {
                out.skipped.push(Skipped {
                    what: format!("Points for {}", plural(missing, "viewer")),
                    why: "Their Twitch name no longer exists, or they already have as many points in Sylva".into(),
                });
            }
        }
        if !r.watchtime.is_empty() {
            let rows = self.login_rows(&r.watchtime);
            for (who, minutes) in self.viewers_by_login(&rows).await? {
                if self.add_watch(&who, minutes, true)? {
                    out.watchtime += 1;
                }
            }
            let missing = rows.len().saturating_sub(out.watchtime);
            if missing > 0 {
                out.skipped.push(Skipped {
                    what: format!("Watch time for {}", plural(missing, "viewer")),
                    why: "Their Twitch name no longer exists, or they already have as much watch time in Sylva".into(),
                });
            }
        }
        if !r.tips.is_empty() {
            // Only tips from before Sylva's first event, so none counts twice.
            let now = Date::now().as_millis() as i64;
            let cutoff = self
                .sql
                .exec("SELECT MIN(received_at) AS v FROM events", None)?
                .to_array::<MaybeRow>()?
                .first()
                .and_then(|x| x.v)
                .map_or(now, |v| v as i64);
            let mut late = 0;
            for t in r.tips.iter().take(MAX_FILE_ROWS) {
                let at = t.at as i64;
                if !(t.amount.is_finite() && t.amount > 0.0) || at <= 0 {
                    continue;
                }
                if at >= cutoff {
                    late += 1;
                    continue;
                }
                let name: String = t.name.trim().chars().take(40).collect();
                let id = format!("file:{at}:{}:{name}", (t.amount * 100.0).round() as i64);
                self.sql.exec(
                    "INSERT OR IGNORE INTO history_events (id, kind, at, amount, name) VALUES (?, 'tip', ?, ?, ?)",
                    vec![
                        id.as_str().into(),
                        (at as f64).into(),
                        t.amount.into(),
                        (!name.is_empty()).then_some(name.as_str()).into(),
                    ],
                )?;
                out.tips += 1;
            }
            if late > 0 {
                out.skipped.push(Skipped {
                    what: plural(late, "tip"),
                    why:
                        "They came in after you started using Sylva, so Sylva already counted them"
                            .into(),
                });
            }
        }
        Ok(Ok(out))
    }

    /// Clean logins with whole numbers, biggest first, one row per login.
    fn login_rows(&self, rows: &[LoginNumber]) -> Vec<(String, i64)> {
        let mut out: Vec<(String, i64)> = rows
            .iter()
            .filter_map(|r| Some((clean_login(&r.login)?, r.n.max(0.0).round() as i64)))
            .filter(|(_, n)| *n > 0)
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1));
        let mut seen = std::collections::HashSet::new();
        out.retain(|(l, _)| seen.insert(l.clone()));
        out.truncate(MAX_FILE_ROWS);
        out
    }

    /// The Twitch viewer behind each login, with its number.
    async fn viewers_by_login(&self, rows: &[(String, i64)]) -> Result<Vec<(Actor, i64)>> {
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
}

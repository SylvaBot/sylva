//! `POST .../import/streamelements`: bring a channel's commands, timers and
//! loyalty points over from StreamElements (see `sylva_core::import`). The
//! owner's StreamElements JWT is used for this one request and never kept.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sylva_core::event::Actor;
use sylva_core::import::{add_commands, add_timers, point_rows, Skipped, MAX_POINT_USERS, SE_API};
use worker::*;

use crate::channel::ChannelDo;
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
}

#[derive(Serialize, Default)]
pub(crate) struct ImportResult {
    commands: usize,
    timers: usize,
    points: usize,
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
        if !(r.commands || r.timers || r.points) {
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
        if r.commands || r.timers {
            let mut settings = self.bot_settings()?;
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
        Ok(Ok(out))
    }

    /// Give each viewer their StreamElements points, when that is more than
    /// they have in Sylva, so running the import twice changes nothing.
    async fn import_points(&self, rows: &[(String, i64)]) -> Result<usize> {
        let app = App::new(&self.env).await?;
        let now = Date::now().as_millis() as i64;
        let mut done = 0;
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
                let Some((_, points)) = chunk.iter().find(|(l, _)| l == login) else {
                    continue;
                };
                let have = self.viewer(id)?.map_or(0, |v| v.balance);
                if *points <= have {
                    continue;
                }
                let who = Actor {
                    id: id.into(),
                    login: login.into(),
                    display_name: u["display_name"].as_str().unwrap_or(login).into(),
                };
                self.credit(&who, points - have, "Imported from StreamElements", now)?;
                done += 1;
            }
        }
        Ok(done)
    }
}

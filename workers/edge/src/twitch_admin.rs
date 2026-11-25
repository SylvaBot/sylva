//! Setup routes for the app's Twitch connection. All need the admin token.
//!
//! * `POST /admin/twitch/conduit` gets an app access token, creates the
//!   app's conduit if it has none (or reuses the first one), and points shard 0
//!   at this Worker's `/twitch/eventsub` as a webhook. Twitch then sends a
//!   verification challenge, which the webhook route answers.
//! * `POST /admin/twitch/subscribe` with `{"login": "somechannel"}` subscribes
//!   that channel to the events that need no permission from the broadcaster
//!   (raids, stream online and offline, channel updates). Follows, subs,
//!   cheers and chat are subscribed when the broadcaster signs in to Sylva.
//! * `GET /admin/twitch/status` lists the conduit, its shards and subscriptions.
//!
//! The client secret is read from the `TWITCH_CLIENT_SECRET` Worker secret and
//! never leaves Cloudflare.

use serde_json::{json, Value};
use worker::*;

use crate::twitch_api::{subscribe_channel, App};

pub async fn setup_conduit(req: &Request, env: &Env) -> Result<Response> {
    let app = App::new(env).await?;
    let id = match app.conduit_id().await? {
        Some(id) => id,
        None => {
            let (status, v) = app
                .helix(
                    Method::Post,
                    "/eventsub/conduits",
                    Some(json!({"shard_count": 1})),
                )
                .await?;
            if status >= 300 {
                return Response::from_json(&json!({"step": "create conduit", "twitch": v}))
                    .map(|r| r.with_status(502));
            }
            v["data"][0]["id"].as_str().unwrap_or_default().to_string()
        }
    };
    let mut callback = req.url()?;
    callback.set_path("/twitch/eventsub");
    callback.set_query(None);
    let secret = env.secret("TWITCH_EVENTSUB_SECRET")?.to_string();
    let (status, v) = app
        .helix(
            Method::Patch,
            "/eventsub/conduits/shards",
            Some(json!({
                "conduit_id": id,
                "shards": [{"id": "0", "transport": {
                    "method": "webhook", "callback": callback.as_str(), "secret": secret
                }}]
            })),
        )
        .await?;
    Response::from_json(&json!({"conduitId": id, "callback": callback.as_str(), "twitch": v}))
        .map(|r| r.with_status(if status < 300 { 200 } else { 502 }))
}

pub async fn subscribe(mut req: Request, env: &Env) -> Result<Response> {
    let body: Value = req.json().await?;
    let login = body["login"].as_str().unwrap_or_default().to_lowercase();
    if login.is_empty()
        || !login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Response::error("Send {\"login\": \"channel_name\"}", 400);
    }
    let app = App::new(env).await?;
    let (_, users) = app
        .helix(Method::Get, &format!("/users?login={login}"), None)
        .await?;
    let Some(user_id) = users["data"][0]["id"].as_str().map(String::from) else {
        return Response::error("No Twitch channel with that name", 404);
    };
    let results = match subscribe_channel(&app, &user_id, false).await {
        Ok(r) => r,
        Err(e) => return Response::error(e.to_string(), 409),
    };
    Response::from_json(&json!({
        "channel": format!("twitch:{user_id}"),
        "subscriptions": results
    }))
}

pub async fn status(env: &Env) -> Result<Response> {
    let app = App::new(env).await?;
    let Some(conduit) = app.conduit_id().await? else {
        return Response::from_json(&json!({"conduit": null}));
    };
    let (_, shards) = app
        .helix(
            Method::Get,
            &format!("/eventsub/conduits/shards?conduit_id={conduit}"),
            None,
        )
        .await?;
    let (_, subs) = app
        .helix(Method::Get, "/eventsub/subscriptions", None)
        .await?;
    Response::from_json(&json!({"conduit": conduit, "shards": shards, "subscriptions": subs}))
}

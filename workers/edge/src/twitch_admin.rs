//! Phase 0 setup routes for a real Twitch connection.
//!
//! * `POST /admin/twitch/conduit` gets an app access token, creates the
//!   app's conduit if it has none (or reuses the first one), and points shard 0
//!   at this Worker's `/twitch/eventsub` as a webhook. Twitch then sends a
//!   verification challenge, which the webhook route answers.
//! * `POST /admin/twitch/subscribe` with `{"login": "somechannel"}` subscribes
//!   that channel to events that need no permission from the broadcaster
//!   (`channel.raid`, `stream.online`, `stream.offline`, `channel.update`).
//!   Follows, subs, cheers and chat need the broadcaster to sign in to Sylva,
//!   which arrives in Phase 1.
//! * `GET /admin/twitch/status` lists the conduit, its shards and subscriptions.
//!
//! All three need the admin token. The client secret is read from the
//! `TWITCH_CLIENT_SECRET` Worker secret and never leaves Cloudflare.

use serde_json::{json, Value};
use worker::*;

const HELIX: &str = "https://api.twitch.tv/helix";

struct App {
    client_id: String,
    token: String,
}

async fn app(env: &Env) -> Result<App> {
    let client_id = env.var("TWITCH_CLIENT_ID")?.to_string();
    let secret = env.secret("TWITCH_CLIENT_SECRET")?.to_string();
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", &client_id)
        .append_pair("client_secret", &secret)
        .append_pair("grant_type", "client_credentials")
        .finish();
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_body(Some(body.into()));
    let headers = Headers::new();
    headers.set("Content-Type", "application/x-www-form-urlencoded")?;
    init.with_headers(headers);
    let req = Request::new_with_init("https://id.twitch.tv/oauth2/token", &init)?;
    let mut res = Fetch::Request(req).send().await?;
    if res.status_code() != 200 {
        return Err(Error::RustError(format!(
            "Twitch refused the app credentials ({}). Check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.",
            res.status_code()
        )));
    }
    let v: Value = res.json().await?;
    let token = v["access_token"]
        .as_str()
        .ok_or_else(|| Error::RustError("no access_token from Twitch".into()))?
        .to_string();
    Ok(App { client_id, token })
}

async fn helix(app: &App, method: Method, path: &str, body: Option<Value>) -> Result<(u16, Value)> {
    let headers = Headers::new();
    headers.set("Client-Id", &app.client_id)?;
    headers.set("Authorization", &format!("Bearer {}", app.token))?;
    let mut init = RequestInit::new();
    init.with_method(method);
    if let Some(b) = body {
        headers.set("Content-Type", "application/json")?;
        init.with_body(Some(b.to_string().into()));
    }
    init.with_headers(headers);
    let req = Request::new_with_init(&format!("{HELIX}{path}"), &init)?;
    let mut res = Fetch::Request(req).send().await?;
    let status = res.status_code();
    let text = res.text().await?;
    let v = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok((status, v))
}

async fn conduit_id(app: &App) -> Result<Option<String>> {
    let (_, v) = helix(app, Method::Get, "/eventsub/conduits", None).await?;
    Ok(v["data"][0]["id"].as_str().map(String::from))
}

pub async fn setup_conduit(req: &Request, env: &Env) -> Result<Response> {
    let app = app(env).await?;
    let id = match conduit_id(&app).await? {
        Some(id) => id,
        None => {
            let (status, v) = helix(
                &app,
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
    let (status, v) = helix(
        &app,
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
    let app = app(env).await?;
    let Some(conduit) = conduit_id(&app).await? else {
        return Response::error("No conduit yet. POST /admin/twitch/conduit first.", 409);
    };
    let (_, users) = helix(&app, Method::Get, &format!("/users?login={login}"), None).await?;
    let Some(user_id) = users["data"][0]["id"].as_str().map(String::from) else {
        return Response::error("No Twitch channel with that name", 404);
    };
    let transport = json!({"method": "conduit", "conduit_id": conduit});
    let subs = [
        (
            "channel.raid",
            "1",
            json!({"to_broadcaster_user_id": user_id}),
        ),
        (
            "stream.online",
            "1",
            json!({"broadcaster_user_id": user_id}),
        ),
        (
            "stream.offline",
            "1",
            json!({"broadcaster_user_id": user_id}),
        ),
        (
            "channel.update",
            "2",
            json!({"broadcaster_user_id": user_id}),
        ),
    ];
    let mut results = Vec::new();
    for (kind, version, condition) in subs {
        let (status, v) = helix(
            &app,
            Method::Post,
            "/eventsub/subscriptions",
            Some(json!({"type": kind, "version": version, "condition": condition, "transport": transport})),
        )
        .await?;
        results.push(json!({"type": kind, "status": status, "twitch": v}));
    }
    Response::from_json(&json!({
        "channel": format!("twitch:{user_id}"),
        "overlay": format!("/overlay/twitch:{user_id}"),
        "subscriptions": results
    }))
}

pub async fn status(env: &Env) -> Result<Response> {
    let app = app(env).await?;
    let Some(conduit) = conduit_id(&app).await? else {
        return Response::from_json(&json!({"conduit": null}));
    };
    let (_, shards) = helix(
        &app,
        Method::Get,
        &format!("/eventsub/conduits/shards?conduit_id={conduit}"),
        None,
    )
    .await?;
    let (_, subs) = helix(&app, Method::Get, "/eventsub/subscriptions", None).await?;
    Response::from_json(&json!({"conduit": conduit, "shards": shards, "subscriptions": subs}))
}

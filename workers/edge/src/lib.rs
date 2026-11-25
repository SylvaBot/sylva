//! Sylva's edge Worker.
//!
//! Routes:
//! * `POST /twitch/eventsub` receives EventSub webhooks (a conduit's webhook
//!   shards point here), checks the signature and hands each event to its
//!   channel's Durable Object.
//! * `GET  /v1/channels/{key}/ws` is the realtime socket (see `sylva_core::protocol`).
//! * `GET  /v1/channels/{key}/state` and `/events?after=&limit=` read the
//!   alert state and the event log.
//! * `POST /v1/channels/{key}/alerts/{pause|resume|mute|unmute|skip}`,
//!   `/alerts/replay/{seq}` and `/alerts/play-next/{alertId}` control alerts.
//! * `POST /v1/channels/{key}/test-event` makes a fake event ("Try it").
//! * `GET  /overlay/{key}` serves the Phase 0 test overlay for OBS.
//!
//! `{key}` is the channel's Durable Object name, such as `twitch:12826`.
//!
//! Phase 0 only: the POST routes under `/v1` need `Authorization: Bearer
//! <SYLVA_ADMIN_TOKEN>`, and reads and sockets are open. Real accounts and
//! per overlay read tokens come in Phase 1.

mod channel;

pub use channel::ChannelDo;
use sylva_core::twitch::{self, WebhookHeaders, WebhookMessage};
use sylva_core::{Actor, Event, EventKind, Platform};
use worker::js_sys;
use worker::*;

const OVERLAY_HTML: &str = include_str!("../overlay/index.html");

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // Clients may percent-encode the `:` in channel keys.
    let path = req.path().replace("%3A", ":").replace("%3a", ":");
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    match (req.method(), segs.as_slice()) {
        (Method::Get, [""]) => Response::ok("Sylva edge is running."),
        (Method::Post, ["twitch", "eventsub"]) => eventsub(req, &env).await,
        (Method::Get, ["overlay", key]) => {
            if !valid_key(key) {
                return Response::error("Not found", 404);
            }
            let mut res = Response::from_html(OVERLAY_HTML)?;
            res.headers_mut().set("Cache-Control", "no-store")?;
            Ok(res)
        }
        (method, ["v1", "channels", key, rest @ ..]) => {
            if !valid_key(key) {
                return Response::error("Unknown channel", 404);
            }
            if method == Method::Post && !authorized(&req, &env) {
                return Response::error("Unauthorized", 401);
            }
            match (method, rest) {
                (Method::Post, ["test-event"]) => test_event(req, &env, key).await,
                (Method::Get, ["ws"])
                | (Method::Get, ["state"])
                | (Method::Get, ["events"])
                | (Method::Post, ["alerts", ..]) => forward(req, &env, key, rest).await,
                _ => Response::error("Not found", 404),
            }
        }
        _ => Response::error("Not found", 404),
    }
}

/// Channel keys look like `twitch:123`. Reject anything else so a stray
/// request cannot create Durable Objects with arbitrary names.
fn valid_key(key: &str) -> bool {
    match key.split_once(':') {
        Some((platform, id)) => {
            matches!(platform, "twitch")
                && !id.is_empty()
                && id.len() <= 32
                && id.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

fn authorized(req: &Request, env: &Env) -> bool {
    let Ok(token) = env.secret("SYLVA_ADMIN_TOKEN") else {
        return false;
    };
    let expected = format!("Bearer {token}");
    req.headers()
        .get("Authorization")
        .ok()
        .flatten()
        .is_some_and(|got| constant_time_eq(got.as_bytes(), expected.as_bytes()))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn stub(env: &Env, key: &str) -> Result<Stub> {
    env.durable_object("CHANNEL")?.get_by_name(key)
}

/// Pass a request on to the channel object, keeping method, headers and body
/// (the websocket upgrade travels this way too).
async fn forward(mut req: Request, env: &Env, key: &str, rest: &[&str]) -> Result<Response> {
    let mut url = req.url()?;
    url.set_path(&format!("/{}", rest.join("/")));
    let method = req.method();
    let mut init = RequestInit::new();
    init.with_method(method.clone())
        .with_headers(req.headers().clone());
    if method == Method::Post {
        let body = req.bytes().await?;
        init.with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    }
    stub(env, key)?
        .fetch_with_request(Request::new_with_init(url.as_str(), &init)?)
        .await
}

async fn ingest(env: &Env, event: &Event) -> Result<Response> {
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(serde_json::to_string(event)?.into()));
    let req = Request::new_with_init("https://channel/ingest", &init)?;
    stub(env, &event.channel)?.fetch_with_request(req).await
}

async fn eventsub(mut req: Request, env: &Env) -> Result<Response> {
    let header =
        |name: &str| -> String { req.headers().get(name).ok().flatten().unwrap_or_default() };
    let headers = WebhookHeaders {
        message_id: header("Twitch-Eventsub-Message-Id"),
        timestamp: header("Twitch-Eventsub-Message-Timestamp"),
        signature: header("Twitch-Eventsub-Message-Signature"),
        message_type: header("Twitch-Eventsub-Message-Type"),
    };
    let body = req.bytes().await?;
    let secret = env.secret("TWITCH_EVENTSUB_SECRET")?.to_string();
    let now = Date::now().as_millis() as i64;

    match twitch::handle_webhook(secret.as_bytes(), &headers, &body, now) {
        Ok(WebhookMessage::Verification { challenge }) => {
            let mut res = Response::ok(challenge)?;
            res.headers_mut().set("Content-Type", "text/plain")?;
            Ok(res)
        }
        Ok(WebhookMessage::Revocation {
            subscription_type,
            status,
        }) => {
            console_warn!("EventSub revoked {subscription_type}: {status}");
            Response::empty().map(|r| r.with_status(204))
        }
        Ok(WebhookMessage::Notification(event)) => {
            let res = ingest(env, &event).await?;
            if res.status_code() >= 300 {
                // A non 2xx makes Twitch retry, which is what we want here.
                return Response::error("Could not store event", 500);
            }
            Response::empty().map(|r| r.with_status(204))
        }
        Err(e) => {
            console_warn!("Rejected EventSub message: {e}");
            Response::error("Forbidden", 403)
        }
    }
}

/// A fake alert for the "Try it" button and for local testing.
async fn test_event(mut req: Request, env: &Env, key: &str) -> Result<Response> {
    #[derive(serde::Deserialize, Default)]
    struct TestEvent {
        kind: Option<EventKind>,
        name: Option<String>,
        amount: Option<f64>,
        message: Option<String>,
    }
    let t: TestEvent = req.json().await.unwrap_or_default();
    let now = Date::now();
    let created_at = js_sys::Date::from(now.clone()).to_iso_string().into();
    let name = t.name.unwrap_or_else(|| "Sylva".into());
    let event = Event {
        id: format!("sylva:test:{}:{}", now.as_millis(), js_random()),
        channel: key.to_string(),
        platform: Platform::Sylva,
        kind: t.kind.unwrap_or(EventKind::Follow),
        raw_type: "sylva.test".into(),
        created_at,
        actor: Some(Actor {
            id: "0".into(),
            login: name.to_lowercase(),
            display_name: name,
        }),
        amount: t.amount,
        currency: None,
        message: t.message,
        tier: None,
        gifted: false,
        sender: None,
        redemption: None,
        raw: serde_json::Value::Null,
    };
    ingest(env, &event).await
}

fn js_random() -> u64 {
    (js_sys::Math::random() * 1e15) as u64
}

//! Sylva's edge Worker.
//!
//! Routes (any other GET is the dashboard, embedded from `web/dist`):
//! * `GET  /auth/twitch/start`, `/auth/twitch/callback`, `POST /auth/sign-out`:
//!   sign in with Twitch (see `auth`).
//! * `GET  /v1/me`: who is signed in and which channels they manage.
//! * `POST /twitch/eventsub` receives EventSub webhooks (a conduit's webhook
//!   shards point here), checks the signature and hands each event to its
//!   channel's Durable Object.
//! * `/v1/channels/{key}/...`: the channel API, for the channel's owner and
//!   team (each role's limits are `sylva_core::team::allows`):
//!   * `GET ws` is the realtime socket (see `sylva_core::protocol`). An
//!     overlay link's `?token=` also opens it, as an overlay only.
//!   * `GET state`, `GET events?after=&limit=` (oldest first),
//!     `GET history?before=&limit=&filter=alerts|chat|all` (newest first),
//!     `GET summary?since=` (counts by kind).
//!   * `POST alerts/{pause|resume|mute|unmute|skip}`, `alerts/replay/{seq}`,
//!     `alerts/play-next/{alertId}` control alerts.
//!   * `POST test-event` makes a fake event ("Try it").
//!   * `GET overlay` gives the overlay link, `POST overlay/rotate` replaces it.
//!   * `GET twitch` says which Twitch events are on, `POST twitch/subscribe`
//!     turns them on again.
//!   * `GET team`, `POST team` (`{login, role}`) and `POST team/{id}/remove`
//!     manage the team (see `team`).
//! * `GET  /overlay/{key}?token=` serves the alert overlay for OBS.
//! * `/admin/twitch/*` sets up the Twitch conduit (see `twitch_admin`).
//!
//! `{key}` is the channel's Durable Object name, such as `twitch:12826`.
//!
//! Who may call the channel API: the signed in owner or a teammate (session
//! cookie or an app's API token), as far as their role allows, or anyone with `Authorization: Bearer <SYLVA_ADMIN_TOKEN>` (tests and setup).
//! Requests that change something with a cookie must come from Sylva's own
//! pages (`Origin` check).

mod account;
mod apps;
mod ask;
mod auth;
mod bot;
mod builtins;
mod channel;
mod chat_alerts;
mod chat_assets;
mod chat_stats;
mod community;
mod delete;
mod games;
mod giveaway;
mod grants;
mod import;
mod loyalty;
mod media;
mod migrate;
mod moderation;
mod nuke;
mod overlays;
mod polly;
mod stats;
mod store;
mod streams;
mod team;
mod tips;
mod twitch_admin;
mod twitch_api;
mod util;
mod web;

pub use account::{AccountDo, DirectoryDo};
pub use channel::ChannelDo;
use channel::{ACCESS_HEADER, CHANNEL_HEADER, TOKEN_HEADER};
use serde_json::json;
use sylva_core::team::{self as roles, Role};
use sylva_core::twitch::{self, WebhookHeaders, WebhookMessage};
use sylva_core::{Actor, Event, EventKind, Platform};
use worker::js_sys;
use worker::*;

const OVERLAY_HTML: &str = include_str!("../overlay/index.html");
const OVERLAY_FRAME_HTML: &str = include_str!("../overlay/frame.html");

/// The built-in alerts and chat widgets, the same code the editor adds. The
/// overlay shows them for its alert box and chat box, and for a channel that
/// has not published a layout yet.
fn overlay_html() -> &'static str {
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PAGE.get_or_init(|| {
        macro_rules! widget {
            ($name:literal, $title:literal, $alerts:literal) => {
                serde_json::json!({
                    "name": $title,
                    "html": include_str!(concat!("../../../web/src/widgets/", $name, ".html")),
                    "css": include_str!(concat!("../../../web/src/widgets/", $name, ".css")),
                    "js": include_str!(concat!("../../../web/src/widgets/", $name, ".js")),
                    "fields": include_str!(concat!("../../../web/src/widgets/", $name, ".json")),
                    "values": {},
                    "alerts": $alerts,
                })
            };
        }
        let defaults = serde_json::json!({
            "alerts": widget!("pill-alerts", "Pill alerts", true),
            "chat": widget!("twitch-chat", "Chat", false),
        });
        // Inside a script tag, "</" could end the script early.
        let json = defaults.to_string().replace("</", "<\\/");
        OVERLAY_HTML.replacen("/*SYLVA_DEFAULTS*/null", &json, 1)
    })
}

/// Who is calling the channel API.
#[derive(PartialEq)]
enum Caller {
    Admin,
    /// The owner or a teammate. `via_token` is an app such as Sylva Desktop with an
    /// API token, rather than a browser with the session cookie.
    Member {
        role: Role,
        via_token: bool,
    },
    /// Not allowed, or only with an overlay link's token.
    Anonymous,
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // Clients may percent-encode the `:` in channel keys.
    let path = req.path().replace("%3A", ":").replace("%3a", ":");
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    match (req.method(), segs.as_slice()) {
        (Method::Get, ["health"]) => Response::ok("Sylva edge is running."),
        (Method::Get, ["auth", "twitch", "start"]) => auth::start(&req, &env).await,
        (Method::Get, ["auth", "twitch", "callback"]) => auth::callback(&req, &env).await,
        (Method::Get, ["auth", "twitch", "bot"]) => auth::bot_start(&req, &env).await,
        (Method::Post, ["auth", "sign-out"]) => auth::sign_out(&req, &env).await,
        (Method::Get, ["v1", "me"]) => match auth::caller(&req, &env).await? {
            Some(s) => no_store(Response::from_json(&s.me)?),
            None => Response::error("Not signed in", 401),
        },
        (Method::Post, ["v1", "device", "code"]) => apps::device_code(req, &env).await,
        (Method::Post, ["v1", "device", "token"]) => apps::device_token(req, &env).await,
        (method, ["v1", "device"]) | (method, ["v1", "apps", ..]) => {
            // Approving apps and managing them needs the browser session:
            // an app cannot approve or list other apps.
            let Some(s) = auth::session(&req, &env).await? else {
                return Response::error("Sign in to Sylva first", 401);
            };
            if method != Method::Get && !auth::same_origin(&req) {
                return Response::error("Forbidden", 403);
            }
            match (method, segs.as_slice()) {
                (Method::Get, ["v1", "device"]) => no_store(apps::device_lookup(&req, &env).await?),
                (Method::Post, ["v1", "device"]) => apps::device_decide(req, &env, s).await,
                (Method::Get, ["v1", "apps"]) => no_store(apps::list(&env, &s).await?),
                (Method::Post, ["v1", "apps", id, "revoke"]) => apps::revoke(&env, &s, id).await,
                _ => Response::error("Not found", 404),
            }
        }
        (Method::Post, ["v1", "account", "delete"]) => {
            // The browser session only: an app cannot delete the account.
            if !auth::same_origin(&req) {
                return Response::error("Forbidden", 403);
            }
            match auth::session(&req, &env).await? {
                Some(s) => delete::delete_account(req, &env, s).await,
                None => Response::error("Sign in to Sylva first", 401),
            }
        }
        (Method::Post, ["twitch", "eventsub"]) => eventsub(req, &env).await,
        (method, ["admin", "twitch", action]) => {
            if !authorized(&req, &env) {
                return Response::error("Unauthorized", 401);
            }
            match (method, *action) {
                (Method::Post, "conduit") => twitch_admin::setup_conduit(&req, &env).await,
                (Method::Post, "subscribe") => twitch_admin::subscribe(req, &env).await,
                (Method::Get, "status") => twitch_admin::status(&env).await,
                _ => Response::error("Not found", 404),
            }
        }
        (Method::Get, ["v1", "public", login]) => public_store(&req, &env, login).await,
        (Method::Get, ["v1", "public", login, "tip"]) => match public_channel(&env, login).await? {
            Ok(ch) => tips::public_config(&req, &env, ch).await,
            Err(res) => Ok(res),
        },
        (Method::Post, ["v1", "public", login, "tip"]) => {
            match public_channel(&env, login).await? {
                Ok(ch) => tips::public_create(req, &env, &ch.key).await,
                Err(res) => Ok(res),
            }
        }
        (Method::Get, ["v1", "public", login, "tip", id]) => {
            match public_channel(&env, login).await? {
                Ok(ch) if id.starts_with("tip_") && id.len() <= 40 => {
                    let mut res = stub(&env, &ch.key)?
                        .fetch_with_str(&format!("https://channel/public/tips/{id}"))
                        .await?;
                    let body = res.text().await?;
                    let mut out = Response::ok(body)?.with_status(res.status_code());
                    out.headers_mut().set("Content-Type", "application/json")?;
                    out.headers_mut().set("Cache-Control", "no-store")?;
                    Ok(out)
                }
                Ok(_) => Response::error("No such tip", 404),
                Err(res) => Ok(res),
            }
        }
        (Method::Post, ["stripe", "webhook"]) => tips::webhook(req, &env).await,
        (Method::Get, [".well-known", "apple-developer-merchantid-domain-association"]) => {
            tips::apple_pay_file().await
        }
        (Method::Get, ["tts", key, id]) => {
            if !valid_key(key) {
                return Response::error("Not found", 404);
            }
            stub(&env, key)?
                .fetch_with_str(&format!("https://channel/public/tts/{id}"))
                .await
        }
        (Method::Get, ["v1", "public", login, "commands"]) => public_commands(&env, login).await,
        (Method::Get, ["v1", "public", login, "chatstats"]) => public_chat_stats(&env, login).await,
        (Method::Get, ["v1", "public", login, "profile"]) => public_profile(&env, login).await,
        (Method::Get, ["v1", "chat-assets", key]) => {
            if !valid_key(key) {
                return Response::error("Unknown channel", 404);
            }
            chat_assets::chat_assets(&env, key).await
        }
        (Method::Get, ["media", key, id]) => {
            if !valid_key(key) || !sylva_core::media::valid_id(id) {
                return Response::error("Not found", 404);
            }
            stub(&env, key)?
                .fetch_with_str(&format!("https://channel/public/media/{id}"))
                .await
        }
        (Method::Get, ["overlay-frame"]) => {
            // A custom widget's frame. The sandbox keeps its code in an
            // origin of its own even when the page is opened directly.
            let mut res = Response::from_html(OVERLAY_FRAME_HTML)?;
            let h = res.headers_mut();
            h.set(
                "Content-Security-Policy",
                "sandbox allow-scripts; frame-ancestors 'self'",
            )?;
            h.set("Cache-Control", "public, max-age=300")?;
            h.set("Referrer-Policy", "no-referrer")?;
            Ok(res)
        }
        (Method::Get, ["overlay", key]) => {
            if !valid_key(key) {
                return Response::error("Not found", 404);
            }
            let mut res = Response::from_html(overlay_html())?;
            res.headers_mut().set("Cache-Control", "no-store")?;
            // Overlay links carry a token in the query: never send it on.
            res.headers_mut().set("Referrer-Policy", "no-referrer")?;
            Ok(res)
        }
        (method, ["v1", "channels", key, rest @ ..]) => {
            if !valid_key(key) {
                return Response::error("Unknown channel", 404);
            }
            let caller = if authorized(&req, &env) {
                Caller::Admin
            } else {
                match auth::caller(&req, &env).await? {
                    Some(s) => match s.me.role(key) {
                        Some(role) => Caller::Member {
                            role,
                            via_token: s.via_token,
                        },
                        None => return Response::error("This is not your channel", 403),
                    },
                    None => Caller::Anonymous,
                }
            };
            if let Caller::Member { role, via_token } = caller {
                // API tokens carry no cookie, so they need no Origin check.
                if !via_token && method != Method::Get && !auth::same_origin(&req) {
                    return Response::error("Forbidden", 403);
                }
                if !roles::allows(role, method != Method::Get, rest) {
                    let who = match role {
                        Role::Editor => "An editor",
                        Role::Moderator => "A moderator",
                        _ => "A viewer",
                    };
                    return Response::error(format!("{who} cannot do that on this channel"), 403);
                }
            }
            if caller == Caller::Anonymous {
                // Only an overlay link may open the socket without signing in.
                let token = req
                    .url()?
                    .query_pairs()
                    .find(|(k, _)| k == "token")
                    .map(|(_, v)| v.into_owned());
                return match (method, rest, token) {
                    (Method::Get, ["ws"], Some(token)) => {
                        forward(req, &env, key, rest, Some(&token)).await
                    }
                    _ => Response::error("Sign in to Sylva first", 401),
                };
            }
            match (method, rest) {
                (Method::Post, ["test-event"]) => test_event(req, &env, key).await,
                (Method::Get, ["overlay"]) => overlay_link(&req, &env, key, false).await,
                (Method::Post, ["overlay", "rotate"]) => overlay_link(&req, &env, key, true).await,
                (Method::Get, ["twitch"]) => twitch_status(&env, key).await,
                (Method::Post, ["twitch", "subscribe"]) => twitch_subscribe(&env, key).await,
                (Method::Get, ["team"]) => team::list(&env, key).await,
                (Method::Post, ["team"]) => team::add(req, &env, key).await,
                (Method::Post, ["team", id, "remove"]) => team::remove(&env, key, id).await,
                (Method::Get, ["ws"])
                | (Method::Get, ["state"])
                | (Method::Get, ["events"])
                | (Method::Get, ["history"])
                | (Method::Get, ["summary"])
                | (Method::Get, ["alert-settings"])
                | (Method::Get, ["widget-settings"])
                | (Method::Post, ["widget-settings"])
                | (Method::Post, ["alert-settings"])
                | (Method::Get, ["bot"])
                | (Method::Get, ["bot", "quotes"])
                | (Method::Post, ["bot", ..])
                | (Method::Get, ["chat-alerts"])
                | (Method::Post, ["chat-alerts"])
                | (Method::Get, ["moderation", ..])
                | (Method::Post, ["moderation", ..])
                | (Method::Get, ["giveaways"])
                | (Method::Post, ["giveaways", ..])
                | (Method::Get, ["loyalty", ..])
                | (Method::Post, ["loyalty", ..])
                | (Method::Get, ["media"])
                | (Method::Get, ["streams"])
                | (Method::Get, ["stats"])
                | (Method::Post, ["media", ..])
                | (Method::Get, ["scene"])
                | (Method::Get, ["overlays"])
                | (Method::Post, ["overlays"])
                | (Method::Post, ["scene", ..])
                | (Method::Post, ["import", "streamelements"])
                | (Method::Post, ["import", "other"])
                | (Method::Get, ["tips"])
                | (Method::Get, ["tips", "held"])
                | (Method::Post, ["tips", ..])
                | (Method::Post, ["alerts", ..]) => forward(req, &env, key, rest, None).await,
                _ => Response::error("Not found", 404),
            }
        }
        (Method::Get | Method::Head, [first, ..])
            if !matches!(
                *first,
                "v1" | "auth" | "twitch" | "admin" | "overlay" | "media" | "tts" | "stripe"
            ) =>
        {
            let versioned = req.url()?.query_pairs().any(|(k, _)| k == "v");
            web::serve(&path, versioned)
        }
        _ => Response::error("Not found", 404),
    }
}

fn no_store(mut res: Response) -> Result<Response> {
    res.headers_mut().set("Cache-Control", "no-store")?;
    Ok(res)
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

pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn stub(env: &Env, key: &str) -> Result<Stub> {
    env.durable_object("CHANNEL")?.get_by_name(key)
}

/// Pass a request on to the channel object, keeping method, headers and body
/// (the websocket upgrade travels this way too). The access header is always
/// set here, never taken from the client: `owner` when the caller was checked
/// above, otherwise `token` with the overlay token for the object to check.
async fn forward(
    mut req: Request,
    env: &Env,
    key: &str,
    rest: &[&str],
    overlay_token: Option<&str>,
) -> Result<Response> {
    let mut url = req.url()?;
    url.set_path(&format!("/{}", rest.join("/")));
    let method = req.method();
    let headers = req.headers().clone();
    headers.delete(ACCESS_HEADER)?;
    headers.delete(TOKEN_HEADER)?;
    match overlay_token {
        Some(t) => {
            headers.set(ACCESS_HEADER, "token")?;
            headers.set(TOKEN_HEADER, t)?;
        }
        None => headers.set(ACCESS_HEADER, "owner")?,
    }
    headers.set(CHANNEL_HEADER, key)?;
    let mut init = RequestInit::new();
    init.with_method(method.clone()).with_headers(headers);
    if method == Method::Post {
        let body = req.bytes().await?;
        init.with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    }
    stub(env, key)?
        .fetch_with_request(Request::new_with_init(url.as_str(), &init)?)
        .await
}

/// Ask the channel object for something as its owner.
async fn owner_call(env: &Env, key: &str, method: Method, path: &str) -> Result<Response> {
    let headers = Headers::new();
    headers.set(ACCESS_HEADER, "owner")?;
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    stub(env, key)?
        .fetch_with_request(Request::new_with_init(
            &format!("https://channel{path}"),
            &init,
        )?)
        .await
}

/// The overlay link for OBS. `rotate` replaces it, which disconnects every
/// overlay using the old one.
async fn overlay_link(req: &Request, env: &Env, key: &str, rotate: bool) -> Result<Response> {
    let mut res = if rotate {
        owner_call(env, key, Method::Post, "/overlay-token/rotate").await?
    } else {
        owner_call(env, key, Method::Get, "/overlay-token").await?
    };
    let v: serde_json::Value = res.json().await?;
    let token = v["token"].as_str().unwrap_or_default();
    no_store(Response::from_json(&json!({
        "url": format!("{}/overlay/{key}?token={token}", auth::origin(req)?),
    }))?)
}

/// The channel key of a Sylva channel from its Twitch login, or the
/// response to send when there is none. Only channels with a Sylva account
/// count, so a lookup never makes a new object.
async fn public_key(env: &Env, login: &str) -> Result<std::result::Result<String, Response>> {
    Ok(public_channel(env, login).await?.map(|c| c.key))
}

/// Like [`public_key`], with the streamer's name and picture from Twitch.
async fn public_channel(
    env: &Env,
    login: &str,
) -> Result<std::result::Result<tips::PublicChannel, Response>> {
    let Some(login) = sylva_core::loyalty::login_arg(login).filter(|l| l.len() <= 25) else {
        return Ok(Err(Response::error("No such channel", 404)?));
    };
    let app = twitch_api::App::new(env).await?;
    let (status, v) = app
        .helix(Method::Get, &format!("/users?login={login}"), None)
        .await?;
    let Some(id) = v["data"][0]["id"].as_str().filter(|_| status == 200) else {
        return Ok(Err(Response::error("No such channel", 404)?));
    };
    let key = format!("twitch:{id}");
    if !valid_key(&key) {
        return Ok(Err(Response::error("No such channel", 404)?));
    }
    let dir = env.durable_object("DIRECTORY")?.get_by_name("directory")?;
    let known = auth::post(
        &dir,
        "/lookup",
        &account::Lookup {
            platform: "twitch".into(),
            platform_user_id: id.into(),
        },
    )
    .await?;
    if known.status_code() != 200 {
        return Ok(Err(Response::error(
            "This channel does not use Sylva",
            404,
        )?));
    }
    let user = &v["data"][0];
    let text = |k: &str| user[k].as_str().unwrap_or_default().to_string();
    Ok(Ok(tips::PublicChannel {
        key,
        login: text("login"),
        name: text("display_name"),
        avatar: text("profile_image_url"),
        banner: text("offline_image_url"),
        description: text("description"),
    }))
}

/// The public commands page's data, for anyone: what `!commands` links to.
async fn public_commands(env: &Env, login: &str) -> Result<Response> {
    let key = match public_key(env, login).await? {
        Ok(k) => k,
        Err(res) => return Ok(res),
    };
    let mut res = stub(env, &key)?
        .fetch_with_str("https://channel/public/commands")
        .await?;
    if res.status_code() != 200 {
        return Response::error("This channel's chat bot is off", 404);
    }
    let body = res.text().await?;
    let mut out = Response::ok(body)?;
    out.headers_mut().set("Content-Type", "application/json")?;
    out.headers_mut()
        .set("Cache-Control", "public, max-age=15")?;
    Ok(out)
}

/// `GET /v1/public/{login}/chatstats`: the chat stats page at /c/{login}.
async fn public_chat_stats(env: &Env, login: &str) -> Result<Response> {
    let ch = match public_channel(env, login).await? {
        Ok(c) => c,
        Err(res) => return Ok(res),
    };
    let mut res = stub(env, &ch.key)?
        .fetch_with_str("https://channel/public/chatstats")
        .await?;
    let mut v: serde_json::Value = res.json().await?;
    v["channel"] = json!({ "login": ch.login, "name": ch.name, "avatar": ch.avatar, "banner": ch.banner });
    let mut out = Response::from_json(&v)?;
    out.headers_mut().set("Cache-Control", "public, max-age=15")?;
    Ok(out)
}

/// `GET /v1/public/{login}/profile`: the channel page at /{login}. Says
/// which tabs and links have something behind them.
async fn public_profile(env: &Env, login: &str) -> Result<Response> {
    let ch = match public_channel(env, login).await? {
        Ok(c) => c,
        Err(res) => return Ok(res),
    };
    let mut res = stub(env, &ch.key)?
        .fetch_with_str("https://channel/public/profile")
        .await?;
    let mut v: serde_json::Value = res.json().await?;
    v["login"] = json!(ch.login);
    v["name"] = json!(ch.name);
    v["avatar"] = json!(ch.avatar);
    v["banner"] = json!(ch.banner);
    v["description"] = json!(ch.description);
    let mut out = Response::from_json(&v)?;
    out.headers_mut().set("Cache-Control", "public, max-age=30")?;
    Ok(out)
}

/// The public points page's data, for anyone: the channel's rewards and
/// leaderboard. Twitch turns the login into the channel.
async fn public_store(req: &Request, env: &Env, login: &str) -> Result<Response> {
    let key = match public_key(env, login).await? {
        Ok(k) => k,
        Err(res) => return Ok(res),
    };
    let viewer: String = req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == "viewer")
        .map(|(_, v)| v.chars().take(25).collect())
        .unwrap_or_default();
    let mut res = stub(env, &key)?
        .fetch_with_str(&format!(
            "https://channel/public?viewer={}",
            sylva_core::auth::encode(&viewer)
        ))
        .await?;
    if res.status_code() != 200 {
        return Response::error("This channel has no points", 404);
    }
    let body = res.text().await?;
    let mut out = Response::ok(body)?;
    out.headers_mut().set("Content-Type", "application/json")?;
    out.headers_mut()
        .set("Cache-Control", "public, max-age=15")?;
    Ok(out)
}

fn broadcaster_id(key: &str) -> &str {
    key.split_once(':').map_or("", |(_, id)| id)
}

async fn twitch_status(env: &Env, key: &str) -> Result<Response> {
    let app = twitch_api::App::new(env).await?;
    match twitch_api::channel_status(&app, broadcaster_id(key)).await {
        Ok(features) => no_store(Response::from_json(&json!({ "features": features }))?),
        Err(e) => {
            console_error!("Twitch status for {key} failed: {e}");
            Response::error("Twitch did not answer. Try again in a minute.", 502)
        }
    }
}

async fn twitch_subscribe(env: &Env, key: &str) -> Result<Response> {
    let app = twitch_api::App::new(env).await?;
    let results = match twitch_api::subscribe_channel(&app, broadcaster_id(key), true).await {
        Ok(r) => r,
        Err(e) => {
            console_error!("Subscribing {key} failed: {e}");
            return Response::error("Twitch did not answer. Try again in a minute.", 502);
        }
    };
    let failed: Vec<_> = results.iter().filter(|r| !r.ok).collect();
    if !failed.is_empty() {
        // 403 from Twitch means the permission is gone: sign in again.
        let needs_sign_in = failed.iter().any(|r| r.status == 403);
        return Response::from_json(&json!({ "ok": false, "needsSignIn": needs_sign_in }))
            .map(|r| r.with_status(409));
    }
    twitch_status(env, key).await
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

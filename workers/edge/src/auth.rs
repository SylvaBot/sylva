//! Signing in to Sylva with Twitch, and web sessions.
//!
//! * `GET /auth/twitch/start` sends the browser to Twitch with a fresh `state`
//!   kept in a short lived cookie.
//! * `GET /auth/twitch/callback` checks `state`, trades the code for tokens on
//!   the server (the client secret never reaches the browser), finds or makes
//!   the Sylva account, subscribes the channel's events, starts a session and
//!   sends the browser to the dashboard.
//! * `POST /auth/sign-out` ends the session.
//!
//! Problems send the browser back to `/?signin=<reason>`, where the sign in
//! page says what happened in plain words.
//!
//! `start?next=/device?code=...` returns to that page after signing in, for
//! approving an app. Only Sylva's own `/app` and `/device` pages are allowed.
//!
//! `start?scopes=moderation` (or `loyalty`, or both with a comma) also asks
//! for that feature's scopes (`sylva_core::auth::GRANTS`). Those tokens are
//! kept as a separate grant (see `account::Grant`), so a later plain sign in
//! does not take the feature away.
//!
//! Apps such as Sylva Desktop authenticate with an API token instead of the cookie
//! (`Authorization: Bearer sylva_...`, see `sylva_core::apps`).

use serde_json::json;
use sylva_core::auth::{
    cookie, hash_secret, missing_scopes, parse_key, seal, set_cookie, twitch_authorize_url,
    SessionToken, SESSION_COOKIE, SESSION_DAYS, STATE_COOKIE,
};
use worker::*;

use crate::account::{
    IdentityRecord, LinkRequest, Me, ResolveRequest, ResolveResult, SessionRequest,
};
use crate::twitch_api::{self, subscribe_channel, App};
use crate::util::{random_bytes, random_hex};

/// A signed in request.
pub struct Session {
    pub token: SessionToken,
    pub me: Me,
    /// True when the request used an API token rather than the browser cookie.
    pub via_token: bool,
}

const NEXT_COOKIE: &str = "sylva_next";

/// Where a sign in may return to: Sylva's own dashboard or device page.
fn safe_next(next: &str) -> Option<&str> {
    let ok_path = next == "/app"
        || next.starts_with("/app/")
        || next == "/device"
        || next.starts_with("/device?");
    let ok_chars = next
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/?=&-_".contains(&b));
    (ok_path && ok_chars).then_some(next)
}

pub(crate) fn is_https(req: &Request) -> bool {
    req.url().map(|u| u.scheme() == "https").unwrap_or(false)
}

pub fn origin(req: &Request) -> Result<String> {
    Ok(req.url()?.origin().ascii_serialization())
}

/// True when a browser request comes from Sylva's own pages. Every request
/// that changes something with a session cookie must pass this, which stops
/// other sites from making a signed in browser act (on top of SameSite=Lax).
pub fn same_origin(req: &Request) -> bool {
    let Ok(own) = origin(req) else { return false };
    req.headers()
        .get("Origin")
        .ok()
        .flatten()
        .is_some_and(|o| o == own)
}

fn account_stub(env: &Env, account_id: &str) -> Result<Stub> {
    env.durable_object("ACCOUNT")?
        .get_by_name(&format!("account:{account_id}"))
}

async fn call<T: serde::Serialize>(stub: &Stub, path: &str, body: &T) -> Result<Response> {
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(serde_json::to_string(body)?.into()));
    stub.fetch_with_request(Request::new_with_init(
        &format!("https://account{path}"),
        &init,
    )?)
    .await
}

fn redirect(location: &str, cookies: &[String]) -> Result<Response> {
    let mut res = Response::empty()?.with_status(302);
    let h = res.headers_mut();
    h.set("Location", location)?;
    h.set("Cache-Control", "no-store")?;
    for c in cookies {
        h.append("Set-Cookie", c)?;
    }
    Ok(res)
}

/// The session behind this request's cookie, if it is valid.
pub async fn session(req: &Request, env: &Env) -> Result<Option<Session>> {
    let header = req.headers().get("Cookie")?.unwrap_or_default();
    let Some(token) = cookie(&header, SESSION_COOKIE).and_then(SessionToken::parse) else {
        return Ok(None);
    };
    let stub = account_stub(env, &token.account_id)?;
    let mut res = call(
        &stub,
        "/sessions/check",
        &SessionRequest {
            hash: hash_secret(&token.secret),
            expires_at: 0,
        },
    )
    .await?;
    if res.status_code() != 200 {
        return Ok(None);
    }
    let me: Me = res.json().await?;
    Ok(Some(Session {
        token,
        me,
        via_token: false,
    }))
}

/// The account behind this request: an app's API token, or else the cookie.
pub async fn caller(req: &Request, env: &Env) -> Result<Option<Session>> {
    let header = req.headers().get("Authorization")?.unwrap_or_default();
    let Some(token) = sylva_core::apps::parse_api_token(&header) else {
        return session(req, env).await;
    };
    let mut res = call(
        &account_stub(env, &token.account_id)?,
        "/tokens/check",
        &SessionRequest {
            hash: hash_secret(&token.secret),
            expires_at: 0,
        },
    )
    .await?;
    if res.status_code() != 200 {
        return Ok(None);
    }
    let me: Me = res.json().await?;
    Ok(Some(Session {
        token,
        me,
        via_token: true,
    }))
}

pub(crate) fn account(env: &Env, account_id: &str) -> Result<Stub> {
    account_stub(env, account_id)
}

pub(crate) async fn post<T: serde::Serialize>(
    stub: &Stub,
    path: &str,
    body: &T,
) -> Result<Response> {
    call(stub, path, body).await
}

/// Set while the shared bot account approves Sylva, so the callback knows
/// this is not a sign in.
const BOT_COOKIE: &str = "sylva_bot";

/// `GET /auth/twitch/bot`: the shared bot account approves Sylva to chat as it.
pub async fn bot_start(req: &Request, env: &Env) -> Result<Response> {
    let state = random_hex(16)?;
    let url = sylva_core::auth::twitch_bot_authorize_url(
        &twitch_api::auth_base(env)?,
        &env.var("TWITCH_CLIENT_ID")?.to_string(),
        &format!("{}/auth/twitch/callback", origin(req)?),
        &state,
    );
    let secure = is_https(req);
    redirect(
        &url,
        &[
            set_cookie(STATE_COOKIE, &state, "/auth", 600, secure),
            set_cookie(BOT_COOKIE, "1", "/auth", 600, secure),
        ],
    )
}

/// The end of [`bot_start`]: show the account's id to put in
/// `SYLVA_BOT_USER_ID`. Nothing is stored: sending chat as the bot needs only
/// Sylva's app token and this one approval.
async fn bot_finish(req: &Request, env: &Env, code: &str) -> Result<Response> {
    let redirect_uri = format!("{}/auth/twitch/callback", origin(req)?);
    let tokens = twitch_api::exchange_code(env, code, &redirect_uri).await?;
    let who = twitch_api::validate(env, &tokens.access_token).await?;
    if who.client_id != env.var("TWITCH_CLIENT_ID")?.to_string() {
        return Err(Error::RustError("token was issued to another app".into()));
    }
    let ok = sylva_core::auth::BOT_SCOPES
        .iter()
        .all(|need| who.scopes.iter().any(|s| s == need));
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let bot_id = env
        .var("SYLVA_BOT_USER_ID")
        .map(|v| v.to_string().trim().to_string())
        .unwrap_or_default();
    let mut saved = false;
    if ok && who.user_id == bot_id {
        // Keep the bot's own token, sealed, so it can moderate every channel
        // that makes it a moderator.
        let key = parse_key(&env.secret("SYLVA_TOKEN_KEY")?.to_string())
            .ok_or_else(|| Error::RustError("SYLVA_TOKEN_KEY must be 64 hex characters".into()))?;
        let now = Date::now().as_millis() as i64;
        let res = post(
            &account(env, crate::grants::BOT_ACCOUNT)?,
            "/grant/save",
            &crate::account::Grant {
                purpose: crate::grants::BOT_PURPOSE.into(),
                platform: "twitch".into(),
                platform_user_id: who.user_id.clone(),
                scopes: who.scopes.clone(),
                access_token: seal(&key, random_bytes()?, &tokens.access_token),
                refresh_token: seal(&key, random_bytes()?, &tokens.refresh_token),
                expires_at: now + tokens.expires_in * 1000,
            },
        )
        .await?;
        saved = (200..300).contains(&res.status_code());
    }
    let body = if ok && saved {
        format!(
            "<h1>{} is ready</h1><p>It chats and moderates for Sylva. Each streamer makes it a moderator with /mod {} in their chat.</p>",
            esc(&who.login),
            esc(&who.login)
        )
    } else if ok {
        format!(
            "<h1>{} can chat for Sylva</h1><p>To make it the bot in every channel, set these Worker variables and deploy:</p>\
             <pre>SYLVA_BOT_USER_ID = \"{}\"\nSYLVA_BOT_LOGIN = \"{}\"</pre>",
            esc(&who.login),
            esc(&who.user_id),
            esc(&who.login)
        )
    } else {
        "<h1>Twitch did not grant chat access</h1><p>Try again and choose Authorize.</p>"
            .to_string()
    };
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>Sylva bot account</title><style>body{{font:15px/1.5 system-ui,sans-serif;background:#0e0e10;color:#ededef;max-width:560px;margin:64px auto;padding:0 16px}}\
         h1{{font-size:22px}}pre{{background:#161618;border:1px solid #2c2c31;border-radius:8px;padding:12px;overflow:auto}}</style></head><body>{body}</body></html>"
    );
    let mut res = Response::from_html(html)?;
    let secure = is_https(req);
    let h = res.headers_mut();
    h.set("Cache-Control", "no-store")?;
    h.append(
        "Set-Cookie",
        &set_cookie(STATE_COOKIE, "", "/auth", 0, secure),
    )?;
    h.append(
        "Set-Cookie",
        &set_cookie(BOT_COOKIE, "", "/auth", 0, secure),
    )?;
    Ok(res)
}

pub async fn start(req: &Request, env: &Env) -> Result<Response> {
    let state = random_hex(16)?;
    let asked: Vec<String> = req
        .url()?
        .query_pairs()
        .filter(|(k, _)| k == "scopes")
        .flat_map(|(_, v)| v.split(',').map(str::to_string).collect::<Vec<_>>())
        .collect();
    let extra: Vec<&str> = sylva_core::auth::GRANTS
        .iter()
        .map(|(p, _)| *p)
        .filter(|p| asked.iter().any(|a| a == p))
        .collect();
    let url = twitch_authorize_url(
        &twitch_api::auth_base(env)?,
        &env.var("TWITCH_CLIENT_ID")?.to_string(),
        &format!("{}/auth/twitch/callback", origin(req)?),
        &state,
        &extra,
    );
    let next = req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == "next")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let mut cookies = vec![
        set_cookie(STATE_COOKIE, &state, "/auth", 600, is_https(req)),
        // A bot approval that was left unfinished must not catch this sign in.
        set_cookie(BOT_COOKIE, "", "/auth", 0, is_https(req)),
    ];
    // Cookie values cannot hold every character, so the path goes in as hex.
    if let Some(next) = safe_next(&next) {
        cookies.push(set_cookie(
            NEXT_COOKIE,
            &sylva_core::hex::encode(next),
            "/auth",
            600,
            is_https(req),
        ));
    }
    redirect(&url, &cookies)
}

pub async fn callback(req: &Request, env: &Env) -> Result<Response> {
    let secure = is_https(req);
    let clear_state = set_cookie(STATE_COOKIE, "", "/auth", 0, secure);
    let clear_next = set_cookie(NEXT_COOKIE, "", "/auth", 0, secure);
    let clear_bot = set_cookie(BOT_COOKIE, "", "/auth", 0, secure);
    let fail = |reason: &str| {
        redirect(
            &format!("/?signin={reason}"),
            &[clear_state.clone(), clear_next.clone(), clear_bot.clone()],
        )
    };

    let url = req.url()?;
    let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
    if q.contains_key("error") {
        // The streamer pressed Cancel on Twitch.
        return fail("denied");
    }
    let header = req.headers().get("Cookie")?.unwrap_or_default();
    let next = cookie(&header, NEXT_COOKIE)
        .and_then(|h| sylva_core::hex::decode(h).ok())
        .and_then(|b| String::from_utf8(b).ok())
        .filter(|n| safe_next(n).is_some())
        .unwrap_or_else(|| "/app".into());
    let expected = cookie(&header, STATE_COOKIE).unwrap_or_default();
    let got = q.get("state").map(String::as_str).unwrap_or_default();
    if expected.is_empty() || !crate::constant_time_eq(expected.as_bytes(), got.as_bytes()) {
        return fail("expired");
    }
    let Some(code) = q.get("code") else {
        return fail("expired");
    };

    if cookie(&header, BOT_COOKIE).is_some() {
        return match bot_finish(req, env, code).await {
            Ok(res) => Ok(res),
            Err(e) => {
                console_error!("Bot approval failed: {e}");
                fail("failed")
            }
        };
    }

    match finish_sign_in(req, env, code).await {
        Ok(SignIn::Done(token)) => {
            let max_age = SESSION_DAYS * 86_400;
            redirect(
                &next,
                &[
                    clear_state,
                    clear_next,
                    set_cookie(
                        SESSION_COOKIE,
                        &token.to_cookie_value(),
                        "/",
                        max_age,
                        secure,
                    ),
                ],
            )
        }
        Ok(SignIn::MissingScopes) => fail("scopes"),
        Err(e) => {
            console_error!("Sign in failed: {e}");
            fail("failed")
        }
    }
}

enum SignIn {
    Done(SessionToken),
    MissingScopes,
}

async fn finish_sign_in(req: &Request, env: &Env, code: &str) -> Result<SignIn> {
    let key = parse_key(&env.secret("SYLVA_TOKEN_KEY")?.to_string())
        .ok_or_else(|| Error::RustError("SYLVA_TOKEN_KEY must be 64 hex characters".into()))?;
    let redirect_uri = format!("{}/auth/twitch/callback", origin(req)?);
    let tokens = twitch_api::exchange_code(env, code, &redirect_uri).await?;
    let who = twitch_api::validate(env, &tokens.access_token).await?;
    if who.client_id != env.var("TWITCH_CLIENT_ID")?.to_string() {
        return Err(Error::RustError("token was issued to another app".into()));
    }
    if !missing_scopes(&who.scopes).is_empty() {
        return Ok(SignIn::MissingScopes);
    }

    let user = App::user(env, &tokens.access_token)?;
    let (_, users) = user.helix(Method::Get, "/users", None).await?;
    let u = &users["data"][0];
    let display_name = u["display_name"].as_str().unwrap_or(&who.login).to_string();
    let avatar = u["profile_image_url"]
        .as_str()
        .filter(|s| s.starts_with("https://"))
        .unwrap_or_default()
        .to_string();

    // Find the account for this Twitch user, or make one.
    let mut res = call(
        &env.durable_object("DIRECTORY")?.get_by_name("directory")?,
        "/resolve",
        &ResolveRequest {
            platform: "twitch".into(),
            platform_user_id: who.user_id.clone(),
            new_account_id: random_hex(16)?,
        },
    )
    .await?;
    let resolved: ResolveResult = res.json().await?;
    let account = account_stub(env, &resolved.account_id)?;

    let now = Date::now().as_millis() as i64;
    let channel = sylva_core::twitch::channel_key(&who.user_id);
    let res = call(
        &account,
        "/link",
        &LinkRequest {
            account_id: resolved.account_id.clone(),
            channel: channel.clone(),
            identity: IdentityRecord {
                platform: "twitch".into(),
                platform_user_id: who.user_id.clone(),
                login: who.login.clone(),
                display_name: display_name.clone(),
                avatar: avatar.clone(),
                scopes: who.scopes.clone(),
                access_token: seal(&key, random_bytes()?, &tokens.access_token),
                refresh_token: seal(&key, random_bytes()?, &tokens.refresh_token),
                expires_at: now + tokens.expires_in * 1000,
            },
        },
    )
    .await?;
    if res.status_code() != 200 {
        return Err(Error::RustError(format!(
            "could not save the account ({})",
            res.status_code()
        )));
    }

    // The channels this person helps run. A failure keeps what the account
    // already had, and the next sign in tries again.
    let person = crate::account::Person {
        id: who.user_id.clone(),
        login: who.login.clone(),
        name: display_name,
        avatar,
    };
    if let Err(e) = crate::team::sync(env, &resolved.account_id, person, channel.clone()).await {
        console_error!("Could not list teams for {channel}: {e}");
    }

    // Turn on follows, subs, cheers, chat and the public events. A failure here
    // does not block signing in: the dashboard shows which events are off and
    // has a button to try again.
    match App::new(env).await {
        Ok(app) => {
            if let Err(e) = subscribe_channel(&app, &who.user_id, true).await {
                console_error!("Could not subscribe {channel}: {e}");
            }
        }
        Err(e) => console_error!("No app token for {channel}: {e}"),
    }

    let token = SessionToken {
        account_id: resolved.account_id,
        secret: random_hex(32)?,
    };
    let res = call(
        &account,
        "/sessions",
        &SessionRequest {
            hash: hash_secret(&token.secret),
            expires_at: now + SESSION_DAYS * 86_400_000,
        },
    )
    .await?;
    if res.status_code() >= 300 {
        return Err(Error::RustError("could not start the session".into()));
    }
    Ok(SignIn::Done(token))
}

pub async fn sign_out(req: &Request, env: &Env) -> Result<Response> {
    if !same_origin(req) {
        return Response::error("Forbidden", 403);
    }
    if let Some(s) = session(req, env).await? {
        call(
            &account_stub(env, &s.token.account_id)?,
            "/sessions/delete",
            &SessionRequest {
                hash: hash_secret(&s.token.secret),
                expires_at: 0,
            },
        )
        .await?;
    }
    let mut res = Response::from_json(&json!({"signedOut": true}))?;
    res.headers_mut().append(
        "Set-Cookie",
        &set_cookie(SESSION_COOKIE, "", "/", 0, is_https(req)),
    )?;
    Ok(res)
}

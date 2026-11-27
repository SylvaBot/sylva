//! Apps such as Sylva Desktop: the device code sign in and the API tokens it makes.
//! See `sylva_core::apps` for the flow.
//!
//! * `POST /v1/device/code` (no auth) starts a sign in for an app.
//! * `POST /v1/device/token` (no auth, the private device code) polls for it.
//! * `GET /v1/device?code=` (browser session) says which app asks.
//! * `POST /v1/device` (browser session) approves or denies it.
//! * `GET /v1/apps` lists the account's API tokens; `POST /v1/apps/{id}/revoke`
//!   revokes one (browser session).

use serde::Deserialize;
use serde_json::json;
use sylva_core::apps::{
    api_token, clean_app_name, normalize_user_code, user_code, DeviceCode, DeviceToken,
    DEVICE_CODE_SECS, POLL_SECS,
};
use sylva_core::auth::{hash_secret, open, parse_key, seal, SessionToken};
use worker::*;

use crate::account::{
    DeviceDecide, DeviceLookup, DevicePending, DevicePoll, DevicePollResult, DeviceStart,
    TokenCreate, TokenDelete,
};
use crate::auth::{self, Session};
use crate::util::{random_bytes, random_hex};

fn directory(env: &Env) -> Result<Stub> {
    env.durable_object("DIRECTORY")?.get_by_name("directory")
}

fn key(env: &Env) -> Result<[u8; 32]> {
    parse_key(&env.secret("SYLVA_TOKEN_KEY")?.to_string())
        .ok_or_else(|| Error::RustError("SYLVA_TOKEN_KEY must be 64 hex characters".into()))
}

fn oauth_error(status: u16, error: &str, description: &str) -> Result<Response> {
    let mut res =
        Response::from_json(&json!({ "error": error, "error_description": description }))?
            .with_status(status);
    res.headers_mut().set("Cache-Control", "no-store")?;
    Ok(res)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CodeRequest {
    #[serde(alias = "client_name")]
    client_name: Option<String>,
}

pub async fn device_code(mut req: Request, env: &Env) -> Result<Response> {
    let body: CodeRequest = req.json().await.unwrap_or_default();
    let app_name = clean_app_name(body.client_name.as_deref());
    let device_code = random_hex(32)?;
    let expires_at = Date::now().as_millis() as i64 + DEVICE_CODE_SECS * 1000;
    let origin = auth::origin(&req)?;
    // A clash between two live codes is very unlikely; try a few times.
    for _ in 0..5 {
        let code = user_code(random_bytes()?);
        let res = auth::post(
            &directory(env)?,
            "/device/start",
            &DeviceStart {
                device_hash: hash_secret(&device_code),
                user_code: code.clone(),
                app_name: app_name.clone(),
                expires_at,
            },
        )
        .await?;
        if res.status_code() == 409 {
            continue;
        }
        if res.status_code() >= 300 {
            return Response::error("Could not start the sign in", 500);
        }
        let mut res = Response::from_json(&DeviceCode {
            device_code: device_code.clone(),
            user_code: code.clone(),
            verification_uri: format!("{origin}/device"),
            verification_uri_complete: format!("{origin}/device?code={code}"),
            expires_in: DEVICE_CODE_SECS,
            interval: POLL_SECS,
        })?;
        res.headers_mut().set("Cache-Control", "no-store")?;
        return Ok(res);
    }
    Response::error("Could not start the sign in", 503)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenRequest {
    #[serde(alias = "device_code")]
    device_code: String,
}

pub async fn device_token(mut req: Request, env: &Env) -> Result<Response> {
    let Ok(body) = req.json::<TokenRequest>().await else {
        return oauth_error(
            400,
            "invalid_request",
            "Send the device code as deviceCode.",
        );
    };
    let mut res = auth::post(
        &directory(env)?,
        "/device/poll",
        &DevicePoll {
            device_hash: hash_secret(&body.device_code),
        },
    )
    .await?;
    let poll: DevicePollResult = res.json().await?;
    match poll.status.as_str() {
        "approved" => {
            let key = key(env)?;
            let token = poll
                .sealed_token
                .as_deref()
                .and_then(|s| open(&key, s))
                .ok_or_else(|| Error::RustError("approved without a token".into()))?;
            let mut res = Response::from_json(&DeviceToken {
                access_token: token,
                token_type: "Bearer".into(),
                account_id: poll.account_id.unwrap_or_default(),
            })?;
            res.headers_mut().set("Cache-Control", "no-store")?;
            Ok(res)
        }
        "pending" => oauth_error(
            400,
            "authorization_pending",
            "Waiting for the streamer to approve.",
        ),
        "slow_down" => oauth_error(400, "slow_down", "Poll at most every 5 seconds."),
        "denied" => oauth_error(400, "access_denied", "The streamer said no."),
        _ => oauth_error(400, "expired_token", "This code expired. Start again."),
    }
}

/// Which app a code belongs to, for the approval page.
pub async fn device_lookup(req: &Request, env: &Env) -> Result<Response> {
    let code = req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let Some(code) = normalize_user_code(&code) else {
        return Response::error("That is not a Sylva code. Check it and try again.", 400);
    };
    let mut res = auth::post(
        &directory(env)?,
        "/device/lookup",
        &DeviceLookup {
            user_code: code.clone(),
        },
    )
    .await?;
    if res.status_code() != 200 {
        return Response::error(
            "That code has expired or was already used. Start again in the app.",
            404,
        );
    }
    let pending: DevicePending = res.json().await?;
    Response::from_json(&json!({ "userCode": code, "appName": pending.app_name }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Decision {
    user_code: String,
    approve: bool,
}

pub async fn device_decide(mut req: Request, env: &Env, session: Session) -> Result<Response> {
    let Ok(d) = req.json::<Decision>().await else {
        return Response::error("Send userCode and approve", 400);
    };
    let Some(code) = normalize_user_code(&d.user_code) else {
        return Response::error("That is not a Sylva code. Check it and try again.", 400);
    };
    let dir = directory(env)?;
    if !d.approve {
        let res = auth::post(
            &dir,
            "/device/decide",
            &DeviceDecide {
                user_code: code,
                approve: false,
                account_id: None,
                sealed_token: None,
            },
        )
        .await?;
        if res.status_code() >= 300 {
            return Response::error("That code has expired or was already used.", 404);
        }
        return Response::from_json(&json!({ "approved": false }));
    }

    let mut res = auth::post(
        &dir,
        "/device/lookup",
        &DeviceLookup {
            user_code: code.clone(),
        },
    )
    .await?;
    if res.status_code() != 200 {
        return Response::error(
            "That code has expired or was already used. Start again in the app.",
            404,
        );
    }
    let pending: DevicePending = res.json().await?;

    // Make the token, store only its hash on the account, and hold the token
    // itself (encrypted) until the app picks it up.
    let account_id = session.token.account_id.clone();
    let token = SessionToken {
        account_id: account_id.clone(),
        secret: random_hex(32)?,
    };
    let created = auth::post(
        &auth::account(env, &account_id)?,
        "/tokens",
        &TokenCreate {
            hash: hash_secret(&token.secret),
            id: random_hex(8)?,
            name: pending.app_name.clone(),
        },
    )
    .await?;
    if created.status_code() >= 300 {
        return Response::error("Could not create the app's access", 500);
    }
    let res = auth::post(
        &dir,
        "/device/decide",
        &DeviceDecide {
            user_code: code,
            approve: true,
            account_id: Some(account_id),
            sealed_token: Some(seal(&key(env)?, random_bytes()?, &api_token(&token))),
        },
    )
    .await?;
    if res.status_code() >= 300 {
        return Response::error("That code has expired or was already used.", 404);
    }
    Response::from_json(&json!({ "approved": true, "appName": pending.app_name }))
}

pub async fn list(env: &Env, session: &Session) -> Result<Response> {
    let stub = auth::account(env, &session.token.account_id)?;
    let mut res = stub
        .fetch_with_request(Request::new("https://account/tokens", Method::Get)?)
        .await?;
    // Copy into a fresh response: a Durable Object's reply has fixed headers.
    let list: Vec<sylva_core::apps::AppToken> = res.json().await?;
    Response::from_json(&list)
}

pub async fn revoke(env: &Env, session: &Session, id: &str) -> Result<Response> {
    if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Response::error("Unknown app", 404);
    }
    auth::post(
        &auth::account(env, &session.token.account_id)?,
        "/tokens/delete",
        &TokenDelete { id: id.into() },
    )
    .await?;
    Response::from_json(&json!({ "revoked": true }))
}

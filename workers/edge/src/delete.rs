//! `POST /v1/account/delete`: delete a Sylva account and everything in it.
//!
//! Only the browser session may do this (an app cannot), and the body must
//! name the account's Twitch login, so a stray request cannot delete anyone.
//!
//! Order matters. Twitch comes first: if Twitch does not confirm that it
//! stopped sending the channel's events, nothing is deleted and the streamer
//! can try again. Then the account, its channels, its directory entries and
//! its teams are erased (teammates lose the channel at once), the Twitch
//! tokens are revoked and the cookie is cleared.

use serde::Deserialize;
use serde_json::json;
use sylva_core::auth::{open, parse_key, set_cookie, SESSION_COOKIE};
use worker::*;

use crate::account::{ChannelOnly, Erased, Forget, Forgotten};
use crate::auth::{self, Session};
use crate::channel::ACCESS_HEADER;
use crate::twitch_api::{self, App};

#[derive(Deserialize)]
struct Confirm {
    confirm: String,
}

pub async fn delete_account(mut req: Request, env: &Env, session: Session) -> Result<Response> {
    let logins: Vec<String> = session
        .me
        .identities
        .iter()
        .map(|i| i.login.to_lowercase())
        .collect();
    let confirmed = req
        .json::<Confirm>()
        .await
        .is_ok_and(|c| logins.contains(&c.confirm.trim().to_lowercase()));
    if !confirmed {
        return Response::error("Type your Twitch name to confirm.", 400);
    }

    // 1. Twitch stops sending events for every linked Twitch user.
    let twitch_ids: Vec<&str> = session
        .me
        .identities
        .iter()
        .filter(|i| i.platform == "twitch")
        .map(|i| i.id.as_str())
        .collect();
    if !twitch_ids.is_empty() {
        let app = App::new(env).await?;
        for id in &twitch_ids {
            if let Err(e) = twitch_api::unsubscribe_user(&app, id).await {
                console_error!("Deleting an account stopped at Twitch: {e}");
                return Response::error(
                    "Twitch did not answer, so nothing was deleted. Try again in a minute.",
                    502,
                );
            }
        }
    }

    // 2. The account itself, which hands back its sealed Twitch tokens.
    let account_id = session.token.account_id.clone();
    let mut res = auth::post(&auth::account(env, &account_id)?, "/erase", &json!({})).await?;
    if res.status_code() != 200 {
        return Response::error("Could not delete the account. Try again.", 500);
    }
    let erased: Erased = res.json().await?;

    // 3. Every channel it owned: events, alerts, settings and overlay links.
    for c in session.me.channels.iter().filter(|c| c.role == "owner") {
        let headers = Headers::new();
        headers.set(ACCESS_HEADER, "owner")?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post).with_headers(headers);
        let res = env
            .durable_object("CHANNEL")?
            .get_by_name(&c.key)?
            .fetch_with_request(Request::new_with_init("https://channel/erase", &init)?)
            .await?;
        if res.status_code() >= 300 {
            console_error!("Erasing {} answered {}", c.key, res.status_code());
        }
    }

    // 4. The directory, so the same Twitch account starts fresh next time,
    //    leaves every team, and its own channels' teams lose access.
    let directory = env.durable_object("DIRECTORY")?.get_by_name("directory")?;
    let owned: Vec<String> = session
        .me
        .channels
        .iter()
        .filter(|c| c.role == "owner")
        .map(|c| c.key.clone())
        .collect();
    let mut res = auth::post(
        &directory,
        "/forget",
        &Forget {
            account_id,
            channels: owned,
        },
    )
    .await?;
    if res.status_code() == 200 {
        let forgotten: Forgotten = res.json().await?;
        for d in forgotten.dropped {
            let res = auth::post(
                &auth::account(env, &d.account_id)?,
                "/memberships/remove",
                &ChannelOnly { channel: d.channel },
            )
            .await?;
            if res.status_code() >= 300 {
                console_error!("A teammate kept a deleted channel ({})", res.status_code());
            }
        }
    }

    // 5. Twitch forgets Sylva's tokens (best effort: they may have expired).
    let key = env
        .secret("SYLVA_TOKEN_KEY")
        .ok()
        .and_then(|k| parse_key(&k.to_string()));
    if let Some(key) = key {
        for sealed in &erased.sealed_tokens {
            if let Some(token) = open(&key, sealed) {
                let _ = twitch_api::revoke_token(env, &token).await;
            }
        }
    }

    let mut res = Response::from_json(&json!({ "deleted": true }))?;
    res.headers_mut().set("Cache-Control", "no-store")?;
    res.headers_mut().append(
        "Set-Cookie",
        &set_cookie(SESSION_COOKIE, "", "/", 0, auth::is_https(&req)),
    )?;
    Ok(res)
}

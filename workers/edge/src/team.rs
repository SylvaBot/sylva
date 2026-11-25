//! `/v1/channels/{key}/team`: the owner adds people to help run the channel.
//!
//! The team lives in the directory (see `account`), keyed by Twitch user, so
//! someone can be added before they ever sign in to Sylva. Each change is
//! copied into the teammate's own account at once when they have one, and
//! again at every sign in, so ordinary requests never ask the directory.

use serde::Deserialize;
use serde_json::{json, Value};
use worker::*;

use crate::account::{
    ChannelOnly, Membership, Person, TeamChange, TeamMember, TeamPut, TeamRemove,
};
use crate::auth;
use crate::twitch_api::App;

#[derive(Deserialize)]
struct AddRequest {
    login: String,
    role: String,
}

fn directory(env: &Env) -> Result<Stub> {
    env.durable_object("DIRECTORY")?.get_by_name("directory")
}

fn person(v: &Value) -> Option<Person> {
    Some(Person {
        id: v["id"].as_str()?.to_string(),
        login: v["login"].as_str()?.to_string(),
        name: v["display_name"]
            .as_str()
            .or(v["login"].as_str())?
            .to_string(),
        avatar: v["profile_image_url"]
            .as_str()
            .filter(|s| s.starts_with("https://"))
            .unwrap_or_default()
            .to_string(),
    })
}

/// The team, as the owner's page shows it.
pub async fn list(env: &Env, key: &str) -> Result<Response> {
    let mut res = auth::post(
        &directory(env)?,
        "/team/list",
        &ChannelOnly {
            channel: key.into(),
        },
    )
    .await?;
    let team: Vec<TeamMember> = res.json().await?;
    let mut out = Response::from_json(&json!({
        "team": team,
        "max": sylva_core::team::MAX_TEAM,
    }))?;
    out.headers_mut().set("Cache-Control", "no-store")?;
    Ok(out)
}

/// Tell the teammate's account, if they have one.
async fn apply(env: &Env, change: TeamChange, remove: bool) -> Result<()> {
    let Some(account_id) = change.account_id else {
        return Ok(());
    };
    let stub = auth::account(env, &account_id)?;
    let res = if remove {
        auth::post(
            &stub,
            "/memberships/remove",
            &ChannelOnly {
                channel: change.membership.channel,
            },
        )
        .await?
    } else {
        auth::post(&stub, "/memberships/put", &change.membership).await?
    };
    if res.status_code() >= 300 {
        return Err(Error::RustError(format!(
            "updating a teammate's account answered {}",
            res.status_code()
        )));
    }
    Ok(())
}

/// Add someone by their Twitch name, or change their role.
pub async fn add(mut req: Request, env: &Env, key: &str) -> Result<Response> {
    let Ok(body) = req.json::<AddRequest>().await else {
        return Response::error("Send a Twitch name and a role", 400);
    };
    let Some(login) =
        sylva_core::loyalty::login_arg(&body.login).filter(|l| l.len() <= 25 && l.is_ascii())
    else {
        return Response::error("Type their Twitch name", 400);
    };
    let owner_id = key.strip_prefix("twitch:").unwrap_or_default();
    let app = App::new(env).await?;
    let (status, v) = app
        .helix(
            Method::Get,
            &format!("/users?id={owner_id}&login={login}"),
            None,
        )
        .await?;
    if status != 200 {
        return Response::error("Twitch did not answer. Try again in a minute.", 502);
    }
    let people: Vec<Person> = v["data"]
        .as_array()
        .map(|a| a.iter().filter_map(person).collect())
        .unwrap_or_default();
    let Some(owner) = people.iter().find(|p| p.id == owner_id).cloned() else {
        return Response::error("Twitch did not answer. Try again in a minute.", 502);
    };
    let Some(member) = people.iter().find(|p| p.login == login).cloned() else {
        return Response::error(format!("No Twitch account is called {login}"), 404);
    };
    if member.id == owner.id {
        return Response::error("You own this channel already", 400);
    }
    let mut res = auth::post(
        &directory(env)?,
        "/team/put",
        &TeamPut {
            channel: key.into(),
            owner,
            member,
            role: body.role,
        },
    )
    .await?;
    if res.status_code() != 200 {
        return Ok(res);
    }
    apply(env, res.json().await?, false).await?;
    list(env, key).await
}

pub async fn remove(env: &Env, key: &str, id: &str) -> Result<Response> {
    let mut res = auth::post(
        &directory(env)?,
        "/team/remove",
        &TeamRemove {
            channel: key.into(),
            id: id.into(),
        },
    )
    .await?;
    if res.status_code() != 200 {
        return Ok(res);
    }
    apply(env, res.json().await?, true).await?;
    list(env, key).await
}

/// At sign in: copy the channels this person helps run into their account.
pub async fn sync(env: &Env, account_id: &str, person: Person, channel: String) -> Result<()> {
    let mut res = auth::post(
        &directory(env)?,
        "/team/sign-in",
        &crate::account::TeamSignIn { person, channel },
    )
    .await?;
    if res.status_code() != 200 {
        return Err(Error::RustError(format!(
            "listing teams answered {}",
            res.status_code()
        )));
    }
    let list: Vec<Membership> = res.json().await?;
    let res = auth::post(&auth::account(env, account_id)?, "/memberships/sync", &list).await?;
    if res.status_code() >= 300 {
        return Err(Error::RustError(format!(
            "saving teams answered {}",
            res.status_code()
        )));
    }
    Ok(())
}

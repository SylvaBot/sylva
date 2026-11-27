//! What an overlay needs to draw chat the way Twitch and the emote extensions
//! do: Twitch's badge images, and the channel's 7TV, BetterTTV and
//! FrankerFaceZ emotes with the global ones. Everything here is public, so the
//! route needs no sign in. Each isolate keeps a channel's answer for an hour.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Map, Value};
use worker::*;

use crate::twitch_api::App;

const KEEP_MS: f64 = 3_600_000.0;
const MAX_CACHED: usize = 64;

thread_local! {
    static CACHE: RefCell<HashMap<String, (String, f64)>> = RefCell::new(HashMap::new());
}

/// Ids go into image links, so only plain ones are kept.
fn plain(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn get_json(url: &str) -> Value {
    let Ok(mut res) = Fetch::Url(match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return Value::Null,
    })
    .send()
    .await
    else {
        return Value::Null;
    };
    if res.status_code() != 200 {
        return Value::Null;
    }
    res.json().await.unwrap_or(Value::Null)
}

fn emote(
    out: &mut Map<String, Value>,
    code: Option<&str>,
    provider: &str,
    id: &str,
    urls: [String; 3],
) {
    let Some(code) = code else { return };
    if code.is_empty() || code.len() > 100 || !plain(id) {
        return;
    }
    out.insert(
        code.to_string(),
        json!({ "provider": provider, "id": id, "urls": { "1": urls[0], "2": urls[1], "4": urls[2] } }),
    );
}

fn bttv(out: &mut Map<String, Value>, list: &Value) {
    for e in list.as_array().into_iter().flatten() {
        let id = e["id"].as_str().unwrap_or_default();
        let u = |s: &str| format!("https://cdn.betterttv.net/emote/{id}/{s}.webp");
        emote(
            out,
            e["code"].as_str(),
            "bttv",
            id,
            [u("1x"), u("2x"), u("3x")],
        );
    }
}

fn ffz(out: &mut Map<String, Value>, list: &Value) {
    for e in list.as_array().into_iter().flatten() {
        let id = match &e["id"] {
            Value::Number(n) => n.to_string(),
            v => v.as_str().unwrap_or_default().to_string(),
        };
        let u = |s: &str| format!("https://cdn.frankerfacez.com/emote/{id}/{s}");
        emote(
            out,
            e["code"].as_str(),
            "ffz",
            &id,
            [u("1"), u("2"), u("4")],
        );
    }
}

fn seventv(out: &mut Map<String, Value>, list: &Value) {
    for e in list.as_array().into_iter().flatten() {
        let id = e["id"].as_str().unwrap_or_default();
        let u = |s: &str| format!("https://cdn.7tv.app/emote/{id}/{s}.webp");
        emote(
            out,
            e["name"].as_str(),
            "7tv",
            id,
            [u("1x"), u("2x"), u("4x")],
        );
    }
}

fn badges(out: &mut Map<String, Value>, v: &Value) {
    for set in v["data"].as_array().into_iter().flatten() {
        let set_id = set["set_id"].as_str().unwrap_or_default();
        for ver in set["versions"].as_array().into_iter().flatten() {
            let id = ver["id"].as_str().unwrap_or_default();
            let url = ver["image_url_4x"]
                .as_str()
                .or(ver["image_url_2x"].as_str())
                .or(ver["image_url_1x"].as_str());
            if let Some(url) = url.filter(|u| u.starts_with("https://")) {
                out.insert(format!("{set_id}/{id}"), Value::String(url.to_string()));
            }
        }
    }
}

pub(crate) async fn build(env: &Env, user_id: &str) -> Value {
    let mut b = Map::new();
    if let Ok(app) = App::new(env).await {
        for path in [
            "/chat/badges/global".to_string(),
            format!("/chat/badges?broadcaster_id={user_id}"),
        ] {
            if let Ok((200, v)) = app.helix(Method::Get, &path, None).await {
                badges(&mut b, &v);
            }
        }
    }
    // Globals first, so the channel's own emotes win a shared name; 7TV last.
    let mut e = Map::new();
    ffz(
        &mut e,
        &get_json("https://api.betterttv.net/3/cached/frankerfacez/emotes/global").await,
    );
    bttv(
        &mut e,
        &get_json("https://api.betterttv.net/3/cached/emotes/global").await,
    );
    seventv(
        &mut e,
        &get_json("https://7tv.io/v3/emote-sets/global").await["emotes"],
    );
    ffz(
        &mut e,
        &get_json(&format!(
            "https://api.betterttv.net/3/cached/frankerfacez/users/twitch/{user_id}"
        ))
        .await,
    );
    let channel = get_json(&format!(
        "https://api.betterttv.net/3/cached/users/twitch/{user_id}"
    ))
    .await;
    bttv(&mut e, &channel["sharedEmotes"]);
    bttv(&mut e, &channel["channelEmotes"]);
    seventv(
        &mut e,
        &get_json(&format!("https://7tv.io/v3/users/twitch/{user_id}")).await["emote_set"]
            ["emotes"],
    );
    json!({ "badges": b, "emotes": e })
}

/// `GET /v1/chat-assets/{key}`.
pub async fn chat_assets(env: &Env, key: &str) -> Result<Response> {
    let user_id = key.split_once(':').map(|(_, id)| id).unwrap_or_default();
    let now = Date::now().as_millis() as f64;
    let cached = CACHE.with(|c| {
        c.borrow()
            .get(key)
            .filter(|(_, at)| now - at < KEEP_MS)
            .map(|(b, _)| b.clone())
    });
    let body = match cached {
        Some(b) => b,
        None => {
            let b = build(env, user_id).await.to_string();
            CACHE.with(|c| {
                let mut c = c.borrow_mut();
                if c.len() >= MAX_CACHED {
                    c.clear();
                }
                c.insert(key.to_string(), (b.clone(), now));
            });
            b
        }
    };
    let mut res = Response::ok(body)?;
    let h = res.headers_mut();
    h.set("Content-Type", "application/json")?;
    h.set("Cache-Control", "public, max-age=3600")?;
    Ok(res)
}

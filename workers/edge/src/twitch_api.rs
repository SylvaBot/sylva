//! Calls to Twitch: app and user tokens, Helix, and EventSub subscriptions.
//!
//! Base URLs come from the `TWITCH_AUTH_URL` and `TWITCH_API_URL` vars so the
//! end to end tests can point the Worker at a local fake Twitch.

use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sylva_core::twitch::{channel_subscriptions, Feature};
use worker::*;

/// A Helix caller: the app's client id plus either the app token or a user token.
pub struct App {
    pub client_id: String,
    pub token: String,
    api: String,
}

thread_local! {
    /// App access tokens last about two months. Reuse one per isolate instead
    /// of asking Twitch for a new one on every call.
    static APP_TOKEN: RefCell<Option<(String, i64)>> = const { RefCell::new(None) };
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

fn var(env: &Env, name: &str) -> Result<String> {
    Ok(env.var(name)?.to_string().trim_end_matches('/').to_string())
}

pub fn auth_base(env: &Env) -> Result<String> {
    var(env, "TWITCH_AUTH_URL")
}

async fn post_form(url: &str, pairs: &[(&str, &str)]) -> Result<(u16, Value)> {
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        form.append_pair(k, v);
    }
    let headers = Headers::new();
    headers.set("Content-Type", "application/x-www-form-urlencoded")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(form.finish().into()));
    let mut res = Fetch::Request(Request::new_with_init(url, &init)?)
        .send()
        .await?;
    let status = res.status_code();
    let text = res.text().await?;
    Ok((
        status,
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
    ))
}

impl App {
    /// The app itself, with a cached app access token.
    pub async fn new(env: &Env) -> Result<App> {
        let client_id = env.var("TWITCH_CLIENT_ID")?.to_string();
        let api = var(env, "TWITCH_API_URL")?;
        let cached = APP_TOKEN.with(|t| t.borrow().clone());
        if let Some((token, expires)) = cached {
            if expires > now_ms() {
                return Ok(App {
                    client_id,
                    token,
                    api,
                });
            }
        }
        let secret = env.secret("TWITCH_CLIENT_SECRET")?.to_string();
        let (status, v) = post_form(
            &format!("{}/token", auth_base(env)?),
            &[
                ("client_id", &client_id),
                ("client_secret", &secret),
                ("grant_type", "client_credentials"),
            ],
        )
        .await?;
        let token = match v["access_token"].as_str() {
            Some(t) if status == 200 => t.to_string(),
            _ => {
                return Err(Error::RustError(format!(
                    "Twitch refused the app credentials ({status}). Check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET."
                )))
            }
        };
        // Renew a few minutes early.
        let expires = now_ms() + v["expires_in"].as_i64().unwrap_or(3600) * 1000 - 300_000;
        APP_TOKEN.with(|t| *t.borrow_mut() = Some((token.clone(), expires)));
        Ok(App {
            client_id,
            token,
            api,
        })
    }

    /// Helix as a signed in user.
    pub fn user(env: &Env, user_token: &str) -> Result<App> {
        Ok(App {
            client_id: env.var("TWITCH_CLIENT_ID")?.to_string(),
            token: user_token.to_string(),
            api: var(env, "TWITCH_API_URL")?,
        })
    }

    pub async fn helix(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value)> {
        let headers = Headers::new();
        headers.set("Client-Id", &self.client_id)?;
        headers.set("Authorization", &format!("Bearer {}", self.token))?;
        let mut init = RequestInit::new();
        init.with_method(method);
        if let Some(b) = body {
            headers.set("Content-Type", "application/json")?;
            init.with_body(Some(b.to_string().into()));
        }
        init.with_headers(headers);
        let req = Request::new_with_init(&format!("{}{path}", self.api), &init)?;
        let mut res = Fetch::Request(req).send().await?;
        let status = res.status_code();
        let text = res.text().await?;
        if status == 401 {
            // A revoked or expired app token: forget it so the next call gets a new one.
            APP_TOKEN.with(|t| {
                if t.borrow()
                    .as_ref()
                    .is_some_and(|(tok, _)| *tok == self.token)
                {
                    *t.borrow_mut() = None;
                }
            });
        }
        let v = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok((status, v))
    }

    pub async fn conduit_id(&self) -> Result<Option<String>> {
        let (_, v) = self.helix(Method::Get, "/eventsub/conduits", None).await?;
        Ok(v["data"][0]["id"].as_str().map(String::from))
    }
}

/// What Twitch returns when a sign in code is exchanged.
#[derive(Deserialize)]
pub struct UserTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in: i64,
}

/// What `oauth2/validate` says about a user token.
#[derive(Deserialize)]
pub struct Validated {
    pub client_id: String,
    pub user_id: String,
    pub login: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

pub async fn exchange_code(env: &Env, code: &str, redirect_uri: &str) -> Result<UserTokens> {
    let client_id = env.var("TWITCH_CLIENT_ID")?.to_string();
    let secret = env.secret("TWITCH_CLIENT_SECRET")?.to_string();
    let (status, v) = post_form(
        &format!("{}/token", auth_base(env)?),
        &[
            ("client_id", &client_id),
            ("client_secret", &secret),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ],
    )
    .await?;
    if status != 200 {
        return Err(Error::RustError(format!(
            "Twitch did not accept the sign in code ({status}): {v}"
        )));
    }
    Ok(serde_json::from_value(v)?)
}

pub async fn validate(env: &Env, user_token: &str) -> Result<Validated> {
    let headers = Headers::new();
    headers.set("Authorization", &format!("OAuth {user_token}"))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let req = Request::new_with_init(&format!("{}/validate", auth_base(env)?), &init)?;
    let mut res = Fetch::Request(req).send().await?;
    if res.status_code() != 200 {
        return Err(Error::RustError(format!(
            "Twitch did not validate the new token ({})",
            res.status_code()
        )));
    }
    res.json().await
}

/// The result of one subscription request, for logs and the admin route.
#[derive(Serialize)]
pub struct SubscribeResult {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub status: u16,
    pub ok: bool,
    pub twitch: Value,
}

/// Subscribe a channel's events on the app's conduit. With `signed_in` false
/// only the events that need no permission are made. A 409 means the
/// subscription exists already, which counts as success.
pub async fn subscribe_channel(
    app: &App,
    broadcaster_user_id: &str,
    signed_in: bool,
) -> Result<Vec<SubscribeResult>> {
    let Some(conduit) = app.conduit_id().await? else {
        return Err(Error::RustError(
            "No conduit yet. POST /admin/twitch/conduit first.".into(),
        ));
    };
    let transport = json!({"method": "conduit", "conduit_id": conduit});
    let mut results = Vec::new();
    for spec in channel_subscriptions(broadcaster_user_id) {
        if spec.needs_sign_in && !signed_in {
            continue;
        }
        let (status, v) = app
            .helix(
                Method::Post,
                "/eventsub/subscriptions",
                Some(json!({
                    "type": spec.kind,
                    "version": spec.version,
                    "condition": spec.condition,
                    "transport": transport
                })),
            )
            .await?;
        let ok = status < 300 || status == 409;
        if !ok {
            console_warn!(
                "Subscribing {} for {broadcaster_user_id} failed: {status} {v}",
                spec.kind
            );
        }
        results.push(SubscribeResult {
            kind: spec.kind,
            status,
            ok,
            twitch: v,
        });
    }
    Ok(results)
}

/// One row of the dashboard's "Twitch events" panel.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureStatus {
    pub feature: Feature,
    /// True when every subscription behind the feature is enabled.
    pub on: bool,
    /// Twitch's status for each subscription that is not enabled, such as
    /// `authorization_revoked`, or `missing` when there is none.
    pub problems: Vec<String>,
}

/// Which of a channel's events are flowing, read from Twitch.
pub async fn channel_status(app: &App, broadcaster_user_id: &str) -> Result<Vec<FeatureStatus>> {
    let mut subs: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..5 {
        let mut path = format!("/eventsub/subscriptions?user_id={broadcaster_user_id}");
        if let Some(c) = &cursor {
            path.push_str(&format!("&after={}", sylva_core::auth::encode(c)));
        }
        let (status, v) = app.helix(Method::Get, &path, None).await?;
        if status != 200 {
            return Err(Error::RustError(format!(
                "Twitch did not list subscriptions ({status})"
            )));
        }
        if let Some(data) = v["data"].as_array() {
            subs.extend(data.iter().cloned());
        }
        cursor = v["pagination"]["cursor"].as_str().map(String::from);
        if cursor.is_none() {
            break;
        }
    }

    let mut out: Vec<FeatureStatus> = Vec::new();
    for spec in channel_subscriptions(broadcaster_user_id) {
        let found = subs.iter().find(|s| {
            s["type"] == spec.kind
                && spec
                    .condition
                    .as_object()
                    .is_some_and(|want| want.iter().all(|(k, v)| s["condition"][k] == *v))
        });
        let problem = match found {
            Some(s) if s["status"] == "enabled" => None,
            Some(s) => Some(format!(
                "{}: {}",
                spec.kind,
                s["status"].as_str().unwrap_or("unknown")
            )),
            None => Some(format!("{}: missing", spec.kind)),
        };
        match out.iter_mut().find(|f| f.feature == spec.feature) {
            Some(f) => {
                if let Some(p) = problem {
                    f.on = false;
                    f.problems.push(p);
                }
            }
            None => out.push(FeatureStatus {
                feature: spec.feature,
                on: problem.is_none(),
                problems: problem.into_iter().collect(),
            }),
        }
    }
    Ok(out)
}

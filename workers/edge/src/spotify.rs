//! The streamer's Spotify connection, in the channel's Durable Object.
//!
//! Song requests play in the streamer's own Spotify app, driven by Sylva
//! Control through Spotify's Web API. The streamer connects Spotify once on
//! the Song requests page (OAuth with PKCE, so Sylva needs no Spotify client
//! secret). The refresh token is sealed with `SYLVA_TOKEN_KEY` and stays
//! here: `!sr` searches Spotify with it, and Sylva Control asks for a short
//! lived access token (`GET songs/spotify/token`, owner only) to play.
//!
//! `SPOTIFY_CLIENT_ID` names the Spotify app. Its redirect URI must be
//! `{site}/auth/spotify/callback`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sylva_core::auth::{open, parse_key, seal};
use sylva_core::songs::{pkce_challenge, SpotifyLink};
use worker::*;

use crate::channel::ChannelDo;
use crate::util::{random_bytes, random_hex};

const ACCOUNTS: &str = "https://accounts.spotify.com";
const API: &str = "https://api.spotify.com/v1";
const SCOPES: &str = "user-read-playback-state user-modify-playback-state user-read-private";
const TIMEOUT_MS: u32 = 6_000;
/// A sign in started this long ago is no longer accepted.
const PKCE_TTL_MS: i64 = 15 * 60_000;

#[derive(Serialize, Deserialize)]
struct Pending {
    verifier: String,
    state: String,
    redirect: String,
    at: i64,
}

#[derive(Serialize, Deserialize)]
struct Access {
    token: String,
    /// Milliseconds since 1970.
    exp: i64,
}

fn now() -> i64 {
    Date::now().as_millis() as i64
}

fn form(pairs: &[(&str, &str)]) -> String {
    let mut u = Url::parse("https://x/").expect("a valid address");
    u.query_pairs_mut().extend_pairs(pairs);
    u.query().unwrap_or("").to_string()
}

async fn send(req: Request) -> Option<(u16, Value)> {
    let signal = AbortSignal::from(web_sys::AbortSignal::timeout_with_u32(TIMEOUT_MS));
    let mut res = Fetch::Request(req).send_with_signal(&signal).await.ok()?;
    let status = res.status_code();
    let v = res.json().await.unwrap_or(Value::Null);
    Some((status, v))
}

impl ChannelDo {
    fn spotify_client_id(&self) -> Option<String> {
        self.var("SPOTIFY_CLIENT_ID").filter(|s| !s.is_empty())
    }

    fn spotify_seal_key(&self) -> Result<[u8; 32]> {
        parse_key(&self.env.secret("SYLVA_TOKEN_KEY")?.to_string())
            .ok_or_else(|| Error::RustError("SYLVA_TOKEN_KEY is not a 64 character hex key".into()))
    }

    fn sealed(&self, key: &str) -> Result<Option<String>> {
        match self.config(key)?.filter(|v| !v.is_empty()) {
            Some(v) => Ok(open(&self.spotify_seal_key()?, &v)),
            None => Ok(None),
        }
    }

    fn set_sealed(&self, key: &str, value: &str) -> Result<()> {
        self.set_config(
            key,
            &seal(&self.spotify_seal_key()?, random_bytes()?, value),
        )
    }

    pub(crate) fn spotify_link(&self) -> Result<SpotifyLink> {
        let connected = self
            .config("spotify_refresh")?
            .is_some_and(|v| !v.is_empty());
        Ok(SpotifyLink {
            ready: self.spotify_client_id().is_some(),
            name: if connected {
                self.config("spotify_name")?.filter(|n| !n.is_empty())
            } else {
                None
            },
            premium: connected && self.config("spotify_premium")?.as_deref() == Some("1"),
        })
    }

    /// Start a sign in: the Spotify page to send the streamer to.
    pub(crate) fn spotify_connect(
        &self,
        origin: &str,
    ) -> Result<std::result::Result<String, String>> {
        let Some(client_id) = self.spotify_client_id() else {
            return Ok(Err("Spotify is not set up on this Sylva server yet.".into()));
        };
        let Some(key) = self.key() else {
            return Ok(Err("Open the dashboard once more, then try again.".into()));
        };
        let p = Pending {
            verifier: random_hex(32)?,
            state: format!("{key}.{}", random_hex(16)?),
            redirect: format!("{origin}/auth/spotify/callback"),
            at: now(),
        };
        let url = format!(
            "{ACCOUNTS}/authorize?{}",
            form(&[
                ("client_id", &client_id),
                ("response_type", "code"),
                ("redirect_uri", &p.redirect),
                ("scope", SCOPES),
                ("state", &p.state),
                ("code_challenge_method", "S256"),
                ("code_challenge", &pkce_challenge(&p.verifier)),
            ])
        );
        self.set_config("spotify_pkce", &serde_json::to_string(&p)?)?;
        Ok(Ok(url))
    }

    /// Spotify sent the streamer back. Returns where to send them next.
    pub(crate) async fn spotify_callback(&self, code: &str, state: &str) -> Result<String> {
        let pending: Option<Pending> = self
            .config("spotify_pkce")?
            .and_then(|v| serde_json::from_str(&v).ok());
        let Some(p) = pending.filter(|p| p.state == state && now() - p.at < PKCE_TTL_MS) else {
            return Ok("/app/songs?spotify=expired".into());
        };
        self.set_config("spotify_pkce", "")?;
        let client_id = self.spotify_client_id().unwrap_or_default();
        let body = form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &p.redirect),
            ("client_id", &client_id),
            ("code_verifier", &p.verifier),
        ]);
        let Some(access) = self.spotify_tokens(body).await? else {
            return Ok("/app/songs?spotify=failed".into());
        };
        if let Some((200, me)) = self.spotify_call(Method::Get, "/me", None, &access).await {
            let name = me["display_name"]
                .as_str()
                .or(me["id"].as_str())
                .unwrap_or("Spotify");
            self.set_config("spotify_name", name)?;
            let premium = me["product"].as_str() == Some("premium");
            self.set_config("spotify_premium", if premium { "1" } else { "0" })?;
        }
        Ok("/app/songs?spotify=connected".into())
    }

    /// Ask Spotify's token endpoint, save what it gives, return the access token.
    async fn spotify_tokens(&self, body: String) -> Result<Option<String>> {
        let headers = Headers::new();
        headers.set("Content-Type", "application/x-www-form-urlencoded")?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(body.into()));
        let req = Request::new_with_init(&format!("{ACCOUNTS}/api/token"), &init)?;
        let Some((200, v)) = send(req).await else {
            return Ok(None);
        };
        let Some(token) = v["access_token"].as_str() else {
            return Ok(None);
        };
        // Spotify may hand out a new refresh token; the old one then stops working.
        if let Some(r) = v["refresh_token"].as_str() {
            self.set_sealed("spotify_refresh", r)?;
        }
        let exp = now() + v["expires_in"].as_i64().unwrap_or(3600) * 1000;
        let a = Access {
            token: token.into(),
            exp,
        };
        self.set_sealed("spotify_access", &serde_json::to_string(&a)?)?;
        Ok(Some(token.into()))
    }

    /// A working access token and when it expires, or words for the streamer.
    pub(crate) async fn spotify_access(
        &self,
        fresh: bool,
    ) -> Result<std::result::Result<(String, i64), String>> {
        let Some(refresh) = self.sealed("spotify_refresh")? else {
            return Ok(Err(
                "Connect Spotify on the Song requests page first.".into()
            ));
        };
        if !fresh {
            if let Some(a) = self
                .sealed("spotify_access")?
                .and_then(|s| serde_json::from_str::<Access>(&s).ok())
            {
                if a.exp - now() > 120_000 {
                    return Ok(Ok((a.token, a.exp)));
                }
            }
        }
        let client_id = self.spotify_client_id().unwrap_or_default();
        let body = form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", &client_id),
        ]);
        match self.spotify_tokens(body).await? {
            Some(token) => {
                let exp = self
                    .sealed("spotify_access")?
                    .and_then(|s| serde_json::from_str::<Access>(&s).ok())
                    .map(|a| a.exp)
                    .unwrap_or(now() + 3_600_000);
                Ok(Ok((token, exp)))
            }
            None => Ok(Err(
                "Spotify did not accept the saved sign in. Connect Spotify again.".into(),
            )),
        }
    }

    pub(crate) fn spotify_disconnect(&self) -> Result<()> {
        for k in [
            "spotify_refresh",
            "spotify_access",
            "spotify_name",
            "spotify_premium",
            "spotify_pkce",
        ] {
            self.set_config(k, "")?;
        }
        Ok(())
    }

    async fn spotify_call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> Option<(u16, Value)> {
        let headers = Headers::new();
        headers
            .set("Authorization", &format!("Bearer {token}"))
            .ok()?;
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(headers);
        if let Some(b) = body {
            init.with_body(Some(b.to_string().into()));
        }
        send(Request::new_with_init(&format!("{API}{path}"), &init).ok()?).await
    }

    /// GET from the Web API as the streamer, refreshing once on a 401.
    /// `Err` is worded for chat.
    pub(crate) async fn spotify_get(
        &self,
        path: &str,
    ) -> Result<std::result::Result<Value, String>> {
        let (token, _) = match self.spotify_access(false).await? {
            Ok(t) => t,
            Err(_) => {
                return Ok(Err(
                    "Song requests need Spotify, and it is not connected yet.".into(),
                ))
            }
        };
        let mut got = self.spotify_call(Method::Get, path, None, &token).await;
        if matches!(got, Some((401, _))) {
            if let Ok((token, _)) = self.spotify_access(true).await? {
                got = self.spotify_call(Method::Get, path, None, &token).await;
            }
        }
        Ok(match got {
            Some((200, v)) => Ok(v),
            Some((404, _)) => Err("Spotify has no such song.".into()),
            Some((429, _)) => Err("Spotify is busy. Try again in a minute.".into()),
            _ => Err("Spotify did not answer. Try again in a minute.".into()),
        })
    }

    /// `songs/spotify/...` from the dashboard and Sylva Control (owner only).
    pub(crate) async fn spotify_route(
        &self,
        req: &Request,
        post: bool,
        rest: &[&str],
    ) -> Result<Option<Response>> {
        Ok(Some(match (post, rest) {
            (true, ["connect"]) => {
                let origin = crate::auth::origin(req)?;
                match self.spotify_connect(&origin)? {
                    Ok(url) => Response::from_json(&json!({ "url": url }))?,
                    Err(m) => Response::error(m, 400)?,
                }
            }
            (true, ["disconnect"]) => {
                self.spotify_disconnect()?;
                return Ok(None);
            }
            (false, ["token"]) => {
                // `?fresh=1` when Spotify turned the last token down.
                let fresh = req
                    .url()?
                    .query_pairs()
                    .any(|(k, v)| k == "fresh" && v == "1");
                match self.spotify_access(fresh).await? {
                    Ok((token, exp)) => {
                        let mut r = Response::from_json(
                            &json!({ "accessToken": token, "expiresAt": exp }),
                        )?;
                        r.headers_mut().set("Cache-Control", "no-store")?;
                        r
                    }
                    Err(m) => Response::error(m, 409)?,
                }
            }
            _ => Response::error("Not found", 404)?,
        }))
    }
}

//! Tips through each streamer's own Stripe account (Stripe Connect with
//! direct charges: the payment is made on the streamer's account, so money
//! never passes through Sylva, and Stripe handles payouts and taxes).
//!
//! The rules (limits, holds, blocklist decisions) are in `sylva_core::tips`.
//! Here is everything that talks to Stripe, Workers AI and storage:
//! * Worker routes: the public tip page's data (`GET/POST /v1/public/{login}/tip`),
//!   a tip's status, Stripe's webhook (`POST /stripe/webhook`), the spoken
//!   message (`GET /tts/{key}/{id}`) and Apple Pay's domain file.
//! * In the channel object: the `tips` table, the streamer's settings,
//!   connecting Stripe, checking and charging a tip, holding or releasing it
//!   into the alert queue, refunds, blocklists and dispute evidence.
//!
//! Secrets (set by whoever runs Sylva, never in the repository):
//! `STRIPE_SECRET_KEY` (the platform's secret key), `STRIPE_PUBLISHABLE_KEY`
//! and `STRIPE_WEBHOOK_SECRET` (the signing secret of the Connect webhook).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sylva_core::protocol::{Role, ServerFrame};
use sylva_core::tips::{self as rules, Form, HoldMode, TipSettings};
use sylva_core::{Actor, Event, EventKind, Platform};
use worker::*;

use crate::channel::ChannelDo;
use crate::util::random_hex;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS tips (
    id            TEXT PRIMARY KEY,
    intent        TEXT,
    charge        TEXT,
    amount        INTEGER NOT NULL,
    currency      TEXT NOT NULL,
    base          REAL NOT NULL,
    name          TEXT NOT NULL,
    message       TEXT NOT NULL,
    email_hash    TEXT NOT NULL,
    email_hint    TEXT NOT NULL,
    ip            TEXT NOT NULL,
    ip_hash       TEXT NOT NULL,
    ip_country    TEXT,
    card_country  TEXT,
    card_hash     TEXT,
    method        TEXT,
    status        TEXT NOT NULL,
    verified      INTEGER NOT NULL DEFAULT 0,
    risk          TEXT,
    hold_reason   TEXT,
    needs_ok      INTEGER NOT NULL DEFAULT 0,
    release_at    INTEGER,
    created_at    INTEGER NOT NULL,
    agreed_at     INTEGER NOT NULL,
    paid_at       INTEGER,
    released_at   INTEGER,
    shown_at      INTEGER,
    live          INTEGER NOT NULL DEFAULT 0,
    event_seq     INTEGER,
    clip          TEXT,
    dispute       TEXT,
    dispute_status TEXT,
    evidence_at   INTEGER,
    blocked       INTEGER NOT NULL DEFAULT 0,
    note          TEXT
);
CREATE INDEX IF NOT EXISTS tips_intent ON tips (intent);
CREATE INDEX IF NOT EXISTS tips_charge ON tips (charge);
CREATE INDEX IF NOT EXISTS tips_status ON tips (status, created_at);
CREATE INDEX IF NOT EXISTS tips_email ON tips (email_hash);
CREATE INDEX IF NOT EXISTS tips_ip ON tips (ip_hash, created_at);
CREATE TABLE IF NOT EXISTS tts (
    id         TEXT PRIMARY KEY,
    audio      TEXT NOT NULL,
    ms         INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tip_voice (
    id         TEXT PRIMARY KEY,
    voice      TEXT NOT NULL,
    created_at INTEGER NOT NULL
)";

/// The stand-in voice for tips, made on the server.
const TTS_FALLBACK: &str = "@cf/deepgram/aura-2-en";


fn now() -> i64 {
    Date::now().as_millis() as i64
}

/// Whether whoever runs Sylva has set up the Stripe platform account.
/// Sylva runs on Stripe test keys (a sandbox): every tip is a test.
pub(crate) fn test_mode(env: &Env) -> bool {
    env.secret("STRIPE_SECRET_KEY").is_ok_and(|v| {
        let k = v.to_string();
        k.starts_with("sk_test_") || k.starts_with("rk_test_")
    })
}

pub(crate) fn platform_ready(env: &Env) -> bool {
    [
        "STRIPE_SECRET_KEY",
        "STRIPE_PUBLISHABLE_KEY",
        "STRIPE_WEBHOOK_SECRET",
    ]
    .iter()
    .all(|k| env.secret(k).is_ok_and(|v| !v.to_string().is_empty()))
}

/// One call to Stripe's API. `account` makes the call on a streamer's
/// connected account. Returns the status and the JSON body.
pub(crate) async fn stripe(
    env: &Env,
    method: Method,
    path: &str,
    account: Option<&str>,
    form: Option<&Form>,
    idempotency: Option<&str>,
) -> Result<(u16, Value)> {
    let key = env.secret("STRIPE_SECRET_KEY")?.to_string();
    let headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {key}"))?;
    headers.set("Stripe-Version", rules::STRIPE_VERSION)?;
    if let Some(a) = account {
        headers.set("Stripe-Account", a)?;
    }
    if let Some(i) = idempotency {
        headers.set("Idempotency-Key", i)?;
    }
    let mut url = format!("https://api.stripe.com/v1{path}");
    let mut init = RequestInit::new();
    if let Some(f) = form {
        if method == Method::Get {
            url = format!("{url}?{}", f.encode());
        } else {
            headers.set("Content-Type", "application/x-www-form-urlencoded")?;
            init.with_body(Some(f.encode().into()));
        }
    }
    init.with_method(method).with_headers(headers);
    let mut res = Fetch::Request(Request::new_with_init(&url, &init)?)
        .send()
        .await?;
    let status = res.status_code();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, body))
}

/// One call to Stripe's v2 API (JSON bodies), used for connected accounts.
pub(crate) async fn stripe_v2(
    env: &Env,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(u16, Value)> {
    let key = env.secret("STRIPE_SECRET_KEY")?.to_string();
    let headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {key}"))?;
    headers.set("Stripe-Version", rules::STRIPE_V2_VERSION)?;
    let mut init = RequestInit::new();
    if let Some(b) = body {
        headers.set("Content-Type", "application/json")?;
        init.with_body(Some(serde_json::to_string(b)?.into()));
    }
    init.with_method(method).with_headers(headers);
    let url = format!("https://api.stripe.com/v2{path}");
    let mut res = Fetch::Request(Request::new_with_init(&url, &init)?)
        .send()
        .await?;
    let status = res.status_code();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, body))
}

fn stripe_error(v: &Value) -> String {
    v["error"]["message"]
        .as_str()
        .unwrap_or("Stripe did not answer")
        .to_string()
}

fn header(req: &Request, name: &str) -> String {
    req.headers().get(name).ok().flatten().unwrap_or_default()
}

/* ---------------- Worker routes ---------------- */

/// A Sylva channel from its Twitch login, with the streamer's name and picture.
pub(crate) struct PublicChannel {
    pub key: String,
    pub login: String,
    pub name: String,
    pub avatar: String,
    /// The Twitch offline image, the closest thing Twitch's API has to a banner.
    pub banner: String,
}

/// `GET /v1/public/{login}/tip`: what the tip page needs.
pub(crate) async fn public_config(req: &Request, env: &Env, ch: PublicChannel) -> Result<Response> {
    let country = req.cf().and_then(|cf| cf.country()).unwrap_or_default();
    let mut res = crate::stub(env, &ch.key)?
        .fetch_with_str(&format!(
            "https://channel/public/tips?country={}",
            sylva_core::auth::encode(&country)
        ))
        .await?;
    let mut v: Value = res.json().await?;
    v["login"] = json!(ch.login);
    v["name"] = json!(ch.name);
    v["avatar"] = json!(ch.avatar);
    v["banner"] = json!(ch.banner);
    v["key"] = json!(ch.key);
    let ready = platform_ready(env);
    v["open"] = json!(ready && v["open"].as_bool().unwrap_or(false));
    v["testMode"] = json!(test_mode(env));
    if ready {
        v["publishableKey"] = json!(env.secret("STRIPE_PUBLISHABLE_KEY")?.to_string());
    }
    let mut out = Response::from_json(&v)?;
    out.headers_mut().set("Cache-Control", "no-store")?;
    Ok(out)
}

/// `POST /v1/public/{login}/tip`: check and charge a tip.
pub(crate) async fn public_create(mut req: Request, env: &Env, key: &str) -> Result<Response> {
    if !platform_ready(env) {
        return Response::error("Tips are not open yet.", 503);
    }
    // Cloudflare sets this; a client cannot.
    let ip = header(&req, "CF-Connecting-IP");
    let country = req.cf().and_then(|cf| cf.country()).unwrap_or_default();
    let body = req.bytes().await?;
    if body.len() > 8192 {
        return Response::error("Too long", 413);
    }
    let headers = Headers::new();
    headers.set("X-Sylva-Ip", &ip)?;
    headers.set("X-Sylva-Country", &country)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    crate::stub(env, key)?
        .fetch_with_request(Request::new_with_init(
            "https://channel/public/tips",
            &init,
        )?)
        .await
}

/// `POST /stripe/webhook`: events from streamers' Stripe accounts.
pub(crate) async fn webhook(mut req: Request, env: &Env) -> Result<Response> {
    let Ok(secret) = env.secret("STRIPE_WEBHOOK_SECRET") else {
        return Response::error("Not set up", 503);
    };
    let signature = header(&req, "Stripe-Signature");
    let body = req.bytes().await?;
    let now_s = now() / 1000;
    if let Err(e) = rules::verify_stripe(&secret.to_string(), &signature, &body, now_s) {
        console_warn!("Rejected Stripe webhook: {e}");
        return Response::error("Bad signature", 400);
    }
    let event: Value = serde_json::from_slice(&body)?;
    let Some(account) = event["account"].as_str() else {
        // An event on Sylva's own account: nothing to do.
        return Response::ok("ignored");
    };
    let dir = env.durable_object("DIRECTORY")?.get_by_name("directory")?;
    let mut found = crate::auth::post(
        &dir,
        "/stripe/channel",
        &crate::account::StripeLink {
            account: account.into(),
            channel: String::new(),
        },
    )
    .await?;
    if found.status_code() != 200 {
        return Response::ok("unknown account");
    }
    let v: Value = found.json().await?;
    let channel = v["channel"].as_str().unwrap_or_default().to_string();
    if !crate::valid_key(&channel) {
        return Response::ok("unknown account");
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(serde_json::to_string(&event)?.into()));
    let res = crate::stub(env, &channel)?
        .fetch_with_request(Request::new_with_init(
            "https://channel/stripe-event",
            &init,
        )?)
        .await?;
    if res.status_code() >= 300 {
        // Stripe retries anything that is not 2xx.
        return Response::error("Could not handle the event", 500);
    }
    Response::ok("ok")
}

/// Apple Pay checks this file on the tip page's domain before it shows.
pub(crate) async fn apple_pay_file() -> Result<Response> {
    let mut res = Fetch::Url(Url::parse(
        "https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association",
    )?)
    .send()
    .await?;
    if res.status_code() != 200 {
        return Response::error("Not found", 404);
    }
    let bytes = res.bytes().await?;
    let mut out = Response::from_bytes(bytes)?;
    out.headers_mut().set("Content-Type", "text/plain")?;
    out.headers_mut()
        .set("Cache-Control", "public, max-age=86400")?;
    Ok(out)
}

/// Blocklist calls to the directory.
async fn directory_blocked(env: &Env, hashes: Vec<String>) -> Result<bool> {
    let dir = env.durable_object("DIRECTORY")?.get_by_name("directory")?;
    let mut res = crate::auth::post(
        &dir,
        "/tips/blocked",
        &crate::account::TipBlock {
            hashes,
            reason: String::new(),
        },
    )
    .await?;
    let v: Value = res.json().await.unwrap_or(Value::Null);
    Ok(v["blocked"].as_bool().unwrap_or(false))
}

async fn directory_block(env: &Env, hashes: Vec<String>, reason: &str) -> Result<()> {
    if hashes.is_empty() {
        return Ok(());
    }
    let dir = env.durable_object("DIRECTORY")?.get_by_name("directory")?;
    crate::auth::post(
        &dir,
        "/tips/block",
        &crate::account::TipBlock {
            hashes,
            reason: reason.into(),
        },
    )
    .await?;
    Ok(())
}

/* ---------------- Rows and views ---------------- */

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
pub(crate) struct TipRow {
    id: String,
    intent: Option<String>,
    charge: Option<String>,
    amount: f64,
    currency: String,
    base: f64,
    name: String,
    message: String,
    email_hash: String,
    email_hint: String,
    ip: String,
    ip_hash: String,
    ip_country: Option<String>,
    card_country: Option<String>,
    card_hash: Option<String>,
    method: Option<String>,
    status: String,
    verified: f64,
    risk: Option<String>,
    hold_reason: Option<String>,
    needs_ok: f64,
    release_at: Option<f64>,
    created_at: f64,
    agreed_at: f64,
    paid_at: Option<f64>,
    released_at: Option<f64>,
    shown_at: Option<f64>,
    live: f64,
    clip: Option<String>,
    dispute: Option<String>,
    dispute_status: Option<String>,
    evidence_at: Option<f64>,
    blocked: f64,
    note: Option<String>,
}

/// A tip as the dashboard and Sylva Desktop see it. No IP address or email.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TipView {
    id: String,
    name: String,
    message: String,
    amount: f64,
    currency: String,
    base: f64,
    email: String,
    method: Option<String>,
    status: String,
    verified: bool,
    risk: Option<String>,
    hold_reason: Option<String>,
    needs_approval: bool,
    release_at: Option<i64>,
    created_at: i64,
    paid_at: Option<i64>,
    shown_at: Option<i64>,
    country: Option<String>,
    card_country: Option<String>,
    clip: Option<String>,
    dispute_status: Option<String>,
    evidence_sent: bool,
    blocked: bool,
    note: Option<String>,
    /// Paid with Stripe test keys.
    test: bool,
}

impl TipRow {
    fn currency(&self) -> &'static rules::Currency {
        rules::currency(&self.currency).unwrap_or(&rules::CURRENCIES[0])
    }
    fn paid_amount(&self) -> f64 {
        rules::from_minor(self.amount as i64, self.currency())
    }
    fn view(&self) -> TipView {
        TipView {
            id: self.id.clone(),
            name: self.name.clone(),
            message: self.message.clone(),
            amount: self.paid_amount(),
            currency: self.currency.clone(),
            base: self.base,
            email: self.email_hint.clone(),
            method: self.method.clone(),
            status: self.status.clone(),
            verified: self.verified > 0.0,
            risk: self.risk.clone(),
            hold_reason: self.hold_reason.clone(),
            needs_approval: self.needs_ok > 0.0 || self.release_at.is_none(),
            release_at: self.release_at.map(|t| t as i64),
            created_at: self.created_at as i64,
            paid_at: self.paid_at.map(|t| t as i64),
            shown_at: self.shown_at.map(|t| t as i64),
            country: self.ip_country.clone(),
            card_country: self.card_country.clone(),
            clip: self.clip.clone(),
            dispute_status: self.dispute_status.clone(),
            evidence_sent: self.evidence_at.is_some(),
            blocked: self.blocked > 0.0,
            note: self.note.clone(),
            test: self.id.starts_with("tip_test_"),
        }
    }
    /// Everything that identifies the tipper, for blocklists.
    fn hashes(&self, with_ip: bool) -> Vec<String> {
        let mut h = vec![self.email_hash.clone()];
        if let Some(c) = &self.card_hash {
            h.push(c.clone());
        }
        if with_ip {
            h.push(self.ip_hash.clone());
        }
        h
    }
}

#[derive(Deserialize)]
struct CountRow {
    n: f64,
}

#[derive(Deserialize)]
struct NumRow {
    value: Option<f64>,
}

#[derive(Deserialize)]
struct TtsRow {
    audio: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewTip {
    amount: f64,
    currency: String,
    name: String,
    /// Optional: the tip page no longer asks for it.
    #[serde(default)]
    email: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    agreed: bool,
    confirmation_token: String,
    /// The Kokoro voice the tipper picked.
    #[serde(default)]
    voice: String,
}

#[derive(Deserialize, Default)]
struct ConnectBody {
    #[serde(default)]
    country: String,
}

/// The streamer's Stripe account, as Sylva last saw it.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct AccountState {
    id: String,
    country: String,
    charges_enabled: bool,
    details_submitted: bool,
    /// Things Stripe still needs before payouts or payments work.
    due: u32,
    domain: String,
    /// Stripe's own card payments status (active, pending, restricted...).
    stripe_status: String,
    /// Stripe's reason codes when card payments are not active yet.
    reasons: Vec<String>,
    /// What Stripe still wants, in its own words (requirement names).
    needs: Vec<String>,
}

fn error(message: &str, status: u16) -> Result<Response> {
    Response::error(message, status)
}

/* ---------------- The channel's side ---------------- */

impl ChannelDo {
    pub(crate) fn tip_settings(&self) -> Result<TipSettings> {
        Ok(self
            .config("tip_settings")?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    }

    fn stripe_account(&self) -> Result<Option<AccountState>> {
        Ok(self
            .config("stripe_account")?
            .and_then(|s| serde_json::from_str::<AccountState>(&s).ok())
            .filter(|a| !a.id.is_empty()))
    }

    fn save_account(&self, a: &AccountState) -> Result<()> {
        self.set_config("stripe_account", &serde_json::to_string(a)?)
    }

    fn pepper(&self) -> Result<String> {
        Ok(self.env.secret("SYLVA_TOKEN_KEY")?.to_string())
    }

    fn tip(&self, id: &str) -> Result<Option<TipRow>> {
        Ok(self
            .sql
            .exec("SELECT * FROM tips WHERE id = ?", vec![id.into()])?
            .to_array::<TipRow>()?
            .into_iter()
            .next())
    }

    fn tip_by(&self, column: &str, value: &str) -> Result<Option<TipRow>> {
        let col = match column {
            "intent" => "intent",
            _ => "charge",
        };
        Ok(self
            .sql
            .exec(
                &format!("SELECT * FROM tips WHERE {col} = ? LIMIT 1"),
                vec![value.into()],
            )?
            .to_array::<TipRow>()?
            .into_iter()
            .next())
    }

    fn set_tip(&self, id: &str, sets: &str, values: Vec<SqlStorageValue>) -> Result<()> {
        let mut v = values;
        v.push(id.into());
        self.sql
            .exec(&format!("UPDATE tips SET {sets} WHERE id = ?"), v)?;
        Ok(())
    }

    fn tip_count(&self, query: &str, values: Vec<SqlStorageValue>) -> Result<u32> {
        Ok(self
            .sql
            .exec(query, values)?
            .to_array::<CountRow>()?
            .first()
            .map_or(0, |r| r.n as u32))
    }

    /// Whether this person has a tip here that went through and stayed.
    fn known_tipper(
        &self,
        email_hash: &str,
        card_hash: Option<&str>,
        except: &str,
    ) -> Result<bool> {
        Ok(self.tip_count(
            "SELECT COUNT(*) AS n FROM tips WHERE status = 'shown' AND id != ?
               AND (email_hash = ? OR (card_hash IS NOT NULL AND card_hash = ?))",
            vec![
                except.into(),
                email_hash.into(),
                card_hash.unwrap_or("-").into(),
            ],
        )? > 0)
    }

    /// Whether this channel blocked this person or they disputed a tip here.
    fn locally_blocked(&self, hashes: &[&str]) -> Result<bool> {
        for h in hashes {
            let n = self.tip_count(
                "SELECT COUNT(*) AS n FROM tips WHERE (blocked = 1 OR status = 'disputed')
                   AND (email_hash = ?1 OR card_hash = ?1 OR ip_hash = ?1)",
                vec![(*h).into()],
            )?;
            if n > 0 {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn held_count(&self) -> Result<u32> {
        self.tip_count(
            "SELECT COUNT(*) AS n FROM tips WHERE status = 'held'",
            vec![],
        )
    }

    /// Tell the dashboard and Sylva Desktop the held tips changed.
    fn tips_changed(&self) -> Result<()> {
        let text = serde_json::to_string(&ServerFrame::Tips {
            held: self.held_count()?,
        })?;
        for ws in self.sockets(Role::Feed) {
            let _ = ws.send_with_str(&text);
        }
        Ok(())
    }

    /// The tip page's data: limits and suggestions in each currency.
    pub(crate) fn tips_public(&self, country: &str) -> Result<Value> {
        let s = self.tip_settings()?;
        let account = self.stripe_account()?;
        let open = s.enabled && account.as_ref().is_some_and(|a| a.charges_enabled);
        let base = rules::currency(&s.currency).unwrap_or(&rules::CURRENCIES[0]);
        let currencies: Vec<Value> = rules::CURRENCIES
            .iter()
            .map(|c| {
                let conv = |x: f64| rules::convert(x, base.code, c.code);
                let exact = c.code == base.code;
                let pick = |x: f64, up: bool| if exact { x } else { rules::nice(conv(x), c, up) };
                json!({
                    "code": c.code,
                    "decimals": c.decimals,
                    "min": pick(s.min, true),
                    "max": (if exact { s.max } else { rules::nice(conv(s.max), c, false).min(conv(s.max)) }).min(rules::stripe_max(c)),
                    "suggested": s.suggested.iter().map(|x| pick(*x, false)).collect::<Vec<_>>(),
                })
            })
            .collect();
        let guess = rules::currency_for_country(country).unwrap_or(base.code);
        // Top tippers over the last 7 days, by total in the streamer's currency.
        #[derive(Deserialize)]
        struct Top {
            name: String,
            base: f64,
            email_hash: String,
            card_hash: Option<String>,
        }
        let rows = self
            .sql
            .exec(
                "SELECT name, base, email_hash, card_hash FROM tips WHERE status = 'shown' AND blocked = 0
                   AND released_at > ? AND (? OR id NOT LIKE 'tip_test_%')
                 ORDER BY released_at",
                vec![
                    ((now() - 7 * 86_400_000) as f64).into(),
                    (if test_mode(&self.env) { 1.0 } else { 0.0 }).into(),
                ],
            )?
            .to_array::<Top>()?;
        let mut totals: Vec<(String, String, f64)> = Vec::new();
        for r in rows {
            // The same person: same email, else same card, else same name.
            let who = if !r.email_hash.starts_with("none:") {
                r.email_hash.clone()
            } else if let Some(c) = &r.card_hash {
                c.clone()
            } else {
                format!("name:{}", r.name.to_lowercase())
            };
            match totals.iter_mut().find(|t| t.0 == who) {
                // The latest name they tipped under.
                Some(t) => {
                    t.1 = r.name;
                    t.2 += r.base;
                }
                None => totals.push((who, r.name, r.base)),
            }
        }
        totals.sort_by(|a, b| b.2.total_cmp(&a.2));
        let top: Vec<Value> = totals
            .iter()
            .take(5)
            .map(|t| json!({ "name": t.1, "amount": (t.2 * 100.0).round() / 100.0 }))
            .collect();
        Ok(json!({
            "top": top,
            "open": open,
            "account": account.map(|a| a.id),
            "currency": guess,
            "baseCurrency": base.code,
            "currencies": currencies,
            "excluded": rules::EXCLUDED_METHODS,
            "allowed": rules::ALLOWED_METHODS,
            "order": rules::METHOD_ORDER,
            "messageMax": rules::MESSAGE_MAX,
            "nameMax": rules::NAME_MAX,
            "note": s.note,
            // Tippers pick the voice that reads their message.
            "speech": if s.tts {
                json!({
                    "min": s.tts_min,
                    "voice": s.voice_for(""),
                    "voices": s.voices(),
                })
            } else {
                Value::Null
            },
            "look": {
                "avatar": s.avatar,
                "banner": s.banner,
                "background": s.background,
                "bgColor": s.bg_color,
                "bgTile": s.bg_tile,
                "tileSize": s.tile_size,
            },
        }))
    }

    /// A viewer's tip: check it, then charge it on the streamer's account.
    pub(crate) async fn tips_create(&self, mut req: Request) -> Result<Response> {
        let ip = header(&req, "X-Sylva-Ip");
        let ip_country = header(&req, "X-Sylva-Country");
        let t: NewTip = match req.json().await {
            Ok(t) => t,
            Err(_) => {
                return error(
                    "Something in the form was not right. Refresh and try again.",
                    400,
                )
            }
        };
        let s = self.tip_settings()?;
        let Some(account) = self
            .stripe_account()?
            .filter(|a| a.charges_enabled && s.enabled)
        else {
            return error("This streamer is not taking tips right now.", 400);
        };
        if !t.agreed {
            return error("Tick the box to confirm the tip is a gift.", 400);
        }
        let name = match rules::clean_name(&t.name) {
            Ok(n) => n,
            Err(m) => return error(&m, 400),
        };
        let message = match rules::clean_message(&t.message) {
            Ok(m) => m,
            Err(m) => return error(&m, 400),
        };
        // No email is asked for. One sent anyway is checked and used.
        let email = if t.email.trim().is_empty() {
            None
        } else {
            match rules::normalize_email(&t.email) {
                Some(e) => Some(e),
                None => return error("That email address does not look right.", 400),
            }
        };
        let Some(cur) = rules::currency(&t.currency) else {
            return error("Pick one of the listed currencies.", 400);
        };
        let Some(minor) = rules::to_minor(t.amount, cur) else {
            return error("Enter an amount like 5 or 5.50.", 400);
        };
        let token = t.confirmation_token.trim();
        if !token.starts_with("ctoken_")
            || token.len() > 120
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return error("The payment details were not ready. Try again.", 400);
        }

        // What will pay: card country and fingerprint, wallet, method.
        let (status, ct) = stripe(
            &self.env,
            Method::Get,
            &format!("/confirmation_tokens/{token}"),
            Some(&account.id),
            None,
            None,
        )
        .await?;
        if status != 200 {
            console_warn!("Confirmation token lookup failed: {}", stripe_error(&ct));
            return error("The payment details expired. Try again.", 400);
        }
        let preview = &ct["payment_method_preview"];
        let kind = preview["type"].as_str().unwrap_or("").to_string();
        if kind.is_empty() || rules::EXCLUDED_METHODS.contains(&kind.as_str()) {
            return error("That payment method can't be used for tips here.", 400);
        }
        let card = &preview["card"];
        let is_card = kind == "card";
        let card_country = card["country"].as_str().map(str::to_string);
        let pepper = self.pepper()?;
        let card_hash = card["fingerprint"]
            .as_str()
            .map(|f| rules::ident_hash(pepper.as_bytes(), "card", f));
        // Without an email the tipper is known by card and IP address; the
        // column gets a value that matches nothing else.
        let email_hash = match &email {
            Some(e) => rules::ident_hash(pepper.as_bytes(), "email", e),
            None => format!("none:{}", random_hex(12)?),
        };
        let ip_hash = rules::ident_hash(pepper.as_bytes(), "ip", &ip);

        let now = now();
        let mut ids = vec![email_hash.as_str(), ip_hash.as_str()];
        if let Some(c) = &card_hash {
            ids.push(c);
        }
        let mut global = vec![email_hash.clone()];
        if let Some(c) = &card_hash {
            global.push(c.clone());
        }
        let blocked = self.locally_blocked(&ids)? || directory_blocked(&self.env, global).await?;
        // Test mode is for the streamer trying things: no attempt limits.
        let testing = test_mode(&self.env);
        let recent_attempts = if testing {
            0
        } else {
            self.tip_count(
            "SELECT COUNT(*) AS n FROM tips WHERE created_at > ? AND (ip_hash = ? OR email_hash = ?)",
            vec![((now - 10 * 60_000) as f64).into(), ip_hash.as_str().into(), email_hash.as_str().into()],
        )?
        };
        // Only real declines count, not payments Sylva or Stripe could not start.
        let recent_failures = if testing {
            0
        } else {
            self.tip_count(
                "SELECT COUNT(*) AS n FROM tips WHERE status = 'failed' AND created_at > ?
               AND (note IS NULL OR note NOT LIKE 'Not started:%')
               AND (ip_hash = ? OR email_hash = ? OR (card_hash IS NOT NULL AND card_hash = ?))",
                vec![
                    ((now - 60 * 60_000) as f64).into(),
                    ip_hash.as_str().into(),
                    email_hash.as_str().into(),
                    card_hash.as_deref().unwrap_or("-").into(),
                ],
            )?
        };
        let base = rules::convert(t.amount, cur.code, &s.currency);
        let known = self.known_tipper(&email_hash, card_hash.as_deref(), "")?;
        let attempt = rules::Attempt {
            base,
            ip_country: Some(ip_country.clone())
                .filter(|c| !c.is_empty() && c != "XX" && c != "T1"),
            card_country: card_country.clone(),
            card: is_card,
            blocked,
            recent_attempts,
            recent_failures,
            known,
        };
        if let Err(m) = rules::precheck(&s, &attempt) {
            return error(&m, if blocked { 403 } else { 400 });
        }

        // Clear out abandoned attempts now and then.
        self.sql.exec(
            "DELETE FROM tips WHERE status IN ('pending', 'failed') AND created_at < ?",
            vec![((now - 3 * 86_400_000) as f64).into()],
        )?;
        self.sql.exec(
            "DELETE FROM tip_voice WHERE created_at < ?",
            vec![((now - 30 * 86_400_000) as f64).into()],
        )?;
        let id = if test_mode(&self.env) {
            format!("tip_test_{}", random_hex(12)?)
        } else {
            format!("tip_{}", random_hex(12)?)
        };
        self.sql.exec(
            "INSERT INTO tips (id, amount, currency, base, name, message, email_hash, email_hint,
                ip, ip_hash, ip_country, card_country, card_hash, method, status, created_at, agreed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            vec![
                id.as_str().into(),
                (minor as f64).into(),
                cur.code.into(),
                base.into(),
                name.as_str().into(),
                message.as_str().into(),
                email_hash.as_str().into(),
                email.as_deref().map(rules::email_hint).unwrap_or_default().into(),
                ip.as_str().into(),
                ip_hash.as_str().into(),
                attempt.ip_country.clone().into(),
                card_country.into(),
                card_hash.into(),
                kind.as_str().into(),
                (now as f64).into(),
                (now as f64).into(),
            ],
        )?;
        self.sql.exec(
            "INSERT OR REPLACE INTO tip_voice (id, voice, created_at) VALUES (?, ?, ?)",
            vec![id.as_str().into(), s.voice_for(&t.voice).into(), (now as f64).into()],
        )?;
        // Wake Kokoro while the tipper pays, so the message is read right away.
        if s.tts {
            crate::kokoro::warm(&self.env);
        }

        let channel = self.channel_name()?;
        let mut form = Form::new()
            .add("amount", minor)
            .add("currency", cur.code.to_ascii_lowercase())
            .add("confirm", "true")
            .add("confirmation_token", token)
            .add("automatic_payment_methods[enabled]", "true")
            .add(
                "payment_method_options[card][request_three_d_secure]",
                "any",
            )
            .add("description", format!("Tip to {channel}"))
            .add("metadata[sylva_tip]", &id)
            .add("metadata[sylva_channel]", self.key().unwrap_or_default());
        if let Some(e) = &email {
            form.push("receipt_email", e);
        }
        for m in rules::EXCLUDED_METHODS {
            form.push("excluded_payment_method_types[]", m);
        }
        let (status, pi) = stripe(
            &self.env,
            Method::Post,
            "/payment_intents",
            Some(&account.id),
            Some(&form),
            Some(&id),
        )
        .await?;
        if !(200..300).contains(&status) {
            let card_error = pi["error"]["type"].as_str() == Some("card_error");
            // Only a card decline counts toward the tipper's decline limit.
            let note = if card_error {
                stripe_error(&pi)
            } else {
                format!("Not started: {}", stripe_error(&pi))
            };
            self.set_tip(&id, "status = 'failed', note = ?", vec![note.into()])?;
            return if card_error {
                error(&stripe_error(&pi), 402)
            } else {
                console_error!("Creating a tip payment failed: {}", stripe_error(&pi));
                error(
                    "The payment could not be started. Try again in a minute.",
                    502,
                )
            };
        }
        let intent = pi["id"].as_str().unwrap_or_default().to_string();
        let pi_status = pi["status"].as_str().unwrap_or_default().to_string();
        // The webhook may have come first and found nothing: only fill blanks.
        self.set_tip(
            &id,
            "intent = COALESCE(intent, ?)",
            vec![intent.as_str().into()],
        )?;
        if pi_status == "requires_payment_method" || pi_status == "canceled" {
            self.set_tip(&id, "status = 'failed'", vec![])?;
            return error("The payment was declined. Try another way to pay.", 402);
        }
        let mut out = json!({ "id": id, "status": pi_status });
        if pi_status == "requires_action" {
            out["clientSecret"] = pi["client_secret"].clone();
        }
        Response::from_json(&out)
    }

    /// A tip's state for the viewer who sent it.
    pub(crate) fn tips_status(&self, id: &str) -> Result<Response> {
        let Some(t) = self.tip(id)? else {
            return error("No such tip", 404);
        };
        let status = match t.status.as_str() {
            "pending" => "pending",
            "failed" => "failed",
            "held" | "shown" => "paid",
            _ => "closed",
        };
        Response::from_json(
            &json!({ "status": status, "note": if status == "failed" { t.note } else { None } }),
        )
    }

    /// Events from the streamer's Stripe account (via the Worker's webhook).
    pub(crate) async fn stripe_event(&self, ev: Value) -> Result<()> {
        let obj = &ev["data"]["object"];
        let kind = ev["type"].as_str().unwrap_or_default();
        match kind {
            "charge.succeeded" => self.charge_succeeded(obj).await?,
            "payment_intent.payment_failed" | "payment_intent.canceled" => {
                if let Some(t) = self.find_tip(obj["id"].as_str(), None).await? {
                    if t.status == "pending" {
                        let why = obj["last_payment_error"]["message"]
                            .as_str()
                            .unwrap_or("Declined");
                        self.set_tip(&t.id, "status = 'failed', note = ?", vec![why.into()])?;
                    }
                }
            }
            "charge.refunded" => {
                if obj["refunded"].as_bool() == Some(true) {
                    if let Some(t) = self
                        .find_tip(obj["payment_intent"].as_str(), obj["id"].as_str())
                        .await?
                    {
                        if !matches!(t.status.as_str(), "rejected" | "refunded" | "disputed") {
                            let was_held = t.status == "held";
                            self.set_tip(&t.id, "status = 'refunded'", vec![])?;
                            if was_held {
                                self.tips_changed()?;
                            }
                        }
                    }
                }
            }
            "charge.dispute.created" => {
                let Some(t) = self
                    .find_tip(obj["payment_intent"].as_str(), obj["charge"].as_str())
                    .await?
                else {
                    return Ok(());
                };
                let was_held = t.status == "held";
                let dispute = obj["id"].as_str().unwrap_or_default();
                self.set_tip(
                    &t.id,
                    "status = 'disputed', dispute = ?, dispute_status = ?",
                    vec![
                        dispute.into(),
                        obj["status"].as_str().unwrap_or("needs_response").into(),
                    ],
                )?;
                directory_block(&self.env, t.hashes(false), "dispute").await?;
                if was_held {
                    self.tips_changed()?;
                }
                if self.tip_settings()?.auto_evidence {
                    if let Err(e) = self.send_evidence(&t.id, dispute).await {
                        console_error!("Dispute evidence for {} failed: {e}", t.id);
                    }
                }
            }
            "charge.dispute.closed" | "charge.dispute.updated" => {
                if let Some(t) = self
                    .find_tip(obj["payment_intent"].as_str(), obj["charge"].as_str())
                    .await?
                {
                    self.set_tip(
                        &t.id,
                        "dispute_status = ?",
                        vec![obj["status"].as_str().unwrap_or("").into()],
                    )?;
                }
            }
            "radar.early_fraud_warning.created" => {
                let Some(t) = self
                    .find_tip(obj["payment_intent"].as_str(), obj["charge"].as_str())
                    .await?
                else {
                    return Ok(());
                };
                directory_block(&self.env, t.hashes(false), "fraud warning").await?;
                let actionable = obj["actionable"].as_bool().unwrap_or(false);
                if actionable
                    && self.tip_settings()?.refund_on_warning
                    && !matches!(t.status.as_str(), "refunded" | "rejected" | "disputed")
                {
                    match self.refund(&t, true).await? {
                        Ok(()) => {
                            let was_held = t.status == "held";
                            self.set_tip(
                                &t.id,
                                "status = 'refunded', note = ?",
                                vec!["Refunded on its own after the card's bank warned of fraud"
                                    .into()],
                            )?;
                            if was_held {
                                self.tips_changed()?;
                            }
                        }
                        Err(m) => console_error!("Refund after fraud warning failed: {m}"),
                    }
                } else {
                    self.set_tip(
                        &t.id,
                        "note = ?",
                        vec!["The card's bank warned of fraud".into()],
                    )?;
                }
            }
            "account.updated" => {
                if let Some(mut a) = self.stripe_account()? {
                    if obj["id"].as_str() == Some(a.id.as_str()) {
                        self.refresh_account(&mut a).await?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The tip for a payment, by its payment intent or charge. When the
    /// webhook beats the reply that saved the intent, the intent's metadata
    /// names the tip.
    async fn find_tip(&self, intent: Option<&str>, charge: Option<&str>) -> Result<Option<TipRow>> {
        if let Some(i) = intent {
            if let Some(t) = self.tip_by("intent", i)? {
                return Ok(Some(t));
            }
        }
        if let Some(c) = charge {
            if let Some(t) = self.tip_by("charge", c)? {
                return Ok(Some(t));
            }
        }
        let (Some(i), Some(a)) = (intent, self.stripe_account()?) else {
            return Ok(None);
        };
        let (status, pi) = stripe(
            &self.env,
            Method::Get,
            &format!("/payment_intents/{i}"),
            Some(&a.id),
            None,
            None,
        )
        .await?;
        if status != 200 {
            return Ok(None);
        }
        let Some(id) = pi["metadata"]["sylva_tip"].as_str() else {
            return Ok(None);
        };
        let t = self.tip(id)?;
        if t.is_some() {
            self.set_tip(id, "intent = ?", vec![i.into()])?;
        }
        Ok(self.tip(id)?)
    }

    async fn charge_succeeded(&self, ch: &Value) -> Result<()> {
        let Some(t) = self.find_tip(ch["payment_intent"].as_str(), None).await? else {
            return Ok(());
        };
        if t.status != "pending" {
            return Ok(());
        }
        let details = &ch["payment_method_details"];
        let kind = details["type"].as_str().unwrap_or("").to_string();
        let card = &details["card"];
        let wallet = card["wallet"]["type"].as_str().map(str::to_string);
        let three_d = card["three_d_secure"]["result"].as_str().unwrap_or("");
        let is_card = kind == "card";
        let verified = !is_card
            || matches!(three_d, "authenticated" | "attempt_acknowledged")
            || matches!(wallet.as_deref(), Some("apple_pay" | "google_pay"));
        let risk = ch["outcome"]["risk_level"]
            .as_str()
            .unwrap_or("normal")
            .to_string();
        let method = wallet.clone().unwrap_or(kind.clone());
        let card_country = card["country"]
            .as_str()
            .map(str::to_string)
            .or(t.card_country.clone());
        let pepper = self.pepper()?;
        let card_hash = card["fingerprint"]
            .as_str()
            .map(|f| rules::ident_hash(pepper.as_bytes(), "card", f))
            .or(t.card_hash.clone());
        let live = self.uptime_ms()?.is_some();
        let now = now();
        let s = self.tip_settings()?;
        let known = self.known_tipper(&t.email_hash, card_hash.as_deref(), &t.id)?;
        let paid = rules::Paid {
            base: t.base,
            card: is_card,
            verified,
            risk: risk.clone(),
            known,
            ip_country: t.ip_country.clone(),
            card_country: card_country.clone(),
        };
        self.set_tip(
            &t.id,
            "charge = ?, method = ?, card_country = ?, card_hash = ?, verified = ?, risk = ?, paid_at = ?, live = ?",
            vec![
                ch["id"].as_str().unwrap_or_default().into(),
                method.as_str().into(),
                card_country.into(),
                card_hash.into(),
                (verified as i64 as f64).into(),
                risk.as_str().into(),
                (now as f64).into(),
                (live as i64 as f64).into(),
            ],
        )?;
        match rules::hold_reason(&s, &paid) {
            Some((reason, must_approve)) => {
                let needs_ok = must_approve || s.hold == HoldMode::Approve;
                let release_at = if needs_ok {
                    None
                } else {
                    Some((now + s.delay_seconds as i64 * 1000) as f64)
                };
                self.set_tip(
                    &t.id,
                    "status = 'held', hold_reason = ?, needs_ok = ?, release_at = ?",
                    vec![
                        reason.into(),
                        (needs_ok as i64 as f64).into(),
                        release_at.into(),
                    ],
                )?;
                self.tips_changed()?;
                if release_at.is_some() {
                    self.schedule().await?;
                }
                // Read the message now, so the alert is ready the moment
                // the tip is let through.
                if let Some(t) = self.tip(&t.id)? {
                    if let Some(text) = self.spoken(&s, &t) {
                        self.make_speech(&t, &text).await;
                    }
                }
            }
            None => {
                if let Some(t) = self.tip(&t.id)? {
                    self.release(&t).await?;
                }
            }
        }
        Ok(())
    }

    /// Put a paid tip in the alert queue, with its spoken message.
    async fn release(&self, t: &TipRow) -> Result<()> {
        let s = self.tip_settings()?;
        let now = now();
        // Claim it first, so a second release (approve twice, alarm and
        // approve at once) cannot alert twice.
        self.set_tip(
            &t.id,
            "status = 'shown', released_at = ?, release_at = NULL",
            vec![(now as f64).into()],
        )?;
        // Usually made already, when the payment went through.
        if let Some(text) = self.spoken(&s, t) {
            if !self.has_speech(&t.id) {
                self.make_speech(t, &text).await;
            }
        }
        let login: String = t
            .name
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_')
            .collect::<String>()
            .to_lowercase();
        let event = Event {
            // Test tips use the test event id, so they stay out of stats.
            id: if t.id.starts_with("tip_test_") {
                format!("sylva:test:stripe:{}", t.id)
            } else {
                format!("stripe:{}", t.id)
            },
            channel: self.key().unwrap_or_default(),
            platform: Platform::Stripe,
            kind: EventKind::Tip,
            raw_type: "sylva.tip".into(),
            created_at: js_sys::Date::new(&(t.paid_at.unwrap_or(now as f64)).into())
                .to_iso_string()
                .into(),
            actor: Some(Actor {
                id: {
                    let who = if t.email_hash.starts_with("none:") {
                        t.card_hash.as_deref().unwrap_or(&t.email_hash)
                    } else {
                        &t.email_hash
                    };
                    format!("tip:{}", &who[..12.min(who.len())])
                },
                login,
                display_name: t.name.clone(),
            }),
            amount: Some(t.paid_amount()),
            currency: Some(t.currency.clone()),
            message: Some(t.message.clone()).filter(|m| !m.is_empty()),
            tier: None,
            gifted: false,
            sender: None,
            redemption: None,
            raw: json!({
                "tip": t.id,
                "sylvaBase": t.base,
                "baseCurrency": s.currency,
                "method": t.method,
            }),
        };
        let result = self.ingest(event).await?;
        self.set_tip(&t.id, "event_seq = ?", vec![(result.seq as f64).into()])?;
        if t.status == "held" {
            self.tips_changed()?;
        }
        // A clip of the moment, for dispute evidence.
        if t.live > 0.0 || self.uptime_ms()?.is_some() {
            if let Some(url) = self.make_clip().await {
                self.set_tip(&t.id, "clip = ?", vec![url.into()])?;
            }
        }
        Ok(())
    }

    async fn make_clip(&self) -> Option<String> {
        let broadcaster = self.broadcaster_id()?;
        let crate::grants::Token::Ok(token) = self.user_token("commands").await.ok()? else {
            return None;
        };
        let app = crate::twitch_api::App::user(&self.env, &token).ok()?;
        let (status, v) = app
            .helix(
                Method::Post,
                &format!("/clips?broadcaster_id={broadcaster}"),
                None,
            )
            .await
            .ok()?;
        v["data"][0]["id"]
            .as_str()
            .filter(|_| status == 202 || status == 200)
            .map(|id| format!("https://clips.twitch.tv/{id}"))
    }

    /// Read a tip's message aloud and keep the audio for its alert: Kokoro
    /// in the voice the tipper picked, or the stand-in voice when Kokoro is
    /// not set up or does not answer in time.
    async fn make_speech(&self, t: &TipRow, text: &str) {
        let voice = self.tip_voice(&t.id);
        let kokoro = match crate::kokoro::speak(&self.env, text, &voice).await {
            Ok(a) => a.filter(|a| !a.is_empty()),
            Err(e) => {
                console_error!("Kokoro could not read {}, using the stand-in voice: {e}", t.id);
                None
            }
        };
        let audio = match kokoro {
            Some(a) => a,
            None => match self.stand_in(text).await {
                Ok(a) => a,
                Err(e) => {
                    console_error!("Text to speech for {} failed: {e}", t.id);
                    return;
                }
            },
        };
        if let Err(e) = self.keep_speech(&t.id, text, &audio) {
            console_error!("Could not keep the speech for {}: {e}", t.id);
        }
    }

    /// What is read aloud for a tip, when it is read at all.
    fn spoken(&self, s: &TipSettings, t: &TipRow) -> Option<String> {
        if !s.tts || t.base + 0.005 < s.tts_min {
            return None;
        }
        s.speech(&t.name, &rules::spoken_amount(t.paid_amount(), &t.currency), &t.message)
    }

    fn tip_voice(&self, id: &str) -> String {
        #[derive(Deserialize)]
        struct Row {
            voice: String,
        }
        let picked = self
            .sql
            .exec("SELECT voice FROM tip_voice WHERE id = ?", vec![id.into()])
            .and_then(|c| c.to_array::<Row>())
            .ok()
            .and_then(|r| r.into_iter().next())
            .map(|r| r.voice)
            .unwrap_or_default();
        self.tip_settings()
            .map(|s| s.voice_for(&picked).to_string())
            .unwrap_or_else(|_| rules::VOICES[0].id.to_string())
    }

    async fn stand_in(&self, text: &str) -> Result<Vec<u8>> {
        let stream = self
            .env
            .ai("AI")?
            .run_bytes(TTS_FALLBACK, json!({ "text": text, "speaker": "draco" }))
            .await?;
        let audio = Response::from_stream(stream)?.bytes().await?;
        if audio.is_empty() {
            return Err(Error::RustError("no audio".into()));
        }
        Ok(audio)
    }

    fn keep_speech(&self, id: &str, text: &str, audio: &[u8]) -> Result<()> {
        let ms = sylva_core::speech::mp3_ms(&audio)
            .unwrap_or(text.chars().count() as u32 * 65 + 800)
            .min(60_000) as i64;
        let audio = sylva_core::media::b64_encode(audio);
        let now = now();
        self.sql.exec(
            "DELETE FROM tts WHERE created_at < ?",
            vec![((now - 2 * 86_400_000) as f64).into()],
        )?;
        self.sql.exec(
            "INSERT OR REPLACE INTO tts (id, audio, ms, created_at) VALUES (?, ?, ?, ?)",
            vec![
                id.into(),
                audio.into(),
                (ms as f64).into(),
                (now as f64).into(),
            ],
        )?;
        Ok(())
    }

    /// The spoken message for a tip alert, and how long it takes.
    pub(crate) fn tip_speech(&self, event: &Event) -> Option<(String, u32)> {
        if event.platform != Platform::Stripe || event.kind != EventKind::Tip {
            return None;
        }
        let id = event
            .id
            .strip_prefix("sylva:test:stripe:")
            .or_else(|| event.id.strip_prefix("stripe:"))?;
        let rows = self
            .sql
            .exec("SELECT ms AS value FROM tts WHERE id = ?", vec![id.into()])
            .ok()?
            .to_array::<NumRow>()
            .ok()?;
        let ms = rows.first()?.value?;
        Some((id.to_string(), ms as u32))
    }

    fn has_speech(&self, id: &str) -> bool {
        self.sql
            .exec("SELECT ms AS value FROM tts WHERE id = ?", vec![id.into()])
            .and_then(|c| c.to_array::<NumRow>())
            .is_ok_and(|r| !r.is_empty())
    }

    pub(crate) fn tts_file(&self, id: &str) -> Result<Response> {
        if !id.starts_with("tip_") || id.len() > 40 {
            return error("Not found", 404);
        }
        let rows = self
            .sql
            .exec("SELECT audio FROM tts WHERE id = ?", vec![id.into()])?
            .to_array::<TtsRow>()?;
        let Some(row) = rows.first() else {
            return error("Not found", 404);
        };
        let bytes = sylva_core::media::b64_decode(&row.audio).unwrap_or_default();
        let mut res = Response::from_bytes(bytes)?;
        let h = res.headers_mut();
        h.set("Content-Type", "audio/mpeg")?;
        h.set("Cache-Control", "public, max-age=86400, immutable")?;
        h.set("X-Content-Type-Options", "nosniff")?;
        h.set("Access-Control-Allow-Origin", "*")?;
        Ok(res)
    }

    /// When an alert finishes on screen, note when a tip was shown.
    pub(crate) fn tip_alert_done(&self, alert_id: u64) -> Result<()> {
        self.sql.exec(
            "UPDATE tips SET shown_at = ? WHERE shown_at IS NULL
               AND event_seq = (SELECT event_seq FROM alerts WHERE id = ?)",
            vec![(now() as f64).into(), (alert_id as f64).into()],
        )?;
        Ok(())
    }

    /// The earliest delayed tip still to release.
    pub(crate) fn next_tip_at(&self) -> Result<Option<i64>> {
        Ok(self
            .sql
            .exec(
                "SELECT MIN(release_at) AS value FROM tips WHERE status = 'held' AND release_at IS NOT NULL",
                None,
            )?
            .to_array::<NumRow>()?
            .first()
            .and_then(|r| r.value)
            .map(|v| v as i64))
    }

    pub(crate) async fn run_tip_releases(&self, now: i64) -> Result<()> {
        let due = self
            .sql
            .exec(
                "SELECT * FROM tips WHERE status = 'held' AND release_at IS NOT NULL AND release_at <= ?",
                vec![(now as f64).into()],
            )?
            .to_array::<TipRow>()?;
        for t in due {
            self.release(&t).await?;
        }
        Ok(())
    }

    async fn refund(&self, t: &TipRow, fraud: bool) -> Result<std::result::Result<(), String>> {
        let (Some(charge), Some(a)) = (&t.charge, self.stripe_account()?) else {
            return Ok(Err("This tip was never paid.".into()));
        };
        let mut form = Form::new().add("charge", charge);
        if fraud {
            form.push("reason", "fraudulent");
        }
        let (status, v) = stripe(
            &self.env,
            Method::Post,
            "/refunds",
            Some(&a.id),
            Some(&form),
            Some(&format!("refund-{}", t.id)),
        )
        .await?;
        Ok(
            if (200..300).contains(&status)
                || v["error"]["code"].as_str() == Some("charge_already_refunded")
            {
                Ok(())
            } else {
                Err(stripe_error(&v))
            },
        )
    }

    /// Send Stripe everything Sylva knows about a disputed tip.
    async fn send_evidence(&self, id: &str, dispute: &str) -> Result<()> {
        let (Some(t), Some(a)) = (self.tip(id)?, self.stripe_account()?) else {
            return Ok(());
        };
        let channel = self.channel_name()?;
        let login = self.config("channel_login")?.unwrap_or_default();
        let when = |ms: Option<f64>| {
            ms.map(|m| {
                js_sys::Date::new(&m.into())
                    .to_iso_string()
                    .as_string()
                    .unwrap_or_default()
            })
            .unwrap_or_else(|| "not recorded".into())
        };
        let paid = when(t.paid_at);
        let amount = format!("{:.2} {}", t.paid_amount(), t.currency);
        let stream = if login.is_empty() {
            format!("the Twitch channel {channel}")
        } else {
            format!("the Twitch channel {channel} (https://twitch.tv/{login})")
        };
        let mut lines = vec![
            format!("This was a voluntary tip of {amount} to {stream}, paid on the streamer's own tip page on Sylva."),
            format!("Tip id: {}. Paid at {paid}.", t.id),
            format!("Payment method: {}.", t.method.clone().unwrap_or_default()),
            format!(
                "3D Secure or wallet authentication: {}.",
                if t.verified > 0.0 { "yes" } else { "no" }
            ),
            format!("Name the tipper gave: {}.", t.name),
            format!("Message the tipper wrote: {}", if t.message.is_empty() { "(none)".into() } else { t.message.clone() }),
            format!("Country of the tipper's IP address: {}. Card country: {}.", t.ip_country.clone().unwrap_or("unknown".into()), t.card_country.clone().unwrap_or("not a card".into())),
            format!("The tipper ticked the box \"I understand this tip is a voluntary gift and is not refundable\" at {}.", when(Some(t.agreed_at))),
            format!("The stream was {} when the tip was paid.", if t.live > 0.0 { "live" } else { "offline" }),
            format!("The tip's alert, with the tipper's name and message, was sent to the live stream at {} and finished showing at {}.", when(t.released_at), when(t.shown_at)),
        ];
        if let Some(c) = &t.clip {
            lines.push(format!("Clip of the stream at the moment of the tip: {c}"));
        }
        let mut form = Form::new()
            .add("evidence[customer_name]", &t.name)
            .add("evidence[product_description]", format!(
                "A voluntary digital tip to {stream}. Nothing is shipped: the tip is delivered instantly when the tipper's name and message appear on the live stream."
            ))
            .add("evidence[refund_policy_disclosure]", "Tips are voluntary gifts and are not refundable. The tip page shows this, and the tipper must tick a box saying so before paying.")
            .add("evidence[uncategorized_text]", lines.join("\n"))
            .add("evidence[access_activity_log]", format!(
                "Tip page used from IP address {} ({}) at {}; payment confirmed at {paid}.",
                t.ip, t.ip_country.clone().unwrap_or("unknown country".into()), when(Some(t.created_at))
            ))
            .add("submit", "true");
        if !t.ip.is_empty() {
            form.push("evidence[customer_purchase_ip]", &t.ip);
        }
        if let Some(d) = t.paid_at {
            let iso = when(Some(d));
            form.push("evidence[service_date]", iso.get(..10).unwrap_or(&iso));
        }
        let (status, v) = stripe(
            &self.env,
            Method::Post,
            &format!("/disputes/{dispute}"),
            Some(&a.id),
            Some(&form),
            None,
        )
        .await?;
        if (200..300).contains(&status) {
            self.set_tip(id, "evidence_at = ?", vec![(now() as f64).into()])?;
        } else {
            console_error!("Stripe refused the evidence: {}", stripe_error(&v));
        }
        Ok(())
    }

    /// Bring the account's state up to date straight from Stripe. Reads the
    /// Accounts v2 object (card payments `active` on the merchant
    /// configuration means tips can be taken). If that read fails or has no
    /// card payments status, the v1 view of the same account is used.
    async fn refresh_account(&self, a: &mut AccountState) -> Result<()> {
        let (status, obj) = stripe_v2(
            &self.env,
            Method::Get,
            &format!(
                "/core/accounts/{}?include=configuration.merchant&include=identity&include=requirements",
                a.id
            ),
            None,
        )
        .await?;
        let card = &obj["configuration"]["merchant"]["capabilities"]["card_payments"];
        if status == 200 && card["status"].is_string() {
            let state = card["status"].as_str().unwrap_or_default();
            a.charges_enabled = state == "active";
            a.stripe_status = state.into();
            a.reasons = card["status_details"]
                .as_array()
                .map(|d| {
                    d.iter()
                        .filter_map(|x| x["code"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let open: Vec<&Value> = obj["requirements"]["entries"]
                .as_array()
                .map(|e| {
                    e.iter()
                        .filter(|x| {
                            x["minimum_deadline"]["status"].as_str() != Some("eventually_due")
                        })
                        .collect()
                })
                .unwrap_or_default();
            let entries = open.len() as u32;
            a.needs = open
                .iter()
                .map(|x| {
                    let mut n = x["description"].as_str().unwrap_or("unknown").to_string();
                    if x["awaiting_action_from"].as_str() == Some("stripe") {
                        n.push_str(" (Stripe is reviewing)");
                    }
                    if let Some(e) = x["errors"].as_array().and_then(|e| e.first()) {
                        n.push_str(&format!(": {}", e["description"].as_str().unwrap_or("")));
                    }
                    n
                })
                .collect();
            a.due = if a.charges_enabled {
                entries
            } else {
                (a.reasons.len() as u32).max(entries)
            };
            // Sent in once nothing Stripe lists is waiting on the streamer.
            a.details_submitted = a.charges_enabled
                || card["status_details"].as_array().is_some_and(|d| {
                    d.iter().all(|x| {
                        x["code"].as_str() != Some("requirements_past_due")
                            && x["resolution"].as_str() != Some("provide_info")
                    })
                });
            if let Some(c) = obj["identity"]["country"].as_str() {
                a.country = c.to_ascii_uppercase();
            }
        } else {
            if status != 200 {
                console_warn!(
                    "Reading the Stripe account (v2) failed: {}",
                    stripe_error(&obj)
                );
            }
            let (status, v) = stripe(
                &self.env,
                Method::Get,
                &format!("/accounts/{}", a.id),
                None,
                None,
                None,
            )
            .await?;
            if status != 200 {
                console_warn!("Reading the Stripe account failed: {}", stripe_error(&v));
                return Ok(());
            }
            a.charges_enabled = v["charges_enabled"].as_bool() == Some(true);
            a.details_submitted = v["details_submitted"].as_bool() == Some(true);
            a.stripe_status = v["capabilities"]["card_payments"]
                .as_str()
                .unwrap_or_default()
                .into();
            let req = &v["requirements"];
            let count = |k: &str| req[k].as_array().map_or(0, |x| x.len());
            a.due = (count("currently_due") + count("past_due")) as u32;
            a.needs = ["past_due", "currently_due"]
                .iter()
                .flat_map(|k| req[*k].as_array().cloned().unwrap_or_default())
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect();
            a.reasons = req["disabled_reason"]
                .as_str()
                .map(|r| vec![r.to_string()])
                .unwrap_or_default();
            if let Some(c) = v["country"].as_str() {
                a.country = c.to_ascii_uppercase();
            }
        }
        console_log!(
            "Stripe account {}: card payments {}, due {}, reasons {:?}, needs {:?}",
            a.id,
            a.stripe_status,
            a.due,
            a.reasons,
            a.needs
        );
        self.save_account(a)?;
        Ok(())
    }

    /// Apple Pay and Google Pay show only on domains registered on the account.
    async fn register_domain(&self, a: &mut AccountState, host: &str) -> Result<()> {
        if !a.charges_enabled
            || a.domain == host
            || host.is_empty()
            || host.starts_with("localhost")
        {
            return Ok(());
        }
        let form = Form::new().add("domain_name", host).add("enabled", "true");
        let (status, v) = stripe(
            &self.env,
            Method::Post,
            "/payment_method_domains",
            Some(&a.id),
            Some(&form),
            None,
        )
        .await?;
        if (200..300).contains(&status)
            || v["error"]["code"].as_str() == Some("resource_already_exists")
        {
            a.domain = host.into();
            self.save_account(a)?;
        } else {
            console_warn!(
                "Registering {host} for wallets failed: {}",
                stripe_error(&v)
            );
        }
        Ok(())
    }

    /// `GET tips`: the dashboard's Tips page.
    pub(crate) async fn tips_view(&self, origin: &str, host: &str) -> Result<Value> {
        let ready = platform_ready(&self.env);
        let mut account = self.stripe_account()?;
        if let (true, Some(a)) = (ready, account.as_mut()) {
            if !a.charges_enabled || a.due > 0 {
                self.refresh_account(a).await?;
            }
            self.register_domain(a, host).await?;
        }
        let tips: Vec<TipView> = self
            .sql
            .exec(
                "SELECT * FROM tips WHERE status != 'pending' AND NOT (status = 'failed' AND created_at < ?)
                 ORDER BY created_at DESC LIMIT 200",
                vec![((now() - 86_400_000) as f64).into()],
            )?
            .to_array::<TipRow>()?
            .iter()
            .map(TipRow::view)
            .collect();
        let login = self.config("channel_login")?.unwrap_or_default();
        Ok(json!({
            "platformReady": ready,
            "testMode": test_mode(&self.env),
            "account": account,
            "settings": self.tip_settings()?,
            "tips": tips,
            "pageUrl": if login.is_empty() { Value::Null } else { json!(format!("{origin}/tip/{login}")) },
            "currencies": rules::CURRENCIES.iter().map(|c| c.code).collect::<Vec<_>>(),
            "countries": rules::STRIPE_COUNTRIES,
            "voices": rules::VOICES,
        }))
    }

    pub(crate) fn tips_held(&self) -> Result<Vec<TipView>> {
        Ok(self
            .sql
            .exec(
                "SELECT * FROM tips WHERE status = 'held' ORDER BY paid_at",
                None,
            )?
            .to_array::<TipRow>()?
            .iter()
            .map(TipRow::view)
            .collect())
    }

    pub(crate) fn tips_save_settings(
        &self,
        s: TipSettings,
    ) -> std::result::Result<TipSettings, String> {
        let s = s.validate().map_err(|e| e.0)?;
        for id in s.images() {
            if !self.media_exists(id).map_err(|e| e.to_string())? {
                return Err("That image is no longer in your files. Pick another one.".into());
            }
        }
        self.set_config(
            "tip_settings",
            &serde_json::to_string(&s).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(s)
    }

    /// `POST tips/connect`: make the streamer's Stripe account if needed,
    /// and give the link to Stripe's own setup pages.
    pub(crate) async fn tips_connect(&self, mut req: Request, origin: &str) -> Result<Response> {
        if !platform_ready(&self.env) {
            return error("Sylva's Stripe setup is not finished yet.", 503);
        }
        let body: ConnectBody = req.json().await.unwrap_or_default();
        let account = match self.stripe_account()? {
            Some(a) => a,
            None => {
                let country = body.country.to_ascii_uppercase();
                if !rules::STRIPE_COUNTRIES.contains(&country.as_str()) {
                    return error("Pick the country you live in.", 400);
                }
                let name = self.channel_name()?;
                let body = json!({
                    "display_name": name,
                    "dashboard": "full",
                    "identity": { "country": country.to_ascii_lowercase() },
                    "configuration": {
                        "merchant": { "capabilities": { "card_payments": { "requested": true } } }
                    },
                    "defaults": {
                        "responsibilities": { "fees_collector": "stripe", "losses_collector": "stripe" }
                    },
                    "metadata": { "sylva_channel": self.key().unwrap_or_default() },
                    "include": ["configuration.merchant", "identity"],
                });
                let (status, v) =
                    stripe_v2(&self.env, Method::Post, "/core/accounts", Some(&body)).await?;
                if !(200..300).contains(&status) {
                    console_error!("Making a Stripe account failed: {}", stripe_error(&v));
                    return error(&format!("Stripe said: {}", stripe_error(&v)), 502);
                }
                let a = AccountState {
                    id: v["id"].as_str().unwrap_or_default().into(),
                    country,
                    ..AccountState::default()
                };
                self.save_account(&a)?;
                let dir = self
                    .env
                    .durable_object("DIRECTORY")?
                    .get_by_name("directory")?;
                crate::auth::post(
                    &dir,
                    "/stripe/link",
                    &crate::account::StripeLink {
                        account: a.id.clone(),
                        channel: self.key().unwrap_or_default(),
                    },
                )
                .await?;
                a
            }
        };
        let body = json!({
            "account": account.id,
            "use_case": {
                "type": "account_onboarding",
                "account_onboarding": {
                    "refresh_url": format!("{origin}/app/tips?stripe=again"),
                    "return_url": format!("{origin}/app/tips?stripe=back"),
                    // Collect everything Stripe will ever ask for in one pass.
                    "collection_options": { "fields": "eventually_due", "future_requirements": "include" },
                }
            }
        });
        let (status, v) =
            stripe_v2(&self.env, Method::Post, "/core/account_links", Some(&body)).await?;
        if !(200..300).contains(&status) {
            return error(&format!("Stripe said: {}", stripe_error(&v)), 502);
        }
        Response::from_json(&json!({ "url": v["url"] }))
    }

    /// `POST tips/disconnect`: stop using the Stripe account. The account
    /// itself, its money and its history stay with the streamer on Stripe.
    pub(crate) async fn tips_disconnect(&self) -> Result<Response> {
        if let Some(a) = self.stripe_account()? {
            let dir = self
                .env
                .durable_object("DIRECTORY")?
                .get_by_name("directory")?;
            crate::auth::post(
                &dir,
                "/stripe/unlink",
                &crate::account::StripeLink {
                    account: a.id,
                    channel: self.key().unwrap_or_default(),
                },
            )
            .await?;
        }
        self.sql
            .exec("DELETE FROM config WHERE key = 'stripe_account'", None)?;
        Response::ok("ok")
    }

    /// `POST tips/{id}/{approve|reject|refund|block}`.
    pub(crate) async fn tips_action(&self, id: &str, action: &str) -> Result<Response> {
        let Some(t) = self.tip(id)? else {
            return error("No such tip", 404);
        };
        match action {
            "approve" => {
                if t.status != "held" {
                    return error("This tip is not waiting any more.", 409);
                }
                self.release(&t).await?;
            }
            "reject" | "refund" => {
                let ok_state = if action == "reject" {
                    t.status == "held"
                } else {
                    t.status == "shown"
                };
                if !ok_state {
                    return error("This tip can't be refunded from here now.", 409);
                }
                if let Err(m) = self.refund(&t, false).await? {
                    return error(&format!("Stripe said: {m}"), 502);
                }
                let status = if action == "reject" {
                    "rejected"
                } else {
                    "refunded"
                };
                self.set_tip(&t.id, "status = ?, release_at = NULL", vec![status.into()])?;
                if t.status == "held" {
                    self.tips_changed()?;
                }
            }
            "block" => self.set_tip(&t.id, "blocked = 1", vec![])?,
            "unblock" => self.set_tip(&t.id, "blocked = 0", vec![])?,
            _ => return error("Not found", 404),
        }
        Response::from_json(&self.tip(id)?.map(|t| t.view()))
    }
}

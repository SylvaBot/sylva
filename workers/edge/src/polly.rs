//! Amazon Polly's Brian, one of the voices tips can be read in. Needs the
//! Worker secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (an IAM
//! user allowed `polly:SynthesizeSpeech`); `AWS_REGION` is optional.

use serde_json::json;
use sylva_core::speech;
use worker::*;

/// What tippers hear when they press play on Brian.
const DEMO: &str = "Hi, I'm Brian. Thanks so much for the tip, have an awesome stream!";

/// The access key id and its secret, when both are set.
fn keys(env: &Env) -> Option<(String, String)> {
    let get = |k: &str| env.secret(k).ok().map(|v| v.to_string()).filter(|v| !v.is_empty());
    Some((get("AWS_ACCESS_KEY_ID")?, get("AWS_SECRET_ACCESS_KEY")?))
}

thread_local! {
    /// Brian's demo once Polly has made it, or when Polly last refused.
    static PROBE: std::cell::RefCell<Option<(Option<Vec<u8>>, f64)>> = const { std::cell::RefCell::new(None) };
}

/// Polly is asked again this long after it refused.
const RETRY_MS: f64 = 10.0 * 60.0 * 1000.0;

/// Brian's demo, made by Polly once per isolate. None while Polly refuses
/// (an AWS account on hold, a missing permission) or no keys are set.
async fn probe(env: &Env) -> Option<Vec<u8>> {
    keys(env)?;
    let now = Date::now().as_millis() as f64;
    let known = PROBE.with(|p| p.borrow().clone());
    match known {
        Some((Some(a), _)) => return Some(a),
        Some((None, at)) if now - at < RETRY_MS => return None,
        _ => {}
    }
    let made = match speak(env, DEMO).await {
        Ok(a) if !a.is_empty() => Some(a),
        Ok(_) => None,
        Err(e) => {
            console_error!("Brian is not available: {e}");
            None
        }
    };
    PROBE.with(|p| *p.borrow_mut() = Some((made.clone(), now)));
    made
}

/// Whether Brian can be offered: the keys are set and Polly answers.
pub(crate) async fn ready(env: &Env) -> bool {
    probe(env).await.is_some()
}

/// `text` read by Brian, as MP3.
pub(crate) async fn speak(env: &Env, text: &str) -> Result<Vec<u8>> {
    let (access, secret) = keys(env).ok_or_else(|| Error::RustError("no AWS keys".into()))?;
    let region = env
        .var("AWS_REGION")
        .map(|v| v.to_string())
        .ok()
        .filter(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .unwrap_or_else(|| "us-east-2".into());
    let host = format!("polly.{region}.amazonaws.com");
    let body = json!({
        "Engine": "standard",
        "OutputFormat": "mp3",
        "SampleRate": "22050",
        "Text": text,
        "TextType": "text",
        "VoiceId": speech::POLLY_VOICE,
    })
    .to_string();
    let date = speech::amz_date(&String::from(js_sys::Date::new_0().to_iso_string()));
    let auth = speech::aws_authorization(
        &speech::AwsRequest {
            method: "POST",
            host: &host,
            path: "/v1/speech",
            query: "",
            headers: &[("content-type", "application/json")],
            body: body.as_bytes(),
            region: &region,
            service: "polly",
            date: &date,
        },
        &access,
        &secret,
    );
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("X-Amz-Date", &date)?;
    headers.set("Authorization", &auth)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.into()));
    let mut res = Fetch::Request(Request::new_with_init(&format!("https://{host}/v1/speech"), &init)?)
        .send()
        .await?;
    if res.status_code() != 200 {
        let why = res.text().await.unwrap_or_default();
        return Err(Error::RustError(format!(
            "Polly said {}: {}",
            res.status_code(),
            why.chars().take(300).collect::<String>()
        )));
    }
    res.bytes().await
}

/// Brian's demo for the play buttons.
pub(crate) async fn demo(env: &Env) -> Result<Response> {
    let Some(audio) = probe(env).await else {
        return Response::error("Brian is not available", 503);
    };
    let headers = Headers::new();
    headers.set("Content-Type", "audio/mpeg")?;
    headers.set("Cache-Control", "public, max-age=86400")?;
    Ok(Response::from_bytes(audio)?.with_headers(headers))
}

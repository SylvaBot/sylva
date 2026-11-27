//! Kokoro-82M text to speech, run on Cloudflare in a Container (see
//! `containers/kokoro`). One Durable Object, `KokoroDo`, owns the container:
//! it starts it on demand, passes requests to it and stops it after
//! [`IDLE_MS`] without use, so it costs nothing while no one tips.
//!
//! Tips are read as soon as the payment goes through, and the container is
//! woken while the tipper is still filling in the form, so the audio is ready
//! before the alert. Until the container is deployed, `speak` answers
//! `Ok(None)` and the stand-in voice reads tips.

use serde_json::json;
use worker::*;

/// The container stops after this long without a request.
const IDLE_MS: i64 = 3 * 60 * 1000;
/// How long a tip waits for Kokoro before the stand-in voice reads it.
const SPEAK_TIMEOUT_MS: u64 = 6000;
const PORT: u16 = 8080;

fn stub(env: &Env) -> Option<Stub> {
    env.durable_object("KOKORO").ok()?.get_by_name("kokoro").ok()
}

/// `f`, unless it takes longer than `ms`.
async fn within<T>(ms: u64, f: impl std::future::Future<Output = T>) -> Option<T> {
    use std::future::Future;
    use std::task::Poll;
    let mut f = std::pin::pin!(f);
    let mut late = std::pin::pin!(Delay::from(std::time::Duration::from_millis(ms)));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(v) = f.as_mut().poll(cx) {
            return Poll::Ready(Some(v));
        }
        if late.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

async fn call(stub: &Stub, path: &str, body: Option<String>, timeout_ms: u64) -> Result<Response> {
    let mut init = RequestInit::new();
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.unwrap_or_default().into()));
    let req = Request::new_with_init(&format!("https://kokoro{path}"), &init)?;
    within(timeout_ms, stub.fetch_with_request(req))
        .await
        .unwrap_or_else(|| Err(Error::RustError("Kokoro took too long".into())))
}

/// `text` read by Kokoro in `voice`, as MP3. `Ok(None)` while Kokoro is not
/// set up here.
pub(crate) async fn speak(env: &Env, text: &str, voice: &str) -> Result<Option<Vec<u8>>> {
    let Some(stub) = stub(env) else { return Ok(None) };
    let body = json!({ "text": text, "voice": voice }).to_string();
    let mut res = call(&stub, "/speak", Some(body), SPEAK_TIMEOUT_MS).await?;
    match res.status_code() {
        200 => Ok(Some(res.bytes().await?)),
        // No container in this deploy.
        501 => Ok(None),
        code => Err(Error::RustError(format!(
            "Kokoro said {code}: {}",
            res.text().await.unwrap_or_default().chars().take(200).collect::<String>()
        ))),
    }
}

/// Start the container now, so it is ready when the payment goes through.
pub(crate) fn warm(env: &Env) {
    if let Some(stub) = stub(env) {
        wasm_bindgen_futures::spawn_local(async move {
            let _ = call(&stub, "/warm", None, 30_000).await;
        });
    }
}

#[durable_object]
pub struct KokoroDo {
    state: State,
}

impl KokoroDo {
    /// Start the container if it is not running and wait until it answers.
    async fn ready(&self, c: &Container) -> Result<Fetcher> {
        if !c.running() {
            c.start(None)?;
        }
        let port = c.get_tcp_port(PORT)?;
        for _ in 0..120 {
            if let Ok(r) = port.fetch("http://kokoro/health", None).await {
                if r.status_code() == 200 {
                    return Ok(port);
                }
            }
            Delay::from(std::time::Duration::from_millis(250)).await;
        }
        Err(Error::RustError("Kokoro did not start".into()))
    }
}

impl DurableObject for KokoroDo {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let Some(c) = self.state.container() else {
            return Response::error("Kokoro is not deployed", 501);
        };
        // Stop after a while without use.
        self.state.storage().set_alarm(IDLE_MS).await?;
        let port = self.ready(&c).await?;
        match (req.method(), req.path().as_str()) {
            (Method::Post, "/warm") => Response::ok("ready"),
            (Method::Post, "/speak") => {
                let body = req.text().await?;
                let headers = Headers::new();
                headers.set("Content-Type", "application/json")?;
                let mut init = RequestInit::new();
                init.with_method(Method::Post)
                    .with_headers(headers)
                    .with_body(Some(body.into()));
                port.fetch_request(Request::new_with_init("http://kokoro/speak", &init)?)
                    .await
            }
            _ => Response::error("Not found", 404),
        }
    }

    async fn alarm(&self) -> Result<Response> {
        if let Some(c) = self.state.container() {
            if c.running() {
                c.destroy(None).await?;
            }
        }
        Response::ok("stopped")
    }
}

//! The dashboard's files, embedded at build time (see `build.rs`).

use worker::*;

macro_rules! web_file {
    ($path:literal) => {
        include_bytes!(concat!(env!("OUT_DIR"), "/web/", $path))
    };
}

/// Hashes of the page's inline scripts, for its Content-Security-Policy.
const SCRIPT_HASHES: &str = include_str!(concat!(env!("OUT_DIR"), "/web/script-hashes.txt"));

/// Twitch profile pictures are the only images from elsewhere. Tip pages
/// also load Stripe.js, which draws the payment form in Stripe's own frames.
fn content_security_policy(tip_page: bool) -> String {
    if tip_page {
        return format!(
            "default-src 'self'; script-src 'self' {SCRIPT_HASHES} https://js.stripe.com; \
             style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: https://static-cdn.jtvnw.net https://*.stripe.com; font-src 'self'; \
             connect-src 'self' https://api.stripe.com https://merchant-ui-api.stripe.com https://*.stripe.com; \
             frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com; \
             object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        );
    }
    format!(
        "default-src 'self'; script-src 'self' {SCRIPT_HASHES}; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: https://static-cdn.jtvnw.net; font-src 'self'; connect-src 'self'; \
         object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    )
}

/// A dashboard file for a path, with its content type. Unknown paths get
/// `index.html`, so the dashboard can route them itself. `versioned` is true
/// when the link carries `?v=`, which changes with every build, so the file
/// can be kept for a year.
pub fn serve(path: &str, versioned: bool) -> Result<Response> {
    if let Some(id) = path
        .strip_prefix("/kokoro/demos/")
        .and_then(|f| f.strip_suffix(".mp3"))
    {
        return demo(id);
    }
    let asset_cache = if versioned {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=60"
    };
    let (body, kind, cache): (&[u8], &str, &str) = match path {
        "/assets/app.js" => (
            web_file!("assets/app.js"),
            "text/javascript; charset=utf-8",
            asset_cache,
        ),
        "/assets/index.css" => (
            web_file!("assets/index.css"),
            "text/css; charset=utf-8",
            asset_cache,
        ),
        "/logo.svg" => (
            web_file!("logo.svg"),
            "image/svg+xml",
            "public, max-age=86400",
        ),
        "/mod-badge.png" => (
            web_file!("mod-badge.png"),
            "image/png",
            "public, max-age=86400",
        ),
        "/fonts/inter-latin-wght.woff2" => (
            web_file!("fonts/inter-latin-wght.woff2"),
            "font/woff2",
            "public, max-age=31536000, immutable",
        ),
        "/fonts/LICENSE-Inter.txt" => (
            web_file!("fonts/LICENSE-Inter.txt"),
            "text/plain; charset=utf-8",
            "public, max-age=86400",
        ),
        "/fonts/geist-wght.woff2" => (
            web_file!("fonts/geist-wght.woff2"),
            "font/woff2",
            "public, max-age=31536000, immutable",
        ),
        "/fonts/geist-mono-wght.woff2" => (
            web_file!("fonts/geist-mono-wght.woff2"),
            "font/woff2",
            "public, max-age=31536000, immutable",
        ),
        "/fonts/LICENSE-Geist.txt" => (
            web_file!("fonts/LICENSE-Geist.txt"),
            "text/plain; charset=utf-8",
            "public, max-age=86400",
        ),
        "/LICENSE-Phosphor.txt" => (
            web_file!("LICENSE-Phosphor.txt"),
            "text/plain; charset=utf-8",
            "public, max-age=86400",
        ),
        _ => (
            web_file!("index.html"),
            "text/html; charset=utf-8",
            "no-cache",
        ),
    };
    let mut res = Response::from_bytes(body.to_vec())?;
    let h = res.headers_mut();
    h.set("Content-Type", kind)?;
    h.set("Cache-Control", cache)?;
    h.set("X-Content-Type-Options", "nosniff")?;
    if kind.starts_with("text/html") {
        h.set(
            "Content-Security-Policy",
            &content_security_policy(path.starts_with("/tip/")),
        )?;
        h.set("X-Frame-Options", "DENY")?;
        h.set("Referrer-Policy", "same-origin")?;
        h.set(
            "Permissions-Policy",
            if path.starts_with("/tip/") {
                "camera=(), microphone=(), geolocation=(), payment=(self \"https://js.stripe.com\")"
            } else {
                "camera=(), microphone=(), geolocation=()"
            },
        )?;
    }
    Ok(res)
}

/// The short demo of a Kokoro voice played on the tip page and dashboard.
fn demo(id: &str) -> Result<Response> {
    let body: &[u8] = match id {
        "af_alloy" => include_bytes!("../demos/af_alloy.mp3"),
        "af_aoede" => include_bytes!("../demos/af_aoede.mp3"),
        "af_bella" => include_bytes!("../demos/af_bella.mp3"),
        "af_heart" => include_bytes!("../demos/af_heart.mp3"),
        "af_jessica" => include_bytes!("../demos/af_jessica.mp3"),
        "af_kore" => include_bytes!("../demos/af_kore.mp3"),
        "af_nicole" => include_bytes!("../demos/af_nicole.mp3"),
        "af_nova" => include_bytes!("../demos/af_nova.mp3"),
        "af_river" => include_bytes!("../demos/af_river.mp3"),
        "af_sarah" => include_bytes!("../demos/af_sarah.mp3"),
        "af_sky" => include_bytes!("../demos/af_sky.mp3"),
        "am_adam" => include_bytes!("../demos/am_adam.mp3"),
        "am_echo" => include_bytes!("../demos/am_echo.mp3"),
        "am_eric" => include_bytes!("../demos/am_eric.mp3"),
        "am_fenrir" => include_bytes!("../demos/am_fenrir.mp3"),
        "am_liam" => include_bytes!("../demos/am_liam.mp3"),
        "am_michael" => include_bytes!("../demos/am_michael.mp3"),
        "am_onyx" => include_bytes!("../demos/am_onyx.mp3"),
        "am_puck" => include_bytes!("../demos/am_puck.mp3"),
        "am_santa" => include_bytes!("../demos/am_santa.mp3"),
        "bf_alice" => include_bytes!("../demos/bf_alice.mp3"),
        "bf_emma" => include_bytes!("../demos/bf_emma.mp3"),
        "bf_isabella" => include_bytes!("../demos/bf_isabella.mp3"),
        "bf_lily" => include_bytes!("../demos/bf_lily.mp3"),
        "bm_daniel" => include_bytes!("../demos/bm_daniel.mp3"),
        "bm_fable" => include_bytes!("../demos/bm_fable.mp3"),
        "bm_george" => include_bytes!("../demos/bm_george.mp3"),
        "bm_lewis" => include_bytes!("../demos/bm_lewis.mp3"),
        _ => return Response::error("Not found", 404),
    };
    let headers = Headers::new();
    headers.set("Content-Type", "audio/mpeg")?;
    headers.set("Cache-Control", "public, max-age=86400")?;
    Ok(Response::from_bytes(body.to_vec())?.with_headers(headers))
}

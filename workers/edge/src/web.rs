//! The dashboard's files, embedded at build time (see `build.rs`).

use worker::*;

macro_rules! web_file {
    ($path:literal) => {
        include_bytes!(concat!(env!("OUT_DIR"), "/web/", $path))
    };
}

/// Hashes of the page's inline scripts, for its Content-Security-Policy.
const SCRIPT_HASHES: &str = include_str!(concat!(env!("OUT_DIR"), "/web/script-hashes.txt"));

/// Twitch profile pictures are the only images from elsewhere.
fn content_security_policy() -> String {
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
        "/LICENSE-Lucide.txt" => (
            web_file!("LICENSE-Lucide.txt"),
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
        h.set("Content-Security-Policy", &content_security_policy())?;
        h.set("X-Frame-Options", "DENY")?;
        h.set("Referrer-Policy", "same-origin")?;
        h.set(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=()",
        )?;
    }
    Ok(res)
}

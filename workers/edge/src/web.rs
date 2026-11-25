//! The dashboard's files, embedded at build time (see `build.rs`).

use worker::*;

macro_rules! web_file {
    ($path:literal) => {
        include_bytes!(concat!(env!("OUT_DIR"), "/web/", $path))
    };
}

/// A dashboard file for a path, with its content type. Unknown paths get
/// `index.html`, so the dashboard can route them itself.
pub fn serve(path: &str) -> Result<Response> {
    let (body, kind, cache): (&[u8], &str, &str) = match path {
        "/assets/app.js" => (
            web_file!("assets/app.js"),
            "text/javascript; charset=utf-8",
            "public, max-age=60",
        ),
        "/assets/index.css" => (
            web_file!("assets/index.css"),
            "text/css; charset=utf-8",
            "public, max-age=60",
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
    Ok(res)
}

//! Embeds the dashboard (built by `npm run build:web` into `web/dist`) into the
//! Worker, so one upload carries everything.
//!
//! Why not Workers static assets: deploys from Claude's cloud sessions go
//! through a proxy that replaces the API token on every Cloudflare request,
//! including the asset upload, which needs its own short lived token. Embedding
//! sidesteps that, and the dashboard is small (about 100 KB gzipped).
//!
//! When `web/dist` has not been built (for example `cargo clippy` alone), each
//! file is replaced by a short note so the Worker still compiles.

use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};

/// Files the Worker serves, as written by Vite (see web/vite.config.ts).
const FILES: &[&str] = &[
    "index.html",
    "assets/app.js",
    "assets/index.css",
    "logo.svg",
    "LICENSE-Lucide.txt",
    "fonts/inter-latin-wght.woff2",
    "fonts/LICENSE-Inter.txt",
    "fonts/geist-wght.woff2",
    "fonts/geist-mono-wght.woff2",
    "fonts/LICENSE-Geist.txt",
];

/// Files that `index.html` links with a version, so browsers can keep them
/// for a year and still fetch a new build at once.
const VERSIONED: &[&str] = &["/assets/app.js", "/assets/index.css"];

fn main() {
    let dist = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../web/dist");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("web");
    println!("cargo:rerun-if-changed={}", dist.display());
    for f in FILES {
        let src = dist.join(f);
        println!("cargo:rerun-if-changed={}", src.display());
        let dst = out.join(f);
        fs::create_dir_all(dst.parent().unwrap()).unwrap();
        let bytes = fs::read(&src)
            .unwrap_or_else(|_| b"The dashboard is not built. Run npm run build:web.".to_vec());
        fs::write(&dst, bytes).unwrap();
    }

    // Point index.html at versioned files: `/assets/app.js?v=<hash>`.
    let index_path = out.join("index.html");
    let mut index = fs::read_to_string(&index_path).unwrap();
    for f in VERSIONED {
        let bytes = fs::read(out.join(f.trim_start_matches('/'))).unwrap();
        let version = &hex(&Sha256::digest(&bytes))[..12];
        index = index.replace(&format!("\"{f}\""), &format!("\"{f}?v={version}\""));
    }
    fs::write(&index_path, &index).unwrap();

    // The page's Content-Security-Policy allows its one inline script (the
    // theme, applied before paint) by hash, and no other inline script.
    let hashes: Vec<String> = inline_scripts(&index)
        .map(|s| format!("'sha256-{}'", base64(&Sha256::digest(s.as_bytes()))))
        .collect();
    fs::write(out.join("script-hashes.txt"), hashes.join(" ")).unwrap();
}

/// The bodies of `<script>` tags without attributes.
fn inline_scripts(html: &str) -> impl Iterator<Item = &str> {
    html.split("<script>")
        .skip(1)
        .filter_map(|rest| rest.split_once("</script>").map(|(body, _)| body))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

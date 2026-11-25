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
];

fn main() {
    let dist = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../web/dist");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("web");
    println!("cargo:rerun-if-changed={}", dist.display());
    for f in FILES {
        let src = dist.join(f);
        println!("cargo:rerun-if-changed={}", src.display());
        let dst = out.join(f);
        fs::create_dir_all(dst.parent().unwrap()).unwrap();
        match fs::read(&src) {
            Ok(bytes) => fs::write(&dst, bytes).unwrap(),
            Err(_) => {
                fs::write(&dst, b"The dashboard is not built. Run npm run build:web.").unwrap()
            }
        }
    }
}

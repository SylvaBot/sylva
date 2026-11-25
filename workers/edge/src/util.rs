//! Small helpers shared by the Worker and its Durable Objects.

use worker::js_sys::{Function, Reflect, Uint8Array};
use worker::wasm_bindgen::JsCast;
use worker::*;

/// `N` bytes from the runtime's cryptographic random source
/// (`crypto.getRandomValues`).
pub fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let global = js_sys::global();
    let crypto = Reflect::get(&global, &"crypto".into())?;
    let get: Function = Reflect::get(&crypto, &"getRandomValues".into())?
        .dyn_into()
        .map_err(|_| Error::RustError("crypto.getRandomValues is missing".into()))?;
    let buf = Uint8Array::new_with_length(N as u32);
    get.call1(&crypto, &buf)?;
    let mut out = [0u8; N];
    buf.copy_to(&mut out);
    Ok(out)
}

/// `len` random bytes as lowercase hex (so `2 * len` characters).
pub fn random_hex(len: usize) -> Result<String> {
    let mut out = String::with_capacity(len * 2);
    let mut left = len;
    while left > 0 {
        let chunk = random_bytes::<32>()?;
        let n = left.min(32);
        out.push_str(&hex_encode(&chunk[..n]));
        left -= n;
    }
    Ok(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

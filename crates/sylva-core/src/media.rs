//! Sounds and images a streamer uploads for their alerts. The channel's
//! Durable Object keeps them, in pieces small enough for one SQLite row, and
//! serves them at `/media/{channel}/{id}` to the overlay.

/// The largest file, in bytes.
pub const MAX_FILE: usize = 3_000_000;
/// The most files a channel keeps.
pub const MAX_FILES: usize = 30;
/// The most bytes a channel keeps, all files together.
pub const MAX_TOTAL: usize = 40_000_000;
/// Raw bytes per stored piece. Stored as base64, a piece stays under 1 MB.
pub const CHUNK: usize = 700_000;
pub const MAX_NAME: usize = 60;

/// What a file is, from its first bytes, never from what the browser said.
/// `(media type, extension, is a sound)`.
pub fn sniff(b: &[u8]) -> Option<(&'static str, &'static str, bool)> {
    let at = |i: usize, s: &[u8]| b.len() >= i + s.len() && &b[i..i + s.len()] == s;
    if at(0, b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png", false))
    } else if at(0, b"\xff\xd8\xff") {
        Some(("image/jpeg", "jpg", false))
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        Some(("image/gif", "gif", false))
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some(("image/webp", "webp", false))
    } else if at(0, b"RIFF") && at(8, b"WAVE") {
        Some(("audio/wav", "wav", true))
    } else if at(0, b"OggS") {
        Some(("audio/ogg", "ogg", true))
    } else if at(0, b"ID3") || (b.len() > 1 && b[0] == 0xff && b[1] & 0xe0 == 0xe0) {
        Some(("audio/mpeg", "mp3", true))
    } else {
        None
    }
}

/// A stored file's id: 16 hex characters, a dot and a known extension.
pub fn valid_id(id: &str) -> bool {
    match id.split_once('.') {
        Some((h, ext)) => {
            h.len() == 16
                && h.bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                && matches!(ext, "png" | "jpg" | "gif" | "webp" | "wav" | "ogg" | "mp3")
        }
        None => false,
    }
}

/// The media type for a stored id.
pub fn type_of(id: &str) -> &'static str {
    match id.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        _ => "audio/mpeg",
    }
}

pub fn is_sound(id: &str) -> bool {
    type_of(id).starts_with("audio/")
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= c.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        if c == b'=' {
            break;
        }
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip() {
        for data in [
            &b""[..],
            b"f",
            b"fo",
            b"foo",
            b"foob",
            b"\x00\xff\x10\x80hello",
        ] {
            assert_eq!(b64_decode(&b64_encode(data)).unwrap(), data);
        }
        assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn files_are_known_by_their_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest").unwrap().1, "png");
        assert_eq!(sniff(b"ID3\x04").unwrap().1, "mp3");
        assert_eq!(sniff(b"RIFF\0\0\0\0WAVEfmt ").unwrap().1, "wav");
        assert!(sniff(b"<svg onload=x>").is_none());
        assert!(valid_id("0123456789abcdef.mp3"));
        assert!(!valid_id("0123456789abcdef.svg"));
        assert!(!valid_id("../etc.mp3"));
    }
}

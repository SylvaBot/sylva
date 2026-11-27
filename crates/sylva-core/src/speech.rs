//! Text to speech for tips: signing Amazon Polly requests and measuring the
//! MP3 that comes back, so an alert stays up while its message is read.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

/// The voice tips are read in: Amazon Polly's standard Brian.
pub const POLLY_VOICE: &str = "Brian";

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("any key length works");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sha_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// `2026-11-27T03:57:10.123Z` to `20261127T035710Z`.
pub fn amz_date(iso: &str) -> String {
    let head = iso.split('.').next().unwrap_or(iso).trim_end_matches('Z');
    let mut out: String = head.chars().filter(|c| *c != '-' && *c != ':').collect();
    out.push('Z');
    out
}

/// One AWS request to sign with Signature Version 4.
pub struct AwsRequest<'a> {
    pub method: &'a str,
    pub host: &'a str,
    pub path: &'a str,
    /// Already in canonical form (sorted, encoded), or empty.
    pub query: &'a str,
    /// Headers to sign besides `host` and `x-amz-date`.
    pub headers: &'a [(&'a str, &'a str)],
    pub body: &'a [u8],
    pub region: &'a str,
    pub service: &'a str,
    /// From [`amz_date`].
    pub date: &'a str,
}

/// The `Authorization` header for `req`. Send `x-amz-date: req.date` and
/// every header in `req.headers` with it.
pub fn aws_authorization(req: &AwsRequest, access_key: &str, secret_key: &str) -> String {
    let mut headers: Vec<(String, String)> = req
        .headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
        .chain([
            ("host".to_string(), req.host.to_string()),
            ("x-amz-date".to_string(), req.date.to_string()),
        ])
        .collect();
    headers.sort();
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed: Vec<&str> = headers.iter().map(|(k, _)| k.as_str()).collect();
    let signed = signed.join(";");
    let canonical = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        req.method,
        req.path,
        req.query,
        canonical_headers,
        signed,
        sha_hex(req.body)
    );
    let day = &req.date[..8.min(req.date.len())];
    let scope = format!("{day}/{}/{}/aws4_request", req.region, req.service);
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        req.date,
        sha_hex(canonical.as_bytes())
    );
    let k = hmac(format!("AWS4{secret_key}").as_bytes(), day);
    let k = hmac(&k, req.region);
    let k = hmac(&k, req.service);
    let k = hmac(&k, "aws4_request");
    let signature = hex::encode(hmac(&k, &to_sign));
    format!("AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={signature}")
}

/// How long an MP3 plays, in milliseconds, from its frame headers. None
/// when no frames are found.
pub fn mp3_ms(data: &[u8]) -> Option<u32> {
    let mut i = 0;
    // Skip an ID3v2 tag.
    if data.len() > 10 && &data[..3] == b"ID3" {
        let size = data[6..10]
            .iter()
            .fold(0usize, |n, b| (n << 7) | (*b as usize & 0x7f));
        i = 10 + size;
    }
    const RATES_V1: [u32; 15] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    ];
    const RATES_V2: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let mut micros: u64 = 0;
    let mut frames = 0;
    while i + 4 <= data.len() {
        let h = &data[i..i + 4];
        let version = (h[1] >> 3) & 3; // 3: MPEG 1, 2: MPEG 2, 0: MPEG 2.5
        let layer = (h[1] >> 1) & 3; // 1: Layer III
        let rate_i = (h[2] >> 4) as usize;
        let freq_i = ((h[2] >> 2) & 3) as usize;
        if h[0] != 0xff
            || h[1] & 0xe0 != 0xe0
            || version == 1
            || layer != 1
            || rate_i == 0
            || rate_i == 15
            || freq_i == 3
        {
            i += 1;
            continue;
        }
        let base = [44_100u32, 48_000, 32_000][freq_i];
        let (freq, kbps, samples, coef) = match version {
            3 => (base, RATES_V1[rate_i], 1152u32, 144u32),
            2 => (base / 2, RATES_V2[rate_i], 576, 72),
            _ => (base / 4, RATES_V2[rate_i], 576, 72),
        };
        let pad = ((h[2] >> 1) & 1) as u32;
        let len = (coef * kbps * 1000 / freq + pad) as usize;
        micros += samples as u64 * 1_000_000 / freq as u64;
        frames += 1;
        i += len.max(1);
    }
    (frames > 0).then(|| (micros / 1000) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_like_aws() {
        // AWS's own Signature Version 4 test suite, case "get-vanilla".
        let req = AwsRequest {
            method: "GET",
            host: "example.amazonaws.com",
            path: "/",
            query: "",
            headers: &[],
            body: b"",
            region: "us-east-1",
            service: "service",
            date: "20150830T123600Z",
        };
        assert_eq!(
            aws_authorization(
                &req,
                "AKIDEXAMPLE",
                "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
            ),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, \
             Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
        assert_eq!(amz_date("2026-11-27T03:57:10.123Z"), "20261127T035710Z");
    }

    #[test]
    fn measures_mp3() {
        // 100 frames of MPEG 2 Layer III, 24 kHz, 48 kbps: 576 samples
        // and 144 bytes each, 2.4 seconds in all.
        let mut frame = vec![0u8; 144];
        frame[..4].copy_from_slice(&[0xff, 0xf3, 0x64, 0xc4]);
        let mut data = b"ID3\x03\x00\x00\x00\x00\x00\x02xx".to_vec();
        for _ in 0..100 {
            data.extend_from_slice(&frame);
        }
        assert_eq!(mp3_ms(&data), Some(2400));
        assert_eq!(mp3_ms(b"not audio"), None);
    }
}

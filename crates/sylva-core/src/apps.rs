//! Signing apps such as Sylva Desktop in to Sylva with a device code, and the API
//! tokens they get.
//!
//! The flow follows OAuth's device authorization grant (RFC 8628):
//!
//! 1. The app asks for a code (`POST /v1/device/code`) and shows the streamer
//!    a short user code, such as `BCDF-GHJK`, and the page to enter it on.
//! 2. The streamer, signed in to Sylva in a browser, enters the code on
//!    `/device` and approves the app.
//! 3. The app polls `POST /v1/device/token` with its private device code until
//!    it gets an API token, then calls the API with
//!    `Authorization: Bearer sylva_<account id>.<secret>`.
//!
//! An API token is like a session that never expires on its own: the account
//! stores only a hash of its secret, and the streamer can revoke it in
//! Settings.

use serde::{Deserialize, Serialize};

use crate::auth::SessionToken;

/// Device codes last this long.
pub const DEVICE_CODE_SECS: i64 = 600;
/// How often an app should poll for its token.
pub const POLL_SECS: i64 = 5;
/// Every API token starts with this, so it can be told apart from the admin
/// token and spotted by secret scanners.
pub const API_TOKEN_PREFIX: &str = "sylva_";
pub const MAX_APP_NAME: usize = 40;

/// Letters only, without vowels (no accidental words) and without the
/// easily confused I, O, U, Y.
const USER_CODE_ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";

/// Make a user code such as `BCDF-GHJK` from 8 random bytes.
pub fn user_code(random: [u8; 8]) -> String {
    let mut out = String::with_capacity(9);
    for (i, b) in random.iter().enumerate() {
        if i == 4 {
            out.push('-');
        }
        // 256 is not a multiple of 20, so this is very slightly uneven; with
        // 20^8 codes and a 10 minute life that does not matter.
        out.push(USER_CODE_ALPHABET[*b as usize % USER_CODE_ALPHABET.len()] as char);
    }
    out
}

/// Read a code the way a person might type it: any case, with or without
/// the dash or spaces. Returns the canonical `XXXX-XXXX` form.
pub fn normalize_user_code(input: &str) -> Option<String> {
    let letters: String = input
        .chars()
        .filter(|c| !matches!(c, '-' | ' ' | '\t'))
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if letters.len() != 8 || !letters.bytes().all(|b| USER_CODE_ALPHABET.contains(&b)) {
        return None;
    }
    Some(format!("{}-{}", &letters[..4], &letters[4..]))
}

/// The bearer token an app sends.
pub fn api_token(token: &SessionToken) -> String {
    format!("{API_TOKEN_PREFIX}{}", token.to_cookie_value())
}

/// Read `Authorization: Bearer sylva_...`. Other bearer values (the admin
/// token) give `None`.
pub fn parse_api_token(authorization: &str) -> Option<SessionToken> {
    let value = authorization.strip_prefix("Bearer ")?.trim();
    SessionToken::parse(value.strip_prefix(API_TOKEN_PREFIX)?)
}

/// A friendly, safe app name for the token list.
pub fn clean_app_name(name: Option<&str>) -> String {
    let name: String = name
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_APP_NAME)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "An app".into()
    } else {
        name.into()
    }
}

/// `POST /v1/device/code` reply. Field names follow RFC 8628.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: i64,
    pub interval: i64,
}

/// `POST /v1/device/token` reply once approved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceToken {
    pub access_token: String,
    pub token_type: String,
    pub account_id: String,
}

/// One API token as Settings lists it. The secret is never shown again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppToken {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_codes_are_readable_and_round_trip() {
        let code = user_code([0, 1, 2, 3, 19, 20, 255, 128]);
        assert_eq!(code.len(), 9);
        assert_eq!(&code[4..5], "-");
        assert!(code
            .bytes()
            .filter(|b| *b != b'-')
            .all(|b| USER_CODE_ALPHABET.contains(&b)));
        assert_eq!(normalize_user_code(&code), Some(code.clone()));
        assert_eq!(
            normalize_user_code(&code.to_lowercase().replace('-', " ")),
            Some(code)
        );
    }

    #[test]
    fn bad_user_codes_are_refused() {
        assert_eq!(normalize_user_code("BCDF-GHJ"), None);
        assert_eq!(
            normalize_user_code("BCDF-GHJA"),
            None,
            "vowels are never used"
        );
        assert_eq!(normalize_user_code("BCDF-GHJK-L"), None);
        assert_eq!(normalize_user_code(""), None);
    }

    #[test]
    fn api_tokens_parse_only_with_the_prefix() {
        let t = SessionToken {
            account_id: "a".repeat(32),
            secret: "b".repeat(64),
        };
        let bearer = format!("Bearer {}", api_token(&t));
        assert_eq!(parse_api_token(&bearer), Some(t.clone()));
        assert_eq!(
            parse_api_token(&format!("Bearer {}", t.to_cookie_value())),
            None
        );
        assert_eq!(parse_api_token("Bearer local-dev-admin-token"), None);
        assert_eq!(
            parse_api_token(&api_token(&t)),
            None,
            "needs the Bearer scheme"
        );
    }

    #[test]
    fn app_names_are_cleaned() {
        assert_eq!(clean_app_name(Some("  Sylva Desktop  ")), "Sylva Desktop");
        assert_eq!(clean_app_name(Some("a\u{0}b")), "ab");
        assert_eq!(clean_app_name(None), "An app");
        assert_eq!(clean_app_name(Some(&"x".repeat(100))).len(), MAX_APP_NAME);
    }
}

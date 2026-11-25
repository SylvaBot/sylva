//! Sign in and sessions, without any HTTP or Cloudflare code.
//!
//! * Twitch sign in uses the authorization code flow with a confidential
//!   client: the client secret stays on the server. [`TWITCH_SCOPES`] lists
//!   what Sylva asks for and why, in plain words the sign in page shows.
//! * A web session is a cookie holding `<account id>.<secret>`. The account
//!   stores only [`hash_secret`] of the secret, so a leaked database cannot be
//!   turned into working cookies, and signing out deletes the hash.
//! * Platform tokens are encrypted at rest with AES-256-GCM ([`seal`] and
//!   [`open`]) under a key kept as a Worker secret.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};

/// Twitch scopes Sylva asks for at sign in, each with the reason shown to the
/// streamer. Phase 1 needs exactly these for follows, subs, cheers and chat.
pub const TWITCH_SCOPES: &[(&str, &str)] = &[
    ("moderator:read:followers", "See new followers"),
    (
        "channel:read:subscriptions",
        "See new subs, resubs and gifted subs",
    ),
    ("bits:read", "See cheers"),
    ("user:read:chat", "Read your chat"),
    // Reading chat with an app token also needs these two. They show Twitch
    // that Sylva reads chat on the channel's behalf.
    ("user:bot", "Read your chat"),
    ("channel:bot", "Read your chat"),
];

/// Scopes asked for only when the streamer turns on moderation, so signing in
/// asks for no more than the basics.
pub const MOD_SCOPES: &[(&str, &str)] = &[
    (
        "moderator:manage:chat_messages",
        "Delete messages that break your chat rules",
    ),
    (
        "moderator:manage:banned_users",
        "Time out chatters who keep breaking them",
    ),
];

/// Asked for only when the streamer lets lurkers earn loyalty points.
pub const LOYALTY_SCOPES: &[(&str, &str)] = &[(
    "moderator:read:chatters",
    "See who is in your chat, so viewers who only watch earn points too",
)];

/// Extra permissions, each asked for only when its feature needs it, and
/// kept as its own grant so a plain sign in does not take it away.
pub const GRANTS: &[(&str, &[(&str, &str)])] =
    &[("moderation", MOD_SCOPES), ("loyalty", LOYALTY_SCOPES)];

/// True when `granted` holds every scope of `purpose`.
pub fn has_grant(purpose: &str, granted: &[String]) -> bool {
    GRANTS
        .iter()
        .find(|(p, _)| *p == purpose)
        .is_some_and(|(_, scopes)| scopes.iter().all(|(s, _)| granted.iter().any(|g| g == s)))
}

/// True when `granted` holds every moderation scope.
pub fn can_moderate(granted: &[String]) -> bool {
    has_grant("moderation", granted)
}

/// How long a web session lasts.
pub const SESSION_DAYS: i64 = 30;
/// Name of the session cookie.
pub const SESSION_COOKIE: &str = "sylva_session";
/// Name of the short lived cookie that holds the OAuth `state`.
pub const STATE_COOKIE: &str = "sylva_oauth";

/// The space separated scope string Twitch expects, without duplicates.
pub fn scope_string() -> String {
    let mut seen: Vec<&str> = Vec::new();
    for (s, _) in TWITCH_SCOPES {
        if !seen.contains(s) {
            seen.push(s);
        }
    }
    seen.join(" ")
}

/// Scopes from [`TWITCH_SCOPES`] that `granted` does not include.
pub fn missing_scopes(granted: &[String]) -> Vec<&'static str> {
    let mut out = Vec::new();
    for (s, _) in TWITCH_SCOPES {
        if !granted.iter().any(|g| g == s) && !out.contains(s) {
            out.push(*s);
        }
    }
    out
}

/// Percent-encode a query value (everything except RFC 3986 unreserved bytes).
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The Twitch page that asks the streamer to approve Sylva.
/// `auth_base` is `https://id.twitch.tv/oauth2` in production. `extra`
/// names [`GRANTS`] to ask for as well, such as `moderation`.
pub fn twitch_authorize_url(
    auth_base: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    extra: &[&str],
) -> String {
    let mut scopes = scope_string();
    for (purpose, list) in GRANTS {
        if extra.contains(purpose) {
            for (s, _) in *list {
                if !scopes.split(' ').any(|x| x == *s) {
                    scopes.push(' ');
                    scopes.push_str(s);
                }
            }
        }
    }
    authorize_url(auth_base, client_id, redirect_uri, state, &scopes, false)
}

/// The Twitch approval page for the shared bot account: only [`BOT_SCOPES`], and
/// Twitch asks which account to use, so the bot account can be picked even
/// while the streamer is signed in to Twitch.
pub fn twitch_bot_authorize_url(
    auth_base: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
) -> String {
    authorize_url(
        auth_base,
        client_id,
        redirect_uri,
        state,
        &BOT_SCOPES.join(" "),
        true,
    )
}

/// What the shared bot account grants: `user:bot` to be a bot, and
/// `user:write:chat`, which Twitch also asks of whoever sends a chat message
/// with the app's token.
pub const BOT_SCOPES: &[&str] = &["user:bot", "user:write:chat"];

fn authorize_url(
    auth_base: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    scopes: &str,
    force_verify: bool,
) -> String {
    format!(
        "{}/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}{}",
        auth_base.trim_end_matches('/'),
        encode(client_id),
        encode(redirect_uri),
        encode(scopes),
        encode(state),
        if force_verify {
            "&force_verify=true"
        } else {
            ""
        },
    )
}

/// Find a cookie's value in a `Cookie` request header.
pub fn cookie<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|part| {
        let (k, v) = part.trim().split_once('=')?;
        (k == name && !v.is_empty()).then_some(v)
    })
}

/// A `Set-Cookie` value. `max_age` 0 deletes the cookie. `secure` should be
/// true on https; browsers also accept it on `http://localhost`, but keeping
/// it off there lets every local browser sign in.
pub fn set_cookie(name: &str, value: &str, path: &str, max_age: i64, secure: bool) -> String {
    format!(
        "{name}={value}; Path={path}; Max-Age={max_age}; HttpOnly; SameSite=Lax{}",
        if secure { "; Secure" } else { "" }
    )
}

/// The two halves of a session cookie: `<account id>.<secret>`, both hex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionToken {
    pub account_id: String,
    pub secret: String,
}

impl SessionToken {
    pub fn parse(value: &str) -> Option<Self> {
        let (account_id, secret) = value.split_once('.')?;
        let hex = |s: &str, len: usize| {
            s.len() == len
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        (hex(account_id, 32) && hex(secret, 64)).then(|| SessionToken {
            account_id: account_id.into(),
            secret: secret.into(),
        })
    }

    pub fn to_cookie_value(&self) -> String {
        format!("{}.{}", self.account_id, self.secret)
    }
}

/// What the account stores instead of the session secret.
pub fn hash_secret(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// Parse a 32 byte key written as 64 hex characters.
pub fn parse_key(hex_key: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(hex_key.trim()).ok()?;
    bytes.try_into().ok()
}

/// Encrypt a token. `nonce` must be 12 fresh random bytes for every call.
/// The result is `v1.<hex nonce><hex ciphertext>`.
pub fn seal(key: &[u8; 32], nonce: [u8; 12], plaintext: &str) -> String {
    let cipher = Aes256Gcm::new(key.into());
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .expect("AES-GCM encryption does not fail for small inputs");
    format!("v1.{}{}", hex::encode(nonce), hex::encode(ct))
}

/// Decrypt what [`seal`] produced. `None` if the key is wrong or the value was changed.
pub fn open(key: &[u8; 32], sealed: &str) -> Option<String> {
    let bytes = hex::decode(sealed.strip_prefix("v1.")?).ok()?;
    if bytes.len() < 12 + 16 {
        return None;
    }
    let (nonce, ct) = bytes.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    let pt = cipher.decrypt(Nonce::from_slice(nonce), ct).ok()?;
    String::from_utf8(pt).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_string_has_no_duplicates() {
        let s = scope_string();
        assert_eq!(
            s,
            "moderator:read:followers channel:read:subscriptions bits:read user:read:chat user:bot channel:bot"
        );
    }

    #[test]
    fn missing_scopes_lists_what_is_not_granted() {
        let granted = vec!["bits:read".to_string(), "user:read:chat".to_string()];
        assert_eq!(
            missing_scopes(&granted),
            vec![
                "moderator:read:followers",
                "channel:read:subscriptions",
                "user:bot",
                "channel:bot"
            ]
        );
        let all: Vec<String> = scope_string().split(' ').map(String::from).collect();
        assert!(missing_scopes(&all).is_empty());
    }

    #[test]
    fn authorize_url_is_encoded() {
        let url = twitch_authorize_url(
            "https://id.twitch.tv/oauth2/",
            "abc",
            "https://x.dev/auth/twitch/callback",
            "s t",
            &[],
        );
        assert!(url.starts_with(
            "https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=abc&"
        ));
        assert!(url.contains("redirect_uri=https%3A%2F%2Fx.dev%2Fauth%2Ftwitch%2Fcallback"));
        assert!(url.contains("scope=moderator%3Aread%3Afollowers%20channel%3Aread%3Asubscriptions"));
        assert!(url.ends_with("state=s%20t"));
        assert!(!url.contains("manage"));
        let m = twitch_authorize_url("https://a", "abc", "https://x", "s", &["moderation"]);
        assert!(m.contains(
            "%20moderator%3Amanage%3Achat_messages%20moderator%3Amanage%3Abanned_users&"
        ));
    }

    #[test]
    fn moderation_needs_both_scopes() {
        let one = vec!["moderator:manage:chat_messages".to_string()];
        assert!(!can_moderate(&one));
        let both = vec![
            "user:bot".to_string(),
            "moderator:manage:banned_users".to_string(),
            "moderator:manage:chat_messages".to_string(),
        ];
        assert!(can_moderate(&both));
        assert!(!has_grant("loyalty", &both));
        assert!(has_grant(
            "loyalty",
            &["moderator:read:chatters".to_string()]
        ));
        assert!(!has_grant("unknown", &both));
        let l = twitch_authorize_url(
            "https://a",
            "abc",
            "https://x",
            "s",
            &["loyalty", "moderation"],
        );
        assert!(l.contains("channel%3Abot%20moderator%3Amanage%3Achat_messages%20moderator%3Amanage%3Abanned_users%20moderator%3Aread%3Achatters&"));
    }

    #[test]
    fn cookies_are_found_by_exact_name() {
        let h = "a=1; sylva_session_old=x; sylva_session=abc.def;b=2";
        assert_eq!(cookie(h, "sylva_session"), Some("abc.def"));
        assert_eq!(cookie(h, "b"), Some("2"));
        assert_eq!(cookie(h, "missing"), None);
        assert_eq!(cookie("sylva_session=", "sylva_session"), None);
    }

    #[test]
    fn set_cookie_flags() {
        assert_eq!(
            set_cookie("n", "v", "/", 60, true),
            "n=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure"
        );
        assert!(!set_cookie("n", "", "/", 0, false).contains("Secure"));
    }

    #[test]
    fn session_tokens_parse_strictly() {
        let t = SessionToken {
            account_id: "a".repeat(32),
            secret: "b".repeat(64),
        };
        assert_eq!(SessionToken::parse(&t.to_cookie_value()), Some(t));
        assert_eq!(SessionToken::parse("abc.def"), None);
        assert_eq!(
            SessionToken::parse(&format!("{}.{}", "A".repeat(32), "b".repeat(64))),
            None
        );
        assert_eq!(SessionToken::parse(&"a".repeat(97)), None);
    }

    #[test]
    fn hash_is_sha256_hex() {
        assert_eq!(
            hash_secret("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn seal_and_open_round_trip() {
        let key = parse_key(&"11".repeat(32)).unwrap();
        let sealed = seal(&key, [7; 12], "oauth-token");
        assert!(sealed.starts_with("v1.070707"));
        assert_eq!(open(&key, &sealed).as_deref(), Some("oauth-token"));

        let other = parse_key(&"22".repeat(32)).unwrap();
        assert_eq!(open(&other, &sealed), None);

        let mut tampered = sealed.clone();
        tampered.pop();
        tampered.push('0');
        if tampered != sealed {
            assert_eq!(open(&key, &tampered), None);
        }
        assert_eq!(open(&key, "v1.zz"), None);
        assert_eq!(parse_key("abcd"), None);
    }
}

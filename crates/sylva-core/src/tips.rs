//! Tips: viewers pay the streamer directly through the streamer's own Stripe
//! account (Stripe Connect, direct charges), so the money never passes
//! through Sylva. Sylva shows the tip page, checks each tip before it is
//! charged, and plays the alert once Stripe confirms the payment.
//!
//! This module is the part with no Cloudflare code: the streamer's tip
//! settings, currencies and rough conversion, the checks made before a
//! payment, the decision to hold a paid tip, Stripe webhook signatures and
//! form encoding for Stripe's API.
//!
//! Chargeback protection, in order of strength:
//! 1. Methods that cannot be charged back (bank redirects such as iDEAL,
//!    Bancontact, BLIK, EPS, Przelewy24, and Pix, vouchers) are offered
//!    first. Methods that can be reversed for weeks without a reason (bank
//!    debits), buy now pay later and PayPal are never offered
//!    ([`EXCLUDED_METHODS`]).
//! 2. Every card tip asks for 3D Secure, which moves fraud liability to the
//!    card's bank when the bank authenticates it.
//! 3. Checks before charging ([`precheck`]): Sylva-wide blocklist, attempts
//!    and declines per address, card country against the
//!    viewer's country.
//! 4. Holds after paying ([`hold_reason`]): big tips, first tips, card tips
//!    without 3D Secure and tips Stripe Radar finds risky wait for approval
//!    (or a delay) before the alert and text to speech.
//! 5. After the fact: an early fraud warning refunds the tip before it can
//!    become a dispute, and a dispute sends Stripe the evidence on its own.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::alerts::Invalid;

/// Payment methods Sylva never offers for tips.
/// * Bank debits (`sepa_debit`, `us_bank_account`, `bacs_debit`,
///   `au_becs_debit`, `acss_debit`): the payer can reverse them for weeks,
///   often with no reason needed, and they take days to confirm.
/// * Buy now pay later (`klarna`, `afterpay_clearpay`, `affirm`, `zip`):
///   makes no sense for a tip and brings disputes.
/// * `paypal`: PayPal's seller protection does not cover tips.
/// * `cashapp`, `amazon_pay`, `revolut_pay`: can be disputed and have no
///   3D Secure, so they give less control than a card.
pub const EXCLUDED_METHODS: &[&str] = &[
    "sepa_debit",
    "us_bank_account",
    "bacs_debit",
    "au_becs_debit",
    "acss_debit",
    "klarna",
    "afterpay_clearpay",
    "affirm",
    "zip",
    "paypal",
    "cashapp",
    "amazon_pay",
    "revolut_pay",
];

/// The order the tip page lists methods in, when Stripe offers them for the
/// viewer: methods that cannot be charged back first, then wallets and cards.
pub const METHOD_ORDER: &[&str] = &[
    "ideal",
    "bancontact",
    "blik",
    "eps",
    "p24",
    "twint",
    "swish",
    "pix",
    "promptpay",
    "paynow",
    "grabpay",
    "fpx",
    "oxxo",
    "boleto",
    "konbini",
    "apple_pay",
    "google_pay",
    "card",
    "link",
];

/// Methods Sylva means to offer. Not sent to Stripe: Elements with
/// `allowedPaymentMethodTypes` cannot be confirmed against a PaymentIntent
/// with automatic payment methods, so the form and the charge both use
/// EXCLUDED_METHODS instead. Kept to test that the two lists never overlap.
pub const ALLOWED_METHODS: &[&str] = &[
    "card",
    "link",
    "ideal",
    "bancontact",
    "blik",
    "eps",
    "p24",
    "twint",
    "swish",
    "pix",
    "promptpay",
    "paynow",
    "grabpay",
    "fpx",
    "oxxo",
    "boleto",
    "konbini",
];

/// The Stripe API version Sylva is written against.
pub const STRIPE_VERSION: &str = "2025-03-31.basil";

/// The version sent with Stripe's v2 API (Accounts v2 for streamers' accounts).
pub const STRIPE_V2_VERSION: &str = "2026-11-18.endive";

/// Longest tip message, in characters.
pub const MESSAGE_MAX: usize = 255;
/// Longest tipper name, in characters.
pub const NAME_MAX: usize = 25;

/// One currency tips can be paid in.
pub struct Currency {
    pub code: &'static str,
    /// Digits after the decimal point in Stripe's amounts (0 for JPY).
    pub decimals: u32,
    /// Roughly how many US dollars one unit is worth. Only used for limits,
    /// holds and totals in the streamer's own currency, never to charge.
    pub usd: f64,
}

/// Currencies the tip page offers. Every one is a Stripe presentment
/// currency; the zero-decimal ones (JPY, KRW, VND, CLP) match Stripe's list.
/// The rates are approximate (late 2025)
/// and only move limits and totals, so they do not need to be exact.
pub const CURRENCIES: &[Currency] = &[
    Currency {
        code: "USD",
        decimals: 2,
        usd: 1.0,
    },
    Currency {
        code: "EUR",
        decimals: 2,
        usd: 1.16,
    },
    Currency {
        code: "GBP",
        decimals: 2,
        usd: 1.33,
    },
    Currency {
        code: "CAD",
        decimals: 2,
        usd: 0.72,
    },
    Currency {
        code: "AUD",
        decimals: 2,
        usd: 0.65,
    },
    Currency {
        code: "NZD",
        decimals: 2,
        usd: 0.57,
    },
    Currency {
        code: "CHF",
        decimals: 2,
        usd: 1.24,
    },
    Currency {
        code: "SEK",
        decimals: 2,
        usd: 0.105,
    },
    Currency {
        code: "NOK",
        decimals: 2,
        usd: 0.099,
    },
    Currency {
        code: "DKK",
        decimals: 2,
        usd: 0.155,
    },
    Currency {
        code: "PLN",
        decimals: 2,
        usd: 0.27,
    },
    Currency {
        code: "CZK",
        decimals: 2,
        usd: 0.047,
    },
    Currency {
        code: "JPY",
        decimals: 0,
        usd: 0.0066,
    },
    Currency {
        code: "SGD",
        decimals: 2,
        usd: 0.77,
    },
    Currency {
        code: "HKD",
        decimals: 2,
        usd: 0.128,
    },
    Currency {
        code: "MYR",
        decimals: 2,
        usd: 0.24,
    },
    Currency {
        code: "THB",
        decimals: 2,
        usd: 0.031,
    },
    Currency {
        code: "PHP",
        decimals: 2,
        usd: 0.017,
    },
    Currency {
        code: "INR",
        decimals: 2,
        usd: 0.0113,
    },
    Currency {
        code: "BRL",
        decimals: 2,
        usd: 0.19,
    },
    Currency {
        code: "MXN",
        decimals: 2,
        usd: 0.054,
    },
    Currency {
        code: "ZAR",
        decimals: 2,
        usd: 0.057,
    },
    Currency {
        code: "IDR",
        decimals: 2,
        usd: 6e-05,
    },
    Currency {
        code: "KRW",
        decimals: 0,
        usd: 0.00069,
    },
    Currency {
        code: "TWD",
        decimals: 2,
        usd: 0.032,
    },
    Currency {
        code: "CNY",
        decimals: 2,
        usd: 0.14,
    },
    Currency {
        code: "VND",
        decimals: 0,
        usd: 3.8e-05,
    },
    Currency {
        code: "AED",
        decimals: 2,
        usd: 0.272,
    },
    Currency {
        code: "SAR",
        decimals: 2,
        usd: 0.266,
    },
    Currency {
        code: "QAR",
        decimals: 2,
        usd: 0.274,
    },
    Currency {
        code: "ILS",
        decimals: 2,
        usd: 0.3,
    },
    Currency {
        code: "TRY",
        decimals: 2,
        usd: 0.024,
    },
    Currency {
        code: "HUF",
        decimals: 2,
        usd: 0.003,
    },
    Currency {
        code: "RON",
        decimals: 2,
        usd: 0.227,
    },
    Currency {
        code: "COP",
        decimals: 2,
        usd: 0.00026,
    },
    Currency {
        code: "CLP",
        decimals: 0,
        usd: 0.00106,
    },
    Currency {
        code: "PEN",
        decimals: 2,
        usd: 0.296,
    },
    Currency {
        code: "NGN",
        decimals: 2,
        usd: 0.00069,
    },
    Currency {
        code: "KES",
        decimals: 2,
        usd: 0.0077,
    },
    Currency {
        code: "EGP",
        decimals: 2,
        usd: 0.021,
    },
    Currency {
        code: "PKR",
        decimals: 2,
        usd: 0.0036,
    },
    Currency {
        code: "BDT",
        decimals: 2,
        usd: 0.0082,
    },
    Currency {
        code: "UAH",
        decimals: 2,
        usd: 0.024,
    },
    Currency {
        code: "KZT",
        decimals: 2,
        usd: 0.0019,
    },
    Currency {
        code: "MAD",
        decimals: 2,
        usd: 0.108,
    },
];

pub fn currency(code: &str) -> Option<&'static Currency> {
    CURRENCIES
        .iter()
        .find(|c| c.code.eq_ignore_ascii_case(code))
}

/// The currency a viewer in this country most likely pays in, if offered.
/// The largest amount Stripe takes in one payment: eight digits in the
/// smallest unit, twelve for IDR.
pub fn stripe_max(c: &Currency) -> f64 {
    let digits = if c.code == "IDR" { 12 } else { 8 };
    (10f64.powi(digits) - 1.0) / 10f64.powi(c.decimals as i32)
}

pub fn currency_for_country(country: &str) -> Option<&'static str> {
    let c = country.to_ascii_uppercase();
    Some(match c.as_str() {
        "US" | "PR" | "EC" | "SV" | "PA" => "USD",
        "AT" | "BE" | "CY" | "DE" | "EE" | "ES" | "FI" | "FR" | "GR" | "HR" | "IE" | "IT"
        | "LT" | "LU" | "LV" | "MT" | "NL" | "PT" | "SI" | "SK" | "MC" | "SM" | "VA" | "AD"
        | "ME" | "XK" | "BG" => "EUR",
        "GB" | "IM" | "JE" | "GG" => "GBP",
        "CA" => "CAD",
        "AU" => "AUD",
        "NZ" => "NZD",
        "CH" | "LI" => "CHF",
        "SE" => "SEK",
        "NO" => "NOK",
        "DK" | "GL" | "FO" => "DKK",
        "PL" => "PLN",
        "CZ" => "CZK",
        "JP" => "JPY",
        "SG" => "SGD",
        "HK" => "HKD",
        "MY" => "MYR",
        "TH" => "THB",
        "PH" => "PHP",
        "IN" => "INR",
        "BR" => "BRL",
        "MX" => "MXN",
        "ZA" => "ZAR",
        "ID" => "IDR",
        "KR" => "KRW",
        "TW" => "TWD",
        "CN" => "CNY",
        "VN" => "VND",
        "AE" => "AED",
        "SA" => "SAR",
        "QA" => "QAR",
        "IL" => "ILS",
        "TR" => "TRY",
        "HU" => "HUF",
        "RO" => "RON",
        "CO" => "COP",
        "CL" => "CLP",
        "PE" => "PEN",
        "NG" => "NGN",
        "KE" => "KES",
        "EG" => "EGP",
        "PK" => "PKR",
        "BD" => "BDT",
        "UA" => "UAH",
        "KZ" => "KZT",
        "MA" => "MAD",
        _ => return None,
    })
}

/// Countries a streamer's Stripe account can be in (Stripe's supported
/// countries for accounts with their own Stripe Dashboard).
pub const STRIPE_COUNTRIES: &[&str] = &[
    "AE", "AT", "AU", "BE", "BG", "BR", "CA", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR",
    "GB", "GI", "GR", "HK", "HR", "HU", "IE", "IT", "JP", "LI", "LT", "LU", "LV", "MT", "MX", "MY",
    "NL", "NO", "NZ", "PL", "PT", "RO", "SE", "SG", "SI", "SK", "TH", "US",
];

/// Convert between currencies with the rough rates above.
pub fn convert(amount: f64, from: &str, to: &str) -> f64 {
    if from.eq_ignore_ascii_case(to) {
        return amount;
    }
    match (currency(from), currency(to)) {
        (Some(f), Some(t)) => amount * f.usd / t.usd,
        _ => amount,
    }
}

/// An amount in Stripe's smallest unit (cents), or `None` when it has more
/// decimals than the currency allows or is not a positive number.
pub fn to_minor(amount: f64, cur: &Currency) -> Option<i64> {
    if !amount.is_finite() || amount <= 0.0 {
        return None;
    }
    let scale = 10f64.powi(cur.decimals as i32);
    let minor = (amount * scale).round();
    if (minor - amount * scale).abs() > 1e-6 * scale.max(1.0) || minor > 1e12 {
        return None;
    }
    Some(minor as i64)
}

pub fn from_minor(minor: i64, cur: &Currency) -> f64 {
    minor as f64 / 10f64.powi(cur.decimals as i32)
}

/// A friendly round number near `amount`, for suggested amounts and limits
/// shown in another currency. `up` rounds up (for minimums).
pub fn nice(amount: f64, cur: &Currency, up: bool) -> f64 {
    if amount <= 0.0 {
        return 0.0;
    }
    let step = if amount < 10.0 {
        if cur.decimals == 0 {
            1.0
        } else {
            0.5
        }
    } else {
        let mag = 10f64.powi(amount.log10().floor() as i32);
        let s = mag / 2.0;
        if cur.decimals == 0 {
            s.max(1.0)
        } else {
            s
        }
    };
    let n = if up {
        (amount / step - 1e-9).ceil()
    } else {
        (amount / step + 1e-9).floor().max(1.0)
    };
    n * step
}

/// What happens to a card tip from a country other than the viewer's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Mismatch {
    Allow,
    Hold,
    #[default]
    Block,
}

/// What a held tip waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum HoldMode {
    /// Nothing is held: every paid tip alerts at once (risky tips still wait).
    Off,
    /// Held tips alert on their own after `delay_seconds`.
    Delay,
    /// Held tips wait until someone approves them in Sylva or Sylva Control.
    #[default]
    Approve,
}

/// The streamer's tip settings. Amounts are in `currency`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TipSettings {
    /// Whether the tip page takes tips.
    pub enabled: bool,
    /// The streamer's currency: limits are set in it and Stats count in it.
    pub currency: String,
    pub min: f64,
    pub max: f64,
    /// The buttons the tip page shows.
    pub suggested: Vec<f64>,
    pub hold: HoldMode,
    /// Tips at or above this wait (0 means no amount holds).
    pub hold_over: f64,
    /// First tips from someone wait.
    pub hold_first: bool,
    /// Card tips the card's bank did not authenticate with 3D Secure wait.
    pub hold_unverified: bool,
    pub delay_seconds: u32,
    pub mismatch: Mismatch,
    /// Refund a tip as soon as Stripe gets an early fraud warning for it.
    pub refund_on_warning: bool,
    /// Send Stripe the tip's evidence as soon as a dispute opens.
    pub auto_evidence: bool,
    /// Read tip messages aloud on the overlay.
    pub tts: bool,
    /// Tips below this are not read aloud.
    pub tts_min: f64,
    /// What is read: `{name}`, `{amount}` and `{message}` are filled in.
    pub tts_template: String,
    /// The wait after the alert sound before the message is read.
    pub tts_delay_ms: u32,
    /// How loud the message is read, 0 to 100.
    pub tts_volume: u8,
    /// Messages are cut to this many characters.
    pub tts_max_chars: u32,
    /// Words never read aloud.
    pub tts_words: Vec<String>,
    /// What happens to a message with one of `tts_words`.
    pub tts_word_mode: WordMode,
    /// Shown on the tip page above the form.
    pub note: String,
    /// The tip page's picture: an uploaded image id, or empty for the
    /// Twitch profile picture.
    pub avatar: String,
    /// The tip page's banner: an uploaded image id, empty for the Twitch
    /// offline image, or `none`.
    pub banner: String,
    /// The page background image (an uploaded image id), or empty.
    pub background: String,
    /// The page background colour as `#rrggbb`, or empty for the default.
    pub bg_color: String,
    /// Repeat the background image as tiles instead of filling the page.
    pub bg_tile: bool,
    /// The width and height of one tile, in pixels.
    pub tile_size: u32,
}

pub const TTS_TEMPLATE: &str = "{name} tipped {amount}. {message}";
pub const TTS_DELAY_MAX: u32 = 10_000;
pub const TTS_CHARS_MIN: u32 = 20;
pub const TTS_CHARS_MAX: u32 = 500;

/// What happens to a tip message with a filtered word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WordMode {
    /// Read the message without the word.
    #[default]
    Remove,
    /// Do not read the message at all.
    Skip,
}

pub const TILE_MIN: u32 = 16;
pub const TILE_MAX: u32 = 1024;

fn image_id(id: &str) -> bool {
    crate::media::valid_id(id)
        && !id.ends_with(".mp3")
        && !id.ends_with(".ogg")
        && !id.ends_with(".wav")
}

impl TipSettings {
    /// The uploaded images the page uses.
    pub fn images(&self) -> Vec<&str> {
        [&self.avatar, &self.banner, &self.background]
            .into_iter()
            .map(String::as_str)
            .filter(|x| image_id(x))
            .collect()
    }
}

impl Default for TipSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            currency: "USD".into(),
            min: 1.0,
            max: 500.0,
            suggested: vec![3.0, 5.0, 10.0, 25.0],
            hold: HoldMode::Approve,
            hold_over: 50.0,
            hold_first: true,
            hold_unverified: true,
            delay_seconds: 60,
            mismatch: Mismatch::Block,
            refund_on_warning: true,
            auto_evidence: true,
            tts: true,
            tts_min: 3.0,
            tts_template: TTS_TEMPLATE.into(),
            tts_delay_ms: 0,
            tts_volume: 80,
            tts_max_chars: 200,
            tts_words: Vec::new(),
            tts_word_mode: WordMode::Remove,
            note: String::new(),
            avatar: String::new(),
            banner: String::new(),
            background: String::new(),
            bg_color: String::new(),
            bg_tile: true,
            tile_size: 160,
        }
    }
}

impl TipSettings {
    /// What is read aloud for a tip, or None when there is nothing to read.
    pub fn speech(&self, name: &str, amount: &str, message: &str) -> Option<String> {
        let blocked = |w: &str| {
            let f = fold(w);
            !f.is_empty() && self.tts_words.iter().any(|b| f.contains(b.as_str()))
        };
        let name = if name.split_whitespace().any(blocked) {
            "Someone"
        } else {
            name
        };
        let mut words: Vec<&str> = message
            .split_whitespace()
            .filter(|w| {
                let l = w.to_ascii_lowercase();
                !(l.starts_with("http://") || l.starts_with("https://") || l.starts_with("www."))
            })
            .collect();
        if words.iter().any(|w| blocked(w)) {
            match self.tts_word_mode {
                WordMode::Remove => words.retain(|w| !blocked(w)),
                WordMode::Skip => words.clear(),
            }
        }
        let max = self.tts_max_chars.clamp(TTS_CHARS_MIN, TTS_CHARS_MAX) as usize;
        let mut msg = String::new();
        for w in words {
            let len = msg.chars().count() + usize::from(!msg.is_empty()) + w.chars().count();
            if len > max {
                if msg.is_empty() {
                    msg = w.chars().take(max).collect();
                }
                break;
            }
            if !msg.is_empty() {
                msg.push(' ');
            }
            msg.push_str(w);
        }
        let template = if self.tts_template.trim().is_empty() {
            TTS_TEMPLATE
        } else {
            &self.tts_template
        };
        let out = template
            .replace("{name}", name)
            .replace("{amount}", amount)
            .replace("{message}", &msg);
        let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
        out.chars().any(char::is_alphanumeric).then_some(out)
    }

}

impl TipSettings {
    /// Check settings from the dashboard, tidying what can be tidied.
    pub fn validate(mut self) -> Result<Self, Invalid> {
        let bad = |m: &str| Err(Invalid(m.into()));
        let Some(cur) = currency(&self.currency) else {
            return bad("Pick one of the listed currencies.");
        };
        self.currency = cur.code.into();
        // The smallest tip must be worth about a dollar, above Stripe's own minimums.
        let floor = nice(convert(1.0, "USD", cur.code), cur, true);
        let top = convert(10_000.0, "USD", cur.code);
        let finite = [self.min, self.max, self.hold_over, self.tts_min];
        if finite.iter().any(|x| !x.is_finite() || *x < 0.0) {
            return bad("Amounts must be numbers of 0 or more.");
        }
        if self.min < floor {
            return Err(Invalid(format!(
                "The smallest tip must be at least {floor} {}.",
                cur.code
            )));
        }
        if self.max < self.min {
            return bad("The largest tip must be at least the smallest.");
        }
        if self.max > top {
            return Err(Invalid(format!(
                "The largest tip can be up to {} {}.",
                top.floor(),
                cur.code
            )));
        }
        self.suggested.retain(|x| x.is_finite() && *x > 0.0);
        self.suggested.truncate(6);
        if self
            .suggested
            .iter()
            .any(|x| *x < self.min || *x > self.max)
        {
            return bad("Suggested amounts must be between the smallest and largest tip.");
        }
        if self.delay_seconds > 3600 {
            return bad("The delay can be up to an hour.");
        }
        self.tts_template = self
            .tts_template
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if self.tts_template.is_empty() {
            self.tts_template = TTS_TEMPLATE.into();
        }
        if self.tts_template.chars().count() > 200 {
            return bad("What's read can be up to 200 characters.");
        }
        if self.tts_delay_ms > TTS_DELAY_MAX {
            return bad("The wait before reading can be up to 10 seconds.");
        }
        self.tts_volume = self.tts_volume.min(100);
        self.tts_max_chars = self.tts_max_chars.clamp(TTS_CHARS_MIN, TTS_CHARS_MAX);
        let mut words: Vec<String> = self
            .tts_words
            .iter()
            .map(|w| fold(w))
            .filter(|w| !w.is_empty())
            .collect();
        words.sort();
        words.dedup();
        if words.len() > 200 || words.iter().any(|w| w.chars().count() > 40) {
            return bad("Filter up to 200 words of up to 40 letters each.");
        }
        self.tts_words = words;
        self.note = self.note.trim().chars().take(300).collect();
        if !(self.avatar.is_empty() || image_id(&self.avatar))
            || !(self.banner.is_empty() || self.banner == "none" || image_id(&self.banner))
            || !(self.background.is_empty() || image_id(&self.background))
        {
            return bad("Pick an image from your files.");
        }
        self.bg_color = self.bg_color.trim().to_ascii_lowercase();
        if !self.bg_color.is_empty()
            && !(self.bg_color.len() == 7
                && self.bg_color.starts_with('#')
                && self.bg_color[1..].bytes().all(|c| c.is_ascii_hexdigit()))
        {
            return bad("The background colour must look like #1a1a1a.");
        }
        self.tile_size = self.tile_size.clamp(TILE_MIN, TILE_MAX);
        Ok(self)
    }
}

/// Everything known about a tip before it is charged.
#[derive(Debug, Clone, Default)]
pub struct Attempt {
    /// In the streamer's currency.
    pub base: f64,
    /// The viewer's country from their IP address.
    pub ip_country: Option<String>,
    /// The card's country, for card and wallet payments.
    pub card_country: Option<String>,
    /// Whether this is a card (or a wallet that pays with a card).
    pub card: bool,
    /// On the Sylva-wide or the channel's own blocklist.
    pub blocked: bool,
    /// Tip attempts from this address or email in the last 10 minutes.
    pub recent_attempts: u32,
    /// Declined or failed payments from this address or email in the last hour.
    pub recent_failures: u32,
    /// Whether this person has a tip here that went through and was not
    /// refunded or disputed.
    pub known: bool,
}

/// Why a tip is refused before it is charged, in words for the viewer.
pub fn precheck(s: &TipSettings, a: &Attempt) -> Result<(), String> {
    if a.blocked {
        return Err("Tips from you can't be accepted here.".into());
    }
    if a.recent_failures >= 3 {
        return Err("Too many payments were declined. Try again in an hour.".into());
    }
    if a.recent_attempts >= 6 {
        return Err("Too many tips at once. Try again in a few minutes.".into());
    }
    let eps = 0.005;
    if a.base + eps < s.min * 0.999 {
        return Err(format!("The smallest tip is {} {}.", s.min, s.currency));
    }
    if a.base > s.max * 1.001 + eps {
        return Err(format!("The largest tip is {} {}.", s.max, s.currency));
    }
    if a.card && s.mismatch == Mismatch::Block && mismatched(a) {
        return Err(
            "This card is from another country than where you are. Use a card from your country or another payment method."
                .into(),
        );
    }
    Ok(())
}

fn mismatched(a: &Attempt) -> bool {
    match (&a.ip_country, &a.card_country) {
        (Some(ip), Some(card)) => {
            !ip.is_empty() && !card.is_empty() && !ip.eq_ignore_ascii_case(card)
        }
        _ => false,
    }
}

/// Everything known about a tip once Stripe says it is paid.
#[derive(Debug, Clone, Default)]
pub struct Paid {
    pub base: f64,
    pub card: bool,
    /// The card's bank authenticated it (3D Secure), or a wallet with its
    /// own authentication paid it.
    pub verified: bool,
    /// Stripe Radar's risk level: normal, elevated or highest.
    pub risk: String,
    pub known: bool,
    pub ip_country: Option<String>,
    pub card_country: Option<String>,
}

/// Why a paid tip waits before its alert, or `None` to show it now.
/// Risky tips always wait for approval, whatever the hold setting.
pub fn hold_reason(s: &TipSettings, p: &Paid) -> Option<(&'static str, bool)> {
    // (reason, needs approval even in delay mode)
    if p.risk == "elevated" || p.risk == "highest" {
        return Some(("Stripe Radar marked it risky", true));
    }
    if s.hold == HoldMode::Off {
        return None;
    }
    if p.card && s.mismatch == Mismatch::Hold {
        let a = Attempt {
            ip_country: p.ip_country.clone(),
            card_country: p.card_country.clone(),
            ..Attempt::default()
        };
        if mismatched(&a) {
            return Some(("The card is from another country", false));
        }
    }
    if p.card && !p.verified && s.hold_unverified {
        return Some(("The card's bank did not verify it", false));
    }
    if s.hold_over > 0.0 && p.base + 0.005 >= s.hold_over * 0.999 {
        return Some(("Big tip", false));
    }
    if !p.known && s.hold_first {
        return Some(("First tip from this person", false));
    }
    None
}

/// Check a tipper's name: trimmed, no control characters.
pub fn clean_name(name: &str) -> Result<String, String> {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    let n = n.trim().to_string();
    if n.is_empty() {
        return Err("Add a name to show with your tip.".into());
    }
    if n.chars().count() > NAME_MAX {
        return Err(format!("Names can be up to {NAME_MAX} characters."));
    }
    Ok(n)
}

pub fn clean_message(message: &str) -> Result<String, String> {
    let m: String = message
        .chars()
        .map(|c| {
            if c == '\n' || c == '\r' || c == '\t' {
                ' '
            } else {
                c
            }
        })
        .filter(|c| !c.is_control())
        .collect();
    let m = m.trim().to_string();
    if m.chars().count() > MESSAGE_MAX {
        return Err(format!("Messages can be up to {MESSAGE_MAX} characters."));
    }
    Ok(m)
}

/// A lowercased email with `+tags` dropped (and dots for Gmail), so the
/// same inbox always gives the same blocklist entry.
pub fn normalize_email(email: &str) -> Option<String> {
    let e = email.trim().to_ascii_lowercase();
    if e.len() > 254 || e.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (user, domain) = e.split_once('@')?;
    if user.is_empty()
        || domain.contains('@')
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
    {
        return None;
    }
    let user = user.split('+').next().unwrap_or(user);
    let user = if domain == "gmail.com" || domain == "googlemail.com" {
        user.replace('.', "")
    } else {
        user.to_string()
    };
    if user.is_empty() {
        return None;
    }
    let domain = if domain == "googlemail.com" {
        "gmail.com"
    } else {
        domain
    };
    Some(format!("{user}@{domain}"))
}

/// `j***@gmail.com`: enough for the streamer to tell tippers apart.
pub fn email_hint(email: &str) -> String {
    match email.split_once('@') {
        Some((u, d)) => format!("{}***@{d}", u.chars().next().unwrap_or('*')),
        None => "***".into(),
    }
}

/// A keyed hash of a tipper's email, card or address, so blocklists and
/// limits work without keeping the value itself.
pub fn ident_hash(pepper: &[u8], kind: &str, value: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(pepper).expect("HMAC takes any key length");
    mac.update(kind.as_bytes());
    mac.update(b":");
    mac.update(value.as_bytes());
    hex::encode(&mac.finalize().into_bytes()[..16])
}

/// Check a Stripe webhook's `Stripe-Signature` header. `now` and the
/// tolerance are in seconds.
pub fn verify_stripe(
    secret: &str,
    header: &str,
    body: &[u8],
    now: i64,
) -> Result<(), &'static str> {
    let mut t: Option<i64> = None;
    let mut sigs = Vec::new();
    for part in header.split(',') {
        match part.trim().split_once('=') {
            Some(("t", v)) => t = v.parse().ok(),
            Some(("v1", v)) => sigs.push(v),
            _ => {}
        }
    }
    let t = t.ok_or("no timestamp")?;
    if sigs.is_empty() {
        return Err("no signature");
    }
    if (now - t).abs() > 300 {
        return Err("too old");
    }
    for sig in sigs {
        let Ok(raw) = hex::decode(sig) else { continue };
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
        mac.update(t.to_string().as_bytes());
        mac.update(b".");
        mac.update(body);
        if mac.verify_slice(&raw).is_ok() {
            return Ok(());
        }
    }
    Err("signature does not match")
}

/// Stripe's API takes form bodies: `a[b][]=c&d=e`.
#[derive(Default)]
pub struct Form(Vec<(String, String)>);

impl Form {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn add(mut self, key: &str, value: impl ToString) -> Self {
        self.0.push((key.into(), value.to_string()));
        self
    }
    pub fn push(&mut self, key: &str, value: impl ToString) {
        self.0.push((key.into(), value.to_string()));
    }
    pub fn encode(&self) -> String {
        self.0
            .iter()
            .map(|(k, v)| format!("{}={}", crate::auth::encode(k), crate::auth::encode(v)))
            .collect::<Vec<_>>()
            .join("&")
    }
}

/// An amount as it is read aloud: "5 dollars", "12.50 euros".
pub fn spoken_amount(amount: f64, code: &str) -> String {
    let n = if amount.fract().abs() < 1e-9 {
        format!("{}", amount as i64)
    } else {
        format!("{amount:.2}")
    };
    let one = (amount - 1.0).abs() < 1e-9;
    let word = match code.to_ascii_uppercase().as_str() {
        "USD" => {
            if one {
                "dollar"
            } else {
                "dollars"
            }
        }
        "CAD" => {
            if one {
                "Canadian dollar"
            } else {
                "Canadian dollars"
            }
        }
        "AUD" => {
            if one {
                "Australian dollar"
            } else {
                "Australian dollars"
            }
        }
        "NZD" => {
            if one {
                "New Zealand dollar"
            } else {
                "New Zealand dollars"
            }
        }
        "SGD" => {
            if one {
                "Singapore dollar"
            } else {
                "Singapore dollars"
            }
        }
        "HKD" => {
            if one {
                "Hong Kong dollar"
            } else {
                "Hong Kong dollars"
            }
        }
        "EUR" => {
            if one {
                "euro"
            } else {
                "euros"
            }
        }
        "GBP" => {
            if one {
                "pound"
            } else {
                "pounds"
            }
        }
        "JPY" => "yen",
        "CHF" => "Swiss francs",
        "SEK" => "Swedish kronor",
        "NOK" => "Norwegian kroner",
        "DKK" => "Danish kroner",
        "PLN" => "zloty",
        "CZK" => "Czech koruna",
        "BRL" => "reais",
        "MXN" => "Mexican pesos",
        "PHP" => "Philippine pesos",
        "INR" => "rupees",
        "ZAR" => "rand",
        "MYR" => "ringgit",
        "THB" => "baht",
        "IDR" => "rupiah",
        "KRW" => "won",
        "TWD" => "New Taiwan dollars",
        "CNY" => "yuan",
        "VND" => "dong",
        "AED" => "dirhams",
        "SAR" => "riyals",
        "QAR" => "Qatari riyals",
        "ILS" => "shekels",
        "TRY" => "Turkish lira",
        "HUF" => "forint",
        "RON" => "lei",
        "COP" => "Colombian pesos",
        "CLP" => "Chilean pesos",
        "PEN" => "soles",
        "NGN" => "naira",
        "KES" => "Kenyan shillings",
        "EGP" => "Egyptian pounds",
        "PKR" => "Pakistani rupees",
        "BDT" => "taka",
        "UAH" => "hryvnias",
        "KZT" => "tenge",
        "MAD" => "Moroccan dirhams",
        _ => return format!("{n} {code}"),
    };
    format!("{n} {word}")
}

/// The text read aloud for a tip: no links, at most 200 characters.
/// A word as compared with the filter: lower case letters and digits only.
fn fold(w: &str) -> String {
    w.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usd() -> &'static Currency {
        currency("usd").unwrap()
    }

    #[test]
    fn minor_units() {
        assert_eq!(to_minor(5.0, usd()), Some(500));
        assert_eq!(to_minor(5.25, usd()), Some(525));
        assert_eq!(to_minor(0.1 + 0.2, usd()), Some(30));
        assert_eq!(to_minor(5.255, usd()), None);
        assert_eq!(to_minor(-1.0, usd()), None);
        let jpy = currency("JPY").unwrap();
        assert_eq!(to_minor(500.0, jpy), Some(500));
        assert_eq!(to_minor(500.5, jpy), None);
        assert_eq!(from_minor(525, usd()), 5.25);
    }

    #[test]
    fn allowed_never_excluded() {
        for m in ALLOWED_METHODS {
            assert!(
                !EXCLUDED_METHODS.contains(m),
                "{m} is both allowed and excluded"
            );
        }
        assert!(EXCLUDED_METHODS.contains(&"klarna"));
    }

    #[test]
    fn nice_numbers() {
        let eur = currency("EUR").unwrap();
        assert_eq!(nice(4.31, eur, false), 4.0);
        assert_eq!(nice(4.31, eur, true), 4.5);
        assert_eq!(nice(43.1, eur, false), 40.0);
        assert_eq!(nice(431.0, eur, true), 450.0);
        let jpy = currency("JPY").unwrap();
        assert_eq!(nice(757.0, jpy, false), 750.0);
        assert_eq!(nice(0.86, eur, true), 1.0);
    }

    #[test]
    fn settings_validate() {
        assert!(TipSettings::default().validate().is_ok());
        let s = TipSettings {
            min: 0.2,
            ..TipSettings::default()
        };
        assert!(s.validate().is_err());
        let s = TipSettings {
            currency: "XYZ".into(),
            ..TipSettings::default()
        };
        assert!(s.validate().is_err());
        let s = TipSettings {
            suggested: vec![1000.0],
            ..TipSettings::default()
        };
        assert!(s.validate().is_err());
        let s = TipSettings {
            currency: "jpy".into(),
            min: 200.0,
            max: 50_000.0,
            hold_over: 5000.0,
            suggested: vec![500.0],
            ..TipSettings::default()
        };
        assert_eq!(s.validate().unwrap().currency, "JPY");
    }

    #[test]
    fn prechecks() {
        let s = TipSettings::default();
        let ok = Attempt {
            base: 5.0,
            known: false,
            ..Attempt::default()
        };
        assert!(precheck(&s, &ok).is_ok());
        assert!(precheck(
            &s,
            &Attempt {
                base: 0.5,
                ..ok.clone()
            }
        )
        .is_err());
        assert!(precheck(
            &s,
            &Attempt {
                base: 80.0,
                ..ok.clone()
            }
        )
        .is_ok());
        assert!(precheck(
            &s,
            &Attempt {
                base: 501.0,
                known: true,
                ..ok.clone()
            }
        )
        .is_err());
        assert!(precheck(
            &s,
            &Attempt {
                blocked: true,
                ..ok.clone()
            }
        )
        .is_err());
        assert!(precheck(
            &s,
            &Attempt {
                recent_failures: 3,
                ..ok.clone()
            }
        )
        .is_err());
        let abroad = Attempt {
            card: true,
            ip_country: Some("DE".into()),
            card_country: Some("US".into()),
            ..ok.clone()
        };
        assert!(precheck(&s, &abroad).is_err());
        assert!(precheck(
            &s,
            &Attempt {
                card: false,
                ..abroad.clone()
            }
        )
        .is_ok());
        let allow = TipSettings {
            mismatch: Mismatch::Allow,
            ..TipSettings::default()
        };
        assert!(precheck(&allow, &abroad).is_ok());
    }

    #[test]
    fn holds() {
        let s = TipSettings::default();
        let p = Paid {
            base: 5.0,
            card: true,
            verified: true,
            risk: "normal".into(),
            known: true,
            ..Paid::default()
        };
        assert_eq!(hold_reason(&s, &p), None);
        assert!(hold_reason(
            &s,
            &Paid {
                known: false,
                ..p.clone()
            }
        )
        .is_some());
        assert!(hold_reason(
            &s,
            &Paid {
                base: 50.0,
                ..p.clone()
            }
        )
        .is_some());
        assert!(hold_reason(
            &s,
            &Paid {
                verified: false,
                ..p.clone()
            }
        )
        .is_some());
        assert!(hold_reason(
            &s,
            &Paid {
                verified: false,
                card: false,
                ..p.clone()
            }
        )
        .is_none());
        let off = TipSettings {
            hold: HoldMode::Off,
            ..TipSettings::default()
        };
        assert_eq!(
            hold_reason(
                &off,
                &Paid {
                    known: false,
                    ..p.clone()
                }
            ),
            None
        );
        assert_eq!(
            hold_reason(
                &off,
                &Paid {
                    risk: "elevated".into(),
                    ..p.clone()
                }
            )
            .map(|r| r.1),
            Some(true)
        );
    }

    #[test]
    fn emails() {
        assert_eq!(
            normalize_email(" A.B+x@GMail.com ").as_deref(),
            Some("ab@gmail.com")
        );
        assert_eq!(
            normalize_email("a.b+x@proton.me").as_deref(),
            Some("a.b@proton.me")
        );
        assert_eq!(normalize_email("nope"), None);
        assert_eq!(normalize_email("a@b"), None);
        assert_eq!(normalize_email("+x@b.com"), None);
        assert_eq!(email_hint("josh@x.com"), "j***@x.com");
    }

    #[test]
    fn stripe_signature() {
        let secret = "whsec_test";
        let body = br#"{"id":"evt_1"}"#;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(b"1700000000.");
        mac.update(body);
        let sig = hex::encode(mac.finalize().into_bytes());
        let header = format!("t=1700000000,v1=deadbeef,v1={sig}");
        assert_eq!(verify_stripe(secret, &header, body, 1_700_000_100), Ok(()));
        assert!(verify_stripe(secret, &header, body, 1_700_001_000).is_err());
        assert!(verify_stripe("whsec_other", &header, body, 1_700_000_100).is_err());
        assert!(verify_stripe(secret, &header, b"{}", 1_700_000_100).is_err());
    }

    #[test]
    fn form_and_speech() {
        let f = Form::new().add("a[b][]", "x y").add("n", 5);
        assert_eq!(f.encode(), "a%5Bb%5D%5B%5D=x%20y&n=5");
        let mut s = TipSettings::default();
        let say = |s: &TipSettings, m: &str| s.speech("Ann", "5 dollars", m);
        assert_eq!(
            say(&s, "hi https://x.y there").as_deref(),
            Some("Ann tipped 5 dollars. hi there")
        );
        assert_eq!(say(&s, " ").as_deref(), Some("Ann tipped 5 dollars."));
        s.tts_template = "{message}".into();
        assert_eq!(say(&s, "hello"), Some("hello".into()));
        assert_eq!(say(&s, " "), None);
        s.tts_words = vec!["darn".into()];
        assert_eq!(say(&s, "oh DARNIT ok"), Some("oh ok".into()));
        s.tts_word_mode = WordMode::Skip;
        assert_eq!(say(&s, "oh darn ok"), None);
        s.tts_template = TTS_TEMPLATE.into();
        assert_eq!(
            s.speech("darn_it", "5 dollars", "hi").as_deref(),
            Some("Someone tipped 5 dollars. hi")
        );
        s.tts_max_chars = 20;
        assert_eq!(
            say(&s, "aaaa bbbb cccc dddd eeee").as_deref(),
            Some("Ann tipped 5 dollars. aaaa bbbb cccc dddd")
        );
        let v = TipSettings {
            tts_words: vec![" Foo! ".into(), "foo".into(), "".into()],
            tts_template: "  ".into(),
            ..TipSettings::default()
        }
        .validate()
        .unwrap();
        assert_eq!(v.tts_words, ["foo"]);
        assert_eq!(v.tts_template, TTS_TEMPLATE);
        assert_eq!(spoken_amount(5.0, "USD"), "5 dollars");
        assert_eq!(spoken_amount(1.0, "EUR"), "1 euro");
        assert_eq!(spoken_amount(2.5, "GBP"), "2.50 pounds");
    }
}

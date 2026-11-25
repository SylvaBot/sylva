//! Chat moderation: rules that catch spam, presets that set them, and what
//! happens to a chatter who breaks them.
//!
//! A streamer picks a preset (Relaxed, Standard or Strict) or tunes the rules
//! by hand, which makes it Custom. A message that breaks a rule is deleted the
//! first time and the chatter is timed out if they keep going, on a ladder the
//! preset sets. Strikes are forgotten after an hour without one.
//!
//! Nothing here talks to Twitch. The channel's Durable Object runs [`check`]
//! on every chat line and carries out the [`penalty`].

use serde::{Deserialize, Serialize};

use crate::alerts::Invalid;
use crate::bot::UserLevel;

pub const MAX_WORDS: usize = 200;
pub const MAX_WORD_LEN: usize = 50;
pub const MAX_ALLOWED_LINKS: usize = 50;
/// Twitch's longest timeout is two weeks.
pub const MAX_TIMEOUT_S: u32 = 1_209_600;
/// Strikes older than this are forgotten.
pub const STRIKE_RESET_MS: i64 = 3_600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Preset {
    #[default]
    Off,
    Relaxed,
    Standard,
    Strict,
    Custom,
}

/// A rule that looks at a share of the message, such as capital letters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub on: bool,
    /// Messages shorter than this (in letters or characters) are left alone.
    pub min: u32,
    /// Caught at or above this percentage.
    pub percent: u32,
}

/// A rule with a ceiling, such as the number of emotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub on: bool,
    /// Caught above this.
    pub max: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    pub links: bool,
    pub caps: Share,
    pub symbols: Share,
    pub emotes: Limit,
    pub length: Limit,
    pub repeats: Limit,
    pub zalgo: bool,
}

/// The whole moderation setup of a channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSettings {
    pub preset: Preset,
    pub rules: Rules,
    /// Chatters at this level or above are never moderated. Moderators and the
    /// streamer always are skipped.
    pub exempt: UserLevel,
    /// Seconds of timeout for the first, second and third strike. 0 deletes
    /// the message only.
    pub steps: [u32; 3],
    /// Banned words and phrases, matched whole and ignoring case.
    #[serde(default)]
    pub words: Vec<String>,
    /// Sites that may be linked, such as `clips.twitch.tv`. Their subdomains
    /// count too.
    #[serde(default)]
    pub allowed_links: Vec<String>,
    /// Say in chat why a message was removed.
    #[serde(default = "yes")]
    pub notice: bool,
}

fn yes() -> bool {
    true
}

impl Default for ModSettings {
    fn default() -> Self {
        let (rules, exempt, steps) = preset(Preset::Standard);
        ModSettings {
            preset: Preset::Off,
            rules,
            exempt,
            steps,
            words: Vec::new(),
            allowed_links: vec!["clips.twitch.tv".into()],
            notice: true,
        }
    }
}

const OFF_SHARE: Share = Share {
    on: false,
    min: 20,
    percent: 80,
};

/// What a preset sets: the rules, who is skipped and the timeout ladder.
pub fn preset(p: Preset) -> (Rules, UserLevel, [u32; 3]) {
    match p {
        Preset::Relaxed => (
            Rules {
                links: true,
                caps: OFF_SHARE,
                symbols: Share {
                    on: false,
                    min: 15,
                    percent: 60,
                },
                emotes: Limit { on: false, max: 15 },
                length: Limit {
                    on: false,
                    max: 400,
                },
                repeats: Limit { on: false, max: 20 },
                zalgo: true,
            },
            UserLevel::Subscriber,
            [0, 60, 600],
        ),
        Preset::Strict => (
            Rules {
                links: true,
                caps: Share {
                    on: true,
                    min: 12,
                    percent: 60,
                },
                symbols: Share {
                    on: true,
                    min: 10,
                    percent: 40,
                },
                emotes: Limit { on: true, max: 8 },
                length: Limit { on: true, max: 250 },
                repeats: Limit { on: true, max: 12 },
                zalgo: true,
            },
            UserLevel::Vip,
            [60, 600, 3600],
        ),
        // Standard, and the starting point for Off and Custom.
        _ => (
            Rules {
                links: true,
                caps: Share {
                    on: true,
                    min: 20,
                    percent: 80,
                },
                symbols: Share {
                    on: true,
                    min: 15,
                    percent: 60,
                },
                emotes: Limit { on: true, max: 15 },
                length: Limit { on: true, max: 400 },
                repeats: Limit { on: true, max: 20 },
                zalgo: true,
            },
            UserLevel::Vip,
            [0, 300, 1800],
        ),
    }
}

/// Which rule a message broke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Rule {
    Words,
    Links,
    Zalgo,
    Length,
    Repeats,
    Caps,
    Symbols,
    Emotes,
}

impl Rule {
    /// Said in chat after `@name, `.
    pub fn notice(self) -> &'static str {
        match self {
            Rule::Words => "that word is not allowed here",
            Rule::Links => "links are not allowed here",
            Rule::Zalgo => "please do not post glitched text",
            Rule::Length => "that message was too long",
            Rule::Repeats => "please do not repeat characters",
            Rule::Caps => "please ease up on the capital letters",
            Rule::Symbols => "please ease up on the symbols",
            Rule::Emotes => "please ease up on the emotes",
        }
    }
}

/// A chat message as moderation sees it.
pub struct Message<'a> {
    /// The whole text, emotes included.
    pub text: &'a str,
    /// The text without emotes, for the caps and symbols rules.
    pub words_only: &'a str,
    pub emotes: u32,
}

impl ModSettings {
    /// Checked settings, ready to store. A named preset always carries its
    /// own rules, so the rules shown match what runs.
    pub fn validated(mut self) -> Result<ModSettings, Invalid> {
        if !matches!(self.preset, Preset::Off | Preset::Custom) {
            let (rules, exempt, steps) = preset(self.preset);
            self.rules = rules;
            self.exempt = exempt;
            self.steps = steps;
        }
        let r = &mut self.rules;
        for s in [&mut r.caps, &mut r.symbols] {
            s.min = s.min.clamp(1, 500);
            s.percent = s.percent.clamp(10, 100);
        }
        r.emotes.max = r.emotes.max.clamp(1, 100);
        r.length.max = r.length.max.clamp(20, 500);
        r.repeats.max = r.repeats.max.clamp(3, 100);
        for s in &mut self.steps {
            *s = (*s).min(MAX_TIMEOUT_S);
        }
        if self.exempt < UserLevel::Subscriber {
            // Everyone exempt would make moderation do nothing.
            self.exempt = UserLevel::Subscriber;
        }
        if self.exempt > UserLevel::Moderator {
            self.exempt = UserLevel::Moderator;
        }

        let mut words: Vec<String> = Vec::new();
        for w in &self.words {
            let w = w.trim().to_lowercase();
            if w.is_empty() || words.contains(&w) {
                continue;
            }
            if w.chars().count() > MAX_WORD_LEN {
                return Err(Invalid(format!(
                    "Banned words can be up to {MAX_WORD_LEN} characters each."
                )));
            }
            words.push(w);
        }
        if words.len() > MAX_WORDS {
            return Err(Invalid(format!("Up to {MAX_WORDS} banned words.")));
        }
        self.words = words;

        let mut sites: Vec<String> = Vec::new();
        for s in &self.allowed_links {
            let raw = s.trim();
            if raw.is_empty() {
                continue;
            }
            let Some(host) = host_of(raw).filter(|h| h.contains('.')) else {
                return Err(Invalid(format!(
                    "\"{raw}\" is not a website. Use a name such as clips.twitch.tv."
                )));
            };
            if !sites.contains(&host) {
                sites.push(host);
            }
        }
        if sites.len() > MAX_ALLOWED_LINKS {
            return Err(Invalid(format!("Up to {MAX_ALLOWED_LINKS} allowed sites.")));
        }
        self.allowed_links = sites;
        Ok(self)
    }

    /// Whether a chatter at this level is moderated at all.
    pub fn applies_to(&self, level: UserLevel) -> bool {
        self.preset != Preset::Off && level < self.exempt && level < UserLevel::Moderator
    }
}

/// The first rule `msg` breaks, if any.
pub fn check(s: &ModSettings, msg: &Message) -> Option<Rule> {
    if s.preset == Preset::Off {
        return None;
    }
    let r = &s.rules;
    let lower = msg.text.to_lowercase();
    if s.words.iter().any(|w| contains_word(&lower, w)) {
        return Some(Rule::Words);
    }
    if r.links && links(msg.text).any(|h| !allowed(&h, &s.allowed_links)) {
        return Some(Rule::Links);
    }
    if r.zalgo && is_zalgo(msg.text) {
        return Some(Rule::Zalgo);
    }
    if r.length.on && msg.text.chars().count() as u32 > r.length.max {
        return Some(Rule::Length);
    }
    if r.repeats.on && longest_run(msg.text) > r.repeats.max {
        return Some(Rule::Repeats);
    }
    if r.caps.on {
        let letters = msg
            .words_only
            .chars()
            .filter(|c| c.is_uppercase() || c.is_lowercase());
        let (mut all, mut upper) = (0u32, 0u32);
        for c in letters {
            all += 1;
            if c.is_uppercase() {
                upper += 1;
            }
        }
        if all >= r.caps.min && upper * 100 >= r.caps.percent * all {
            return Some(Rule::Caps);
        }
    }
    if r.symbols.on {
        let (mut all, mut sym) = (0u32, 0u32);
        for c in msg.words_only.chars().filter(|c| !c.is_whitespace()) {
            all += 1;
            if !c.is_alphanumeric() {
                sym += 1;
            }
        }
        if all >= r.symbols.min && sym * 100 >= r.symbols.percent * all {
            return Some(Rule::Symbols);
        }
    }
    if r.emotes.on && msg.emotes > r.emotes.max {
        return Some(Rule::Emotes);
    }
    None
}

/// Seconds of timeout for a chatter with `strikes` recent strikes before this
/// one. 0 means delete the message only.
pub fn penalty(steps: &[u32; 3], strikes: u32) -> u32 {
    steps[(strikes as usize).min(steps.len() - 1)]
}

/// "1 minute", "5 minutes", "1 hour" and so on.
pub fn duration_text(seconds: u32) -> String {
    let (n, unit) = if seconds.is_multiple_of(86_400) {
        (seconds / 86_400, "day")
    } else if seconds.is_multiple_of(3600) {
        (seconds / 3600, "hour")
    } else if seconds.is_multiple_of(60) {
        (seconds / 60, "minute")
    } else {
        (seconds, "second")
    };
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

/// Whole word (or phrase) match: the characters around it are not letters or
/// digits.
fn contains_word(text: &str, word: &str) -> bool {
    let mut from = 0;
    while let Some(i) = text[from..].find(word) {
        let start = from + i;
        let end = start + word.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        let edge = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
        if edge(before) && edge(after) {
            return true;
        }
        from = start + text[start..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// Top level domains that count as a link when written without `http`. A
/// short list on purpose: "ok.so" and "lol.idk" are chat, not links.
const TLDS: &[&str] = &[
    "com", "net", "org", "io", "gg", "tv", "me", "co", "ly", "be", "uk", "de", "ru", "xyz", "app",
    "dev", "info", "biz", "us", "ca", "fr", "shop", "site", "online", "live", "link", "click",
    "top", "cc", "gl", "tk", "ml", "ga", "cf", "eu", "store", "tech", "fun", "art", "ws", "su",
    "to", "pw", "icu", "vip", "win", "bid", "club", "page", "gift", "gifts", "promo", "sale",
    "stream", "money", "cash", "bet", "casino",
];

/// The host of every link in `text`, lower case and without `www.`.
fn links(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split_whitespace().filter_map(|word| {
        let w = word.trim_matches(|c: char| "()[]{}<>\"'.,!?;:".contains(c));
        let explicit = w.contains("://") || w.to_ascii_lowercase().starts_with("www.");
        let host = host_of(w)?;
        let tld = host.rsplit('.').next()?;
        let looks = host.contains('.')
            && host
                .split('.')
                .all(|l| !l.is_empty() && l.chars().all(|c| c.is_alphanumeric() || c == '-'));
        (looks && (explicit || TLDS.contains(&tld))).then_some(host)
    })
}

/// `https://www.Example.com:8080/x?y` becomes `example.com`.
fn host_of(s: &str) -> Option<String> {
    let s = s.split_once("://").map_or(s, |(_, rest)| rest);
    let host = s.split(['/', '?', '#']).next()?;
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    let host = host.split(':').next()?.trim_end_matches('.').to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    (!host.is_empty()).then_some(host)
}

fn allowed(host: &str, sites: &[String]) -> bool {
    sites
        .iter()
        .any(|s| host == s || host.ends_with(&format!(".{s}")))
}

fn is_combining(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0489 | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// Three or more combining marks stacked on one letter. Real writing uses
/// at most two.
fn is_zalgo(text: &str) -> bool {
    let mut run = 0;
    for c in text.chars() {
        if is_combining(c) {
            run += 1;
            if run >= 3 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// The longest run of one character, spaces aside.
fn longest_run(text: &str) -> u32 {
    let (mut best, mut run, mut last) = (0u32, 0u32, None);
    for c in text.chars() {
        if c.is_whitespace() {
            run = 0;
            last = None;
            continue;
        }
        let c = c.to_lowercase().next().unwrap_or(c);
        if Some(c) == last {
            run += 1;
        } else {
            run = 1;
            last = Some(c);
        }
        best = best.max(run);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(p: Preset) -> ModSettings {
        ModSettings {
            preset: p,
            ..Default::default()
        }
        .validated()
        .unwrap()
    }

    fn msg(text: &str) -> Message<'_> {
        Message {
            text,
            words_only: text,
            emotes: 0,
        }
    }

    #[test]
    fn off_catches_nothing() {
        let s = ModSettings::default();
        assert_eq!(check(&s, &msg("buy followers at cheap.xyz")), None);
        assert!(!s.applies_to(UserLevel::Everyone));
    }

    #[test]
    fn links_are_caught_unless_allowed() {
        let s = with(Preset::Relaxed);
        for t in [
            "buy followers at cheap.xyz",
            "go to https://evil.example/path",
            "www.example.org",
            "(bit.ly/abc)",
            "HTTPS://Spam.Example.COM",
        ] {
            assert_eq!(check(&s, &msg(t)), Some(Rule::Links), "{t}");
        }
        for t in [
            "ok.so what now",
            "lol...yeah",
            "1.5 seconds",
            "see clips.twitch.tv/SomeClip",
            "https://clips.twitch.tv/x",
            "v1.2.3 is out",
        ] {
            assert_eq!(check(&s, &msg(t)), None, "{t}");
        }
    }

    #[test]
    fn banned_words_match_whole_words_ignoring_case() {
        let mut s = with(Preset::Relaxed);
        s.words = vec!["  Bad Word ".into(), "spam".into(), "spam".into()];
        let s = s.validated().unwrap();
        assert_eq!(s.words, ["bad word", "spam"]);
        assert_eq!(check(&s, &msg("this is SPAM!")), Some(Rule::Words));
        assert_eq!(check(&s, &msg("a bad word here")), Some(Rule::Words));
        assert_eq!(check(&s, &msg("spamming is fine")), None);
        assert_eq!(check(&s, &msg("antispam")), None);
        assert_eq!(check(&s, &msg("é spam é")), Some(Rule::Words));
    }

    #[test]
    fn caps_symbols_length_repeats_and_emotes() {
        let s = with(Preset::Standard);
        assert_eq!(
            check(&s, &msg("WHY IS EVERYONE SHOUTING TODAY")),
            Some(Rule::Caps)
        );
        assert_eq!(check(&s, &msg("GG WP")), None, "short shouts are fine");
        assert_eq!(
            check(&s, &msg("$$$$$$$$$$ !!!!!! ######")),
            Some(Rule::Symbols)
        );
        assert_eq!(check(&s, &msg("$%^&*()_+{}|:<>?~ hi")), Some(Rule::Symbols));
        assert_eq!(check(&s, &msg(&"a ".repeat(201))), Some(Rule::Length));
        assert_eq!(
            check(&s, &msg("noooooooooooooooooooooo")),
            Some(Rule::Repeats)
        );
        let m = Message {
            text: "Kappa Kappa",
            words_only: "",
            emotes: 16,
        };
        assert_eq!(check(&s, &m), Some(Rule::Emotes));
        let m = Message {
            text: "LUL LUL LUL LUL LUL LUL LUL",
            words_only: "      ",
            emotes: 7,
        };
        assert_eq!(check(&s, &m), None, "emote names are not caps");
    }

    #[test]
    fn zalgo_is_caught_but_accents_are_not() {
        let s = with(Preset::Relaxed);
        assert_eq!(
            check(&s, &msg("he\u{0336}\u{0337}\u{0338}llo")),
            Some(Rule::Zalgo)
        );
        assert_eq!(check(&s, &msg("Tiếng Việt, café, naïve")), None);
    }

    #[test]
    fn presets_carry_their_own_rules() {
        let mut s = with(Preset::Strict);
        s.rules.caps.on = false;
        s.steps = [0, 0, 0];
        let s = s.validated().unwrap();
        assert!(s.rules.caps.on, "a named preset resets its rules");
        assert_eq!(s.steps, [60, 600, 3600]);
        let mut c = s.clone();
        c.preset = Preset::Custom;
        c.rules.caps.on = false;
        c.steps = [0, 10, 99_999_999];
        let c = c.validated().unwrap();
        assert!(!c.rules.caps.on);
        assert_eq!(c.steps, [0, 10, MAX_TIMEOUT_S]);
    }

    #[test]
    fn who_is_moderated() {
        let s = with(Preset::Standard);
        assert!(s.applies_to(UserLevel::Everyone));
        assert!(s.applies_to(UserLevel::Subscriber));
        assert!(!s.applies_to(UserLevel::Vip));
        assert!(!s.applies_to(UserLevel::Moderator));
        assert!(!s.applies_to(UserLevel::Broadcaster));
        let r = with(Preset::Relaxed);
        assert!(!r.applies_to(UserLevel::Subscriber));
        let mut c = s.clone();
        c.preset = Preset::Custom;
        c.exempt = UserLevel::Broadcaster;
        let c = c.validated().unwrap();
        assert_eq!(c.exempt, UserLevel::Moderator);
        assert!(!c.applies_to(UserLevel::Moderator));
    }

    #[test]
    fn allowed_sites_are_tidied() {
        let mut s = with(Preset::Standard);
        s.allowed_links = vec!["https://www.YouTube.com/".into(), "youtube.com".into()];
        let s = s.validated().unwrap();
        assert_eq!(s.allowed_links, ["youtube.com"]);
        assert_eq!(check(&s, &msg("m.youtube.com/watch")), None);
        let mut bad = s.clone();
        bad.allowed_links = vec!["not a site".into()];
        assert!(bad.validated().is_err());
    }

    #[test]
    fn the_ladder_and_its_words() {
        assert_eq!(penalty(&[0, 300, 1800], 0), 0);
        assert_eq!(penalty(&[0, 300, 1800], 1), 300);
        assert_eq!(penalty(&[0, 300, 1800], 7), 1800);
        assert_eq!(duration_text(60), "1 minute");
        assert_eq!(duration_text(300), "5 minutes");
        assert_eq!(duration_text(3600), "1 hour");
        assert_eq!(duration_text(10), "10 seconds");
        assert_eq!(duration_text(86_400), "1 day");
    }
}

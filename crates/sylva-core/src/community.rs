//! Counters and quotes: the small community features the chat bot carries.
//!
//! A counter is a number with a name, such as `deaths`. Anyone can show it
//! with `!deaths`; moderators change it with `!deaths +`, `!deaths -2`,
//! `!deaths = 10` or `!deaths reset`.
//!
//! Quotes are numbered lines worth keeping. `!quote` shows a random one,
//! `!quote 12` that one, `!quote word` a random one that mentions the word.
//! `!addquote text` adds one and `!delquote 12` removes it (moderators by
//! default). Numbers are never reused, so `#12` always means the same quote.

use serde::{Deserialize, Serialize};

use crate::alerts::Invalid;
use crate::bot::UserLevel;

pub const MAX_COUNTERS: usize = 30;
pub const MAX_LABEL: usize = 40;
pub const MAX_QUOTES: usize = 2000;
pub const MAX_QUOTE: usize = 300;
pub const MAX_QUOTE_BY: usize = 40;
/// The chat words quotes answer to.
pub const QUOTE_TRIGGERS: [&str; 3] = ["quote", "addquote", "delquote"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counter {
    /// The chat trigger without `!`, such as `deaths`.
    pub name: String,
    /// What chat sees, such as `Deaths`.
    #[serde(default)]
    pub label: String,
    /// Kept by the server: a settings save keeps the stored value. Change it
    /// with the counter's own route or from chat.
    #[serde(default)]
    pub value: i64,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteSettings {
    pub enabled: bool,
    /// Who may add and remove quotes from chat.
    pub add_level: UserLevel,
}

impl Default for QuoteSettings {
    fn default() -> Self {
        QuoteSettings {
            enabled: true,
            add_level: UserLevel::Moderator,
        }
    }
}

/// What a counter command asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CounterAction {
    Show,
    Add(i64),
    Set(i64),
}

/// `+`, `+3`, `-`, `-2`, `= 10`, `=10`, `set 10` and `reset`. Anything else
/// (or nothing) shows the counter.
pub fn counter_action(args: &[String]) -> CounterAction {
    let joined = args.join(" ");
    let a = joined.trim().to_lowercase();
    let num = |s: &str| {
        s.trim()
            .parse::<i64>()
            .ok()
            .filter(|n| n.abs() <= 1_000_000_000)
    };
    if a == "+" {
        return CounterAction::Add(1);
    }
    if a == "-" {
        return CounterAction::Add(-1);
    }
    if a == "reset" {
        return CounterAction::Set(0);
    }
    if let Some(n) = a.strip_prefix('+').and_then(num) {
        return CounterAction::Add(n);
    }
    if let Some(n) = a.strip_prefix('-').and_then(num) {
        return CounterAction::Add(-n);
    }
    if let Some(n) = a
        .strip_prefix('=')
        .or_else(|| a.strip_prefix("set "))
        .and_then(num)
    {
        return CounterAction::Set(n);
    }
    CounterAction::Show
}

impl Counter {
    pub fn apply(&mut self, action: CounterAction) {
        const LIMIT: i64 = 1_000_000_000_000;
        self.value = match action {
            CounterAction::Show => self.value,
            CounterAction::Add(n) => self.value.saturating_add(n),
            CounterAction::Set(n) => n,
        }
        .clamp(-LIMIT, LIMIT);
    }

    /// What the bot says, such as `Deaths: 6`.
    pub fn reply(&self) -> String {
        format!("{}: {}", self.label, self.value)
    }
}

/// Checks counters: names like command triggers, no repeats, labels filled
/// in, values kept from `stored`.
pub fn validate_counters(
    counters: &mut [Counter],
    stored: &[Counter],
    clean_trigger: impl Fn(&str) -> Result<String, Invalid>,
) -> Result<(), Invalid> {
    if counters.len() > MAX_COUNTERS {
        return Err(Invalid(format!(
            "A channel can have up to {MAX_COUNTERS} counters"
        )));
    }
    let mut seen: Vec<String> = Vec::new();
    for c in counters.iter_mut() {
        c.name = clean_trigger(&c.name)?;
        if seen.contains(&c.name) {
            return Err(Invalid(format!("!{} is used by two counters", c.name)));
        }
        seen.push(c.name.clone());
        let label = c.label.trim();
        c.label = if label.is_empty() {
            let mut chars = c.name.chars();
            chars
                .next()
                .map(|f| f.to_uppercase().chain(chars).collect())
                .unwrap_or_default()
        } else {
            label.chars().take(MAX_LABEL).collect()
        };
        if let Some(s) = stored.iter().find(|s| s.name == c.name) {
            c.value = s.value;
        }
    }
    Ok(())
}

/// One saved quote.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub id: i64,
    pub text: String,
    /// Who said it. Empty means the streamer.
    #[serde(default)]
    pub by: String,
    /// What was being played, if known.
    #[serde(default)]
    pub game: String,
    /// When it was added, in milliseconds.
    pub at: i64,
}

/// A quote as typed: trimmed and checked.
pub fn clean_quote(text: &str, by: &str, game: &str) -> Result<(String, String, String), Invalid> {
    let text = text.trim().trim_matches('"').trim().to_string();
    if text.is_empty() {
        return Err(Invalid("A quote needs some words".into()));
    }
    if text.chars().count() > MAX_QUOTE {
        return Err(Invalid(format!(
            "A quote can be up to {MAX_QUOTE} characters"
        )));
    }
    let short = |s: &str| s.trim().chars().take(MAX_QUOTE_BY).collect::<String>();
    Ok((text, short(by), short(game)))
}

/// `#12: "Never again" (Maple, Hollow Knight, 2026-11-25)`.
pub fn quote_line(q: &Quote, channel: &str) -> String {
    let mut extra = vec![if q.by.is_empty() {
        channel.to_string()
    } else {
        q.by.clone()
    }];
    if !q.game.is_empty() {
        extra.push(q.game.clone());
    }
    extra.push(date(q.at));
    format!("#{}: \"{}\" ({})", q.id, q.text, extra.join(", "))
}

/// `YYYY-MM-DD` in UTC from milliseconds since 1970.
pub fn date(ms: i64) -> String {
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// What `!quote ...` asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuoteLookup {
    Random,
    Number(i64),
    Search(String),
}

pub fn quote_lookup(args: &[String]) -> QuoteLookup {
    let a = args.join(" ");
    let a = a.trim().trim_start_matches('#');
    if a.is_empty() {
        QuoteLookup::Random
    } else if let Ok(n) = a.parse::<i64>() {
        QuoteLookup::Number(n)
    } else {
        QuoteLookup::Search(a.to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn counter_actions() {
        use CounterAction::*;
        assert_eq!(counter_action(&args("")), Show);
        assert_eq!(counter_action(&args("+")), Add(1));
        assert_eq!(counter_action(&args("-")), Add(-1));
        assert_eq!(counter_action(&args("+3")), Add(3));
        assert_eq!(counter_action(&args("-2")), Add(-2));
        assert_eq!(counter_action(&args("= 10")), Set(10));
        assert_eq!(counter_action(&args("=10")), Set(10));
        assert_eq!(counter_action(&args("set 7")), Set(7));
        assert_eq!(counter_action(&args("RESET")), Set(0));
        assert_eq!(counter_action(&args("lol")), Show);
        assert_eq!(
            counter_action(&args("+99999999999")),
            Show,
            "silly numbers are ignored"
        );
        let mut c = Counter {
            name: "deaths".into(),
            label: "Deaths".into(),
            value: 5,
            enabled: true,
        };
        c.apply(Add(1));
        assert_eq!(c.reply(), "Deaths: 6");
        c.apply(Set(0));
        c.apply(Add(-1));
        assert_eq!(c.value, -1);
    }

    #[test]
    fn counters_are_checked_and_keep_their_values() {
        let clean = |s: &str| Ok(s.trim().trim_start_matches('!').to_lowercase());
        let stored = vec![Counter {
            name: "deaths".into(),
            label: "Deaths".into(),
            value: 12,
            enabled: true,
        }];
        let mut list = vec![
            Counter {
                name: "!Deaths".into(),
                label: "".into(),
                value: 0,
                enabled: true,
            },
            Counter {
                name: "wins".into(),
                label: "  Wins today ".into(),
                value: 3,
                enabled: true,
            },
        ];
        validate_counters(&mut list, &stored, clean).unwrap();
        assert_eq!((list[0].label.as_str(), list[0].value), ("Deaths", 12));
        assert_eq!((list[1].label.as_str(), list[1].value), ("Wins today", 3));
        list.push(list[1].clone());
        assert!(validate_counters(&mut list, &stored, clean).is_err());
    }

    #[test]
    fn quotes() {
        let q = Quote {
            id: 12,
            text: "Never again".into(),
            by: "".into(),
            game: "Hollow Knight".into(),
            at: 1_795_600_000_000,
        };
        assert_eq!(
            quote_line(&q, "Maple"),
            "#12: \"Never again\" (Maple, Hollow Knight, 2026-11-25)"
        );
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(951_782_400_000), "2000-02-29");
        assert_eq!(quote_lookup(&args("")), QuoteLookup::Random);
        assert_eq!(quote_lookup(&args("#4")), QuoteLookup::Number(4));
        assert_eq!(
            quote_lookup(&args("Never")),
            QuoteLookup::Search("never".into())
        );
        assert!(clean_quote("  \"\" ", "", "").is_err());
        assert_eq!(
            clean_quote(" \"hi there\" ", " Rowan ", "").unwrap(),
            ("hi there".into(), "Rowan".into(), "".into())
        );
        assert!(clean_quote(&"a".repeat(301), "", "").is_err());
    }
}

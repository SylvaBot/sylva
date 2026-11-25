//! The points store: rewards viewers buy with loyalty points.
//!
//! The streamer lists rewards, each with a cost and optionally a limited
//! stock, a wait between uses per viewer, and a message the viewer must add
//! (such as a song name). Viewers redeem with `!redeem 2` or
//! `!redeem hydrate`, adding their message after it. Every redemption waits
//! in a queue on the dashboard until the streamer marks it done or refunds it.

use serde::{Deserialize, Serialize};

use crate::alerts::Invalid;

pub const MAX_ITEMS: usize = 50;
pub const MAX_ITEM_NAME: usize = 40;
pub const MAX_ITEM_DESC: usize = 200;
pub const MAX_COST: u32 = 10_000_000;
pub const MAX_INPUT: usize = 200;
/// The longest wait between uses, in minutes (a week).
pub const MAX_COOLDOWN: u32 = 10_080;
/// The chat words the store answers to.
pub const TRIGGERS: [&str; 3] = ["redeem", "store", "rewards"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreItem {
    /// Given by the server, such as `r3`.
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub cost: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// How many are left. `None` is unlimited.
    #[serde(default)]
    pub stock: Option<u32>,
    /// Minutes a viewer waits before buying this again. 0 is no wait.
    #[serde(default)]
    pub cooldown: u32,
    /// The viewer must add a message, such as a song name.
    #[serde(default)]
    pub input: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSettings {
    pub enabled: bool,
    #[serde(default)]
    pub items: Vec<StoreItem>,
}

fn tidy(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl StoreSettings {
    /// Checks a save. Ids are the server's: stored ones are kept and new
    /// rewards are numbered after the highest seen.
    pub fn validated(mut self, stored: &StoreSettings) -> Result<StoreSettings, Invalid> {
        if self.items.len() > MAX_ITEMS {
            return Err(Invalid(format!(
                "A store can have up to {MAX_ITEMS} rewards"
            )));
        }
        let number = |id: &str| id.strip_prefix('r').and_then(|n| n.parse::<u32>().ok());
        let mut next = stored
            .items
            .iter()
            .chain(self.items.iter())
            .filter_map(|i| number(&i.id))
            .max()
            .unwrap_or(0)
            + 1;
        let mut ids: Vec<String> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        for item in &mut self.items {
            let known = stored.items.iter().any(|s| s.id == item.id);
            if !known || ids.contains(&item.id) {
                item.id = format!("r{next}");
                next += 1;
            }
            ids.push(item.id.clone());
            item.name = tidy(&item.name);
            if item.name.is_empty() || item.name.chars().count() > MAX_ITEM_NAME {
                return Err(Invalid(format!(
                    "Each reward needs a name of up to {MAX_ITEM_NAME} characters"
                )));
            }
            if item.name.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return Err(Invalid(format!(
                    "\"{}\" starts with a number, which chat reads as a reward's place in the list",
                    item.name
                )));
            }
            let key = item.name.to_lowercase();
            if names.contains(&key) {
                return Err(Invalid(format!("Two rewards are called \"{}\"", item.name)));
            }
            names.push(key);
            item.description = tidy(&item.description);
            if item.description.chars().count() > MAX_ITEM_DESC {
                return Err(Invalid(format!(
                    "The description of \"{}\" can be up to {MAX_ITEM_DESC} characters",
                    item.name
                )));
            }
            if item.cost == 0 || item.cost > MAX_COST {
                return Err(Invalid(format!(
                    "\"{}\" needs a cost from 1 to 10,000,000",
                    item.name
                )));
            }
            item.cooldown = item.cooldown.min(MAX_COOLDOWN);
        }
        Ok(self)
    }

    /// The rewards viewers can see, in order: their place in this list is
    /// the number chat uses.
    pub fn shown(&self) -> Vec<&StoreItem> {
        self.items.iter().filter(|i| i.enabled).collect()
    }

    /// The reward `!redeem` asks for, and the viewer's message after it.
    /// Accepts the reward's number in the shown list or its name (ignoring
    /// capitals), the longest matching name first.
    pub fn find<'a>(&'a self, args: &[String]) -> Option<(&'a StoreItem, String)> {
        let shown = self.shown();
        let first = args.first()?;
        if let Ok(n) = first.trim_start_matches('#').parse::<usize>() {
            let item = shown.get(n.checked_sub(1)?)?;
            return Some((item, args[1..].join(" ")));
        }
        let words: Vec<String> = args.iter().map(|a| a.to_lowercase()).collect();
        let mut best: Option<(&StoreItem, usize)> = None;
        for item in shown {
            let name: Vec<String> = item
                .name
                .to_lowercase()
                .split_whitespace()
                .map(String::from)
                .collect();
            if words.len() >= name.len()
                && words[..name.len()] == name[..]
                && best.is_none_or(|(_, n)| name.len() > n)
            {
                best = Some((item, name.len()));
            }
        }
        best.map(|(item, n)| (item, args[n..].join(" ")))
    }
}

/// A viewer's message for a reward, tidied, or `None` when it is too long.
pub fn clean_input(s: &str) -> Option<String> {
    let s = tidy(s);
    (s.chars().count() <= MAX_INPUT).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, name: &str, cost: u32) -> StoreItem {
        StoreItem {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            cost,
            enabled: true,
            stock: None,
            cooldown: 0,
            input: false,
        }
    }

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn saves_are_checked_and_numbered() {
        let stored = StoreSettings {
            enabled: true,
            items: vec![item("r4", "Hydrate", 100)],
        };
        let saved = StoreSettings {
            enabled: true,
            items: vec![
                item("r4", "  Hydrate ", 100),
                item("", "Song   request", 500),
                item("r4", "Pushups", 50),
            ],
        }
        .validated(&stored)
        .unwrap();
        let got: Vec<(&str, &str)> = saved
            .items
            .iter()
            .map(|i| (i.id.as_str(), i.name.as_str()))
            .collect();
        assert_eq!(
            got,
            [("r4", "Hydrate"), ("r5", "Song request"), ("r6", "Pushups")]
        );
        let bad = |items: Vec<StoreItem>| {
            StoreSettings {
                enabled: true,
                items,
            }
            .validated(&stored)
            .is_err()
        };
        assert!(bad(vec![item("", "", 1)]));
        assert!(bad(vec![item("", "A", 0)]));
        assert!(bad(vec![item("", "1 song", 5)]));
        assert!(bad(vec![item("", "Hi", 5), item("", "HI", 5)]));
        assert!(bad(vec![item("", "A", MAX_COST + 1)]));
    }

    #[test]
    fn redeem_finds_by_number_or_name() {
        let mut off = item("r3", "Hidden", 1);
        off.enabled = false;
        let s = StoreSettings {
            enabled: true,
            items: vec![item("r1", "Song", 10), off, item("r2", "Song request", 20)],
        };
        let (i, rest) = s.find(&args("2 Never Gonna")).unwrap();
        assert_eq!((i.id.as_str(), rest.as_str()), ("r2", "Never Gonna"));
        let (i, rest) = s.find(&args("song REQUEST Darude")).unwrap();
        assert_eq!((i.id.as_str(), rest.as_str()), ("r2", "Darude"));
        let (i, rest) = s.find(&args("song")).unwrap();
        assert_eq!((i.id.as_str(), rest.as_str()), ("r1", ""));
        assert!(s.find(&args("3")).is_none(), "only shown rewards count");
        assert!(s.find(&args("0")).is_none());
        assert!(s.find(&args("hidden")).is_none());
        assert!(s.find(&args("")).is_none());
        assert_eq!(clean_input("  a   b "), Some("a b".into()));
        assert_eq!(clean_input(&"x".repeat(201)), None);
    }
}

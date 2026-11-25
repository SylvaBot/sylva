//! Giveaways: viewers enter with a chat word, the streamer draws a winner.
//!
//! The draw can be checked by anyone. When a giveaway opens, Sylva picks a
//! secret seed and shows its SHA-256 hash. When it draws, it shows the seed
//! itself, so everyone can see the seed was fixed before anyone entered.
//! The winner is [`pick`] of the seed, the round and the entries in the
//! order they came in: hash `seed:round`, read the first 8 bytes as a
//! number, and take it modulo the total tickets.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::alerts::Invalid;
use crate::bot::UserLevel;

pub const MAX_PRIZE: usize = 100;
/// The most tickets a subscriber can get.
pub const MAX_LUCK: u32 = 5;
pub const MAX_ENTRY_COST: u32 = 1_000_000;

/// What the streamer sets when starting a giveaway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GiveawaySettings {
    pub prize: String,
    /// The chat word viewers type to enter, without `!`, such as `join`.
    pub keyword: String,
    /// Who may enter.
    #[serde(default = "everyone")]
    pub level: UserLevel,
    /// Loyalty points an entry costs. 0 is free.
    #[serde(default)]
    pub cost: u32,
    /// Tickets for subscribers; everyone else has 1.
    #[serde(default = "one")]
    pub sub_luck: u32,
}

fn everyone() -> UserLevel {
    UserLevel::Everyone
}

fn one() -> u32 {
    1
}

impl GiveawaySettings {
    pub fn validated(mut self) -> Result<GiveawaySettings, Invalid> {
        self.prize = self.prize.split_whitespace().collect::<Vec<_>>().join(" ");
        if self.prize.is_empty() || self.prize.chars().count() > MAX_PRIZE {
            return Err(Invalid(format!(
                "Name the prize in up to {MAX_PRIZE} characters"
            )));
        }
        let k = self.keyword.trim().trim_start_matches('!').to_lowercase();
        if k.is_empty() || k.len() > 25 || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(Invalid(
                "The chat word can use letters, numbers and _, up to 25".into(),
            ));
        }
        self.keyword = k;
        if self.cost > MAX_ENTRY_COST {
            return Err(Invalid("An entry can cost up to 1,000,000 points".into()));
        }
        self.sub_luck = self.sub_luck.clamp(1, MAX_LUCK);
        if self.level == UserLevel::Broadcaster {
            self.level = UserLevel::Moderator;
        }
        Ok(self)
    }

    /// Tickets for a viewer at `level`.
    pub fn tickets(&self, level: UserLevel) -> u32 {
        if level >= UserLevel::Subscriber {
            self.sub_luck
        } else {
            1
        }
    }
}

/// The public commitment to a seed: its SHA-256 in hex.
pub fn seed_hash(seed: &str) -> String {
    hex::encode(Sha256::digest(seed.as_bytes()))
}

/// The winning entry for `round` (1 for the first draw), given each
/// entry's tickets in the order they entered. Entries with 0 tickets (such
/// as earlier winners) cannot win. `None` when nobody can.
pub fn pick(seed: &str, round: u32, tickets: &[u32]) -> Option<usize> {
    let total: u64 = tickets.iter().map(|&t| u64::from(t)).sum();
    if total == 0 {
        return None;
    }
    let digest = Sha256::digest(format!("{seed}:{round}").as_bytes());
    let mut first = [0u8; 8];
    first.copy_from_slice(&digest[..8]);
    let mut target = u64::from_be_bytes(first) % total;
    for (i, &t) in tickets.iter().enumerate() {
        let t = u64::from(t);
        if target < t {
            return Some(i);
        }
        target -= t;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings() {
        let s = GiveawaySettings {
            prize: "  A   game key ".into(),
            keyword: "!Join".into(),
            level: UserLevel::Broadcaster,
            cost: 0,
            sub_luck: 9,
        }
        .validated()
        .unwrap();
        assert_eq!(s.prize, "A game key");
        assert_eq!(s.keyword, "join");
        assert_eq!(s.level, UserLevel::Moderator);
        assert_eq!(s.sub_luck, 5);
        assert_eq!(s.tickets(UserLevel::Vip), 5);
        assert_eq!(s.tickets(UserLevel::Everyone), 1);
        let bad = |prize: &str, keyword: &str| {
            GiveawaySettings {
                prize: prize.into(),
                keyword: keyword.into(),
                level: UserLevel::Everyone,
                cost: 0,
                sub_luck: 1,
            }
            .validated()
            .is_err()
        };
        assert!(bad("", "join"));
        assert!(bad("Prize", "two words"));
        assert!(bad("Prize", "!"));
    }

    #[test]
    fn draws_are_fixed_by_the_seed() {
        // Known values, so anyone checking by hand gets the same answer.
        assert_eq!(
            seed_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let tickets = [1, 1, 1, 1, 1];
        let a = pick("seed", 1, &tickets).unwrap();
        assert_eq!(
            pick("seed", 1, &tickets),
            Some(a),
            "the same seed picks the same entry"
        );
        assert!(a < 5);
        assert_eq!(pick("seed", 1, &[0, 0]), None);
        assert_eq!(pick("seed", 1, &[]), None);
        assert_eq!(pick("seed", 3, &[0, 4, 0]), Some(1));
        // Over many seeds, an entry with 3 tickets wins about 3 times as often.
        let mut wins = [0u32; 2];
        for i in 0..4000 {
            wins[pick(&format!("s{i}"), 1, &[1, 3]).unwrap()] += 1;
        }
        assert!((2700..3300).contains(&wins[1]), "{wins:?}");
    }
}

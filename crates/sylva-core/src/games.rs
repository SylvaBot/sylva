//! Points games in chat: !gamble, !roulette, !slots, !blackjack and !duel.
//!
//! Everything here is pure: the Durable Object passes in the random numbers
//! and the viewer's balance, and gets back the change in points and the line
//! to post. That keeps the odds testable.

use serde::{Deserialize, Serialize};

use crate::loyalty::grouped;

/// The most a single bet may be, whatever the settings say.
pub const MAX_BET: i64 = 10_000_000;
/// How long a blackjack hand or a duel challenge waits for an answer.
pub const ANSWER_MS: i64 = 120_000;
/// The chat words the games answer to.
pub const TRIGGERS: [&str; 10] = [
    "gamble",
    "roulette",
    "slots",
    "blackjack",
    "bj",
    "hit",
    "stand",
    "duel",
    "accept",
    "deny",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameSettings {
    pub gamble: bool,
    pub roulette: bool,
    pub slots: bool,
    pub blackjack: bool,
    pub duel: bool,
    /// The smallest bet.
    pub min_bet: u32,
    /// The largest bet, or 0 for no limit besides the viewer's own points.
    pub max_bet: u32,
    /// Seconds a viewer waits between games.
    pub cooldown: u32,
}

impl Default for GameSettings {
    fn default() -> Self {
        GameSettings {
            gamble: true,
            roulette: true,
            slots: true,
            blackjack: true,
            duel: true,
            min_bet: 10,
            max_bet: 0,
            cooldown: 30,
        }
    }
}

impl GameSettings {
    pub fn validated(mut self) -> GameSettings {
        self.min_bet = self.min_bet.clamp(1, MAX_BET as u32);
        self.max_bet = self.max_bet.min(MAX_BET as u32);
        if self.max_bet != 0 && self.max_bet < self.min_bet {
            self.max_bet = self.min_bet;
        }
        self.cooldown = self.cooldown.min(3600);
        self
    }

    /// Whether the game a trigger belongs to is on.
    pub fn on(&self, game: Game) -> bool {
        match game {
            Game::Gamble => self.gamble,
            Game::Roulette => self.roulette,
            Game::Slots => self.slots,
            Game::Blackjack => self.blackjack,
            Game::Duel => self.duel,
        }
    }

    /// Check a bet against the limits, as the line to post when it fails.
    pub fn check(&self, bet: i64, balance: i64, user: &str, name: &str) -> Result<(), String> {
        if balance <= 0 {
            return Err(format!("{user}, you have no {name} yet."));
        }
        if bet > balance {
            return Err(format!(
                "{user}, you only have {} {name}.",
                grouped(balance)
            ));
        }
        if bet < i64::from(self.min_bet) {
            return Err(format!(
                "{user}, the smallest bet is {} {name}.",
                grouped(self.min_bet.into())
            ));
        }
        if self.max_bet != 0 && bet > i64::from(self.max_bet) {
            return Err(format!(
                "{user}, the largest bet is {} {name}.",
                grouped(self.max_bet.into())
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Game {
    Gamble,
    Roulette,
    Slots,
    Blackjack,
    Duel,
}

impl Game {
    pub fn of(trigger: &str) -> Option<Game> {
        Some(match trigger {
            "gamble" => Game::Gamble,
            "roulette" => Game::Roulette,
            "slots" => Game::Slots,
            "blackjack" | "bj" | "hit" | "stand" => Game::Blackjack,
            "duel" | "accept" | "deny" => Game::Duel,
            _ => return None,
        })
    }

    pub fn key(self) -> &'static str {
        match self {
            Game::Gamble => "gamble",
            Game::Roulette => "roulette",
            Game::Slots => "slots",
            Game::Blackjack => "blackjack",
            Game::Duel => "duel",
        }
    }
}

/// A bet as typed: `100`, `1,000`, `2k`, `1.5m`, `all`, `half` or `25%`.
pub fn bet(arg: &str, balance: i64) -> Option<i64> {
    let a = arg.trim().to_lowercase().replace(',', "");
    let n = match a.as_str() {
        "all" | "allin" | "max" => balance,
        "half" => balance / 2,
        _ => {
            if let Some(p) = a.strip_suffix('%') {
                let p: f64 = p.parse().ok()?;
                if !(0.0..=100.0).contains(&p) {
                    return None;
                }
                (balance as f64 * p / 100.0).floor() as i64
            } else {
                let (num, times) = match a.chars().last()? {
                    'k' => (&a[..a.len() - 1], 1_000.0),
                    'm' => (&a[..a.len() - 1], 1_000_000.0),
                    _ => (a.as_str(), 1.0),
                };
                let f: f64 = num.parse().ok()?;
                if !f.is_finite() {
                    return None;
                }
                (f * times).floor() as i64
            }
        }
    };
    (n > 0).then_some(n.min(MAX_BET))
}

/// `!gamble`: a roll of 1 to 100. 56 or more doubles the bet, and 100
/// pays four times.
pub fn gamble(roll: u32, bet: i64, user: &str, name: &str) -> (i64, String) {
    let (net, how) = match roll {
        100 => (bet * 3, "hit the jackpot and won"),
        56..=99 => (bet, "won"),
        _ => (-bet, "lost"),
    };
    (
        net,
        format!(
            "{user} rolled {roll} and {how} {} {name}.",
            grouped(net.abs())
        ),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    Red,
    Black,
    Even,
    Odd,
    Number(u32),
}

impl Pick {
    pub fn parse(s: &str) -> Option<Pick> {
        Some(match s.trim().to_lowercase().as_str() {
            "red" | "r" => Pick::Red,
            "black" | "b" => Pick::Black,
            "even" => Pick::Even,
            "odd" => Pick::Odd,
            "green" | "g" => Pick::Number(0),
            n => {
                let n: u32 = n.parse().ok()?;
                (n <= 36).then_some(Pick::Number(n))?
            }
        })
    }

    fn label(self) -> String {
        match self {
            Pick::Red => "red".into(),
            Pick::Black => "black".into(),
            Pick::Even => "even".into(),
            Pick::Odd => "odd".into(),
            Pick::Number(n) => n.to_string(),
        }
    }
}

const REDS: [u32; 18] = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

fn color(n: u32) -> &'static str {
    if n == 0 {
        "green"
    } else if REDS.contains(&n) {
        "red"
    } else {
        "black"
    }
}

/// `!roulette`: a wheel with 0 to 36. Colors, even and odd pay even money;
/// a single number pays 35 to 1.
pub fn roulette(spin: u32, pick: Pick, bet: i64, user: &str, name: &str) -> (i64, String) {
    let won_times = match pick {
        Pick::Red => (color(spin) == "red").then_some(1),
        Pick::Black => (color(spin) == "black").then_some(1),
        Pick::Even => (spin != 0 && spin.is_multiple_of(2)).then_some(1),
        Pick::Odd => (spin % 2 == 1).then_some(1),
        Pick::Number(n) => (n == spin).then_some(35),
    };
    let net = won_times.map_or(-bet, |t| bet * t);
    let how = if net > 0 { "won" } else { "lost" };
    (
        net,
        format!(
            "The ball lands on {spin} {}. {user} bet on {} and {how} {} {name}.",
            color(spin),
            pick.label(),
            grouped(net.abs())
        ),
    )
}

pub const SYMBOLS: [&str; 6] = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎"];

/// `!slots`: three reels of six symbols. Three of a kind pays ten times
/// (twenty for 💎), two of a kind gives back one and a half times the bet.
pub fn slots(reels: [usize; 3], bet: i64, user: &str, name: &str) -> (i64, String) {
    let [a, b, c] = reels.map(|r| r % SYMBOLS.len());
    let back = if a == b && b == c {
        if SYMBOLS[a] == "💎" {
            bet * 20
        } else {
            bet * 10
        }
    } else if a == b || b == c || a == c {
        bet + bet / 2
    } else {
        0
    };
    let net = back - bet;
    let line = format!("{} {} {}", SYMBOLS[a], SYMBOLS[b], SYMBOLS[c]);
    let how = if net > 0 {
        format!("{user} won {} {name}!", grouped(net))
    } else {
        format!("{user} lost {} {name}.", grouped(-net))
    };
    (net, format!("| {line} | {how}"))
}

/// A blackjack hand waiting for `!hit` or `!stand`. Cards are ranks 1 (ace)
/// to 13 (king), dealt from an endless shoe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hand {
    pub bet: i64,
    pub player: Vec<u8>,
    pub dealer: Vec<u8>,
    pub at: i64,
}

fn card(r: u8) -> &'static str {
    [
        "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K",
    ][usize::from(r.clamp(1, 13) - 1)]
}

/// A hand's best total, counting aces as 11 while that does not bust.
pub fn total(cards: &[u8]) -> u32 {
    let mut sum: u32 = cards.iter().map(|&r| u32::from(r.min(10))).sum();
    let aces = cards.iter().filter(|&&r| r == 1).count();
    for _ in 0..aces {
        if sum + 10 <= 21 {
            sum += 10;
        }
    }
    sum
}

fn show(cards: &[u8]) -> String {
    format!(
        "{} ({})",
        cards.iter().map(|&r| card(r)).collect::<Vec<_>>().join(" "),
        total(cards)
    )
}

fn natural(cards: &[u8]) -> bool {
    cards.len() == 2 && total(cards) == 21
}

/// What happened to a blackjack hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Play {
    /// Still going: keep the hand and post the line.
    Going(Hand, String),
    /// Over: pay back `back` points (the bet was taken at the start).
    Done { back: i64, line: String },
}

/// Deal a new hand. The bet is taken before this.
pub fn deal(bet: i64, now: i64, draw: &mut dyn FnMut() -> u8, user: &str, name: &str) -> Play {
    let player = vec![draw(), draw()];
    let dealer = vec![draw(), draw()];
    let hand = Hand {
        bet,
        player,
        dealer,
        at: now,
    };
    if natural(&hand.player) || natural(&hand.dealer) {
        return settle(hand, user, name);
    }
    let line = format!(
        "{user}, you have {}. The dealer shows {}. Type !hit or !stand.",
        show(&hand.player),
        card(hand.dealer[0])
    );
    Play::Going(hand, line)
}

/// `!hit`: one more card.
pub fn hit(mut hand: Hand, draw: &mut dyn FnMut() -> u8, user: &str, name: &str) -> Play {
    hand.player.push(draw());
    let t = total(&hand.player);
    if t > 21 {
        return Play::Done {
            back: 0,
            line: format!(
                "{user} drew {} and busts with {t}. Lost {} {name}.",
                card(*hand.player.last().unwrap_or(&1)),
                grouped(hand.bet)
            ),
        };
    }
    if t == 21 {
        return stand(hand, draw, user, name);
    }
    let line = format!(
        "{user}, you have {}. The dealer shows {}. Type !hit or !stand.",
        show(&hand.player),
        card(hand.dealer[0])
    );
    Play::Going(hand, line)
}

/// `!stand`: the dealer draws to 17, then the hands are compared.
pub fn stand(mut hand: Hand, draw: &mut dyn FnMut() -> u8, user: &str, name: &str) -> Play {
    while total(&hand.dealer) < 17 {
        hand.dealer.push(draw());
    }
    settle(hand, user, name)
}

fn settle(hand: Hand, user: &str, name: &str) -> Play {
    let (p, d) = (total(&hand.player), total(&hand.dealer));
    let bet = hand.bet;
    let (back, how) = if natural(&hand.player) && natural(&hand.dealer) {
        (bet, "Both have blackjack, a push.".to_string())
    } else if natural(&hand.player) {
        let won = bet * 3 / 2;
        (
            bet + won,
            format!("Blackjack! {user} won {} {name}.", grouped(won)),
        )
    } else if natural(&hand.dealer) {
        (
            0,
            format!(
                "The dealer has blackjack. {user} lost {} {name}.",
                grouped(bet)
            ),
        )
    } else if d > 21 || p > d {
        (bet * 2, format!("{user} won {} {name}.", grouped(bet)))
    } else if p == d {
        (bet, "A push, the bet comes back.".to_string())
    } else {
        (0, format!("{user} lost {} {name}.", grouped(bet)))
    };
    Play::Done {
        back,
        line: format!(
            "{user} has {}, the dealer has {}. {how}",
            show(&hand.player),
            show(&hand.dealer)
        ),
    }
}

/// A duel challenge waiting for the other viewer's `!accept`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Challenge {
    pub from_id: String,
    pub from_login: String,
    pub from_name: String,
    pub bet: i64,
    pub at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bets_parse() {
        assert_eq!(bet("100", 50), Some(100));
        assert_eq!(bet("1,000", 0), Some(1000));
        assert_eq!(bet("2k", 0), Some(2000));
        assert_eq!(bet("1.5m", 0), Some(1_500_000));
        assert_eq!(bet("all", 640), Some(640));
        assert_eq!(bet("half", 640), Some(320));
        assert_eq!(bet("25%", 640), Some(160));
        assert_eq!(bet("0", 640), None);
        assert_eq!(bet("-5", 640), None);
        assert_eq!(bet("all", 0), None);
        assert_eq!(bet("abc", 10), None);
        assert_eq!(bet("150%", 10), None);
    }

    #[test]
    fn limits() {
        let s = GameSettings {
            max_bet: 500,
            ..GameSettings::default()
        };
        assert!(s.check(100, 1000, "a", "points").is_ok());
        assert!(s.check(5, 1000, "a", "points").is_err());
        assert!(s.check(600, 1000, "a", "points").is_err());
        assert!(s.check(100, 50, "a", "points").is_err());
        assert!(s.check(100, 0, "a", "points").is_err());
    }

    #[test]
    fn gamble_rolls() {
        assert_eq!(gamble(55, 100, "a", "p").0, -100);
        assert_eq!(gamble(56, 100, "a", "p").0, 100);
        assert_eq!(gamble(100, 100, "a", "p").0, 300);
        assert_eq!(gamble(1, 100, "a", "p").1, "a rolled 1 and lost 100 p.");
    }

    #[test]
    fn roulette_pays() {
        assert_eq!(roulette(1, Pick::Red, 10, "a", "p").0, 10);
        assert_eq!(roulette(2, Pick::Red, 10, "a", "p").0, -10);
        assert_eq!(roulette(0, Pick::Even, 10, "a", "p").0, -10);
        assert_eq!(roulette(17, Pick::Number(17), 10, "a", "p").0, 350);
        assert_eq!(
            roulette(0, Pick::parse("green").unwrap(), 10, "a", "p").0,
            350
        );
        assert_eq!(Pick::parse("37"), None);
    }

    #[test]
    fn slots_pay() {
        assert_eq!(slots([0, 0, 0], 100, "a", "p").0, 900);
        assert_eq!(slots([5, 5, 5], 100, "a", "p").0, 1900);
        assert_eq!(slots([1, 1, 2], 100, "a", "p").0, 50);
        assert_eq!(slots([0, 1, 2], 100, "a", "p").0, -100);
    }

    fn shoe(cards: &[u8]) -> impl FnMut() -> u8 + '_ {
        let mut i = 0;
        move || {
            let c = cards[i % cards.len()];
            i += 1;
            c
        }
    }

    #[test]
    fn blackjack_plays() {
        assert_eq!(total(&[1, 13]), 21);
        assert_eq!(total(&[1, 1, 9]), 21);
        assert_eq!(total(&[10, 6, 1]), 17);
        // Player A K against dealer 9 7: blackjack pays 3 to 2.
        let mut d = shoe(&[1, 13, 9, 7]);
        match deal(100, 0, &mut d, "a", "p") {
            Play::Done { back, .. } => assert_eq!(back, 250),
            other => panic!("{other:?}"),
        }
        // Player 10 6 against dealer 9 8, hits a 10 and busts.
        let mut d = shoe(&[10, 6, 9, 8, 10]);
        let Play::Going(hand, _) = deal(100, 0, &mut d, "a", "p") else {
            panic!()
        };
        assert!(matches!(
            hit(hand.clone(), &mut d, "a", "p"),
            Play::Done { back: 0, .. }
        ));
        // Standing on 16 against 17 loses; dealer drawing past 21 wins.
        let mut none = shoe(&[2]);
        assert!(matches!(
            stand(hand.clone(), &mut none, "a", "p"),
            Play::Done { back: 0, .. }
        ));
        let soft = Hand {
            dealer: vec![10, 6],
            ..hand
        };
        let mut ten = shoe(&[10]);
        assert!(matches!(
            stand(soft, &mut ten, "a", "p"),
            Play::Done { back: 200, .. }
        ));
    }
}

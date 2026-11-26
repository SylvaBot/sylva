//! Points games in chat: !gamble, !roulette, !slots, !blackjack and !duel.
//!
//! Everything here is pure: the Durable Object passes in the random numbers
//! and the viewer's balance, and gets back the change in points and the line
//! to post. That keeps the odds testable.

use serde::{Deserialize, Serialize};

use crate::bot::UserLevel;
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
    /// The smallest bet, for a game without its own.
    pub min_bet: u32,
    /// The largest bet, or 0 for no limit besides the viewer's own points,
    /// for a game without its own.
    pub max_bet: u32,
    /// Seconds a viewer waits between games, for a game without its own.
    pub cooldown: u32,
    /// Who may play each game, and its own bets and cooldown.
    pub rules: GameRules,
    /// What each game pays.
    pub odds: Odds,
}

/// One game's own limits. A missing number falls back to the shared one
/// above, which is how settings saved before these existed keep working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameRule {
    pub level: UserLevel,
    /// Seconds before the same viewer may play again.
    pub cooldown: Option<u32>,
    /// Seconds before anyone may start this game again.
    pub global_cooldown: u32,
    pub min_bet: Option<u32>,
    /// 0 for no limit.
    pub max_bet: Option<u32>,
}

impl Default for GameRule {
    fn default() -> Self {
        GameRule {
            level: UserLevel::Everyone,
            cooldown: None,
            global_cooldown: 0,
            min_bet: None,
            max_bet: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GameRules {
    pub gamble: GameRule,
    pub roulette: GameRule,
    pub slots: GameRule,
    pub blackjack: GameRule,
    pub duel: GameRule,
}

/// Payouts as the percent of the bet that comes back, so 200 doubles it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Odds {
    /// The lowest roll of 1 to 100 that wins `!gamble`.
    pub gamble_win_at: u32,
    pub gamble_win: u32,
    /// A roll of 100.
    pub gamble_jackpot: u32,
    /// Red, black, even or odd.
    pub roulette_color: u32,
    pub roulette_number: u32,
    pub slots_pair: u32,
    pub slots_triple: u32,
    /// Three 💎.
    pub slots_jackpot: u32,
    /// A blackjack on the first two cards.
    pub blackjack_natural: u32,
    /// Seconds a challenged viewer has to answer a duel.
    pub duel_wait: u32,
}

impl Default for Odds {
    fn default() -> Self {
        Odds {
            gamble_win_at: 56,
            gamble_win: 200,
            gamble_jackpot: 400,
            roulette_color: 200,
            roulette_number: 3600,
            slots_pair: 150,
            slots_triple: 1000,
            slots_jackpot: 2000,
            blackjack_natural: 250,
            duel_wait: 120,
        }
    }
}

impl Odds {
    fn validated(mut self) -> Odds {
        self.gamble_win_at = self.gamble_win_at.clamp(2, 100);
        for (v, lo, hi) in [
            (&mut self.gamble_win, 101, 1_000),
            (&mut self.gamble_jackpot, 101, 100_000),
            (&mut self.roulette_color, 101, 1_000),
            (&mut self.roulette_number, 101, 10_000),
            (&mut self.slots_pair, 0, 1_000),
            (&mut self.slots_triple, 101, 100_000),
            (&mut self.slots_jackpot, 101, 100_000),
            (&mut self.blackjack_natural, 101, 1_000),
            (&mut self.duel_wait, 15, 600),
        ] {
            *v = (*v).clamp(lo, hi);
        }
        self
    }
}

/// One game's limits with the shared ones filled in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub level: UserLevel,
    pub cooldown: u32,
    pub global_cooldown: u32,
    pub min_bet: u32,
    pub max_bet: u32,
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
            rules: GameRules::default(),
            odds: Odds::default(),
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
        for r in [
            &mut self.rules.gamble,
            &mut self.rules.roulette,
            &mut self.rules.slots,
            &mut self.rules.blackjack,
            &mut self.rules.duel,
        ] {
            r.cooldown = r.cooldown.map(|c| c.min(3600));
            r.global_cooldown = r.global_cooldown.min(3600);
            r.min_bet = r.min_bet.map(|b| b.clamp(1, MAX_BET as u32));
            r.max_bet = r.max_bet.map(|b| b.min(MAX_BET as u32));
            if let (Some(lo), Some(hi)) = (r.min_bet, r.max_bet) {
                if hi != 0 && hi < lo {
                    r.max_bet = Some(lo);
                }
            }
        }
        self.odds = self.odds.validated();
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

    /// A game's limits, with the shared ones where it has none of its own.
    pub fn limits(&self, game: Game) -> Limits {
        let r = match game {
            Game::Gamble => &self.rules.gamble,
            Game::Roulette => &self.rules.roulette,
            Game::Slots => &self.rules.slots,
            Game::Blackjack => &self.rules.blackjack,
            Game::Duel => &self.rules.duel,
        };
        let min_bet = r.min_bet.unwrap_or(self.min_bet);
        let max_bet = r.max_bet.unwrap_or(self.max_bet);
        Limits {
            level: r.level,
            cooldown: r.cooldown.unwrap_or(self.cooldown),
            global_cooldown: r.global_cooldown,
            min_bet,
            max_bet: if max_bet != 0 {
                max_bet.max(min_bet)
            } else {
                0
            },
        }
    }

    /// Check a bet against the limits, as the line to post when it fails.
    pub fn check(
        &self,
        game: Game,
        bet: i64,
        balance: i64,
        user: &str,
        name: &str,
    ) -> Result<(), String> {
        let Limits {
            min_bet, max_bet, ..
        } = self.limits(game);
        if balance <= 0 {
            return Err(format!("{user}, you have no {name} yet."));
        }
        if bet > balance {
            return Err(format!(
                "{user}, you only have {} {name}.",
                grouped(balance)
            ));
        }
        if bet < i64::from(min_bet) {
            return Err(format!(
                "{user}, the smallest bet is {} {name}.",
                grouped(min_bet.into())
            ));
        }
        if max_bet != 0 && bet > i64::from(max_bet) {
            return Err(format!(
                "{user}, the largest bet is {} {name}.",
                grouped(max_bet.into())
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

/// The points that come back for `pct` percent of `bet`.
fn pays(bet: i64, pct: u32) -> i64 {
    bet.saturating_mul(i64::from(pct)) / 100
}

/// `!gamble`: a roll of 1 to 100. By default 56 or more doubles the bet,
/// and 100 pays four times.
pub fn gamble(roll: u32, bet: i64, odds: &Odds, user: &str, name: &str) -> (i64, String) {
    let (net, how) = if roll >= 100 {
        (
            pays(bet, odds.gamble_jackpot) - bet,
            "hit the jackpot and won",
        )
    } else if roll >= odds.gamble_win_at {
        (pays(bet, odds.gamble_win) - bet, "won")
    } else {
        (-bet, "lost")
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
pub fn roulette(
    spin: u32,
    pick: Pick,
    bet: i64,
    odds: &Odds,
    user: &str,
    name: &str,
) -> (i64, String) {
    let (c, n) = (odds.roulette_color, odds.roulette_number);
    let won = match pick {
        Pick::Red => (color(spin) == "red").then_some(c),
        Pick::Black => (color(spin) == "black").then_some(c),
        Pick::Even => (spin != 0 && spin.is_multiple_of(2)).then_some(c),
        Pick::Odd => (spin % 2 == 1).then_some(c),
        Pick::Number(x) => (x == spin).then_some(n),
    };
    let net = won.map_or(-bet, |pct| pays(bet, pct) - bet);
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
pub fn slots(reels: [usize; 3], bet: i64, odds: &Odds, user: &str, name: &str) -> (i64, String) {
    let [a, b, c] = reels.map(|r| r % SYMBOLS.len());
    let back = if a == b && b == c {
        if SYMBOLS[a] == "💎" {
            pays(bet, odds.slots_jackpot)
        } else {
            pays(bet, odds.slots_triple)
        }
    } else if a == b || b == c || a == c {
        pays(bet, odds.slots_pair)
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
pub fn deal(
    bet: i64,
    now: i64,
    natural_pays: u32,
    draw: &mut dyn FnMut() -> u8,
    user: &str,
    name: &str,
) -> Play {
    let player = vec![draw(), draw()];
    let dealer = vec![draw(), draw()];
    let hand = Hand {
        bet,
        player,
        dealer,
        at: now,
    };
    if natural(&hand.player) || natural(&hand.dealer) {
        return settle(hand, natural_pays, user, name);
    }
    let line = format!(
        "{user}, you have {}. The dealer shows {}. Type !hit or !stand.",
        show(&hand.player),
        card(hand.dealer[0])
    );
    Play::Going(hand, line)
}

/// `!hit`: one more card.
pub fn hit(
    mut hand: Hand,
    natural_pays: u32,
    draw: &mut dyn FnMut() -> u8,
    user: &str,
    name: &str,
) -> Play {
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
        return stand(hand, natural_pays, draw, user, name);
    }
    let line = format!(
        "{user}, you have {}. The dealer shows {}. Type !hit or !stand.",
        show(&hand.player),
        card(hand.dealer[0])
    );
    Play::Going(hand, line)
}

/// `!stand`: the dealer draws to 17, then the hands are compared.
pub fn stand(
    mut hand: Hand,
    natural_pays: u32,
    draw: &mut dyn FnMut() -> u8,
    user: &str,
    name: &str,
) -> Play {
    while total(&hand.dealer) < 17 {
        hand.dealer.push(draw());
    }
    settle(hand, natural_pays, user, name)
}

fn settle(hand: Hand, natural_pays: u32, user: &str, name: &str) -> Play {
    let (p, d) = (total(&hand.player), total(&hand.dealer));
    let bet = hand.bet;
    let (back, how) = if natural(&hand.player) && natural(&hand.dealer) {
        (bet, "Both have blackjack, a push.".to_string())
    } else if natural(&hand.player) {
        let back = pays(bet, natural_pays);
        let won = back - bet;
        (
            back,
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

/// `!raffle`, as StreamElements runs it: a moderator starts it with an
/// amount, viewers type `!join`, and one of them wins points that Sylva
/// creates (nobody pays in).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RaffleSettings {
    pub enabled: bool,
    /// Seconds the raffle stays open.
    pub duration: u32,
    /// The most points one raffle may give.
    pub max_amount: u32,
    pub start: String,
    pub running: String,
    pub end: String,
}

pub const RAFFLE_MIN_S: u32 = 10;
pub const RAFFLE_MAX_S: u32 = 3600;
pub const MAX_RAFFLE_MESSAGE: usize = 300;

impl Default for RaffleSettings {
    fn default() -> Self {
        RaffleSettings {
            enabled: true,
            duration: 30,
            max_amount: 3000,
            start: "A raffle has begun for {points} {pointsname}! It ends in {time} seconds. Type !join to enter".into(),
            running: "The raffle for {points} {pointsname} ends in {time} seconds. Type !join to enter".into(),
            end: "The raffle has ended and {winner} won {points} {pointsname}".into(),
        }
    }
}

impl RaffleSettings {
    pub fn validated(mut self) -> Result<RaffleSettings, crate::alerts::Invalid> {
        self.duration = self.duration.clamp(RAFFLE_MIN_S, RAFFLE_MAX_S);
        self.max_amount = self.max_amount.clamp(1, MAX_BET as u32);
        let d = RaffleSettings::default();
        for (msg, fallback) in [
            (&mut self.start, d.start),
            (&mut self.running, d.running),
            (&mut self.end, d.end),
        ] {
            let t = msg.trim().to_string();
            if t.chars().count() > MAX_RAFFLE_MESSAGE {
                return Err(crate::alerts::Invalid(format!(
                    "Raffle messages can be up to {MAX_RAFFLE_MESSAGE} characters"
                )));
            }
            *msg = if t.is_empty() { fallback } else { t };
        }
        Ok(self)
    }
}

/// A raffle that is open now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Raffle {
    pub amount: i64,
    pub started_at: i64,
    pub ends_at: i64,
    /// Whether the running message went out.
    pub reminded: bool,
}

impl Raffle {
    /// When the running message goes out: halfway, for raffles of 20
    /// seconds or more.
    pub fn remind_at(&self) -> Option<i64> {
        let half = (self.ends_at - self.started_at) / 2;
        (!self.reminded && half >= 10_000).then_some(self.started_at + half)
    }

    pub fn next_at(&self) -> i64 {
        self.remind_at().unwrap_or(self.ends_at)
    }
}

/// A raffle message with its variables filled in.
pub fn raffle_line(template: &str, points: i64, name: &str, secs: i64, winner: &str) -> String {
    template
        .replace("{points}", &grouped(points))
        .replace("{pointsname}", name)
        .replace("{time}", &secs.max(0).to_string())
        .replace("{winner}", winner)
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
    fn raffles() {
        let s = RaffleSettings {
            duration: 1,
            start: "  ".into(),
            ..RaffleSettings::default()
        }
        .validated()
        .unwrap();
        assert_eq!(s.duration, RAFFLE_MIN_S);
        assert_eq!(s.start, RaffleSettings::default().start);
        assert_eq!(
            raffle_line(&RaffleSettings::default().end, 3000, "leaves", 0, "Maple"),
            "The raffle has ended and Maple won 3,000 leaves"
        );
        let r = Raffle {
            amount: 1,
            started_at: 0,
            ends_at: 30_000,
            reminded: false,
        };
        assert_eq!(r.next_at(), 15_000);
        let short = Raffle {
            ends_at: 10_000,
            ..r.clone()
        };
        assert_eq!(short.next_at(), 10_000);
        assert_eq!(
            Raffle {
                reminded: true,
                ..r
            }
            .next_at(),
            30_000
        );
    }

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
        assert!(s.check(Game::Gamble, 100, 1000, "a", "points").is_ok());
        assert!(s.check(Game::Gamble, 5, 1000, "a", "points").is_err());
        assert!(s.check(Game::Gamble, 600, 1000, "a", "points").is_err());
        assert!(s.check(Game::Gamble, 100, 50, "a", "points").is_err());
        assert!(s.check(Game::Gamble, 100, 0, "a", "points").is_err());
    }

    #[test]
    fn gamble_rolls() {
        assert_eq!(gamble(55, 100, &Odds::default(), "a", "p").0, -100);
        assert_eq!(gamble(56, 100, &Odds::default(), "a", "p").0, 100);
        assert_eq!(gamble(100, 100, &Odds::default(), "a", "p").0, 300);
        assert_eq!(
            gamble(1, 100, &Odds::default(), "a", "p").1,
            "a rolled 1 and lost 100 p."
        );
    }

    #[test]
    fn roulette_pays() {
        assert_eq!(roulette(1, Pick::Red, 10, &Odds::default(), "a", "p").0, 10);
        assert_eq!(
            roulette(2, Pick::Red, 10, &Odds::default(), "a", "p").0,
            -10
        );
        assert_eq!(
            roulette(0, Pick::Even, 10, &Odds::default(), "a", "p").0,
            -10
        );
        assert_eq!(
            roulette(17, Pick::Number(17), 10, &Odds::default(), "a", "p").0,
            350
        );
        assert_eq!(
            roulette(
                0,
                Pick::parse("green").unwrap(),
                10,
                &Odds::default(),
                "a",
                "p"
            )
            .0,
            350
        );
        assert_eq!(Pick::parse("37"), None);
    }

    #[test]
    fn slots_pay() {
        assert_eq!(slots([0, 0, 0], 100, &Odds::default(), "a", "p").0, 900);
        assert_eq!(slots([5, 5, 5], 100, &Odds::default(), "a", "p").0, 1900);
        assert_eq!(slots([1, 1, 2], 100, &Odds::default(), "a", "p").0, 50);
        assert_eq!(slots([0, 1, 2], 100, &Odds::default(), "a", "p").0, -100);
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
        match deal(100, 0, 250, &mut d, "a", "p") {
            Play::Done { back, .. } => assert_eq!(back, 250),
            other => panic!("{other:?}"),
        }
        // Player 10 6 against dealer 9 8, hits a 10 and busts.
        let mut d = shoe(&[10, 6, 9, 8, 10]);
        let Play::Going(hand, _) = deal(100, 0, 250, &mut d, "a", "p") else {
            panic!()
        };
        assert!(matches!(
            hit(hand.clone(), 250, &mut d, "a", "p"),
            Play::Done { back: 0, .. }
        ));
        // Standing on 16 against 17 loses; dealer drawing past 21 wins.
        let mut none = shoe(&[2]);
        assert!(matches!(
            stand(hand.clone(), 250, &mut none, "a", "p"),
            Play::Done { back: 0, .. }
        ));
        let soft = Hand {
            dealer: vec![10, 6],
            ..hand
        };
        let mut ten = shoe(&[10]);
        assert!(matches!(
            stand(soft, 250, &mut ten, "a", "p"),
            Play::Done { back: 200, .. }
        ));
    }

    #[test]
    fn custom_odds_and_limits() {
        let odds = Odds {
            gamble_win_at: 90,
            gamble_win: 300,
            ..Odds::default()
        };
        assert_eq!(gamble(89, 100, &odds, "a", "p").0, -100);
        assert_eq!(gamble(90, 100, &odds, "a", "p").0, 200);
        let mut s = GameSettings::default();
        s.rules.slots.min_bet = Some(500);
        s.rules.slots.cooldown = Some(5);
        assert!(s.check(Game::Slots, 100, 1000, "a", "p").is_err());
        assert!(s.check(Game::Gamble, 100, 1000, "a", "p").is_ok());
        assert_eq!(s.limits(Game::Slots).cooldown, 5);
        assert_eq!(s.limits(Game::Gamble).cooldown, 30);
        let old: GameSettings = serde_json::from_str(r#"{"minBet":20,"cooldown":10}"#).unwrap();
        assert_eq!(old.limits(Game::Duel).min_bet, 20);
        assert_eq!(old.odds, Odds::default());
    }
}

//! Points games in chat: !gamble, !roulette, !slots, !blackjack (with
//! !hit and !stand) and !duel (with !accept and !deny). The odds and the
//! lines live in `sylva_core::games`; this file keeps the balances, the open
//! blackjack hands and the waiting duels.

use sylva_core::games::{
    bet, deal, gamble, hit, roulette, slots, stand, Challenge, Game, Hand, Pick, Play, ANSWER_MS,
    SYMBOLS,
};
use sylva_core::loyalty::{grouped, LoyaltySettings};
use sylva_core::Actor;
use worker::*;

use crate::channel::ChannelDo;
use crate::community::Ask;
use crate::util::random_bytes;

/// A random number below `n`.
fn below(n: u32) -> Result<u32> {
    let b = random_bytes::<8>()?;
    Ok((u64::from_le_bytes(b) % u64::from(n.max(1))) as u32)
}

/// Enough random cards for any blackjack hand.
fn shoe() -> Result<Vec<u8>> {
    (0..24).map(|_| Ok(1 + below(13)? as u8)).collect()
}

fn drawer(cards: Vec<u8>) -> impl FnMut() -> u8 {
    let mut i = 0;
    move || {
        let c = cards[i % cards.len()];
        i += 1;
        c
    }
}

const STARTS: [&str; 6] = ["gamble", "roulette", "slots", "blackjack", "bj", "duel"];

impl ChannelDo {
    fn clear_config(&self, key: &str) -> Result<()> {
        self.sql
            .exec("DELETE FROM config WHERE key = ?", vec![key.into()])?;
        Ok(())
    }

    fn stored<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        Ok(self
            .config(key)?
            .and_then(|v| serde_json::from_str(&v).ok()))
    }

    /// The answer to a points game, if `trigger` is one that is on. `who`
    /// is the viewer playing (`None` in the test chat, which saves nothing).
    pub(crate) async fn game_reply(
        &self,
        trigger: &str,
        args: &[String],
        ask: &Ask<'_>,
        who: Option<&Actor>,
        user: &str,
    ) -> Result<Option<String>> {
        let s = self.loyalty_settings()?;
        let Some(game) = Game::of(trigger) else {
            return Ok(None);
        };
        if !s.enabled || !s.games.on(game) {
            return Ok(None);
        }
        let Ask { now, dry, .. } = *ask;
        if !dry && who.is_none() {
            return Ok(None);
        }
        let id = who.map_or("test", |w| w.id.as_str());
        let starts = STARTS.contains(&trigger);
        if starts && !dry {
            let key = format!("g:{}:{id}", game.key());
            let wait = i64::from(s.games.cooldown) * 1000;
            if self.last_used(&key)?.is_some_and(|l| now - l < wait) {
                return Ok(None);
            }
            self.mark_used(&key, now)?;
        }
        let balance = match who {
            Some(w) => self.viewer(&w.id)?.map_or(0, |v| v.balance),
            // The test chat plays with what the streamer has, or 1,000.
            None => self
                .viewer_by_login(&user.to_lowercase())?
                .map_or(0, |v| v.balance)
                .max(1000),
        };
        let name = s.name.as_str();
        let usage = |how: &str| Ok(Some(format!("{user}, try {how}.")));
        match trigger {
            "gamble" | "slots" => {
                let Some(b) = args.first().and_then(|a| bet(a, balance)) else {
                    return usage(&format!("!{trigger} 100 or !{trigger} all"));
                };
                if let Err(line) = s.games.check(b, balance, user, name) {
                    return Ok(Some(line));
                }
                let (net, line) = if trigger == "gamble" {
                    gamble(1 + below(100)?, b, user, name)
                } else {
                    let n = SYMBOLS.len() as u32;
                    let reels = [below(n)?, below(n)?, below(n)?].map(|r| r as usize);
                    slots(reels, b, user, name)
                };
                if let (false, Some(w)) = (dry, who) {
                    let why = if trigger == "gamble" {
                        "Gamble"
                    } else {
                        "Slots"
                    };
                    self.credit(w, net, why, now)?;
                }
                Ok(Some(line))
            }
            "roulette" => {
                let (amount, pick) = match args {
                    [] => return usage("!roulette 100 red, or black, even, odd, green or 0 to 36"),
                    [a] => (a, Some(Pick::Red)),
                    [a, b, ..] => match Pick::parse(a) {
                        Some(p) if a.parse::<u32>().is_err() => (b, Some(p)),
                        _ => (a, Pick::parse(b)),
                    },
                };
                let (Some(b), Some(pick)) = (bet(amount, balance), pick) else {
                    return usage("!roulette 100 red, or black, even, odd, green or 0 to 36");
                };
                if let Err(line) = s.games.check(b, balance, user, name) {
                    return Ok(Some(line));
                }
                let (net, line) = roulette(below(37)?, pick, b, user, name);
                if let (false, Some(w)) = (dry, who) {
                    self.credit(w, net, "Roulette", now)?;
                }
                Ok(Some(line))
            }
            "blackjack" | "bj" | "hit" | "stand" => {
                self.blackjack(trigger, args, &s, who, user, balance, now, dry)
            }
            _ => {
                self.duel(trigger, args, &s, who, user, balance, now, dry)
                    .await
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn blackjack(
        &self,
        trigger: &str,
        args: &[String],
        s: &LoyaltySettings,
        who: Option<&Actor>,
        user: &str,
        balance: i64,
        now: i64,
        dry: bool,
    ) -> Result<Option<String>> {
        let name = s.name.as_str();
        let key = format!("bj:{}", who.map_or("test", |w| w.id.as_str()));
        let open: Option<Hand> = if dry { None } else { self.stored(&key)? };
        let mut draw = drawer(shoe()?);
        let finish = |play: Play| -> Result<Option<String>> {
            match play {
                Play::Going(hand, line) => {
                    if !dry {
                        self.set_config(&key, &serde_json::to_string(&hand)?)?;
                    }
                    Ok(Some(line))
                }
                Play::Done { back, line } => {
                    if let (false, Some(w)) = (dry, who) {
                        self.clear_config(&key)?;
                        if back > 0 {
                            self.credit(w, back, "Blackjack", now)?;
                        }
                    }
                    Ok(Some(line))
                }
            }
        };
        if let Some(hand) = open {
            if now - hand.at > ANSWER_MS {
                // A hand left too long stands where it is.
                return finish(stand(hand, &mut draw, user, name));
            }
            return finish(match trigger {
                "hit" => hit(hand, &mut draw, user, name),
                "stand" => stand(hand, &mut draw, user, name),
                _ => {
                    return Ok(Some(format!(
                        "{user}, you are still playing a hand. Type !hit or !stand."
                    )))
                }
            });
        }
        if trigger == "hit" || trigger == "stand" {
            return Ok(None);
        }
        let Some(b) = args.first().and_then(|a| bet(a, balance)) else {
            return Ok(Some(format!("{user}, try !blackjack 100.")));
        };
        if let Err(line) = s.games.check(b, balance, user, name) {
            return Ok(Some(line));
        }
        if let (false, Some(w)) = (dry, who) {
            self.credit(w, -b, "Blackjack bet", now)?;
        }
        finish(deal(b, now, &mut draw, user, name))
    }

    #[allow(clippy::too_many_arguments)]
    async fn duel(
        &self,
        trigger: &str,
        args: &[String],
        s: &LoyaltySettings,
        who: Option<&Actor>,
        user: &str,
        balance: i64,
        now: i64,
        dry: bool,
    ) -> Result<Option<String>> {
        let name = s.name.as_str();
        let me = who.map_or_else(|| user.to_lowercase(), |w| w.login.clone());
        if trigger == "duel" {
            let target = args.first().and_then(|a| sylva_core::loyalty::login_arg(a));
            let amount = args.get(1).and_then(|a| bet(a, balance));
            let (Some(target), Some(b)) = (target, amount) else {
                return Ok(Some(format!("{user}, try !duel @name 100.")));
            };
            if target == me {
                return Ok(None);
            }
            if let Err(line) = s.games.check(b, balance, user, name) {
                return Ok(Some(line));
            }
            let line = format!(
                "{user} challenges {target} to a duel for {} {name}. {target}, type !accept or !deny within 2 minutes.",
                grouped(b)
            );
            let (false, Some(w)) = (dry, who) else {
                return Ok(Some(line));
            };
            let key = format!("duel:{target}");
            if let Some(c) = self.stored::<Challenge>(&key)? {
                if now - c.at <= ANSWER_MS {
                    return Ok(Some(format!("{target} already has a duel waiting.")));
                }
            }
            let c = Challenge {
                from_id: w.id.clone(),
                from_login: w.login.clone(),
                from_name: w.display_name.clone(),
                bet: b,
                at: now,
            };
            self.set_config(&key, &serde_json::to_string(&c)?)?;
            return Ok(Some(line));
        }
        let key = format!("duel:{me}");
        let (false, Some(w)) = (dry, who) else {
            return Ok(None);
        };
        let Some(c) = self.stored::<Challenge>(&key)? else {
            return Ok(None);
        };
        self.clear_config(&key)?;
        if now - c.at > ANSWER_MS {
            return Ok(None);
        }
        if trigger == "deny" {
            return Ok(Some(format!(
                "{user} turned down the duel with {}.",
                c.from_name
            )));
        }
        let theirs = self.viewer(&c.from_id)?.map_or(0, |v| v.balance);
        if balance < c.bet {
            return Ok(Some(format!(
                "{user}, you need {} {name} for this duel.",
                grouped(c.bet)
            )));
        }
        if theirs < c.bet {
            return Ok(Some(format!(
                "{} no longer has {} {name}, so the duel is off.",
                c.from_name,
                grouped(c.bet)
            )));
        }
        let them = Actor {
            id: c.from_id,
            login: c.from_login,
            display_name: c.from_name,
        };
        let (winner, loser) = if below(2)? == 0 {
            (w, &them)
        } else {
            (&them, w)
        };
        self.credit(
            loser,
            -c.bet,
            &format!("Lost a duel to {}", winner.display_name),
            now,
        )?;
        self.credit(
            winner,
            c.bet,
            &format!("Won a duel against {}", loser.display_name),
            now,
        )?;
        Ok(Some(format!(
            "{} wins the duel against {} and takes {} {name}!",
            winner.display_name,
            loser.display_name,
            grouped(c.bet)
        )))
    }
}

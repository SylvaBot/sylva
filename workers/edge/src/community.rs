//! Counters and quotes in the channel's Durable Object (see
//! `sylva_core::community`): answering `!deaths`, `!quote` and friends in
//! chat and in the test chat, and the dashboard's quote list.

use serde::{Deserialize, Serialize};
use sylva_core::alerts::Invalid;
use sylva_core::bot::{BotSettings, UserLevel};
use sylva_core::community::{
    clean_quote, counter_action, quote_line, quote_lookup, CounterAction, Quote, QuoteLookup,
    MAX_QUOTES,
};
use worker::*;

use crate::channel::ChannelDo;

/// `!quote` and showing a counter wait this long between uses, except for
/// moderators, so a viewer cannot flood chat with them.
const SHOW_COOLDOWN_MS: i64 = 5_000;

#[derive(Deserialize)]
struct QuoteRow {
    id: f64,
    text: String,
    said_by: String,
    game: String,
    at: f64,
}

impl From<QuoteRow> for Quote {
    fn from(r: QuoteRow) -> Quote {
        Quote {
            id: r.id as i64,
            text: r.text,
            by: r.said_by,
            game: r.game,
            at: r.at as i64,
        }
    }
}

#[derive(Deserialize)]
struct CountRow {
    n: f64,
}

#[derive(Deserialize)]
struct MaybeText {
    value: Option<String>,
}

/// A quote from the dashboard. `id` is only for putting back a deleted
/// quote under its old number (Undo).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteInput {
    pub text: String,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub game: String,
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub at: Option<i64>,
}

#[derive(Serialize)]
pub struct QuoteList {
    pub quotes: Vec<Quote>,
}

/// Who asks, and how: `dry` saves nothing (the test chat).
#[derive(Clone, Copy)]
pub(crate) struct Ask<'a> {
    pub level: UserLevel,
    /// The streamer's name, for quotes without a speaker.
    pub channel: &'a str,
    pub now: i64,
    pub dry: bool,
}

impl ChannelDo {
    pub(crate) fn quotes(&self) -> Result<Vec<Quote>> {
        Ok(self
            .sql
            .exec(
                "SELECT id, text, said_by, game, at FROM quotes ORDER BY id",
                None,
            )?
            .to_array::<QuoteRow>()?
            .into_iter()
            .map(Quote::from)
            .collect())
    }

    fn quote(&self, id: i64) -> Result<Option<Quote>> {
        Ok(self
            .sql
            .exec(
                "SELECT id, text, said_by, game, at FROM quotes WHERE id = ?",
                vec![id.into()],
            )?
            .to_array::<QuoteRow>()?
            .into_iter()
            .next()
            .map(Quote::from))
    }

    fn quote_count(&self) -> Result<usize> {
        Ok(self
            .sql
            .exec("SELECT COUNT(*) AS n FROM quotes", None)?
            .to_array::<CountRow>()?
            .first()
            .map_or(0, |r| r.n as usize))
    }

    /// The next quote number. Numbers are never reused, even after a delete.
    fn next_quote_id(&self) -> Result<i64> {
        let stored = self
            .config("quote_next")?
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(1);
        let max = self
            .sql
            .exec("SELECT MAX(id) AS value FROM quotes", None)?
            .to_array::<CountRowOpt>()?
            .first()
            .and_then(|r| r.value)
            .map_or(0, |v| v as i64);
        Ok(stored.max(max + 1))
    }

    /// What is being played, from the newest channel update Twitch sent.
    fn current_game(&self) -> Result<String> {
        Ok(self
            .sql
            .exec(
                "SELECT json_extract(body, '$.raw.category_name') AS value FROM events
                 WHERE kind = 'other' AND json_extract(body, '$.rawType') = 'channel.update'
                 ORDER BY seq DESC LIMIT 1",
                None,
            )?
            .to_array::<MaybeText>()?
            .into_iter()
            .next()
            .and_then(|r| r.value)
            .unwrap_or_default())
    }

    /// Add a quote. `Err` holds words for the person adding it.
    pub(crate) fn add_quote(
        &self,
        input: QuoteInput,
    ) -> Result<std::result::Result<Quote, String>> {
        let (text, by, game) = match clean_quote(&input.text, &input.by, &input.game) {
            Ok(v) => v,
            Err(Invalid(m)) => return Ok(Err(m)),
        };
        if self.quote_count()? >= MAX_QUOTES {
            return Ok(Err(format!(
                "This channel has {MAX_QUOTES} quotes, the most it can keep. Remove some first."
            )));
        }
        let next = self.next_quote_id()?;
        // Undo puts a quote back under its old number, if that is still free.
        let id = match input.id {
            Some(id) if id > 0 && id < next && self.quote(id)?.is_none() => id,
            _ => next,
        };
        let at = input
            .at
            .filter(|a| *a > 0)
            .unwrap_or_else(|| Date::now().as_millis() as i64);
        self.sql.exec(
            "INSERT INTO quotes (id, text, said_by, game, at) VALUES (?, ?, ?, ?, ?)",
            vec![
                id.into(),
                text.clone().into(),
                by.clone().into(),
                game.clone().into(),
                at.into(),
            ],
        )?;
        if id == next {
            self.set_config("quote_next", &(next + 1).to_string())?;
        }
        Ok(Ok(Quote {
            id,
            text,
            by,
            game,
            at,
        }))
    }

    pub(crate) fn edit_quote(
        &self,
        id: i64,
        input: QuoteInput,
    ) -> Result<std::result::Result<Quote, (u16, String)>> {
        let Some(old) = self.quote(id)? else {
            return Ok(Err((404, format!("There is no quote #{id}"))));
        };
        let (text, by, game) = match clean_quote(&input.text, &input.by, &input.game) {
            Ok(v) => v,
            Err(Invalid(m)) => return Ok(Err((400, m))),
        };
        self.sql.exec(
            "UPDATE quotes SET text = ?, said_by = ?, game = ? WHERE id = ?",
            vec![
                text.clone().into(),
                by.clone().into(),
                game.clone().into(),
                id.into(),
            ],
        )?;
        Ok(Ok(Quote {
            text,
            by,
            game,
            ..old
        }))
    }

    pub(crate) fn delete_quote(&self, id: i64) -> Result<Option<Quote>> {
        let old = self.quote(id)?;
        if old.is_some() {
            // Remember the number so it is never handed out again.
            let next = self.next_quote_id()?;
            self.set_config("quote_next", &next.to_string())?;
            self.sql
                .exec("DELETE FROM quotes WHERE id = ?", vec![id.into()])?;
        }
        Ok(old)
    }

    /// Set a counter from the dashboard.
    pub(crate) fn set_counter(&self, name: &str, value: i64) -> Result<bool> {
        let mut settings = self.bot_settings()?;
        let Some(c) = settings.counters.iter_mut().find(|c| c.name == name) else {
            return Ok(false);
        };
        c.apply(CounterAction::Set(value));
        self.save_bot_settings(&settings)?;
        Ok(true)
    }

    fn cooled(&self, key: &str, level: UserLevel, now: i64, dry: bool) -> Result<bool> {
        if dry || level >= UserLevel::Moderator {
            return Ok(true);
        }
        let last = self.last_used(key)?;
        if last.is_some_and(|l| now - l < SHOW_COOLDOWN_MS) {
            return Ok(false);
        }
        self.mark_used(key, now)?;
        Ok(true)
    }

    /// The answer to a counter or quote command, if `trigger` is one. With
    /// `dry`, nothing is saved (the test chat).
    pub(crate) fn community_reply(
        &self,
        settings: &mut BotSettings,
        trigger: &str,
        args: &[String],
        ask: &Ask,
    ) -> Result<Option<String>> {
        let Ask {
            level,
            channel,
            now,
            dry,
        } = *ask;
        if let Some(i) = settings.counter(trigger) {
            let mut action = counter_action(args);
            if level < UserLevel::Moderator {
                action = CounterAction::Show;
            }
            if action == CounterAction::Show
                && !self.cooled(&format!("k:{trigger}"), level, now, dry)?
            {
                return Ok(None);
            }
            settings.counters[i].apply(action);
            if action != CounterAction::Show && !dry {
                // Save only the new value onto what is stored now.
                self.set_counter(&settings.counters[i].name, settings.counters[i].value)?;
            }
            return Ok(Some(settings.counters[i].reply()));
        }
        if !settings.quotes.enabled {
            return Ok(None);
        }
        match trigger {
            "quote" => {
                if !self.cooled("q:quote", level, now, dry)? {
                    return Ok(None);
                }
                let all = self.quotes()?;
                if all.is_empty() {
                    return Ok(Some(
                        "No quotes yet. Moderators can add one with !addquote.".into(),
                    ));
                }
                let pick = |list: Vec<&Quote>| {
                    let i = (js_sys::Math::random() * list.len() as f64) as usize;
                    list.get(i.min(list.len().saturating_sub(1)))
                        .map(|q| quote_line(q, channel))
                };
                Ok(Some(match quote_lookup(args) {
                    QuoteLookup::Random => pick(all.iter().collect()).unwrap_or_default(),
                    QuoteLookup::Number(n) => all
                        .iter()
                        .find(|q| q.id == n)
                        .map(|q| quote_line(q, channel))
                        .unwrap_or_else(|| format!("There is no quote #{n}.")),
                    QuoteLookup::Search(word) => pick(
                        all.iter()
                            .filter(|q| {
                                q.text.to_lowercase().contains(&word)
                                    || q.by.to_lowercase().contains(&word)
                                    || q.game.to_lowercase().contains(&word)
                            })
                            .collect(),
                    )
                    .unwrap_or_else(|| "No quote mentions that.".into()),
                }))
            }
            "addquote" => {
                if level < settings.quotes.add_level {
                    return Ok(None);
                }
                let text = args.join(" ");
                if text.trim().is_empty() {
                    return Ok(Some(
                        "Add a quote with !addquote followed by the words.".into(),
                    ));
                }
                if dry {
                    return Ok(Some(match clean_quote(&text, "", "") {
                        Ok(_) => format!("Added quote #{}.", self.next_quote_id()?),
                        Err(Invalid(m)) => format!("{m}."),
                    }));
                }
                let game = self.current_game()?;
                Ok(Some(
                    match self.add_quote(QuoteInput {
                        text,
                        by: String::new(),
                        game,
                        id: None,
                        at: Some(now),
                    })? {
                        Ok(q) => format!("Added quote #{}.", q.id),
                        Err(m) => format!("{}.", m.trim_end_matches('.')),
                    },
                ))
            }
            "delquote" => {
                if level < settings.quotes.add_level {
                    return Ok(None);
                }
                let QuoteLookup::Number(n) = quote_lookup(args) else {
                    return Ok(Some("Remove a quote with !delquote and its number.".into()));
                };
                let exists = if dry {
                    self.quote(n)?.is_some()
                } else {
                    self.delete_quote(n)?.is_some()
                };
                Ok(Some(if exists {
                    format!("Quote #{n} removed.")
                } else {
                    format!("There is no quote #{n}.")
                }))
            }
            _ => Ok(None),
        }
    }
}

#[derive(Deserialize)]
struct CountRowOpt {
    value: Option<f64>,
}

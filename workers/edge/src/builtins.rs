//! Built-in chat commands in the channel's Durable Object (the list and
//! everything that needs no network is in `sylva_core::builtins`).
//!
//! Most read Twitch with Sylva's app token. Clips, the title, the category
//! and followers need the streamer's `commands` grant; removing messages
//! and timeouts need the `moderation` grant. A few read public services:
//! icanhazdadjoke.com, uselessfacts.jsph.pl, dictionaryapi.dev,
//! urbandictionary.com, 7tv.io, betterttv.net and frankerfacez.com.
//! `SYLVA_LOOKUP_URL` points all of those at one test server instead.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sylva_core::bot::{BotSettings, Skip, UserLevel};
use sylva_core::builtins::{
    self as core, age_words, command_edit, date_words, emote_line, filesay_lines, filesay_url,
    meaning_line, name_and_reply, nuke, parse_time, target_login, CommandEdit, Nuke, DAD_JOKES,
    EIGHT_BALL, FACTS, FILESAY_GAP_MS, FILESAY_MAX_BYTES, NUKE_MAX, NUKE_WINDOW_MS, PERMIT_S,
    VOTEKICK_TIMEOUT_S, VOTEKICK_VOTES, VOTEKICK_WINDOW_MS,
};
use sylva_core::community::{counter_action, CounterAction};
use sylva_core::event::Actor;
use worker::*;

use crate::bot::{badges, sender};
use crate::channel::ChannelDo;
use crate::community::Ask;
use crate::grants::{Permission, Token};
use crate::twitch_api::App;

/// Twitch's own limit for a stream title.
const MAX_TITLE: usize = 140;
/// How long `!emotes` keeps a list before reading it again.
const EMOTES_TTL_MS: i64 = 6 * 3_600_000;
/// How long a public service may take before the bot gives up.
const LOOKUP_TIMEOUT_MS: u32 = 5_000;

/// Who typed the command.
pub(crate) struct Chatter<'a> {
    /// `None` in the test chat.
    pub actor: Option<&'a Actor>,
    pub name: &'a str,
}

/// What a built-in command did.
pub(crate) enum Outcome {
    Reply(String),
    /// It ran and has nothing to say, such as `!vanish`.
    Quiet,
    Skip(Skip),
}

#[derive(Serialize, Deserialize)]
struct EmoteCache {
    at: i64,
    line: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Filesay {
    pub lines: Vec<String>,
    pub next: usize,
    pub at: i64,
}

#[derive(Deserialize)]
struct ChatRow {
    message_id: Option<String>,
    user_id: Option<String>,
    login: Option<String>,
    text: Option<String>,
    badges: Option<String>,
}

#[derive(Deserialize)]
struct TextRow {
    value: Option<String>,
}

#[derive(Deserialize)]
struct NumRow {
    n: f64,
}

#[derive(Deserialize)]
struct StreamRow {
    seq: f64,
    at: f64,
    raw_type: String,
}

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

impl ChannelDo {
    fn var(&self, name: &str) -> Option<String> {
        self.env
            .var(name)
            .ok()
            .map(|v| v.to_string().trim().trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
    }

    /// The address of a public service, or the test server's stand-in.
    fn lookup_url(&self, test_path: &str, real: String) -> String {
        match self.var("SYLVA_LOOKUP_URL") {
            Some(base) => format!("{base}/{test_path}"),
            None => real,
        }
    }

    /// GET a public service. `None` when it fails or is slow, so the bot can
    /// say so instead of hanging.
    async fn lookup(&self, url: &str, json_answer: bool) -> Option<(u16, String)> {
        let headers = Headers::new();
        let _ = headers.set(
            "Accept",
            if json_answer {
                "application/json"
            } else {
                "text/plain, */*"
            },
        );
        let agent = match self.config("site").ok().flatten() {
            Some(site) => format!("Sylva chat bot ({site})"),
            None => "Sylva chat bot".into(),
        };
        let _ = headers.set("User-Agent", &agent);
        let mut init = RequestInit::new();
        init.with_method(Method::Get).with_headers(headers);
        let req = Request::new_with_init(url, &init).ok()?;
        let signal = AbortSignal::from(web_sys::AbortSignal::timeout_with_u32(LOOKUP_TIMEOUT_MS));
        let mut res = Fetch::Request(req).send_with_signal(&signal).await.ok()?;
        let status = res.status_code();
        let text = res.text().await.ok()?;
        Some((status, text))
    }

    async fn lookup_json(&self, url: &str) -> Option<Value> {
        match self.lookup(url, true).await {
            Some((200, text)) => serde_json::from_str(&text).ok(),
            _ => None,
        }
    }

    fn channel_login(&self) -> Result<Option<String>> {
        self.config("channel_login")
    }

    /// Run a built-in command, if `trigger` names one that is not replaced by
    /// the streamer's own command or counter. With `ask.dry` (the test chat)
    /// nothing is changed and nothing is sent.
    pub(crate) async fn builtin_reply(
        &self,
        settings: &mut BotSettings,
        trigger: &str,
        args: &[String],
        ask: &Ask<'_>,
        who: &Chatter<'_>,
    ) -> Result<Option<Outcome>> {
        let Some((b, s)) = settings.builtin(trigger) else {
            return Ok(None);
        };
        let (b, s) = (*b, s.clone());
        let quotes_off = b.group == core::Group::Quotes && !settings.quotes.enabled;
        if !s.enabled || quotes_off {
            return Ok(Some(Outcome::Skip(Skip::Off)));
        }
        if ask.level < s.level {
            return Ok(Some(Outcome::Skip(Skip::Level)));
        }
        if !ask.dry && ask.level < UserLevel::Moderator && s.cooldown > 0 {
            let key = format!("b:{}", b.name);
            if self
                .last_used(&key)?
                .is_some_and(|t| ask.now - t < s.cooldown as i64 * 1000)
            {
                return Ok(Some(Outcome::Skip(Skip::Cooldown)));
            }
            self.mark_used(&key, ask.now)?;
        }
        let text = self.run_builtin(b.name, settings, args, ask, who).await?;
        Ok(Some(if text.is_empty() {
            Outcome::Quiet
        } else {
            Outcome::Reply(text)
        }))
    }

    async fn run_builtin(
        &self,
        name: &str,
        settings: &mut BotSettings,
        args: &[String],
        ask: &Ask<'_>,
        who: &Chatter<'_>,
    ) -> Result<String> {
        let channel = ask.channel;
        Ok(match name {
            "commands" => match (self.config("site")?, self.channel_login()?) {
                (Some(site), Some(login)) => {
                    format!("The commands for {channel} are at {site}/c/{login}")
                }
                _ => {
                    let list: Vec<String> = settings
                        .commands
                        .iter()
                        .filter(|c| c.enabled && c.level == UserLevel::Everyone)
                        .map(|c| format!("!{}", c.name))
                        .collect();
                    format!("Commands: {}", list.join(", "))
                }
            },
            "uptime" => match self.uptime_ms()? {
                Some(ms) => format!(
                    "{channel} has been live for {}.",
                    sylva_core::bot::duration_words(ms)
                ),
                None => match self.offline_since()? {
                    Some(at) => format!(
                        "{channel} is offline. The last stream ended {} ago.",
                        sylva_core::bot::duration_words(ask.now - at)
                    ),
                    None => format!("{channel} is offline right now."),
                },
            },
            "game" | "title" => match self.channel_info().await? {
                Some(v) if name == "game" => match v["game_name"].as_str().filter(|g| !g.is_empty()) {
                    Some(g) => format!("{channel} is playing {g}."),
                    None => format!("{channel} has not picked a category."),
                },
                Some(v) => match v["title"].as_str().filter(|t| !t.is_empty()) {
                    Some(t) => t.to_string(),
                    None => format!("{channel} has no title yet."),
                },
                None => "Twitch did not answer. Try again in a minute.".into(),
            },
            "gamesplayed" => self.games_played(channel)?,
            "followage" | "followsince" => self.follow(name, args, ask, who).await?,
            "accountage" | "accountsince" => self.account_age(name, args, ask, who).await?,
            "ping" => format!(
                "{} is here and listening in {channel}'s chat.",
                sender(&self.env, &self.broadcaster_id().unwrap_or_default())
                    .login
                    .unwrap_or_else(|| "Sylva".into())
            ),
            "8ball" => {
                if args.is_empty() {
                    "Ask the 8-ball a question, such as !8ball will it rain?".into()
                } else {
                    let i = (js_sys::Math::random() * EIGHT_BALL.len() as f64) as usize;
                    format!(
                        "The 8-ball says: {}",
                        EIGHT_BALL[i.min(EIGHT_BALL.len() - 1)]
                    )
                }
            }
            "dadjoke" => {
                let url = self.lookup_url("dadjoke", "https://icanhazdadjoke.com/".into());
                match self.lookup_json(&url).await.and_then(|v| v["joke"].as_str().map(String::from)) {
                    Some(j) => meaning_line("", &j),
                    None => pick(DAD_JOKES).into(),
                }
            }
            "fact" => {
                let url = self.lookup_url(
                    "fact",
                    "https://uselessfacts.jsph.pl/api/v2/facts/random?language=en".into(),
                );
                match self.lookup_json(&url).await.and_then(|v| v["text"].as_str().map(String::from)) {
                    Some(f) => meaning_line("", &f),
                    None => pick(FACTS).into(),
                }
            }
            "dictionary" => {
                let Some(word) = args.first().map(|w| w.to_lowercase()) else {
                    return Ok("Look up a word with !dictionary word.".into());
                };
                let enc = sylva_core::auth::encode(&word);
                let url = self.lookup_url(
                    &format!("dictionary/{enc}"),
                    format!("https://api.dictionaryapi.dev/api/v2/entries/en/{enc}"),
                );
                match self.lookup(&url, true).await {
                    Some((200, text)) => {
                        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                        let m = &v[0]["meanings"][0];
                        match m["definitions"][0]["definition"].as_str() {
                            Some(d) => meaning_line(
                                &format!(
                                    "({}) {}: ",
                                    m["partOfSpeech"].as_str().unwrap_or("word"),
                                    v[0]["word"].as_str().unwrap_or(&word)
                                ),
                                d,
                            ),
                            None => format!("The dictionary has no meaning for {word}."),
                        }
                    }
                    Some((404, _)) => format!("The dictionary has no meaning for {word}."),
                    _ => "The dictionary did not answer. Try again in a minute.".into(),
                }
            }
            "urbandictionary" => {
                let term = args.join(" ");
                if term.trim().is_empty() {
                    return Ok("Look up a word with !urbandictionary word.".into());
                }
                let enc = sylva_core::auth::encode(&term);
                let url = self.lookup_url(
                    &format!("urban?term={enc}"),
                    format!("https://api.urbandictionary.com/v0/define?term={enc}"),
                );
                match self.lookup_json(&url).await {
                    Some(v) => match v["list"][0]["definition"].as_str() {
                        Some(d) => meaning_line(
                            &format!("{}: ", v["list"][0]["word"].as_str().unwrap_or(&term)),
                            d,
                        ),
                        None => format!("Urban Dictionary has nothing for {term}."),
                    },
                    None => "Urban Dictionary did not answer. Try again in a minute.".into(),
                }
            }
            "emotes" => {
                let reload = args.first().is_some_and(|a| a.eq_ignore_ascii_case("reload"))
                    && ask.level >= UserLevel::Moderator;
                self.emotes(reload, ask).await?
            }
            "addcmd" | "editcmd" | "setcmd" | "delcmd" | "command" => {
                let edit = match name {
                    "command" => command_edit(args),
                    "delcmd" => name_and_reply(args).map(|(n, _)| CommandEdit::Delete(n)),
                    _ => name_and_reply(args).map(|(n, r)| match name {
                        "addcmd" => CommandEdit::Add(n, r),
                        "editcmd" => CommandEdit::Edit(n, r),
                        _ => CommandEdit::Set(n, r),
                    }),
                };
                match edit {
                    Some(e) => self.edit_command(settings, e, ask)?,
                    None => format!(
                        "Use {}",
                        core::builtin(name).map_or("", |b| b.usage)
                    ),
                }
            }
            "count" => self.count_command(settings, args, ask)?,
            "quote" | "addquote" | "editquote" | "deletequote" => {
                self.quote_command(name, args, ask)?
            }
            "clip" => self.clip(ask).await?,
            "settitle" => {
                let title = args.join(" ").trim().to_string();
                if title.is_empty() {
                    return Ok("Change the title with !settitle and the new title.".into());
                }
                if title.chars().count() > MAX_TITLE {
                    return Ok(format!("Titles can be up to {MAX_TITLE} characters."));
                }
                if ask.dry {
                    return Ok(format!("Title changed to: {title}"));
                }
                match self.patch_channel(json!({ "title": title })).await? {
                    Ok(()) => format!("Title changed to: {title}"),
                    Err(m) => m,
                }
            }
            "setgame" => self.set_game(args, ask).await?,
            "permit" => {
                let Some(login) = target_login(args.first()) else {
                    return Ok("Permit someone with !permit @name.".into());
                };
                if !ask.dry {
                    // Stored as a time in the future: the rules skip them until then.
                    self.mark_used(&format!("permit:{login}"), ask.now + PERMIT_S * 1000)?;
                }
                format!("{login} may skip the chat rules for {PERMIT_S} seconds.")
            }
            "nuke" => {
                let Some(what) = nuke(args) else {
                    return Ok("Use !nuke with the words to remove, or !nuke @name.".into());
                };
                self.nuke(what, ask).await?
            }
            "vanish" => match who.actor {
                None => "Your messages would be removed. The test chat sends nothing to Twitch."
                    .into(),
                Some(_) if ask.level >= UserLevel::Moderator => {
                    "Twitch does not let Sylva time out moderators, so !vanish cannot clear your messages."
                        .into()
                }
                Some(a) => match self.timeout(&a.id, 1, "Sylva: !vanish").await? {
                    Ok(()) => String::new(),
                    Err(m) => m,
                },
            },
            "votekick" => self.votekick(args, ask, who).await?,
            "filesay" => {
                let Some(url) = filesay_url(args.first()) else {
                    return Ok("Use !filesay with the address of a text file.".into());
                };
                self.filesay(&url, ask).await?
            }
            "filesaystop" => {
                let running = self.config("filesay")?.is_some();
                if running && !ask.dry {
                    self.sql
                        .exec("DELETE FROM config WHERE key = 'filesay'", None)?;
                }
                if running {
                    "Stopped !filesay.".into()
                } else {
                    "No !filesay is running.".into()
                }
            }
            _ => String::new(),
        })
    }

    /// When the latest stream ended, if the channel is offline.
    fn offline_since(&self) -> Result<Option<i64>> {
        let rows = self
            .sql
            .exec(
                "SELECT seq, received_at AS at, json_extract(body, '$.rawType') AS raw_type FROM events
                 WHERE kind = 'other' AND json_extract(body, '$.rawType') IN ('stream.online', 'stream.offline')
                 ORDER BY seq DESC LIMIT 1",
                None,
            )?
            .to_array::<StreamRow>()?;
        Ok(rows
            .first()
            .filter(|r| r.raw_type == "stream.offline")
            .map(|r| r.at as i64))
    }

    /// The channel's title and category from Twitch.
    async fn channel_info(&self) -> Result<Option<Value>> {
        let Some(id) = self.broadcaster_id() else {
            return Ok(None);
        };
        let app = App::new(&self.env).await?;
        let (status, v) = app
            .helix(Method::Get, &format!("/channels?broadcaster_id={id}"), None)
            .await?;
        Ok((status == 200)
            .then(|| v["data"][0].clone())
            .filter(|d| d.is_object()))
    }

    /// Every category since the latest stream started, in order.
    fn games_played(&self, channel: &str) -> Result<String> {
        let online = self
            .sql
            .exec(
                "SELECT seq, received_at AS at, json_extract(body, '$.rawType') AS raw_type FROM events
                 WHERE kind = 'other' AND json_extract(body, '$.rawType') = 'stream.online'
                 ORDER BY seq DESC LIMIT 1",
                None,
            )?
            .to_array::<StreamRow>()?;
        let Some(start) = online.first() else {
            return Ok(format!("Sylva has not seen {channel} go live yet."));
        };
        let start = start.seq as i64;
        // The category at the start is the newest update before it.
        let rows = self
            .sql
            .exec(
                "SELECT value FROM (
                   SELECT seq, json_extract(body, '$.raw.category_name') AS value FROM events
                   WHERE kind = 'other' AND json_extract(body, '$.rawType') = 'channel.update' AND seq < ?
                   ORDER BY seq DESC LIMIT 1)
                 UNION ALL
                 SELECT value FROM (
                   SELECT seq, json_extract(body, '$.raw.category_name') AS value FROM events
                   WHERE kind = 'other' AND json_extract(body, '$.rawType') = 'channel.update' AND seq > ?
                   ORDER BY seq)",
                vec![start.into(), start.into()],
            )?
            .to_array::<TextRow>()?;
        let mut games: Vec<String> = Vec::new();
        for g in rows.into_iter().filter_map(|r| r.value) {
            if !g.is_empty() && !games.contains(&g) {
                games.push(g);
            }
        }
        let when = if self.uptime_ms()?.is_some() {
            "this stream"
        } else {
            "the last stream"
        };
        Ok(if games.is_empty() {
            format!("Sylva did not see a category in {when}.")
        } else {
            meaning_line(&format!("Played in {when}: "), &games.join(", "))
        })
    }

    /// The Twitch user a command is about: the one named after it, or the
    /// chatter. `(id, display name)`.
    async fn who_is(
        &self,
        args: &[String],
        who: &Chatter<'_>,
    ) -> Result<std::result::Result<(String, String), String>> {
        let named = args.first().filter(|a| !a.trim().is_empty());
        if named.is_none() {
            if let Some(a) = who.actor {
                return Ok(Ok((a.id.clone(), a.display_name.clone())));
            }
        }
        let login = match named {
            Some(_) => match target_login(named) {
                Some(l) => l,
                None => return Ok(Err("That is not a Twitch name.".into())),
            },
            None => who.name.to_lowercase(),
        };
        let app = App::new(&self.env).await?;
        let (status, v) = app
            .helix(Method::Get, &format!("/users?login={login}"), None)
            .await?;
        if status != 200 {
            return Ok(Err("Twitch did not answer. Try again in a minute.".into()));
        }
        let u = &v["data"][0];
        match u["id"].as_str() {
            Some(id) => Ok(Ok((
                id.to_string(),
                u["display_name"].as_str().unwrap_or(&login).to_string(),
            ))),
            None => Ok(Err(format!("No Twitch account is called {login}."))),
        }
    }

    async fn follow(
        &self,
        name: &str,
        args: &[String],
        ask: &Ask<'_>,
        who: &Chatter<'_>,
    ) -> Result<String> {
        let channel = ask.channel;
        let (id, user) = match self.who_is(args, who).await? {
            Ok(v) => v,
            Err(m) => return Ok(m),
        };
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok("Sylva has not heard from this channel yet.".into());
        };
        if id == broadcaster {
            return Ok(format!("{user} is the streamer!"));
        }
        let token = match self.commands_token().await? {
            Ok(t) => t,
            Err(m) => return Ok(m),
        };
        let (status, v) = App::user(&self.env, &token)?
            .helix(
                Method::Get,
                &format!("/channels/followers?broadcaster_id={broadcaster}&user_id={id}"),
                None,
            )
            .await?;
        if status == 401 {
            self.forget_token("commands");
        }
        if status != 200 {
            return Ok("Twitch did not answer. Try again in a minute.".into());
        }
        let Some(at) = v["data"][0]["followed_at"].as_str().and_then(parse_time) else {
            return Ok(format!("{user} does not follow {channel}."));
        };
        Ok(if name == "followage" {
            format!(
                "{user} has been following {channel} for {}.",
                age_words(at, core::utc_from_ms(ask.now))
            )
        } else {
            format!("{user} has followed {channel} since {}.", date_words(at))
        })
    }

    async fn account_age(
        &self,
        name: &str,
        args: &[String],
        ask: &Ask<'_>,
        who: &Chatter<'_>,
    ) -> Result<String> {
        let (id, user) = match self.who_is(args, who).await? {
            Ok(v) => v,
            Err(m) => return Ok(m),
        };
        let app = App::new(&self.env).await?;
        let (status, v) = app
            .helix(Method::Get, &format!("/users?id={id}"), None)
            .await?;
        let made = v["data"][0]["created_at"].as_str().and_then(parse_time);
        let (200, Some(at)) = (status, made) else {
            return Ok("Twitch did not answer. Try again in a minute.".into());
        };
        Ok(if name == "accountage" {
            format!(
                "{user} made their Twitch account {} ago.",
                age_words(at, core::utc_from_ms(ask.now))
            )
        } else {
            format!("{user} made their Twitch account on {}.", date_words(at))
        })
    }

    /// The streamer's token for clips, title, category and followers, or the
    /// words that tell chat it is missing.
    async fn commands_token(&self) -> Result<std::result::Result<String, String>> {
        Ok(match self.user_token("commands").await? {
            Token::Ok(t) => Ok(t),
            Token::No(Permission::Expired) => Err(
                "Twitch no longer accepts Sylva's permission. The streamer can allow it again on the Bot page."
                    .into(),
            ),
            Token::No(_) => Err(
                "The streamer has not allowed this yet. They can on Sylva's Bot page.".into(),
            ),
        })
    }

    fn mod_token_words(p: Permission) -> String {
        match p {
            Permission::Expired => {
                "Twitch no longer accepts Sylva's permission to moderate. The streamer can allow it again on the Moderation page."
            }
            _ => "Sylva is not allowed to moderate here yet. The streamer can allow it on the Moderation page.",
        }
        .into()
    }

    async fn patch_channel(&self, body: Value) -> Result<std::result::Result<(), String>> {
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(Err("Sylva has not heard from this channel yet.".into()));
        };
        let token = match self.commands_token().await? {
            Ok(t) => t,
            Err(m) => return Ok(Err(m)),
        };
        let (status, v) = App::user(&self.env, &token)?
            .helix(
                Method::Patch,
                &format!("/channels?broadcaster_id={broadcaster}"),
                Some(body),
            )
            .await?;
        if status == 401 {
            self.forget_token("commands");
        }
        Ok(if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(format!(
                "Twitch said no: {}",
                v["message"].as_str().unwrap_or("no reason given")
            ))
        })
    }

    async fn set_game(&self, args: &[String], ask: &Ask<'_>) -> Result<String> {
        let wanted = args.join(" ").trim().to_string();
        if wanted.is_empty() {
            return Ok("Change the category with !setgame and its name.".into());
        }
        let app = App::new(&self.env).await?;
        let (status, v) = app
            .helix(
                Method::Get,
                &format!(
                    "/search/categories?query={}&first=10",
                    sylva_core::auth::encode(&wanted)
                ),
                None,
            )
            .await?;
        if status != 200 {
            return Ok("Twitch did not answer. Try again in a minute.".into());
        }
        let found = v["data"].as_array().cloned().unwrap_or_default();
        let pick = found
            .iter()
            .find(|c| {
                c["name"]
                    .as_str()
                    .is_some_and(|n| n.eq_ignore_ascii_case(&wanted))
            })
            .or_else(|| found.first());
        let (Some(id), Some(game)) = (
            pick.and_then(|c| c["id"].as_str()),
            pick.and_then(|c| c["name"].as_str()),
        ) else {
            return Ok(format!("Twitch has no category called {wanted}."));
        };
        if ask.dry {
            return Ok(format!("Category changed to {game}."));
        }
        Ok(match self.patch_channel(json!({ "game_id": id })).await? {
            Ok(()) => format!("Category changed to {game}."),
            Err(m) => m,
        })
    }

    async fn clip(&self, ask: &Ask<'_>) -> Result<String> {
        if self.uptime_ms()?.is_none() {
            return Ok("Clips can only be made while the stream is live.".into());
        }
        if ask.dry {
            return Ok("A clip would be made now. The test chat does not make real clips.".into());
        }
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok("Sylva has not heard from this channel yet.".into());
        };
        let token = match self.commands_token().await? {
            Ok(t) => t,
            Err(m) => return Ok(m),
        };
        let (status, v) = App::user(&self.env, &token)?
            .helix(
                Method::Post,
                &format!("/clips?broadcaster_id={broadcaster}"),
                None,
            )
            .await?;
        if status == 401 {
            self.forget_token("commands");
        }
        Ok(
            match v["data"][0]["id"]
                .as_str()
                .filter(|_| status == 202 || status == 200)
            {
                Some(id) => format!("Clip made: https://clips.twitch.tv/{id}"),
                None if status == 404 => "Clips can only be made while the stream is live.".into(),
                None => format!(
                    "Twitch did not make the clip: {}",
                    v["message"].as_str().unwrap_or("no reason given")
                ),
            },
        )
    }

    async fn emotes(&self, reload: bool, ask: &Ask<'_>) -> Result<String> {
        if !reload {
            if let Some(c) = self
                .config("emotes")?
                .and_then(|v| serde_json::from_str::<EmoteCache>(&v).ok())
                .filter(|c| ask.now - c.at < EMOTES_TTL_MS)
            {
                return Ok(c.line);
            }
        }
        let Some(id) = self.broadcaster_id() else {
            return Ok("Sylva has not heard from this channel yet.".into());
        };
        let names = |v: &Value, list: &str, field: &str| -> Vec<String> {
            v[list]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|e| e[field].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default()
        };
        let app = App::new(&self.env).await?;
        let (status, tw) = app
            .helix(
                Method::Get,
                &format!("/chat/emotes?broadcaster_id={id}"),
                None,
            )
            .await?;
        let twitch = if status == 200 {
            names(&tw, "data", "name")
        } else {
            Vec::new()
        };
        let seven = self
            .lookup_json(&self.lookup_url(
                &format!("7tv/{id}"),
                format!("https://7tv.io/v3/users/twitch/{id}"),
            ))
            .await
            .map(|v| names(&v["emote_set"], "emotes", "name"))
            .unwrap_or_default();
        let bttv = self
            .lookup_json(&self.lookup_url(
                &format!("bttv/{id}"),
                format!("https://api.betterttv.net/3/cached/users/twitch/{id}"),
            ))
            .await
            .map(|v| {
                let mut all = names(&v, "channelEmotes", "code");
                all.extend(names(&v, "sharedEmotes", "code"));
                all
            })
            .unwrap_or_default();
        let ffz = self
            .lookup_json(&self.lookup_url(
                &format!("ffz/{id}"),
                format!("https://api.frankerfacez.com/v1/room/id/{id}"),
            ))
            .await
            .map(|v| {
                v["sets"]
                    .as_object()
                    .map(|sets| {
                        sets.values()
                            .flat_map(|s| names(s, "emoticons", "name"))
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let line = emote_line(&[
            ("Twitch", twitch),
            ("7TV", seven),
            ("BetterTTV", bttv),
            ("FrankerFaceZ", ffz),
        ]);
        if !ask.dry {
            self.set_config(
                "emotes",
                &serde_json::to_string(&EmoteCache {
                    at: ask.now,
                    line: line.clone(),
                })?,
            )?;
        }
        Ok(line)
    }

    fn edit_command(
        &self,
        settings: &mut BotSettings,
        edit: CommandEdit,
        ask: &Ask<'_>,
    ) -> Result<String> {
        let stored = settings.clone();
        let mut next = settings.clone();
        let named = |n: &str| core::builtin(n).is_some();
        let done: String = match &edit {
            CommandEdit::Show(n) => {
                return Ok(match next.find(n) {
                    Some(i) => {
                        let c = &next.commands[i];
                        format!(
                            "!{}{}: {}",
                            c.name,
                            if c.enabled { "" } else { " (off)" },
                            c.reply
                        )
                    }
                    None if named(n) => format!("!{n} is built in. Change it on Sylva's Bot page."),
                    None => format!("There is no !{n}."),
                });
            }
            CommandEdit::Add(n, r) | CommandEdit::Set(n, r) | CommandEdit::Edit(n, r) => {
                if r.trim().is_empty() {
                    return Ok(format!("!{n} needs a reply after its name."));
                }
                match (next.find(n), &edit) {
                    (Some(_), CommandEdit::Add(..)) => {
                        return Ok(format!("!{n} already exists. Use !editcmd to change it."))
                    }
                    (None, CommandEdit::Edit(..)) => {
                        return Ok(format!("There is no !{n}. Use !addcmd to add it."))
                    }
                    (Some(i), _) => {
                        next.commands[i].reply = r.clone();
                        format!("!{n} changed.")
                    }
                    (None, _) => {
                        if named(n) {
                            return Ok(format!("!{n} is built in. Change it on Sylva's Bot page."));
                        }
                        next.commands.push(sylva_core::bot::Command {
                            name: n.clone(),
                            aliases: Vec::new(),
                            reply: r.clone(),
                            level: UserLevel::Everyone,
                            cooldown: 5,
                            user_cooldown: 0,
                            enabled: true,
                            count: 0,
                        });
                        format!("!{n} added.")
                    }
                }
            }
            CommandEdit::Delete(n) => match next.find(n) {
                Some(i) => {
                    let name = next.commands.remove(i).name;
                    format!("!{name} deleted.")
                }
                None if named(n) => {
                    return Ok(format!(
                        "!{n} is built in. Turn it off on Sylva's Bot page."
                    ))
                }
                None => return Ok(format!("There is no !{n}.")),
            },
            CommandEdit::Enable(n, on) => match next.find(n) {
                Some(i) => {
                    next.commands[i].enabled = *on;
                    format!(
                        "!{} is {}.",
                        next.commands[i].name,
                        if *on { "on" } else { "off" }
                    )
                }
                None if named(n) => {
                    return Ok(format!(
                        "!{n} is built in. Turn it on or off on Sylva's Bot page."
                    ))
                }
                None => return Ok(format!("There is no !{n}.")),
            },
        };
        let checked = match next.validated(&stored) {
            Ok(s) => s,
            Err(e) => return Ok(format!("{}.", e.0.trim_end_matches('.'))),
        };
        if !ask.dry {
            self.save_bot_settings(&checked)?;
        }
        *settings = checked;
        Ok(done)
    }

    fn count_command(
        &self,
        settings: &mut BotSettings,
        args: &[String],
        ask: &Ask<'_>,
    ) -> Result<String> {
        let Some(name) = args
            .first()
            .map(|a| a.trim_start_matches('!').to_lowercase())
        else {
            let list: Vec<String> = settings
                .counters
                .iter()
                .filter(|c| c.enabled)
                .map(|c| format!("!{}", c.name))
                .collect();
            return Ok(if list.is_empty() {
                "No counters yet. Add one on Sylva's Bot page.".into()
            } else {
                format!("Counters: {}", list.join(", "))
            });
        };
        let Some(i) = settings.counter(&name) else {
            return Ok(format!("There is no counter called {name}."));
        };
        let mut action = counter_action(&args[1..]);
        if ask.level < UserLevel::Moderator {
            action = CounterAction::Show;
        }
        settings.counters[i].apply(action);
        if action != CounterAction::Show && !ask.dry {
            self.set_counter(&settings.counters[i].name, settings.counters[i].value)?;
        }
        Ok(settings.counters[i].reply())
    }

    /// Time someone out with the streamer's moderation grant.
    pub(crate) async fn timeout(
        &self,
        user_id: &str,
        seconds: u32,
        reason: &str,
    ) -> Result<std::result::Result<(), String>> {
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(Err("Sylva has not heard from this channel yet.".into()));
        };
        let token = match self.user_token("moderation").await? {
            Token::Ok(t) => t,
            Token::No(p) => return Ok(Err(Self::mod_token_words(p))),
        };
        let (status, v) = App::user(&self.env, &token)?
            .helix(
                Method::Post,
                &format!("/moderation/bans?broadcaster_id={broadcaster}&moderator_id={broadcaster}"),
                Some(json!({ "data": { "user_id": user_id, "duration": seconds, "reason": reason } })),
            )
            .await?;
        if status == 401 {
            self.forget_token("moderation");
        }
        Ok(if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(format!(
                "Twitch said no: {}",
                v["message"].as_str().unwrap_or("no reason given")
            ))
        })
    }

    /// Recent chat lines, newest first.
    fn recent_chat(&self, since: i64) -> Result<Vec<ChatRow>> {
        self.sql
            .exec(
                "SELECT json_extract(body, '$.raw.message_id') AS message_id,
                        json_extract(body, '$.actor.id') AS user_id,
                        json_extract(body, '$.actor.login') AS login,
                        json_extract(body, '$.message') AS text,
                        json_extract(body, '$.raw.badges') AS badges
                 FROM events WHERE kind = 'chat' AND received_at > ?
                 ORDER BY seq DESC LIMIT 500",
                vec![since.into()],
            )?
            .to_array::<ChatRow>()
    }

    /// Whether a chatter's latest line shows them as a moderator or above.
    fn row_level(&self, row: &ChatRow) -> UserLevel {
        let raw: Value = row
            .badges
            .as_deref()
            .and_then(|b| serde_json::from_str(b).ok())
            .unwrap_or(Value::Null);
        let list = badges(&json!({ "badges": raw }));
        UserLevel::from_badges(
            list.iter().map(String::as_str),
            row.user_id.as_deref() == self.broadcaster_id().as_deref(),
        )
    }

    async fn nuke(&self, what: Nuke, ask: &Ask<'_>) -> Result<String> {
        let bot_id = sender(&self.env, &self.broadcaster_id().unwrap_or_default()).id;
        let rows = self.recent_chat(ask.now - NUKE_WINDOW_MS)?;
        let hits: Vec<&ChatRow> = rows
            .iter()
            .filter(|r| r.user_id.as_deref() != Some(bot_id.as_str()))
            .filter(|r| self.row_level(r) < UserLevel::Moderator)
            .filter(|r| match &what {
                Nuke::User(login) => r.login.as_deref() == Some(login.as_str()),
                Nuke::Words(w) => r
                    .text
                    .as_deref()
                    .is_some_and(|t| t.to_lowercase().contains(w.as_str())),
            })
            .filter(|r| r.message_id.is_some())
            .take(NUKE_MAX)
            .collect();
        if hits.is_empty() {
            return Ok("Nothing in the last 5 minutes matches.".into());
        }
        if ask.dry {
            return Ok(format!(
                "{} would be removed.",
                plural(hits.len(), "message")
            ));
        }
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok("Sylva has not heard from this channel yet.".into());
        };
        let token = match self.user_token("moderation").await? {
            Token::Ok(t) => t,
            Token::No(p) => return Ok(Self::mod_token_words(p)),
        };
        let user = App::user(&self.env, &token)?;
        let mut removed = 0;
        for r in hits {
            let id = r.message_id.as_deref().unwrap_or_default();
            let (status, _) = user
                .helix(
                    Method::Delete,
                    &format!(
                        "/moderation/chat?broadcaster_id={broadcaster}&moderator_id={broadcaster}&message_id={}",
                        sylva_core::auth::encode(id)
                    ),
                    None,
                )
                .await?;
            if status == 401 {
                self.forget_token("moderation");
                break;
            }
            if (200..300).contains(&status) {
                removed += 1;
            }
        }
        Ok(format!("Removed {}.", plural(removed, "message")))
    }

    async fn votekick(&self, args: &[String], ask: &Ask<'_>, who: &Chatter<'_>) -> Result<String> {
        let Some(login) = target_login(args.first()) else {
            return Ok("Vote to time someone out with !votekick @name.".into());
        };
        let rows = self.recent_chat(ask.now - 30 * 60_000)?;
        let Some(target) = rows
            .iter()
            .find(|r| r.login.as_deref() == Some(login.as_str()))
        else {
            return Ok(format!("{login} has not chatted in the last 30 minutes."));
        };
        let target_id = target.user_id.clone().unwrap_or_default();
        let bot_id = sender(&self.env, &self.broadcaster_id().unwrap_or_default()).id;
        if self.row_level(target) >= UserLevel::Vip || target_id == bot_id {
            return Ok(format!("{login} cannot be voted out."));
        }
        let voter = who.actor.map_or("test".to_string(), |a| a.id.clone());
        if voter == target_id {
            return Ok("You cannot vote for yourself.".into());
        }
        let prefix = format!("vk:{target_id}:");
        if ask.dry {
            return Ok(format!("Vote to time out {login}: 1 of {VOTEKICK_VOTES}."));
        }
        self.sql.exec(
            "DELETE FROM bot_cooldowns WHERE key LIKE 'vk:%' AND at < ?",
            vec![(ask.now - VOTEKICK_WINDOW_MS).into()],
        )?;
        self.mark_used(&format!("{prefix}{voter}"), ask.now)?;
        let votes = self
            .sql
            .exec(
                "SELECT COUNT(*) AS n FROM bot_cooldowns WHERE substr(key, 1, ?) = ?",
                vec![(prefix.len() as i64).into(), prefix.as_str().into()],
            )?
            .to_array::<NumRow>()?
            .first()
            .map_or(0, |r| r.n as usize);
        if votes < VOTEKICK_VOTES {
            return Ok(format!(
                "Vote to time out {login}: {votes} of {VOTEKICK_VOTES}."
            ));
        }
        self.sql.exec(
            "DELETE FROM bot_cooldowns WHERE substr(key, 1, ?) = ?",
            vec![(prefix.len() as i64).into(), prefix.as_str().into()],
        )?;
        Ok(
            match self
                .timeout(
                    &target_id,
                    VOTEKICK_TIMEOUT_S,
                    "Sylva: chat voted with !votekick",
                )
                .await?
            {
                Ok(()) => format!("Chat voted {login} out for 5 minutes."),
                Err(m) => m,
            },
        )
    }

    async fn filesay(&self, url: &str, ask: &Ask<'_>) -> Result<String> {
        if self.config("filesay")?.is_some() {
            return Ok("A !filesay is already running. Stop it with !filesaystop.".into());
        }
        let Some((status, text)) = self.lookup(url, false).await else {
            return Ok("That file could not be read.".into());
        };
        if status != 200 {
            return Ok(format!(
                "That file could not be read (the server said {status})."
            ));
        }
        if text.len() > FILESAY_MAX_BYTES {
            return Ok("That file is too big. Keep it under 64 KB.".into());
        }
        let lines = filesay_lines(&text);
        if lines.is_empty() {
            return Ok("That file is empty.".into());
        }
        let n = lines.len();
        if !ask.dry {
            self.set_config(
                "filesay",
                &serde_json::to_string(&Filesay {
                    lines,
                    next: 0,
                    at: ask.now + FILESAY_GAP_MS,
                })?,
            )?;
            self.schedule().await?;
        }
        Ok(format!(
            "Posting {}, one every 2 seconds.",
            plural(n, "line")
        ))
    }

    /// When the next `!filesay` line is due, for the alarm.
    pub(crate) fn next_filesay_at(&self) -> Result<Option<i64>> {
        Ok(self
            .config("filesay")?
            .and_then(|v| serde_json::from_str::<Filesay>(&v).ok())
            .map(|f| f.at))
    }

    /// Post the next `!filesay` line when it is due.
    pub(crate) async fn run_filesay(&self, now: i64) -> Result<()> {
        let Some(mut f) = self
            .config("filesay")?
            .and_then(|v| serde_json::from_str::<Filesay>(&v).ok())
        else {
            return Ok(());
        };
        if f.at > now {
            return Ok(());
        }
        let line = f.lines.get(f.next).cloned();
        f.next += 1;
        f.at = now + FILESAY_GAP_MS;
        if f.next >= f.lines.len() || line.is_none() {
            self.sql
                .exec("DELETE FROM config WHERE key = 'filesay'", None)?;
        } else {
            self.set_config("filesay", &serde_json::to_string(&f)?)?;
        }
        if let (Some(line), Some(broadcaster)) = (line, self.broadcaster_id()) {
            let from = sender(&self.env, &broadcaster);
            self.say(&broadcaster, &from, &line, now).await?;
        }
        Ok(())
    }

    /// Whether `!permit` lets this chatter skip the chat rules right now.
    pub(crate) fn permitted(&self, login: &str, now: i64) -> Result<bool> {
        Ok(self
            .last_used(&format!("permit:{}", login.to_lowercase()))?
            .is_some_and(|until| until > now))
    }

    /// Whether Sylva has the streamer's permission for commands that need
    /// one, for the dashboard.
    pub(crate) async fn builtin_permissions(&self) -> Result<Value> {
        let state = |t: Token| match t {
            Token::Ok(_) => Permission::Ok,
            Token::No(p) => p,
        };
        Ok(json!({
            "commands": state(self.user_token("commands").await?),
            "moderation": state(self.user_token("moderation").await?),
        }))
    }
}

fn pick(list: &[&'static str]) -> &'static str {
    let i = (js_sys::Math::random() * list.len() as f64) as usize;
    list[i.min(list.len() - 1)]
}

/// One row of the public commands page.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicCommand {
    pub name: String,
    pub aliases: Vec<String>,
    /// The reply as written, variables and all, or what a built-in does.
    pub text: String,
    pub usage: String,
    pub level: UserLevel,
    pub cooldown: u32,
    pub builtin: bool,
}

/// The public commands page's data.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicCommands {
    pub channel: String,
    pub login: String,
    pub commands: Vec<PublicCommand>,
    pub counters: Vec<sylva_core::community::Counter>,
}

impl ChannelDo {
    /// Every command chat can use, for the page `!commands` links to.
    /// `None` while the bot is off.
    pub(crate) fn public_commands(&self) -> Result<Option<PublicCommands>> {
        let settings = self.bot_settings()?;
        if !settings.enabled {
            return Ok(None);
        }
        let mut commands: Vec<PublicCommand> = settings
            .commands
            .iter()
            .filter(|c| c.enabled)
            .map(|c| PublicCommand {
                name: c.name.clone(),
                aliases: c.aliases.clone(),
                text: c.reply.clone(),
                usage: format!("!{}", c.name),
                level: c.level,
                cooldown: c.cooldown,
                builtin: false,
            })
            .collect();
        for b in core::BUILTINS {
            let Some((_, s)) = settings.builtin(b.name) else {
                continue;
            };
            let quotes_off = b.group == core::Group::Quotes && !settings.quotes.enabled;
            if !s.enabled || quotes_off {
                continue;
            }
            commands.push(PublicCommand {
                name: b.name.into(),
                aliases: b.aliases.iter().map(|a| a.to_string()).collect(),
                text: b.about.into(),
                usage: b.usage.into(),
                level: s.level,
                cooldown: s.cooldown,
                builtin: true,
            });
        }
        Ok(Some(PublicCommands {
            channel: self.channel_name()?,
            login: self.channel_login()?.unwrap_or_default(),
            commands,
            counters: settings
                .counters
                .into_iter()
                .filter(|c| c.enabled)
                .collect(),
        }))
    }
}

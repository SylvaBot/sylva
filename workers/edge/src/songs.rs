//! Song requests in the channel's Durable Object (the rules are in
//! `sylva_core::songs`).
//!
//! The queue, the song up now and the last few finished songs are kept in
//! `config` as JSON: a queue holds at most a couple of hundred short rows.
//! Sylva Control plays the audio and reports its playback here; the
//! dashboard's buttons reach it as `songControl` frames on its socket.
//!
//! Songs are looked up on Spotify with the streamer's own Spotify sign in
//! (see `spotify.rs`), and Sylva Control plays them in their Spotify app.
//! A YouTube link in `!sr` is turned into a Spotify search for its title,
//! read from YouTube's official oEmbed endpoint.

use serde::Deserialize;
use serde_json::{json, Value};
use sylva_core::bot::UserLevel;
use sylva_core::protocol::{Role, ServerFrame};
use sylva_core::songs::{
    self as core, clock, song_link, Found, Playback, Song, SongControl, SongSettings, SongWho,
    SongsView, HISTORY, PLAYER_FRESH_MS,
};
use worker::*;

use crate::builtins::Chatter;
use crate::channel::ChannelDo;
use crate::community::Ask;
use crate::twitch_api::App;

const LOOKUP_TIMEOUT_MS: u32 = 6_000;

#[derive(Deserialize)]
struct MoveBody {
    to: usize,
}
#[derive(Deserialize)]
struct NextBody {
    #[serde(default)]
    from: Option<u64>,
}
#[derive(Deserialize)]
struct AddBody {
    query: String,
}

fn now() -> i64 {
    Date::now().as_millis() as i64
}

impl ChannelDo {
    fn json_config<T: serde::de::DeserializeOwned + Default>(&self, key: &str) -> Result<T> {
        Ok(self
            .config(key)?
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    fn set_json<T: serde::Serialize>(&self, key: &str, v: &T) -> Result<()> {
        self.set_config(key, &serde_json::to_string(v)?)
    }

    pub(crate) fn song_settings(&self) -> Result<SongSettings> {
        self.json_config("song_settings")
    }

    fn song_queue(&self) -> Result<Vec<Song>> {
        self.json_config("song_queue")
    }

    fn song_current(&self) -> Result<Option<Song>> {
        self.json_config("song_current")
    }

    pub(crate) fn songs_view(&self) -> Result<SongsView> {
        let playback: Playback = self.json_config("song_playback")?;
        let online = playback.at > 0 && now() - playback.at < PLAYER_FRESH_MS;
        Ok(SongsView {
            settings: self.song_settings()?,
            current: self.song_current()?,
            queue: self.song_queue()?,
            playback,
            player_online: online,
            history: self.json_config("song_history")?,
            spotify: self.spotify_link()?,
        })
    }

    /// Tell the dashboard and Sylva Control what changed.
    pub(crate) fn songs_changed(&self) -> Result<SongsView> {
        let view = self.songs_view()?;
        let text = serde_json::to_string(&ServerFrame::Songs(Box::new(view.clone())))?;
        for ws in self.sockets(Role::Feed) {
            let _ = ws.send_with_str(&text);
        }
        Ok(view)
    }

    fn send_control(&self, control: SongControl) -> Result<()> {
        let text = serde_json::to_string(&ServerFrame::SongControl { control })?;
        for ws in self.sockets(Role::Feed) {
            let _ = ws.send_with_str(&text);
        }
        Ok(())
    }

    /// Finish the song up now (if it is still `from`) and start the next.
    fn advance(&self, from: Option<u64>) -> Result<()> {
        let current = self.song_current()?;
        if from.is_some() && current.as_ref().map(|s| s.id) != from {
            return Ok(());
        }
        let mut queue = self.song_queue()?;
        if let Some(done) = current {
            let mut history: Vec<Song> = self.json_config("song_history")?;
            history.insert(0, done);
            history.truncate(HISTORY);
            self.set_json("song_history", &history)?;
        }
        let next = if queue.is_empty() { None } else { Some(queue.remove(0)) };
        self.set_json("song_current", &next)?;
        self.set_json("song_queue", &queue)?;
        Ok(())
    }

    fn next_song_id(&self) -> Result<u64> {
        let id = self
            .config("song_next_id")?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1);
        self.set_config("song_next_id", &(id + 1).to_string())?;
        Ok(id)
    }

    /// Put a found song in the queue, or up now when nothing is.
    fn push_song(&self, found: Found, by: &str, by_id: &str) -> Result<(Song, usize)> {
        let song = Song {
            id: self.next_song_id()?,
            track: found.track,
            video_id: found.video_id,
            title: found.title,
            author: found.author,
            duration_s: found.duration_s,
            by: by.into(),
            by_id: by_id.into(),
            at: now(),
        };
        if self.song_current()?.is_none() {
            self.set_json("song_current", &Some(song.clone()))?;
            return Ok((song, 0));
        }
        let mut queue = self.song_queue()?;
        queue.push(song.clone());
        self.set_json("song_queue", &queue)?;
        Ok((song, queue.len()))
    }

    /// `/songs/...` from the dashboard, team and Sylva Control.
    pub(crate) async fn songs_route(&self, mut req: Request, rest: &[&str]) -> Result<Response> {
        let post = req.method() == Method::Post;
        if let ["spotify", tail @ ..] = rest {
            if let Some(res) = self.spotify_route(&req, post, tail).await? {
                return Ok(res);
            }
            return Response::from_json(&self.songs_changed()?);
        }
        match (post, rest) {
            (false, []) => return Response::from_json(&self.songs_view()?),
            (true, ["settings"]) => {
                let Ok(s) = req.json::<SongSettings>().await else {
                    return Response::error("Those settings could not be read", 400);
                };
                match s.validated() {
                    Ok(s) => self.set_json("song_settings", &s)?,
                    Err(e) => return Response::error(e.0, 400),
                }
            }
            (true, ["add"]) => {
                let Ok(b) = req.json::<AddBody>().await else {
                    return Response::error("Type a song name or a Spotify link", 400);
                };
                let found = match self.find_song(&b.query).await? {
                    Ok(f) => f,
                    Err(m) => return Response::error(m, 400),
                };
                let (queue, current) = (self.song_queue()?, self.song_current()?);
                let settings = SongSettings { max_duration_s: core::MAX_DURATION_S, ..self.song_settings()? };
                if let Some(m) = core::refusal(&settings, &queue, current.as_ref(), &found, "", true) {
                    return Response::error(m, 400);
                }
                let id = self.broadcaster_id().unwrap_or_default();
                self.push_song(found, &self.channel_name()?, &id)?;
            }
            (true, ["next"]) => {
                let b: NextBody = req.json().await.unwrap_or(NextBody { from: None });
                self.advance(b.from)?;
            }
            (true, ["clear"]) => self.set_json("song_queue", &Vec::<Song>::new())?,
            (true, ["control"]) => {
                let Ok(c) = req.json::<SongControl>().await else {
                    return Response::error("That could not be read", 400);
                };
                self.send_control(c)?;
                return Response::from_json(&self.songs_view()?);
            }
            (true, ["player"]) => {
                let Ok(mut p) = req.json::<Playback>().await else {
                    return Response::error("That could not be read", 400);
                };
                let old: Playback = self.json_config("song_playback")?;
                p.at = now();
                p.volume = p.volume.min(100);
                self.set_json("song_playback", &p)?;
                // A heartbeat that matches what everyone already shows
                // needs no broadcast.
                let expected = if old.playing {
                    old.position_ms as i64 + (p.at - old.at)
                } else {
                    old.position_ms as i64
                };
                let same = old.song_id == p.song_id
                    && old.playing == p.playing
                    && old.volume == p.volume
                    && old.status == p.status
                    && (p.position_ms as i64 - expected).abs() < 3_000
                    && p.at - old.at < PLAYER_FRESH_MS;
                if same {
                    return Response::from_json(&json!({ "ok": true }));
                }
                self.songs_changed()?;
                return Response::from_json(&json!({ "ok": true }));
            }
            (true, [id, action]) => {
                let Ok(id) = id.parse::<u64>() else {
                    return Response::error("There is no such song", 404);
                };
                let mut queue = self.song_queue()?;
                match *action {
                    "remove" => {
                        if self.song_current()?.is_some_and(|s| s.id == id) {
                            self.advance(Some(id))?;
                        } else {
                            queue.retain(|s| s.id != id);
                            self.set_json("song_queue", &queue)?;
                        }
                    }
                    "move" => {
                        let Ok(b) = req.json::<MoveBody>().await else {
                            return Response::error("That could not be read", 400);
                        };
                        if !core::move_song(&mut queue, id, b.to) {
                            return Response::error("That song already left the queue", 404);
                        }
                        self.set_json("song_queue", &queue)?;
                    }
                    _ => return Response::error("Not found", 404),
                }
            }
            _ => return Response::error("Not found", 404),
        }
        Response::from_json(&self.songs_changed()?)
    }

    /// What `/{login}/songs` shows: no viewer ids.
    pub(crate) fn songs_public(&self) -> Result<Value> {
        let v = self.songs_view()?;
        let strip = |s: &Song| json!({ "title": s.title, "author": s.author, "videoId": s.video_id, "track": s.track, "durationS": s.duration_s, "by": s.by });
        Ok(json!({
            "enabled": v.settings.enabled,
            "who": v.settings.who,
            "current": v.current.as_ref().map(strip),
            "queue": v.queue.iter().map(strip).collect::<Vec<_>>(),
            "playing": v.player_online && v.playback.playing && v.playback.song_id == v.current.as_ref().map(|s| s.id),
            "positionMs": v.playback.position_ms,
            "at": v.playback.at,
        }))
    }

    /// A YouTube video's title, from YouTube's official oEmbed endpoint.
    async fn youtube_title(&self, id: &str) -> Option<String> {
        let base = self
            .var("SYLVA_LOOKUP_URL")
            .filter(|b| !b.is_empty())
            .map(|b| format!("{b}/youtube"))
            .unwrap_or_else(|| "https://www.youtube.com".into());
        let url = format!("{base}/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}");
        let req = Request::new(&url, Method::Get).ok()?;
        let signal = AbortSignal::from(web_sys::AbortSignal::timeout_with_u32(LOOKUP_TIMEOUT_MS));
        let mut res = Fetch::Request(req).send_with_signal(&signal).await.ok()?;
        if res.status_code() != 200 {
            return None;
        }
        let v: Value = res.json().await.ok()?;
        v["title"].as_str().map(core::search_words)
    }

    /// A link or a search, as one Spotify track. `Err` is worded for chat.
    pub(crate) async fn find_song(&self, query: &str) -> Result<std::result::Result<Found, String>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Err("Add a song name or a Spotify link, such as !sr never gonna give you up".into()));
        }
        if let Some(id) = core::spotify_track(query) {
            return Ok(match self.spotify_get(&format!("/tracks/{id}?market=from_token")).await? {
                Ok(v) if v["is_playable"].as_bool() == Some(false) => {
                    Err("That song can't play on Spotify here.".into())
                }
                Ok(v) => core::parse_spotify_track(&v).ok_or_else(|| "Spotify has no such song.".to_string()),
                Err(m) => Err(m),
            });
        }
        let words = match core::video_id(query).filter(|_| query.contains("youtu")) {
            Some(id) => match self.youtube_title(&id).await {
                Some(t) => t,
                None => return Ok(Err("That YouTube video could not be found. Try the song name.".into())),
            },
            None if query.starts_with("http") || query.contains("://") => {
                return Ok(Err("Use a song name, a Spotify link or a YouTube link.".into()))
            }
            None => query.to_string(),
        };
        let mut q = Url::parse("https://x/").expect("a valid address");
        q.query_pairs_mut()
            .append_pair("q", &words)
            .append_pair("type", "track")
            .append_pair("limit", "1")
            .append_pair("market", "from_token");
        Ok(match self.spotify_get(&format!("/search?{}", q.query().unwrap_or(""))).await? {
            Ok(v) => v["tracks"]["items"]
                .get(0)
                .and_then(core::parse_spotify_track)
                .ok_or_else(|| format!("No song on Spotify matches {words}.")),
            Err(m) => Err(m),
        })
    }

    /// Whether a viewer follows the channel. `None` when Twitch can't say.
    async fn follows(&self, user_id: &str) -> Result<Option<bool>> {
        let Some(broadcaster) = self.broadcaster_id() else {
            return Ok(None);
        };
        let Ok(token) = self.commands_token().await? else {
            return Ok(None);
        };
        let (status, v) = App::user(&self.env, &token)?
            .helix(
                Method::Get,
                &format!("/channels/followers?broadcaster_id={broadcaster}&user_id={user_id}"),
                None,
            )
            .await?;
        if status == 401 {
            self.forget_token("commands");
        }
        Ok((status == 200).then(|| v["data"].as_array().is_some_and(|d| !d.is_empty())))
    }

    /// The song request commands in chat.
    pub(crate) async fn song_command(
        &self,
        name: &str,
        args: &[String],
        ask: &Ask<'_>,
        who: &Chatter<'_>,
    ) -> Result<String> {
        let settings = self.song_settings()?;
        let at = format!("@{}", who.name);
        let by_id = who.actor.map(|a| a.id.as_str()).unwrap_or("");
        let is_mod = ask.level >= UserLevel::Moderator;
        match name {
            "sr" => {
                if !settings.enabled {
                    return Ok(format!("{at} Song requests are off right now."));
                }
                if settings.live_only && !is_mod && self.uptime_ms()?.is_none() {
                    return Ok(format!("{at} Song requests open when the stream is live."));
                }
                let need = match settings.who {
                    SongWho::Everyone | SongWho::Followers => UserLevel::Everyone,
                    SongWho::Subscriber => UserLevel::Subscriber,
                    SongWho::Vip => UserLevel::Vip,
                    SongWho::Moderator => UserLevel::Moderator,
                };
                if ask.level < need {
                    let who = match settings.who {
                        SongWho::Subscriber => "subscribers, VIPs and moderators",
                        SongWho::Vip => "VIPs and moderators",
                        _ => "moderators",
                    };
                    return Ok(format!("{at} Song requests are for {who} right now."));
                }
                if settings.who == SongWho::Followers && ask.level < UserLevel::Subscriber && !by_id.is_empty() {
                    match self.follows(by_id).await? {
                        Some(true) => {}
                        Some(false) => return Ok(format!("{at} Follow the channel to request songs.")),
                        None => return Ok(format!("{at} Twitch could not say if you follow. Try again in a minute.")),
                    }
                }
                let found = match self.find_song(&args.join(" ")).await? {
                    Ok(f) => f,
                    Err(m) => return Ok(format!("{at} {m}")),
                };
                let (queue, current) = (self.song_queue()?, self.song_current()?);
                if let Some(m) = core::refusal(&settings, &queue, current.as_ref(), &found, by_id, is_mod) {
                    return Ok(format!("{at} {m}"));
                }
                let length = if found.duration_s > 0 { format!(" ({})", clock(found.duration_s)) } else { String::new() };
                let title = found.title.clone();
                if ask.dry {
                    return Ok(format!("{at} Added {title}{length}. (Test chat: nothing was queued.)"));
                }
                let (_, place) = self.push_song(found, who.name, by_id)?;
                self.songs_changed()?;
                Ok(if place == 0 {
                    format!("{at} Added {title}{length}. It plays next.")
                } else {
                    format!("{at} Added {title}{length}, number {place} in the queue.")
                })
            }
            "song" => Ok(match self.song_current()? {
                Some(s) => format!("Now playing: {} by {} (requested by {}) {}", s.title, s.author, s.by, song_link(&s)),
                None => "No song is playing.".into(),
            }),
            "songlist" => {
                let queue = self.song_queue()?;
                let link = match (self.config("site")?, self.channel_login()?) {
                    (Some(site), Some(login)) => format!(" Full queue: {site}/{login}/songs"),
                    _ => String::new(),
                };
                if queue.is_empty() {
                    return Ok(format!("The song queue is empty.{link}"));
                }
                let next: Vec<String> = queue
                    .iter()
                    .take(3)
                    .enumerate()
                    .map(|(i, s)| format!("{}. {}", i + 1, s.title))
                    .collect();
                let more = if queue.len() > 3 { format!(" and {} more.", queue.len() - 3) } else { String::new() };
                Ok(format!("Next up: {}{more}{link}", next.join(" | ")))
            }
            "wrongsong" => {
                let mut queue = self.song_queue()?;
                let Some(i) = queue.iter().rposition(|s| !by_id.is_empty() && s.by_id == by_id) else {
                    return Ok(format!("{at} You have no song waiting."));
                };
                if ask.dry {
                    return Ok(format!("{at} Removed {}.", queue[i].title));
                }
                let s = queue.remove(i);
                self.set_json("song_queue", &queue)?;
                self.songs_changed()?;
                Ok(format!("{at} Removed {}.", s.title))
            }
            "skipsong" => {
                let Some(s) = self.song_current()? else {
                    return Ok("No song is playing.".into());
                };
                if ask.dry {
                    return Ok(format!("Skipped {}.", s.title));
                }
                self.advance(Some(s.id))?;
                self.songs_changed()?;
                Ok(format!("Skipped {}.", s.title))
            }
            _ => Ok(String::new()),
        }
    }
}

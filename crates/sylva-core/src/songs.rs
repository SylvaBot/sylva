//! Song requests: viewers ask for a song with `!sr`, Sylva keeps the queue,
//! and Sylva Control plays it in the streamer's Spotify app.
//!
//! Who owns what:
//! * The queue and the song that is up now live in the channel's Durable
//!   Object, because chat, the dashboard and Sylva Control all change them.
//! * Playback (playing or paused, the position, the volume) belongs to
//!   Sylva Control, which reports it here so every page shows the truth.
//!
//! Nothing here touches the network. The Worker looks songs up on Spotify
//! (with the streamer's own Spotify sign in) and hands the answers to
//! [`parse_spotify_track`]. YouTube links still work in `!sr`: their title
//! is searched on Spotify. Songs queued before Spotify carry only a
//! `video_id`, and [`parse_player`] and [`parse_search`] read YouTube.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::alerts::Invalid;

pub const MAX_QUEUE: u32 = 200;
pub const MAX_PER_USER: u32 = 20;
/// The longest song a streamer may allow, in seconds (one hour).
pub const MAX_DURATION_S: u32 = 3600;
/// How long a player report counts as "Sylva Control is open".
pub const PLAYER_FRESH_MS: i64 = 45_000;
/// How many finished songs the dashboard can show.
pub const HISTORY: usize = 20;

/// Who may request songs. Unlike other commands this has a followers step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SongWho {
    Everyone,
    Followers,
    Subscriber,
    Vip,
    Moderator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongSettings {
    /// Off until the streamer turns song requests on.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "everyone")]
    pub who: SongWho,
    /// Songs waiting at most.
    #[serde(default = "d_queue")]
    pub max_queue: u32,
    /// Songs one viewer may have waiting at once. Moderators have no limit.
    #[serde(default = "d_per_user")]
    pub max_per_user: u32,
    /// The longest song accepted, in seconds.
    #[serde(default = "d_duration")]
    pub max_duration_s: u32,
    /// Take requests only while the stream is live.
    #[serde(default)]
    pub live_only: bool,
}

fn everyone() -> SongWho {
    SongWho::Everyone
}
fn d_queue() -> u32 {
    50
}
fn d_per_user() -> u32 {
    3
}
fn d_duration() -> u32 {
    600
}

impl Default for SongSettings {
    fn default() -> Self {
        SongSettings {
            enabled: false,
            who: SongWho::Everyone,
            max_queue: d_queue(),
            max_per_user: d_per_user(),
            max_duration_s: d_duration(),
            live_only: false,
        }
    }
}

impl SongSettings {
    pub fn validated(self) -> Result<SongSettings, Invalid> {
        if self.max_queue == 0 || self.max_queue > MAX_QUEUE {
            return Err(Invalid(format!("The queue can hold 1 to {MAX_QUEUE} songs")));
        }
        if self.max_per_user == 0 || self.max_per_user > MAX_PER_USER {
            return Err(Invalid(format!("Each viewer can have 1 to {MAX_PER_USER} songs waiting")));
        }
        if self.max_duration_s < 30 || self.max_duration_s > MAX_DURATION_S {
            return Err(Invalid("The longest song can be 30 seconds to 1 hour".into()));
        }
        Ok(self)
    }
}

/// One requested song.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    /// Given by the server, never reused in a channel.
    pub id: u64,
    /// The Spotify track id (22 characters).
    #[serde(default)]
    pub track: String,
    /// The YouTube video id, only on songs queued before Spotify.
    #[serde(default)]
    pub video_id: String,
    pub title: String,
    /// The artists.
    #[serde(default)]
    pub author: String,
    pub duration_s: u32,
    /// Display name of the viewer who asked, or the streamer's.
    pub by: String,
    /// Their Twitch user id, for per-viewer limits and `!wrongsong`.
    #[serde(default)]
    pub by_id: String,
    pub at: i64,
}

/// What Sylva Control says it is doing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    /// The song it has loaded, by [`Song::id`].
    #[serde(default)]
    pub song_id: Option<u64>,
    #[serde(default)]
    pub playing: bool,
    /// Where it was when it reported, in milliseconds.
    #[serde(default)]
    pub position_ms: u64,
    /// 0 to 100.
    #[serde(default = "d_volume")]
    pub volume: u8,
    /// Loading the audio, or the last error, for the dashboard.
    #[serde(default)]
    pub status: Option<String>,
    /// Server time of the report, filled in by the server.
    #[serde(default)]
    pub at: i64,
}

fn d_volume() -> u8 {
    60
}

/// Everything a song requests page or player needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongsView {
    pub settings: SongSettings,
    pub current: Option<Song>,
    pub queue: Vec<Song>,
    pub playback: Playback,
    /// Sylva Control reported within [`PLAYER_FRESH_MS`].
    pub player_online: bool,
    /// Recently finished or skipped, newest first.
    #[serde(default)]
    pub history: Vec<Song>,
    #[serde(default)]
    pub spotify: SpotifyLink,
}

/// The streamer's Spotify connection, as pages show it. Tokens never leave
/// the server except to the owner's own Sylva Control.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyLink {
    /// This Sylva server has a Spotify app set up.
    pub ready: bool,
    /// The Spotify account's display name, when connected.
    pub name: Option<String>,
    /// Spotify Premium, which playback through Spotify's API needs.
    pub premium: bool,
}

/// A remote control press from the dashboard or chat, sent to Sylva Control.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SongControl {
    Play,
    Pause,
    #[serde(rename_all = "camelCase")]
    Seek {
        position_ms: u64,
    },
    Volume {
        volume: u8,
    },
}

/// Why a request was refused, worded for chat.
pub fn refusal(
    settings: &SongSettings,
    queue: &[Song],
    current: Option<&Song>,
    found: &Found,
    by_id: &str,
    is_mod: bool,
) -> Option<String> {
    if found.live {
        return Some("Live streams can't be requested.".into());
    }
    if found.duration_s > settings.max_duration_s {
        return Some(format!(
            "That song is {}, longer than the {} limit.",
            clock(found.duration_s),
            clock(settings.max_duration_s)
        ));
    }
    if queue.len() as u32 >= settings.max_queue {
        return Some("The song queue is full. Try again later.".into());
    }
    let dup = queue.iter().chain(current).any(|s| {
        if found.track.is_empty() {
            s.video_id == found.video_id
        } else {
            s.track == found.track
        }
    });
    if dup {
        return Some("That song is already in the queue.".into());
    }
    if !is_mod && !by_id.is_empty() {
        let mine = queue.iter().filter(|s| s.by_id == by_id).count() as u32;
        if mine >= settings.max_per_user {
            return Some(format!(
                "You already have {mine} song{} waiting. Wait for one to play first.",
                if mine == 1 { "" } else { "s" }
            ));
        }
    }
    None
}

/// Move a song to `to` (clamped). Returns false when there is no such song.
pub fn move_song(queue: &mut Vec<Song>, id: u64, to: usize) -> bool {
    let Some(from) = queue.iter().position(|s| s.id == id) else {
        return false;
    };
    let s = queue.remove(from);
    let to = to.min(queue.len());
    queue.insert(to, s);
    true
}

/// "3:07", "1:02:03".
pub fn clock(secs: u32) -> String {
    let (h, m, s) = (secs / 3600, secs / 60 % 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// "3:07" or "1:02:03" to seconds.
pub fn parse_clock(text: &str) -> Option<u32> {
    let mut total = 0u32;
    for part in text.trim().split(':') {
        let n: u32 = part.parse().ok()?;
        total = total.checked_mul(60)?.checked_add(n)?;
    }
    Some(total)
}

fn is_id(s: &str) -> bool {
    s.len() == 11
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The video id in a YouTube link or a bare id: youtube.com/watch?v=,
/// youtu.be/, /shorts/, /embed/, /live/, music.youtube.com and m.youtube.com.
pub fn video_id(input: &str) -> Option<String> {
    let t = input.trim().trim_start_matches('<').trim_end_matches('>');
    if is_id(t) {
        return Some(t.to_string());
    }
    let rest = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("http://"))
        .unwrap_or(t);
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let path = path.split('#').next().unwrap_or("");
    let candidate = match host {
        "youtu.be" => path.split('/').next().map(str::to_string),
        "youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            let mut segs = path.split('/');
            match segs.next() {
                Some("watch") => query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("v="))
                    .map(str::to_string),
                Some("shorts" | "embed" | "live" | "v") => segs.next().map(str::to_string),
                _ => None,
            }
        }
        _ => None,
    }?;
    is_id(&candidate).then_some(candidate)
}

/// A song found on Spotify (or, before Spotify, YouTube), before it joins the queue.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    #[serde(default)]
    pub track: String,
    #[serde(default)]
    pub video_id: String,
    pub title: String,
    pub author: String,
    pub duration_s: u32,
    pub live: bool,
}

/// Read a YouTube `youtubei/v1/player` answer. `Err` carries words for chat.
pub fn parse_player(v: &Value) -> Result<Found, String> {
    let status = v["playabilityStatus"]["status"].as_str().unwrap_or("");
    let d = &v["videoDetails"];
    let id = d["videoId"].as_str().unwrap_or("");
    if !is_id(id) {
        return Err(match status {
            "LOGIN_REQUIRED" => "YouTube says that video needs a sign in, so it can't be played.".into(),
            _ => "That video could not be found.".into(),
        });
    }
    if status != "OK" && status != "LOGIN_REQUIRED" {
        return Err("YouTube won't play that video outside its site.".into());
    }
    if v["playabilityStatus"]["playableInEmbed"].as_bool() == Some(false) {
        return Err("That video's owner does not let it play outside YouTube.".into());
    }
    Ok(Found {
        track: String::new(),
        video_id: id.into(),
        title: d["title"].as_str().unwrap_or("Untitled").into(),
        author: d["author"].as_str().unwrap_or("").into(),
        duration_s: d["lengthSeconds"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        live: d["isLive"].as_bool().unwrap_or(false)
            || (d["isLiveContent"].as_bool() == Some(true) && d["lengthSeconds"].as_str() == Some("0")),
    })
}

/// The first video in a YouTube `youtubei/v1/search` answer.
pub fn parse_search(v: &Value) -> Option<Found> {
    let mut stack = vec![v];
    while let Some(n) = stack.pop() {
        match n {
            Value::Object(m) => {
                if let Some(r) = m.get("videoRenderer") {
                    if let Some(f) = renderer(r) {
                        return Some(f);
                    }
                }
                // Keep YouTube's order: push in reverse so the first child pops first.
                let kids: Vec<&Value> = m.values().collect();
                stack.extend(kids.into_iter().rev());
            }
            Value::Array(a) => stack.extend(a.iter().rev()),
            _ => {}
        }
    }
    None
}

fn text(v: &Value) -> String {
    if let Some(s) = v["simpleText"].as_str() {
        return s.into();
    }
    v["runs"]
        .as_array()
        .map(|r| r.iter().filter_map(|x| x["text"].as_str()).collect())
        .unwrap_or_default()
}

fn renderer(r: &Value) -> Option<Found> {
    let id = r["videoId"].as_str().filter(|s| is_id(s))?;
    // Live streams and premieres have no length.
    let length = text(&r["lengthText"]);
    let duration_s = parse_clock(&length).unwrap_or(0);
    Some(Found {
        track: String::new(),
        video_id: id.into(),
        title: text(&r["title"]),
        author: text(&r["ownerText"]),
        duration_s,
        live: length.is_empty(),
    })
}

fn is_track(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// The track id in a Spotify link (open.spotify.com/track/..., with or
/// without an `intl-xx` part) or a `spotify:track:` address.
pub fn spotify_track(input: &str) -> Option<String> {
    let t = input.trim().trim_start_matches('<').trim_end_matches('>');
    if let Some(id) = t.strip_prefix("spotify:track:") {
        return is_track(id).then(|| id.to_string());
    }
    let rest = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("http://"))
        .unwrap_or(t);
    let (host, path) = rest.split_once('/')?;
    if !host.eq_ignore_ascii_case("open.spotify.com") {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    let mut segs = path.split('/').filter(|s| !s.starts_with("intl-"));
    match (segs.next(), segs.next()) {
        (Some("track"), Some(id)) if is_track(id) => Some(id.to_string()),
        _ => None,
    }
}

/// Read a Spotify track object (`/v1/tracks/{id}`, or one search result).
pub fn parse_spotify_track(v: &Value) -> Option<Found> {
    let id = v["id"].as_str().filter(|s| is_track(s))?;
    let author = v["artists"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    Some(Found {
        track: id.into(),
        video_id: String::new(),
        title: v["name"].as_str().unwrap_or("Untitled").into(),
        author,
        duration_s: (v["duration_ms"].as_u64().unwrap_or(0) / 1000) as u32,
        live: false,
    })
}

/// A YouTube title as Spotify search words: drops the bits in brackets
/// that YouTube adds ("(Official Video)", "[Lyrics]", "| 4K").
pub fn search_words(title: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in title.split('|').next().unwrap_or(title).chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let words: Vec<&str> = out.split_whitespace().filter(|w| *w != "-" && !w.eq_ignore_ascii_case("ft.") && !w.eq_ignore_ascii_case("feat.")).collect();
    if words.is_empty() {
        title.trim().to_string()
    } else {
        words.join(" ")
    }
}

/// The link chat and pages show for a song.
pub fn song_link(s: &Song) -> String {
    if s.track.is_empty() {
        format!("https://youtu.be/{}", s.video_id)
    } else {
        format!("https://open.spotify.com/track/{}", s.track)
    }
}

/// The PKCE challenge for a verifier: base64url (no padding) of its SHA-256.
pub fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    crate::media::b64_encode(&Sha256::digest(verifier.as_bytes()))
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_ids_in_links() {
        let id = Some("dQw4w9WgXcQ".to_string());
        for link in [
            "dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=10",
            "youtu.be/dQw4w9WgXcQ?si=abc",
            "https://m.youtube.com/shorts/dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x",
            "<https://www.youtube.com/embed/dQw4w9WgXcQ>",
        ] {
            assert_eq!(video_id(link), id, "{link}");
        }
        assert_eq!(video_id("never gonna give you up"), None);
        assert_eq!(video_id("https://example.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(video_id("https://youtube.com/watch?v=short"), None);
    }

    #[test]
    fn clocks() {
        assert_eq!(clock(187), "3:07");
        assert_eq!(clock(3723), "1:02:03");
        assert_eq!(parse_clock("3:07"), Some(187));
        assert_eq!(parse_clock("1:02:03"), Some(3723));
        assert_eq!(parse_clock(""), None);
    }

    fn song(id: u64, by: &str) -> Song {
        Song {
            id,
            track: String::new(),
            video_id: format!("vid{id:08}"),
            title: format!("Song {id}"),
            author: String::new(),
            duration_s: 200,
            by: by.into(),
            by_id: by.into(),
            at: 0,
        }
    }

    fn found(id: &str, secs: u32) -> Found {
        Found { track: String::new(), video_id: id.into(), title: "T".into(), author: "A".into(), duration_s: secs, live: false }
    }

    #[test]
    fn refuses_by_the_rules() {
        let s = SongSettings { max_per_user: 2, max_queue: 3, ..Default::default() };
        let q = vec![song(1, "a"), song(2, "a")];
        assert!(refusal(&s, &q, None, &found("x", 200), "b", false).is_none());
        assert!(refusal(&s, &q, None, &found("x", 200), "a", false).unwrap().contains("2 songs"));
        assert!(refusal(&s, &q, None, &found("x", 200), "a", true).is_none());
        assert!(refusal(&s, &q, None, &found("x", 9999), "b", false).unwrap().contains("longer"));
        assert!(refusal(&s, &q, None, &found("vid00000001", 200), "b", false).unwrap().contains("already"));
        let full = vec![song(1, "a"), song(2, "b"), song(3, "c")];
        assert!(refusal(&s, &full, None, &found("x", 200), "d", false).unwrap().contains("full"));
    }

    #[test]
    fn moves_songs() {
        let mut q = vec![song(1, "a"), song(2, "a"), song(3, "a")];
        assert!(move_song(&mut q, 3, 0));
        assert_eq!(q.iter().map(|s| s.id).collect::<Vec<_>>(), [3, 1, 2]);
        assert!(move_song(&mut q, 3, 99));
        assert_eq!(q.iter().map(|s| s.id).collect::<Vec<_>>(), [1, 2, 3]);
        assert!(!move_song(&mut q, 9, 0));
    }

    #[test]
    fn reads_youtube_answers() {
        let p = json!({
            "playabilityStatus": { "status": "OK", "playableInEmbed": true },
            "videoDetails": { "videoId": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up", "author": "Rick Astley", "lengthSeconds": "213", "isLiveContent": false }
        });
        let f = parse_player(&p).unwrap();
        assert_eq!((f.duration_s, f.live, f.author.as_str()), (213, false, "Rick Astley"));
        assert!(parse_player(&json!({ "playabilityStatus": { "status": "ERROR" } })).is_err());

        let s = json!({ "contents": { "a": [
            { "shelfRenderer": {} },
            { "videoRenderer": { "videoId": "dQw4w9WgXcQ", "title": { "runs": [{ "text": "Never Gonna" }] },
              "ownerText": { "runs": [{ "text": "Rick Astley" }] }, "lengthText": { "simpleText": "3:33" } } },
            { "videoRenderer": { "videoId": "zzzzzzzzzzz", "title": { "runs": [{ "text": "Other" }] } } }
        ] } });
        let f = parse_search(&s).unwrap();
        assert_eq!((f.video_id.as_str(), f.duration_s, f.title.as_str()), ("dQw4w9WgXcQ", 213, "Never Gonna"));
    }

    #[test]
    fn control_frames_are_tagged() {
        let c: SongControl = serde_json::from_str(r#"{"action":"seek","positionMs":5000}"#).unwrap();
        assert_eq!(c, SongControl::Seek { position_ms: 5000 });
        assert_eq!(serde_json::to_string(&SongControl::Pause).unwrap(), r#"{"action":"pause"}"#);
    }

    #[test]
    fn reads_spotify() {
        let id = Some("4uLU6hMCjMI75M1A2tKUQC".to_string());
        for link in [
            "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
            "https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc",
            "open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
            "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
        ] {
            assert_eq!(spotify_track(link), id, "{link}");
        }
        assert_eq!(spotify_track("https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC"), None);
        let f = parse_spotify_track(&json!({
            "id": "4uLU6hMCjMI75M1A2tKUQC", "name": "Never Gonna Give You Up",
            "duration_ms": 213573, "artists": [{ "name": "Rick Astley" }]
        }))
        .unwrap();
        assert_eq!((f.duration_s, f.author.as_str()), (213, "Rick Astley"));
        assert_eq!(search_words("Rick Astley - Never Gonna Give You Up (Official Video) [4K]"), "Rick Astley Never Gonna Give You Up");
        // RFC 7636 appendix B.
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}

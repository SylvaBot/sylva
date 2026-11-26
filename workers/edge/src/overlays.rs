//! Overlays: each one is a single element (a code widget) that fills its own
//! OBS Browser Source. The streamer sizes and places it in OBS. The list is
//! kept in the channel's config as JSON and sent to overlay pages with the
//! widget data, so an edit shows on stream at once.
//!
//! `alerts` and `chat` are the built-in overlays. They use Sylva's own widget
//! code (put into the overlay page by the server), with the streamer's field
//! values and sounds on top, and they always exist: the plain overlay link
//! and `&widget=chat` show them, so links made before overlays existed keep
//! working.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::*;

use crate::channel::ChannelDo;

const KEY: &str = "overlays";
const MAX_OVERLAYS: usize = 24;
const MAX_SOUNDS: usize = 12;
/// Code and settings for every overlay together.
const MAX_BYTES: usize = 900_000;
pub(crate) const BUILTINS: [&str; 2] = ["alerts", "chat"];

/// A sound the overlay plays when something happens.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sound {
    /// An event kind such as `follow` or `chat`, or `any`.
    pub on: String,
    /// An uploaded file's id (see media.rs).
    pub media: String,
    #[serde(default = "full")]
    pub volume: f64,
}

fn full() -> f64 {
    1.0
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Overlay {
    pub id: String,
    pub name: String,
    /// `alerts` or `chat` for the built-in overlays, which take Sylva's code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<String>,
    /// Field values for a built-in overlay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Value>,
    /// The widget code (html, css, js, fields, values, alerts) for the others.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<Value>,
    #[serde(default)]
    pub sounds: Vec<Sound>,
}

const KINDS: [&str; 11] = [
    "any", "follow", "subscriber", "giftedSub", "communityGift", "cheer", "tip", "redemption",
    "raid", "chat", "alert",
];

/// Check a list sent by the dashboard, and make sure both built-ins are in it.
pub(crate) fn validated(mut list: Vec<Overlay>) -> std::result::Result<Vec<Overlay>, String> {
    if list.len() > MAX_OVERLAYS {
        return Err(format!("Up to {MAX_OVERLAYS} overlays"));
    }
    let mut seen = std::collections::HashSet::new();
    for o in &mut list {
        o.name = o.name.trim().chars().take(60).collect();
        if o.name.is_empty() {
            o.name = "Overlay".into();
        }
        if o.id.is_empty()
            || o.id.len() > 40
            || !o.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || !seen.insert(o.id.clone())
        {
            return Err("Each overlay needs its own id".into());
        }
        match o.builtin.as_deref() {
            Some(b) if BUILTINS.contains(&b) && o.id == b => o.code = None,
            Some(_) => return Err("Unknown built-in overlay".into()),
            None if BUILTINS.contains(&o.id.as_str()) => {
                return Err("That id belongs to a built-in overlay".into())
            }
            None => {
                if !o.code.as_ref().is_some_and(Value::is_object) {
                    return Err(format!("{} has no code", o.name));
                }
                o.values = None;
            }
        }
        if o.sounds.len() > MAX_SOUNDS {
            return Err(format!("Up to {MAX_SOUNDS} sounds on one overlay"));
        }
        for s in &mut o.sounds {
            if !KINDS.contains(&s.on.as_str()) {
                return Err("Unknown event for a sound".into());
            }
            if s.media.is_empty() || s.media.len() > 120 || s.media.contains('/') {
                return Err("Pick a sound file".into());
            }
            s.volume = if s.volume.is_finite() { s.volume.clamp(0.0, 1.0) } else { 1.0 };
        }
    }
    for b in BUILTINS.iter().rev() {
        if !list.iter().any(|o| o.id == *b) {
            list.insert(0, default_overlay(b));
        }
    }
    let bytes = serde_json::to_string(&list).map_or(usize::MAX, |s| s.len());
    if bytes > MAX_BYTES {
        return Err("Your overlays are too large. Remove some code or images.".into());
    }
    Ok(list)
}

fn default_overlay(id: &str) -> Overlay {
    Overlay {
        id: id.into(),
        name: if id == "chat" { "Chat" } else { "Alerts" }.into(),
        builtin: Some(id.into()),
        values: None,
        code: None,
        sounds: Vec::new(),
    }
}

impl ChannelDo {
    /// The channel's overlays, the built-ins first when nothing is saved yet.
    pub(crate) fn overlays(&self) -> Result<Vec<Overlay>> {
        let saved = self
            .config(KEY)?
            .and_then(|v| serde_json::from_str::<Vec<Overlay>>(&v).ok());
        Ok(saved.unwrap_or_else(|| BUILTINS.iter().map(|b| default_overlay(b)).collect()))
    }

    /// Save the list and send it to every overlay on screen.
    pub(crate) fn save_overlays(&self, list: Vec<Overlay>) -> std::result::Result<Vec<Overlay>, String> {
        let list = validated(list)?;
        let text = serde_json::to_string(&list).map_err(|e| e.to_string())?;
        self.set_config(KEY, &text).map_err(|e| e.to_string())?;
        self.send_widget_data().map_err(|e| e.to_string())?;
        Ok(list)
    }

    /// For the widget data: `None` until the streamer saved something, so
    /// overlay pages keep their defaults.
    pub(crate) fn overlays_for_widgets(&self) -> Result<Option<Value>> {
        Ok(self.config(KEY)?.and_then(|v| serde_json::from_str(&v).ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(id: &str) -> Overlay {
        Overlay {
            id: id.into(),
            name: "Mine".into(),
            builtin: None,
            values: None,
            code: Some(serde_json::json!({ "html": "<p>hi</p>" })),
            sounds: vec![],
        }
    }

    #[test]
    fn builtins_are_always_there() {
        let list = validated(vec![custom("a1")]).unwrap();
        let ids: Vec<_> = list.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["alerts", "chat", "a1"]);
    }

    #[test]
    fn rejects_bad_lists() {
        assert!(validated(vec![custom("a1"), custom("a1")]).is_err());
        assert!(validated(vec![custom("chat")]).is_err());
        let mut no_code = custom("x");
        no_code.code = None;
        assert!(validated(vec![no_code]).is_err());
        let mut bad_sound = custom("y");
        bad_sound.sounds.push(Sound { on: "nope".into(), media: "a.mp3".into(), volume: 1.0 });
        assert!(validated(vec![bad_sound]).is_err());
    }
}

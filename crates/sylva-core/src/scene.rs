//! Overlay scenes: every widget on one 1920 by 1080 canvas, placed in the
//! dashboard's editor and shown by a single OBS Browser Source
//! (`/overlay/<channel>?token=...&scene`).
//!
//! The streamer edits a draft. Publishing copies the draft to what overlays
//! show, keeps the previous published versions so one can be restored, and
//! pushes the new layout to every open overlay at once.

use serde::{Deserialize, Serialize};

use crate::alerts::Invalid;

pub const SCENE_WIDTH: f64 = 1920.0;
pub const SCENE_HEIGHT: f64 = 1080.0;
pub const MAX_ITEMS: usize = 24;
/// Published versions kept for Restore.
pub const KEPT_VERSIONS: usize = 20;
/// The smallest a widget may be, so it can still be grabbed in the editor.
pub const MIN_SIZE: f64 = 40.0;

/// A widget on the canvas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WidgetKind {
    Alerts,
    Feed,
    Latest,
    Top,
    Goal,
    Chat,
}

/// Kinds a latest label may follow.
pub const LATEST_LABEL_KINDS: [&str; 5] =
    ["follow", "subscriber", "communityGift", "cheer", "raid"];
/// Kinds a top label may rank.
pub const TOP_LABEL_KINDS: [&str; 2] = ["cheer", "communityGift"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneItem {
    /// Unique within the scene: letters, digits, `-` and `_`, up to 32.
    pub id: String,
    pub widget: WidgetKind,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// For `latest` and `top`: which kind of event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// For `feed` and `chat`: how many rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub items: Vec<SceneItem>,
}

/// A published scene, as overlays receive it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub version: u64,
    pub published_at: i64,
    pub scene: Scene,
}

/// One entry in the version list. The scene itself is fetched on Restore.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: u64,
    pub published_at: i64,
    pub items: usize,
}

/// `GET /v1/channels/{key}/scene`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneState {
    pub draft: Scene,
    /// When the draft was last saved, or 0 when it never was.
    pub draft_saved_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<Published>,
    /// Newest first.
    pub versions: Vec<VersionInfo>,
}

impl Scene {
    /// Check a scene from the editor and tidy it: sizes rounded to whole
    /// pixels and kept on the canvas, options only where they apply.
    pub fn validated(mut self) -> Result<Scene, Invalid> {
        if self.items.len() > MAX_ITEMS {
            return Err(Invalid(format!(
                "A scene can hold up to {MAX_ITEMS} widgets"
            )));
        }
        let mut ids = std::collections::HashSet::new();
        for item in &mut self.items {
            let id_ok = !item.id.is_empty()
                && item.id.len() <= 32
                && item
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            if !id_ok || !ids.insert(item.id.clone()) {
                return Err(Invalid("Each widget needs its own id".into()));
            }
            for v in [item.x, item.y, item.w, item.h] {
                if !v.is_finite() {
                    return Err(Invalid("Widget positions must be numbers".into()));
                }
            }
            item.w = item.w.round().clamp(MIN_SIZE, SCENE_WIDTH);
            item.h = item.h.round().clamp(MIN_SIZE, SCENE_HEIGHT);
            item.x = item.x.round().clamp(0.0, SCENE_WIDTH - item.w);
            item.y = item.y.round().clamp(0.0, SCENE_HEIGHT - item.h);
            match item.widget {
                WidgetKind::Latest => {
                    let k = item.kind.as_deref().unwrap_or("follow");
                    if !LATEST_LABEL_KINDS.contains(&k) {
                        return Err(Invalid(
                            "A latest label shows follows, subs, gifts, cheers or raids".into(),
                        ));
                    }
                    item.kind = Some(k.into());
                    item.limit = None;
                }
                WidgetKind::Top => {
                    let k = item.kind.as_deref().unwrap_or("cheer");
                    if !TOP_LABEL_KINDS.contains(&k) {
                        return Err(Invalid("A top label ranks cheers or gifts".into()));
                    }
                    item.kind = Some(k.into());
                    item.limit = None;
                }
                WidgetKind::Feed => {
                    item.kind = None;
                    item.limit = Some(item.limit.unwrap_or(5).clamp(1, 20));
                }
                WidgetKind::Chat => {
                    item.kind = None;
                    item.limit = Some(item.limit.unwrap_or(12).clamp(1, 30));
                }
                WidgetKind::Alerts | WidgetKind::Goal => {
                    item.kind = None;
                    item.limit = None;
                }
            }
        }
        if self
            .items
            .iter()
            .filter(|i| i.widget == WidgetKind::Alerts)
            .count()
            > 1
        {
            return Err(Invalid("A scene can have one alert box".into()));
        }
        Ok(self)
    }

    pub fn has_alerts(&self) -> bool {
        self.items.iter().any(|i| i.widget == WidgetKind::Alerts)
    }
}

/// The top supporter of one kind, for a top label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopEntry {
    /// `cheer` or `communityGift`.
    pub kind: String,
    pub name: String,
    pub amount: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, widget: WidgetKind) -> SceneItem {
        SceneItem {
            id: id.into(),
            widget,
            x: 10.4,
            y: 20.6,
            w: 300.0,
            h: 100.0,
            kind: None,
            limit: None,
        }
    }

    #[test]
    fn scenes_are_tidied() {
        let mut far = item("b", WidgetKind::Feed);
        far.x = 5000.0;
        far.y = -30.0;
        far.w = 10.0;
        far.limit = Some(99);
        let mut latest = item("c", WidgetKind::Latest);
        latest.limit = Some(3);
        let s = Scene {
            items: vec![item("a", WidgetKind::Alerts), far, latest],
        }
        .validated()
        .unwrap();
        assert_eq!((s.items[0].x, s.items[0].y), (10.0, 21.0));
        assert_eq!(s.items[1].w, MIN_SIZE);
        assert_eq!(s.items[1].x, SCENE_WIDTH - MIN_SIZE);
        assert_eq!(s.items[1].y, 0.0);
        assert_eq!(s.items[1].limit, Some(20));
        assert_eq!(s.items[2].kind.as_deref(), Some("follow"));
        assert_eq!(s.items[2].limit, None);
        assert!(s.has_alerts());
    }

    #[test]
    fn bad_scenes_are_refused() {
        let twice = Scene {
            items: vec![item("a", WidgetKind::Feed), item("a", WidgetKind::Chat)],
        };
        assert!(twice.validated().is_err());
        let two_boxes = Scene {
            items: vec![item("a", WidgetKind::Alerts), item("b", WidgetKind::Alerts)],
        };
        assert!(two_boxes.validated().is_err());
        let mut top = item("a", WidgetKind::Top);
        top.kind = Some("follow".into());
        assert!(Scene { items: vec![top] }.validated().is_err());
        let mut nan = item("a", WidgetKind::Goal);
        nan.x = f64::NAN;
        assert!(Scene { items: vec![nan] }.validated().is_err());
        let bad_id = item("a b", WidgetKind::Goal);
        assert!(Scene {
            items: vec![bad_id]
        }
        .validated()
        .is_err());
        let many = Scene {
            items: (0..=MAX_ITEMS)
                .map(|i| item(&format!("i{i}"), WidgetKind::Goal))
                .collect(),
        };
        assert!(many.validated().is_err());
    }

    #[test]
    fn json_shape() {
        let s: Scene = serde_json::from_str(
            r#"{"items":[{"id":"x","widget":"top","x":0,"y":0,"w":400,"h":60,"kind":"communityGift"}]}"#,
        )
        .unwrap();
        assert_eq!(s.items[0].widget, WidgetKind::Top);
        assert!(s.validated().is_ok());
    }
}

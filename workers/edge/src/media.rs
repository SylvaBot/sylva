//! Uploaded alert sounds and images, kept in the channel's own SQLite (see
//! `sylva_core::media`). Members upload and delete them from the dashboard;
//! anyone with a file's id can load it, like any image on a web page.

use serde::{Deserialize, Serialize};
use sylva_core::media::{
    b64_decode, b64_encode, sniff, type_of, valid_id, CHUNK, MAX_FILE, MAX_FILES, MAX_NAME,
    MAX_TOTAL,
};
use worker::*;

use crate::channel::ChannelDo;
use crate::util::random_hex;

/// One uploaded file, for the dashboard.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFile {
    pub id: String,
    pub name: String,
    pub size: f64,
    pub at: f64,
}

#[derive(Deserialize)]
struct Piece {
    data: String,
}

impl ChannelDo {
    pub(crate) fn media_list(&self) -> Result<Vec<MediaFile>> {
        self.sql
            .exec(
                "SELECT id, name, size, at FROM media ORDER BY at DESC",
                None,
            )?
            .to_array()
    }

    pub(crate) fn media_exists(&self, id: &str) -> Result<bool> {
        Ok(self.media_list()?.iter().any(|m| m.id == id))
    }

    /// Keep an upload. `Err` holds words for the dashboard.
    pub(crate) fn media_add(
        &self,
        name: &str,
        bytes: &[u8],
    ) -> Result<std::result::Result<MediaFile, String>> {
        if bytes.is_empty() {
            return Ok(Err("That file is empty".into()));
        }
        if bytes.len() > MAX_FILE {
            return Ok(Err(format!(
                "Files can be up to {} MB",
                MAX_FILE / 1_000_000
            )));
        }
        let Some((_, ext, _)) = sniff(bytes) else {
            return Ok(Err(
                "Upload an MP3, OGG or WAV sound, or a PNG, JPG, GIF or WebP image".into(),
            ));
        };
        let have = self.media_list()?;
        if have.len() >= MAX_FILES {
            return Ok(Err(format!(
                "You can keep up to {MAX_FILES} files. Delete one first."
            )));
        }
        let total: f64 = have.iter().map(|m| m.size).sum();
        if total as usize + bytes.len() > MAX_TOTAL {
            return Ok(Err(format!(
                "Your files can take up to {} MB in all. Delete one first.",
                MAX_TOTAL / 1_000_000
            )));
        }
        let id = format!("{}.{ext}", random_hex(8)?);
        let name: String = name
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_NAME)
            .collect();
        let name = if name.is_empty() { id.clone() } else { name };
        for (n, piece) in bytes.chunks(CHUNK).enumerate() {
            self.sql.exec(
                "INSERT INTO media_pieces (id, n, data) VALUES (?, ?, ?)",
                vec![
                    id.as_str().into(),
                    (n as f64).into(),
                    b64_encode(piece).into(),
                ],
            )?;
        }
        let at = Date::now().as_millis() as f64;
        self.sql.exec(
            "INSERT INTO media (id, name, size, at) VALUES (?, ?, ?, ?)",
            vec![
                id.as_str().into(),
                name.as_str().into(),
                (bytes.len() as f64).into(),
                at.into(),
            ],
        )?;
        Ok(Ok(MediaFile {
            id,
            name,
            size: bytes.len() as f64,
            at,
        }))
    }

    /// Delete a file, and stop every alert that used it from using it.
    pub(crate) fn media_delete(&self, id: &str) -> Result<()> {
        self.sql
            .exec("DELETE FROM media WHERE id = ?", vec![id.into()])?;
        self.sql
            .exec("DELETE FROM media_pieces WHERE id = ?", vec![id.into()])?;
        self.forget_media_in_alerts(id)
    }

    /// The file, for `GET /media/{channel}/{id}`.
    pub(crate) fn media_file(&self, id: &str) -> Result<Response> {
        if !valid_id(id) {
            return Response::error("Not found", 404);
        }
        let pieces: Vec<Piece> = self
            .sql
            .exec(
                "SELECT data FROM media_pieces WHERE id = ? ORDER BY n",
                vec![id.into()],
            )?
            .to_array()?;
        if pieces.is_empty() {
            return Response::error("Not found", 404);
        }
        let mut bytes = Vec::new();
        for p in pieces {
            bytes.extend(b64_decode(&p.data).unwrap_or_default());
        }
        let mut res = Response::from_bytes(bytes)?;
        let h = res.headers_mut();
        h.set("Content-Type", type_of(id))?;
        // Ids are never reused, so a file never changes.
        h.set("Cache-Control", "public, max-age=31536000, immutable")?;
        h.set("X-Content-Type-Options", "nosniff")?;
        h.set("Content-Security-Policy", "default-src 'none'; sandbox")?;
        h.set("Access-Control-Allow-Origin", "*")?;
        Ok(res)
    }
}

//! `!ask` in the channel's Durable Object: the streamer's AI key, sealed with
//! `SYLVA_TOKEN_KEY`, and the call to their AI. The request and answer shapes
//! are in `sylva_core::ask`. `SYLVA_LOOKUP_URL` points the AI at the test
//! server (`{base}/ai`) instead.

use sylva_core::ask::{
    self as core, answer_text, chat_line, error_line, key_hint, AskSettings, AskUpdate, AskView,
};
use sylva_core::auth::{open, parse_key, seal};
use worker::*;

use crate::builtins::Chatter;
use crate::channel::ChannelDo;
use crate::community::Ask;
use crate::util::random_bytes;

const SETTINGS: &str = "ask_settings";
const KEY: &str = "ask_key";
const HINT: &str = "ask_key_hint";

impl ChannelDo {
    pub(crate) fn ask_settings(&self) -> Result<AskSettings> {
        Ok(self
            .config(SETTINGS)?
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    pub(crate) fn ask_view(&self) -> Result<AskView> {
        let saved = self.config(KEY)?.is_some_and(|k| !k.is_empty());
        Ok(AskView {
            settings: self.ask_settings()?,
            key_hint: if saved {
                self.config(HINT)?.filter(|h| !h.is_empty())
            } else {
                None
            },
        })
    }

    fn seal_key(&self) -> Result<[u8; 32]> {
        parse_key(&self.env.secret("SYLVA_TOKEN_KEY")?.to_string())
            .ok_or_else(|| Error::RustError("SYLVA_TOKEN_KEY is not a 64 character hex key".into()))
    }

    /// Save the streamer's `!ask` choices. A new key is sealed before it is
    /// stored and is never sent back.
    pub(crate) fn save_ask(
        &self,
        update: AskUpdate,
    ) -> Result<std::result::Result<AskView, String>> {
        let clear = update.clear_key;
        let (settings, key) = match update.validated() {
            Ok(v) => v,
            Err(m) => return Ok(Err(m)),
        };
        self.set_config(SETTINGS, &serde_json::to_string(&settings)?)?;
        if let Some(k) = key {
            self.set_config(KEY, &seal(&self.seal_key()?, random_bytes()?, &k))?;
            self.set_config(HINT, &key_hint(&k))?;
        } else if clear {
            self.set_config(KEY, "")?;
            self.set_config(HINT, "")?;
        }
        Ok(Ok(self.ask_view()?))
    }

    fn ask_key(&self) -> Result<Option<String>> {
        match self.config(KEY)?.filter(|k| !k.is_empty()) {
            Some(sealed) => Ok(open(&self.seal_key()?, &sealed)),
            None => Ok(None),
        }
    }

    /// Answer `!ask`. Empty means say nothing.
    pub(crate) async fn ask_reply(
        &self,
        args: &[String],
        ask: &Ask<'_>,
        who: &Chatter<'_>,
    ) -> Result<String> {
        let Some(key) = self.ask_key()? else {
            // Viewers in a channel without a key see nothing; the test chat
            // tells the streamer what is missing.
            return Ok(if ask.dry {
                "Add an AI API key under Ask on the Bot page to turn on !ask.".into()
            } else {
                String::new()
            });
        };
        let Some(question) = core::question(args) else {
            return Ok(format!(
                "@{} Ask a question, such as !ask why is the sky blue?",
                who.name
            ));
        };
        let settings = self.ask_settings()?;
        let system = core::system_prompt(ask.channel, who.name, &settings.instructions);
        let base = self.var("SYLVA_LOOKUP_URL").map(|b| format!("{b}/ai"));
        let req = core::request(&settings, &key, &system, &question, base.as_deref());

        let headers = Headers::new();
        headers.set("Content-Type", "application/json")?;
        for (name, value) in &req.headers {
            headers.set(name, value)?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(req.body.to_string().into()));
        let request = Request::new_with_init(&req.url, &init)?;
        let signal = AbortSignal::from(web_sys::AbortSignal::timeout_with_u32(core::TIMEOUT_MS));
        let mut res = match Fetch::Request(request).send_with_signal(&signal).await {
            Ok(r) => r,
            Err(_) => return Ok(error_line(settings.provider, 0)),
        };
        let status = res.status_code();
        if status != 200 {
            console_log!("!ask: {} answered {status}", settings.provider.label());
            return Ok(error_line(settings.provider, status));
        }
        let Some(answer) = res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| answer_text(settings.provider, &v))
        else {
            return Ok(error_line(settings.provider, 0));
        };
        let line = chat_line(who.name, &answer);
        if sylva_core::moderation::blocks_bot_text(&self.mod_settings()?, &line) {
            return Ok(format!("@{} I can't answer that one here.", who.name));
        }
        Ok(line)
    }
}

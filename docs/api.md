# The Sylva API for apps such as Cortex

Apps sign in to a streamer's Sylva with a device code, then call the same API the dashboard uses with an API token. All bodies are JSON.

## Signing in (device code)

The flow follows OAuth's device authorization grant (RFC 8628).

1. **Start.** `POST /v1/device/code` with `{"clientName": "Cortex"}`. The reply:

   ```json
   {
     "device_code": "64 hex characters, keep it private",
     "user_code": "BCDF-GHJK",
     "verification_uri": "https://sylva-edge.haruxe.workers.dev/device",
     "verification_uri_complete": "https://sylva-edge.haruxe.workers.dev/device?code=BCDF-GHJK",
     "expires_in": 600,
     "interval": 5
   }
   ```

2. **Show the code.** Show `user_code` and open `verification_uri_complete` in the browser. The streamer signs in with Twitch if needed and presses Allow.

3. **Poll.** Every `interval` seconds, `POST /v1/device/token` with `{"deviceCode": "..."}`. Until the streamer answers, the reply is a 400 with `{"error": "authorization_pending"}`. Other errors: `slow_down` (wait longer between polls), `access_denied` (the streamer pressed Deny), `expired_token` (the code expired, or the token was already handed out: start again). On success:

   ```json
   { "access_token": "sylva_<account id>.<secret>", "token_type": "Bearer", "account_id": "..." }
   ```

   The token is handed out once. Store it like a password (on Windows, in Credential Manager).

## Calling the API

Send `Authorization: Bearer sylva_...` on every request. API tokens do not expire on their own; the streamer can remove an app in Settings, after which calls get 401 and the app should sign in again.

| Call | What it does |
| --- | --- |
| `GET /v1/me` | The account, its Twitch identity and its channels. The channel key, such as `twitch:12826`, is in `channels[0].key`. |
| `GET /v1/channels/{key}/history?filter=alerts&limit=100&before=&q=` | Events, newest first. `filter` is `alerts`, `chat` or left out for both. `q` searches names and messages. |
| `GET /v1/channels/{key}/summary?since=<ms>` | Counts by kind since a time, and bits. |
| `GET /v1/channels/{key}/state` | The alert queue: `paused`, `muted`, `playing`, `queued`, `overlaysConnected`. |
| `POST /v1/channels/{key}/alerts/{pause,resume,mute,unmute,skip}` | Control the alert queue. Returns the new state. |
| `POST /v1/channels/{key}/alerts/replay/{seq}` | Play an old event's alert next. |
| `POST /v1/channels/{key}/test-event` | `{"kind": "follow", "name": "Maple", "amount": 5, "message": "..."}`. The reply says whether it went into the alert queue (`alert`). |
| `GET` / `POST /v1/channels/{key}/alert-settings` | Per kind alert settings. |
| `GET` / `POST /v1/channels/{key}/widget-settings` | The goal. |
| `GET /v1/channels/{key}/scene` | The overlay layout: `draft`, `published` (with `version`) and `versions`. |
| `POST /v1/channels/{key}/scene`, `.../scene/publish`, `.../scene/restore/{version}` | Save the draft, publish it, or bring a version back into the draft. |
| `GET /v1/channels/{key}/ws` | The live socket. Send `{"type":"hello","role":"feed","lastSeq":N}` first; see `crates/sylva-core/src/protocol.rs`. |

An app cannot approve other apps or list or remove them; those need the streamer in the browser.

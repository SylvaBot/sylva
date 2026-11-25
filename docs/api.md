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
| `GET` / `POST /v1/channels/{key}/bot` | The chat bot: on or off, its commands and its timers. The answer also says when each timer posts next, or what it waits for. |
| `POST /v1/channels/{key}/bot/try` | `{"message": "!lurk", "level": "everyone"}`. What the bot would answer, without sending. |
| `POST /v1/channels/{key}/bot/timers/{id}/send` | Posts a timer now and restarts its clock. 404 for an unknown timer, 409 while the bot is off. |
| `POST /v1/channels/{key}/bot/counters/{name}/set` | `{"value": 10}`. Sets a counter. |
| `GET` / `POST /v1/channels/{key}/bot/quotes` | Every quote, or `{"text", "by", "game"}` to add one. `id` and `at` put a removed quote back under its old number. |
| `POST /v1/channels/{key}/bot/quotes/{id}` and `.../{id}/delete` | Edit or remove a quote. |
| `GET` / `POST /v1/channels/{key}/moderation` | Moderation rules: `preset`, `rules`, `exempt`, `steps`, `words`, `allowedLinks`, `notice`. The answer adds `permission` (`ok`, `missing` or `expired`) and what each preset sets. |
| `POST /v1/channels/{key}/moderation/try` | `{"message": "...", "level": "everyone", "settings": {...}}`. Which rule the message breaks, if any, without acting. `settings` is optional, to try unsaved rules. |
| `GET /v1/channels/{key}/moderation/log?before=&limit=50` | What Sylva did, newest first. |
| `POST /v1/channels/{key}/moderation/log/{id}/undo` | Lifts a timeout that is still running. 409 for a removed message, which Twitch cannot bring back. |
| `GET` / `POST /v1/channels/{key}/loyalty` | Loyalty points: `enabled`, `name`, `watch`, `active`, `follow`, `sub`, `gift`, `cheer`, `give`. The answer adds `permission` for the chat list, `live`, `botOn`, `viewers` and `everyMinutes`. |
| `GET /v1/channels/{key}/loyalty/viewers?q=&limit=50&offset=0` | Viewers with points, most first: `id`, `login`, `name`, `balance`, `earned`, and `total`. |
| `POST /v1/channels/{key}/loyalty/viewers/{id}/adjust` | `{"delta": 100, "reason": "Won the raffle"}`. A minus delta takes points away, never below zero. |
| `GET /v1/channels/{key}/loyalty/viewers/{id}/ledger` | The viewer's newest 100 changes, with their reasons. |
| `GET` / `POST /v1/channels/{key}/loyalty/store` | The points store: `enabled` and `items` (`id`, `name`, `description`, `cost`, `enabled`, `stock` or null, `cooldown` in minutes, `input`). Ids are the server's. The answer adds `pointsOn`, `pointsName`, `botOn`, `login` and `pending`. |
| `GET /v1/channels/{key}/loyalty/redemptions?status=pending&before=&limit=50` | Redemptions: waiting ones oldest first, or `status=done` for done and refunded, newest first. |
| `POST /v1/channels/{key}/loyalty/redemptions/{id}/done`, `.../reopen`, `.../refund` | Settle a redemption. A refund gives the points back and returns a limited reward to the stock. 409 when it is already in that state. |
| `GET /v1/public/{login}?viewer=` | No sign in. A channel's rewards, its top ten and, with `viewer`, one viewer's points. 404 when the channel has no points. |
| `GET /v1/channels/{key}/scene` | The overlay layout: `draft`, `published` (with `version`) and `versions`. |
| `POST /v1/channels/{key}/scene`, `.../scene/publish`, `.../scene/restore/{version}` | Save the draft, publish it, or bring a version back into the draft. |
| `GET /v1/channels/{key}/ws` | The live socket. Send `{"type":"hello","role":"feed","lastSeq":N}` first; see `crates/sylva-core/src/protocol.rs`. |

An app cannot approve other apps or list or remove them; those need the streamer in the browser.

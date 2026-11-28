# The Sylva API for apps such as Sylva Control

Apps sign in to a streamer's Sylva with a device code, then call the same API the dashboard uses with an API token. All bodies are JSON.

## Signing in (device code)

The flow follows OAuth's device authorization grant (RFC 8628).

1. **Start.** `POST /v1/device/code` with `{"clientName": "Sylva Control"}`. The reply:

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
| `GET /v1/me` | The account, its Twitch identity and its channels, each with `key`, `role` (`owner`, `editor`, `moderator` or `viewer`), `name`, `login` and `avatar`. The account's own channel comes first, such as `twitch:12826` in `channels[0].key`; channels it helps run follow. A role's limits are listed under Team in [site.md](site.md); a refused call gets 403 with the reason. |
| `GET /v1/channels/{key}/team` | The owner only: the team, each with `id`, `login`, `name`, `avatar`, `role`, `addedAt` and `joined` (has signed in to Sylva), and `max`. |
| `POST /v1/channels/{key}/team`, `.../team/{id}/remove` | The owner only. `{"login": "name", "role": "editor"}` adds someone by Twitch name or changes their role; 404 for an unknown name, 409 when the team is full. |
| `GET /v1/channels/{key}/history?filter=alerts&limit=100&before=&q=` | Events, newest first. `filter` is `alerts`, `chat` or left out for both. `q` searches names and messages. |
| `GET /v1/channels/{key}/summary?since=<ms>` | Counts by kind since a time, and bits. |
| `GET /v1/channels/{key}/state` | The alert queue: `paused`, `muted`, `playing`, `queued`, `overlaysConnected`. |
| `POST /v1/channels/{key}/alerts/{pause,resume,mute,unmute,skip}` | Control the alert queue. Returns the new state. |
| `POST /v1/channels/{key}/alerts/replay/{seq}` | Play an old event's alert next. |
| `POST /v1/channels/{key}/alerts/reload` | Every overlay of the channel loads its page again (as OBS's Refresh would). Returns the state. |
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
| `GET` / `POST /v1/channels/{key}/giveaways` | Giveaways: `current` (or null), its newest 500 `entries`, the last 20 `past`, and `pointsOn`, `pointsName`, `botOn`. A post starts one with `prize`, `keyword`, `level`, `cost` and `subLuck`; 409 when one is running, 400 for a chat word Sylva already uses. |
| `POST /v1/channels/{key}/giveaways/{id}/close`, `.../draw`, `.../end`, `.../cancel` | Run the current giveaway. A draw closes entries and adds a winner; cancel gives entry costs back and is refused once someone has won. Each giveaway has `seedHash` from the start and `seed` once a winner is drawn or it is over. |
| `GET /v1/public/{login}?viewer=` | No sign in. A channel's rewards, its top ten and, with `viewer`, one viewer's points. 404 when the channel has no points. |
| `GET /v1/channels/{key}/scene` | The overlay layout: `draft`, `published` (with `version`) and `versions`. |
| `POST /v1/channels/{key}/scene`, `.../scene/publish`, `.../scene/restore/{version}` | Save the draft, publish it, or bring a version back into the draft. |
| `GET /v1/channels/{key}/ws` | The live socket. Send `{"type":"hello","role":"feed","lastSeq":N}` first; see `crates/sylva-core/src/protocol.rs`. |

An app cannot approve other apps or list or remove them; those need the streamer in the browser.

## Song requests

Viewers add songs with `!sr`; Sylva keeps the queue and the song up now, and
Sylva Control plays the audio and reports what it is doing. Types are in
`crates/sylva-core/src/songs.rs`.

| Route | Does |
| --- | --- |
| `GET songs` | `SongsView`: settings, `current`, `queue`, `playback`, `playerOnline`, `history` |
| `POST songs/settings` | Save `SongSettings` (editors and the owner) |
| `POST songs/add` `{ query }` | Add a link or a search, as the streamer |
| `POST songs/next` `{ from }` | Finish the song up now and start the next. `from` is the song id the caller thinks is up; a stale id does nothing, so a track end and a skip never skip twice |
| `POST songs/{id}/remove`, `POST songs/{id}/move` `{ to }`, `POST songs/clear` | Change the queue. Removing the song up now skips it |
| `POST songs/control` | A `SongControl` (`play`, `pause`, `seek`, `volume`) for the player, sent to every feed socket as `songControl` |
| `POST songs/player` | The player's `Playback`: `songId`, `playing`, `positionMs`, `volume`, `status`. Send it on every change and every 10 seconds while open; `playerOnline` turns false 45 seconds after the last one |

Feed sockets also get `songs` frames (a `SongsView`) whenever any of it
changes. `GET /v1/public/{login}/songs` is the queue for the public channel
page, without viewer ids.

# The Sylva website

Sylva is a website, not a desktop window. It has two parts, served by the same Worker from one origin.

![Landing page](site/landing.png)

## The landing page, `/`

What Sylva is, what it does, and three steps to start, with Continue with Twitch at the top and bottom. If a sign in fails, the reason shows under the button. Signed in visitors see Open dashboard instead. Unknown pages show a short Page not found.

## Other public pages

* `/privacy`: what Sylva keeps, why, who can see it, where it is stored, and how to delete it. Linked from every public page's footer and from Delete account.
* `/device`: where a streamer approves an app such as Cortex (see [api.md](api.md)).

## Deleting an account

Settings, Delete account, then type the Twitch name to confirm. `POST /v1/account/delete` (browser session and same origin only; the body is `{"confirm": "<twitch login>"}`):

1. Asks Twitch to stop every EventSub subscription for the user. If Twitch does not confirm, nothing is deleted and the page says to try again.
2. Erases the account (identities, sessions, API tokens), every channel it owns (events, alerts, settings, goal, overlay links; open overlays are closed) and its directory entries, so signing in again starts a fresh account.
3. Revokes the Twitch token and clears the cookie. The browser lands on `/` with a note that the account was deleted.

## The dashboard, `/app`

A sidebar with the pages, the live connection and the signed in channel. On phones the sidebar becomes a drawer behind a menu button. Every page has its own address, so links, reloads and the back button work. Visiting `/app` signed out goes to the landing page, and signing in lands on `/app`.

| Page | Path | What it is for |
| --- | --- | --- |
| Overview | `/app` | The last 24 hours (followers, subs, bits, raids), a setup checklist until the overlay and a test alert are done, recent activity, alert controls and chat. |
| Activity | `/app/activity` | Every event, newest first, with filters by kind, search by name or message, and Show older. Search runs on the server, so it covers all history. |
| Alerts | `/app/alerts` | Mute, pause and skip; alert types (on or off, minimum amount, time on screen, label and message, with a live preview); a test alert for each kind; Replay on recent alerts. |
| Overlay | `/app/overlay` | The overlay editor (every widget on one canvas, published to one link), the goal, single widget links for anyone who prefers one source per widget, New links, and the steps for OBS. |
| Chat | `/app/chat` | Chat, live and read only. |
| Chat bot | `/app/bot` | Turn the bot on, edit its commands and timers, and a test chat that shows what it would answer. |
| Settings | `/app/settings` | The account and Sign out, the theme (Dark, Light or System), connected apps, which Twitch events reach Sylva, and Delete account. |

![Overview](site/overview.png)
![Activity](site/activity.png)
![Alerts](site/alerts.png)
![Alert types](site/alert-types.png)
![Overlay](site/overlay.png)
![Settings in the light theme](site/settings-light.png)
![Overview on a phone](site/phone.png)

## Design

The look takes Cortex's ideas, not its layout: neutral grays, one color per kind of event used everywhere that kind appears, flat cards with 1 px borders, Inter with tabular numbers, a white primary button, and short calm motion. Dark is the default. The light theme uses the same tokens with lighter values, and the choice is applied before the page paints, so it never flashes.

## How it was checked

* Accessibility: axe finds no WCAG 2.1 AA issues on 52 page states (every page in both themes, the alert editor, the overlay editor with each menu open and a widget selected, the chat bot with a command open, a new command, the test chat, and a timer open and a new timer, search, device approval, the phone drawer, privacy and the delete form). Text contrast is at least 4.5 to 1. The phone drawer moves focus in and back out and makes the page behind it inert.
* Security headers: the website sends a Content-Security-Policy with its one inline script allowed by hash, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy`. `app.js` and `index.css` are linked with a content hash and cached for a year.

* Every page driven in Chromium with Playwright at 1440 px and at 390 px (phone), in both themes: sign in through the fake Twitch, live events, search, theme change, the phone drawer, and sign out. No page scrolls sideways on a phone.
* `npm run test:e2e` adds a check for history search: names and messages match regardless of case, and `%` and `_` are taken literally.
* It checks the chat bot against the fake Twitch: off by default, levels, cooldowns, moderators skipping them, aliases, counts a save cannot change, echoes ignored, the test chat sending nothing, and timers (refused variables, waiting for chat lines and for going live, going live restarting them, Send now, the bot's own posts not counting as chat, and Send now refused while the bot is off). When a timer is due is covered by unit tests.
* It also checks the overlay editor (bad layouts are refused, drafts are tidied, publishing pushes the layout to overlays on screen, versions and restore work) and top labels (cheers add up per viewer and reach widgets live).

## Alert types

Each kind of alert (follows, subs, gifted subs, cheers, raids, tips, channel points) has:

* **On or off.** Off still records the event in Activity; it just does not play.
* **Play from** a minimum amount, for kinds with an amount: bits, raid viewers, subs in a gift, tip amount. Smaller ones only go to Activity.
* **On screen for** 2 to 20 seconds.
* **Label and message.** The message can use `{name}`, `{amount}` and, for channel points, `{reward}`.
* **Show what the viewer wrote**, for cheers, subs and tips.

The channel applies these on the server (`crates/sylva-core/src/alerts.rs`): it decides what goes into the queue, and every `play` frame carries the finished text and time on screen, so all overlays show the same thing and old overlay links need no change. A `duration` in an overlay link still overrides the time for that overlay. Test alerts follow the settings too, and the dashboard says when a test only went to Activity.

## The overlay editor

The top of the Overlay page. Every widget sits on one 1920 by 1080 canvas, and the whole layout is one Browser Source in OBS: the overlay link with `&scene` added.

* **Add widget** places an alert box, event list, latest label, top label, goal bar or chat box (one alert box per layout). **Templates** starts from Gameplay, Just chatting or Minimal. **Try it** sends a test event, so an open overlay shows the alert and its labels update. The previews on the canvas use example names.
* Drag to move, pull a corner to resize. Widgets snap to the canvas edges and centers and to each other, with guides; hold Alt to place freely. Arrow keys nudge by 1 px (Shift for 10), Delete removes, Escape deselects, and Undo and Redo work with Ctrl+Z and Ctrl+Shift+Z.
* The panel beside the canvas sets exact position and size, the kind for latest and top labels, how many rows for the event list and chat, and the stacking order.
* Changes save as a draft on their own. **Publish** makes a new version and every open overlay switches to it at once. **History** keeps the last 20 published versions; Restore to draft brings one back to check before publishing it again.

The draft and versions live in the channel's Durable Object (`GET /v1/channels/{key}/scene`, `POST .../scene` for the draft, `POST .../scene/publish`, `POST .../scene/restore/{version}`). The server checks every layout: known widgets only, unique ids, sizes kept on the canvas, at most 24 widgets.

![The overlay editor](site/editor.png)

## The chat bot

Off until the streamer turns it on. When a chat line starts with `!` and names a command, the channel's Durable Object checks who may use it and its cooldowns, counts it, writes the reply and sends it with Twitch's Send Chat Message API and Sylva's app token. The `user:bot` and `channel:bot` scopes granted at sign in are what Twitch needs for that, and the reply shows Twitch's Chat Bot badge.

* **Who replies.** The streamer's own account by default, so it works with no setup. A shared Sylva bot account replies instead once `SYLVA_BOT_USER_ID` and `SYLVA_BOT_LOGIN` are set: sign in to that account at `/auth/twitch/bot` (it asks only for `user:bot`) and it shows the two values.
* **Commands.** Every channel starts with `!commands`, `!uptime`, `!lurk` and `!so` (moderators), which are ordinary commands to change or delete. A command has other names, a reply of up to 500 characters, who may use it (everyone, subscribers, VIPs, moderators, or only the streamer) and cooldowns for everyone and per viewer. Moderators skip cooldowns. Up to 100 commands.
* **Variables** use StreamElements' style so imported commands keep working: `${user}`, `${touser}`, `${1}` to `${9}`, `${args}`, `${channel}`, `${count}`, `${uptime}`, `${random.1-100}` and `${commands}`. A reply with `${uptime}` while offline says the channel is offline. Unknown variables are refused when saving.
* **Test chat** runs a line through the same code on the server without sending it, as a viewer, subscriber, VIP, moderator or the streamer. The editor's preview uses it too, with the unsaved command.
* **Echoes.** The bot remembers what it sent for a minute, so its own reply coming back through chat is never read as a command.
* Deleting a command or a timer offers Undo.

### Timers

Messages the bot posts on a schedule, such as a follow reminder or a Discord link. Up to 20.

* **When.** Every 5 minutes to 3 hours, and only once at least a set number of chat lines (0 to 100) have been sent since the last post, so the bot never talks to an empty room. Lines the bot sent itself do not count. A timer can post only while live (the default) or at any time.
* **How.** The channel's Durable Object keeps one alarm for both alerts and timers, set for whichever is due first. Due timers post one at a time, at least 30 seconds apart. Going live restarts every timer's clock, so nothing fires the moment a stream starts.
* **Variables.** `${channel}`, `${uptime}`, `${commands}` and `${random.1-100}`. Variables about a viewer are refused, because no viewer started the message.
* **The list** shows each timer's rule and what it waits for: the next post time, more chat lines, going live, or the bot being turned on. Send now posts it at once and restarts its clock.

`GET` and `POST /v1/channels/{key}/bot` hold the settings (use counts are the server's and a save cannot change them); `POST .../bot/try` is the test chat; `POST .../bot/timers/{id}/send` is Send now.

![The chat bot](site/bot.png)

## Widgets

Every widget is the overlay page with `&widget=` added to the same private link, so one token covers them all and New links replaces them all at once. Each is its own Browser Source in OBS, at the size the dashboard shows.

| Widget | Link adds | Shows |
| --- | --- | --- |
| Alert box | nothing | Alerts, one at a time, as set in Alerts. |
| Event list | `&widget=feed` (`&limit=` 1 to 20, default 5) | The newest follows, subs, gifts, cheers, raids, tips and redemptions. |
| Latest label | `&widget=latest&kind=follow` (or `subscriber`, `communityGift`, `cheer`, `raid`) | One line with the latest of that kind. |
| Top label | `&widget=top&kind=cheer` (or `communityGift`) | The top cheerer or gifter since the stream went live (or the last 24 hours when Sylva has not seen it go live). |
| Goal bar | `&widget=goal` | The goal set on the Overlay page: followers, subs (new, resubs and each gifted sub) or bits, counted from when it was started. |
| Chat box | `&widget=chat` (`&limit=` 1 to 30, default 12) | Chat lines as they arrive. |

Widgets connect with the `widget` role: on connect they get a `widgets` frame (recent events, the latest of each kind, recent chat and the goal with its progress) and then follow live `event` frames, plus `top` frames when the top cheerer or gifter may have changed. A `?scene` overlay also gets the published layout in the `widgets` frame, and a new one whenever it is published. They never receive `play` frames and do not count as connected alert boxes, so they cannot hold up the alert queue. Saving the goal sends a fresh `widgets` frame to every widget on screen. The goal lives in `GET` and `POST /v1/channels/{key}/widget-settings`.

![Widgets on the Overlay page](site/widgets.png)

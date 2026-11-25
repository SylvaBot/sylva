# Sylva

A friendly web toolkit for streamers: alerts, overlays, an activity feed, and later a chatbot and loyalty points. Twitch first, with room for YouTube, Kick, TikTok, Rumble and Facebook. Cortex (the desktop app in `haruxee/pine`) will connect to Sylva instead of StreamElements.

This repository is in **Phase 1**. Streamers sign in with Twitch, and Sylva picks up their follows, subs, cheers, raids and chat, plays alerts on an overlay for OBS, and shows everything on its website: a landing page at `/` and a dashboard at `/app`. Read [docs/phase-1.md](docs/phase-1.md) and [docs/site.md](docs/site.md) for what is built and what comes next, and [docs/phase-0-findings.md](docs/phase-0-findings.md) for the tests behind the architecture.

## Layout

| Path | What it is |
| --- | --- |
| `crates/sylva-core` | Plain Rust with no Cloudflare code: the normalized event model, Twitch EventSub verification and parsing, the realtime protocol, and sign in helpers (scopes, cookies, token encryption). Cortex can depend on it too. |
| `workers/edge` | The Cloudflare Worker (Rust compiled to WebAssembly with workers-rs). Twitch sign in and webhooks, the API, and three kinds of Durable Object: `ChannelDo` per channel, `AccountDo` per account, and one `DirectoryDo`. |
| `workers/edge/overlay` | The alert overlay for OBS, styled like Cortex. |
| `web` | The website: the landing page and the dashboard, in React and TypeScript, built with Vite. Its look takes Cortex's ideas (neutral grays, one color per kind of event, flat cards) and lays them out as a site. It is built into the Worker (`workers/edge/build.rs`), so one deploy carries everything. |
| `tools` | Node scripts that test a running Worker the way Twitch, OBS and the dashboard would, plus a fake Twitch for sign in tests. |

## Run it locally

You need Rust (stable, with the `wasm32-unknown-unknown` target), Node 22 and `worker-build`:

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.9.0 --locked
npm install
cp workers/edge/.dev.vars.example workers/edge/.dev.vars
npm run dev:test       # Worker and dashboard on http://localhost:8787, using a fake Twitch
npm run fake-twitch    # in another terminal, to sign in from a browser
```

Open `http://localhost:8787` and press **Continue with Twitch**. The fake Twitch signs you in as `sylvatester` at once. To sign in with real Twitch locally, run `npm run dev` instead and put the app's real secret in `.dev.vars` (the app needs `http://localhost:8787/auth/twitch/callback` as a redirect URL).

`npm run dev` and `dev:test` build the dashboard into the Worker, and rebuild when you save a Rust file. While working on the dashboard, `npm run dev:web` serves it with hot reload on `http://localhost:5173` and passes API calls to the Worker.

Tests, with the Worker running under `dev:test`:

```sh
cargo test -p sylva-core     # unit tests
npm run test:e2e             # webhooks, alerts, overlay links and sign in (SKIP_SLOW=1 skips the 30 s check)
npm run test:burst           # raid burst against one channel
```

## API

| Route | Does |
| --- | --- |
| `GET /auth/twitch/start` | Sign in with Twitch |
| `GET /auth/twitch/callback` | Where Twitch sends the streamer back |
| `POST /auth/sign-out` | Sign out |
| `GET /v1/me` | Who is signed in and which channels they manage |
| `POST /twitch/eventsub` | Twitch EventSub webhook (the conduit's webhook shard points here) |
| `GET /v1/channels/{key}/ws` | Realtime socket. Protocol in `crates/sylva-core/src/protocol.rs` |
| `GET /v1/channels/{key}/state` | Alert state: paused, muted, playing, queued, overlays connected |
| `GET /v1/channels/{key}/events?after=&limit=` | The event log, oldest first |
| `GET /v1/channels/{key}/history?before=&limit=&filter=` | The event log, newest first. `filter` is `alerts`, `chat` or `all` |
| `GET /v1/channels/{key}/summary?since=` | Counts by kind and bits since a time (Unix ms) |
| `POST /v1/channels/{key}/alerts/{pause,resume,mute,unmute,skip}` | Control alerts |
| `POST /v1/channels/{key}/alerts/replay/{seq}` | Show an old event again, next |
| `POST /v1/channels/{key}/alerts/play-next/{alertId}` | Move a queued alert to the front |
| `POST /v1/channels/{key}/test-event` | Make a fake alert |
| `GET /v1/channels/{key}/overlay` | The overlay link for OBS |
| `POST /v1/channels/{key}/overlay/rotate` | Replace the overlay link. The old one stops working at once |
| `GET /v1/channels/{key}/twitch` | Which Twitch events are on |
| `POST /v1/channels/{key}/twitch/subscribe` | Turn them on again |
| `GET /overlay/{key}?token=` | The overlay page |

`{key}` is a channel such as `twitch:12826` (the broadcaster's Twitch user id).

Channel routes need the channel's signed in owner (the session cookie), or `Authorization: Bearer <SYLVA_ADMIN_TOKEN>` for tests and setup. Changes made with the cookie must come from Sylva's own pages. An overlay link's token opens the socket as an overlay and nothing else: it cannot read the log or chat.

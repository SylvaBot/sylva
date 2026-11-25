# Sylva

A friendly web toolkit for streamers: alerts, overlays, an activity feed, and later a chatbot and loyalty points. Twitch first, with room for YouTube, Kick, TikTok, Rumble and Facebook. Cortex (the desktop app in `haruxee/pine`) will connect to Sylva instead of StreamElements.

This repository is at **Phase 0**: a working skeleton that proves the risky parts of the plan. Read [docs/phase-0-findings.md](docs/phase-0-findings.md) for what was tested and what came out.

## Layout

| Path | What it is |
| --- | --- |
| `crates/sylva-core` | Plain Rust with no Cloudflare code: the normalized event model, Twitch EventSub verification and parsing, and the realtime protocol. Cortex can depend on it too. |
| `workers/edge` | The Cloudflare Worker (Rust compiled to WebAssembly with workers-rs). Receives Twitch webhooks, serves the API, and holds one `ChannelDo` Durable Object per channel. |
| `workers/edge/overlay` | A small test overlay for OBS, styled like Cortex. |
| `tools` | Node scripts that test a running Worker the way Twitch, OBS and Cortex would. |

## Run it locally

You need Rust (stable, with the `wasm32-unknown-unknown` target), Node 22 and `worker-build`:

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.9.0 --locked
npm install
cp workers/edge/.dev.vars.example workers/edge/.dev.vars
npm run dev            # Worker on http://localhost:8787
```

Then, in another terminal:

```sh
cargo test -p sylva-core     # unit tests
npm run test:e2e             # webhook, alert and replay checks (SKIP_SLOW=1 skips the 30 s one)
npm run test:burst           # raid burst against one channel
```

Open `http://localhost:8787/overlay/twitch:123?debug` to see the overlay, and send it a test alert:

```sh
curl -X POST localhost:8787/v1/channels/twitch:123/test-event \
  -H "Authorization: Bearer local-dev-admin-token" \
  -d '{"kind":"raid","name":"Friend","amount":42}'
```

## API (Phase 0)

| Route | Does |
| --- | --- |
| `POST /twitch/eventsub` | Twitch EventSub webhook (point a conduit's webhook shard here) |
| `GET /v1/channels/{key}/ws` | Realtime socket. Protocol in `crates/sylva-core/src/protocol.rs` |
| `GET /v1/channels/{key}/state` | Alert state: paused, muted, playing, queued, overlays connected |
| `GET /v1/channels/{key}/events?after=&limit=` | Read the event log |
| `POST /v1/channels/{key}/alerts/{pause,resume,mute,unmute,skip}` | Control alerts |
| `POST /v1/channels/{key}/alerts/replay/{seq}` | Show an old event again, next |
| `POST /v1/channels/{key}/alerts/play-next/{alertId}` | Move a queued alert to the front |
| `POST /v1/channels/{key}/test-event` | Make a fake alert |
| `GET /overlay/{key}` | The test overlay |

`{key}` is a channel such as `twitch:12826` (the broadcaster's Twitch user id). POST routes under `/v1` need `Authorization: Bearer <SYLVA_ADMIN_TOKEN>` for now.

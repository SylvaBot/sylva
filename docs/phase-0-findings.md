# Phase 0 findings

Phase 0 had one job: prove the risky parts of the plan before building features on them. The plan picked Rust on Cloudflare Workers, one Durable Object per channel, and Twitch EventSub through webhooks. This page says what was tested, how, and what came out.

**Short version:** nothing blocks the plan. Every Durable Object feature we need works from Rust, the bundle is tiny next to the limit and starts in 5 ms, real Twitch verified our webhook shard, alerts survive an OBS reload in a real browser, and one channel takes about 600 to 780 events per second on Cloudflare with nothing lost.

All tests below ran on 25 Nov 2026 with workers-rs 0.9.0, wrangler 4.159.0 and Rust 1.97, locally under `wrangler dev` (the same workerd runtime Cloudflare uses) and on Cloudflare at `sylva-edge.haruxe.workers.dev`.

## 1. Rust Durable Objects in workers-rs

**Result: works.** `ChannelDo` (in `workers/edge/src/channel.rs`) uses all three features the plan depends on.

| Feature | How Sylva uses it | Tested by |
| --- | --- | --- |
| SQLite storage | Event log, alert queue and settings tables | Every e2e check |
| Hibernating websockets | Overlay and feed sockets, with the role stored as a socket attachment so it survives hibernation | Replay, reload and live checks |
| Auto response | `{"type":"ping"}` is answered by the runtime without waking the object, so keepalives are free | Overlay page keepalive |
| Alarms | An alert nobody acknowledges times out after 30 seconds | The 30 second alarm check |

Things worth knowing for later work:

* **`set_alarm(i64)` takes an offset, not a timestamp.** Passing `now + 30_000` scheduled the alarm about 56 years out. The alarm test caught it. The code now passes a `Duration` so the intent is clear.
* Durable Object handlers take `&self`, so in memory state uses `Cell` or `RefCell`.
* SQL integers come back as JavaScript numbers, so row structs read them as `f64`.
* SQL calls are synchronous. That is what makes ordering simple: assigning a sequence number, writing the event and sending it to sockets all happen with no `await` in between, so no other request can slip in.

## 2. WebAssembly bundle size

**Result: no concern.**

| | Size |
| --- | --- |
| WebAssembly module | 484 KB (209 KB gzipped) |
| JavaScript glue | 30 KB |
| Workers limit | 64 MiB uncompressed, all plans |

The plan worried about the old limits of 3 MB (Free) and 10 MB (Paid) compressed. Cloudflare removed those on 4 Sep 2026 and now only checks the uncompressed size against 64 MiB ([changelog](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)). We use under 1 percent of that. The build uses `opt-level = "z"`, LTO and `wasm-opt -Oz`.

Startup time is the other limit (1 second to run the module's global scope). Cloudflare measured ours at 5 ms on deploy. CI reports the bundle size on every pull request and fails above 8 MB, so growth gets noticed long before it matters.

## 3. Twitch EventSub webhooks

**Result: works, and real Twitch accepted it.** `crates/sylva-core/src/twitch.rs` holds the logic and 15 unit tests. `POST /twitch/eventsub` in the Worker calls it.

* All three message types: `webhook_callback_verification` (replies with the challenge as plain text), `notification`, and `revocation`.
* HMAC-SHA256 signature over message id, timestamp and raw body, compared in constant time.
* Messages older than 10 minutes, or more than 1 minute in the future, are rejected, as Twitch recommends.
* Twitch retries with the same message id. The channel log stores the first and ignores repeats, and still answers 2xx so Twitch stops retrying.
* The channel is found from the subscription's `condition`, which works for conduits (one callback for every channel). Raids use the side the subscription was made for, so an incoming raid is an alert and an outgoing raid is not.
* Normalized so far: follow, sub, resub, gifted sub, community gift, cheer (with anonymous), raid, channel point redemption and chat. Unknown types are kept as `other` with the raw payload, so nothing is dropped.

On the real deploy, `POST /admin/twitch/conduit` created the app's conduit and pointed shard 0 at the Worker. Twitch's verification first failed because a conduit shard's challenge has no `subscription` object, which our parser required. With that fixed, Twitch marked the shard `enabled`.

Optional extra check: run Twitch's own CLI (`twitch event trigger channel.follow -F <url>/twitch/eventsub -s <secret>`) against the Worker as an independent check of the signature format. Downloading the CLI was blocked in this environment. Our tests sign messages exactly as Twitch documents, but a check against Twitch's own tool is cheap insurance.

## 4. Reliable alerts and replay to an OBS overlay

**Result: works, including a real browser reload.**

How it works:

1. Every event gets the next sequence number (1, 2, 3 and so on, with no gaps) and is written to the channel's SQLite log before it is sent anywhere. The runtime's output gate holds websocket frames and HTTP responses until that write is durable.
2. Alertable events also go into an alert queue table. One alert plays at a time per channel.
3. When an overlay connects, it gets the alert that is playing (or the next queued one). The overlay acknowledges when it has finished showing it. Only then does the next one start.
4. If OBS reloads mid alert, the reconnecting overlay is sent the same alert again. Nothing is lost.
5. Feeds (the dashboard, Cortex) say `lastSeq` when they connect and get every event they missed, in order, then live events.
6. Pause, resume, mute, unmute, skip, replay and "play next" are server state that every client can read (`GET /v1/channels/{key}/state`). This is the state Cortex could never get from StreamElements.

`npm run test:e2e` runs 17 checks against a running Worker, all passing:

* webhook verification, bad signature, old message, revocation
* Twitch retries stored once
* alerts wait while no overlay is connected
* feed replay after `lastSeq`, in order, then live
* overlay gets the oldest alert, an OBS reload shows the same alert again
* a stale ack cannot skip the alert on screen
* pause, resume and mute, skip, replay
* admin token required, bad channel keys refused, percent encoded keys work
* an alert nobody acknowledges times out after 30 seconds through the alarm

A Playwright run of the real overlay page in Chromium showed alert 1, reloaded the page mid alert, and got alert 1 again, then the next one:

![Follow alert](phase-0/overlay-follow.png)
![Cheer alert after the reload](phase-0/overlay-cheer.png)

## 5. Burst throughput for one channel

**Result: one channel sustains about 600 to 780 events per second on real Cloudflare with nothing lost, and that is per channel, not per app.**

`npm run test:burst` plays a raid against one channel: 90 percent chat, 10 percent follows, plus 2 percent Twitch retries. Each event is one signed webhook, exactly as Twitch sends them. A feed client stays connected and must receive every event exactly once, with seq 1 to N and no gaps.

On Cloudflare (`sylva-edge.haruxe.workers.dev`, 25 Nov 2026, 5,000 events per run):

| Concurrent senders | Events per second | p50 | p99 | Every event once, in order | Errors |
| --- | --- | --- | --- | --- | --- |
| 10 | 154 | 57 ms | 154 ms | Yes | 0 |
| 50 | 599 | 73 ms | 428 ms | Yes | 0 |
| 200 | 552 | 303 ms | 3.6 s | Yes | 0 |
| Two channels at once, 100 each | 682 and 779 (1,461 total) | 95 to 101 ms | 0.6 to 2.3 s | Yes | 0 |

How to read this:

* **Correctness held at every level.** No lost events, no duplicates, no gaps, no errors, and Twitch retries were dropped.
* **The ceiling is per channel.** Two channels together did about twice what one did, so the limit is the one Durable Object, as Cloudflare's guidance predicts ([soft limit of about 1,000 requests per second](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)). Past the ceiling, events queue and get slower; none failed.
* Our cloud test machine reached the Worker through a proxy, which adds some latency, so real Twitch latency should be a little better.
* Locally under `wrangler dev` the same test reached about 640 events per second, with the local tooling as the limit.

**What this means for Sylva:** a channel can take several hundred events per second before alerts slow down. Chat is the bulk of a raid's traffic. If a very large channel ever comes close, the first step is to give chat its own Durable Object per channel, so alerts never queue behind chat. The ingest path already accepts batches (`/ingest-batch` inside the object) for anything that can be grouped.

## Bugs Phase 0 caught

1. Alarm scheduled 56 years out (the `set_alarm` offset issue above).
2. Browsers encode `:` in `twitch:123` as `%3A`, which made the overlay's socket return 404. The Worker now decodes it, and a check covers it.
3. After the last alert was acknowledged, clients were not told the queue was empty. Now they are.
4. Twitch's conduit shard verification has no `subscription` object, so our parser rejected it. Found by real Twitch on the first deploy.

## Choices made in Phase 0 that you may want to change

* Chat lines go into the same event log as alerts (marked `chat`, never queued as alerts). The plan keeps chat in its own short lived table. Splitting it out later is easy.
* One alert plays at a time per channel, across all overlays of that channel.
* An alert nobody acknowledges times out after 30 seconds.
* POST routes use a single admin token for now. Reads and sockets are open. Real accounts and per overlay read tokens come in Phase 1.

## Not covered yet

* Events that need the broadcaster's permission (follows, subs, cheers, chat). Those need the broadcaster to sign in to Sylva, which is Phase 1. Raids, stream online and offline, and channel updates need no permission and are wired up now.
* Copying events to Postgres through Hyperdrive.

## Deployed

* Worker: `https://sylva-edge.haruxe.workers.dev`, deployed with `npm run deploy`.
* Worker secrets: `TWITCH_CLIENT_SECRET` (set by Josh in the Cloudflare dashboard), plus `TWITCH_EVENTSUB_SECRET` and `SYLVA_ADMIN_TOKEN` (random, set with `wrangler secret put`). Rotate the last two with `wrangler secret put` whenever needed.
* Twitch conduit with one webhook shard pointing at `/twitch/eventsub`.

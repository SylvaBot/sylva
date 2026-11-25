// Burst test: how many events per second can one channel take, and does every
// event arrive exactly once and in order?
//
// It plays a raid: a flood of chat plus follows, with some Twitch retries
// (same message id sent twice). A feed client and an overlay stay connected
// the whole time and must see every event, with seq 1..N and no gaps.
//
//   node tools/burst.mjs [total=5000] [concurrency=50]
//
// Against `npm run dev` this measures workerd on your machine. Point SYLVA_URL
// at a deployed Worker to measure Cloudflare itself.
import { randomUUID } from 'node:crypto';
import { chat, Client, follow, getJson, randomChannelId, sendEventSub } from './lib.mjs';

const total = Number(process.argv[2] || 5000);
const concurrency = Number(process.argv[3] || 50);
const retryShare = 0.02;
const followShare = 0.1;

const id = randomChannelId();
const key = `twitch:${id}`;

const feed = new Client(key, 'feed', 0);
await feed.opened;
await feed.ready();

// Build the messages up front so signing time is not measured.
const messages = [];
for (let i = 0; i < total; i++) {
  const m = Math.random() < followShare ? follow(id, i) : chat(id, i);
  m.messageId = randomUUID();
  messages.push(m);
  if (Math.random() < retryShare) messages.push({ ...m, retry: true });
}
const unique = total;

const latencies = [];
let errors = 0;
let next = 0;
const t0 = performance.now();
async function worker() {
  while (next < messages.length) {
    const m = messages[next++];
    const s = performance.now();
    const res = await sendEventSub(m);
    latencies.push(performance.now() - s);
    if (res.status !== 204) errors++;
    await res.arrayBuffer();
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsed = (performance.now() - t0) / 1000;

// Wait for the feed to catch up.
const deadline = Date.now() + 30000;
while (feed.frames.filter((f) => f.type === 'event').length < unique && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
const seqs = feed.frames.filter((f) => f.type === 'event').map((f) => f.seq);
const inOrder = seqs.every((s, i) => s === i + 1);
const ids = new Set(feed.frames.filter((f) => f.type === 'event').map((f) => f.id));
const state = await getJson(`/v1/channels/${key}/state`);
await feed.close();

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1);
const result = {
  target: process.env.SYLVA_URL || 'local wrangler dev',
  requests: messages.length,
  uniqueEvents: unique,
  retries: messages.length - unique,
  concurrency,
  seconds: Number(elapsed.toFixed(2)),
  requestsPerSecond: Math.round(messages.length / elapsed),
  latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: latencies.at(-1).toFixed(1) },
  non2xx: errors,
  feedReceived: seqs.length,
  feedInOrderNoGaps: inOrder,
  feedDuplicates: seqs.length - ids.size,
  alertsQueued: state.queued,
};
console.log(JSON.stringify(result, null, 2));
const ok = errors === 0 && seqs.length === unique && inOrder && ids.size === unique;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);

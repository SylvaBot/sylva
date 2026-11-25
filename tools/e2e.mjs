// End to end checks against a running Worker: Twitch webhooks in, alerts and
// replay out. Run `npm run dev` in one terminal and `npm run test:e2e` in another.
// Set SKIP_SLOW=1 to skip the 30 second alarm test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { admin, chat, Client, follow, getJson, randomChannelId, sendEventSub, sleep } from './lib.mjs';

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`ok    ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`FAIL  ${name}\n      ${e.stack}`);
  }
}

const id = randomChannelId();
const key = `twitch:${id}`;
console.log(`channel ${key}`);

await check('webhook verification answers the challenge as plain text', async () => {
  const res = await sendEventSub({ type: 'webhook_callback_verification', subType: 'channel.follow',
                                   condition: { broadcaster_user_id: id }, challenge: 'abc-123' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'abc-123');
  assert.match(res.headers.get('content-type'), /text\/plain/);
});

await check('a bad signature is rejected with 403', async () => {
  const res = await sendEventSub({ ...follow(id, 0), secret: 'wrong-secret' });
  assert.equal(res.status, 403);
});

await check('a message older than 10 minutes is rejected with 403', async () => {
  const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const res = await sendEventSub({ ...follow(id, 0), timestamp: old });
  assert.equal(res.status, 403);
});

await check('revocation is accepted with 204', async () => {
  const res = await sendEventSub({ type: 'revocation', subType: 'channel.follow', status: 'authorization_revoked',
                                   condition: { broadcaster_user_id: id } });
  assert.equal(res.status, 204);
});

await check('notifications are stored once even when Twitch retries', async () => {
  const msg = randomUUID();
  for (let i = 0; i < 3; i++) assert.equal((await sendEventSub(follow(id, 1, msg))).status, 204);
  const events = await getJson(`/v1/channels/${key}/events?after=0`);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].kind, 'follow');
  assert.equal(events[0].actor.displayName, 'Viewer1');
});

await check('alerts wait in the queue while no overlay is connected', async () => {
  await sendEventSub(follow(id, 2));
  await sendEventSub(chat(id, 1)); // chat is logged but never queued
  await sendEventSub(follow(id, 3));
  const state = await getJson(`/v1/channels/${key}/state`);
  assert.equal(state.queued, 3);
  assert.equal(state.playing, null);
  assert.equal(state.overlaysConnected, 0);
});

await check('a feed client replays everything after lastSeq, in order, then goes live', async () => {
  const feed = new Client(key, 'feed', 1);
  await feed.opened;
  const ready = await feed.ready();
  assert.equal(ready.headSeq, 4);
  assert.equal(ready.replayTruncated, false);
  const seqs = feed.frames.filter((f) => f.type === 'event').map((f) => f.seq);
  assert.deepEqual(seqs, [2, 3, 4]);
  await sendEventSub(chat(id, 2));
  const live = await feed.next((f) => f.type === 'event' && f.seq === 5);
  assert.equal(live.kind, 'chat');
  await feed.close();
});

let firstAlert;
await check('an overlay gets the oldest alert when it connects', async () => {
  const overlay = new Client(key, 'overlay');
  await overlay.opened;
  const play = await overlay.next((f) => f.type === 'play');
  firstAlert = play.alertId;
  assert.equal(play.event.seq, 1);
  assert.equal(play.muted, false);
  await overlay.close();
});

await check('an OBS reload mid alert shows the same alert again (no loss)', async () => {
  const overlay = new Client(key, 'overlay');
  await overlay.opened;
  const play = await overlay.next((f) => f.type === 'play');
  assert.equal(play.alertId, firstAlert);
  overlay.ack(play.alertId);
  const next = await overlay.next((f) => f.type === 'play' && f.alertId !== firstAlert);
  assert.equal(next.event.seq, 2);
  overlay.ack(next.alertId);
  const third = await overlay.next((f) => f.type === 'play' && f.event.seq === 4);
  overlay.ack(third.alertId);
  await overlay.next((f) => f.type === 'state' && f.playing === null && f.queued === 0);
  await overlay.close();
});

await check('a stale or repeated ack does not skip the next alert', async () => {
  const overlay = new Client(key, 'overlay');
  await overlay.opened;
  await overlay.ready();
  await sendEventSub(follow(id, 4));
  const play = await overlay.next((f) => f.type === 'play');
  overlay.ack(firstAlert); // old alert id: must be ignored
  await sleep(300);
  assert.equal((await getJson(`/v1/channels/${key}/state`)).playing, play.alertId);
  overlay.ack(play.alertId);
  await overlay.next((f) => f.type === 'state' && f.playing === null);
  await overlay.close();
});

await check('pause holds alerts, resume plays them, mute is passed to the overlay', async () => {
  const overlay = new Client(key, 'overlay');
  await overlay.opened;
  await overlay.ready();
  assert.equal((await admin(`/v1/channels/${key}/alerts/pause`)).paused, true);
  await sendEventSub(follow(id, 5));
  await sleep(300);
  assert.equal(overlay.plays().length, 0);
  await admin(`/v1/channels/${key}/alerts/mute`);
  const state = await admin(`/v1/channels/${key}/alerts/resume`);
  assert.equal(state.paused, false);
  const play = await overlay.next((f) => f.type === 'play');
  assert.equal(play.muted, true);
  await admin(`/v1/channels/${key}/alerts/unmute`);
  overlay.ack(play.alertId);
  await overlay.next((f) => f.type === 'state' && f.playing === null);
  await overlay.close();
});

await check('skip stops the alert on screen and moves on', async () => {
  const overlay = new Client(key, 'overlay');
  await overlay.opened;
  await overlay.ready();
  await sendEventSub(follow(id, 6));
  await sendEventSub(follow(id, 7));
  const first = await overlay.next((f) => f.type === 'play');
  await admin(`/v1/channels/${key}/alerts/skip`);
  const stop = await overlay.next((f) => f.type === 'stop');
  assert.equal(stop.alertId, first.alertId);
  const second = await overlay.next((f) => f.type === 'play' && f.alertId !== first.alertId);
  assert.equal(second.event.actor.displayName, 'Viewer7');
  overlay.ack(second.alertId);
  await overlay.next((f) => f.type === 'state' && f.playing === null);
  await overlay.close();
});

await check('replay puts an old event back on screen ahead of the queue', async () => {
  const overlay = new Client(key, 'overlay');
  await overlay.opened;
  await overlay.ready();
  await admin(`/v1/channels/${key}/alerts/replay/1`);
  const play = await overlay.next((f) => f.type === 'play');
  assert.equal(play.event.seq, 1);
  assert.notEqual(play.alertId, firstAlert);
  overlay.ack(play.alertId);
  await overlay.next((f) => f.type === 'state' && f.playing === null);
  await overlay.close();
});

await check('test event route needs the admin token', async () => {
  const res = await fetch(`${process.env.SYLVA_URL || 'http://localhost:8787'}/v1/channels/${key}/test-event`, { method: 'POST' });
  assert.equal(res.status, 401);
  const ok = await admin(`/v1/channels/${key}/test-event`, { kind: 'raid', name: 'Tester', amount: 42 });
  assert.equal(ok.duplicate, false);
});

await check('a percent-encoded channel key works (browsers encode the colon)', async () => {
  const state = await getJson(`/v1/channels/${encodeURIComponent(key)}/state`);
  assert.equal(typeof state.queued, 'number');
});

await check('bad channel keys are refused', async () => {
  const res = await fetch(`${process.env.SYLVA_URL || 'http://localhost:8787'}/v1/channels/evil:../state`);
  assert.equal(res.status, 404);
});

if (!process.env.SKIP_SLOW) {
  await check('an alert nobody acks times out after 30 s via the alarm', async () => {
    const overlay = new Client(key, 'overlay');
    await overlay.opened;
    const stuck = await overlay.next((f) => f.type === 'play'); // the raid test event
    await sendEventSub(follow(id, 8));
    const next = await overlay.next((f) => f.type === 'play' && f.alertId !== stuck.alertId, 40000);
    assert.equal(next.event.actor.displayName, 'Viewer8');
    overlay.ack(next.alertId);
    await overlay.close();
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

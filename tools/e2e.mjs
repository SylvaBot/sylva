// End to end checks against a running Worker: Twitch webhooks in, alerts and
// replay out, overlay links, and signing in with Twitch.
//
// Run `npm run dev:test` in one terminal and `npm run test:e2e` in another.
// dev:test points the Worker at a fake Twitch that this script starts on
// :8788, so the sign in checks run too. Against plain `npm run dev` they are
// skipped. Set SKIP_SLOW=1 to skip the 30 second alarm test.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ADMIN, BASE, admin, chat, chatLine, Client, follow, getJson, randomChannelId, sendEventSub, sleep } from './lib.mjs';
import { FAKE_PORT, FAKE_USER, LOYALTY_SCOPES, startFakeTwitch } from './fake-twitch.mjs';

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

await check('the website sends its security headers and versioned files', async () => {
  const res = await fetch(`${BASE}/app`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const html = await res.text();
  const js = html.match(/\/assets\/app\.js\?v=[0-9a-f]{12}/)?.[0];
  assert.ok(js, 'index.html links a versioned app.js');
  const asset = await fetch(BASE + js);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${BASE}/assets/app.js`)).headers.get('cache-control'), 'public, max-age=60');
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

await check('test event route needs the owner or the admin token', async () => {
  const res = await fetch(`${BASE}/v1/channels/${key}/test-event`, { method: 'POST' });
  assert.equal(res.status, 401);
  const ok = await admin(`/v1/channels/${key}/test-event`, { kind: 'raid', name: 'Tester', amount: 42 });
  assert.equal(ok.duplicate, false);
});

await check('a percent-encoded channel key works (browsers encode the colon)', async () => {
  const state = await getJson(`/v1/channels/${encodeURIComponent(key)}/state`);
  assert.equal(typeof state.queued, 'number');
});

await check('bad channel keys are refused', async () => {
  const res = await fetch(`${BASE}/v1/channels/evil:../state`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(res.status, 404);
});

await check('channel reads need the owner or the admin token', async () => {
  for (const path of ['state', 'events?after=0', 'history', 'summary', 'overlay', 'ws']) {
    const res = await fetch(`${BASE}/v1/channels/${key}/${path}`);
    assert.equal(res.status, 401, path);
  }
  // A client cannot claim access by sending the Worker's internal header.
  const spoof = await fetch(`${BASE}/v1/channels/${key}/state`, { headers: { 'X-Sylva-Access': 'owner' } });
  assert.equal(spoof.status, 401);
});

await check('history is newest first and filters chat from alerts', async () => {
  const all = await getJson(`/v1/channels/${key}/history?limit=500`);
  const seqs = all.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
  assert.equal(all.headSeq, seqs[0]);
  const alerts = await getJson(`/v1/channels/${key}/history?filter=alerts`);
  assert.ok(alerts.events.length > 0 && alerts.events.every((e) => e.kind !== 'chat'));
  const chats = await getJson(`/v1/channels/${key}/history?filter=chat`);
  assert.equal(chats.events.length, 2);
  assert.ok(chats.events.every((e) => e.kind === 'chat'));
  const older = await getJson(`/v1/channels/${key}/history?before=3&limit=1`);
  assert.deepEqual(older.events.map((e) => e.seq), [2]);
});

await check('history search matches names and messages, literally', async () => {
  const tester = await getJson(`/v1/channels/${key}/history?filter=alerts&q=tEsTeR`);
  assert.ok(tester.events.length >= 1);
  assert.ok(tester.events.every((e) => e.actor.displayName === 'Tester'));
  const viewer = await getJson(`/v1/channels/${key}/history?filter=alerts&q=${encodeURIComponent('Viewer7')}`);
  assert.deepEqual(viewer.events.map((e) => e.actor.displayName), ['Viewer7']);
  // % and _ are not wildcards.
  const wild = await getJson(`/v1/channels/${key}/history?q=${encodeURIComponent('%')}`);
  assert.equal(wild.events.length, 0);
  const blank = await getJson(`/v1/channels/${key}/history?filter=alerts&q=${encodeURIComponent('  ')}`);
  const plain = await getJson(`/v1/channels/${key}/history?filter=alerts`);
  assert.equal(blank.events.length, plain.events.length);
});

await check('alert settings: defaults, validation, switches, minimums and the view', async () => {
  const sid = randomChannelId();
  const skey = `twitch:${sid}`;
  const defaults = await getJson(`/v1/channels/${skey}/alert-settings`);
  assert.deepEqual(defaults.kinds.map((k) => k.kind),
    ['follow', 'subscriber', 'communityGift', 'cheer', 'raid', 'tip', 'redemption']);
  assert.ok(defaults.kinds.every((k) => k.enabled && k.durationMs === 5000));

  const post = (body) => fetch(`${BASE}/v1/channels/${skey}/alert-settings`, {
    method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const tooLong = await post({ kinds: defaults.kinds.map((k) => ({ ...k, durationMs: 60000 })) });
  assert.equal(tooLong.status, 400);
  assert.match(await tooLong.text(), /2 to 20 seconds/);
  assert.equal((await post('nonsense')).status, 400);

  const kinds = defaults.kinds.map((k) => {
    if (k.kind === 'follow') return { ...k, enabled: false };
    if (k.kind === 'cheer') return { ...k, minAmount: 100, durationMs: 8000, label: 'Bits!', template: '{name} gave {amount}' };
    return k;
  });
  const saved = await post({ kinds });
  assert.equal(saved.status, 200);
  const again = await getJson(`/v1/channels/${skey}/alert-settings`);
  assert.equal(again.kinds.find((k) => k.kind === 'cheer').minAmount, 100);

  const overlay = new Client(skey, 'overlay', undefined, { headers: { Authorization: `Bearer ${ADMIN}` } });
  await overlay.opened;
  await overlay.ready();
  const follow = await admin(`/v1/channels/${skey}/test-event`, { kind: 'follow', name: 'Quiet' });
  assert.equal(follow.alert, false, 'follows are off');
  const small = await admin(`/v1/channels/${skey}/test-event`, { kind: 'cheer', name: 'Small', amount: 99 });
  assert.equal(small.alert, false, 'under the minimum');
  const big = await admin(`/v1/channels/${skey}/test-event`, { kind: 'cheer', name: 'Big', amount: 12000 });
  assert.equal(big.alert, true);
  const play = await overlay.next((f) => f.type === 'play');
  assert.equal(play.event.seq, big.seq, 'only the cheer over the minimum plays');
  assert.deepEqual(play.view, { label: 'Bits!', name: 'Big', detail: 'Big gave 12,000', durationMs: 8000 });
  overlay.ack(play.alertId);
  await overlay.close();
  const feed = await getJson(`/v1/channels/${skey}/history?filter=alerts`);
  assert.equal(feed.events.length, 3, 'everything still reaches the activity feed');
});

await check('a gift of 2 subs plays one alert, not three', async () => {
  const gid = randomChannelId();
  const gkey = `twitch:${gid}`;
  await sendEventSub({ subType: 'channel.subscription.gift', condition: { broadcaster_user_id: gid },
    event: { user_id: '9', user_login: 'giver', user_name: 'Giver', broadcaster_user_id: gid,
             total: 2, tier: '1000', cumulative_total: 2, is_anonymous: false } });
  for (const n of [1, 2]) {
    await sendEventSub({ subType: 'channel.subscribe', condition: { broadcaster_user_id: gid },
      event: { user_id: String(n), user_login: `r${n}`, user_name: `R${n}`, broadcaster_user_id: gid,
               tier: '1000', is_gift: true } });
  }
  const state = await getJson(`/v1/channels/${gkey}/state`);
  assert.equal(state.queued, 1);
  const sum = await getJson(`/v1/channels/${gkey}/summary`);
  assert.deepEqual(sum.counts, { communityGift: 1, giftedSub: 2 });
});

await check('summary counts by kind and adds up bits', async () => {
  const sid = randomChannelId();
  for (const bits of [100, 250]) {
    await sendEventSub({ subType: 'channel.cheer', condition: { broadcaster_user_id: sid },
      event: { is_anonymous: true, user_id: null, user_login: null, user_name: null,
               broadcaster_user_id: sid, message: 'yay', bits } });
  }
  await sendEventSub(follow(sid, 1));
  const sum = await getJson(`/v1/channels/twitch:${sid}/summary`);
  assert.equal(sum.bits, 350);
  assert.deepEqual(sum.counts, { cheer: 2, follow: 1 });
  const none = await getJson(`/v1/channels/twitch:${sid}/summary?since=${Date.now() + 60000}`);
  assert.deepEqual(none.counts, {});
});

let overlayToken;
await check('an overlay link connects as an overlay only, never as a feed', async () => {
  const { url } = await getJson(`/v1/channels/${key}/overlay`);
  assert.match(url, new RegExp(`/overlay/${key}\\?token=[0-9a-f]{48}$`));
  overlayToken = new URL(url).searchParams.get('token');
  assert.equal((await getJson(`/v1/channels/${key}/overlay`)).url, url, 'the link is stable');

  const overlay = new Client(key, 'overlay', 0, { token: overlayToken });
  await overlay.opened;
  const ready = await overlay.ready();
  // lastSeq is ignored for overlay links: no history is sent.
  assert.equal(overlay.frames.filter((f) => f.type === 'event').length, 0);
  assert.ok(ready.headSeq > 0);
  await overlay.close();

  const feed = new Client(key, 'feed', 0, { token: overlayToken });
  await feed.opened;
  const err = await feed.next((f) => f.type === 'error');
  assert.match(err.message, /only works as an overlay/);
  const closed = await feed.closed;
  assert.equal(closed.code, 4003);
  assert.equal(feed.frames.filter((f) => f.type === 'event').length, 0);
});

await check('widgets get their data, follow events live, and never play alerts', async () => {
  const post = (body) => fetch(`${BASE}/v1/channels/${key}/widget-settings`, {
    method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.deepEqual(await getJson(`/v1/channels/${key}/widget-settings`), { goal: null });
  assert.equal((await post({ goal: { title: ' ', kind: 'bits', target: 10, since: 0 } })).status, 400);
  assert.equal((await post({ goal: { title: 'Bits', kind: 'bits', target: 0, since: 0 } })).status, 400);
  const since = Date.now() - 1000;
  const saved = await post({ goal: { title: ' Sub goal ', kind: 'subs', target: 1000, since } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).goal.title, 'Sub goal');

  const before = await getJson(`/v1/channels/${key}/state`);
  const widget = new Client(key, 'widget', 0, { token: overlayToken });
  await widget.opened;
  const data = await widget.next((f) => f.type === 'widgets');
  assert.equal(widget.frames.filter((f) => f.type === 'event').length, 0, 'no history replay');
  assert.ok(data.recent.length > 0 && data.recent.every((e) => e.kind !== 'chat' && e.kind !== 'other'));
  assert.ok(data.recent.every((e, i, a) => i === 0 || a[i - 1].seq > e.seq), 'newest first');
  assert.ok(data.chat.every((e) => e.kind === 'chat'));
  assert.ok(data.latest.some((e) => e.kind === 'follow'));
  assert.equal(new Set(data.latest.map((e) => e.kind)).size, data.latest.length, 'one per kind');
  assert.equal(data.goal.title, 'Sub goal');
  const start = data.goal.current;

  const state = await getJson(`/v1/channels/${key}/state`);
  assert.equal(state.overlaysConnected, before.overlaysConnected, 'a widget is not an alert box');

  // A gifted sub's recipient counts toward a sub goal but plays no alert of its own.
  await admin(`/v1/channels/${key}/test-event`, { kind: 'giftedSub', name: 'Widgetfan' });
  const live = await widget.next((f) => f.type === 'event' && f.actor?.displayName === 'Widgetfan');
  assert.equal(live.kind, 'giftedSub');
  assert.equal(widget.frames.filter((f) => f.type === 'play').length, 0);

  // Saving settings pushes fresh data to widgets on screen, with the gift counted.
  await post({ goal: { title: 'Sub goal', kind: 'subs', target: 2000, since } });
  const pushed = await widget.next((f) => f.type === 'widgets' && f.goal?.target === 2000);
  assert.equal(pushed.goal.current, start + 1);
  await post({ goal: null });
  const cleared = await widget.next((f) => f.type === 'widgets' && !f.goal);
  assert.ok(cleared);
  await widget.close();
});

await check('the overlay editor saves drafts, publishes versions and pushes the layout', async () => {
  const post = (path, body) => fetch(`${BASE}/v1/channels/${key}/scene${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
  const item = (id, widget, extra = {}) => ({ id, widget, x: 10.4, y: 20, w: 400, h: 120, ...extra });
  const fresh = await getJson(`/v1/channels/${key}/scene`);
  assert.deepEqual(fresh.draft, { items: [] });
  assert.equal(fresh.published, undefined);
  assert.deepEqual(fresh.versions, []);

  // Refused layouts.
  assert.equal((await post('', { items: [item('a', 'alerts'), item('b', 'alerts')] })).status, 400);
  assert.equal((await post('', { items: [item('a', 'feed'), item('a', 'chat')] })).status, 400);
  assert.equal((await post('', { items: [item('a', 'top', { kind: 'follow' })] })).status, 400);
  assert.equal((await post('', { items: [item('a b', 'goal')] })).status, 400);
  assert.equal((await post('', { items: [item('a', 'sparkles')] })).status, 400);
  assert.equal((await post('', { items: Array.from({ length: 25 }, (_, i) => item(`i${i}`, 'goal')) })).status, 400);
  // Custom code: fields must be JSON, and only one thing on a scene plays alerts.
  const custom = (id, code) => item(id, 'custom', { code: { name: 'Mine', html: '<b>hi</b>', css: '', js: '', fields: '', values: {}, alerts: false, ...code } });
  assert.equal((await post('', { items: [custom('c', { fields: 'nope' })] })).status, 400);
  assert.equal((await post('', { items: [custom('c', { alerts: true }), item('a', 'alerts')] })).status, 400);
  const withCode = await (await post('', { items: [custom('c', { alerts: true, fields: '{"x":{"type":"text","value":"1"}}' })] })).json();
  assert.equal(withCode.draft.items[0].code.alerts, true);
  const frame = await fetch(`${BASE}/overlay-frame`);
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(await frame.text(), /window\.Sylva = /);
  await post('', { items: [] });

  // A draft is tidied and kept, but overlays do not see it yet.
  const widget = new Client(key, 'widget', 0, { token: overlayToken });
  await widget.opened;
  const first = await widget.next((f) => f.type === 'widgets');
  assert.equal(first.scene, undefined, 'nothing published yet');
  assert.ok(Array.isArray(first.top));
  const draft = { items: [item('box', 'alerts'), item('top', 'top', { x: 5000 }), item('feed', 'feed', { limit: 99 })] };
  const saved = await (await post('', draft)).json();
  assert.equal(saved.draft.items[0].x, 10);
  assert.equal(saved.draft.items[1].x, 1920 - 400);
  assert.equal(saved.draft.items[1].kind, 'cheer');
  assert.equal(saved.draft.items[2].limit, 20);
  assert.ok(saved.draftSavedAt > 0);
  assert.equal(saved.published, undefined);

  // Publishing makes version 1 and pushes it to the overlay on screen.
  const one = await (await post('/publish')).json();
  assert.equal(one.published.version, 1);
  assert.deepEqual(one.published.scene, saved.draft);
  const pushed = await widget.next((f) => f.type === 'widgets' && f.scene?.version === 1);
  assert.deepEqual(pushed.scene.scene, saved.draft);

  // A second version, then restore the first into the draft.
  await post('', { items: [item('chat', 'chat')] });
  const two = await (await post('/publish')).json();
  assert.equal(two.published.version, 2);
  assert.deepEqual(two.versions.map((v) => [v.version, v.items]), [[2, 1], [1, 3]]);
  const restored = await (await post('/restore/1')).json();
  assert.deepEqual(restored.draft, saved.draft);
  assert.equal(restored.published.version, 2, 'restoring does not publish');
  assert.equal((await post('/restore/99')).status, 404);

  await widget.close();

  // A new widget socket gets the published scene straight away.
  const again = new Client(key, 'widget', 0, { token: overlayToken });
  await again.opened;
  assert.equal((await again.next((f) => f.type === 'widgets')).scene.version, 2);
  await again.close();
});

await check('a cheer updates top labels on screen', async () => {
  // Its own channel, so the cheer's alert does not join this channel's queue.
  const tkey = `twitch:${randomChannelId()}`;
  const widget = new Client(tkey, 'widget', 0);
  await widget.opened;
  assert.deepEqual((await widget.next((f) => f.type === 'widgets')).top, []);
  await admin(`/v1/channels/${tkey}/test-event`, { kind: 'cheer', name: 'Small', amount: 100 });
  await admin(`/v1/channels/${tkey}/test-event`, { kind: 'cheer', name: 'Topfan', amount: 500 });
  await admin(`/v1/channels/${tkey}/test-event`, { kind: 'cheer', name: 'Topfan', amount: 600 });
  const top = await widget.next((f) => f.type === 'top' && f.top.some((t) => t.name === 'Topfan' && t.amount === 1100));
  assert.deepEqual(top.top, [{ kind: 'cheer', name: 'Topfan', amount: 1100 }], 'cheers add up per viewer');
  await widget.close();
  const again = new Client(tkey, 'widget', 0);
  await again.opened;
  assert.deepEqual((await again.next((f) => f.type === 'widgets')).top, top.top);
  await again.close();
});

await check('a wrong overlay token is refused', async () => {
  const bad = new Client(key, 'overlay', undefined, { token: 'f'.repeat(48) });
  await assert.rejects(bad.opened);
});

await check('a new overlay link disconnects the old one and refuses it', async () => {
  const overlay = new Client(key, 'overlay', undefined, { token: overlayToken });
  await overlay.opened;
  await overlay.ready();
  const { url } = await admin(`/v1/channels/${key}/overlay/rotate`);
  const closed = await overlay.closed;
  assert.equal(closed.code, 4001);
  const fresh = new URL(url).searchParams.get('token');
  assert.notEqual(fresh, overlayToken);
  const old = new Client(key, 'overlay', undefined, { token: overlayToken });
  await assert.rejects(old.opened);
  const ok = new Client(key, 'overlay', undefined, { token: fresh });
  await ok.opened;
  await ok.ready();
  await ok.close();
});

// ---------- signing in with Twitch (needs `npm run dev:test`) ----------

let fake = null;
try {
  fake = await startFakeTwitch();
} catch (e) {
  console.log(`note  could not start the fake Twitch on :${FAKE_PORT} (${e.message})`);
}
const probe = await fetch(`${BASE}/auth/twitch/start`, { redirect: 'manual' });
const usesFake = (probe.headers.get('location') || '').startsWith(`http://localhost:${FAKE_PORT}/`);
if (!fake || !usesFake) {
  console.log('skip  sign in checks: start the Worker with `npm run dev:test` to run them');
} else {
  const cookieOf = (res, name) => {
    const c = res.headers.getSetCookie().find((x) => x.startsWith(name + '='));
    return c ? c.split(';')[0].slice(name.length + 1) : null;
  };
  const ownKey = `twitch:${FAKE_USER.id}`;

  /** The browser's trip: start, Twitch approves, callback. Returns the callback response. */
  async function signIn() {
    const start = await fetch(`${BASE}/auth/twitch/start`, { redirect: 'manual' });
    const state = cookieOf(start, 'sylva_oauth');
    const approve = await fetch(start.headers.get('location'), { redirect: 'manual' });
    return fetch(approve.headers.get('location'), { redirect: 'manual', headers: { Cookie: `sylva_oauth=${state}` } });
  }

  let session;
  const asOwner = (extra = {}) => ({ Cookie: `sylva_session=${session}`, ...extra });

  await check('sign in starts on Twitch with the right scopes and a state cookie', async () => {
    const res = await fetch(`${BASE}/auth/twitch/start`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.pathname, '/oauth2/authorize');
    assert.equal(loc.searchParams.get('client_id'), 't9z14i1qdp044der47bq7lpu5w0eru');
    assert.equal(loc.searchParams.get('redirect_uri'), `${BASE}/auth/twitch/callback`);
    assert.equal(loc.searchParams.get('scope'),
      'moderator:read:followers channel:read:subscriptions bits:read user:read:chat user:bot channel:bot');
    const state = cookieOf(res, 'sylva_oauth');
    assert.match(state, /^[0-9a-f]{32}$/);
    assert.equal(loc.searchParams.get('state'), state);
    assert.match(res.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);
  });

  await check('a callback with the wrong state or a cancel goes back with a reason', async () => {
    const wrong = await fetch(`${BASE}/auth/twitch/callback?code=x&state=abc`,
      { redirect: 'manual', headers: { Cookie: 'sylva_oauth=def' } });
    assert.equal(wrong.headers.get('location'), '/?signin=expired');
    const none = await fetch(`${BASE}/auth/twitch/callback?code=x&state=abc`, { redirect: 'manual' });
    assert.equal(none.headers.get('location'), '/?signin=expired');
    const cancel = await fetch(`${BASE}/auth/twitch/callback?error=access_denied&state=abc`, { redirect: 'manual' });
    assert.equal(cancel.headers.get('location'), '/?signin=denied');
    assert.equal(fake.state.tokenRequests.filter((r) => r.grant_type === 'authorization_code').length, 0);
  });

  await check('the chat bot answers commands, with levels, cooldowns and counts', async () => {
    const bid = randomChannelId();
    const bkey = `twitch:${bid}`;
    const path = `/v1/channels/${bkey}/bot`;
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const sent = () => fake.state.chatSent.filter((m) => m.broadcaster_id === bid);
    const say = (text, who = {}) => sendEventSub(chatLine(bid, { text, ...who }));

    assert.equal((await fetch(`${BASE}${path}`)).status, 401, 'owner only');
    const fresh = await getJson(path);
    assert.equal(fresh.settings.enabled, false);
    assert.deepEqual(fresh.settings.commands.map((c) => c.name), ['lurk', 'so']);
    assert.ok(fresh.builtins.some((b) => b.name === 'followage'), 'built-in commands are listed');
    assert.deepEqual(fresh.sender, { kind: 'streamer', id: bid });

    await say('!lurk');
    assert.equal(sent().length, 0, 'the bot is off until turned on');

    const hello = { name: '!Hello', aliases: ['hi'], reply: 'Hi ${user}, you are visitor ${count}! ${touser}', cooldown: 30 };
    assert.equal((await post(path, { enabled: true, commands: [{ ...hello, reply: '${nope}' }] })).status, 400);
    assert.equal((await post(path, { enabled: true, commands: [hello, { ...hello, name: 'hi' }] })).status, 400);
    const saved = await (await post(path, { enabled: true, commands: [...fresh.settings.commands, hello] })).json();
    assert.equal(saved.settings.commands[2].name, 'hello');

    await say('!HI @Juniper');
    assert.deepEqual(sent().map((m) => [m.sender_id, m.message]), [[bid, 'Hi Maple, you are visitor 1! Juniper']]);
    await say('!hello', { id: '7002', name: 'Hazel' });
    assert.equal(sent().length, 1, 'cooldown');
    await say('!hello', { id: '7003', name: 'Modly', badges: ['moderator'] });
    assert.equal(sent().at(-1).message, 'Hi Modly, you are visitor 2! Modly', 'moderators skip cooldowns');

    await say('!so @Rowan', { id: '7004', name: 'Viper', badges: ['vip', 'subscriber'] });
    assert.equal(sent().length, 2, 'shoutouts are for moderators');
    await say('!so @Rowan', { id: '7003', name: 'Modly', badges: ['moderator'] });
    assert.equal(sent().at(-1).message, 'Go give Rowan a follow at twitch.tv/Rowan');

    // The streamer's own account sends the replies, so their echo must not count.
    await say('Go give Rowan a follow at twitch.tv/Rowan', { id: bid, name: 'Streamer' });
    await say('!nothing here');
    await say('hello !lurk');
    assert.equal(sent().length, 3);
    await say('!lurk', { id: bid, name: 'Streamer' });
    assert.equal(sent().at(-1).message, 'Streamer is lurking. Enjoy the stream!');

    // Counts are the server's: a save cannot reset or forge them.
    const now = await getJson(path);
    assert.equal(now.settings.commands[2].count, 2);
    const forged = await (await post(path, { ...now.settings, commands: now.settings.commands.map((c) => ({ ...c, count: 999 })) })).json();
    assert.equal(forged.settings.commands[2].count, 2);

    // The sandbox answers without sending.
    const tryIt = async (body) => (await post(`${path}/try`, body)).json();
    assert.deepEqual(await tryIt({ message: '!hello there', level: 'everyone' }),
      { reply: 'Hi Maple, you are visitor 3! there', command: 'hello' });
    assert.deepEqual(await tryIt({ message: '!hello', level: 'everyone', user: 'Rowan' }),
      { reply: 'Hi Rowan, you are visitor 3! Rowan', command: 'hello' });
    assert.deepEqual(await tryIt({ message: '!so x', level: 'subscriber' }), { skip: 'level', command: 'so' });
    assert.deepEqual(await tryIt({ message: 'hi', level: 'everyone' }), { skip: 'notACommand' });
    assert.deepEqual(await tryIt({ message: '!zzz', level: 'everyone' }), { skip: 'unknown' });
    const draft = { enabled: true, commands: [{ name: 'dice', reply: 'You rolled ${random.6-6}' }] };
    assert.deepEqual(await tryIt({ message: '!dice', level: 'everyone', settings: draft }), { reply: 'You rolled 6', command: 'dice' });
    assert.equal((await post(`${path}/try`, { message: '!x', level: 'everyone', settings: { commands: [{ name: 'a b', reply: 'x' }] } })).status, 400);
    assert.equal(sent().length, 4, 'the sandbox sends nothing');

    // Turned off, it stays quiet.
    await post(path, { ...now.settings, enabled: false });
    await say('!lurk');
    assert.equal(sent().length, 4);
  });

  await check('chat alerts post the lines that are on, and a mass gift hides its single gifts', async () => {
    const cid = randomChannelId();
    const path = `/v1/channels/twitch:${cid}/chat-alerts`;
    const post = (body) => fetch(`${BASE}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const sent = () => fake.state.chatSent.filter((m) => m.broadcaster_id === cid).map((m) => m.message);
    const view = await getJson(path);
    assert.equal(Object.keys(view.settings.alerts).length, 32);
    assert.ok(Object.values(view.settings.alerts).every((a) => !a.enabled), 'everything starts off');
    const on = (ids) => ({ ...view.settings, alerts: Object.fromEntries(Object.entries(view.settings.alerts)
      .map(([id, a]) => [id, { ...a, enabled: ids.includes(id) }])) });
    const bad = await post({ ...on([]), alerts: { ...view.settings.alerts, raid: { enabled: true, message: '${nope}' } } });
    assert.equal(bad.status, 400);
    assert.equal((await post(on(['follow', 'mass_1', 'gift_1', 'raid']))).status, 200);

    const note = (notice_type, extra) => sendEventSub({
      subType: 'channel.chat.notification',
      condition: { broadcaster_user_id: cid, user_id: cid },
      event: { broadcaster_user_id: cid, chatter_user_id: '55', chatter_user_login: 'gus', chatter_user_name: 'Gus',
               chatter_is_anonymous: false, notice_type, message_id: randomUUID(), message: { text: '', fragments: [] },
               ...extra },
    });
    await note('community_sub_gift', { community_sub_gift: { id: 'c1', total: 5, sub_tier: '1000' } });
    await note('sub_gift', { sub_gift: { sub_tier: '1000', recipient_user_name: 'Rae', community_gift_id: 'c1' } });
    await note('sub_gift', { sub_gift: { sub_tier: '1000', recipient_user_name: 'Lou', community_gift_id: null } });
    const f = follow(cid, 3, `dup-follow-${cid}`);
    await sendEventSub(f);
    await sendEventSub(f);
    await sendEventSub({ subType: 'channel.raid', condition: { to_broadcaster_user_id: cid },
      event: { from_broadcaster_user_id: '9', from_broadcaster_user_login: 'r', from_broadcaster_user_name: 'R',
               to_broadcaster_user_id: cid, to_broadcaster_user_login: 'me', to_broadcaster_user_name: 'Me', viewers: 4 } });
    assert.deepEqual(sent(), ['Gus just gifted 5 subs!', 'Gus just gifted a sub to Lou!',
      'Viewer3 just followed the stream!'], 'a retried follow and a raid under 5 viewers say nothing');
  });

  await check('counters and quotes answer in chat, and only moderators change them', async () => {
    const cid = randomChannelId();
    const path = `/v1/channels/twitch:${cid}/bot`;
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const sent = () => fake.state.chatSent.filter((m) => m.broadcaster_id === cid).map((m) => m.message);
    const say = (text, who = {}) => sendEventSub(chatLine(cid, { text, ...who }));
    const mod = { id: '7101', name: 'Modly', badges: ['moderator'] };

    const base = (await getJson(path)).settings;
    assert.deepEqual(base.quotes, { enabled: true, addLevel: 'moderator' });
    assert.match(await (await post(path, { ...base, counters: [{ name: 'lurk' }] })).text(), /both a command and a counter/);
    const saved = await (await post(path, { ...base, enabled: true, counters: [{ name: '!Deaths' }] })).json();
    assert.deepEqual(saved.settings.counters, [{ name: 'deaths', label: 'Deaths', value: 0, enabled: true }]);

    await say('!deaths');
    await say('!deaths +');
    assert.deepEqual(sent(), ['Deaths: 0'], 'viewers only see it, and not twice in 5 seconds');
    await say('!deaths +', mod);
    await say('!deaths = 10', mod);
    assert.deepEqual(sent().slice(1), ['Deaths: 1', 'Deaths: 10']);
    const now = await getJson(path);
    assert.equal(now.settings.counters[0].value, 10);
    const forged = await (await post(path, { ...now.settings, counters: [{ ...now.settings.counters[0], value: 999 }] })).json();
    assert.equal(forged.settings.counters[0].value, 10, 'a settings save keeps the value');
    const set = await (await post(`${path}/counters/deaths/set`, { value: 3 })).json();
    assert.equal(set.settings.counters[0].value, 3);
    assert.equal((await post(`${path}/counters/nope/set`, { value: 3 })).status, 404);

    await say('!quote');
    assert.equal(sent().at(-1), 'No quotes yet. Moderators can add one with !addquote.');
    const before = sent().length;
    await say('!addquote I am not a moderator');
    assert.equal(sent().length, before, 'viewers cannot add quotes');
    await say('!addquote "Never again"', mod);
    assert.equal(sent().at(-1), 'Added quote #1.');
    await say('!quote 1', mod);
    assert.match(sent().at(-1), /^#1: "Never again" \(This channel, \d{4}-\d{2}-\d{2}\)$/);
    await say('!quote 7', mod);
    assert.equal(sent().at(-1), 'There is no quote #7.');

    const second = await (await post(`${path}/quotes`, { text: 'Second', by: 'Rowan', game: 'Celeste' })).json();
    assert.equal(second.id, 2);
    assert.equal((await post(`${path}/quotes`, { text: '  ' })).status, 400);
    const edited = await (await post(`${path}/quotes/2`, { text: 'Second, edited', by: 'Rowan', game: 'Celeste' })).json();
    assert.equal(edited.text, 'Second, edited');
    assert.equal((await post(`${path}/quotes/2/delete`)).status, 200);
    await say('!addquote third', mod);
    assert.equal(sent().at(-1), 'Added quote #3.', 'numbers are never reused');
    const back = await (await post(`${path}/quotes`, { ...edited, id: 2 })).json();
    assert.equal(back.id, 2, 'Undo puts a quote back under its number');
    await say('!quote celeste', mod);
    assert.match(sent().at(-1), /^#2: "Second, edited" \(Rowan, Celeste, /);
    assert.deepEqual((await getJson(`${path}/quotes`)).quotes.map((q) => q.id), [1, 2, 3]);

    const tryIt = async (body) => (await post(`${path}/try`, body)).json();
    assert.deepEqual(await tryIt({ message: '!deaths +', level: 'moderator' }), { reply: 'Deaths: 4', command: 'deaths' });
    assert.equal((await getJson(path)).settings.counters[0].value, 3, 'the test chat changes nothing');
    assert.deepEqual(await tryIt({ message: '!addquote x', level: 'everyone' }), { skip: 'level', command: 'addquote' });
    assert.deepEqual(await tryIt({ message: '!addquote x', level: 'moderator' }), { reply: 'Added quote #4.', command: 'addquote' });

    await say('!delquote 1', mod);
    assert.equal(sent().at(-1), 'Quote #1 removed.');
    await post(path, { ...(await getJson(path)).settings, quotes: { enabled: false, addLevel: 'moderator' } });
    const quiet = sent().length;
    await say('!quote', mod);
    assert.equal(sent().length, quiet, 'quotes can be turned off');
  });

  /** The stream going live or offline. */
  const streamState = (cid, online, login = 'pointstester', name = 'PointsTester') => sendEventSub({
    subType: online ? 'stream.online' : 'stream.offline', condition: { broadcaster_user_id: cid },
    event: { id: randomUUID(), broadcaster_user_id: cid, broadcaster_user_login: login,
             broadcaster_user_name: name, type: 'live', started_at: new Date().toISOString() },
  });
  /** Wait until `fn` returns something truthy, for up to `ms`. */
  const until = async (fn, ms = 12_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v || Date.now() > end) return v;
      await sleep(250);
    }
  };

  await check('loyalty points pay viewers while live, and chat can check and move them', async () => {
    const lid = randomChannelId();
    const path = `/v1/channels/twitch:${lid}/loyalty`;
    const botPath = `/v1/channels/twitch:${lid}/bot`;
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const sent = () => fake.state.chatSent.filter((m) => m.broadcaster_id === lid).map((m) => m.message);
    const say = (text, who) => sendEventSub(chatLine(lid, { text, ...who }));
    const ev = (subType, event) => sendEventSub({ subType, condition: { broadcaster_user_id: lid },
      event: { broadcaster_user_id: lid, broadcaster_user_login: 'pointstester', broadcaster_user_name: 'PointsTester', ...event } });
    const balance = async (login) => (await getJson(`${path}/viewers?q=${login}`)).viewers.find((v) => v.login === login)?.balance ?? 0;
    const hazel = { id: '8001', name: 'Hazel' };
    const mod = { id: '8009', name: 'Modly', badges: ['moderator'] };

    const first = await getJson(path);
    assert.equal(first.settings.enabled, false);
    assert.equal(first.permission, 'missing');
    assert.equal(first.viewers, 0);
    assert.equal((await post(path, { ...first.settings, name: '<b>' })).status, 400);
    const saved = await (await post(path, { ...first.settings, enabled: true, name: ' Leaves ', give: true })).json();
    assert.equal(saved.settings.name, 'leaves');
    await post(botPath, { ...(await getJson(botPath)).settings, enabled: true });

    // Bonuses arrive whether or not the stream is live.
    await say('hello', hazel);
    const followed = { user_id: '8002', user_login: 'rowan', user_name: 'Rowan', followed_at: new Date().toISOString() };
    await ev('channel.follow', followed);
    await ev('channel.follow', followed);
    await ev('channel.subscribe', { user_id: '8002', user_login: 'rowan', user_name: 'Rowan', tier: '1000', is_gift: false });
    await ev('channel.cheer', { is_anonymous: false, user_id: '8001', user_login: 'hazel', user_name: 'Hazel', message: 'yay', bits: 250 });
    await ev('channel.subscription.gift', { user_id: '8003', user_login: 'giver', user_name: 'Giver', total: 2, tier: '1000', is_anonymous: false });
    await ev('channel.subscribe', { user_id: '8004', user_login: 'lucky', user_name: 'Lucky', tier: '1000', is_gift: true });
    assert.equal(await balance('rowan'), 300, 'one follow bonus, however often they follow');
    assert.equal(await balance('hazel'), 100, '250 bits pay for two hundreds');
    assert.equal(await balance('giver'), 200);
    assert.equal(await balance('lucky'), 0, 'a gifted sub pays the gifter');

    // Live: who chatted since going live earns watch and chat points.
    await streamState(lid, true);
    await say('first!', hazel);
    assert.ok(await until(async () => (await balance('hazel')) === 115), 'Hazel was paid for watching and chatting');
    await streamState(lid, false);
    assert.equal(await balance('rowan'), 300, 'without the chatter list, quiet viewers are not seen');

    await say('!points', hazel);
    assert.equal(sent().at(-1), 'Hazel has 115 leaves (rank 3).');
    await say('!leaves @Rowan', { id: '8005', name: 'Ash' });
    assert.equal(sent().at(-1), 'Rowan has 300 leaves (rank 1).');
    await say('!top', mod);
    assert.equal(sent().at(-1), 'Most leaves: 1. Rowan 300, 2. Giver 200, 3. Hazel 115');
    await say('!give @rowan 1000', hazel);
    assert.equal(sent().at(-1), 'Hazel, you have 115 leaves.');
    await say('!give @rowan 15', hazel);
    assert.equal(sent().at(-1), 'Hazel gave 15 leaves to Rowan.');
    await say('!addpoints @nobody 10', mod);
    assert.equal(sent().at(-1), 'There is no viewer called nobody.');
    fake.state.users.set('newbie', { id: '8010', login: 'newbie', display_name: 'Newbie' });
    await say('!addpoints @newbie 40', mod);
    assert.equal(sent().at(-1), 'Newbie now has 40 leaves.');
    const quiet = sent().length;
    await say('!addpoints @newbie 40', { id: '8006', name: 'Sneaky' });
    assert.equal(sent().length, quiet, 'only moderators add points');
    await say('!addpoints @rowan -1000', mod);
    assert.equal(sent().at(-1), 'Rowan now has 0 leaves.', 'a balance stops at zero');

    const found = await getJson(`${path}/viewers?q=HAZ`);
    assert.equal(found.total, 1);
    assert.equal(found.viewers[0].earned, 115);
    const adjusted = await (await post(`${path}/viewers/8001/adjust`, { delta: 5, reason: 'Prize' })).json();
    assert.equal(adjusted.balance, 105);
    assert.equal((await post(`${path}/viewers/8001/adjust`, { delta: 0 })).status, 400);
    assert.equal((await post(`${path}/viewers/9999/adjust`, { delta: 5 })).status, 404);
    const { entries } = await getJson(`${path}/viewers/8001/ledger`);
    assert.deepEqual(entries.map((e) => [e.delta, e.reason]),
      [[5, 'Prize'], [-15, 'Gave to Rowan'], [15, 'Watching'], [100, 'Cheered']]);
    assert.equal((await getJson(path)).viewers, 4);

    const tryIt = async (body) => (await post(`${botPath}/try`, body)).json();
    assert.deepEqual(await tryIt({ message: '!top', level: 'everyone' }),
      { reply: 'Most leaves: 1. Giver 200, 2. Hazel 105, 3. Newbie 40', command: 'top' });
    assert.deepEqual(await tryIt({ message: '!addpoints rowan 5', level: 'everyone' }), { skip: 'level', command: 'addpoints' });

    // Games: on by default, bets checked against the limits.
    const giver = { id: '8003', name: 'Giver' };
    await say('!gamble 5', giver);
    assert.equal(sent().at(-1), 'Giver, the smallest bet is 10 leaves.');
    await say('!slots 20', giver);
    assert.match(sent().at(-1), /^\| .+ \| Giver (won|lost) [\d,]+ leaves/);
    await say('!blackjack 10', giver);
    assert.match(sent().at(-1), /Giver/);
    await say('!stand', giver);
    // Raffle: a moderator starts it, a second start is refused.
    await say('!raffle 50', mod);
    assert.equal(sent().at(-1), 'A raffle has begun for 50 leaves! It ends in 30 seconds. Type !join to enter');
    await say('!raffle', mod);
    assert.match(sent().at(-1), /a raffle is already running/);

    await post(path, { ...saved.settings, enabled: false });
    const off = sent().length;
    await say('!points', { id: '8007', name: 'Late' });
    assert.equal(sent().length, off, 'points can be turned off');
  });

  await check('giveaways take entries from chat and draw winners anyone can check', async () => {
    const gid = randomChannelId();
    const base = `/v1/channels/twitch:${gid}`;
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const sent = () => fake.state.chatSent.filter((m) => m.broadcaster_id === gid).map((m) => m.message);
    const say = (text, who) => sendEventSub(chatLine(gid, { text, ...who }));
    const hazel = { id: '8201', name: 'Hazel' };
    const rowan = { id: '8202', name: 'Rowan', badges: ['subscriber'] };
    const sha = (s) => createHash('sha256').update(s).digest();

    assert.equal((await getJson(`${base}/giveaways`)).current, undefined);
    await post(`${base}/bot`, { ...(await getJson(`${base}/bot`)).settings, enabled: true });
    assert.match(await (await post(`${base}/giveaways`, { prize: 'Key', keyword: 'quote' })).text(), /Sylva's own chat words/);
    assert.match(await (await post(`${base}/giveaways`, { prize: '  ', keyword: 'join' })).text(), /Name the prize/);
    assert.match(await (await post(`${base}/giveaways`, { prize: 'Key', keyword: 'join', cost: 10 })).text(), /Turn loyalty points on/);
    const started = await (await post(`${base}/giveaways`, { prize: 'A game key', keyword: '!Join', subLuck: 2 })).json();
    const g = started.current;
    assert.deepEqual([g.status, g.settings.keyword, g.settings.subLuck, g.seed], ['open', 'join', 2, undefined]);
    assert.match(g.seedHash, /^[0-9a-f]{64}$/);
    assert.equal(sent().at(-1), 'Giveaway: A game key! Type !join to enter.');
    assert.equal((await post(`${base}/giveaways`, { prize: 'Another', keyword: 'enter' })).status, 409);

    await say('!join', hazel);
    await say('!join', rowan);
    await say('!join', hazel);
    await say('!join', { id: gid, name: 'Streamer' });
    let view = await getJson(`${base}/giveaways`);
    assert.deepEqual([view.current.entries, view.current.tickets], [2, 3], 'one entry each, two tickets for the subscriber, none for the streamer');
    assert.deepEqual(view.entries.map((e) => [e.name, e.tickets]), [['Rowan', 2], ['Hazel', 1]]);

    view = await (await post(`${base}/giveaways/${g.id}/draw`)).json();
    const drawn = view.current;
    assert.equal(drawn.status, 'closed', 'drawing closes entries');
    assert.equal(sha(drawn.seed).toString('hex'), g.seedHash, 'the seed matches the hash shown at the start');
    // Check the draw by hand: first 8 bytes of sha256("seed:1"), modulo the 3 tickets.
    const n = Number(sha(`${drawn.seed}:1`).readBigUInt64BE(0) % 3n);
    const expected = n < 1 ? 'Hazel' : 'Rowan';
    assert.equal(drawn.winners[0].name, expected);
    assert.equal(sent().at(-1), `@${expected} won A game key! Congratulations!`);
    await say('!join', { id: '8203', name: 'Late' });
    assert.equal((await getJson(`${base}/giveaways`)).current.entries, 2, 'no entries once closed');
    view = await (await post(`${base}/giveaways/${g.id}/draw`)).json();
    assert.deepEqual(view.current.winners.map((w) => w.name).sort(), ['Hazel', 'Rowan'], 'a winner cannot win twice');
    assert.match(await (await post(`${base}/giveaways/${g.id}/draw`)).text(), /already won/);
    assert.equal((await post(`${base}/giveaways/${g.id}/close`)).status, 409);
    assert.equal((await post(`${base}/giveaways/${g.id}/cancel`)).status, 409, 'a giveaway with a winner ends instead');
    view = await (await post(`${base}/giveaways/${g.id}/end`)).json();
    assert.equal(view.current, undefined);
    assert.deepEqual([view.past[0].status, view.past[0].winners.length, view.past[0].seed], ['ended', 2, drawn.seed]);
    assert.equal((await post(`${base}/giveaways/${g.id}/draw`)).status, 409);

    // An entry that costs points, refunded when the giveaway is cancelled.
    const points = (await getJson(`${base}/loyalty`)).settings;
    await post(`${base}/loyalty`, { ...points, enabled: true });
    await sendEventSub({ subType: 'channel.follow', condition: { broadcaster_user_id: gid },
      event: { user_id: '8201', user_login: 'hazel', user_name: 'Hazel', broadcaster_user_id: gid, followed_at: new Date().toISOString() } });
    const paid = (await (await post(`${base}/giveaways`, { prize: 'Signed poster', keyword: 'enter', cost: 30, level: 'everyone' })).json()).current;
    assert.equal(sent().at(-1), 'Giveaway: Signed poster! Type !enter to enter. It costs 30 points.');
    await say('!enter', hazel);
    const balance = async () => (await getJson(`${base}/loyalty/viewers?q=hazel`)).viewers[0].balance;
    assert.equal(await balance(), 20);
    await say('!enter', { id: '8204', name: 'Poor' });
    assert.equal(sent().at(-1), 'Poor, entering costs 30 points and you have 0.');
    const before = sent().length;
    await say('!enter', { id: '8204', name: 'Poor' });
    assert.equal(sent().length, before, 'told once, not on every try');
    view = await (await post(`${base}/giveaways/${paid.id}/cancel`)).json();
    assert.equal(await balance(), 50, 'cancelling gives the points back');
    assert.deepEqual([view.past[0].status, typeof view.past[0].seed], ['cancelled', 'string']);
    assert.equal(sent().at(-1), 'The giveaway for Signed poster was cancelled.');
  });

  await check('timers wait for chat and going live, and Send now posts at once', async () => {
    const tid = randomChannelId();
    const path = `/v1/channels/twitch:${tid}/bot`;
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const sent = () => fake.state.chatSent.filter((m) => m.broadcaster_id === tid);
    const status = async (id) => (await getJson(path)).timers.find((t) => t.id === id);

    const base = (await getJson(path)).settings;
    assert.deepEqual(base.timers, []);
    const bad = await post(path, { ...base, enabled: true, timers: [{ name: 'Hi', message: 'Hi ${user}', interval: 10 }] });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /cannot fill in/);

    const follow = { name: 'Follow reminder', message: 'Enjoying the stream? Follow ${channel}!', interval: 1, lines: 3, liveOnly: false };
    const discord = { name: 'Discord', message: 'Join the Discord', interval: 30, lines: 0 };
    const saved = await (await post(path, { ...base, enabled: true, timers: [follow, discord] })).json();
    assert.deepEqual(saved.settings.timers.map((t) => [t.id, t.interval, t.liveOnly]), [['t1', 5, false], ['t2', 30, true]]);
    assert.deepEqual(saved.timers, [
      { id: 't1', waiting: 'chat', linesNeeded: 3 },
      { id: 't2', waiting: 'live' },
    ]);

    await sendEventSub(chatLine(tid, { text: 'hello' }));
    await sendEventSub(chatLine(tid, { text: 'hi', id: '7002', name: 'Hazel' }));
    assert.deepEqual(await status('t1'), { id: 't1', waiting: 'chat', linesNeeded: 1 });
    await sendEventSub(chatLine(tid, { text: 'gg' }));
    const ready = await status('t1');
    assert.ok(ready.nextAt > Date.now() + 4 * 60_000 && ready.nextAt < Date.now() + 5 * 60_000 + 5_000, 'five minutes after it was saved');

    await sendEventSub({
      subType: 'stream.online', condition: { broadcaster_user_id: tid },
      event: { id: randomUUID(), broadcaster_user_id: tid, broadcaster_user_login: 'timertester',
               broadcaster_user_name: 'TimerTester', type: 'live', started_at: new Date().toISOString() },
    });
    const live = await getJson(path);
    assert.equal(live.live, true);
    assert.ok(live.timers.find((t) => t.id === 't2').nextAt > Date.now() + 29 * 60_000);
    assert.deepEqual(live.timers.find((t) => t.id === 't1'), { id: 't1', waiting: 'chat', linesNeeded: 3 }, 'going live starts every timer again');

    const now = await (await post(`${path}/timers/t1/send`)).json();
    assert.deepEqual(sent().map((m) => m.message), ['Enjoying the stream? Follow TimerTester!']);
    assert.deepEqual(now.timers.find((t) => t.id === 't1'), { id: 't1', waiting: 'chat', linesNeeded: 3 });
    // The bot's own message coming back is not a viewer's line.
    await sendEventSub(chatLine(tid, { text: 'Enjoying the stream? Follow TimerTester!', id: tid, name: 'TimerTester' }));
    assert.equal((await status('t1')).linesNeeded, 3);
    assert.equal((await post(`${path}/timers/t9/send`)).status, 404);
    await post(path, { ...saved.settings, enabled: false });
    assert.equal((await post(`${path}/timers/t1/send`)).status, 409);
    assert.equal((await status('t1')).waiting, 'bot');
  });

  await check('signing in makes an account, subscribes the channel and starts a session', async () => {
    const res = await signIn();
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/app');
    session = cookieOf(res, 'sylva_session');
    assert.match(session, /^[0-9a-f]{32}\.[0-9a-f]{64}$/);
    assert.equal(cookieOf(res, 'sylva_oauth'), '', 'the state cookie is cleared');
    const exchange = fake.state.tokenRequests.find((r) => r.grant_type === 'authorization_code');
    assert.equal(exchange.redirect_uri, `${BASE}/auth/twitch/callback`);

    const types = fake.state.subscriptions.map((s) => s.type).sort();
    assert.deepEqual(types, ['channel.chat.message', 'channel.chat.notification', 'channel.cheer', 'channel.follow',
      'channel.raid', 'channel.subscribe', 'channel.subscription.gift', 'channel.subscription.message',
      'channel.update', 'stream.offline', 'stream.online'], 'chat alert events that need Allow alerts are skipped');
    assert.ok(fake.state.subscriptions.every((s) => s.transport.method === 'conduit'
      && s.transport.conduit_id === 'fake-conduit'));
    const chatSub = fake.state.subscriptions.find((s) => s.type === 'channel.chat.message');
    assert.deepEqual(chatSub.condition, { broadcaster_user_id: FAKE_USER.id, user_id: FAKE_USER.id });
  });

  let accountId;
  await check('/v1/me says who is signed in, and nothing without the cookie', async () => {
    const res = await fetch(`${BASE}/v1/me`, { headers: asOwner() });
    assert.equal(res.status, 200);
    const me = await res.json();
    accountId = me.accountId;
    assert.equal(me.accountId, session.split('.')[0]);
    assert.deepEqual(me.channels, [{ key: ownKey, role: 'owner', name: FAKE_USER.display_name, login: FAKE_USER.login, avatar: '' }]);
    assert.equal(me.identities[0].login, FAKE_USER.login);
    assert.equal(me.identities[0].displayName, FAKE_USER.display_name);
    assert.ok(!JSON.stringify(me).includes('user-'), 'tokens never leave the account');
    assert.equal((await fetch(`${BASE}/v1/me`)).status, 401);
    const forged = session.split('.')[0] + '.' + 'a'.repeat(64);
    assert.equal((await fetch(`${BASE}/v1/me`, { headers: { Cookie: `sylva_session=${forged}` } })).status, 401);
  });

  await check('the owner can use their channel and no one else\'s', async () => {
    assert.equal((await fetch(`${BASE}/v1/channels/${ownKey}/state`, { headers: asOwner() })).status, 200);
    assert.equal((await fetch(`${BASE}/v1/channels/${key}/state`, { headers: asOwner() })).status, 403);
  });

  let watcherSession;
  await check('the owner adds a team, and each role can do only its part', async () => {
    const helper = { id: '8301', login: 'helper', display_name: 'Helper', profile_image_url: '' };
    const watcher = { id: '8302', login: 'watcher', display_name: 'Watcher', profile_image_url: '' };
    fake.state.users.set(helper.login, helper);
    fake.state.users.set(watcher.login, watcher);
    const ch = `${BASE}/v1/channels/${ownKey}`;
    const as = (cookie) => (path, body) => fetch(`${ch}/${path}`, body === undefined
      ? { headers: { Cookie: `sylva_session=${cookie}` } }
      : { method: 'POST', headers: { Cookie: `sylva_session=${cookie}`, Origin: BASE, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const owner = as(session);
    const signInAs = async (user) => {
      fake.state.as = user;
      try { return cookieOf(await signIn(), 'sylva_session'); } finally { fake.state.as = null; }
    };
    const me = async (cookie) => (await fetch(`${BASE}/v1/me`, { headers: { Cookie: `sylva_session=${cookie}` } })).json();

    // Start from no team, whatever an earlier run left.
    for (const m of (await (await owner('team')).json()).team) await owner(`team/${m.id}/remove`, {});
    assert.equal((await owner('team', { login: 'nobody_here', role: 'editor' })).status, 404);
    assert.match(await (await owner('team', { login: FAKE_USER.login, role: 'editor' })).text(), /own this channel/);
    assert.equal((await owner('team', { login: 'helper', role: 'owner' })).status, 400);
    assert.equal((await owner('team', { login: 'two words', role: 'editor' })).status, 400);
    let team = (await (await owner('team', { login: '@Helper', role: 'editor' })).json()).team;
    // `joined` may already be true here when an earlier run signed Helper in.
    assert.deepEqual(team.map((m) => [m.login, m.name, m.role]), [['helper', 'Helper', 'editor']]);

    // Helper signs in and finds the channel next to their own.
    const helperSession = await signInAs(helper);
    assert.deepEqual((await me(helperSession)).channels.map((c) => [c.key, c.role, c.name]),
      [['twitch:8301', 'owner', 'Helper'], [ownKey, 'editor', FAKE_USER.display_name]]);
    assert.equal((await (await owner('team')).json()).team[0].joined, true);
    const asHelper = as(helperSession);

    // An editor changes settings, but not the team or the overlay link.
    const alertSettings = (await (await asHelper('alert-settings')).json()).settings;
    assert.equal((await asHelper('alert-settings', alertSettings)).status, 200);
    assert.equal((await asHelper('overlay')).status, 200);
    assert.equal((await asHelper('overlay/rotate', {})).status, 403);
    assert.equal((await asHelper('team')).status, 403);
    assert.equal((await asHelper('team', { login: 'watcher', role: 'editor' })).status, 403);
    assert.equal((await fetch(`${BASE}/v1/channels/twitch:8301/state`, { headers: { Cookie: `sylva_session=${session}` } })).status, 403,
      'the owner cannot open the helper\'s own channel');

    // A moderator runs the live parts only, and the change applies at once.
    await owner('team', { login: 'helper', role: 'moderator' });
    assert.equal((await asHelper('alerts/pause', {})).status, 200);
    assert.equal((await asHelper('alerts/resume', {})).status, 200);
    const bot = await asHelper('bot', (await (await asHelper('bot')).json()).settings);
    assert.equal(bot.status, 403);
    assert.equal(await bot.text(), 'A moderator cannot do that on this channel');
    assert.equal((await asHelper('overlay')).status, 403, 'the overlay link stays with editors');

    // A viewer only looks.
    await owner('team', { login: 'helper', role: 'viewer' });
    assert.equal((await asHelper('history?filter=alerts')).status, 200);
    assert.equal((await asHelper('alerts/pause', {})).status, 403);

    // Someone added before they ever sign in sees the channel when they do.
    team = (await (await owner('team', { login: 'watcher', role: 'viewer' })).json()).team;
    assert.deepEqual(team.map((m) => [m.login, m.role]), [['helper', 'viewer'], ['watcher', 'viewer']]);
    assert.equal(team[0].joined, true);
    watcherSession = await signInAs(watcher);
    assert.deepEqual((await me(watcherSession)).channels.map((c) => [c.key, c.role]), [['twitch:8302', 'owner'], [ownKey, 'viewer']]);

    // Removing someone takes the channel away at once.
    assert.deepEqual((await (await owner('team/8301/remove', {})).json()).team.map((m) => m.login), ['watcher']);
    assert.equal((await owner('team/8301/remove', {})).status, 404);
    assert.equal(await (await asHelper('state')).text(), 'This is not your channel');
    assert.deepEqual((await me(helperSession)).channels.map((c) => c.key), ['twitch:8301']);
    // And signing in again does not bring it back.
    assert.deepEqual((await me(await signInAs(helper))).channels.map((c) => c.key), ['twitch:8301']);
  });

  await check('changes with a cookie must come from Sylva\'s own pages', async () => {
    const path = `${BASE}/v1/channels/${ownKey}/alerts/pause`;
    assert.equal((await fetch(path, { method: 'POST', headers: asOwner() })).status, 403);
    assert.equal((await fetch(path, { method: 'POST', headers: asOwner({ Origin: 'https://evil.example' }) })).status, 403);
    const ok = await fetch(path, { method: 'POST', headers: asOwner({ Origin: BASE }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).paused, true);
    await fetch(`${BASE}/v1/channels/${ownKey}/alerts/resume`, { method: 'POST', headers: asOwner({ Origin: BASE }) });
  });

  await check('the owner\'s dashboard socket replays and goes live', async () => {
    await sendEventSub(follow(FAKE_USER.id, 1));
    const feed = new Client(ownKey, 'feed', 0, { headers: asOwner() });
    await feed.opened;
    await feed.next((f) => f.type === 'event' && f.kind === 'follow');
    await sendEventSub(chat(FAKE_USER.id, 1));
    await feed.next((f) => f.type === 'event' && f.kind === 'chat');
    await feed.close();
  });

  await check('the dashboard sees every Twitch event as on', async () => {
    const res = await fetch(`${BASE}/v1/channels/${ownKey}/twitch`, { headers: asOwner() });
    const { features } = await res.json();
    assert.deepEqual(features.map((f) => [f.feature, f.on]),
      [['follows', true], ['subs', true], ['cheers', true], ['chat', true], ['raids', true], ['stream', true]]);
  });

  await check('a missing subscription shows as off, and turning on again fixes it', async () => {
    fake.state.subscriptions = fake.state.subscriptions.filter((s) => s.type !== 'channel.cheer');
    const before = await (await fetch(`${BASE}/v1/channels/${ownKey}/twitch`, { headers: asOwner() })).json();
    const cheers = before.features.find((f) => f.feature === 'cheers');
    assert.equal(cheers.on, false);
    assert.deepEqual(cheers.problems, ['channel.cheer: missing']);
    const res = await fetch(`${BASE}/v1/channels/${ownKey}/twitch/subscribe`, { method: 'POST', headers: asOwner({ Origin: BASE }) });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).features.every((f) => f.on));
  });

  await check('when Twitch refuses permission, the dashboard is told to sign in again', async () => {
    fake.state.subscriptions = [];
    fake.state.failSubscriptions = 403;
    try {
      const res = await fetch(`${BASE}/v1/channels/${ownKey}/twitch/subscribe`, { method: 'POST', headers: asOwner({ Origin: BASE }) });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { ok: false, needsSignIn: true });
    } finally {
      fake.state.failSubscriptions = null;
    }
  });

  await check('signing in again keeps the same account', async () => {
    const res = await signIn();
    const again = cookieOf(res, 'sylva_session');
    assert.equal(again.split('.')[0], accountId);
    assert.notEqual(again, session);
    assert.equal(fake.state.subscriptions.length, 11, 'subscriptions are made again');
  });

  await check('a sign in without every permission is refused', async () => {
    const all = fake.state.grant;
    fake.state.grant = ['bits:read'];
    try {
      const res = await signIn();
      assert.equal(res.headers.get('location'), '/?signin=scopes');
      assert.equal(cookieOf(res, 'sylva_session'), null);
    } finally {
      fake.state.grant = all;
    }
  });

  await check('moderation deletes, then times out, logs it, and lifts a timeout', async () => {
    const tid = FAKE_USER.id;
    const path = `/v1/channels/twitch:${tid}/moderation`;
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const log = async () => (await getJson(`${path}/log`)).entries;
    const acts = () => fake.state.modActions.filter((a) => a.broadcaster_id === tid);
    const say = (text, opts = {}) => sendEventSub(chatLine(tid, { text, ...opts }));

    const first = await getJson(path);
    assert.equal(first.settings.preset, 'off');
    assert.equal(first.permission, 'missing', 'a plain sign in does not allow moderation');
    assert.deepEqual(first.presets.map(([p]) => p), ['relaxed', 'standard', 'strict']);

    const bad = await post(path, { ...first.settings, preset: 'custom', allowedLinks: ['not a site'] });
    assert.equal(bad.status, 400);
    const saved = await (await post(path, { ...first.settings, preset: 'standard', words: ['Badword'] })).json();
    assert.equal(saved.settings.preset, 'standard');
    assert.equal(saved.settings.rules.caps.on, true);
    assert.deepEqual(saved.settings.steps, [0, 300, 1800]);
    assert.deepEqual(saved.settings.words, ['badword']);

    const tried = await (await post(`${path}/try`, { message: 'WHY IS EVERYONE SHOUTING TODAY' })).json();
    assert.deepEqual(tried, { rule: 'caps', skipped: false, steps: [0, 300, 1800] });
    const vip = await (await post(`${path}/try`, { message: 'WHY IS EVERYONE SHOUTING TODAY', level: 'vip' })).json();
    assert.equal(vip.skipped, true);

    // Not allowed yet: the line is logged as failed and nothing reaches Twitch.
    await say('cheap followers at spam.xyz', { id: '9001', name: 'Spammy' });
    let entries = await log();
    assert.equal(entries[0].rule, 'links');
    assert.equal(entries[0].result, 'failed');
    assert.match(entries[0].detail, /Allow moderation/);
    assert.deepEqual(acts(), []);

    // Allow moderation. The token is already expired, so Sylva must refresh it.
    const start = await fetch(`${BASE}/auth/twitch/start?scopes=moderation&next=/app/moderation`, { redirect: 'manual' });
    assert.match(new URL(start.headers.get('location')).searchParams.get('scope'), / moderator:manage:chat_messages moderator:manage:banned_users$/);
    fake.state.tokenTtl = 0;
    let done;
    try {
      const approve = await fetch(start.headers.get('location'), { redirect: 'manual' });
      done = await fetch(approve.headers.get('location'), { redirect: 'manual', headers: { Cookie: `sylva_oauth=${cookieOf(start, 'sylva_oauth')}; sylva_next=${cookieOf(start, 'sylva_next')}` } });
    } finally {
      fake.state.tokenTtl = 14000;
    }
    assert.equal(done.headers.get('location'), '/app/moderation');
    const refreshes = () => fake.state.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length;
    const before = refreshes();
    assert.equal((await getJson(path)).permission, 'ok');
    assert.equal(refreshes(), before + 1, 'the expired token was refreshed');
    // A later plain sign in asks for less, but moderation keeps working.
    await signIn();
    assert.equal((await getJson(path)).permission, 'ok');

    const sent = () => fake.state.chatSent.filter((m) => m.broadcaster_id === tid).map((m) => m.message);
    const chatBefore = sent().length;
    await say('cheap followers at spam.xyz', { id: '9001', name: 'Spammy' });
    assert.equal(acts().at(-1).type, 'delete', 'a strike that never reached Twitch does not count');
    await say('this badword here', { id: '9002', name: 'Rude' });
    assert.equal(acts().length, 2);
    assert.equal(acts()[1].type, 'delete');
    assert.ok(acts()[1].message_id);
    assert.deepEqual(sent().slice(chatBefore), ['@Spammy, links are not allowed here (message removed).'],
      'notices are spaced out, so the second one is not sent');

    // Again within the hour: a timeout.
    await say('BUY NOW cheap.xyz', { id: '9002', name: 'Rude' });
    const timeout = acts().at(-1);
    assert.deepEqual([timeout.type, timeout.user_id, timeout.duration], ['timeout', '9002', 300]);
    entries = await log();
    assert.deepEqual([entries[0].action, entries[0].seconds, entries[0].result, entries[0].user], ['timeout', 300, 'done', 'Rude']);

    // Moderators, VIPs and the streamer are left alone; subscribers are not.
    const count = acts().length;
    await say('spam.xyz', { id: '9003', name: 'Mod', badges: ['moderator'] });
    await say('spam.xyz', { id: '9004', name: 'Vippy', badges: ['vip'] });
    await say('spam.xyz', { id: tid, name: FAKE_USER.display_name });
    assert.equal(acts().length, count);
    await say('spam.xyz', { id: '9005', name: 'Subby', badges: ['subscriber'] });
    assert.equal(acts().length, count + 1);

    // Lift the timeout from the log; a deleted message cannot come back.
    const undo = await post(`${path}/log/${entries[0].id}/undo`);
    assert.equal(undo.status, 200);
    assert.ok((await undo.json()).undoneAt);
    assert.deepEqual(acts().at(-1), { type: 'unban', broadcaster_id: tid, moderator_id: tid, user_id: '9002' });
    assert.equal((await post(`${path}/log/${entries[0].id}/undo`)).status, 409);
    const deleted = (await log()).find((e) => e.action === 'delete' && e.result === 'done');
    assert.match(await (await post(`${path}/log/${deleted.id}/undo`)).text(), /cannot bring back/);
    assert.equal((await post(`${path}/log/999999/undo`)).status, 404);

    // Off again, so the rest of the run is not moderated.
    await post(path, { ...saved.settings, preset: 'off' });
    await say('spam.xyz', { id: '9006', name: 'Late' });
    assert.equal(acts().length, count + 2);
  });

  await check('with the chatter list allowed, viewers who only watch earn too', async () => {
    const tid = FAKE_USER.id;
    const path = `/v1/channels/twitch:${tid}/loyalty`;
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    assert.equal((await getJson(path)).permission, 'missing');
    const start = await fetch(`${BASE}/auth/twitch/start?scopes=loyalty&next=/app/loyalty`, { redirect: 'manual' });
    assert.ok(new URL(start.headers.get('location')).searchParams.get('scope').endsWith(` ${LOYALTY_SCOPES[0]}`));
    const approve = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const done = await fetch(approve.headers.get('location'), { redirect: 'manual', headers: { Cookie: `sylva_oauth=${cookieOf(start, 'sylva_oauth')}; sylva_next=${cookieOf(start, 'sylva_next')}` } });
    assert.equal(done.headers.get('location'), '/app/loyalty');
    assert.equal((await getJson(path)).permission, 'ok');
    assert.equal((await getJson(`/v1/channels/twitch:${tid}/moderation`)).permission, 'ok', 'moderation is still allowed');

    fake.state.chatters.set(tid, [
      { user_id: '9501', user_login: 'lurker', user_name: 'Lurker' },
      { user_id: tid, user_login: FAKE_USER.login, user_name: FAKE_USER.display_name },
    ]);
    const settings = (await getJson(path)).settings;
    await post(path, { ...settings, enabled: true, watch: 10 });
    await streamState(tid, true, FAKE_USER.login, FAKE_USER.display_name);
    try {
      const paid = await until(async () => (await getJson(`${path}/viewers`)).viewers.find((v) => v.login === 'lurker')?.balance === 10);
      assert.ok(paid, 'the lurker earned watch points');
      const { viewers } = await getJson(`${path}/viewers`);
      assert.ok(!viewers.some((v) => v.id === tid), 'the streamer earns nothing');
    } finally {
      await streamState(tid, false, FAKE_USER.login, FAKE_USER.display_name);
      await post(path, { ...settings, enabled: false });
    }
  });

  await check('the points store sells rewards in chat, queues them, refunds, and shows a public page', async () => {
    const tid = FAKE_USER.id;
    const base = `/v1/channels/twitch:${tid}`;
    const post = (p, body) => fetch(`${BASE}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const sent = () => fake.state.chatSent.filter((m) => m.broadcaster_id === tid).map((m) => m.message);
    const say = (text, who) => sendEventSub(chatLine(tid, { text, ...who }));
    const buyer = { id: '8101', name: 'Buyer' };
    const mod = { id: '8109', name: 'Modly', badges: ['moderator'] };
    const points = (await getJson(`${base}/loyalty`)).settings;
    await post(`${base}/loyalty`, { ...points, enabled: true, name: 'leaves' });
    const bot = (await getJson(`${base}/bot`)).settings;
    await post(`${base}/bot`, { ...bot, enabled: true });
    try {
      // Start empty, whatever an earlier run left.
      const first = await (await post(`${base}/loyalty/store`, { enabled: false, items: [] })).json();
      assert.deepEqual(first.settings, { enabled: false, items: [] });
      for (const r of (await getJson(`${base}/loyalty/redemptions`)).redemptions) await post(`${base}/loyalty/redemptions/${r.id}/refund`);
      assert.equal(first.pointsOn, true);
      assert.equal(first.login, FAKE_USER.login, 'the login comes from Twitch events');
      assert.match(await (await post(`${base}/loyalty/store`, { enabled: true, items: [{ name: '1up', cost: 5 }] })).text(), /starts with a number/);
      const saved = await (await post(`${base}/loyalty/store`, { enabled: true, items: [
        { name: 'Hydrate', cost: 100 },
        { name: 'Song request', cost: 300, input: true, cooldown: 10, description: 'Name a song' },
        { name: 'Shoutout', cost: 50, stock: 1 },
      ] })).json();
      assert.deepEqual(saved.settings.items.map((i) => [i.id, i.name, i.enabled]), [['r1', 'Hydrate', true], ['r2', 'Song request', true], ['r3', 'Shoutout', true]]);

      fake.state.users.set('buyer', { id: '8101', login: 'buyer', display_name: 'Buyer' });
      await say('!addpoints @buyer 1000', mod);
      await say('!store', buyer);
      assert.equal(sent().at(-1), `Rewards for leaves: 1. Hydrate (100), 2. Song request (300), 3. Shoutout (50). Redeem with !redeem and a number. All rewards: ${BASE}/s/${FAKE_USER.login}`);
      await say('!redeem 2', buyer);
      assert.equal(sent().at(-1), 'Song request needs a message: !redeem 2 and your message.');
      await say('!redeem song REQUEST Darude Sandstorm', buyer);
      assert.equal(sent().at(-1), 'Buyer redeemed Song request for 300 leaves.');
      await say('!redeem 2 again', buyer);
      assert.equal(sent().at(-1), 'Buyer, you can redeem Song request again in 10 minutes.');
      await say('!redeem shoutout', buyer);
      assert.equal(sent().at(-1), 'Buyer redeemed Shoutout for 50 leaves.');
      await say('!redeem 3', { id: '8102', name: 'Late' });
      assert.equal(sent().at(-1), 'Shoutout is sold out.');
      await say('!redeem 1', { id: '8103', name: 'Poor' });
      assert.equal(sent().at(-1), 'Poor, Hydrate costs 100 leaves and you have 0.');
      await say('!redeem pizza', buyer);
      assert.equal(sent().at(-1), 'There is no reward like that. See them with !store.');
      const balance = async () => (await getJson(`${base}/loyalty/viewers?q=buyer`)).viewers[0].balance;
      assert.equal(await balance(), 650);
      assert.equal((await getJson(`${base}/loyalty/store`)).settings.items[2].stock, 0);

      const queue = (await getJson(`${base}/loyalty/redemptions`)).redemptions;
      assert.deepEqual(queue.map((r) => [r.itemName, r.input, r.name, r.status]),
        [['Song request', 'Darude Sandstorm', 'Buyer', 'pending'], ['Shoutout', '', 'Buyer', 'pending']]);
      const [song, shout] = queue;
      assert.equal((await (await post(`${base}/loyalty/redemptions/${song.id}/done`)).json()).status, 'done');
      assert.equal((await post(`${base}/loyalty/redemptions/${song.id}/done`)).status, 409);
      assert.equal((await (await post(`${base}/loyalty/redemptions/${song.id}/reopen`)).json()).status, 'pending');
      assert.equal((await (await post(`${base}/loyalty/redemptions/${shout.id}/refund`)).json()).status, 'refunded');
      assert.equal((await post(`${base}/loyalty/redemptions/${shout.id}/refund`)).status, 409);
      assert.equal((await post(`${base}/loyalty/redemptions/999999/done`)).status, 404);
      assert.equal(await balance(), 700, 'a refund gives the points back');
      assert.equal((await getJson(`${base}/loyalty/store`)).settings.items[2].stock, 1, 'and the reward back to the stock');
      // History is newest first; earlier runs on this channel may sit below this one.
      assert.deepEqual((await getJson(`${base}/loyalty/redemptions?status=done`)).redemptions.filter((r) => r.id >= song.id).map((r) => [r.id, r.status]), [[shout.id, 'refunded']]);
      assert.equal((await getJson(`${base}/loyalty/store`)).pending, 1);

      const pub = await fetch(`${BASE}/v1/public/${FAKE_USER.login}?viewer=@Buyer`);
      assert.equal(pub.status, 200);
      const page = await pub.json();
      assert.deepEqual(page.items.map((i) => [i.number, i.name, i.cost]), [[1, 'Hydrate', 100], [2, 'Song request', 300], [3, 'Shoutout', 50]]);
      assert.equal(page.pointsName, 'leaves');
      assert.equal(page.channel, FAKE_USER.display_name);
      const place = page.top.findIndex((v) => v.name === 'Buyer') + 1;
      assert.ok(place > 0, 'Buyer is on the leaderboard');
      assert.deepEqual(page.viewer, { name: 'Buyer', balance: 700, rank: place });
      assert.equal((await fetch(`${BASE}/v1/public/nobody_here`)).status, 404);

      const tried = await (await post(`${base}/bot/try`, { message: '!redeem 1', level: 'everyone' })).json();
      assert.deepEqual(tried, { reply: 'Maple redeemed Hydrate for 100 leaves.', command: 'redeem' });

      await post(`${base}/loyalty/store`, { ...saved.settings, enabled: false });
      const quiet = sent().length;
      await say('!redeem 1', mod);
      assert.equal(sent().length, quiet, 'the store can be turned off');
      const closed = await (await fetch(`${BASE}/v1/public/${FAKE_USER.login}`)).json();
      assert.deepEqual([closed.storeOn, closed.items.length], [false, 0]);
    } finally {
      await post(`${base}/loyalty`, { ...points, enabled: false });
      await post(`${base}/bot`, bot);
    }
  });

  const json = (body) => ({ 'Content-Type': 'application/json', ...body });
  const startDevice = async () => {
    const res = await fetch(`${BASE}/v1/device/code`, { method: 'POST', headers: json({}), body: JSON.stringify({ clientName: 'Cortex' }) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const poll = async (deviceCode) => {
    const res = await fetch(`${BASE}/v1/device/token`, { method: 'POST', headers: json({}), body: JSON.stringify({ deviceCode }) });
    return { status: res.status, body: await res.json() };
  };

  await check('sign in can return to the device page, and only to Sylva pages', async () => {
    const next = (n) => fetch(`${BASE}/auth/twitch/start?next=${encodeURIComponent(n)}`, { redirect: 'manual' });
    const ok = await next('/device?code=BCDF-GHJK');
    assert.equal(Buffer.from(cookieOf(ok, 'sylva_next'), 'hex').toString(), '/device?code=BCDF-GHJK');
    for (const bad of ['https://evil.example', '//evil.example', '/auth/sign-out', '/device<script>']) {
      assert.equal(cookieOf(await next(bad), 'sylva_next'), null, bad);
    }
  });

  let apiToken;
  await check('an app signs in with a device code and gets an API token once', async () => {
    const d = await startDevice();
    assert.match(d.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.match(d.device_code, /^[0-9a-f]{64}$/);
    assert.equal(d.verification_uri, `${BASE}/device`);
    assert.equal(d.verification_uri_complete, `${BASE}/device?code=${d.user_code}`);
    assert.deepEqual([d.expires_in, d.interval], [600, 5]);

    assert.equal((await poll(d.device_code)).body.error, 'authorization_pending');
    assert.equal((await poll(d.device_code)).body.error, 'slow_down', 'polled too fast');
    assert.equal((await poll('f'.repeat(64))).body.error, 'expired_token');

    const lookup = `${BASE}/v1/device?code=${d.user_code.toLowerCase().replace('-', ' ')}`;
    assert.equal((await fetch(lookup)).status, 401, 'needs the browser session');
    const found = await (await fetch(lookup, { headers: asOwner() })).json();
    assert.deepEqual(found, { userCode: d.user_code, appName: 'Cortex' });
    assert.equal((await fetch(`${BASE}/v1/device?code=NOPE`, { headers: asOwner() })).status, 400);

    const approve = (code, yes, origin = BASE) => fetch(`${BASE}/v1/device`, {
      method: 'POST', headers: asOwner(json({ Origin: origin })), body: JSON.stringify({ userCode: code, approve: yes }),
    });
    assert.equal((await approve(d.user_code, true, 'https://evil.example')).status, 403);
    const r = await approve(d.user_code, true);
    assert.equal(r.status, 200);
    assert.equal((await approve(d.user_code, true)).status, 404, 'a code is used once');

    const got = await poll(d.device_code);
    assert.equal(got.status, 200);
    assert.match(got.body.access_token, /^sylva_[0-9a-f]{32}\.[0-9a-f]{64}$/);
    assert.equal(got.body.token_type, 'Bearer');
    assert.equal(got.body.account_id, accountId);
    apiToken = got.body.access_token;
    assert.equal((await poll(d.device_code)).body.error, 'expired_token', 'handed out once');
  });

  await check('the API token works like the owner, without cookies or Origin', async () => {
    const bearer = { Authorization: `Bearer ${apiToken}` };
    const me = await (await fetch(`${BASE}/v1/me`, { headers: bearer })).json();
    assert.equal(me.accountId, accountId);
    assert.equal((await fetch(`${BASE}/v1/channels/${ownKey}/state`, { headers: bearer })).status, 200);
    assert.equal((await fetch(`${BASE}/v1/channels/${key}/state`, { headers: bearer })).status, 403);
    const paused = await fetch(`${BASE}/v1/channels/${ownKey}/alerts/pause`, { method: 'POST', headers: bearer });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).paused, true);
    await fetch(`${BASE}/v1/channels/${ownKey}/alerts/resume`, { method: 'POST', headers: bearer });
    const feed = new Client(ownKey, 'feed', 0, { headers: bearer });
    await feed.opened;
    await feed.ready();
    await feed.close();
    assert.equal((await fetch(`${BASE}/v1/apps`, { headers: bearer })).status, 401, 'apps cannot list apps');
    const other = await startDevice();
    const byApp = await fetch(`${BASE}/v1/device`, {
      method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ userCode: other.user_code, approve: true }),
    });
    assert.equal(byApp.status, 401, 'an app cannot approve another app');
    const wrong = apiToken.slice(0, -4) + 'aaaa';
    assert.equal((await fetch(`${BASE}/v1/me`, { headers: { Authorization: `Bearer ${wrong}` } })).status, 401);
  });

  await check('denying an app, and removing one, both stop it', async () => {
    const d = await startDevice();
    const deny = await fetch(`${BASE}/v1/device`, {
      method: 'POST', headers: asOwner(json({ Origin: BASE })), body: JSON.stringify({ userCode: d.user_code, approve: false }),
    });
    assert.deepEqual(await deny.json(), { approved: false });
    assert.equal((await poll(d.device_code)).body.error, 'access_denied');

    // A local test database may hold apps from earlier runs: use the newest.
    const apps = await (await fetch(`${BASE}/v1/apps`, { headers: asOwner() })).json();
    const app = apps[0];
    assert.equal(app.name, 'Cortex');
    assert.ok(app.lastUsedAt > 0, 'last use is recorded');
    assert.ok(!JSON.stringify(apps).includes(apiToken.split('.')[1]), 'the secret is never listed');
    const revoke = (origin) => fetch(`${BASE}/v1/apps/${app.id}/revoke`, { method: 'POST', headers: asOwner({ Origin: origin }) });
    assert.equal((await revoke('https://evil.example')).status, 403);
    assert.equal((await revoke(BASE)).status, 200);
    assert.equal((await fetch(`${BASE}/v1/me`, { headers: { Authorization: `Bearer ${apiToken}` } })).status, 401);
    const after = await (await fetch(`${BASE}/v1/apps`, { headers: asOwner() })).json();
    assert.equal(after.length, apps.length - 1);
    assert.ok(!after.some((x) => x.id === app.id));
  });

  await check('signing out ends the session', async () => {
    assert.equal((await fetch(`${BASE}/auth/sign-out`, { method: 'POST', headers: asOwner() })).status, 403);
    const res = await fetch(`${BASE}/auth/sign-out`, { method: 'POST', headers: asOwner({ Origin: BASE }) });
    assert.equal(res.status, 200);
    assert.equal(cookieOf(res, 'sylva_session'), '');
    assert.equal((await fetch(`${BASE}/v1/me`, { headers: asOwner() })).status, 401);
  });

  await check('deleting the account erases it everywhere, and only when confirmed', async () => {
    session = cookieOf(await signIn(), 'sylva_session');
    const me = await (await fetch(`${BASE}/v1/me`, { headers: asOwner() })).json();
    const mine = me.channels[0].key;
    const chUrl = `${BASE}/v1/channels/${encodeURIComponent(mine)}`;
    const ev = await fetch(`${chUrl}/test-event`, {
      method: 'POST', headers: asOwner(json({ Origin: BASE })), body: JSON.stringify({ kind: 'follow', name: 'BeforeDelete' }),
    });
    assert.equal(ev.status, 200);
    // An app connected to the account, to check it stops working too.
    const d = await startDevice();
    await fetch(`${BASE}/v1/device`, { method: 'POST', headers: asOwner(json({ Origin: BASE })), body: JSON.stringify({ userCode: d.user_code, approve: true }) });
    const app = (await poll(d.device_code)).body.access_token;
    assert.match(app, /^sylva_/);

    const del = (headers, confirm = FAKE_USER.login) => fetch(`${BASE}/v1/account/delete`, {
      method: 'POST', headers: json(headers), body: JSON.stringify({ confirm }),
    });
    assert.equal((await del(asOwner())).status, 403, 'needs same origin');
    assert.equal((await del({ Authorization: `Bearer ${app}`, Origin: BASE })).status, 401, 'an app cannot');
    assert.equal((await del(asOwner({ Origin: BASE }), 'someone-else')).status, 400, 'must name the account');

    fake.state.failDeletes = 503;
    const refused = await del(asOwner({ Origin: BASE }));
    fake.state.failDeletes = null;
    assert.equal(refused.status, 502);
    assert.equal((await fetch(`${BASE}/v1/me`, { headers: asOwner() })).status, 200, 'nothing deleted when Twitch fails');

    const before = fake.state.revoked.length;
    const res = await del(asOwner({ Origin: BASE }), FAKE_USER.login.toUpperCase());
    assert.equal(res.status, 200);
    assert.equal(cookieOf(res, 'sylva_session'), '');
    assert.equal((await fetch(`${BASE}/v1/me`, { headers: asOwner() })).status, 401);
    assert.equal((await fetch(`${BASE}/v1/me`, { headers: { Authorization: `Bearer ${app}` } })).status, 401);
    assert.deepEqual(fake.state.subscriptions.filter((x) => Object.values(x.condition).includes(FAKE_USER.id)), []);
    assert.ok(fake.state.revoked.length > before, 'the Twitch token was revoked');
    const hist = await fetch(`${chUrl}/history?filter=alerts`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.deepEqual((await hist.json()).events, []);
    assert.deepEqual((await getJson(`/v1/channels/${encodeURIComponent(mine)}/moderation/log`)).entries, [], 'the moderation log is erased');
    const watcherMe = await (await fetch(`${BASE}/v1/me`, { headers: { Cookie: `sylva_session=${watcherSession}` } })).json();
    assert.deepEqual(watcherMe.channels.map((c) => c.key), ['twitch:8302'], 'teammates lose the deleted channel');
    assert.deepEqual((await getJson(`/v1/channels/${encodeURIComponent(mine)}/team`)).team, [], 'and the team is gone');

    // Signing in again starts a new, empty account.
    session = cookieOf(await signIn(), 'sylva_session');
    const again = await (await fetch(`${BASE}/v1/me`, { headers: asOwner() })).json();
    assert.notEqual(again.accountId, me.accountId);
    assert.equal(again.channels[0].key, mine);
  });
}
await fake?.close();

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

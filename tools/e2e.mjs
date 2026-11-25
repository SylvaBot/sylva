// End to end checks against a running Worker: Twitch webhooks in, alerts and
// replay out, overlay links, and signing in with Twitch.
//
// Run `npm run dev:test` in one terminal and `npm run test:e2e` in another.
// dev:test points the Worker at a fake Twitch that this script starts on
// :8788, so the sign in checks run too. Against plain `npm run dev` they are
// skipped. Set SKIP_SLOW=1 to skip the 30 second alarm test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ADMIN, BASE, admin, chat, Client, follow, getJson, randomChannelId, sendEventSub, sleep } from './lib.mjs';
import { FAKE_PORT, FAKE_USER, startFakeTwitch } from './fake-twitch.mjs';

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
    assert.deepEqual(types, ['channel.chat.message', 'channel.cheer', 'channel.follow', 'channel.raid',
      'channel.subscribe', 'channel.subscription.gift', 'channel.subscription.message', 'channel.update',
      'stream.offline', 'stream.online']);
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
    assert.deepEqual(me.channels, [{ key: ownKey, role: 'owner' }]);
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
    assert.equal(fake.state.subscriptions.length, 10, 'subscriptions are made again');
  });

  await check('a sign in without every permission is refused', async () => {
    fake.state.grant = ['bits:read'];
    try {
      const res = await signIn();
      assert.equal(res.headers.get('location'), '/?signin=scopes');
      assert.equal(cookieOf(res, 'sylva_session'), null);
    } finally {
      fake.state.grant = ['moderator:read:followers', 'channel:read:subscriptions', 'bits:read',
                          'user:read:chat', 'user:bot', 'channel:bot'];
    }
  });

  await check('signing out ends the session', async () => {
    assert.equal((await fetch(`${BASE}/auth/sign-out`, { method: 'POST', headers: asOwner() })).status, 403);
    const res = await fetch(`${BASE}/auth/sign-out`, { method: 'POST', headers: asOwner({ Origin: BASE }) });
    assert.equal(res.status, 200);
    assert.equal(cookieOf(res, 'sylva_session'), '');
    assert.equal((await fetch(`${BASE}/v1/me`, { headers: asOwner() })).status, 401);
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

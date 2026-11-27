// Shared helpers for the test scripts. They talk to a running Worker
// (local `npm run dev` by default) exactly as Twitch, OBS and Sylva Desktop would.
import { createHmac, randomUUID } from 'node:crypto';

export const BASE = process.env.SYLVA_URL || 'http://localhost:8787';
export const SECRET = process.env.TWITCH_EVENTSUB_SECRET || 'local-dev-secret-change-me';
export const ADMIN = process.env.SYLVA_ADMIN_TOKEN || 'local-dev-admin-token';

export const randomChannelId = () => String(Math.floor(1e9 + Math.random() * 9e9));

/** Sign and POST one EventSub message, the way Twitch does. */
export async function sendEventSub({ type = 'notification', subType, condition, event, challenge,
                                     messageId = randomUUID(), timestamp = new Date().toISOString(),
                                     secret = SECRET, status = 'enabled' }) {
  const body = JSON.stringify({
    subscription: { id: randomUUID(), type: subType, version: '1', status, cost: 0, condition,
                    transport: { method: 'conduit', conduit_id: 'local' },
                    created_at: new Date().toISOString() },
    ...(event ? { event } : {}),
    ...(challenge ? { challenge } : {}),
  });
  const signature = 'sha256=' + createHmac('sha256', secret).update(messageId + timestamp + body).digest('hex');
  return fetch(`${BASE}/twitch/eventsub`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Twitch-Eventsub-Message-Id': messageId,
      'Twitch-Eventsub-Message-Retry': '0',
      'Twitch-Eventsub-Message-Type': type,
      'Twitch-Eventsub-Message-Signature': signature,
      'Twitch-Eventsub-Message-Timestamp': timestamp,
      'Twitch-Eventsub-Subscription-Type': subType,
      'Twitch-Eventsub-Subscription-Version': '1',
    },
    body,
  });
}

/** A follow notification for a channel, with a numbered follower. */
export function follow(channelId, n, messageId) {
  return {
    subType: 'channel.follow',
    condition: { broadcaster_user_id: channelId, moderator_user_id: channelId },
    event: { user_id: String(100000 + n), user_login: `viewer${n}`, user_name: `Viewer${n}`,
             broadcaster_user_id: channelId, broadcaster_user_login: 'me', broadcaster_user_name: 'Me',
             followed_at: new Date().toISOString() },
    messageId,
  };
}

/** A chat message notification. Chat goes to the log and the feed, not the alert queue. */
export function chat(channelId, n) {
  return {
    subType: 'channel.chat.message',
    condition: { broadcaster_user_id: channelId, user_id: '1' },
    event: { broadcaster_user_id: channelId, chatter_user_id: String(200000 + n),
             chatter_user_login: `chatter${n}`, chatter_user_name: `Chatter${n}`,
             message_id: randomUUID(), message: { text: `hype ${n}`, fragments: [] } },
  };
}

/** A chat line with a chosen text, chatter and badges (set ids). */
export function chatLine(channelId, { text, id = '7001', name = 'Maple', badges = [] }) {
  return {
    subType: 'channel.chat.message',
    condition: { broadcaster_user_id: channelId, user_id: channelId },
    event: { broadcaster_user_id: channelId, chatter_user_id: id,
             chatter_user_login: name.toLowerCase(), chatter_user_name: name,
             message_id: randomUUID(), message: { text, fragments: [] },
             badges: badges.map((set_id) => ({ set_id, id: '1', info: '' })) },
  };
}

export async function admin(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** GET as the admin (channel reads need an owner or the admin token). */
export async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** A realtime client that records every frame and lets tests wait for one. */
export class Client {
  /**
   * Connects as the admin by default. Pass `{ token }` to connect with an
   * overlay link's token instead, or `{ headers }` for a session cookie.
   */
  constructor(key, role, lastSeq, { token, headers } = {}) {
    this.frames = [];
    this.waiters = [];
    const url = `${BASE.replace(/^http/, 'ws')}/v1/channels/${key}/ws`;
    this.ws = token
      ? new WebSocket(`${url}?token=${encodeURIComponent(token)}`)
      : new WebSocket(url, { headers: headers || { Authorization: `Bearer ${ADMIN}` } });
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ type: 'hello', role, ...(lastSeq !== undefined ? { lastSeq } : {}) }));
        resolve();
      };
      this.ws.onerror = (e) => reject(new Error(`socket error ${e.message || ''}`));
    });
    this.ws.onmessage = (m) => {
      const f = JSON.parse(m.data);
      this.frames.push(f);
      this.waiters = this.waiters.filter(({ pred, resolve }) => (pred(f) ? (resolve(f), false) : true));
    };
    this.closed = new Promise((resolve) => { this.ws.onclose = resolve; });
  }
  /** Resolve with the first frame (already seen or future) that matches. */
  next(pred, ms = 5000, seen = true) {
    if (seen) {
      const hit = this.frames.find(pred);
      if (hit) return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for frame (${pred})`)), ms);
      this.waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  }
  ready() { return this.next((f) => f.type === 'ready'); }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  ack(alertId) { this.send({ type: 'ack', alertId }); }
  async close() { this.ws.close(1000); await this.closed; }
  plays() { return this.frames.filter((f) => f.type === 'play'); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

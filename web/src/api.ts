// Types and calls for Sylva's API. Shapes match crates/sylva-core (event.rs,
// protocol.rs) and workers/edge (account.rs, twitch_api.rs).

export type Kind =
  | 'follow' | 'subscriber' | 'giftedSub' | 'communityGift' | 'cheer'
  | 'tip' | 'redemption' | 'raid' | 'chat' | 'other';

export interface Actor { id: string; login: string; displayName: string }

export interface SylvaEvent {
  seq: number;
  receivedAt: number;
  id: string;
  channel: string;
  platform: 'twitch' | 'sylva';
  kind: Kind;
  rawType: string;
  createdAt: string;
  actor?: Actor;
  amount?: number;
  currency?: string;
  message?: string;
  tier?: string;
  gifted: boolean;
  sender?: string;
  redemption?: string;
  raw: Record<string, unknown> | null;
}

export interface AlertState {
  paused: boolean;
  muted: boolean;
  playing: number | null;
  queued: number;
  overlaysConnected: number;
}

export interface Identity {
  platform: string;
  id: string;
  login: string;
  displayName: string;
  avatar: string;
  scopes: string[];
}

export interface Me {
  accountId: string;
  identities: Identity[];
  channels: { key: string; role: string }[];
}

export interface Summary { since: number; counts: Partial<Record<Kind, number>>; bits: number }

export interface KindSettings {
  kind: Kind;
  enabled: boolean;
  minAmount: number;
  durationMs: number;
  label: string;
  template: string;
  showMessage: boolean;
}
export interface AlertSettings { kinds: KindSettings[] }

export type GoalKind = 'follows' | 'subs' | 'bits';
export interface Goal { title: string; kind: GoalKind; target: number; since: number }
export interface WidgetSettings { goal?: Goal | null }

export interface AppToken { id: string; name: string; createdAt: number; lastUsedAt?: number | null }

export type Feature = 'follows' | 'subs' | 'cheers' | 'chat' | 'raids' | 'stream';
export interface FeatureStatus { feature: Feature; on: boolean; problems: string[] }

/** An error with the server's own words, ready for a toast. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sylva could not be reached. Check your connection.', 0);
  }
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text error */ }
  if (!res.ok) {
    const message = typeof data === 'string' && data ? data : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

const ch = (key: string) => `/v1/channels/${encodeURIComponent(key)}`;

export const api = {
  me: () => request<Me>('GET', '/v1/me'),
  signOut: () => request<unknown>('POST', '/auth/sign-out'),
  deleteAccount: (confirm: string) => request<{ deleted: boolean }>('POST', '/v1/account/delete', { confirm }),
  history: (key: string, filter: 'alerts' | 'chat', limit: number, before?: number, q?: string) => {
    const p = new URLSearchParams({ filter, limit: String(limit) });
    if (before) p.set('before', String(before));
    if (q) p.set('q', q);
    return request<{ headSeq: number; events: SylvaEvent[] }>('GET', `${ch(key)}/history?${p}`);
  },
  summary: (key: string, since: number) => request<Summary>('GET', `${ch(key)}/summary?since=${since}`),
  alert: (key: string, action: 'pause' | 'resume' | 'mute' | 'unmute' | 'skip') =>
    request<AlertState>('POST', `${ch(key)}/alerts/${action}`),
  replay: (key: string, seq: number) => request<AlertState>('POST', `${ch(key)}/alerts/replay/${seq}`),
  testEvent: (key: string, e: { kind: Kind; name: string; amount?: number; message?: string }) =>
    request<{ seq: number; duplicate: boolean; alert: boolean }>('POST', `${ch(key)}/test-event`, e),
  alertSettings: (key: string) => request<AlertSettings>('GET', `${ch(key)}/alert-settings`),
  saveAlertSettings: (key: string, s: AlertSettings) => request<AlertSettings>('POST', `${ch(key)}/alert-settings`, s),
  widgetSettings: (key: string) => request<WidgetSettings>('GET', `${ch(key)}/widget-settings`),
  saveWidgetSettings: (key: string, s: WidgetSettings) => request<WidgetSettings>('POST', `${ch(key)}/widget-settings`, s),
  deviceLookup: (code: string) =>
    request<{ userCode: string; appName: string }>('GET', `/v1/device?code=${encodeURIComponent(code)}`),
  deviceDecide: (userCode: string, approve: boolean) =>
    request<{ approved: boolean }>('POST', '/v1/device', { userCode, approve }),
  apps: () => request<AppToken[]>('GET', '/v1/apps'),
  revokeApp: (id: string) => request<unknown>('POST', `/v1/apps/${encodeURIComponent(id)}/revoke`),
  overlay: (key: string) => request<{ url: string }>('GET', `${ch(key)}/overlay`),
  rotateOverlay: (key: string) => request<{ url: string }>('POST', `${ch(key)}/overlay/rotate`),
  twitch: (key: string) => request<{ features: FeatureStatus[] }>('GET', `${ch(key)}/twitch`),
  twitchSubscribe: (key: string) => request<{ features: FeatureStatus[] }>('POST', `${ch(key)}/twitch/subscribe`),
  socketUrl: (key: string) =>
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${ch(key)}/ws`,
};

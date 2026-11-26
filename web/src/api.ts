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

export type Role = 'owner' | 'editor' | 'moderator' | 'viewer';

/** A channel the account can open: its own, or one it helps run. */
export interface ChannelRef { key: string; role: Role; name: string; login: string; avatar: string }

export interface Me {
  accountId: string;
  identities: Identity[];
  channels: ChannelRef[];
}

export interface TeamMember { id: string; login: string; name: string; avatar: string; role: Exclude<Role, 'owner'>; addedAt: number; joined: boolean }
export interface TeamView { team: TeamMember[]; max: number }

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

export type WidgetKind = 'alerts' | 'feed' | 'latest' | 'top' | 'goal' | 'chat';
export interface SceneItem {
  id: string; widget: WidgetKind; x: number; y: number; w: number; h: number;
  kind?: string | null; limit?: number | null;
}
export interface Scene { items: SceneItem[] }
export interface SceneState {
  draft: Scene;
  draftSavedAt: number;
  published?: { version: number; publishedAt: number; scene: Scene } | null;
  versions: { version: number; publishedAt: number; items: number }[];
}

export type UserLevel = 'everyone' | 'subscriber' | 'vip' | 'moderator' | 'broadcaster';
export interface BotCommand {
  name: string; aliases: string[]; reply: string; level: UserLevel;
  cooldown: number; userCooldown: number; enabled: boolean; count: number;
}
export interface BotTimer {
  id: string; name: string; message: string; interval: number; lines: number; liveOnly: boolean; enabled: boolean;
}
export interface BotCounter { name: string; label: string; value: number; enabled: boolean }
export interface QuoteSettings { enabled: boolean; addLevel: UserLevel }
export interface BuiltinSetting { name: string; enabled: boolean; level: UserLevel; cooldown: number }
export interface BotSettings {
  enabled: boolean; commands: BotCommand[]; timers: BotTimer[]; counters: BotCounter[]; quotes: QuoteSettings;
  builtins: BuiltinSetting[];
}
export type BuiltinGroup = 'info' | 'fun' | 'commands' | 'quotes' | 'stream' | 'moderation';
export interface Builtin {
  name: string; aliases: string[]; group: BuiltinGroup; about: string; usage: string;
  level: UserLevel; min: UserLevel; cooldown: number; on: boolean; needs: 'nothing' | 'commands' | 'moderation';
}
export type Permission = 'ok' | 'missing' | 'expired';
export interface Quote { id: number; text: string; by: string; game: string; at: number }
export interface TimerStatus { id: string; nextAt?: number; waiting?: 'off' | 'bot' | 'live' | 'chat'; linesNeeded?: number }
export interface BotView {
  settings: BotSettings;
  sender: { kind: 'sylva' | 'streamer'; id: string; login?: string };
  timers: TimerStatus[];
  live: boolean;
  builtins: Builtin[];
  permissions: { commands: Permission; moderation: Permission };
}
export type BotSkip = 'notACommand' | 'unknown' | 'off' | 'level' | 'cooldown';
export interface BotTry { reply?: string; skip?: BotSkip; command?: string }

export type ModPreset = 'off' | 'relaxed' | 'standard' | 'strict' | 'custom';
export interface ModShare { on: boolean; min: number; percent: number }
export interface ModLimit { on: boolean; max: number }
export interface ModRules {
  links: boolean; caps: ModShare; symbols: ModShare; emotes: ModLimit; length: ModLimit; repeats: ModLimit; zalgo: boolean;
}
export type ModRule = 'words' | 'links' | 'zalgo' | 'length' | 'repeats' | 'caps' | 'symbols' | 'emotes';
export interface ModSettings {
  preset: ModPreset; rules: ModRules; exempt: UserLevel; steps: [number, number, number];
  words: string[]; allowedLinks: string[]; notice: boolean;
}
export interface ModView {
  settings: ModSettings;
  permission: 'ok' | 'missing' | 'expired';
  presets: [ModPreset, { rules: ModRules; exempt: UserLevel; steps: [number, number, number] }][];
}
export interface ModEntry {
  id: number; at: number; userId: string; user: string; rule: ModRule; message: string;
  action: 'delete' | 'timeout'; seconds: number; result: 'done' | 'failed'; detail?: string; undoneAt?: number;
}
export interface ModTry { rule?: ModRule; skipped: boolean; steps: [number, number, number] }

export interface LoyaltySettings {
  enabled: boolean; name: string; watch: number; active: number; follow: number; sub: number;
  gift: number; cheer: number; give: boolean;
}
export interface LoyaltyView {
  settings: LoyaltySettings; permission: 'ok' | 'missing' | 'expired'; live: boolean; botOn: boolean;
  viewers: number; everyMinutes: number;
}
export interface ChatAlert { enabled: boolean; message: string }
export interface ChatAlertSettings {
  alerts: Record<string, ChatAlert>; raidMin: number; bitsMin: number; charityMin: number;
  watchStreakMin: number; adAutomatic: boolean;
}
export interface ChatAlertInfo { id: string; label: string; default: string; variables: string[] }
export interface ChatAlertGroup { id: string; title: string; desc: string; alerts: ChatAlertInfo[] }
export interface ChatAlertsView {
  settings: ChatAlertSettings; groups: ChatAlertGroup[]; needsGrant: string[];
  permission: 'ok' | 'missing' | 'expired'; sender: { kind: 'sylva' | 'streamer'; id: string; login?: string };
}
export interface PointsViewer { id: string; login: string; name: string; balance: number; earned: number }
export interface PointsEntry { id: number; delta: number; reason: string; at: number }

export interface StoreItem {
  id: string; name: string; description: string; cost: number; enabled: boolean;
  stock: number | null; cooldown: number; input: boolean;
}
export interface StoreSettings { enabled: boolean; items: StoreItem[] }
export interface StoreView {
  settings: StoreSettings; pointsOn: boolean; pointsName: string; botOn: boolean; login?: string; pending: number;
}
export interface Redemption {
  id: number; itemId: string; itemName: string; cost: number; userId: string; login: string; name: string;
  input: string; at: number; status: 'pending' | 'done' | 'refunded'; doneAt?: number;
}
export interface ImportResult { commands: number; timers: number; points: number; skipped: { what: string; why: string }[] }
export interface PublicCommand {
  name: string; aliases: string[]; text: string; usage: string; level: UserLevel; cooldown: number; builtin: boolean;
}
export interface PublicCommands {
  channel: string; login: string; commands: PublicCommand[]; counters: BotCounter[];
}
export interface PublicViewer { name: string; balance: number; rank: number }
export interface PublicStore {
  channel: string; pointsName: string; storeOn: boolean;
  items: { number: number; name: string; description: string; cost: number; stock?: number | null; cooldown: number; input: boolean }[];
  top: PublicViewer[]; viewer?: PublicViewer;
}

export interface GiveawaySettings { prize: string; keyword: string; level: UserLevel; cost: number; subLuck: number }
export interface Giveaway {
  id: number; settings: GiveawaySettings; status: 'open' | 'closed' | 'ended' | 'cancelled'; seedHash: string; seed?: string;
  openedAt: number; closedAt?: number; endedAt?: number;
  winners: { userId: string; name: string; round: number; at: number }[]; entries: number; tickets: number;
}
export interface GiveawaysView {
  current?: Giveaway; entries: { userId: string; name: string; tickets: number; at: number }[]; past: Giveaway[];
  pointsOn: boolean; pointsName: string; botOn: boolean;
}

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
  bot: (key: string) => request<BotView>('GET', `${ch(key)}/bot`),
  saveBot: (key: string, s: BotSettings) => request<BotView>('POST', `${ch(key)}/bot`, s),
  sendTimer: (key: string, id: string) => request<BotView>('POST', `${ch(key)}/bot/timers/${encodeURIComponent(id)}/send`),
  moderation: (key: string) => request<ModView>('GET', `${ch(key)}/moderation`),
  saveModeration: (key: string, s: ModSettings) => request<ModView>('POST', `${ch(key)}/moderation`, s),
  tryModeration: (key: string, message: string, level: UserLevel, settings?: ModSettings) =>
    request<ModTry>('POST', `${ch(key)}/moderation/try`, { message, level, settings }),
  modLog: (key: string, before?: number) =>
    request<{ entries: ModEntry[] }>('GET', `${ch(key)}/moderation/log${before ? `?before=${before}` : ''}`),
  undoModAction: (key: string, id: number) => request<ModEntry>('POST', `${ch(key)}/moderation/log/${id}/undo`),
  setCounter: (key: string, name: string, value: number) =>
    request<BotView>('POST', `${ch(key)}/bot/counters/${encodeURIComponent(name)}/set`, { value }),
  quotes: (key: string) => request<{ quotes: Quote[] }>('GET', `${ch(key)}/bot/quotes`),
  addQuote: (key: string, q: { text: string; by: string; game: string; id?: number; at?: number }) =>
    request<Quote>('POST', `${ch(key)}/bot/quotes`, q),
  editQuote: (key: string, id: number, q: { text: string; by: string; game: string }) =>
    request<Quote>('POST', `${ch(key)}/bot/quotes/${id}`, q),
  deleteQuote: (key: string, id: number) => request<Quote>('POST', `${ch(key)}/bot/quotes/${id}/delete`),
  tryBot: (key: string, message: string, level: UserLevel, extra: { settings?: BotSettings; user?: string; channel?: string } = {}) =>
    request<BotTry>('POST', `${ch(key)}/bot/try`, { message, level, ...extra }),
  chatAlerts: (key: string) => request<ChatAlertsView>('GET', `${ch(key)}/chat-alerts`),
  saveChatAlerts: (key: string, s: ChatAlertSettings) => request<ChatAlertsView>('POST', `${ch(key)}/chat-alerts`, s),
  loyalty: (key: string) => request<LoyaltyView>('GET', `${ch(key)}/loyalty`),
  saveLoyalty: (key: string, s: LoyaltySettings) => request<LoyaltyView>('POST', `${ch(key)}/loyalty`, s),
  pointsViewers: (key: string, q: string, offset: number, limit = 50) => {
    const p = new URLSearchParams({ q, offset: String(offset), limit: String(limit) });
    return request<{ viewers: PointsViewer[]; total: number }>('GET', `${ch(key)}/loyalty/viewers?${p}`);
  },
  adjustPoints: (key: string, id: string, delta: number, reason: string) =>
    request<PointsViewer>('POST', `${ch(key)}/loyalty/viewers/${encodeURIComponent(id)}/adjust`, { delta, reason }),
  pointsLedger: (key: string, id: string) =>
    request<{ entries: PointsEntry[] }>('GET', `${ch(key)}/loyalty/viewers/${encodeURIComponent(id)}/ledger`),
  store: (key: string) => request<StoreView>('GET', `${ch(key)}/loyalty/store`),
  saveStore: (key: string, s: StoreSettings) => request<StoreView>('POST', `${ch(key)}/loyalty/store`, s),
  redemptions: (key: string, status: 'pending' | 'done', before?: number) =>
    request<{ redemptions: Redemption[] }>('GET', `${ch(key)}/loyalty/redemptions?status=${status}&limit=${status === 'pending' ? 200 : 50}${before ? `&before=${before}` : ''}`),
  settle: (key: string, id: number, action: 'done' | 'reopen' | 'refund') =>
    request<Redemption>('POST', `${ch(key)}/loyalty/redemptions/${id}/${action}`),
  importStreamElements: (key: string, body: { token: string; commands: boolean; timers: boolean; points: boolean }) =>
    request<ImportResult>('POST', `${ch(key)}/import/streamelements`, body),
  publicCommands: (login: string) => request<PublicCommands>('GET', `/v1/public/${encodeURIComponent(login)}/commands`),
  publicStore: (login: string, viewer?: string) =>
    request<PublicStore>('GET', `/v1/public/${encodeURIComponent(login)}${viewer ? `?viewer=${encodeURIComponent(viewer)}` : ''}`),
  giveaways: (key: string) => request<GiveawaysView>('GET', `${ch(key)}/giveaways`),
  startGiveaway: (key: string, s: GiveawaySettings) => request<GiveawaysView>('POST', `${ch(key)}/giveaways`, s),
  giveawayAction: (key: string, id: number, action: 'close' | 'draw' | 'end' | 'cancel') =>
    request<GiveawaysView>('POST', `${ch(key)}/giveaways/${id}/${action}`),
  team: (key: string) => request<TeamView>('GET', `${ch(key)}/team`),
  setTeammate: (key: string, login: string, role: TeamMember['role']) => request<TeamView>('POST', `${ch(key)}/team`, { login, role }),
  removeTeammate: (key: string, id: string) => request<TeamView>('POST', `${ch(key)}/team/${encodeURIComponent(id)}/remove`),
  scene: (key: string) => request<SceneState>('GET', `${ch(key)}/scene`),
  saveScene: (key: string, scene: Scene) => request<SceneState>('POST', `${ch(key)}/scene`, scene),
  publishScene: (key: string) => request<SceneState>('POST', `${ch(key)}/scene/publish`),
  restoreScene: (key: string, version: number) => request<SceneState>('POST', `${ch(key)}/scene/restore/${version}`),
  overlay: (key: string) => request<{ url: string }>('GET', `${ch(key)}/overlay`),
  rotateOverlay: (key: string) => request<{ url: string }>('POST', `${ch(key)}/overlay/rotate`),
  twitch: (key: string) => request<{ features: FeatureStatus[] }>('GET', `${ch(key)}/twitch`),
  twitchSubscribe: (key: string) => request<{ features: FeatureStatus[] }>('POST', `${ch(key)}/twitch/subscribe`),
  socketUrl: (key: string) =>
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${ch(key)}/ws`,
};

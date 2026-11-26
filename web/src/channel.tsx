// The open channel, shared by every dashboard page: one live socket, the
// recent activity and chat it fills, the 24 hour numbers, and the alert
// queue's state. Pages read it with useChannel().
//
// An account can open its own channel and any it helps run. The choice is
// remembered in this browser, and switching remounts everything below.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type AlertState, type ChannelRef, type Identity, type Me, type Role, type Summary, type SylvaEvent } from './api';
import { connect } from './realtime';
import { errorText, useToast } from './ui';

export const PAGE = 100;
const CHAT_MAX = 300;
const DAY = 86_400_000;

/** What the signed in person may do on the open channel. The server checks
 * the same rules (sylva_core::team::allows); this only hides what would fail. */
export interface Can {
  /** Change settings: alerts, overlays, the bot, rules, rewards. */
  edit: boolean;
  /** Run the live parts: the alert queue, points, the store queue, giveaways. */
  moderate: boolean;
  /** Manage the team and the overlay link. */
  own: boolean;
}

export function permissions(role: Role): Can {
  return { own: role === 'owner', edit: role === 'owner' || role === 'editor', moderate: role !== 'viewer' };
}

export const ROLE_NAMES: Record<Role, string> = { owner: 'Owner', editor: 'Editor', moderator: 'Moderator', viewer: 'Viewer' };

export interface Channel {
  key: string;
  me: Me;
  /** The signed in person's own Twitch identity. */
  twitch?: Identity;
  /** The signed in person's own name. */
  you: string;
  /** The open channel's name, Twitch login and picture. */
  name: string;
  login: string;
  avatar: string;
  role: Role;
  can: Can;
  /** Every channel this account can open. */
  channels: ChannelRef[];
  switchTo(key: string): void;
  events: SylvaEvent[];
  chat: SylvaEvent[];
  summary: Summary | null;
  alerts: AlertState | null;
  setAlerts(s: AlertState): void;
  connected: boolean;
  loaded: boolean;
  /** Events with a seq above this arrived live, so they animate in. */
  freshFrom: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): Promise<void>;
  replay(e: SylvaEvent): Promise<void>;
  signOut(): Promise<void>;
}

const Ctx = createContext<Channel | null>(null);

/** How long a test event stays in activity lists. Matches TEST_EVENT_TTL_MS on the server. */
const TEST_TTL = 30_000;

export function useChannel(): Channel {
  const c = useContext(Ctx);
  if (!c) throw new Error('useChannel outside ChannelProvider');
  return c;
}

const CHOICE = 'sylva.channel';

function remembered(me: Me): ChannelRef {
  let key: string | null = null;
  try { key = localStorage.getItem(CHOICE); } catch { /* private mode */ }
  return me.channels.find((c) => c.key === key) ?? me.channels[0];
}

export function ChannelProvider({ me, onSignedOut, children }: { me: Me; onSignedOut(): void; children: ReactNode }) {
  const [current, setCurrent] = useState(() => remembered(me).key);
  const open = me.channels.find((c) => c.key === current) ?? me.channels[0];
  const switchTo = useCallback((key: string) => {
    try { localStorage.setItem(CHOICE, key); } catch { /* private mode */ }
    setCurrent(key);
  }, []);
  return <OpenChannel key={open.key} me={me} open={open} switchTo={switchTo} onSignedOut={onSignedOut}>{children}</OpenChannel>;
}

function OpenChannel({ me, open, switchTo, onSignedOut, children }: {
  me: Me; open: ChannelRef; switchTo(key: string): void; onSignedOut(): void; children: ReactNode;
}) {
  const key = open.key;
  const twitch = me.identities.find((i) => i.platform === 'twitch');
  const you = twitch?.displayName || twitch?.login || 'Streamer';
  const name = open.name || open.login || you;
  const login = open.login || twitch?.login || '';
  const avatar = open.avatar;
  const role = open.role;
  const can = useMemo(() => permissions(role), [role]);
  const toast = useToast();

  const [events, setEvents] = useState<SylvaEvent[]>([]);
  const [chat, setChat] = useState<SylvaEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<AlertState | null>(null);
  const [connected, setConnected] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [freshFrom, setFreshFrom] = useState(Number.MAX_SAFE_INTEGER);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const arrived = useRef(new Map<number, number>());
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    (async () => {
      try {
        const [feed, lines, sum] = await Promise.all([
          api.history(key, 'alerts', PAGE),
          api.history(key, 'chat', 100),
          api.summary(key, Date.now() - DAY),
        ]);
        if (cancelled) return;
        setEvents(feed.events);
        setHasMore(feed.events.length === PAGE);
        setChat(lines.events.slice().reverse());
        setSummary(sum);
        setLoaded(true);
        const head = Math.max(feed.headSeq, lines.headSeq);
        setFreshFrom(head);
        stop = connect(key, head, {
          event(e) {
            if (e.kind === 'chat') {
              setChat((c) => (c.some((x) => x.seq === e.seq) ? c : [...c, e].slice(-CHAT_MAX)));
            } else {
              if (e.platform === 'sylva') arrived.current.set(e.seq, Date.now());
              setEvents((list) => (list.some((x) => x.seq === e.seq) ? list : [e, ...list]));
            }
            setSummary((s) => s && {
              ...s,
              counts: { ...s.counts, [e.kind]: (s.counts[e.kind] || 0) + 1 },
              bits: s.bits + (e.kind === 'cheer' ? e.amount || 0 : 0),
            });
          },
          state: setAlerts,
          connected: setConnected,
        });
      } catch (x) {
        if (!cancelled) {
          setLoaded(true);
          toast('Could not load your channel: ' + errorText(x), true);
        }
      }
    })();
    // The 24 hour window moves, so recount now and then.
    const t = setInterval(() => {
      api.summary(key, Date.now() - DAY).then(setSummary).catch(() => {});
    }, 60000);
    return () => {
      cancelled = true;
      stop();
      clearInterval(t);
    };
  }, [key, toast]);

  // Test events leave the lists 30 seconds after they came in, the same
  // moment the server stops listing them, so every list agrees.
  useEffect(() => {
    const tests = events.filter((e) => e.platform === 'sylva');
    if (!tests.length) return;
    // Live ones count from when they arrived here, so a clock that is off
    // does not hide them early; loaded ones from the server's time.
    const left = (e: SylvaEvent) => {
      const from = arrived.current.get(e.seq) ?? e.receivedAt;
      return Math.min(TEST_TTL, Math.max(0, from + TEST_TTL - Date.now()));
    };
    const t = setTimeout(() => {
      setEvents((list) => list.filter((e) => e.platform !== 'sylva' || left(e) > 0));
    }, Math.min(...tests.map(left)) + 50);
    return () => clearTimeout(t);
  }, [events]);

  const loadMore = useCallback(async () => {
    const list = eventsRef.current;
    const oldest = list[list.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const page = await api.history(key, 'alerts', PAGE, oldest.seq);
      setEvents((l) => [...l, ...page.events.filter((e) => !l.some((x) => x.seq === e.seq))]);
      setHasMore(page.events.length === PAGE);
    } catch (x) {
      toast('Could not load older activity: ' + errorText(x), true);
    } finally {
      setLoadingMore(false);
    }
  }, [key, toast]);

  const replay = useCallback(async (e: SylvaEvent) => {
    try {
      setAlerts(await api.replay(key, e.seq));
      toast('Alert replays next');
    } catch (x) {
      toast(errorText(x), true);
    }
  }, [key, toast]);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } catch {
      // Signed out either way: the session is gone or will expire.
    }
    onSignedOut();
  }, [onSignedOut]);

  const value = useMemo<Channel>(() => ({
    key, me, twitch, you, name, login, avatar, role, can, channels: me.channels, switchTo,
    events, chat, summary, alerts, setAlerts, connected, loaded,
    freshFrom, hasMore, loadingMore, loadMore, replay, signOut,
  }), [key, me, twitch, you, name, login, avatar, role, can, switchTo, events, chat, summary, alerts, connected, loaded, freshFrom, hasMore, loadingMore, loadMore, replay, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

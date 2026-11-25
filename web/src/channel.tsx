// The signed in channel, shared by every dashboard page: one live socket, the
// recent activity and chat it fills, the 24 hour numbers, and the alert
// queue's state. Pages read it with useChannel().

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type AlertState, type Identity, type Me, type Summary, type SylvaEvent } from './api';
import { connect } from './realtime';
import { errorText, useToast } from './ui';

export const PAGE = 100;
const CHAT_MAX = 300;
const DAY = 86_400_000;

export interface Channel {
  key: string;
  me: Me;
  twitch?: Identity;
  name: string;
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

export function useChannel(): Channel {
  const c = useContext(Ctx);
  if (!c) throw new Error('useChannel outside ChannelProvider');
  return c;
}

export function ChannelProvider({ me, onSignedOut, children }: { me: Me; onSignedOut(): void; children: ReactNode }) {
  const key = me.channels[0].key;
  const twitch = me.identities.find((i) => i.platform === 'twitch');
  const name = twitch?.displayName || twitch?.login || 'Streamer';
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
    key, me, twitch, name, events, chat, summary, alerts, setAlerts, connected, loaded,
    freshFrom, hasMore, loadingMore, loadMore, replay, signOut,
  }), [key, me, twitch, name, events, chat, summary, alerts, connected, loaded, freshFrom, hasMore, loadingMore, loadMore, replay, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

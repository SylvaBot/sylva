// The signed in dashboard: Cortex's one column layout with the channel's
// numbers, alert controls, the overlay link, the activity feed, chat, and
// which Twitch events are on.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type AlertState, type FeatureStatus, type Me, type Summary, type SylvaEvent } from './api';
import { Feed } from './feed';
import { connect } from './realtime';
import { Avatar, errorText, Icon, num, useToast } from './ui';

const PAGE = 100;
const CHAT_MAX = 200;
const DAY = 86_400_000;

export function Dashboard({ me, onSignedOut }: { me: Me; onSignedOut(): void }) {
  const key = me.channels[0].key;
  const twitch = me.identities.find((i) => i.platform === 'twitch');
  const name = twitch?.displayName || twitch?.login || 'Streamer';
  const toast = useToast();

  const [events, setEvents] = useState<SylvaEvent[]>([]);
  const [chat, setChat] = useState<SylvaEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<AlertState | null>(null);
  const [connected, setConnected] = useState(true);
  const [freshFrom, setFreshFrom] = useState(Number.MAX_SAFE_INTEGER);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadSummary = useCallback(() => {
    api.summary(key, Date.now() - DAY).then(setSummary).catch(() => {});
  }, [key]);

  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    (async () => {
      try {
        const [feed, lines, sum] = await Promise.all([
          api.history(key, 'alerts', PAGE),
          api.history(key, 'chat', 50),
          api.summary(key, Date.now() - DAY),
        ]);
        if (cancelled) return;
        setEvents(feed.events);
        setHasMore(feed.events.length === PAGE);
        setChat(lines.events.slice().reverse());
        setSummary(sum);
        const head = Math.max(feed.headSeq, lines.headSeq);
        setFreshFrom(head);
        stop = connect(key, head, {
          event(e) {
            if (e.kind === 'chat') {
              setChat((c) => [...c, e].slice(-CHAT_MAX));
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
        toast('Could not load your channel: ' + errorText(x), true);
      }
    })();
    // The 24 hour window moves, so recount now and then.
    const t = setInterval(loadSummary, 60000);
    return () => {
      cancelled = true;
      stop();
      clearInterval(t);
    };
  }, [key, loadSummary, toast]);

  const loadMore = async () => {
    const oldest = events[events.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const page = await api.history(key, 'alerts', PAGE, oldest.seq);
      setEvents((list) => [...list, ...page.events]);
      setHasMore(page.events.length === PAGE);
    } catch (x) {
      toast('Could not load older activity: ' + errorText(x), true);
    } finally {
      setLoadingMore(false);
    }
  };

  const replay = async (e: SylvaEvent) => {
    try {
      setAlerts(await api.replay(key, e.seq));
      toast('Alert replays next');
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const signOut = async () => {
    try {
      await api.signOut();
    } finally {
      onSignedOut();
    }
  };

  const c = summary?.counts || {};
  const subs = (c.subscriber || 0) + (c.giftedSub || 0);

  return (
    <div className="app">
      <div className="main">
        <Header name={name} avatar={twitch?.avatar} login={twitch?.login} onSignOut={signOut} />
        {!connected && <div className="offline">Reconnecting to live events. Nothing is lost while this shows.</div>}
        <div className="content">
          <section className="hero" aria-label="Channel numbers">
            <div className="hero-top">
              <div className="hero-label">New followers</div>
              <div className="hero-num">{summary ? num(c.follow || 0) : '-'}</div>
              <p className="hero-note">In the last 24 hours</p>
            </div>
            <div className="hero-strip">
              <Cell label="Subs" value={summary ? subs : null} />
              <Cell label="Bits" value={summary ? summary.bits : null} />
              <Cell label="Raids" value={summary ? c.raid || 0 : null} />
              <Cell label="Chat messages" value={summary ? c.chat || 0 : null} />
            </div>
          </section>

          <Alerts channel={key} state={alerts} onState={setAlerts} />
          <OverlayLink channel={key} />
          <Feed
            events={events}
            freshFrom={freshFrom}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onMore={loadMore}
            onReplay={replay}
          />
          <Chat lines={chat} freshFrom={freshFrom} />
          <TwitchEvents channel={key} />
        </div>
      </div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="cell">
      <span className="cell-label">{label}</span>
      <b className="cell-num">{num(value)}</b>
    </div>
  );
}

function Header(props: { name: string; avatar?: string; login?: string; onSignOut(): void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <header className="header">
      <div className="brand">
        <img src="/logo.svg" alt="" width="28" height="28" />
        <span className="brand-name">Sylva</span>
        <span className="brand-sub">{props.name}</span>
      </div>
      <div className="header-right">
        <div className="menu-wrap">
          <button
            className="account"
            type="button"
            title="Account"
            aria-haspopup="true"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
          >
            <Avatar name={props.name} url={props.avatar} />
          </button>
          {open && (
            <div className="menu" onClick={(e) => e.stopPropagation()}>
              <div className="menu-row"><span>Twitch</span><b>{props.login || '-'}</b></div>
              <div className="menu-sep" />
              <button className="menu-item danger" type="button" onClick={props.onSignOut}>
                <Icon id="logout" />Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

const TEST_EVENTS = [
  { kind: 'follow', name: 'Maple' },
  { kind: 'subscriber', name: 'Juniper', amount: 6 },
  { kind: 'cheer', name: 'Rowan', amount: 500, message: 'Testing, testing' },
  { kind: 'raid', name: 'Hazel', amount: 42 },
  { kind: 'communityGift', name: 'Aspen', amount: 5 },
] as const;

function Alerts(props: { channel: string; state: AlertState | null; onState(s: AlertState): void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const s = props.state;

  const run = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'paused' in r) props.onState(r as AlertState);
      if (ok) toast(ok);
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(null);
    }
  };

  let note = '';
  if (s) {
    if (s.overlaysConnected === 0) {
      note = s.queued ? `No overlay connected. ${num(s.queued)} waiting until one is.` : 'No overlay connected';
    } else {
      const parts = [s.playing !== null ? 'Playing an alert' : 'Nothing playing'];
      if (s.queued) parts.push(`${num(s.queued)} waiting`);
      parts.push(s.overlaysConnected === 1 ? '1 overlay connected' : `${num(s.overlaysConnected)} overlays connected`);
      note = parts.join(' · ');
    }
  }

  return (
    <section className="panel" aria-labelledby="qa-title">
      <div className="panel-head">
        <h2 className="panel-title" id="qa-title">Alerts</h2>
        <p className="panel-note" aria-live="polite">{note}</p>
      </div>
      <div className="qa-grid">
        <button
          className="qa-btn"
          type="button"
          aria-pressed={!!s?.muted}
          disabled={!s || busy === 'mute'}
          onClick={() => run('mute', () => api.alert(props.channel, s?.muted ? 'unmute' : 'mute'),
            s?.muted ? 'Alerts unmuted' : 'Alerts muted')}
        >
          <Icon id={s?.muted ? 'volx' : 'vol'} /><span>{s?.muted ? 'Unmute alerts' : 'Mute alerts'}</span>
        </button>
        <button
          className="qa-btn"
          type="button"
          aria-pressed={!!s?.paused}
          disabled={!s || busy === 'pause'}
          onClick={() => run('pause', () => api.alert(props.channel, s?.paused ? 'resume' : 'pause'),
            s?.paused ? 'Alerts resumed' : 'Alerts paused')}
        >
          <Icon id={s?.paused ? 'play' : 'pause'} /><span>{s?.paused ? 'Resume alerts' : 'Pause alerts'}</span>
        </button>
        <button
          className="qa-btn"
          type="button"
          disabled={!s || s.playing === null || busy === 'skip'}
          onClick={() => run('skip', () => api.alert(props.channel, 'skip'), 'Skipped the alert on screen')}
        >
          <Icon id="skip" /><span>Skip alert</span>
        </button>
        <button
          className="qa-btn"
          type="button"
          disabled={busy === 'test'}
          onClick={() => {
            const t = TEST_EVENTS[Math.floor(Math.random() * TEST_EVENTS.length)];
            run('test', () => api.testEvent(props.channel, t), 'Test alert sent');
          }}
        >
          <Icon id="zap" /><span>Test alert</span>
        </button>
      </div>
    </section>
  );
}

function OverlayLink({ channel }: { channel: string }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api.overlay(channel).then((r) => setUrl(r.url)).catch((x) => toast('Could not load the overlay link: ' + errorText(x), true));
  }, [channel, toast]);
  useEffect(() => () => clearTimeout(disarm.current), []);

  const masked = url ? url.replace(/token=.*/, 'token=' + '•'.repeat(12)) : 'Loading';

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast('Overlay link copied');
    } catch {
      toast('Your browser blocked copying. Open the overlay and copy its address instead.', true);
    }
  };

  const replace = async () => {
    if (!armed) {
      setArmed(true);
      clearTimeout(disarm.current);
      disarm.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    try {
      setUrl((await api.rotateOverlay(channel)).url);
      toast('New link made. The old one stopped working, so paste this one into OBS.');
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  return (
    <section className="panel" aria-labelledby="overlay-title">
      <h2 className="panel-title" id="overlay-title">Alert overlay</h2>
      <p className="panel-text">
        Add this link to OBS as a Browser Source, 1920 by 1080. Anyone with the link can show your alerts, so keep it private.
      </p>
      <div className="link-row">
        <div className="link-field" title="The link is hidden. Copy it to see it."><span>{masked}</span></div>
        <button className="btn primary" type="button" disabled={!url} onClick={copy}><Icon id="copy" />Copy link</button>
        <a
          className="btn"
          href={url ? url + '&debug' : undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!url}
        >
          <Icon id="external" />Open
        </a>
        <button className={'btn' + (armed ? ' armed' : '')} type="button" disabled={!url} onClick={replace}>
          <Icon id="refresh" />{armed ? 'Click again to replace' : 'New link'}
        </button>
      </div>
    </section>
  );
}

function Chat({ lines, freshFrom }: { lines: SylvaEvent[]; freshFrom: number }) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <section className="panel chat-card" aria-labelledby="chat-title">
      <div className="panel-head">
        <h2 className="panel-title" id="chat-title">Chat</h2>
        <p className="panel-note">Read only</p>
      </div>
      <ol
        className="chat"
        ref={list}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          // Follow new lines only while scrolled to the bottom.
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.length === 0 && <li className="chat-empty">No chat yet. Messages show up here as they are sent.</li>}
        {lines.map((l) => (
          <li key={l.seq} className={l.seq > freshFrom ? 'fresh' : undefined}>
            <b>{l.actor?.displayName || 'Someone'}</b>{l.message}
          </li>
        ))}
      </ol>
    </section>
  );
}

const FEATURE_LABELS: Record<string, string> = {
  follows: 'Follows', subs: 'Subs', cheers: 'Cheers', chat: 'Chat', raids: 'Raids', stream: 'Going live',
};

function TwitchEvents({ channel }: { channel: string }) {
  const toast = useToast();
  const [features, setFeatures] = useState<FeatureStatus[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  useEffect(() => {
    api.twitch(channel).then((r) => setFeatures(r.features)).catch(() => setFailed(true));
  }, [channel]);

  const turnOn = async () => {
    setBusy(true);
    try {
      const r = await api.twitchSubscribe(channel);
      setFeatures(r.features);
      setFailed(false);
      toast('Twitch events are on');
    } catch (x) {
      if (x instanceof ApiError && x.status === 409 && (x.body as { needsSignIn?: boolean })?.needsSignIn) {
        setNeedsSignIn(true);
      } else {
        toast(errorText(x), true);
      }
    } finally {
      setBusy(false);
    }
  };

  const off = features?.filter((f) => !f.on) || [];
  return (
    <section className="panel" aria-labelledby="twitch-title">
      <div className="panel-head">
        <h2 className="panel-title" id="twitch-title">Twitch events</h2>
        <p className="panel-note">{features ? (off.length ? `${off.length} off` : 'All on') : ''}</p>
      </div>
      {failed && !features && <p className="panel-text">Could not check with Twitch right now. Events still arrive.</p>}
      {features && (
        <div className="status-grid">
          {features.map((f) => (
            <div key={f.feature} className={'status ' + (f.on ? 'on' : 'off')} title={f.problems.join('\n')}>
              <span className="dot" />{FEATURE_LABELS[f.feature] || f.feature}<span className="state">{f.on ? 'On' : 'Off'}</span>
            </div>
          ))}
        </div>
      )}
      {(off.length > 0 || failed) && (
        <div className="status-actions">
          <p>
            {needsSignIn
              ? 'Twitch says Sylva no longer has permission. Sign in again to turn these back on.'
              : 'Some events are not reaching Sylva.'}
          </p>
          {needsSignIn
            ? <a className="btn primary" href="/auth/twitch/start"><Icon id="twitch" />Sign in again</a>
            : <button className="btn" type="button" disabled={busy} onClick={turnOn}>{busy ? 'Turning on' : 'Turn on again'}</button>}
        </div>
      )}
    </section>
  );
}

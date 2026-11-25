// The dashboard's pages. Each reads the live channel from useChannel().

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type AlertState, type FeatureStatus, type Kind, type SylvaEvent } from './api';
import { PAGE, useChannel } from './channel';
import { FeedList, Filters, lastDay, matchesShown, MixBar, useShown, useTick } from './feed';
import { Link } from './router';
import { getTheme, setTheme, type Theme } from './theme';
import { ago, Avatar, errorText, Icon, num, useToast } from './ui';

function PageHead({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

function Card({ title, desc, action, children, className, id }: {
  title?: string; desc?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  const hid = id ? id + '-title' : undefined;
  return (
    <section className={'card' + (className ? ' ' + className : '')} aria-labelledby={hid}>
      {title && (
        <div className="card-head">
          <div>
            <h2 id={hid}>{title}</h2>
            {desc && <p>{desc}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function read(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function remember(key: string) {
  try { localStorage.setItem(key, '1'); } catch { /* private window */ }
}

/* ---------------------------------------------------------------- Overview */

export function OverviewPage() {
  const ch = useChannel();
  useTick();
  const c = ch.summary?.counts || {};
  const s = ch.summary;
  const { counts, total } = lastDay(ch.events);
  const first = ch.name.split(/\s+/)[0];

  return (
    <div className="page">
      <PageHead title={`Welcome back, ${first}`} desc="Here is your channel over the last 24 hours." />
      <div className="stats" role="group" aria-label="Last 24 hours">
        <Stat c="c-follow" label="New followers" value={s ? c.follow || 0 : null} />
        <Stat c="c-sub" label="Subs" value={s ? (c.subscriber || 0) + (c.giftedSub || 0) : null} />
        <Stat c="c-bits" label="Bits" value={s ? s.bits : null} />
        <Stat c="c-raid" label="Raids" value={s ? c.raid || 0 : null} />
      </div>
      <GetStarted />
      <div className="grid-main">
        <Card
          id="recent"
          title="Recent activity"
          desc={total === 1 ? '1 event in the last 24 hours' : `${num(total)} events in the last 24 hours`}
          action={<Link className="btn sm" href="/app/activity">View all<Icon id="chevron" /></Link>}
        >
          <MixBar counts={counts} total={total} />
          <FeedList
            events={ch.events.slice(0, 8)}
            freshFrom={ch.freshFrom}
            onReplay={ch.replay}
            empty={ch.loaded ? 'No activity yet. Follows, subs, cheers and raids appear here the moment they happen.' : 'Loading activity'}
          />
        </Card>
        <div className="stack">
          <Card id="alerts" title="Alerts" action={<Link className="btn sm ghost" href="/app/alerts">Manage</Link>}>
            <div className="card-body"><AlertControls /></div>
          </Card>
          <Card
            id="chat-preview"
            title="Chat"
            desc={s ? `${num(c.chat || 0)} messages in the last 24 hours` : undefined}
            action={<Link className="btn sm ghost" href="/app/chat">Open</Link>}
          >
            <ChatList lines={ch.chat.slice(-30)} freshFrom={ch.freshFrom} size="short" />
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ c, label, value }: { c: string; label: string; value: number | null }) {
  return (
    <div className={'card stat ' + c}>
      <div className="stat-label"><span className="bar" />{label}</div>
      <div className="stat-num">{num(value)}</div>
      <div className="stat-note">Last 24 hours</div>
    </div>
  );
}

function GetStarted() {
  const ch = useChannel();
  const [hidden, setHidden] = useState(() => read('sylva.setupHidden'));
  const overlayDone = (ch.alerts?.overlaysConnected ?? 0) > 0 || read('sylva.overlayCopied');
  const testDone = ch.events.some((e) => e.platform === 'sylva');
  if (hidden || !ch.loaded || (overlayDone && testDone)) return null;
  return (
    <section className="card setup" aria-labelledby="setup-title">
      <div className="setup-head">
        <div>
          <h2 id="setup-title">Get set up</h2>
          <p>Two more steps and your alerts are on stream.</p>
        </div>
        <button className="icon-btn" type="button" aria-label="Hide setup" title="Hide" onClick={() => { remember('sylva.setupHidden'); setHidden(true); }}>
          <Icon id="x" />
        </button>
      </div>
      <ol>
        <li className="done">
          <span className="check"><Icon id="tick" /></span>
          <div><b>Sign in with Twitch</b><span>Your events reach Sylva live.</span></div>
        </li>
        <li className={overlayDone ? 'done' : undefined}>
          <span className="check">{overlayDone ? <Icon id="tick" /> : 2}</span>
          <div>
            <b>Add your overlay to OBS</b>
            <span>One Browser Source shows every alert.</span>
            {!overlayDone && <Link className="btn sm" href="/app/overlay">Get the link</Link>}
          </div>
        </li>
        <li className={testDone ? 'done' : undefined}>
          <span className="check">{testDone ? <Icon id="tick" /> : 3}</span>
          <div>
            <b>Send a test alert</b>
            <span>See it play on your overlay.</span>
            {!testDone && <Link className="btn sm" href="/app/alerts">Try one</Link>}
          </div>
        </li>
      </ol>
    </section>
  );
}

/* ---------------------------------------------------------------- Alerts */

function stateNote(s: AlertState | null): string {
  if (!s) return 'Connecting';
  if (s.overlaysConnected === 0) {
    return s.queued ? `No overlay connected. ${num(s.queued)} waiting until one is.` : 'No overlay connected';
  }
  const parts = [s.playing !== null ? 'Playing an alert' : 'Nothing playing'];
  if (s.queued) parts.push(`${num(s.queued)} waiting`);
  parts.push(s.overlaysConnected === 1 ? '1 overlay connected' : `${num(s.overlaysConnected)} overlays connected`);
  return parts.join(' · ');
}

function AlertControls({ wide }: { wide?: boolean }) {
  const ch = useChannel();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const s = ch.alerts;

  const run = async (id: string, fn: () => Promise<AlertState>, ok: string) => {
    setBusy(id);
    try {
      ch.setAlerts(await fn());
      toast(ok);
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="state-line" aria-live="polite">{stateNote(s)}</p>
      <div className={'qa-grid' + (wide ? ' four' : '')}>
        <button
          className="qa-btn"
          type="button"
          aria-pressed={!!s?.muted}
          disabled={!s || busy === 'mute'}
          onClick={() => run('mute', () => api.alert(ch.key, s?.muted ? 'unmute' : 'mute'), s?.muted ? 'Alerts unmuted' : 'Alerts muted')}
        >
          <Icon id={s?.muted ? 'volx' : 'vol'} /><span>{s?.muted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button
          className="qa-btn"
          type="button"
          aria-pressed={!!s?.paused}
          disabled={!s || busy === 'pause'}
          onClick={() => run('pause', () => api.alert(ch.key, s?.paused ? 'resume' : 'pause'), s?.paused ? 'Alerts resumed' : 'Alerts paused')}
        >
          <Icon id={s?.paused ? 'play' : 'pause'} /><span>{s?.paused ? 'Resume' : 'Pause'}</span>
        </button>
        <button
          className="qa-btn"
          type="button"
          disabled={!s || s.playing === null || busy === 'skip'}
          onClick={() => run('skip', () => api.alert(ch.key, 'skip'), 'Skipped the alert on screen')}
        >
          <Icon id="skip" /><span>Skip</span>
        </button>
        <TestButton />
      </div>
    </>
  );
}

const TESTS: { kind: Kind; label: string; c: string; icon: string; name: string; amount?: number; message?: string }[] = [
  { kind: 'follow', label: 'Follow', c: 'c-follow', icon: 'heart', name: 'Maple' },
  { kind: 'subscriber', label: 'Sub', c: 'c-sub', icon: 'star', name: 'Juniper', amount: 6 },
  { kind: 'communityGift', label: 'Gifted subs', c: 'c-gift', icon: 'gift', name: 'Aspen', amount: 5 },
  { kind: 'cheer', label: 'Cheer', c: 'c-bits', icon: 'gem', name: 'Rowan', amount: 500, message: 'Testing, testing' },
  { kind: 'raid', label: 'Raid', c: 'c-raid', icon: 'swords', name: 'Hazel', amount: 42 },
];

function sendTest(key: string, t: (typeof TESTS)[number]) {
  return api.testEvent(key, { kind: t.kind, name: t.name, amount: t.amount, message: t.message });
}

function TestButton() {
  const ch = useChannel();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="qa-btn"
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await sendTest(ch.key, TESTS[Math.floor(Math.random() * TESTS.length)]);
          toast('Test alert sent');
        } catch (x) {
          toast(errorText(x), true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon id="zap" /><span>Test</span>
    </button>
  );
}

export function AlertsPage() {
  const ch = useChannel();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const recent = ch.events.filter((e) => e.kind !== 'giftedSub' && e.kind !== 'other').slice(0, 6);

  return (
    <div className="page">
      <PageHead title="Alerts" desc="What plays on your overlay, one alert at a time." />
      <div className="stack">
        <Card id="controls" title="Controls" desc="Changes apply to every connected overlay at once.">
          <div className="card-body"><AlertControls wide /></div>
        </Card>
        <Card id="tests" title="Send a test alert" desc="Test alerts play like real ones and are marked Test in your activity.">
          <div className="card-body">
            <div className="try-grid">
              {TESTS.map((t) => (
                <button
                  key={t.kind}
                  className={'try ' + t.c}
                  type="button"
                  disabled={busy === t.kind}
                  onClick={async () => {
                    setBusy(t.kind);
                    try {
                      await sendTest(ch.key, t);
                      toast(`Test ${t.label.toLowerCase()} sent`);
                    } catch (x) {
                      toast(errorText(x), true);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <span className="tile"><Icon id={t.icon} /></span>{t.label}
                </button>
              ))}
            </div>
          </div>
        </Card>
        <Card id="replay" title="Replay a recent alert" desc="Replays go to the front of the queue.">
          <FeedList
            events={recent}
            freshFrom={ch.freshFrom}
            onReplay={ch.replay}
            empty="Alerts you can replay show up here."
          />
        </Card>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Overlay */

export function OverlayPage() {
  const ch = useChannel();
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api.overlay(ch.key).then((r) => setUrl(r.url)).catch((x) => toast('Could not load the overlay link: ' + errorText(x), true));
  }, [ch.key, toast]);
  useEffect(() => () => clearTimeout(disarm.current), []);

  const masked = url ? url.replace(/token=.*/, 'token=' + '•'.repeat(12)) : 'Loading';
  const connected = ch.alerts?.overlaysConnected ?? 0;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      remember('sylva.overlayCopied');
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
      setUrl((await api.rotateOverlay(ch.key)).url);
      toast('New link made. The old one stopped working, so paste this one into OBS.');
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  return (
    <div className="page">
      <PageHead
        title="Overlay"
        desc={connected === 0 ? 'No overlay is connected right now.' : connected === 1 ? '1 overlay is connected right now.' : `${num(connected)} overlays are connected right now.`}
      />
      <div className="stack">
        <Card id="link" title="Your overlay link" desc="Anyone with this link can show your alerts, so keep it private.">
          <div className="card-body">
            <div className="link-row">
              <div className="link-field" title="The link is hidden. Copy it to use it."><span>{masked}</span></div>
              <button className="btn primary" type="button" disabled={!url} onClick={copy}><Icon id="copy" />Copy link</button>
              <a className="btn" href={url ? url + '&debug' : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!url}>
                <Icon id="external" />Open
              </a>
              <button className={'btn' + (armed ? ' armed' : '')} type="button" disabled={!url} onClick={replace}>
                <Icon id="refresh" />{armed ? 'Click again to replace' : 'New link'}
              </button>
            </div>
          </div>
        </Card>
        <div className="grid-2">
          <Card id="obs" title="Add it to OBS">
            <div className="card-body">
              <ol className="steps">
                <li>In OBS, under <b>Sources</b>, click <b>+</b> and choose <b>Browser</b>.</li>
                <li>Name it <b>Sylva alerts</b> and click <b>OK</b>.</li>
                <li>Paste your overlay link into <b>URL</b>.</li>
                <li>Set <b>Width</b> to <b>1920</b> and <b>Height</b> to <b>1080</b>, then click <b>OK</b>.</li>
                <li>Send a test alert from <Link href="/app/alerts">Alerts</Link> to check it.</li>
              </ol>
            </div>
          </Card>
          <Card id="look" title="What it looks like" desc="Alerts appear in the middle of the screen, over your scene.">
            <div className="card-body">
              <div className="stage" aria-hidden="true">
                <div className="alert-card c-sub">
                  <div className="label">New subscriber</div>
                  <div className="name">Juniper</div>
                  <div className="detail">6 months</div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Activity */

export function ActivityPage() {
  const ch = useChannel();
  const toast = useToast();
  useTick();
  const [shown, toggle] = useShown();
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SylvaEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);

  // Search on the server, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!q) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.history(ch.key, 'alerts', PAGE, undefined, q)
      .then((r) => {
        if (cancelled) return;
        setResults(r.events);
        setMore(r.events.length === PAGE);
      })
      .catch((x) => !cancelled && toast('Search failed: ' + errorText(x), true))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [q, ch.key, toast]);

  const searchMore = async () => {
    if (!results?.length) return;
    setLoading(true);
    try {
      const r = await api.history(ch.key, 'alerts', PAGE, results[results.length - 1].seq, q);
      setResults([...results, ...r.events]);
      setMore(r.events.length === PAGE);
    } catch (x) {
      toast('Search failed: ' + errorText(x), true);
    } finally {
      setLoading(false);
    }
  };

  const { counts, total } = lastDay(ch.events);
  const source = results ?? ch.events;
  const visible = source.filter(matchesShown(shown));
  const hasMore = results ? more : ch.hasMore;
  const busy = results ? loading : ch.loadingMore;

  let empty: string;
  if (!ch.loaded) empty = 'Loading activity';
  else if (q && loading) empty = 'Searching';
  else if (q) empty = `Nothing matches "${q}"${shown.size ? ' with these filters' : ''}.`;
  else if (ch.events.length) empty = 'Nothing here for these filters yet.';
  else empty = 'No activity yet. Follows, subs, cheers and raids appear here the moment they happen.';

  return (
    <div className="page">
      <PageHead title="Activity" desc="Every follow, sub, gift, cheer and raid, newest first." />
      <Card id="activity" title="All activity" desc={total === 1 ? '1 event in the last 24 hours' : `${num(total)} events in the last 24 hours`}>
        <MixBar counts={counts} total={total} />
        <div className="feed-tools">
          <label className="search">
            <Icon id="search" />
            <span className="sr-only">Search activity</span>
            <input
              className="input"
              type="search"
              placeholder="Search names and messages"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <Filters shown={shown} toggle={toggle} counts={counts} total={total} />
        </div>
        <FeedList events={visible} freshFrom={ch.freshFrom} onReplay={ch.replay} empty={empty} />
        {hasMore && visible.length > 0 && (
          <div className="feed-more">
            <button className="btn" type="button" disabled={busy} onClick={results ? searchMore : ch.loadMore}>
              {busy ? 'Loading' : 'Show older'}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- Chat */

function ChatList({ lines, freshFrom, size }: { lines: SylvaEvent[]; freshFrom: number; size: 'short' | 'tall' }) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <ol
      className={'chat ' + size}
      ref={list}
      aria-live="polite"
      tabIndex={0}
      aria-label="Chat messages"
      onScroll={(e) => {
        const el = e.currentTarget;
        // Follow new lines only while scrolled to the bottom.
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length === 0 && <li className="empty">No chat yet. Messages show up here as they are sent.</li>}
      {lines.map((l) => (
        <li key={l.seq} className={l.seq > freshFrom ? 'fresh' : undefined}>
          <time dateTime={l.createdAt} title={new Date(l.createdAt).toLocaleString()}>{ago(l.createdAt)}</time>
          <b>{l.actor?.displayName || 'Someone'}</b>{l.message}
        </li>
      ))}
    </ol>
  );
}

export function ChatPage() {
  const ch = useChannel();
  useTick();
  return (
    <div className="page">
      <PageHead title="Chat" desc="Your Twitch chat, live. Scroll up to pause, scroll down to follow again." />
      <Card id="chat" title={`twitch.tv/${ch.twitch?.login ?? ''}`} desc="Read only">
        <ChatList lines={ch.chat} freshFrom={ch.freshFrom} size="tall" />
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- Settings */

const FEATURE_LABELS: Record<string, string> = {
  follows: 'Follows', subs: 'Subs', cheers: 'Cheers', chat: 'Chat', raids: 'Raids', stream: 'Going live',
};

function TwitchEvents() {
  const ch = useChannel();
  const toast = useToast();
  const [features, setFeatures] = useState<FeatureStatus[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  useEffect(() => {
    api.twitch(ch.key).then((r) => setFeatures(r.features)).catch(() => setFailed(true));
  }, [ch.key]);

  const turnOn = async () => {
    setBusy(true);
    try {
      const r = await api.twitchSubscribe(ch.key);
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
    <Card
      id="twitch"
      title="Twitch events"
      desc={features ? (off.length ? `${off.length} not reaching Sylva` : 'All events reach Sylva') : failed ? undefined : 'Checking with Twitch'}
    >
      <div className="card-body stack">
        {failed && !features && <p className="card-text">Could not check with Twitch right now. Events still arrive.</p>}
        {features && (
          <div className="status-grid">
            {features.map((f) => (
              <div key={f.feature} className={'status ' + (f.on ? 'on' : 'off')} title={f.problems.join('\n') || undefined}>
                <span className="dot" />{FEATURE_LABELS[f.feature] || f.feature}<span className="state">{f.on ? 'On' : 'Off'}</span>
              </div>
            ))}
          </div>
        )}
        {(off.length > 0 || failed) && (
          <div className="notice">
            <span>
              {needsSignIn
                ? 'Twitch says Sylva no longer has permission. Sign in again to turn these back on.'
                : 'Some events are not reaching Sylva.'}
            </span>
            {needsSignIn
              ? <a className="btn primary sm" href="/auth/twitch/start"><Icon id="twitch" />Sign in again</a>
              : <button className="btn sm" type="button" disabled={busy} onClick={turnOn}>{busy ? 'Turning on' : 'Turn on again'}</button>}
          </div>
        )}
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const ch = useChannel();
  const [theme, set] = useState<Theme>(getTheme);
  const [signingOut, setSigningOut] = useState(false);
  const choose = (t: Theme) => { setTheme(t); set(t); };
  const themes: { id: Theme; label: string; icon: string }[] = useMemo(() => [
    { id: 'dark', label: 'Dark', icon: 'moon' },
    { id: 'light', label: 'Light', icon: 'sun' },
    { id: 'system', label: 'System', icon: 'monitor' },
  ], []);

  return (
    <div className="page">
      <PageHead title="Settings" desc="Your account, how Sylva looks, and your connection to Twitch." />
      <div className="stack">
        <Card id="account" title="Account">
          <div className="setting">
            <div className="account">
              <Avatar name={ch.name} url={ch.twitch?.avatar} large />
              <div>
                <b>{ch.name}</b>
                <span>Signed in with Twitch as {ch.twitch?.login}</span>
              </div>
            </div>
            <button
              className="btn danger"
              type="button"
              disabled={signingOut}
              onClick={() => { setSigningOut(true); void ch.signOut(); }}
            >
              <Icon id="logout" />{signingOut ? 'Signing out' : 'Sign out'}
            </button>
          </div>
        </Card>
        <Card id="appearance" title="Appearance">
          <div className="setting">
            <div>
              <h3>Theme</h3>
              <p>Saved in this browser.</p>
            </div>
            <div className="segmented" role="group" aria-label="Theme">
              {themes.map((t) => (
                <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => choose(t.id)}>
                  <Icon id={t.icon} />{t.label}
                </button>
              ))}
            </div>
          </div>
        </Card>
        <TwitchEvents />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 404 */

export function NotFoundPage() {
  return (
    <div className="page">
      <div className="not-found">
        <h1>Page not found</h1>
        <p>That page does not exist in your dashboard.</p>
        <Link className="btn primary" href="/app">Go to Overview</Link>
      </div>
    </div>
  );
}

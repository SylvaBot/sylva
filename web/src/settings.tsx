// Settings: a window over the page with its own sidebar and a search, like a
// desktop app's preferences. Account, Team, Connected apps, Import from
// StreamElements and Appearance; Sign out at the foot.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type AppToken, type FeatureStatus } from './api';
import { useChannel } from './channel';
import { MigrateCard } from './migrate';
import { Link } from './router';
import { TeamCard } from './team';
import {
  getDensity, getMotion, getTheme, setDensity, setMotion, setTheme, type Density, type Theme,
} from './theme';
import { ago, Avatar, errorText, Icon, Row, Sect, Seg, SkelRows, Switch, useToast } from './ui';

export type SettingsSection = 'account' | 'team' | 'apps' | 'import' | 'appearance';

const SECTIONS: { id: SettingsSection; label: string; icon: string; owner?: boolean; words: string }[] = [
  { id: 'account', label: 'Account', icon: 'user', words: 'profile twitch events permissions delete account sign out' },
  { id: 'team', label: 'Team', icon: 'team', owner: true, words: 'moderators editors viewers people roles' },
  { id: 'apps', label: 'Connected apps', icon: 'plug', words: 'sylva desktop device tokens remove' },
  { id: 'import', label: 'Import from another service', icon: 'import', owner: true, words: 'move migrate switch streamelements streamlabs nightbot fossabot moobot wizebot csv commands timers points watch time tips history jwt' },
  { id: 'appearance', label: 'Appearance', icon: 'palette', words: 'theme dark light system density compact clock 12 24 hour motion animation' },
];

export function SettingsWindow({ section, onSection, onClose }: { section: SettingsSection; onSection(s: SettingsSection): void; onClose(): void }) {
  const ch = useChannel();
  const [q, setQ] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const list = SECTIONS.filter((s) => !s.owner || ch.can.own);
  const needle = q.trim().toLowerCase();
  const shown = needle ? list.filter((s) => (s.label + ' ' + s.words).toLowerCase().includes(needle)) : list;
  const current = list.find((s) => s.id === section) ?? list[0];

  // Escape closes; focus stays inside the window and goes back where it was.
  useEffect(() => {
    back.current = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    addEventListener('keydown', key);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
      back.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-side">
          <h2 id="settings-title">Settings</h2>
          <label className="search settings-search">
            <Icon id="search" />
            <span className="sr-only">Search settings</span>
            <input className="input" type="search" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </label>
          <nav aria-label="Settings sections">
            {shown.map((s) => (
              <button key={s.id} type="button" className="si" aria-current={s.id === current.id ? 'page' : undefined} onClick={() => onSection(s.id)}>
                <Icon id={s.icon} />{s.label}
              </button>
            ))}
            {shown.length === 0 && <p className="settings-none">Nothing matches.</p>}
          </nav>
          <button className="si settings-out" type="button" disabled={signingOut} onClick={() => { setSigningOut(true); void ch.signOut(); }}>
            <Icon id="logout" />{signingOut ? 'Signing out' : 'Sign out'}
          </button>
        </div>
        <div className="settings-main">
          <div className="settings-head">
            <h3>{current.label}</h3>
            <button className="icon-btn" type="button" aria-label="Close settings" onClick={onClose}><Icon id="x" /></button>
          </div>
          <div className="settings-body">
            {current.id === 'account' && <AccountSection />}
            {current.id === 'team' && <TeamCard />}
            {current.id === 'apps' && <ConnectedApps />}
            {current.id === 'import' && <MigrateCard />}
            {current.id === 'appearance' && <Appearance />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Account */

const FEATURE_LABELS: Record<string, string> = {
  follows: 'Follows', subs: 'Subs', cheers: 'Bits', chat: 'Chat', raids: 'Raids', stream: 'Going live', chatAlerts: 'Chat alerts',
};

function AccountSection() {
  const ch = useChannel();
  return (
    <div className="stack">
      <Sect title="Profile">
        <div className="gr">
          <Avatar name={ch.you} url={ch.twitch?.avatar} />
          <div className="gr-main">
            <div className="t1">{ch.you}</div>
            <div className="t2">Signed in with Twitch as {ch.twitch?.login}</div>
          </div>
        </div>
      </Sect>
      <TwitchEvents />
      {ch.can.own && <DeleteAccount />}
    </div>
  );
}

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
      if (x instanceof ApiError && x.status === 409 && (x.body as { needsSignIn?: boolean })?.needsSignIn) setNeedsSignIn(true);
      else toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  const off = features?.filter((f) => !f.on) || [];
  const fix = (off.length > 0 || failed) && ch.can.edit;
  return (
    <Sect
      title="Twitch events"
      desc={features ? (off.length ? `${off.length} not reaching Sylva` : 'Everything reaches Sylva') : failed ? 'Could not check with Twitch right now. Events still arrive.' : 'Checking with Twitch'}
      action={fix ? (needsSignIn && !ch.can.own ? null : needsSignIn
        ? <a className="btn sm primary" href="/auth/twitch/start"><Icon id="twitch" />Sign in again</a>
        : <button className="btn sm" type="button" disabled={busy} onClick={turnOn}>{busy ? 'Turning on' : 'Turn on again'}</button>) : undefined}
      foot={needsSignIn
        ? ch.can.own
          ? 'Twitch says Sylva no longer has permission. Sign in again to turn these back on.'
          : `Twitch says Sylva no longer has permission. ${ch.name} needs to sign in to Sylva again to turn these back on.`
        : (off.length > 0 || failed) && !ch.can.edit ? 'The owner or an editor can turn these back on here.' : undefined}
    >
      {!features && !failed && <SkelRows n={3} tile={false} />}
      {failed && !features && <Row title="Unknown for now" desc="Sylva could not ask Twitch. Try again in a minute." />}
      {features?.map((f) => (
        <Row key={f.feature} title={FEATURE_LABELS[f.feature] || f.feature} desc={f.problems.join(' ') || undefined}>
          <span className={'state-text' + (f.on ? '' : ' off')}>{f.on ? 'On' : 'Off'}</span>
        </Row>
      ))}
    </Sect>
  );
}

function DeleteAccount() {
  const ch = useChannel();
  const login = ch.twitch?.login ?? '';
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = login !== '' && typed.trim().toLowerCase() === login.toLowerCase();

  const remove = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(typed.trim());
      // A full load, so nothing of the old account stays in memory.
      location.assign('/?deleted=1');
    } catch (x) {
      setError(errorText(x));
      setBusy(false);
    }
  };

  return (
    <Sect title="Delete account">
      {!open ? (
        <Row
          title="Delete your Sylva account"
          desc={<>Your activity, settings, overlay links and connected apps are deleted at once, and Twitch stops sending Sylva your events. This cannot be undone. <Link href="/privacy">What Sylva keeps</Link></>}
        >
          <button className="btn sm danger" type="button" onClick={() => setOpen(true)}>Delete account</button>
        </Row>
      ) : (
        <form className="gr delete-form" onSubmit={remove}>
          <div className="gr-main">
            <label className="t1" htmlFor="delete-confirm">Type <span className="mono">{login}</span> to confirm</label>
            <input
              id="delete-confirm"
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              style={{ marginTop: 8 }}
            />
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="gr-ctl" style={{ alignSelf: 'flex-end' }}>
            <button className="btn sm" type="button" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setError(null); }}>Cancel</button>
            <button className="btn sm solid-danger" type="submit" disabled={busy || !matches}>{busy ? 'Deleting' : 'Delete everything'}</button>
          </div>
        </form>
      )}
    </Sect>
  );
}

/* ---------------------------------------------------------------- Connected apps */

function ConnectedApps() {
  const toast = useToast();
  const [apps, setApps] = useState<AppToken[] | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    api.apps().then(setApps).catch(() => setApps([]));
  }, []);

  const revoke = async (a: AppToken) => {
    if (armed !== a.id) { setArmed(a.id); return; }
    setArmed(null);
    try {
      await api.revokeApp(a.id);
      setApps((list) => (list || []).filter((x) => x.id !== a.id));
      toast(`${a.name} can no longer use your Sylva`);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  return (
    <Sect
      title="Apps you allowed to use your Sylva"
      foot={<>To connect one, such as Sylva Desktop, sign in from the app and enter its code at <Link href="/device">{location.host}/device</Link>.</>}
    >
      {apps === null && <SkelRows n={1} tile={false} />}
      {apps && apps.length === 0 && <Row title="No apps yet" desc="Apps you connect show up here, and you can remove them any time." />}
      {apps?.map((a) => (
        <Row
          key={a.id}
          title={a.name}
          desc={`Connected ${new Date(a.createdAt).toLocaleDateString()}${a.lastUsedAt ? `, last used ${ago(new Date(a.lastUsedAt).toISOString())}` : ', not used yet'}`}
        >
          <button className={'btn sm' + (armed === a.id ? ' armed' : ' danger')} type="button" onClick={() => revoke(a)} onBlur={() => setArmed(null)}>
            {armed === a.id ? 'Click again to remove' : 'Remove'}
          </button>
        </Row>
      ))}
    </Sect>
  );
}

/* ---------------------------------------------------------------- Appearance */

function Appearance() {
  const [theme, set] = useState<Theme>(getTheme);
  const [density, setD] = useState<Density>(getDensity);
  const [clock, setClock] = useState<'12' | '24'>(() => {
    try { return localStorage.getItem('sylva.clock') === '24' ? '24' : '12'; } catch { return '12'; }
  });
  const motionNow = () => document.documentElement.dataset.motion === 'reduce';
  const [reduce, setReduce] = useState(motionNow);
  const [motionPicked, setMotionPicked] = useState(getMotion() !== 'system');
  return (
    <div className="stack">
      <Part title="Look">
        <Row title="Theme" desc="Saved in this browser">
          <Seg label="Theme" options={[{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }, { id: 'system', label: 'System' }] as const} value={theme} onChange={(t) => { setTheme(t); set(t); }} />
        </Row>
        <Row title="Density" desc="Compact fits more rows on smaller screens">
          <Seg label="Density" options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }] as const} value={density} onChange={(d) => { setDensity(d); setD(d); }} />
        </Row>
      </Part>
      <Part title="Time">
        <Row title="Clock" desc="For times in Activity and the logs">
          <Seg label="Clock" options={[{ id: '12', label: '12 hour' }, { id: '24', label: '24 hour' }] as const} value={clock} onChange={(c) => {
            try { localStorage.setItem('sylva.clock', c); } catch { /* private window */ }
            setClock(c);
          }} />
        </Row>
      </Part>
      <Part title="Motion">
        <Row title="Reduce motion" desc={motionPicked ? 'Fewer animations across the dashboard' : 'Follows your system setting until you change it'}>
          <Switch on={reduce} label="Reduce motion" onChange={(v) => { setMotion(v ? 'reduce' : 'full'); setReduce(motionNow()); setMotionPicked(true); }} />
        </Row>
      </Part>
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return <Sect title={title}>{children}</Sect>;
}

// The dashboard frame: a sidebar with the pages in four groups, the search
// that jumps to any page or action (Ctrl K), and your name with Settings at
// the foot. On phones a top bar opens the sidebar as a drawer. Settings opens
// as a window over the page.

import { Command } from 'cmdk';
import { Fragment, useEffect, useRef, useState, type ComponentType } from 'react';
import { api } from './api';
import { AlertsPage } from './alertsPage';
import { AlertStylePage } from './alertStyle';
import { ROLE_NAMES, useChannel } from './channel';
import { CommandsPage } from './bot';
import { GiveawaysPage } from './giveaways';
import { HomePage } from './home';
import { ModerationPage } from './moderation';
import { OverlayPage } from './overlay';
import { ActivityPage, NotFoundPage } from './pages';
import { PointsPage } from './points';
import { Link, navigate } from './router';
import { SettingsWindow, type SettingsSection } from './settings';
import { TipsPage } from './tipsAdmin';
import { SongsPage } from './songs';
import { Avatar, errorText, Icon, Leaf, useToast } from './ui';
import { Select } from './dropdown';

interface Page { path: string; label: string; icon: string; view: ComponentType; group: string; nav?: string }

const PAGES: Page[] = [
  { path: '/app', label: 'Home', icon: 'home', view: HomePage, group: '' },
  { path: '/app/activity', label: 'Activity', icon: 'activity', view: ActivityPage, group: '' },
  { path: '/app/alerts', label: 'Alerts', icon: 'bell', view: AlertsPage, group: 'Stream' },
  { path: '/app/overlays', label: 'Overlays', icon: 'layers', view: OverlayPage, group: 'Stream' },
  { path: '/app/tips', label: 'Tips', icon: 'tip', view: TipsPage, group: 'Stream' },
  { path: '/app/songs', label: 'Song requests', icon: 'music', view: SongsPage, group: 'Stream' },
  { path: '/app/commands', label: 'Commands', icon: 'terminal', view: CommandsPage, group: 'Chat' },
  { path: '/app/moderation', label: 'Moderation', icon: 'shield', view: ModerationPage, group: 'Chat' },
  { path: '/app/points', label: 'Points', icon: 'gem', view: PointsPage, group: 'Community' },
  { path: '/app/giveaways', label: 'Giveaways', icon: 'ticket', view: GiveawaysPage, group: 'Community' },
];
/** Pages that are not in the sidebar, shown under the page they belong to. */
const SUBPAGES: Page[] = [
  { path: '/app/alerts/style', label: 'Alert style', icon: 'palette', view: AlertStylePage, group: 'Stream', nav: '/app/alerts' },
];
/** Old addresses keep working: bookmarks, Sylva Control and older links. */
const MOVED: Record<string, string> = {
  '/app/stats': '/app',
  '/app/overlay': '/app/overlays',
  '/app/bot': '/app/commands',
  '/app/chat-alerts': '/app/alerts?tab=chat',
  '/app/loyalty': '/app/points',
  '/app/store': '/app/points',
};

export function Shell({ path }: { path: string }) {
  const ch = useChannel();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const clean = path.replace(/\/+$/, '') || '/app';
  const isSettings = clean === '/app/settings';
  const page = isSettings ? PAGES[0] : [...PAGES, ...SUBPAGES].find((p) => p.path === clean);
  const navPath = page?.nav ?? page?.path;
  const View = page?.view ?? NotFoundPage;

  // Old page addresses move to where that page lives now.
  useEffect(() => {
    const to = MOVED[clean];
    if (to) navigate(to + (to.includes('?') ? '' : location.search) + location.hash, true);
  }, [clean]);

  // /app/settings opens the Settings window over Home, for older links.
  useEffect(() => {
    if (isSettings) setSettings((s) => s ?? 'account');
  }, [isSettings]);

  useEffect(() => {
    document.title = `${isSettings ? 'Settings' : page?.label ?? 'Not found'} · Sylva`;
    setOpen(false);
  }, [page, isSettings]);

  // Ctrl or Cmd + K opens the search from anywhere.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v); }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  // The phone drawer: focus moves into it when it opens and back to the menu
  // button when it closes; the page behind it is inert meanwhile.
  useEffect(() => {
    if (open) side.current?.querySelector<HTMLElement>('.side-nav a')?.focus();
    else if (wasOpen.current) menuButton.current?.focus();
    wasOpen.current = open;
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const wide = matchMedia('(min-width: 721px)');
    const resized = () => wide.matches && setOpen(false);
    addEventListener('keydown', esc);
    wide.addEventListener('change', resized);
    return () => {
      removeEventListener('keydown', esc);
      wide.removeEventListener('change', resized);
    };
  }, [open]);

  // Only a lost connection that lasts a few seconds gets a quiet note.
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (ch.connected) { setLost(false); return; }
    const t = setTimeout(() => setLost(true), 6000);
    return () => clearTimeout(t);
  }, [ch.connected]);

  const closeSettings = () => {
    setSettings(null);
    if (isSettings) navigate('/app', true);
  };

  return (
    <div className={'shell' + (open ? ' open' : '')}>
      <div className="drawer-scrim" onClick={() => setOpen(false)} />
      <aside ref={side} className="side" aria-label="Sylva">
        <Link className="side-brand" href="/app" aria-label="Sylva home"><Leaf size={24} />Sylva</Link>
        <button className="side-search" type="button" onClick={() => setPalette(true)} aria-keyshortcuts="Control+K Meta+K">
          <Icon id="search" /><span>Search</span><span className="kbd">Ctrl K</span>
        </button>
        <nav className="side-nav" aria-label="Pages">
          {PAGES.map((p, i) => (
            <Fragment key={p.path}>
              {p.group && p.group !== PAGES[i - 1]?.group && <div className="side-label" role="presentation">{p.group}</div>}
              <Link className="si" href={p.path} current={p.path === navPath && !isSettings}>
                <Icon id={p.icon} />{p.label}
              </Link>
            </Fragment>
          ))}
        </nav>
        <div className="side-foot">
          {ch.channels.length > 1 && (
            <div className="side-channel">
              <Select className="sm" style={{ width: '100%' }} label="Channel" value={ch.key} onChange={(k) => ch.switchTo(k)}
                options={ch.channels.map((c) => ({ value: c.key, label: (c.name || c.login || 'Your channel') + (c.role === 'owner' ? '' : ` (${ROLE_NAMES[c.role]})`) }))} />
            </div>
          )}
          <div className="side-me">
            <Avatar name={ch.you} url={ch.twitch?.avatar} />
            <span className="side-me-name">{ch.you}{ch.role !== 'owner' && <small>{ROLE_NAMES[ch.role]} for {ch.name}</small>}</span>
            <button className="icon-btn" type="button" aria-label="Settings" title="Settings" onClick={() => { setOpen(false); setSettings('account'); }}>
              <Icon id="settings" />
            </button>
          </div>
        </div>
      </aside>

      <div className="frame" inert={open}>
        <header className="topbar">
          <button ref={menuButton} className="icon-btn" type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
            <Icon id="menu" />
          </button>
          <Link className="side-brand" href="/app" aria-label="Sylva home"><Leaf size={22} />Sylva</Link>
          <button className="icon-btn" type="button" aria-label="Search" onClick={() => setPalette(true)}>
            <Icon id="search" />
          </button>
        </header>
        <main className="main" id="content">
          {lost && <div className="notice reconnect" role="status">Reconnecting to live events. Nothing is lost while this shows.</div>}
          {!ch.can.edit && (
            <div className="notice role-note">
              {ch.can.moderate
                ? <span>You are a moderator for {ch.name}. Settings are read only here; the alert queue, points, rewards, giveaways, quotes and counters work as usual.</span>
                : <span>You can see everything on {ch.name}&apos;s channel, but only the owner and editors can change it.</span>}
            </div>
          )}
          <View />
        </main>
      </div>
      {palette && <Palette pages={PAGES} onClose={() => setPalette(false)} openSettings={(s) => setSettings(s)} />}
      {settings && <SettingsWindow section={settings} onSection={setSettings} onClose={closeSettings} />}
    </div>
  );
}

/** Jump to any page or run a common action by typing (cmdk). */
function Palette({ pages, onClose, openSettings }: { pages: Page[]; onClose(): void; openSettings(s: SettingsSection): void }) {
  const ch = useChannel();
  const toast = useToast();
  const go = (to: string) => { onClose(); navigate(to); scrollTo(0, 0); };
  const s = ch.alerts;
  const alertAction = async (a: 'pause' | 'resume' | 'mute' | 'unmute' | 'skip', done: string) => {
    onClose();
    try { ch.setAlerts(await api.alert(ch.key, a)); toast(done); } catch (x) { toast(errorText(x), true); }
  };
  const actions: { label: string; icon: string; run(): void; when: boolean }[] = [
    { label: s?.paused ? 'Resume alerts' : 'Pause alerts', icon: s?.paused ? 'play' : 'pause', when: ch.can.moderate && !!s,
      run: () => void alertAction(s?.paused ? 'resume' : 'pause', s?.paused ? 'Alerts resumed' : 'Alerts paused') },
    { label: s?.muted ? 'Unmute alerts' : 'Mute alerts', icon: s?.muted ? 'vol' : 'volx', when: ch.can.moderate && !!s,
      run: () => void alertAction(s?.muted ? 'unmute' : 'mute', s?.muted ? 'Alerts unmuted' : 'Alerts muted') },
    { label: 'Skip the alert on screen', icon: 'skip', when: ch.can.moderate && s?.playing !== null && !!s, run: () => void alertAction('skip', 'Skipped the alert on screen') },
    { label: 'Edit alert style', icon: 'palette', when: true, run: () => go('/app/alerts/style') },
    { label: 'New command', icon: 'plus', when: ch.can.edit, run: () => go('/app/commands?new=1') },
    { label: 'Start a giveaway', icon: 'ticket', when: ch.can.moderate, run: () => go('/app/giveaways') },
    { label: 'Open Settings', icon: 'settings', when: true, run: () => { onClose(); openSettings('account'); } },
    { label: 'Change theme', icon: 'palette', when: true, run: () => { onClose(); openSettings('appearance'); } },
  ];
  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Command className="palette" label="Search" loop onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="palette-input"><Icon id="search" /><Command.Input autoFocus placeholder="Search pages and actions" /></div>
        <Command.List>
          <Command.Empty>Nothing by that name.</Command.Empty>
          <Command.Group heading="Pages">
            {pages.map((p) => (
              <Command.Item key={p.path} value={p.label} onSelect={() => go(p.path)}>
                <Icon id={p.icon} />{p.label}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Actions">
            {actions.filter((a) => a.when).map((a) => (
              <Command.Item key={a.label} value={a.label} onSelect={a.run}>
                <Icon id={a.icon} />{a.label}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

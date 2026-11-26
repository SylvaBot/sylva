// The dashboard frame: a sidebar with the pages, the channel and the live
// connection, and on phones a top bar that opens the sidebar as a drawer.

import { Fragment, useEffect, useRef, useState } from 'react';
import { BotPage } from './bot';
import { ChatAlertsPage } from './chatAlerts';
import { ROLE_NAMES, useChannel } from './channel';
import { GiveawaysPage } from './giveaways';
import { LoyaltyPage } from './loyalty';
import { StorePage } from './store';
import { ModerationPage } from './moderation';
import { OverlayPage } from './overlay';
import { ActivityPage, AlertsPage, ChatPage, NotFoundPage, OverviewPage, SettingsPage } from './pages';
import { Command } from 'cmdk';
import { Link, navigate } from './router';
import { StatsPage } from './stats';
import { Avatar, Icon } from './ui';

const PAGES = [
  { path: '/app', label: 'Overview', icon: 'home', view: OverviewPage, group: 'Home' },
  { path: '/app/stats', label: 'Stats', icon: 'chart', view: StatsPage, group: 'Home' },
  { path: '/app/activity', label: 'Activity', icon: 'activity', view: ActivityPage, group: 'Home' },
  { path: '/app/alerts', label: 'Alerts', icon: 'bell', view: AlertsPage, group: 'Stream' },
  { path: '/app/overlay', label: 'Overlays', icon: 'monitor', view: OverlayPage, group: 'Stream' },
  { path: '/app/chat', label: 'Chat', icon: 'message', view: ChatPage, group: 'Stream' },
  { path: '/app/bot', label: 'Chat bot', icon: 'bot', view: BotPage, group: 'Bot' },
  { path: '/app/chat-alerts', label: 'Chat alerts', icon: 'zap', view: ChatAlertsPage, group: 'Bot' },
  { path: '/app/moderation', label: 'Moderation', icon: 'shield', view: ModerationPage, group: 'Bot' },
  { path: '/app/loyalty', label: 'Loyalty', icon: 'gem', view: LoyaltyPage, group: 'Community' },
  { path: '/app/store', label: 'Store', icon: 'gift', view: StorePage, group: 'Community' },
  { path: '/app/giveaways', label: 'Giveaways', icon: 'trophy', view: GiveawaysPage, group: 'Community' },
];
const SETTINGS = { path: '/app/settings', label: 'Settings', icon: 'settings', view: SettingsPage, group: 'Account' };

export function Shell({ path }: { path: string }) {
  const ch = useChannel();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const clean = path.replace(/\/+$/, '') || '/app';
  const page = [...PAGES, SETTINGS].find((p) => p.path === clean);
  const View = page?.view ?? NotFoundPage;

  useEffect(() => {
    document.title = `${page?.label ?? 'Not found'} · Sylva`;
    setOpen(false);
  }, [page]);

  // Ctrl or Cmd + K opens the page search from anywhere.
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
    if (open) rail.current?.querySelector<HTMLElement>('nav a')?.focus();
    else if (wasOpen.current) menuButton.current?.focus();
    wasOpen.current = open;
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // Wider than a phone there is no drawer, so nothing may stay inert.
    const wide = matchMedia('(min-width: 861px)');
    const resized = () => wide.matches && setOpen(false);
    addEventListener('keydown', esc);
    wide.addEventListener('change', resized);
    return () => {
      removeEventListener('keydown', esc);
      wide.removeEventListener('change', resized);
    };
  }, [open]);

  const queued = ch.alerts?.queued ?? 0;
  const conn = (
    <span className={'conn ' + (ch.connected ? 'up' : 'down')} role="status" title={ch.connected ? 'Receiving events live' : 'Reconnecting. Nothing is lost.'}>
      <span className="dot" />{ch.connected ? 'Connected' : 'Reconnecting'}
    </span>
  );
  const navLink = (p: typeof SETTINGS) => (
    <Link key={p.path} href={p.path} current={p === page} data-tip={p.label} aria-label={p.label}>
      <Icon id={p.icon} /><span className="rail-label">{p.label}</span>
      {p.path === '/app/alerts' && queued > 0 && <span className="badge" title={`${queued} alerts waiting`}>{queued}</span>}
    </Link>
  );

  return (
    <div className={'shell' + (open ? ' open' : '')}>
      <div className="drawer-scrim" onClick={() => setOpen(false)} />
      <aside ref={rail} className="rail" aria-label="Dashboard">
        <Link className="rail-brand" href="/app" aria-label="Sylva home"><img src="/logo.svg" alt="" width="32" height="32" /><span className="rail-label">Sylva</span></Link>
        <nav className="rail-nav" aria-label="Pages">
          {PAGES.map((p, i) => (
            <Fragment key={p.path}>
              {i > 0 && p.group !== PAGES[i - 1].group && <span className="rail-sep" role="separator" />}
              {navLink(p)}
            </Fragment>
          ))}
        </nav>
        <nav className="rail-foot" aria-label="Account">{navLink(SETTINGS)}</nav>
      </aside>

      <div className="frame" inert={open}>
        <header className="appbar">
          <button ref={menuButton} className="icon-btn menu-btn" type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
            <Icon id="menu" />
          </button>
          <div className="appbar-title">
            <span className="appbar-group">{page?.group ?? 'Sylva'}</span>
            <b>{page?.label ?? 'Not found'}</b>
          </div>
          <div className="appbar-right">
            <button className="search-pill" type="button" onClick={() => setPalette(true)} aria-keyshortcuts="Control+K Meta+K">
              <Icon id="search" /><span>Search</span><kbd>Ctrl K</kbd>
            </button>
            {conn}
            {ch.channels.length > 1 && (
              <label className="channel-pick">
                <span className="sr-only">Channel</span>
                <select className="select sm" value={ch.key} onChange={(e) => ch.switchTo(e.target.value)}>
                  {ch.channels.map((c) => (
                    <option key={c.key} value={c.key}>
                      {(c.name || c.login || 'Your channel') + (c.role === 'owner' ? '' : ` (${ROLE_NAMES[c.role]})`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="pill-group" role="group" aria-label="History">
              <button className="pill-btn" type="button" aria-label="Back" onClick={() => history.back()}><Icon id="chevron-left" /></button>
              <button className="pill-btn" type="button" aria-label="Forward" onClick={() => history.forward()}><Icon id="chevron" /></button>
            </div>
            <Link className="me-chip" href="/app/settings" title={ch.role === 'owner' ? `${ch.name}, settings` : `${ch.name} (${ROLE_NAMES[ch.role]}), settings`}>
              <Avatar name={ch.name} url={ch.avatar} />
            </Link>
          </div>
        </header>

        <main className="main" id="content">
          {!ch.connected && <div className="notice reconnect" role="status">Reconnecting to live events. Nothing is lost while this shows.</div>}
          {!ch.can.edit && (
            <div className="notice role-note">
              {ch.can.moderate
                ? <>You are a moderator for {ch.name}. Settings are read only here; the alert queue, points, the store queue, giveaways, quotes and counters work as usual.</>
                : <>You can see everything on {ch.name}&apos;s channel, but only the owner and editors can change it.</>}
            </div>
          )}
          <View />
        </main>
      </div>
      {palette && <Palette pages={[...PAGES, SETTINGS]} onClose={() => setPalette(false)} />}
    </div>
  );
}

/** Jump to any page by typing its name (cmdk). */
function Palette({ pages, onClose }: { pages: (typeof SETTINGS)[]; onClose(): void }) {
  const go = (to: string) => { onClose(); navigate(to); scrollTo(0, 0); };
  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Command className="palette" label="Go to a page" loop onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="palette-input"><Icon id="search" /><Command.Input autoFocus placeholder="Go to a page" /></div>
        <Command.List>
          <Command.Empty>No page by that name.</Command.Empty>
          {['Home', 'Stream', 'Bot', 'Community', 'Account'].map((g) => (
            <Command.Group key={g} heading={g}>
              {pages.filter((p) => p.group === g).map((p) => (
                <Command.Item key={p.path} value={p.label} onSelect={() => go(p.path)}>
                  <Icon id={p.icon} />{p.label}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}

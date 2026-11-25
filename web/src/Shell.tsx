// The dashboard frame: a sidebar with the pages, the channel and the live
// connection, and on phones a top bar that opens the sidebar as a drawer.

import { useEffect, useRef, useState } from 'react';
import { BotPage } from './bot';
import { useChannel } from './channel';
import { LoyaltyPage } from './loyalty';
import { ModerationPage } from './moderation';
import { OverlayPage } from './overlay';
import { ActivityPage, AlertsPage, ChatPage, NotFoundPage, OverviewPage, SettingsPage } from './pages';
import { Link } from './router';
import { Avatar, Icon } from './ui';

const PAGES = [
  { path: '/app', label: 'Overview', icon: 'home', view: OverviewPage },
  { path: '/app/activity', label: 'Activity', icon: 'activity', view: ActivityPage },
  { path: '/app/alerts', label: 'Alerts', icon: 'bell', view: AlertsPage },
  { path: '/app/overlay', label: 'Overlay', icon: 'monitor', view: OverlayPage },
  { path: '/app/chat', label: 'Chat', icon: 'message', view: ChatPage },
  { path: '/app/bot', label: 'Chat bot', icon: 'bot', view: BotPage },
  { path: '/app/moderation', label: 'Moderation', icon: 'shield', view: ModerationPage },
  { path: '/app/loyalty', label: 'Loyalty', icon: 'gem', view: LoyaltyPage },
];
const SETTINGS = { path: '/app/settings', label: 'Settings', icon: 'settings', view: SettingsPage };

export function Shell({ path }: { path: string }) {
  const ch = useChannel();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const clean = path.replace(/\/+$/, '') || '/app';
  const page = [...PAGES, SETTINGS].find((p) => p.path === clean);
  const View = page?.view ?? NotFoundPage;

  useEffect(() => {
    document.title = `${page?.label ?? 'Not found'} · Sylva`;
    setOpen(false);
  }, [page]);

  // The phone drawer: focus moves into it when it opens and back to the menu
  // button when it closes; the page behind it is inert meanwhile.
  useEffect(() => {
    if (open) sidebar.current?.querySelector<HTMLElement>('nav a')?.focus();
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
      <span className="dot" />{ch.connected ? 'Live' : 'Reconnecting'}
    </span>
  );

  return (
    <div className={'shell' + (open ? ' open' : '')}>
      <header className="topbar" inert={open}>
        <button ref={menuButton} className="icon-btn" type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
          <Icon id="menu" />
        </button>
        <Link className="brand" href="/app"><img src="/logo.svg" alt="" width="24" height="24" /><span>Sylva</span></Link>
        {conn}
      </header>
      <div className="drawer-scrim" onClick={() => setOpen(false)} />

      <aside ref={sidebar} className="sidebar" aria-label="Dashboard">
        <Link className="brand" href="/app"><img src="/logo.svg" alt="" width="26" height="26" /><span>Sylva</span></Link>
        <nav className="nav" aria-label="Pages">
          {PAGES.map((p) => (
            <Link key={p.path} href={p.path} current={p === page}>
              <Icon id={p.icon} />{p.label}
              {p.path === '/app/alerts' && queued > 0 && <span className="badge" title={`${queued} alerts waiting`}>{queued}</span>}
            </Link>
          ))}
          <span className="nav-label">Account</span>
          <Link href={SETTINGS.path} current={page === SETTINGS}><Icon id="settings" />Settings</Link>
        </nav>
        <div className="sidebar-foot">
          {conn}
          <Link className="me-card" href="/app/settings" title="Account settings">
            <Avatar name={ch.name} url={ch.twitch?.avatar} />
            <div>
              <b>{ch.name}</b>
              <span>twitch.tv/{ch.twitch?.login}</span>
            </div>
          </Link>
        </div>
      </aside>

      <main className="main" id="content" inert={open}>
        {!ch.connected && <div className="notice reconnect" role="status">Reconnecting to live events. Nothing is lost while this shows.</div>}
        <View />
      </main>
    </div>
  );
}

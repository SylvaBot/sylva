// Top level routing. "/" is the public landing page. "/app/..." is the
// dashboard, which needs a Sylva session: without one it sends you to the
// landing page, which offers Continue with Twitch.

import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { ChannelProvider } from './channel';
import { ChannelPage, ChatStatsPage, type ChannelTab } from './channelPage';
import { DevicePage } from './device';
import { Landing } from './Landing';
import { navigate, usePath } from './router';
import { Shell } from './Shell';
import { PrivacyPage } from './site';
import { PublicStorePage } from './store';
import { PublicTipPage } from './tips';
import { PageSkel, Skel } from './ui';

const SIGNIN_ERRORS: Record<string, string> = {
  denied: 'You cancelled on Twitch, so nothing changed. Sign in when you are ready.',
  expired: 'That sign in took too long or was opened twice. Try again.',
  scopes: 'Twitch did not give Sylva every permission it needs. Try again and allow all of them.',
  failed: 'Twitch did not finish the sign in. Try again in a minute.',
};

/** First path words the site uses itself, so they are never channel pages. */
const RESERVED = new Set(['app', 'device', 'privacy', 's', 'c', 'tip', 'overlay', 'overlay-frame', 'media', 'tts', 'auth', 'v1', 'assets', 'kokoro', 'health']);

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const reason = params.get('signin');
    if (reason) setError(SIGNIN_ERRORS[reason] || SIGNIN_ERRORS.failed);
    if (params.has('deleted')) setNotice('Your Sylva account and everything in it were deleted.');
    if (reason || params.has('deleted')) history.replaceState(null, '', location.pathname);
    api.me()
      .then((m) => setMe(m.channels.length ? m : null))
      .catch((x) => {
        setMe(null);
        if (!(x instanceof ApiError && x.status === 401)) setError('Sylva could not be reached. Refresh to try again.');
      });
  }, []);

  const inApp = path === '/app' || path.startsWith('/app/');

  useEffect(() => {
    if (inApp && me === null) navigate('/', true);
  }, [inApp, me]);

  useEffect(() => {
    if (path === '/') document.title = 'Sylva: alerts, overlays and activity for Twitch';
  }, [inApp, path]);

  if (path === '/device') return <DevicePage me={me} />;
  if (path === '/privacy') return <PrivacyPage signedIn={!!me} />;
  const store = /^\/s\/([A-Za-z0-9_]{1,25})\/?$/.exec(path);
  if (store) return <PublicStorePage login={store[1].toLowerCase()} signedIn={!!me} />;
  const tip = /^\/tip\/([A-Za-z0-9_]{1,25})\/?$/.exec(path);
  if (tip) return <PublicTipPage login={tip[1].toLowerCase()} signedIn={!!me} />;
  const stats = /^\/c\/([A-Za-z0-9_]{1,25})\/?$/.exec(path);
  if (stats) return <ChatStatsPage login={stats[1].toLowerCase()} signedIn={!!me} />;
  const channel = /^\/([A-Za-z0-9_]{1,25})(?:\/(leaderboard|commands))?\/?$/.exec(path);
  if (channel && !RESERVED.has(channel[1].toLowerCase())) {
    return <ChannelPage login={channel[1].toLowerCase()} tab={(channel[2] || 'profile') as ChannelTab} signedIn={!!me} />;
  }
  if (inApp) {
    if (!me) return <BootSkeleton numbers={path === '/app' || path.startsWith('/app/stats')} />;
    return (
      <ChannelProvider me={me} onSignedOut={() => { setMe(null); navigate('/', true); }}>
        <Shell path={path} />
      </ChannelProvider>
    );
  }
  return <Landing signedIn={!!me} error={error} notice={notice} notFound={path !== '/'} />;
}

/** The dashboard's frame in gray while your account loads, so the real one
 * appears in place instead of replacing a loading line. */
function BootSkeleton({ numbers }: { numbers: boolean }) {
  return (
    <div className="shell boot" role="status" aria-label="Loading your channel">
      <aside className="rail" aria-hidden="true">
        <span className="rail-brand"><img src="/logo.svg" alt="" width="32" height="32" /></span>
        <div className="rail-nav">{Array.from({ length: 9 }, (_, i) => <Skel key={i} />)}</div>
      </aside>
      <div className="frame">
        <header className="appbar"><span className="boot-menu"><Skel w={22} h={16} /></span><Skel w={140} h={16} /><Skel w={36} h={36} round /></header>
        <main className="main">
          <PageSkel kpis={numbers} />
        </main>
      </div>
    </div>
  );
}

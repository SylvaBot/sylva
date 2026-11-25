// Top level routing. "/" is the public landing page. "/app/..." is the
// dashboard, which needs a Sylva session: without one it sends you to the
// landing page, which offers Continue with Twitch.

import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { ChannelProvider } from './channel';
import { DevicePage } from './device';
import { Landing } from './Landing';
import { navigate, usePath } from './router';
import { Shell } from './Shell';
import { PrivacyPage } from './site';

const SIGNIN_ERRORS: Record<string, string> = {
  denied: 'You cancelled on Twitch, so nothing changed. Sign in when you are ready.',
  expired: 'That sign in took too long or was opened twice. Try again.',
  scopes: 'Twitch did not give Sylva every permission it needs. Try again and allow all of them.',
  failed: 'Twitch did not finish the sign in. Try again in a minute.',
};

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
    if (!inApp && path !== '/device' && path !== '/privacy') document.title = 'Sylva: alerts, overlays and activity for Twitch';
  }, [inApp, path]);

  if (path === '/device') return <DevicePage me={me} />;
  if (path === '/privacy') return <PrivacyPage signedIn={!!me} />;
  if (inApp) {
    if (!me) return <div className="loading" role="status">Loading your channel</div>;
    return (
      <ChannelProvider me={me} onSignedOut={() => { setMe(null); navigate('/', true); }}>
        <Shell path={path} />
      </ChannelProvider>
    );
  }
  return <Landing signedIn={!!me} error={error} notice={notice} notFound={path !== '/'} />;
}

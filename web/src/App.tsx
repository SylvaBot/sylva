import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { Dashboard } from './Dashboard';
import { Icon } from './ui';

// What the scopes in sylva-core's TWITCH_SCOPES are for, in the streamer's words.
const ASKS = ['See new followers', 'See new subs, resubs and gifted subs', 'See cheers', 'Read your chat'];

const SIGNIN_ERRORS: Record<string, string> = {
  denied: 'You cancelled on Twitch, so nothing changed. Sign in when you are ready.',
  expired: 'That sign in took too long or was opened twice. Try again.',
  scopes: 'Twitch did not give Sylva every permission it needs. Try again and allow all of them.',
  failed: 'Twitch did not finish the sign in. Try again in a minute.',
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const reason = params.get('signin');
    if (reason) {
      setError(SIGNIN_ERRORS[reason] || SIGNIN_ERRORS.failed);
      history.replaceState(null, '', location.pathname);
    }
    api.me()
      .then(setMe)
      .catch((x) => {
        setMe(null);
        if (!(x instanceof ApiError && x.status === 401)) setError('Sylva could not be reached. Refresh to try again.');
      });
  }, []);

  if (me === undefined) return null;
  if (me && me.channels.length) return <Dashboard me={me} onSignedOut={() => setMe(null)} />;
  return <SignIn error={error} />;
}

function SignIn({ error }: { error: string | null }) {
  return (
    <div className="overlay welcome">
      <div className="dialog">
        <img src="/logo.svg" alt="" width="40" height="40" />
        <h1>Sign in to Sylva</h1>
        <p>Alerts, your overlay and your activity feed in one calm place. Sign in with Twitch to start.</p>
        <ul className="signin-list" aria-label="What Twitch will ask you to allow">
          {ASKS.map((a) => <li key={a}><Icon id="check" />{a}</li>)}
        </ul>
        <p className="hint">Sylva does not post in your chat or change your channel.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <a className="btn primary" href="/auth/twitch/start"><Icon id="twitch" />Continue with Twitch</a>
      </div>
    </div>
  );
}

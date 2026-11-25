// /device: where a streamer approves an app, such as Cortex, that showed them
// a code. Signed out visitors sign in first and come back here.

import { useEffect, useState, type FormEvent } from 'react';
import { api, type Me } from './api';
import { Link } from './router';
import { SiteFooter } from './site';
import { errorText, Icon } from './ui';

type Step =
  | { at: 'enter' }
  | { at: 'checking' }
  | { at: 'confirm'; code: string; app: string }
  | { at: 'done'; app: string; approved: boolean };

const fromUrl = () => new URLSearchParams(location.search).get('code') || '';

export function DevicePage({ me }: { me: Me | null | undefined }) {
  const [code, setCode] = useState(fromUrl);
  const [step, setStep] = useState<Step>({ at: 'enter' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Connect an app · Sylva';
  }, []);

  const check = async (value: string) => {
    setError(null);
    setStep({ at: 'checking' });
    try {
      const r = await api.deviceLookup(value);
      setStep({ at: 'confirm', code: r.userCode, app: r.appName });
    } catch (x) {
      setError(errorText(x));
      setStep({ at: 'enter' });
    }
  };

  // A link with the code already in it goes straight to the question.
  useEffect(() => {
    if (me && fromUrl()) void check(fromUrl());
  }, [me]);

  const decide = async (approve: boolean) => {
    if (step.at !== 'confirm') return;
    setBusy(true);
    setError(null);
    try {
      await api.deviceDecide(step.code, approve);
      setStep({ at: 'done', app: step.app, approved: approve });
    } catch (x) {
      setError(errorText(x));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) void check(code);
  };

  const next = `/device${code.trim() ? `?code=${encodeURIComponent(code.trim().toUpperCase())}` : ''}`;
  const signIn = `/auth/twitch/start?next=${encodeURIComponent(next)}`;

  return (
    <div className="site">
      <header className="site-nav">
        <Link className="brand" href="/" aria-label="Sylva home">
          <img src="/logo.svg" alt="" width="26" height="26" />
          <span>Sylva</span>
        </Link>
        <span className="spacer" />
        {me && <Link className="btn" href="/app">Dashboard</Link>}
      </header>
      <main id="content" className="device wrap">
        <section className="card device-card" aria-labelledby="device-title">
          <span className="device-icon"><Icon id="monitor" /></span>
          {me === undefined && <p className="card-text">Loading</p>}

          {me === null && (
            <>
              <h1 id="device-title">Connect an app</h1>
              <p className="card-text">Sign in to Sylva first, then you can approve the app that showed you a code.</p>
              <a className="btn primary lg full" href={signIn}><Icon id="twitch" />Continue with Twitch</a>
            </>
          )}

          {me && (step.at === 'enter' || step.at === 'checking') && (
            <form onSubmit={submit} className="device-form">
              <h1 id="device-title">Connect an app</h1>
              <p className="card-text">Enter the code the app shows you.</p>
              <label className="sr-only" htmlFor="device-code">Code</label>
              <input
                id="device-code"
                className="input code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="BCDF-GHJK"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={12}
                autoFocus
              />
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="btn primary lg full" type="submit" disabled={step.at === 'checking' || !code.trim()}>
                {step.at === 'checking' ? 'Checking' : 'Continue'}
              </button>
            </form>
          )}

          {me && step.at === 'confirm' && (
            <>
              <h1 id="device-title">Allow {step.app} to use your Sylva?</h1>
              <p className="card-text">Code <b className="mono">{step.code}</b>. Only allow it if you just started signing in to {step.app}.</p>
              <ul className="signin-list" aria-label={`${step.app} will be able to`}>
                <li><Icon id="check" />See your activity, chat and alert queue</li>
                <li><Icon id="check" />Pause, mute, skip, replay and test alerts</li>
                <li><Icon id="check" />Read and change your alert and widget settings</li>
              </ul>
              <p className="field-hint">You can take this back at any time in Settings.</p>
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="device-actions">
                <button className="btn lg" type="button" disabled={busy} onClick={() => decide(false)}>Deny</button>
                <button className="btn primary lg" type="button" disabled={busy} onClick={() => decide(true)}>Allow</button>
              </div>
            </>
          )}

          {me && step.at === 'done' && (
            <>
              <h1 id="device-title">{step.approved ? `${step.app} is connected` : `${step.app} was not connected`}</h1>
              <p className="card-text">
                {step.approved
                  ? `Go back to ${step.app}. It finishes signing in on its own in a few seconds.`
                  : 'Nothing changed. You can close this page.'}
              </p>
              <Link className="btn lg full" href="/app/settings">Manage connected apps</Link>
            </>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

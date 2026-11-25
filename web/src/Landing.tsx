// The public site: what Sylva is, how to start, and Continue with Twitch.

import type { ReactNode } from 'react';
import { Link } from './router';
import { Icon } from './ui';

const START = '/auth/twitch/start';

const PREVIEW = [
  { kind: 'subscriber', icon: 'star', title: <><b>Juniper</b> resubscribed</>, pills: ['Tier 1', '6 months'], time: 'now' },
  { kind: 'cheer', icon: 'gem', title: <><b>Rowan</b> cheered 500 bits</>, msg: 'Clutch play, take my bits', time: '2m ago' },
  { kind: 'follow', icon: 'heart', title: <><b>Maple</b> followed</>, time: '4m ago' },
  { kind: 'raid', icon: 'swords', title: <><b>Hazel</b> raided with 42 viewers</>, time: '9m ago' },
  { kind: 'communityGift', icon: 'gift', title: <><b>Aspen</b> gifted 5 subs</>, pills: ['Tier 1'], time: '12m ago' },
];

const FEATURES = [
  { icon: 'bell', c: 'c-sub', title: 'Alerts that just work', text: 'Follows, subs, gifts, cheers and raids play on stream one at a time, in order, and never twice. Pause, mute, skip or replay from the dashboard.' },
  { icon: 'activity', c: 'c-follow', title: 'Every event in one feed', text: 'One color per kind of event, a 24 hour summary, filters and search, with history going back as far as you streamed with Sylva.' },
  { icon: 'monitor', c: 'c-bits', title: 'One link for OBS', text: 'Add a single Browser Source. If a link leaks, make a new one and the old one stops working at once.' },
  { icon: 'message', c: 'c-raid', title: 'Chat beside it', text: 'Read chat live next to your alerts and activity, without another window open.' },
  { icon: 'zap', c: 'c-reward', title: 'Live, not polled', text: 'Events arrive from Twitch in about a second and reach every open dashboard and overlay at the same time.' },
  { icon: 'shield', c: 'c-gift', title: 'Private by default', text: 'Your overlay link only shows alerts, your activity and chat are only visible to you, and Twitch tokens are stored encrypted.' },
];

export function Landing({ signedIn, error, notFound }: { signedIn: boolean; error: string | null; notFound: boolean }) {
  const cta = signedIn
    ? <Link className="btn primary lg" href="/app">Open dashboard<Icon id="arrow" /></Link>
    : <a className="btn primary lg" href={START}><Icon id="twitch" />Continue with Twitch</a>;

  return (
    <div className="site">
      <header className="site-nav">
        <Link className="brand" href="/" aria-label="Sylva home">
          <img src="/logo.svg" alt="" width="26" height="26" />
          <span>Sylva</span>
        </Link>
        {!notFound && (
          <nav className="site-links" aria-label="Sections">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
          </nav>
        )}
        <span className="spacer" />
        {signedIn
          ? <Link className="btn primary" href="/app">Open dashboard</Link>
          : <><a className="btn ghost" href={START}>Sign in</a><a className="btn primary" href={START}>Get started</a></>}
      </header>

      <main id="content">
        {notFound ? (
          <section className="not-found wrap">
            <h1>Page not found</h1>
            <p>That page does not exist. It may have moved.</p>
            <Link className="btn primary" href={signedIn ? '/app' : '/'}>{signedIn ? 'Go to your dashboard' : 'Go to the home page'}</Link>
          </section>
        ) : (
          <>
            <section className="hero wrap">
              <div>
                <span className="eyebrow"><span className="dot" />For Twitch streamers</span>
                <h1>Your alerts and activity, <em>in one calm place.</em></h1>
                <p className="lede">
                  Sylva puts your follows, subs, cheers and raids on stream as alerts, keeps every one in a live
                  feed, and shows your chat beside it. Sign in with Twitch and it is ready in under a minute.
                </p>
                <div className="hero-cta">{cta}</div>
                {error && <p className="signin-error" role="alert">{error}</p>}
                <p className="hero-note">Sylva does not post in your chat or change anything on your channel.</p>
              </div>
              <Preview />
            </section>

            <section className="section wrap" id="features" aria-labelledby="features-title">
              <div className="section-head">
                <h2 id="features-title">Everything your stream needs to react to its viewers</h2>
                <p>Built around one idea: you should see what happened, and your viewers should see you notice it.</p>
              </div>
              <div className="features">
                {FEATURES.map((f) => (
                  <article key={f.title} className={'feature ' + f.c}>
                    <span className="tile"><Icon id={f.icon} /></span>
                    <h3>{f.title}</h3>
                    <p>{f.text}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="section wrap" id="how" aria-labelledby="how-title">
              <div className="section-head">
                <h2 id="how-title">Three steps, then you are live</h2>
                <p>No downloads and nothing to install.</p>
              </div>
              <ol className="how">
                <Step title="Sign in with Twitch">Sylva asks Twitch for the least it needs: to see followers, subs, cheers and chat.</Step>
                <Step title="Add your overlay to OBS">Copy your overlay link and add it as a Browser Source at 1920 by 1080.</Step>
                <Step title="Go live">Alerts play on stream, and the dashboard shows everything as it happens.</Step>
              </ol>
            </section>

            <section className="cta-band" aria-labelledby="cta-title">
              <h2 id="cta-title">Ready when you are</h2>
              <p>Set up your alerts and overlay in a minute, and keep your whole stream in view.</p>
              {cta}
            </section>
          </>
        )}
      </main>

      <footer className="site-footer">
        <span>© {new Date().getFullYear()} Sylva</span>
        <span>Not affiliated with Twitch.</span>
      </footer>
    </div>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

function Preview() {
  return (
    <div className="preview" aria-hidden="true">
      <div className="preview-bar"><span /><span /><span /></div>
      <ol className="feed">
        {PREVIEW.map((p) => (
          <li key={p.time} className={'item k-' + p.kind}>
            <span className="tile"><Icon id={p.icon} /></span>
            <div className="item-main">
              <div className="item-title">{p.title}</div>
              {p.msg && <p className="item-msg">{p.msg}</p>}
              {p.pills && <div className="pills">{p.pills.map((x) => <span key={x} className="pill">{x}</span>)}</div>}
            </div>
            <div className="item-side"><time>{p.time}</time></div>
          </li>
        ))}
      </ol>
      <div className="preview-alert">
        <div className="label">New subscriber</div>
        <div className="name">Juniper</div>
        <div className="detail">6 months, Tier 1</div>
      </div>
    </div>
  );
}

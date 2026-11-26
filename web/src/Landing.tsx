// The public site: what Sylva is, how to start, and Continue with Twitch.

import type { ReactNode } from 'react';
import { Link } from './router';
import { SiteFooter } from './site';
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
  { icon: 'layers', c: 'c-bits', title: 'An overlay editor', text: 'Place alerts, event lists, labels, a goal bar and chat on one 1920 by 1080 canvas, publish it to one OBS link, and roll back any time.' },
  { icon: 'code', c: 'c-raid', title: 'Your own widgets', text: 'Write plain HTML, CSS and JavaScript with a live preview. Each widget runs in a sandbox, and StreamElements custom widgets paste straight in.' },
  { icon: 'bot', c: 'c-follow', title: 'A chat bot with the usual commands', text: 'Custom commands, timers, counters, quotes, !followage, !uptime, !clip, !settitle and the rest, with levels and cooldowns you set.' },
  { icon: 'shield', c: 'c-gift', title: 'Moderation that keeps up', text: 'Rules for links, caps, symbols, emotes and banned words with steps that escalate, a !nuke for raids of spam, and a log where you can undo.' },
  { icon: 'gem', c: 'c-reward', title: 'Points, games and rewards', text: 'Viewers earn points for watching and supporting, play !gamble, !slots, !blackjack and !duel, enter raffles, and spend points in your store.' },
  { icon: 'trophy', c: 'c-tip', title: 'Giveaways anyone can check', text: 'Keyword entry, subscriber luck and a winner drawn from a seed committed before the draw, so viewers can see it was fair.' },
  { icon: 'activity', c: 'c-follow', title: 'Every event in one feed', text: 'One color per kind of event, a 24 hour summary, filters and search, and your chat beside it, live in about a second.' },
  { icon: 'users', c: 'c-sub', title: 'Your team, your keys', text: 'Give editors and moderators their own access, replace a leaked overlay link at once, and know your Twitch tokens are stored encrypted.' },
];

const MOVING = [
  'Your commands and their levels and cooldowns',
  'Your timers, one per message',
  'Your top 1,000 viewers\u2019 points',
];

export function Landing({ signedIn, error, notice, notFound }: {
  signedIn: boolean; error: string | null; notice: string | null; notFound: boolean;
}) {
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
            <a href="#moving">Switching</a>
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
                <h1>Your whole stream, <em>in one calm place.</em></h1>
                <p className="lede">
                  Alerts and an overlay editor, a chat bot, moderation, loyalty points with games and a store, and
                  giveaways, all in one dashboard that updates live. Sign in with Twitch and it is ready in a minute.
                </p>
                <div className="hero-cta">{cta}</div>
                {error && <p className="signin-error" role="alert">{error}</p>}
                {notice && <p className="site-notice" role="status">{notice}</p>}
                <p className="hero-note">Free while in beta. Every feature is off until you turn it on.</p>
              </div>
              <Preview />
            </section>

            <section className="section wrap" id="features" aria-labelledby="features-title">
              <div className="section-head">
                <h2 id="features-title">Everything a stream needs, without five different tools</h2>
                <p>One sign in, one overlay link and one dashboard, built to be fast on stream and calm to use.</p>
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
                <Step title="Sign in with Twitch">Sylva asks Twitch for the least it needs, and asks again only for the extras you turn on.</Step>
                <Step title="Add your overlay to OBS">Copy your overlay link and add it as one Browser Source at 1920 by 1080.</Step>
                <Step title="Go live">Alerts play on stream, the bot answers in chat, and the dashboard shows everything as it happens.</Step>
              </ol>
            </section>

            <section className="section wrap" id="moving" aria-labelledby="moving-title">
              <div className="section-head">
                <h2 id="moving-title">Coming from StreamElements?</h2>
                <p>Bring your setup with you in one step from Settings. Your StreamElements token is used once and never kept.</p>
              </div>
              <ul className="moving">
                {MOVING.map((m) => <li key={m}><Icon id="check" />{m}</li>)}
              </ul>
            </section>

            <section className="cta-band" aria-labelledby="cta-title">
              <h2 id="cta-title">Ready when you are</h2>
              <p>Set up your alerts, overlay and bot in a few minutes, and keep your whole stream in view.</p>
              {cta}
            </section>
          </>
        )}
      </main>

      <SiteFooter />
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

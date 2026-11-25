// Pieces shared by the public pages (home, /device, /privacy), and the
// privacy page itself.

import { useEffect, type ReactNode } from 'react';
import { Link } from './router';

export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="site-nav">
      <Link className="brand" href="/" aria-label="Sylva home">
        <img src="/logo.svg" alt="" width="26" height="26" />
        <span>Sylva</span>
      </Link>
      {children}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>© {new Date().getFullYear()} Sylva</span>
      <nav className="footer-links" aria-label="About Sylva">
        <Link href="/privacy">Privacy</Link>
        <span>Not affiliated with Twitch.</span>
      </nav>
    </footer>
  );
}

const UPDATED = '25 November 2026';

export function PrivacyPage({ signedIn }: { signedIn: boolean }) {
  useEffect(() => {
    document.title = 'Privacy · Sylva';
  }, []);

  return (
    <div className="site">
      <SiteHeader>
        <span className="spacer" />
        {signedIn
          ? <Link className="btn primary" href="/app">Open dashboard</Link>
          : <Link className="btn" href="/">Home</Link>}
      </SiteHeader>
      <main id="content" className="prose wrap">
        <h1>Privacy</h1>
        <p className="prose-lede">
          What Sylva keeps, why, and how to delete it. In short: only what it needs to run your alerts and
          dashboard, never sold or shared for advertising, and gone the moment you delete your account.
        </p>
        <p className="prose-meta">Last updated {UPDATED}.</p>

        <h2>What Sylva keeps</h2>
        <ul>
          <li><b>Your Twitch account:</b> its id, name, display name and profile picture address.</li>
          <li>
            <b>Your Twitch sign in:</b> the access and refresh tokens Twitch gives Sylva, encrypted before
            they are stored. Sylva uses them only to receive your channel's events and chat.
          </li>
          <li>
            <b>Moderation permission, if you allow it:</b> a second pair of Twitch tokens that may remove
            messages and time out chatters, encrypted the same way and used only for the moderation rules you turn on.
          </li>
          <li>
            <b>Chat list permission, if you allow it:</b> a Twitch token that may read who is in your chat,
            encrypted the same way and used only to pay loyalty points to viewers who watch without chatting.
          </li>
          <li>
            <b>Your channel's activity:</b> follows, subs, gifted subs, cheers, raids, chat messages, and
            when your stream starts, ends or changes title, with the viewer names Twitch sends. This is your
            Activity feed and history.
          </li>
          <li><b>Your settings:</b> alert settings, your goal, your overlay layouts, whether alerts are paused or muted, and your overlay link.</li>
          <li><b>Your chat bot:</b> its commands, timers, counters and quotes, how often each command was used, and when each was last used, for cooldowns.</li>
          <li>
            <b>Moderation:</b> your rules and word lists, and a log of the last 500 actions with the message
            that broke a rule and who sent it. Strikes against a chatter are forgotten after an hour.
          </li>
          <li>
            <b>Loyalty points, if you turn them on:</b> for each viewer who earns them, their Twitch id, name,
            balance and total earned, and a history of why their balance changed (the newest 20,000 changes in your channel).
          </li>
          <li>
            <b>Your points store, if you open it:</b> your rewards, and each redemption with the viewer's name,
            what they wrote with it and whether it is done (every waiting one, and the newest 5,000 others).
            Your public points page at <code>/s/</code> and your Twitch name shows your rewards and the ten viewers
            with the most points, and lets anyone look up a viewer's points, as <code>!points</code> does in chat.
          </li>
          <li>
            <b>Giveaways, if you run them:</b> each giveaway's prize, settings, seed and winners, and each entry
            with the viewer's Twitch id, name and tickets (your last 50 giveaways).
          </li>
          <li>
            <b>Your team, if you add one:</b> each teammate's Twitch id, name and picture, their role, and when they
            were added. Each teammate's account keeps your channel's name and their role, so they can open it.
          </li>
          <li>
            <b>Sign ins:</b> for each browser session and each connected app (such as Cortex), a one way hash
            of its secret, when it was made and when an app was last used. Sylva cannot recover the secret from it.
          </li>
        </ul>

        <h2>What Sylva does not do</h2>
        <ul>
          <li>It posts in your chat only when you turn on the chat bot (to answer your commands, counters and quotes, and to post your timers) or moderation notices, and it removes messages or times out chatters only under moderation rules you turn on. It does not change anything else on your channel.</li>
          <li>It does not sell your data, show ads, or share data with anyone for advertising.</li>
          <li>It has no analytics or tracking scripts, and loads nothing from other sites except Twitch profile pictures.</li>
        </ul>

        <h2>Cookies and browser storage</h2>
        <p>
          Sylva sets one cookie to keep you signed in (<code>sylva_session</code>, for up to 30 days) and two
          short lived cookies while you sign in with Twitch, which protect the sign in and remember the page to
          return to. Your theme, your Activity filters and which setup steps you finished are kept in this
          browser's storage.
          None of these are used for tracking.
        </p>

        <h2>Who can see what</h2>
        <ul>
          <li>Your activity, chat and settings are visible only to you when signed in, and to apps you connected.</li>
          <li>Anyone with your overlay link sees what it puts on stream (alerts and the widgets you add), nothing else. You can replace the link at any time on the Overlay page.</li>
        </ul>

        <h2>Where it is stored</h2>
        <p>
          Sylva runs on Cloudflare Workers. Your data is stored with Cloudflare Durable Objects, and is
          encrypted in transit and at rest by Cloudflare. Twitch tokens are also encrypted by Sylva itself.
        </p>

        <h2>How long it is kept</h2>
        <p>
          Until you delete your account. Sign in sessions end after 30 days, and unused connection codes for
          apps after 10 minutes.
        </p>

        <h2>Deleting your data</h2>
        <p>
          In <Link href="/app/settings">Settings</Link>, choose <b>Delete account</b>. Sylva then asks Twitch to
          stop sending your channel's events, deletes your account, activity, chat history, settings, overlay
          links and connected apps at once, and tells Twitch to forget its sign in. This cannot be undone. You can
          also remove Sylva's access on Twitch under Settings, Connections.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about your data: <span className="placeholder">[contact email to be added]</span>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

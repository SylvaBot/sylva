// A channel's public pages. /{login} is the profile with Leaderboard and
// Commands tabs; /c/{login} is the chat stats page that !chatstats links to.

import { useEffect, useState, type ReactNode } from 'react';
import { api, type ChatEmote, type ChatStats, type PublicCommands, type PublicProfile, type PublicStore } from './api';
import { CommandsBody } from './commandsPage';
import { Link } from './router';
import { SiteFooter, SiteHeader } from './site';
import { Avatar, Icon, num, SkelRows } from './ui';

type Load<T> = T | null | 'missing' | 'failed';

function useLoad<T>(run: () => Promise<T>, deps: unknown[]): Load<T> {
  const [data, setData] = useState<Load<T>>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    run()
      .then((d) => live && setData(d))
      .catch((x) => live && setData(x?.status === 404 ? 'missing' : 'failed'));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return data;
}

function Frame({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  return (
    <div className="site">
      <SiteHeader>
        <span className="spacer" />
        {signedIn ? <Link className="btn" href="/app">Open dashboard</Link> : <Link className="btn" href="/">What is Sylva?</Link>}
      </SiteHeader>
      {children}
      <SiteFooter />
    </div>
  );
}

function Missing({ login, failed }: { login: string; failed: boolean }) {
  return (
    <main id="content" className="prose wrap">
      <h1>{failed ? 'Something went wrong' : 'No channel here'}</h1>
      <p className="prose-lede">
        {failed ? 'Sylva could not be reached. Refresh to try again.' : `${login} does not use Sylva, or the link is mistyped.`}
      </p>
    </main>
  );
}

/** The banner, picture and name at the top of both pages. */
function Hero({ login, name, avatar, banner, live, children }: {
  login: string; name: string; avatar: string; banner: string; live?: boolean; children?: ReactNode;
}) {
  const bg = banner.startsWith('https://') ? { backgroundImage: `url("${banner}")` } : undefined;
  return (
    <header className="ch-hero">
      <div className={bg ? 'ch-banner' : 'ch-banner empty'} style={bg} />
      <div className="ch-id">
        <Avatar name={name} url={avatar} large />
        <div className="ch-name">
          <h1>{name}</h1>
          <p>
            <a href={`https://twitch.tv/${login}`} target="_blank" rel="noreferrer">twitch.tv/{login}</a>
            {live && <span className="ch-live">Live now</span>}
          </p>
        </div>
        {children && <div className="ch-actions">{children}</div>}
      </div>
    </header>
  );
}

const TABS = [
  { id: 'profile', label: 'Profile', path: '' },
  { id: 'leaderboard', label: 'Leaderboard', path: '/leaderboard' },
  { id: 'commands', label: 'Commands', path: '/commands' },
] as const;
export type ChannelTab = (typeof TABS)[number]['id'];

/** /{login}, /{login}/leaderboard and /{login}/commands. */
export function ChannelPage({ login, tab, signedIn }: { login: string; tab: ChannelTab; signedIn: boolean }) {
  const profile = useLoad(() => api.publicProfile(login), [login]);

  useEffect(() => {
    const who = typeof profile === 'object' && profile ? profile.name : login;
    const what = tab === 'profile' ? '' : tab === 'leaderboard' ? ' leaderboard' : ' chat commands';
    document.title = `${who}${what} · Sylva`;
  }, [profile, login, tab]);

  if (profile === 'missing' || profile === 'failed') {
    return <Frame signedIn={signedIn}><Missing login={login} failed={profile === 'failed'} /></Frame>;
  }
  if (!profile) {
    return <Frame signedIn={signedIn}><main id="content" className="wrap pub"><SkelRows n={5} /></main></Frame>;
  }
  const p = profile;
  return (
    <Frame signedIn={signedIn}>
      <main id="content" className="wrap ch">
        <Hero login={p.login} name={p.name} avatar={p.avatar} banner={p.banner} live={p.live}>
          {p.tips && <Link className="btn primary lg" href={`/tip/${p.login}`}>Tip {p.name}</Link>}
          <Link className="btn lg" href={`/c/${p.login}`}><Icon id="chart" />Chat Stats</Link>
        </Hero>
        <nav className="ch-tabs" aria-label={`${p.name}’s pages`}>
          {TABS.map((t) => (
            <Link key={t.id} href={`/${p.login}${t.path}`} current={t.id === tab}>{t.label}</Link>
          ))}
        </nav>
        {tab === 'profile' && <ProfileTab p={p} />}
        {tab === 'leaderboard' && <LeaderboardTab p={p} />}
        {tab === 'commands' && <CommandsTab p={p} />}
      </main>
    </Frame>
  );
}

function ProfileTab({ p }: { p: PublicProfile }) {
  const stats = useLoad(() => api.chatStats(p.login), [p.login]);
  const s = typeof stats === 'object' ? stats : null;
  return (
    <div className="ch-profile">
      <section className="card ch-about" aria-labelledby="ch-about">
        <div className="card-head"><div><h2 id="ch-about">About</h2></div></div>
        <p className="ch-bio">{p.description || `${p.name} has not written a Twitch bio yet.`}</p>
        <p className="ch-bio">
          <a className="btn" href={`https://twitch.tv/${p.login}`} target="_blank" rel="noreferrer"><Icon id="twitch" />Watch on Twitch</a>
        </p>
      </section>
      <section className="card" aria-labelledby="ch-chat">
        <div className="card-head">
          <div><h2 id="ch-chat">In chat</h2><p>The people who talk the most.</p></div>
          <Link className="btn sm" href={`/c/${p.login}`}>All chat stats</Link>
        </div>
        {stats === null
          ? <SkelRows n={3} tile={false} />
          : !s || s.total === 0
            ? <p className="empty">Sylva starts counting with the next message in {p.name}’s chat.</p>
            : <>
                <p className="ch-sum"><b>{num(s.total)}</b> messages so far</p>
                <Ranked rows={s.chatters.slice(0, 5).map((c) => ({ key: c.login, label: c.name, value: c.messages }))} />
              </>}
      </section>
    </div>
  );
}

function LeaderboardTab({ p }: { p: PublicProfile }) {
  const store = useLoad<PublicStore | null>(() => (p.points ? api.publicStore(p.login) : Promise.resolve(null)), [p.login, p.points]);
  if (!p.points) {
    return <section className="card"><p className="empty">{p.name} has not turned on loyalty points, so there is no leaderboard yet.</p></section>;
  }
  if (store === null) return <section className="card"><SkelRows n={5} tile={false} /></section>;
  if (store === 'missing' || store === 'failed') {
    return <section className="card"><p className="empty">The leaderboard could not be loaded. Refresh to try again.</p></section>;
  }
  const pts = store.pointsName;
  return (
    <section className="card" aria-labelledby="ch-top">
      <div className="card-head">
        <div><h2 id="ch-top">Top {pts}</h2><p>Earned by watching and chatting while {p.name} is live. Type <code>!{pts.replace(/ /g, '')}</code> in chat to see yours.</p></div>
        <Link className="btn sm" href={`/s/${p.login}`}>Rewards</Link>
      </div>
      {store.top.length === 0
        ? <p className="empty">Nobody has any {pts} yet.</p>
        : <Ranked rows={store.top.map((v) => ({ key: String(v.rank), label: v.name, value: v.balance }))} />}
    </section>
  );
}

function CommandsTab({ p }: { p: PublicProfile }) {
  const data = useLoad<PublicCommands | null>(() => (p.bot ? api.publicCommands(p.login) : Promise.resolve(null)), [p.login, p.bot]);
  if (!p.bot) return <section className="card"><p className="empty">{p.name} does not have Sylva’s chat bot turned on.</p></section>;
  if (data === null) return <section className="card"><SkelRows n={5} tile={false} /></section>;
  if (data === 'missing' || data === 'failed') {
    return <section className="card"><p className="empty">The commands could not be loaded. Refresh to try again.</p></section>;
  }
  return <CommandsBody data={data} />;
}

/** A ranked list with a bar sized against the first row. */
function Ranked({ rows, unit }: { rows: { key: string; label: ReactNode; value: number; img?: string }[]; unit?: string }) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="ch-rank">
      {rows.map((r, i) => (
        <li key={r.key}>
          <span className="ch-n">{i + 1}</span>
          {r.img && <img className="ch-emote" src={r.img} alt="" loading="lazy" referrerPolicy="no-referrer" />}
          <span className="ch-label">{r.label}</span>
          <span className="ch-val">{num(r.value)}{unit && <span className="sr-only"> {unit}</span>}</span>
          <span className="ch-bar" style={{ width: `${(r.value / top) * 100}%` }} aria-hidden="true" />
        </li>
      ))}
    </ol>
  );
}

const EMOTES: { id: keyof ChatStats['emotes']; label: string }[] = [
  { id: 'twitch', label: 'Top Twitch emotes' },
  { id: '7tv', label: 'Top 7TV emotes' },
  { id: 'bttv', label: 'Top BTTV emotes' },
  { id: 'ffz', label: 'Top FFZ emotes' },
];

function rate(n: number | null): string {
  if (n === null) return '-';
  if (n >= 10) return n.toFixed(0);
  if (n >= 0.1) return n.toFixed(2);
  return n.toFixed(3);
}

function List({ id, title, empty, children }: { id: string; title: string; empty: boolean; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-head"><div><h2 id={id}>{title}</h2></div></div>
      {empty ? <p className="empty">None counted yet.</p> : children}
    </section>
  );
}

/** /c/{login}: the chat stats page. */
export function ChatStatsPage({ login, signedIn }: { login: string; signedIn: boolean }) {
  const data = useLoad(() => api.chatStats(login), [login]);

  useEffect(() => {
    document.title = `${typeof data === 'object' && data ? data.channel.name : login} chat stats · Sylva`;
  }, [data, login]);

  if (data === 'missing' || data === 'failed') {
    return <Frame signedIn={signedIn}><Missing login={login} failed={data === 'failed'} /></Frame>;
  }
  if (!data) {
    return <Frame signedIn={signedIn}><main id="content" className="wrap pub"><SkelRows n={6} /></main></Frame>;
  }
  const c = data.channel;
  const since = data.since ? new Date(data.since).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const emoteRows = (list: ChatEmote[]) => list.map((e) => ({ key: e.id, label: e.name, value: e.uses, img: e.url }));
  return (
    <Frame signedIn={signedIn}>
      <main id="content" className="wrap ch">
        <Hero login={c.login} name={c.name} avatar={c.avatar} banner={c.banner} live={data.live}>
          <Link className="btn lg" href={`/${c.login}`}>Profile</Link>
        </Hero>

        <section className="ch-totals" aria-label="Chat totals">
          <div>
            <b className="ch-big">{num(data.total)}</b>
            <span>messages sent in {c.name}’s chat</span>
          </div>
          <div>
            <b className="ch-big">{rate(data.perSecond)}</b>
            <span>messages per second while live</span>
          </div>
        </section>
        <p className="ch-note">
          {since ? `Counted since ${since}. ` : 'Sylva starts counting with the next chat message. '}
          The bot’s own messages and removed messages are left out.
        </p>

        <div className="ch-stats">
          <List id="cs-chatters" title="Top chatters" empty={data.chatters.length === 0}>
            <Ranked unit="messages" rows={data.chatters.map((x) => ({ key: x.login, label: x.name, value: x.messages }))} />
          </List>
          <div className="ch-side">
            {EMOTES.map((e) => (
              <List key={e.id} id={`cs-${e.id}`} title={e.label} empty={data.emotes[e.id].length === 0}>
                <Ranked unit="uses" rows={emoteRows(data.emotes[e.id])} />
              </List>
            ))}
            <List id="cs-commands" title="Top commands" empty={data.commands.length === 0}>
              <Ranked unit="uses" rows={data.commands.map((x) => ({ key: x.name, label: <code>!{x.name}</code>, value: x.uses }))} />
            </List>
          </div>
        </div>
      </main>
    </Frame>
  );
}

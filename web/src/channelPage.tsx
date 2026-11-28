// A channel's public pages. /{login} is the profile with Leaderboard and
// Commands tabs; /c/{login} is the chat stats page that !chatstats links to.

import { useEffect, useState, type ReactNode } from 'react';
import { api, type ChatEmote, type ChatStats, type PublicCommands, type PublicProfile, type PublicSongs, type PublicStore } from './api';
import { clock, SONG_WHO, usePosition } from './songs';
import { CommandsBody } from './commandsPage';
import { Link, navigate } from './router';
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

function Frame({ signedIn, stats, children }: { signedIn: boolean; stats?: boolean; children: ReactNode }) {
  return (
    <div className="site">
      <SiteHeader>
        {stats && <Link className="ch-section" href="/c">Chat stats</Link>}
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
  { id: 'songs', label: 'Song requests', path: '/songs' },
] as const;
export type ChannelTab = (typeof TABS)[number]['id'];

/** /{login}, /{login}/leaderboard and /{login}/commands. */
export function ChannelPage({ login, tab, signedIn }: { login: string; tab: ChannelTab; signedIn: boolean }) {
  const profile = useLoad(() => api.publicProfile(login), [login]);

  useEffect(() => {
    const who = typeof profile === 'object' && profile ? profile.name : login;
    const what = tab === 'profile' ? '' : tab === 'leaderboard' ? ' leaderboard' : tab === 'songs' ? ' song requests' : ' chat commands';
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
        {tab === 'songs' && <SongsTab p={p} />}
      </main>
    </Frame>
  );
}

function ProfileTab({ p }: { p: PublicProfile }) {
  return (
    <div className="ch-profile">
      <section className="card ch-about" aria-labelledby="ch-about">
        <div className="card-head"><div><h2 id="ch-about">About</h2></div></div>
        <p className="ch-bio">{p.description || `${p.name} has not written a Twitch bio yet.`}</p>
        <p className="ch-bio">
          <a className="btn" href={`https://twitch.tv/${p.login}`} target="_blank" rel="noreferrer"><Icon id="twitch" />Watch on Twitch</a>
        </p>
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

function SongsTab({ p }: { p: PublicProfile }) {
  const [data, setData] = useState<Load<PublicSongs>>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.publicSongs(p.login).then((d) => live && setData(d)).catch(() => live && setData((d) => (typeof d === 'object' && d ? d : 'failed')));
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 10_000);
    return () => { live = false; clearInterval(t); };
  }, [p.login]);
  const d = typeof data === 'object' && data ? data : null;
  const pos = usePosition(d?.positionMs ?? 0, d?.at ?? 0, !!d?.playing);
  if (data === null) return <section className="card"><SkelRows n={5} tile={false} /></section>;
  if (!d) return <section className="card"><p className="empty">The song queue could not be loaded. Refresh to try again.</p></section>;
  const who = SONG_WHO.find((w) => w.id === d.who)?.label.toLowerCase() ?? 'everyone';
  return (
    <div className="stack">
      <section className="card ch-songs-now" aria-labelledby="songs-now">
        <div className="card-head"><div><h2 id="songs-now">Now playing</h2>
          <p>{d.enabled ? `Type !sr and a YouTube link or song name in ${p.name}’s chat. Open to ${who}.` : `${p.name} is not taking song requests right now.`}</p></div></div>
        {d.current ? (
          <div className="card-body sr-pub-now">
            <a className="t1 sr-title" href={`https://youtu.be/${d.current.videoId}`} target="_blank" rel="noreferrer">{d.current.title}</a>
            <div className="t2">{d.current.author} · asked by {d.current.by}</div>
            <div className="sr-time">
              <span className="mono">{clock(Math.min(pos / 1000, d.current.durationS))}</span>
              <span className="sr-bar" aria-hidden="true"><span style={{ width: `${d.current.durationS ? Math.min(100, pos / 10 / d.current.durationS) : 0}%` }} /></span>
              <span className="mono">{clock(d.current.durationS)}</span>
            </div>
          </div>
        ) : <p className="empty">Nothing is playing.</p>}
      </section>
      <section className="card" aria-labelledby="songs-next">
        <div className="card-head"><div><h2 id="songs-next">Up next</h2></div></div>
        {d.queue.length === 0 ? <p className="empty">The queue is empty.</p> : (
          <ol className="ch-queue">
            {d.queue.map((s, i) => (
              <li key={s.videoId + i}>
                <span className="ch-label"><span className="t1">{s.title}</span><span className="t2">{s.by}</span></span>
                <span className="mono faint">{clock(s.durationS)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
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

/** The streamers on Sylva whose chats sent the most messages. */
function TopStreamers({ limit, current }: { limit: number; current?: string }) {
  const top = useLoad(() => api.chatTop(), []);
  const rows = typeof top === 'object' && top ? top.slice(0, limit) : [];
  return (
    <section className="card ch-top" aria-labelledby="cs-top">
      <div className="card-head"><div><h2 id="cs-top">Top streamers on Sylva</h2><p>By messages sent in their chat.</p></div></div>
      {top === null
        ? <SkelRows n={4} tile={false} />
        : rows.length === 0
          ? <p className="empty">{top === 'failed' || top === 'missing' ? 'The list could not be loaded. Refresh to try again.' : 'No channel has chat stats yet.'}</p>
          : <Ranked unit="messages" rows={rows.map((r) => ({
              key: r.login,
              label: (
                <Link className={r.login === current ? 'ch-who on' : 'ch-who'} href={`/c/${r.login}`}>
                  <Avatar name={r.name} url={r.avatar} />{r.name}
                </Link>
              ),
              value: r.total,
            }))} />}
    </section>
  );
}

/** /c: chat stats home, with a search and the top streamers on Sylva. */
export function ChatStatsHome({ signedIn }: { signedIn: boolean }) {
  const [q, setQ] = useState('');
  useEffect(() => { document.title = 'Chat stats · Sylva'; }, []);
  const go = () => {
    const login = q.trim().replace(/^@/, '').toLowerCase();
    if (/^[a-z0-9_]{1,25}$/.test(login)) navigate(`/c/${login}`);
  };
  return (
    <Frame signedIn={signedIn} stats>
      <main id="content" className="wrap ch">
        <div className="pub-head">
          <h1 className="ch-title">Chat stats</h1>
          <p className="prose-lede">Messages, top chatters, emotes and commands for every channel on Sylva.</p>
          <form className="pub-look" onSubmit={(e) => { e.preventDefault(); go(); }}>
            <label className="sr-only" htmlFor="cs-q">Twitch channel</label>
            <input id="cs-q" className="input" placeholder="Twitch channel" maxLength={26} value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn primary" type="submit" disabled={!q.trim()}>See stats</button>
          </form>
        </div>
        <TopStreamers limit={50} />
      </main>
    </Frame>
  );
}

/** /c/{login}: the chat stats page. */
export function ChatStatsPage({ login, signedIn }: { login: string; signedIn: boolean }) {
  const data = useLoad(() => api.chatStats(login), [login]);

  useEffect(() => {
    document.title = `${typeof data === 'object' && data ? data.channel.name : login} chat stats · Sylva`;
  }, [data, login]);

  if (data === 'missing' || data === 'failed') {
    return <Frame signedIn={signedIn} stats><Missing login={login} failed={data === 'failed'} /></Frame>;
  }
  if (!data) {
    return <Frame signedIn={signedIn} stats><main id="content" className="wrap pub"><SkelRows n={6} /></main></Frame>;
  }
  const c = data.channel;
  const since = data.since ? new Date(data.since).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const emoteRows = (list: ChatEmote[]) => list.map((e) => ({ key: e.id, label: e.name, value: e.uses, img: e.url }));
  return (
    <Frame signedIn={signedIn} stats>
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
          {data.imported
            ? `Includes ${num(data.imported.messages)} messages from ${num(data.imported.chatters)} chatters counted by StreamElements, then Sylva’s own count${since ? ` since ${since}` : ''}. `
            : since ? `Counted since ${since}. ` : 'Sylva starts counting with the next chat message. '}
          Chat bots, test events and removed messages are left out.
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
            <List id="cs-hashtags" title="Top hashtags" empty={data.hashtags.length === 0}>
              <Ranked unit="uses" rows={data.hashtags.map((x) => ({ key: x.name, label: `#${x.name}`, value: x.uses }))} />
            </List>
          </div>
        </div>
        <TopStreamers limit={10} current={c.login} />
      </main>
    </Frame>
  );
}

// The public page at /c/{login}: every chat command a channel's bot answers.
// The bot's !commands links here.

import { useEffect, useMemo, useState } from 'react';
import { api, type PublicCommand, type PublicCommands, type UserLevel } from './api';
import { Link } from './router';
import { SiteFooter, SiteHeader } from './site';
import { num, SkelRows } from './ui';

const WHO: Record<UserLevel, string> = {
  everyone: 'Everyone',
  subscriber: 'Subscribers and up',
  vip: 'VIPs and up',
  moderator: 'Moderators',
  broadcaster: 'Only the streamer',
};

function wait(s: number): string {
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return m >= 60 ? '1 hour' : `${m} minute${m === 1 ? '' : 's'}`;
}

function Row({ c }: { c: PublicCommand }) {
  const tags = [
    c.level !== 'everyone' ? WHO[c.level] : null,
    c.builtin && c.usage !== `!${c.name}` ? c.usage : null,
    c.cooldown ? `Once every ${wait(c.cooldown)}` : null,
  ].filter(Boolean) as string[];
  return (
    <li>
      <code className="pub-cmd">!{c.name}</code>
      <div className="pub-item">
        {c.aliases.length > 0 && <span className="pub-tags">Also {c.aliases.map((a) => '!' + a).join(', ')}</span>}
        <span className="pub-text">{c.text}</span>
        {tags.length > 0 && <span className="pub-tags">{tags.join(' · ')}</span>}
      </div>
    </li>
  );
}

export function PublicCommandsPage({ login, signedIn }: { login: string; signedIn: boolean }) {
  const [data, setData] = useState<PublicCommands | null | 'missing' | 'failed'>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    api.publicCommands(login)
      .then((d) => { setData(d); document.title = `${d.channel}’s chat commands · Sylva`; })
      .catch((x) => { setData(x?.status === 404 ? 'missing' : 'failed'); document.title = 'Chat commands · Sylva'; });
  }, [login]);

  const shown = useMemo(() => {
    if (typeof data !== 'object' || !data) return [];
    const w = q.trim().toLowerCase().replace(/^!/, '');
    return data.commands
      .filter((c) => !w || c.name.includes(w) || c.aliases.some((a) => a.includes(w)) || c.text.toLowerCase().includes(w))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, q]);

  const header = (
    <SiteHeader>
      <span className="spacer" />
      {signedIn ? <Link className="btn" href="/app">Open dashboard</Link> : <Link className="btn" href="/">What is Sylva?</Link>}
    </SiteHeader>
  );

  if (data === null || data === 'missing' || data === 'failed') {
    return (
      <div className="site">
        {header}
        <main id="content" className="prose wrap">
          {data === null
            ? <SkelRows n={5} tile={false} />
            : <>
                <h1>{data === 'missing' ? 'No commands here' : 'Something went wrong'}</h1>
                <p className="prose-lede">
                  {data === 'missing'
                    ? `${login} does not have Sylva's chat bot turned on, or the link is mistyped.`
                    : 'Sylva could not be reached. Refresh to try again.'}
                </p>
              </>}
        </main>
        <SiteFooter />
      </div>
    );
  }

  const open = shown.filter((c) => c.level === 'everyone');
  const roles = shown.filter((c) => c.level !== 'everyone');
  return (
    <div className="site">
      {header}
      <main id="content" className="wrap pub">
        <div className="pub-head">
          <p className="pub-eyebrow">twitch.tv/{data.login || login}</p>
          <h1>{data.channel}’s chat commands</h1>
          <p className="prose-lede">Type these in {data.channel}’s chat on Twitch, and the bot answers.</p>
          <div className="pub-look">
            <label className="sr-only" htmlFor="pub-q">Find a command</label>
            <input id="pub-q" className="input" type="search" placeholder="Find a command" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        <div className="pub-grid">
          <section className="card" aria-labelledby="pub-everyone">
            <div className="card-head"><div><h2 id="pub-everyone">For everyone</h2><p>Anyone in chat can use these.</p></div></div>
            {open.length === 0
              ? <p className="empty">{q ? 'No command matches that.' : 'None yet.'}</p>
              : <ul className="pub-items pub-cmds">{open.map((c) => <Row key={c.name} c={c} />)}</ul>}
          </section>
          <div className="stack">
            <section className="card" aria-labelledby="pub-roles">
              <div className="card-head"><div><h2 id="pub-roles">For subscribers, VIPs and moderators</h2><p>These need a role in the channel.</p></div></div>
              {roles.length === 0
                ? <p className="empty">{q ? 'No command matches that.' : 'None.'}</p>
                : <ul className="pub-items pub-cmds">{roles.map((c) => <Row key={c.name} c={c} />)}</ul>}
            </section>
            {data.counters.length > 0 && (
              <section className="card" aria-labelledby="pub-counters">
                <div className="card-head"><div><h2 id="pub-counters">Counters</h2><p>Type the name to see the count.</p></div></div>
                <ul className="pub-top">
                  {data.counters.map((c) => (
                    <li key={c.name}>
                      <code className="pub-cmd">!{c.name}</code>
                      <b>{c.label}</b>
                      <span className="pub-cost">{num(c.value)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

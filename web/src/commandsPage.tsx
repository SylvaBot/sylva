// The commands tab of the channel page: every chat command a channel's bot
// answers. The bot's !commands links to /{login}/commands.

import { useMemo, useState } from 'react';
import { type PublicCommand, type PublicCommands, type UserLevel } from './api';
import { num } from './ui';

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

/** The commands tab of the channel page at /{login}/commands. */
export function CommandsBody({ data }: { data: PublicCommands }) {
  const [q, setQ] = useState('');

  const shown = useMemo(() => {
    const w = q.trim().toLowerCase().replace(/^!/, '');
    return data.commands
      .filter((c) => !w || c.name.includes(w) || c.aliases.some((a) => a.includes(w)) || c.text.toLowerCase().includes(w))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, q]);

  const open = shown.filter((c) => c.level === 'everyone');
  const roles = shown.filter((c) => c.level !== 'everyone');
  return (
    <>
      <div className="pub-look">
        <label className="sr-only" htmlFor="pub-q">Find a command</label>
        <input id="pub-q" className="input" type="search" placeholder="Find a command" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="pub-grid">
        <section className="card" aria-labelledby="pub-everyone">
          <div className="card-head"><div><h2 id="pub-everyone">For everyone</h2><p>Type these in {data.channel}’s chat on Twitch, and the bot answers.</p></div></div>
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
    </>
  );
}

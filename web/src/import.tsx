// Settings > Import from StreamElements: bring commands, timers, points and past streams over
// with the streamer's StreamElements JWT, which is used once and not kept.

import { useState } from 'react';
import { api, type ImportResult } from './api';
import { useChannel } from './channel';
import { errorText, Row, Sect, Switch, useToast } from './ui';

export function ImportCard() {
  const ch = useChannel();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [pick, setPick] = useState({ commands: true, timers: true, counters: true, points: true, watchtime: true, loyalty: true, store: true, chatstats: true, history: true });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportResult | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.importStreamElements(ch.key, { token: token.trim(), ...pick });
      setDone(r);
      setToken('');
      toast('Brought over from StreamElements');
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const KEYS = ['commands', 'timers', 'counters', 'points', 'watchtime', 'loyalty', 'store', 'chatstats', 'history'] as const;
  const LABELS = { commands: 'Commands', timers: 'Timers', counters: 'Counters', points: 'Loyalty points', watchtime: 'Watch time', loyalty: 'Points settings', store: 'Store items', chatstats: 'Chat stats', history: 'Stream history' } as const;
  const DESCS = {
    commands: 'Your bot commands, with their replies and cooldowns',
    timers: 'Messages the bot posts on a schedule',
    counters: 'Counters like deaths or wins, with their current numbers',
    loyalty: 'What your points are called, how fast viewers earn them and the follow, sub and cheer bonuses',
    store: 'Rewards viewers buy with points, with cost, stock and cooldown',
    chatstats: 'All time messages, top chatters, emotes, commands and hashtags. Replaces what Sylva counted so far, since StreamElements counted the same chat',
    points: 'Every viewer keeps whichever balance is higher',
    watchtime: 'How long each viewer has watched',
    history: 'Past streams and alerts, shown on Home and in Activity',
  } as const;
  return (
    <div className="stack">
      <Sect title="What to bring over">
        {KEYS.map((k) => (
          <Row key={k} title={LABELS[k]} desc={DESCS[k]}>
            <Switch on={pick[k]} onChange={(v) => setPick({ ...pick, [k]: v })} label={LABELS[k]} />
          </Row>
        ))}
      </Sect>
      <Sect
        title="Your StreamElements JWT token"
        foot="Copy it from StreamElements under Account, Channels, Show secrets. Sylva uses it for this import only and does not keep it."
      >
        <form className="gr" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <label className="sr-only" htmlFor="import-token">StreamElements JWT token</label>
          <input id="import-token" className="input" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your token" value={token} onChange={(e) => setToken(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button className="btn primary" type="submit" disabled={busy || !token.trim() || !KEYS.some((k) => pick[k])}>
            {busy ? 'Bringing it over' : 'Import'}
          </button>
        </form>
      </Sect>
      {done && (
        <Sect title="Brought over">
          <div className="gr" aria-live="polite">
            <div className="gr-main">
              <div className="t1">
                {plural(done.commands, 'command')}, {plural(done.timers, 'timer')}, {plural(done.counters, 'counter')}, {plural(done.rewards, 'reward')}, {done.chatMessages > 0 ? `${done.chatMessages.toLocaleString()} chat messages, ` : ''}{done.loyalty ? 'your points settings, ' : ''}points for {plural(done.points, 'viewer')}, watch time for {plural(done.watchtime, 'viewer')}, {plural(done.streams, 'past stream')} and {plural(done.activities, 'past alert')}
              </div>
              <div className="t2">Commands with a name Sylva already uses were left alone. StreamElements does not keep viewer counts or chat messages per stream, so past streams show those as a dash.</div>
            </div>
          </div>
          {done.skipped.map((s, i) => <Row key={i} title={s.what} desc={s.why} />)}
        </Sect>
      )}
    </div>
  );
}

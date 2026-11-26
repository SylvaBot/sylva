// Settings > Move from StreamElements: bring commands, timers and points over
// with the streamer's StreamElements JWT, which is used once and not kept.

import { useState } from 'react';
import { api, type ImportResult } from './api';
import { useChannel } from './channel';
import { Card } from './pages';
import { errorText, useToast } from './ui';

export function ImportCard() {
  const ch = useChannel();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [pick, setPick] = useState({ commands: true, timers: true, points: true, watchtime: true });
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
  return (
    <Card
      id="import"
      title="Move from StreamElements"
      desc={<>Bring over your StreamElements bot commands, timers, loyalty points and watch time. Copy your JWT token from StreamElements under Account, Channels, Show secrets. Sylva uses it for this import only and does not keep it.</>}
    >
      <form className="card-body import-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label className="field" htmlFor="import-token">
          StreamElements JWT token
          <input id="import-token" className="input" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <fieldset className="import-pick">
          <legend className="sr-only">What to bring over</legend>
          {(['commands', 'timers', 'points', 'watchtime'] as const).map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={pick[k]} onChange={(e) => setPick({ ...pick, [k]: e.target.checked })} />
              {k === 'points' ? 'Loyalty points' : k === 'watchtime' ? 'Watch time' : k[0].toUpperCase() + k.slice(1)}
            </label>
          ))}
        </fieldset>
        <button className="btn primary" type="submit" disabled={busy || !token.trim() || !(pick.commands || pick.timers || pick.points || pick.watchtime)}>
          {busy ? 'Bringing it over' : 'Import'}
        </button>
      </form>
      {done && (
        <div className="card-body import-done" aria-live="polite">
          <p>
            Brought over {plural(done.commands, 'command')}, {plural(done.timers, 'timer')}, points for {plural(done.points, 'viewer')} and watch time for {plural(done.watchtime, 'viewer')}.
            Commands with a name Sylva already uses were left alone, and viewers keep whichever balance is higher.
          </p>
          {done.skipped.length > 0 && (
            <ul className="import-skipped">
              {done.skipped.map((s, i) => <li key={i}><b>{s.what}</b>: {s.why}</li>)}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

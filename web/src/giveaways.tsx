// The Giveaways page: start one, watch entries come in, draw winners, and
// see past giveaways with the seed that proves each draw. The rules match
// crates/sylva-core/src/giveaway.rs.

import { useCallback, useEffect, useState } from 'react';
import { api, type Giveaway, type GiveawaySettings, type GiveawaysView, type UserLevel } from './api';
import { useChannel } from './channel';
import { NumberField } from './moderation';
import { Card, PageHead } from './pages';
import { Link } from './router';
import { errorText, Gate, Icon, num, SkelCard, useToast } from './ui';
import { Select } from './dropdown';

const LEVELS: { id: UserLevel; label: string }[] = [
  { id: 'everyone', label: 'Everyone' },
  { id: 'subscriber', label: 'Subscribers, VIPs and moderators' },
  { id: 'vip', label: 'VIPs and moderators' },
  { id: 'moderator', label: 'Moderators only' },
];

function when(at: number): string {
  const d = new Date(at);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function GiveawaysPage() {
  const ch = useChannel();
  const [view, setView] = useState<GiveawaysView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api.giveaways(ch.key).then(setView).catch(() => setFailed(true));
  }, [ch.key]);

  useEffect(() => {
    load();
    // Entries arrive from chat, so keep the page current while it is open.
    const t = setInterval(() => { if (!document.hidden) load(); }, 5_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="page">
      <PageHead title="Giveaways" desc="Viewers enter with a word in chat. Each draw uses a seed Sylva fixes before anyone enters, so anyone can check it was fair." />
      {failed && !view && <Card><div className="card-body"><p className="card-text">Could not load giveaways. Refresh to try again.</p></div></Card>}
      {!view && !failed && <SkelCard rows={3} />}
      {view && (
        <div className="stack">
          {!view.botOn && (
            <div className="notice">
              <span>Entries come from chat, which Sylva only reads for commands while the chat bot is on. Turn it on to run a giveaway.</span>
              <Link className="btn sm" href="/app/commands">Open Commands</Link>
            </div>
          )}
          <Gate on={ch.can.moderate}>
            {view.current
              ? <Current view={view} g={view.current} onView={setView} />
              : <Start view={view} onView={setView} />}
          </Gate>
          <Past list={view.past} />
        </div>
      )}
    </div>
  );
}

function Start({ view, onView }: { view: GiveawaysView; onView(v: GiveawaysView): void }) {
  const ch = useChannel();
  const toast = useToast();
  const [draft, setDraft] = useState<GiveawaySettings>({ prize: '', keyword: 'enter', level: 'everyone', cost: 0, subLuck: 1 });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<GiveawaySettings>) => setDraft((d) => ({ ...d, ...p }));
  const word = draft.keyword.trim().replace(/^!/, '').toLowerCase() || 'enter';

  const start = async () => {
    setBusy(true);
    try {
      onView(await api.startGiveaway(ch.key, draft));
      toast('The giveaway is open');
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="give-start" title="Start a giveaway" desc="Sylva posts it in chat, takes one entry per viewer, and draws when you are ready.">
      <form className="card-body give-form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <label className="field wide" htmlFor="give-prize">
          Prize
          <input id="give-prize" className="input" maxLength={100} required placeholder="A Steam key for Hollow Knight" value={draft.prize} onChange={(e) => set({ prize: e.target.value })} />
        </label>
        <label className="field" htmlFor="give-word">
          <span className="field-row">Chat word<span className="field-hint">Viewers type !{word}</span></span>
          <input id="give-word" className="input" maxLength={26} required value={draft.keyword} onChange={(e) => set({ keyword: e.target.value })} />
        </label>
        <label className="field" htmlFor="give-level">
          Who can enter
          <Select<UserLevel> id="give-level" value={draft.level} onChange={(v) => set({ level: v })}
            options={LEVELS.map((l) => ({ value: l.id, label: l.label }))} />
        </label>
        <label className="field" htmlFor="give-luck">
          Subscriber luck
          <Select<number> id="give-luck" value={draft.subLuck} onChange={(v) => set({ subLuck: v })}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: n === 1 ? 'Same chance as everyone' : `${n} times the chance` }))} />
        </label>
        <div className="field">
          <span id="give-cost-label">Entry cost</span>
          <div className="reward-cost" role="group" aria-labelledby="give-cost-label">
            <NumberField label="Entry cost" value={draft.cost} min={0} max={1_000_000} onChange={(n) => set({ cost: n })} />
            <span>{view.pointsOn ? view.pointsName : 'points (turn points on to charge)'}</span>
          </div>
        </div>
        <div className="type-actions">
          <button className="btn primary" type="submit" disabled={busy || !draft.prize.trim()}>{busy ? 'Starting' : 'Start giveaway'}</button>
        </div>
      </form>
    </Card>
  );
}

function Seed({ g }: { g: Giveaway }) {
  return (
    <dl className="give-seed">
      <div><dt>Seed hash</dt><dd><code>{g.seedHash}</code></dd></div>
      {g.seed
        ? <div><dt>Seed</dt><dd><code>{g.seed}</code></dd></div>
        : <div><dt>Seed</dt><dd>Shown after the first draw.</dd></div>}
    </dl>
  );
}

function Current({ view, g, onView }: { view: GiveawaysView; g: Giveaway; onView(v: GiveawaysView): void }) {
  const ch = useChannel();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const act = async (action: 'close' | 'draw' | 'end' | 'cancel') => {
    setBusy(true);
    try {
      const v = await api.giveawayAction(ch.key, g.id, action);
      onView(v);
      if (action === 'draw') {
        const w = v.current?.winners.at(-1);
        toast(w ? `${w.name} won` : 'Drawn');
      } else {
        toast({ close: 'Entries are closed', end: 'The giveaway is over', cancel: 'The giveaway was cancelled' }[action]);
      }
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  const open = g.status === 'open';
  const level = LEVELS.find((l) => l.id === g.settings.level)?.label ?? 'Everyone';
  return (
    <Card
      id="give-now"
      className="give-now"
      title={g.settings.prize}
      desc={<>
        <span className={'pill ' + (open ? 'on' : 'off')}>{open ? 'Taking entries' : 'Entries closed'}</span>
        {' '}Type <code>!{g.settings.keyword}</code> to enter. {level}
        {g.settings.cost ? `, ${num(g.settings.cost)} ${view.pointsName} each` : ''}
        {g.settings.subLuck > 1 ? `, subscribers ${g.settings.subLuck} times the chance` : ''}. Started {when(g.openedAt)}.
      </>}
    >
      <div className="card-body give-stats">
        <div className="stat-inline"><span>Entries</span><b>{num(g.entries)}</b></div>
        <div className="stat-inline"><span>Tickets</span><b>{num(g.tickets)}</b></div>
        <div className="give-actions">
          {g.winners.length === 0 && <button className="btn ghost danger" type="button" disabled={busy} onClick={() => void act('cancel')}>Cancel</button>}
          {open && <button className="btn" type="button" disabled={busy} onClick={() => void act('close')}>Close entries</button>}
          {g.winners.length > 0 && <button className="btn" type="button" disabled={busy} onClick={() => void act('end')}>Finish</button>}
          <button className="btn primary" type="button" disabled={busy || g.entries === 0} onClick={() => void act('draw')}>
            <Icon id="trophy" />{g.winners.length ? 'Draw another' : 'Draw a winner'}
          </button>
        </div>
      </div>
      {g.winners.length > 0 && (
        <ol className="give-winners" aria-label="Winners">
          {g.winners.map((w) => (
            <li key={w.round}><span className="pub-num">{w.round}</span><b>{w.name}</b><span className="cmd-meta">{when(w.at)}</span></li>
          ))}
        </ol>
      )}
      <div className="card-body give-entries">
        <h3 className="points-sub">Entries, newest first</h3>
        {view.entries.length === 0
          ? <p className="field-hint">Nobody yet. Entries show here as viewers type !{g.settings.keyword}.</p>
          : (
            <ul className="give-entry-list">
              {view.entries.map((e) => (
                <li key={e.userId}>{e.name}{e.tickets > 1 && <span className="cmd-meta"> ×{e.tickets}</span>}</li>
              ))}
            </ul>
          )}
        {g.entries > view.entries.length && <p className="field-hint">And {num(g.entries - view.entries.length)} more.</p>}
      </div>
      <div className="card-body give-proof">
        <Seed g={g} />
      </div>
    </Card>
  );
}

function Past({ list }: { list: Giveaway[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Card id="give-past" title="Past giveaways" desc="Each one keeps its seed. To check a draw, hash the seed with SHA-256 and compare it with the hash shown at the start.">
      {list.length === 0
        ? <p className="empty"><Icon id="trophy" />No giveaways yet.</p>
        : (
          <ul className="types">
            {list.map((g) => (
              <li key={g.id} className={'type' + (open === g.id ? ' open' : '')}>
                <div className="type-row">
                  <div className="type-main">
                    <b>{g.settings.prize}</b>
                    <span className="cmd-meta">
                      {when(g.openedAt)} · {num(g.entries)} {g.entries === 1 ? 'entry' : 'entries'} · {g.status === 'cancelled'
                        ? 'Cancelled'
                        : g.winners.length ? `Won by ${g.winners.map((w) => w.name).join(', ')}` : 'No winner drawn'}
                    </span>
                  </div>
                  <button className="btn sm ghost" type="button" aria-expanded={open === g.id} aria-label={`${open === g.id ? 'Hide' : 'Show'} the seed for ${g.settings.prize}`}
                    onClick={() => setOpen(open === g.id ? null : g.id)}>{open === g.id ? 'Hide' : 'Seed'}</button>
                </div>
                {open === g.id && (
                  <div className="give-proof past">
                    <Seed g={g} />
                    <p className="field-hint">Winner number N is found by hashing &ldquo;seed:N&rdquo; with SHA-256, reading the first 8 bytes as a number, and counting that many tickets (modulo the total) through the entries in the order they came in, skipping earlier winners.</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}

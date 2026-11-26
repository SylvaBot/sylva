// The Loyalty page: what viewers earn, the chat commands, and every
// viewer's points with a way to change them. The rules match
// crates/sylva-core/src/loyalty.rs, which checks every save again.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type LoyaltySettings, type LoyaltyView, type PointsEntry, type PointsViewer } from './api';
import { useChannel } from './channel';
import { NumberField } from './moderation';
import { Card, PageHead } from './pages';
import { Link } from './router';
import { errorText, Gate, Icon, num, SkelCard, SkelRows, useToast } from './ui';

const ALLOW_URL = '/auth/twitch/start?scopes=loyalty&next=/app/loyalty';
const PAGE = 50;
const MAX_RULE = 100_000;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Rule = 'watch' | 'active' | 'follow' | 'sub' | 'gift' | 'cheer';

function rules(every: number): { key: Rule; name: string; when: string }[] {
  const period = every === 1 ? 'Every minute' : `Every ${every} minutes`;
  return [
    { key: 'watch', name: 'Watching', when: `${period} you are live, for each viewer in chat.` },
    { key: 'active', name: 'Chatting', when: `${period} you are live, extra for viewers who chatted.` },
    { key: 'follow', name: 'Following', when: 'Once per viewer, the first time they follow.' },
    { key: 'sub', name: 'Subscribing', when: 'For each sub and resub. A gifted sub pays the gifter instead.' },
    { key: 'gift', name: 'Gifting subs', when: 'For each sub gifted to your community.' },
    { key: 'cheer', name: 'Cheering', when: 'For every 100 bits.' },
  ];
}

export function LoyaltyPage() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<LoyaltyView | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<LoyaltySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [listVersion, setListVersion] = useState(0);

  const adopt = useCallback((v: LoyaltyView) => {
    setView(v);
    setDraft(v.settings);
  }, []);

  useEffect(() => {
    api.loyalty(ch.key).then(adopt).catch(() => setFailed(true));
  }, [ch.key, adopt]);

  const changed = !!view && !!draft && !same(draft, view.settings);
  const set = (patch: Partial<LoyaltySettings>) => draft && setDraft({ ...draft, ...patch });

  const save = async (next: LoyaltySettings, done?: string) => {
    setBusy(true);
    try {
      adopt(await api.saveLoyalty(ch.key, next));
      toast(done ?? 'Points saved');
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => {
    if (!view) return;
    // The switch saves at once, keeping any other edits as a draft.
    const on = !view.settings.enabled;
    void (async () => {
      setBusy(true);
      try {
        const v = await api.saveLoyalty(ch.key, { ...view.settings, enabled: on });
        setView(v);
        setDraft((d) => (d ? { ...d, enabled: v.settings.enabled } : v.settings));
        toast(on ? 'Points are on' : 'Points are off');
      } catch (x) {
        toast(errorText(x), true);
      } finally {
        setBusy(false);
      }
    })();
  };

  const name = view?.settings.name ?? 'points';
  const cmdName = name.replace(/ /g, '');

  return (
    <div className="page">
      <PageHead title="Loyalty" desc="Viewers earn points for watching, chatting and supporting you, and check them in chat." />
      {failed && !view && <Card><div className="card-body"><p className="card-text">Could not load loyalty points. Refresh to try again.</p></div></Card>}
      {!view && !failed && <SkelCard rows={4} />}
      {view && draft && (
        <div className="stack">
          {view.settings.enabled && view.permission !== 'ok' && (
            <div className="notice">
              <span>
                {!ch.can.own
                  ? `Right now only viewers who chat earn watch points. ${ch.name} can let Sylva see who is in chat on this page, so viewers who only watch earn too.`
                  : view.permission === 'expired'
                    ? 'Twitch no longer accepts Sylva’s permission to see who is in your chat. Allow it again so viewers who only watch keep earning.'
                    : 'Right now only viewers who chat earn watch points. Let Sylva see who is in your chat so viewers who only watch earn too.'}
              </span>
              {ch.can.own && <a className="btn primary sm" href={ALLOW_URL}><Icon id="twitch" />Allow chat list</a>}
            </div>
          )}
          {view.settings.enabled && !view.botOn && (
            <div className="notice">
              <span>Points are counted, but <code>!{cmdName}</code> and the other chat commands only answer while the chat bot is on.</span>
              <Link className="btn sm" href="/app/bot">Open Chat bot</Link>
            </div>
          )}

          <Card
            id="points-main"
            className="points-card"
            title="Points"
            desc={view.settings.enabled
              ? (view.live ? 'On, and paying viewers now while you are live.' : 'On. Watch points are paid while you are live.')
              : 'Off. Turn points on to start counting.'}
            action={
              <div className="field inline points-switch">
                <span>{view.settings.enabled ? 'On' : 'Off'}</span>
                <button className="switch" type="button" role="switch" aria-checked={view.settings.enabled} aria-label="Loyalty points" disabled={busy || !ch.can.edit} onClick={toggle} />
              </div>
            }
          >
            <Gate on={ch.can.edit}>
              <div className="card-body points-settings">
                <label className="field" htmlFor="points-name">
                  <span className="field-row">What they are called<span className="field-hint">Viewers can also type !{draft.name.trim().toLowerCase().replace(/ /g, '') || 'points'}</span></span>
                  <input id="points-name" className="input" maxLength={20} value={draft.name} placeholder="points" onChange={(e) => set({ name: e.target.value })} />
                </label>
                <div className="field inline">
                  <span>Viewers can give their own with <code>!give</code></span>
                  <button className="switch" type="button" role="switch" aria-checked={draft.give} aria-label="Viewers can give points" onClick={() => set({ give: !draft.give })} />
                </div>
              </div>
              <h3 className="points-sub">How viewers earn</h3>
              <ul className="types points-rules">
                {rules(view.everyMinutes).map((r) => (
                  <li key={r.key} className="type">
                    <div className="type-row">
                      <div className="type-main">
                        <b>{r.name}</b>
                        <span>{r.when}</span>
                      </div>
                      <div className="points-amount">
                        <NumberField label={`${r.name}: points`} value={draft[r.key]} min={0} max={MAX_RULE} onChange={(n) => set({ [r.key]: n })} />
                        <span>{draft.name.trim().toLowerCase() || 'points'}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Gate>
            <p className="card-body field-hint points-foot">You and your bot never earn. A balance never drops below zero.</p>
          </Card>

          <Card id="points-games" title="Games" desc={`!gamble, !roulette, !slots, !blackjack, !duel and !raffle, with their odds, bets and cooldowns, are on the Chat bot page.`}
            action={<Link className="btn sm" href="/app/bot#games">Open Games</Link>}>{null}</Card>

          {changed && (
            <div className="save-bar" role="region" aria-label="Unsaved changes">
              <span>You have changes that are not saved yet.</span>
              <button className="btn ghost" type="button" disabled={busy} onClick={() => adopt(view)}>Discard</button>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void save(draft)}>{busy ? 'Saving' : 'Save changes'}</button>
            </div>
          )}


          <Card id="points-commands" title="Chat commands" desc="What viewers and moderators can type. Viewers wait 5 seconds between checks; moderators never wait.">
            <ul className="types points-cmds">
              <CommandRow cmd={`!${cmdName}`} alt={cmdName !== 'points' ? '!points' : undefined} what={`Shows their ${name} and rank. Add @name to see someone else’s.`} />
              <CommandRow cmd="!top" alt="!leaderboard" what={`The five viewers with the most ${name}.`} />
              <CommandRow cmd="!give @name 100" what={view.settings.give ? `Gives some of their own ${name} to another viewer.` : 'Off. Turn on giving above to allow it.'} off={!view.settings.give} />
              <CommandRow cmd="!addpoints @name 100" what={`Moderators add ${name}, or take some away with a minus sign.`} />
            </ul>
          </Card>

          <Viewers name={name} version={listVersion} onChanged={() => setListVersion((n) => n + 1)} />
        </div>
      )}
    </div>
  );
}


function CommandRow({ cmd, alt, what, off }: { cmd: string; alt?: string; what: string; off?: boolean }) {
  return (
    <li className={'type' + (off ? ' off' : '')}>
      <div className="type-row">
        <div className="type-main">
          <b><code>{cmd}</code>{alt && <span className="points-alt">or <code>{alt}</code></span>}</b>
          <span>{what}</span>
        </div>
      </div>
    </li>
  );
}

function Viewers({ name, version, onChanged }: { name: string; version: number; onChanged(): void }) {
  const ch = useChannel();
  const [q, setQ] = useState('');
  const [list, setList] = useState<PointsViewer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const asked = useRef(0);

  const load = useCallback(async (query: string, offset: number) => {
    const n = ++asked.current;
    try {
      const r = await api.pointsViewers(ch.key, query.trim(), offset, PAGE);
      if (n !== asked.current) return;
      setTotal(r.total);
      setList((old) => (offset === 0 ? r.viewers : [...(old ?? []), ...r.viewers]));
    } catch {
      if (n === asked.current) setList((old) => old ?? []);
    }
  }, [ch.key]);

  useEffect(() => {
    const t = setTimeout(() => void load(q, 0), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load, version]);

  const put = (v: PointsViewer) => setList((old) => old?.map((x) => (x.id === v.id ? v : x)) ?? null);
  const searching = q.trim() !== '';

  return (
    <Card
      id="points-viewers"
      className="points-viewers"
      title="Viewers"
      desc={`Everyone with ${name}, most first. Open a viewer to see why their balance changed, or to change it.`}
      action={<button className="btn sm ghost" type="button" onClick={() => void load(q, 0)}><Icon id="refresh" />Refresh</button>}
    >
      <div className="card-body points-search">
        <label className="field" htmlFor="points-q">
          <span className="sr-only">Search viewers</span>
          <input id="points-q" className="input" type="search" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {list !== null && <span className="field-hint" role="status">{num(total)} {total === 1 ? 'viewer' : 'viewers'}{searching ? ' found' : ''}</span>}
      </div>
      {list === null && <SkelRows n={4} />}
      {list?.length === 0 && (
        <p className="empty">
          <Icon id="gem" />
          {searching ? 'No viewer matches that name.' : `Nobody has any ${name} yet. Viewers start earning once points are on and you go live.`}
        </p>
      )}
      {!!list?.length && (
        <ol className="types points-list">
          {list.map((v, i) => (
            <li key={v.id} className={'type' + (open === v.id ? ' open' : '')}>
              <div className="type-row">
                <span className="points-rank">{searching ? '' : i + 1}</span>
                <div className="type-main">
                  <b>{v.name}</b>
                  <span className="cmd-meta">{num(v.earned)} earned in all</span>
                </div>
                <span className="points-balance">{num(v.balance)}<span className="sr-only"> {name}</span></span>
                <button className="btn sm ghost" type="button" aria-expanded={open === v.id} aria-label={`${open === v.id ? 'Close' : 'Open'} ${v.name}`} onClick={() => setOpen(open === v.id ? null : v.id)}>
                  {open === v.id ? 'Close' : 'Open'}
                </button>
              </div>
              {open === v.id && <ViewerDetail viewer={v} name={name} onSaved={(nv) => { put(nv); onChanged(); }} />}
            </li>
          ))}
        </ol>
      )}
      {!!list && list.length < total && (
        <div className="card-body load-more">
          <button className="btn sm" type="button" onClick={() => void load(q, list.length)}>Show more ({num(total - list.length)} left)</button>
        </div>
      )}
    </Card>
  );
}

function when(at: number): string {
  const d = new Date(at);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ViewerDetail({ viewer, name, onSaved }: { viewer: PointsViewer; name: string; onSaved(v: PointsViewer): void }) {
  const ch = useChannel();
  const toast = useToast();
  const [entries, setEntries] = useState<PointsEntry[] | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const id = `pv-${viewer.id}`;

  const loadLedger = useCallback(() => {
    api.pointsLedger(ch.key, viewer.id).then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  }, [ch.key, viewer.id]);
  useEffect(loadLedger, [loadLedger]);

  const delta = Math.round(Number(amount.replace(/,/g, '')));
  const valid = amount.trim() !== '' && Number.isFinite(delta) && delta !== 0;

  const apply = async (sign: 1 | -1) => {
    if (!valid) return;
    setBusy(true);
    try {
      const v = await api.adjustPoints(ch.key, viewer.id, sign * Math.abs(delta), reason);
      onSaved(v);
      setAmount('');
      setReason('');
      loadLedger();
      toast(`${v.name} now has ${num(v.balance)} ${name}`);
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="points-detail">
      {ch.can.moderate && <form className="points-adjust" onSubmit={(e) => { e.preventDefault(); void apply(1); }}>
        <label className="field" htmlFor={`${id}-amount`}>
          Amount
          <input id={`${id}-amount`} className="input" inputMode="numeric" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d,]/g, ''))} />
        </label>
        <label className="field" htmlFor={`${id}-reason`}>
          Reason
          <input id={`${id}-reason`} className="input" maxLength={60} placeholder="Won the raffle" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="points-adjust-actions">
          <button className="btn" type="button" disabled={busy || !valid} onClick={() => void apply(-1)}>Take away</button>
          <button className="btn primary" type="submit" disabled={busy || !valid}>Add</button>
        </div>
      </form>}
      <h3 className="points-sub">Recent changes</h3>
      {entries === null && <SkelRows n={3} tile={false} />}
      {entries?.length === 0 && <p className="field-hint">No changes kept for this viewer.</p>}
      {!!entries?.length && (
        <ul className="points-ledger">
          {entries.map((e) => (
            <li key={e.id}>
              <span className={'points-delta' + (e.delta < 0 ? ' minus' : '')}>{e.delta > 0 ? '+' : ''}{num(e.delta)}</span>
              <span className="points-reason">{e.reason}</span>
              <time dateTime={new Date(e.at).toISOString()}>{when(e.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

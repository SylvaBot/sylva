// Shared page pieces (the page head and sections), the Activity page and the
// page for an address that does not exist.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Kind, type Redemption, type SylvaEvent } from './api';
import { PAGE, useChannel } from './channel';
import { FeedRow, groupOf, GROUPS, matchesShown, useTick } from './feed';
import { Link, usePath } from './router';
import { errorText, Icon, num, Skel, SkelRows, timeOf, useToast } from './ui';

/** The top of every page: a mono tag with the page's address, its name, a line about it, and actions. */
export function PageHead({ title, desc, children, tag, big }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; tag?: string; big?: boolean }) {
  const path = usePath();
  const shown = tag ?? ('/' + (path.replace(/^\/app\/?/, '').replace(/\/+$/, '') || 'home'));
  return (
    <div className={'page-head' + (big ? ' big' : '')}>
      <div>
        <span className="tag">{shown}</span>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

/** A section with a small label over a filled box. `className` styles the box. */
export function Card({ title, desc, action, children, className, id }: {
  title?: ReactNode; desc?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  const hid = id ? id + '-title' : undefined;
  const box = <div className={'card' + (className ? ' ' + className : '')}>{children}</div>;
  if (!title && !action) return <section className="sect" id={id}>{box}</section>;
  return (
    <section className="sect" aria-labelledby={title ? hid : undefined} id={id}>
      <div className="sect-head">
        <div>{title && <h2 id={hid}>{title}</h2>}{desc && <p>{desc}</p>}</div>
        {action && <div className="page-actions">{action}</div>}
      </div>
      {box}
    </section>
  );
}

export function read(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
export function remember(key: string) {
  try { localStorage.setItem(key, '1'); } catch { /* private window */ }
}

/** Test alerts, one per kind that plays on stream. */
export const TESTS: { kind: Kind; label: string; icon: string; name: string; amount?: number; message?: string }[] = [
  { kind: 'follow', label: 'Follow', icon: 'heart', name: 'Maple' },
  { kind: 'subscriber', label: 'Sub', icon: 'star', name: 'Juniper', amount: 6, message: 'Six months already, love this place' },
  { kind: 'communityGift', label: 'Gifted subs', icon: 'gift', name: 'Aspen', amount: 5 },
  { kind: 'cheer', label: 'Bits', icon: 'zap', name: 'Rowan', amount: 500, message: 'Testing, testing' },
  { kind: 'raid', label: 'Raid', icon: 'raid', name: 'Hazel', amount: 42 },
  { kind: 'tip', label: 'Tip', icon: 'tip', name: 'Willow', amount: 10, message: 'That clutch was unreal' },
  { kind: 'redemption', label: 'Points redemption', icon: 'gem', name: 'Birch' },
];

export function sendTest(key: string, t: (typeof TESTS)[number]) {
  return api.testEvent(key, { kind: t.kind, name: t.name, amount: t.amount, message: t.message });
}

/* ---------------------------------------------------------------- Activity */

const SHOW_KEY = 'sylva.activityShow';
const CHIPS = [{ id: 'all', label: 'All' }, ...GROUPS.filter((g) => g.id !== 'other').map((g) => ({ id: g.id, label: g.label }))];

function savedShow(): string {
  try {
    const v = localStorage.getItem(SHOW_KEY) || 'all';
    return CHIPS.some((c) => c.id === v) ? v : 'all';
  } catch { return 'all'; }
}

type Line = { at: number; key: string; ev?: SylvaEvent; red?: Redemption };

const DAY = 86_400_000;
function dayName(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (d0 === t0) return 'Today';
  if (Math.round((t0 - d0) / DAY) === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ActivityPage() {
  const ch = useChannel();
  const toast = useToast();
  useTick();
  const [show, setShowState] = useState(savedShow);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SylvaEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reds, setReds] = useState<Redemption[]>([]);
  const [settling, setSettling] = useState<number | null>(null);

  const setShow = (v: string) => {
    setShowState(v);
    try { localStorage.setItem(SHOW_KEY, v); } catch { /* private window */ }
  };

  // Search on the server, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!q) { setResults(null); return; }
    let cancelled = false;
    setLoading(true);
    api.history(ch.key, 'alerts', PAGE, undefined, q)
      .then((r) => {
        if (cancelled) return;
        setResults(r.events);
        setMore(r.events.length === PAGE);
      })
      .catch((x) => !cancelled && toast('Search failed: ' + errorText(x), true))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [q, ch.key, toast]);

  // Rewards viewers bought with points: waiting ones get Done and Refund.
  useEffect(() => {
    let live = true;
    const load = () => Promise.all([api.redemptions(ch.key, 'pending'), api.redemptions(ch.key, 'done')])
      .then(([p, d]) => live && setReds([...p.redemptions, ...d.redemptions]))
      .catch(() => { /* no rewards, or no access: the list simply has none */ });
    void load();
    const t = setInterval(load, 20_000);
    return () => { live = false; clearInterval(t); };
  }, [ch.key]);

  const settle = async (r: Redemption, action: 'done' | 'refund') => {
    setSettling(r.id);
    try {
      const next = await api.settle(ch.key, r.id, action);
      setReds((list) => list.map((x) => (x.id === r.id ? next : x)));
      toast(action === 'done' ? `${r.itemName} for ${r.name} is done` : `${r.name} got ${num(r.cost)} points back`, false, {
        label: 'Undo',
        run: () => void api.settle(ch.key, r.id, 'reopen').then((back) => setReds((list) => list.map((x) => (x.id === r.id ? back : x)))).catch((x) => toast(errorText(x), true)),
      });
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setSettling(null);
    }
  };

  const searchMore = async () => {
    if (!results?.length) return;
    setLoading(true);
    try {
      const r = await api.history(ch.key, 'alerts', PAGE, results[results.length - 1].seq, q);
      setResults([...results, ...r.events]);
      setMore(r.events.length === PAGE);
    } catch (x) {
      toast('Search failed: ' + errorText(x), true);
    } finally {
      setLoading(false);
    }
  };

  const source = results ?? ch.events;
  const hasMore = results ? more : ch.hasMore;
  const busy = results ? loading : ch.loadingMore;
  const events = source.filter(matchesShown(show));
  const oldest = source.length ? Date.parse(source[source.length - 1].createdAt) : 0;
  const needle = q.toLowerCase();
  const lines: Line[] = useMemo(() => {
    const list: Line[] = events.map((e) => ({ at: Date.parse(e.createdAt), key: 'e' + e.seq, ev: e }));
    if (show === 'all' || show === 'redemption') {
      for (const r of reds) {
        if (hasMore && r.at < oldest) continue;
        if (needle && !`${r.name} ${r.login} ${r.itemName} ${r.input}`.toLowerCase().includes(needle)) continue;
        list.push({ at: r.at, key: 'r' + r.id, red: r });
      }
    }
    return list.sort((a, b) => b.at - a.at);
  }, [events, reds, show, hasMore, oldest, needle]);

  const days: { name: string; lines: Line[] }[] = [];
  for (const l of lines) {
    const name = dayName(l.at);
    const last = days[days.length - 1];
    if (last && last.name === name) last.lines.push(l);
    else days.push({ name, lines: [l] });
  }

  const exportCsv = () => {
    const rows = [['date', 'time', 'kind', 'name', 'amount', 'currency', 'message', 'test'].join(',')];
    for (const l of lines) {
      const d = new Date(l.at);
      const date = d.toLocaleDateString('en-CA');
      const time = d.toTimeString().slice(0, 8);
      if (l.ev) {
        const e = l.ev;
        rows.push([date, time, groupOf(e.kind).label, e.actor?.displayName ?? '', e.amount ?? '', e.currency ?? '', e.message ?? '', e.platform === 'sylva' ? 'yes' : ''].map(csvCell).join(','));
      } else if (l.red) {
        const r = l.red;
        rows.push([date, time, 'Reward: ' + r.itemName, r.name, r.cost, 'points', r.input, ''].map(csvCell).join(','));
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
    a.download = `sylva-activity-${new Date().toLocaleDateString('en-CA')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  let empty: string;
  if (q && loading) empty = 'Searching';
  else if (q) empty = `Nothing matches "${q}"${show !== 'all' ? ' with this filter' : ''}.`;
  else if (ch.events.length) empty = 'Nothing here for this filter yet.';
  else empty = 'No activity yet. Follows, subs, bits, raids and tips appear here the moment they happen.';
  const firstLoad = !ch.loaded || (!!q && loading && !results);

  return (
    <div className="page activity">
      <PageHead title="Activity" desc="Everything that happened on your channel, newest first.">
        <button className="btn" type="button" onClick={exportCsv} disabled={!lines.length}><Icon id="download" />Export CSV</button>
      </PageHead>
      <div className="act-tools">
        <label className="search act-search">
          <Icon id="search" />
          <span className="sr-only">Search activity</span>
          <input className="input" type="search" placeholder="Search names and messages" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="act-chips" role="group" aria-label="Show">
          {CHIPS.map((c) => (
            <button key={c.id} type="button" className="btn sm" aria-pressed={show === c.id} onClick={() => setShow(c.id)}>{c.label}</button>
          ))}
        </div>
      </div>

      {firstLoad ? (
        <section className="sect act-day">
          <div className="sect-head"><div><Skel w={60} h={12} /></div></div>
          <div className="grp"><SkelRows n={6} /></div>
        </section>
      ) : days.length === 0 ? (
        <section className="sect act-day"><div className="grp"><div className="empty"><Icon id="activity" />{empty}</div></div></section>
      ) : days.map((d) => (
        <section key={d.name} className="sect act-day" aria-label={d.name}>
          <div className="sect-head"><div><h2>{d.name}</h2></div></div>
          <div className="grp">
            <ol className="feed">
              {d.lines.map((l) => l.ev ? (
                <FeedRow key={l.key} e={l.ev} fresh={l.ev.seq > ch.freshFrom} onReplay={ch.can.moderate ? ch.replay : undefined} clock />
              ) : (
                <RewardRow key={l.key} r={l.red!} busy={settling === l.red!.id} can={ch.can.moderate} onSettle={settle} />
              ))}
            </ol>
          </div>
        </section>
      ))}

      {hasMore && lines.length > 0 && (
        <div className="act-more">
          <button className="btn" type="button" disabled={busy} onClick={results ? searchMore : ch.loadMore}>
            {busy ? 'Loading' : 'Show older'}
          </button>
        </div>
      )}
    </div>
  );
}

/** A reward bought with points: Done and Refund while it waits. */
function RewardRow({ r, busy, can, onSettle }: { r: Redemption; busy: boolean; can: boolean; onSettle(r: Redemption, a: 'done' | 'refund'): void }) {
  return (
    <li className="item">
      <span className="tile" aria-hidden="true"><Icon id="gem" /></span>
      <div className="item-main">
        <div className="item-title"><b>{r.name}</b> redeemed <b>{r.itemName}</b></div>
        <p className="item-msg">{r.input ? `"${r.input}"` : `${num(r.cost)} points`}</p>
      </div>
      {r.status === 'pending' ? (
        can && (
          <div className="acts">
            <button className="btn sm" type="button" disabled={busy} onClick={() => onSettle(r, 'refund')}>Refund</button>
            <button className="btn sm primary" type="button" disabled={busy} onClick={() => onSettle(r, 'done')}>Done</button>
          </div>
        )
      ) : (
        <span className="done-note">{r.status === 'refunded' ? 'Refunded' : 'Done'}</span>
      )}
      <time dateTime={new Date(r.at).toISOString()} title={new Date(r.at).toLocaleString()}>{timeOf(r.at)}</time>
    </li>
  );
}

/* ---------------------------------------------------------------- 404 */

export function NotFoundPage() {
  return (
    <div className="page">
      <PageHead tag="/404" title="Page not found" desc="That page does not exist in your dashboard.">
        <Link className="btn primary" href="/app">Go to Home</Link>
      </PageHead>
    </div>
  );
}

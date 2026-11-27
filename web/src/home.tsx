// Home: how the channel is doing. A greeting for the time of day, a range
// (today, this week, this month, this year, all time or your own dates),
// five totals compared with the same stretch before, and one bar chart you
// can switch between tips, followers, subs, bits, raids and redemptions.
// Numbers come from the channel's own log (workers/edge/src/stats.rs).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type StatTotals, type Stats } from './api';
import { useChannel } from './channel';
import { niceMax, short, useWidth } from './charts';
import { PageHead } from './pages';
import { Icon, num, Seg, Skel } from './ui';
import { Floating, Select } from './dropdown';

type Range = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';
type Metric = 'tips' | 'follows' | 'subs' | 'bits' | 'raids' | 'redemptions';

const RANGES: { id: Range; label: string; short: string; words: string }[] = [
  { id: 'today', label: 'Today', short: 'Today', words: 'today' },
  { id: 'week', label: 'This week', short: 'Week', words: 'this week' },
  { id: 'month', label: 'This month', short: 'Month', words: 'this month' },
  { id: 'year', label: 'This year', short: 'Year', words: 'this year' },
  { id: 'all', label: 'All time', short: 'All', words: 'all time' },
];
const METRICS: { id: Metric; label: string; one: string; many: string }[] = [
  { id: 'tips', label: 'Tips', one: 'in tips', many: 'in tips' },
  { id: 'follows', label: 'Followers', one: 'follower', many: 'followers' },
  { id: 'subs', label: 'Subs', one: 'sub', many: 'subs' },
  { id: 'bits', label: 'Bits', one: 'bit', many: 'bits' },
  { id: 'raids', label: 'Raids', one: 'raid', many: 'raids' },
  { id: 'redemptions', label: 'Redemptions', one: 'redemption', many: 'redemptions' },
];

const DAY = 86_400_000;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (a: Date, b: Date) => Math.round((midnight(b).getTime() - midnight(a).getTime()) / DAY);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const md = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const mdLong = (d: Date) => d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
const mdy = (d: Date) => d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

/** "8 days", from a start and end that are both counted. */
const span = (a: Date, b: Date) => `${md(a)} to ${md(b)}`;

interface Plan {
  /** The request for the range itself. */
  days: number; end: number;
  /** A second request for what it is compared with, when that is not just the days before. */
  compare?: { days: number; end: number };
  /** Words for what it is compared with, after "vs". */
  vs: string | null;
  /** Today uses the last 7 days for its chart and the last day for its totals. */
  lastDayOnly?: boolean;
}

function plan(range: Range, custom: { from: string; to: string }): Plan {
  const today = midnight(new Date());
  if (range === 'today') return { days: 7, end: 0, vs: 'yesterday', lastDayOnly: true };
  if (range === 'week') {
    const n = ((today.getDay() + 6) % 7) + 1; // Monday is day 1
    const a = addDays(today, -n + 1 - 7);
    return { days: n, end: 0, compare: { days: n, end: 7 }, vs: n === 1 ? md(a) : span(a, addDays(a, n - 1)) };
  }
  if (range === 'month') {
    const n = today.getDate();
    const lastLen = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
    const m = Math.min(n, lastLen);
    const a = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const b = new Date(today.getFullYear(), today.getMonth() - 1, m);
    return { days: n, end: 0, compare: { days: m, end: daysBetween(b, today) }, vs: m === 1 ? md(a) : span(a, b) };
  }
  if (range === 'year') {
    const jan1 = new Date(today.getFullYear(), 0, 1);
    const n = daysBetween(jan1, today) + 1;
    const a = new Date(today.getFullYear() - 1, 0, 1);
    const b = new Date(today.getFullYear() - 1, today.getMonth(), Math.min(today.getDate(), new Date(today.getFullYear() - 1, today.getMonth() + 1, 0).getDate()));
    return { days: n, end: 0, compare: { days: daysBetween(a, b) + 1, end: daysBetween(b, today) }, vs: 'this time last year' };
  }
  if (range === 'all') return { days: 0, end: 0, vs: null };
  const from = fromIso(custom.from);
  const to = fromIso(custom.to);
  const n = daysBetween(from, to) + 1;
  return { days: n, end: Math.max(0, daysBetween(to, today)), vs: n === 1 ? 'the day before' : `the ${num(n)} days before` };
}

const totalOf = (t: StatTotals, m: Metric) => (m === 'subs' ? t.subs + t.gifted : t[m]);
const sumOf = (list: StatTotals[]): StatTotals => list.reduce((a, d) => {
  for (const k of Object.keys(a) as (keyof StatTotals)[]) a[k] += d[k];
  return a;
}, { follows: 0, subs: 0, gifted: 0, bits: 0, raids: 0, raiders: 0, tips: 0, redemptions: 0, chat: 0, chatters: 0 });

const SAVED = 'sylva.homeRange';
function savedRange(): Range {
  try {
    const v = localStorage.getItem(SAVED);
    return RANGES.some((r) => r.id === v) ? (v as Range) : 'month';
  } catch { return 'month'; }
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 21) return 'Good evening';
  return 'Good night';
}

export function HomePage() {
  const ch = useChannel();
  const [range, setRange] = useState<Range>(savedRange);
  const today = isoDay(new Date());
  const [custom, setCustom] = useState({ from: isoDay(addDays(new Date(), -13)), to: today });
  const [picking, setPicking] = useState(false);
  const dateBtn = useRef<HTMLButtonElement>(null);
  const closeDates = useCallback(() => setPicking(false), []);
  const [metric, setMetric] = useState<Metric>('follows');
  const [data, setData] = useState<{ key: string; stats: Stats; compare: StatTotals | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);
  const p = useMemo(() => plan(range, custom), [range, custom]);
  const want = `${ch.key}:${range}:${p.days}:${p.end}`;

  useEffect(() => {
    try { if (range !== 'custom') localStorage.setItem(SAVED, range); } catch { /* private window */ }
  }, [range]);

  // The tip currency, for the Tips total. Asked once.
  useEffect(() => {
    let live = true;
    api.tips(ch.key).then((v) => live && setCurrency(v.settings.currency || 'USD')).catch(() => live && setCurrency('USD'));
    return () => { live = false; };
  }, [ch.key]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    Promise.all([
      api.stats(ch.key, p.days, p.end),
      p.compare ? api.stats(ch.key, p.compare.days, p.compare.end) : Promise.resolve(null),
    ]).then(([stats, cmp]) => {
      if (!live) return;
      setData({ key: want, stats, compare: cmp ? cmp.totals : null });
    }).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [ch.key, p, want]);

  const ready = data?.key === want && currency !== null ? data : null;
  const s = ready?.stats;

  // What the cards show, and what they are compared with.
  let now: StatTotals | null = null;
  let before: StatTotals | null = null;
  if (s && ready) {
    if (p.lastDayOnly) {
      now = s.series[s.series.length - 1] ?? sumOf([]);
      before = s.series[s.series.length - 2] ?? sumOf([]);
    } else {
      now = s.totals;
      before = range === 'all' ? null : ready.compare ?? s.previous;
    }
  }

  const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(n);
  const who = ch.role === 'owner' ? 'your channel' : `${ch.name}'s channel`;
  const first = (ch.you || '').split(/\s+/)[0];
  const todayDate = midnight(new Date());
  let when: string;
  if (range === 'today') when = `is doing today, ${todayDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`;
  else if (range === 'week') when = `did this week, ${mdLong(addDays(todayDate, -((todayDate.getDay() + 6) % 7)))} to ${mdLong(todayDate)}`;
  else if (range === 'month') when = `did this month, ${mdLong(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1))} to ${mdLong(todayDate)}`;
  else if (range === 'year') when = `did this year, ${mdLong(new Date(todayDate.getFullYear(), 0, 1))} to ${mdLong(todayDate)}`;
  else if (range === 'all') when = s ? `has done since ${mdy(new Date(s.from))}` : 'has done since you joined';
  else when = `did from ${mdy(fromIso(custom.from))} to ${mdy(fromIso(custom.to))}`;

  return (
    <div className="page home">
      <PageHead tag="/home" title={`${greeting()}, ${first}`} desc={`Here's how ${who} ${when}.`} big>
        <Seg
          label="Date range"
          options={RANGES.map((r) => ({ id: r.id, label: <><span className="wide-only">{r.label}</span><span className="phone-only">{r.short}</span></> }))}
          value={range === 'custom' ? ('' as Range) : range}
          onChange={(r) => { setRange(r); setPicking(false); }}
        />
        <div className="pop-wrap">
          <button ref={dateBtn} className={'btn' + (range === 'custom' ? ' primary' : '')} type="button" aria-expanded={picking} aria-label="Custom dates" onClick={() => setPicking(!picking)}>
            <Icon id="calendar" /><span className="wide-only">Custom dates</span>
          </button>
          {picking && (
            <Floating anchor={dateBtn} onClose={closeDates}>
            <DatePop
              from={custom.from}
              to={custom.to}
              max={today}
              onApply={(from, to) => { setCustom({ from, to }); setRange('custom'); setPicking(false); }}
            />
            </Floating>
          )}
        </div>
      </PageHead>

      {failed && !ready && <div className="notice">Sylva could not load your numbers. Refresh to try again.</div>}

      <div className="totals" role="group" aria-label="Totals">
        <Total label="Followers" value={now?.follows} before={before?.follows} vs={p.vs} fmt={num} />
        <Total label="Subscribers" value={now ? now.subs + now.gifted : undefined} before={before ? before.subs + before.gifted : undefined} vs={p.vs} fmt={num} />
        <Total label="Tips" value={now?.tips} before={before?.tips} vs={p.vs} fmt={money} />
        <Total label="Raids" value={now?.raids} note={now ? `${num(now.raiders)} ${now.raiders === 1 ? 'viewer' : 'viewers'} brought in` : undefined} fmt={num} />
        <Total label="Bits" value={now?.bits} before={before?.bits} vs={p.vs} fmt={num} wide />
      </div>

      <PerDay stats={s ?? null} metric={metric} setMetric={setMetric} money={money} today={p.lastDayOnly ?? false} />
    </div>
  );
}

/** One total with its change against the stretch before. */
function Total({ label, value, before, vs, note, fmt, wide }: {
  label: string; value?: number; before?: number; vs?: string | null; note?: string; fmt(n: number): string; wide?: boolean;
}) {
  let foot: string | undefined = note;
  if (foot === undefined && value !== undefined) {
    if (!vs || before === undefined) foot = ' ';
    else if (!before) foot = value ? `Up from none ${vs === 'yesterday' ? 'yesterday' : 'in ' + vs}` : `None ${vs === 'yesterday' ? 'yesterday' : 'in ' + vs} either`;
    else {
      const pct = Math.round(((value - before) / before) * 100);
      foot = pct > 0 ? `+${num(pct)}% vs ${vs}` : pct < 0 ? `${num(-pct)}% less than ${vs}` : `Same as ${vs}`;
    }
  }
  return (
    <div className={'grp total' + (wide ? ' wide' : '')}>
      <div className="total-label">{label}</div>
      <div className="total-num">{value === undefined ? <Skel w={96} h={26} /> : fmt(value)}</div>
      <div className="total-foot">{foot === undefined ? <Skel w="70%" h={11} /> : foot}</div>
    </div>
  );
}

interface Bucket { start: number; label: string; long: string; value: number }

/** Day buckets, or months for anything longer than about three months. */
function buckets(s: Stats, metric: Metric): { list: Bucket[]; monthly: boolean } {
  const days = s.series;
  const monthly = days.length > 92;
  if (!monthly) {
    return {
      monthly,
      list: days.map((d) => {
        const at = new Date(d.start);
        return { start: d.start, label: md(at), long: at.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }), value: totalOf(d, metric) };
      }),
    };
  }
  const map = new Map<string, Bucket>();
  for (const d of days) {
    const at = new Date(d.start);
    const k = `${at.getFullYear()}-${at.getMonth()}`;
    let b = map.get(k);
    if (!b) {
      const m0 = new Date(at.getFullYear(), at.getMonth(), 1);
      b = {
        start: m0.getTime(),
        label: m0.toLocaleDateString(undefined, { month: 'short', ...(at.getMonth() === 0 ? { year: '2-digit' } : {}) }),
        long: m0.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        value: 0,
      };
      map.set(k, b);
    }
    b.value += totalOf(d, metric);
  }
  return { monthly, list: [...map.values()] };
}

function PerDay({ stats, metric, setMetric, money, today }: {
  stats: Stats | null; metric: Metric; setMetric(m: Metric): void; money(n: number): string; today: boolean;
}) {
  const [table, setTable] = useState(false);
  const m = METRICS.find((x) => x.id === metric)!;
  const data = stats ? buckets(stats, metric) : null;
  const fmt = (v: number) => (metric === 'tips' ? money(v) : `${num(v)} ${v === 1 ? m.one : m.many}`);
  let best: Bucket | null = null;
  for (const b of data?.list ?? []) if (b.value > 0 && (!best || b.value > best.value)) best = b;
  const unit = data?.monthly ? 'month' : 'day';
  const title = `${m.label} per ${unit}${today ? ', last 7 days' : ''}`;

  return (
    <section className="grp per-day" aria-labelledby="per-day-title">
      <div className="per-day-head">
        <div>
          <h2 id="per-day-title">{title}</h2>
          <p>{!data ? <Skel w={220} h={11} /> : best ? `Best ${unit}: ${best.long}, ${fmt(best.value)}` : `No ${metric === 'tips' ? 'tips' : m.many} in this range yet`}</p>
        </div>
        <div className="wide-only"><Seg label="Chart shows" options={METRICS.map((x) => ({ id: x.id, label: x.label }))} value={metric} onChange={setMetric} /></div>
        <div className="phone-only">
          <Select<Metric> className="sm" label="Chart shows" value={metric} onChange={setMetric}
            options={METRICS.map((x) => ({ value: x.id, label: x.label }))} />
        </div>
      </div>
      {table && data ? (
        <div className="per-day-table">
          <table className="data-table">
            <thead><tr><th scope="col">{data.monthly ? 'Month' : 'Day'}</th><th scope="col">{m.label}</th></tr></thead>
            <tbody>
              {[...data.list].reverse().map((b) => <tr key={b.start}><th scope="row">{b.long}</th><td>{metric === 'tips' ? money(b.value) : num(b.value)}</td></tr>)}
            </tbody>
          </table>
        </div>
      ) : (
        <Bars list={data?.list ?? null} best={best} fmt={fmt} title={title} money={metric === 'tips'} />
      )}
      <div className="per-day-foot">
        <button className="btn sm link" type="button" disabled={!data} onClick={() => setTable(!table)} aria-pressed={table}>
          <Icon id={table ? 'chart' : 'chevron'} />{table ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
    </section>
  );
}

/** Rounded top bars on quiet gridlines; the best bar and the one under the pointer are lighter. */
function Bars({ list, best, fmt, title, money }: { list: Bucket[] | null; best: Bucket | null; fmt(v: number): string; title: string; money: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const phone = width > 0 && width < 520;
  const h = phone ? 200 : 320;
  const pl = 40, pr = 4, pt = 52, pb = 26;
  const iw = Math.max(0, width - pl - pr), ih = h - pt - pb;

  if (!list || width === 0) {
    return <div ref={ref} className="bars" style={{ height: h }}>{list === null && width > 0 && <div className="bars-skel" style={{ top: pt, bottom: pb, left: pl }} />}{list === null && width === 0 && null}</div>;
  }
  const max = Math.max(0, ...list.map((b) => b.value));
  const { top, step } = niceMax(max, 3);
  const n = list.length;
  const slot = iw / Math.max(1, n);
  const gap = Math.min(8, Math.max(2, slot * 0.22));
  const bw = Math.max(1, slot - gap);
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / (phone ? 56 : 64)))));
  const y = (v: number) => pt + ih - (top ? (ih * v) / top : 0);
  const ticks: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  const tickText = (t: number) => (money ? short(t) : short(t));
  const shown = hover ?? null;
  const tip = shown !== null ? list[shown] : null;
  const tipW = 132, tipH = 42;
  const tipX = tip ? Math.min(Math.max(pl + shown! * slot + slot / 2 - tipW / 2, pl), width - pr - tipW) : 0;
  const tipY = tip ? Math.max(2, y(tip.value) - tipH - 10) : 0;

  return (
    <div ref={ref} className="bars" style={{ height: h }}>
      <svg
        ref={svgRef}
        className="chart"
        width={width}
        height={h}
        viewBox={`0 0 ${width} ${h}`}
        role="img"
        aria-label={`${title}. ${best ? `Highest ${best.long} with ${fmt(best.value)}.` : 'Nothing yet.'} Use Show as table for every number.`}
        onMouseLeave={() => setHover(null)}
      >
        <g className="grid">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pl} x2={width - pr} y1={y(t)} y2={y(t)} className={t === 0 ? 'baseline' : undefined} />
              <text x={pl - 8} y={y(t) + 4} textAnchor="end">{tickText(t)}</text>
            </g>
          ))}
        </g>
        {list.map((b, i) => {
          const x = pl + i * slot + gap / 2;
          const yy = y(b.value);
          const bh = pt + ih - yy;
          const r = Math.min(4, bw / 2, bh);
          const d = bh <= 0 ? '' : `M${x},${pt + ih}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${pt + ih}Z`;
          const lit = hover === i || (hover === null && best === b);
          return (
            <g key={b.start}>
              {d && <path d={d} className={'bar' + (lit ? ' on' : '')} />}
              <rect
                className="hit"
                x={pl + i * slot}
                y={pt}
                width={slot}
                height={ih}
                tabIndex={-1}
                onMouseEnter={() => setHover(i)}
                onTouchStart={() => setHover(i)}
              />
            </g>
          );
        })}
        {list.map((b, i) => (i % every === 0 ? (
          <text key={'l' + b.start} className="axis" x={pl + i * slot + slot / 2} y={h - 8} textAnchor="middle">{b.label}</text>
        ) : null))}
        {tip && (
          <g aria-hidden="true" pointerEvents="none">
            <rect className="tip-box" x={tipX} y={tipY} width={tipW} height={tipH} rx={8} />
            <text className="tip-k" x={tipX + 12} y={tipY + 17}>{tip.label}</text>
            <text className="tip-v" x={tipX + 12} y={tipY + 34}>{fmt(tip.value)}</text>
          </g>
        )}
      </svg>
    </div>
  );
}

/** From and to dates for a custom range. */
function DatePop({ from, to, max, onApply }: { from: string; to: string; max: string; onApply(from: string, to: string): void }) {
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const okay = a && b && a <= b && b <= max && daysBetween(fromIso(a), fromIso(b)) < 3660;
  return (
    <form className="pop date-pop" onSubmit={(e) => { e.preventDefault(); if (okay) onApply(a, b); }}>
      <label className="field">From<input className="input" type="date" value={a} max={b || max} onChange={(e) => setA(e.target.value)} required /></label>
      <label className="field">To<input className="input" type="date" value={b} min={a} max={max} onChange={(e) => setB(e.target.value)} required /></label>
      <button className="btn primary" type="submit" disabled={!okay}>Show these dates</button>
    </form>
  );
}

// The Stats page: how the channel is doing over 7, 30 or 90 days or a year,
// compared with the period before. Growth numbers first, then every other
// number in a dense grid, a daily chart with the period before behind it,
// and tabs for streams, viewers, supporters and chat. Worked out by the channel from its event log
// (workers/edge/src/stats.rs); viewer counts are sampled while live.

import NumberFlow from '@number-flow/react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Recap, type StatTotals, type Stats } from './api';
import { useChannel } from './channel';
import { DayBars, Heatmap, RankList, Sparkline, TimeLine } from './charts';
import { PageHead } from './pages';
import { Icon, num } from './ui';

const RANGES = [7, 30, 90, 365] as const;
const RANGE_KEY = 'sylva.statsDays';

function savedRange(): number {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    return (RANGES as readonly number[]).includes(v) ? v : 30;
  } catch { return 30; }
}

/** Load stats for a range; shared by the Stats page and the Overview tiles. */
export function useStats(days: number) {
  const ch = useChannel();
  const [data, setData] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    api.stats(ch.key, days).then((s) => live && setData(s)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [ch.key, days]);
  return { data: data && data.days === days ? data : null, stale: data, failed };
}

/** Percent change against the period before, or null when there is nothing to compare. */
export function change(now: number, before: number): number | null {
  if (!before) return now ? null : 0;
  return ((now - before) / before) * 100;
}

export function Delta({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) return <span className="delta new" title={label}>New</span>;
  const r = Math.round(pct) || 0;
  const cls = r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
  const text = (r > 0 ? '+' : '') + num(r) + '%';
  return <span className={'delta ' + cls} title={label}><span className="sr-only">{r > 0 ? 'Up' : r < 0 ? 'Down' : 'No change'} </span>{text}</span>;
}

export function Kpi({ c, label, value, pct, spark, note, unit }: {
  c: string; label: string; value: number | null; pct?: number | null; spark?: number[]; note: string; unit?: string;
}) {
  return (
    <div className={'card kpi ' + c}>
      <span className="kpi-label"><span className="bar" />{label}</span>
      <div className="kpi-num">
        {value === null ? '-' : <NumberFlow value={value} />}{unit && value !== null && <small>{unit}</small>}
        {pct !== undefined && value !== null && <Delta pct={pct} label={note} />}
      </div>
      <div className="kpi-foot">
        <span>{note}</span>
        {spark && <Sparkline values={spark} />}
      </div>
    </div>
  );
}

type MetricKey = 'follows' | 'subs' | 'gifted' | 'bits' | 'chat' | 'chatters' | 'raids' | 'raiders' | 'redemptions';
const METRICS: { key: MetricKey; label: string; c: string }[] = [
  { key: 'follows', label: 'Followers', c: 'c-follow' },
  { key: 'subs', label: 'New subs', c: 'c-sub' },
  { key: 'gifted', label: 'Gifted subs', c: 'c-gift' },
  { key: 'bits', label: 'Bits', c: 'c-bits' },
  { key: 'chat', label: 'Chat messages', c: 'c-chat' },
  { key: 'chatters', label: 'Chatters', c: 'c-raid' },
  { key: 'raids', label: 'Raids', c: 'c-raid' },
  { key: 'raiders', label: 'Raid viewers', c: 'c-raid' },
  { key: 'redemptions', label: 'Redemptions', c: 'c-reward' },
];

const hours = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const streamDay = (at: number) => new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const one = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

type Tab = 'streams' | 'viewers' | 'people' | 'chat';
const TABS: { id: Tab; label: string }[] = [
  { id: 'streams', label: 'Streams' },
  { id: 'viewers', label: 'Viewers' },
  { id: 'people', label: 'Top supporters' },
  { id: 'chat', label: 'Chat' },
];
const RANGE_NAMES: Record<number, string> = { 7: '7 days', 30: '30 days', 90: '90 days', 365: '1 year' };

/** One small number in the metric grid, with its change when there is something to compare. */
function Cell({ label, value, before, text, hint }: { label: string; value: number | null; before?: number | null; text?: string; hint?: string }) {
  return (
    <div className="cell" title={hint}>
      <span className="cell-label">{label}</span>
      <span className="cell-num">{value === null ? '-' : text ?? num(value)}</span>
      {value !== null && before !== undefined && before !== null && <Delta pct={change(value, before)} label="vs the period before" />}
    </div>
  );
}

/** The daily numbers as a CSV file, for spreadsheets. */
function exportCsv(s: Stats) {
  const cols: (keyof StatTotals)[] = ['follows', 'subs', 'gifted', 'bits', 'raids', 'raiders', 'tips', 'redemptions', 'chat', 'chatters'];
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA');
  const lines = [['date', ...cols].join(','), ...s.series.map((d) => [day(d.start), ...cols.map((c) => d[c])].join(','))];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
  a.download = `sylva-stats-${day(s.from)}-${s.days}d.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function StatsPage() {
  const [days, setDays] = useState(savedRange);
  const { data, stale, failed } = useStats(days);
  const s = data ?? stale;
  const [tab, setTab] = useState<Tab>('streams');
  const [metric, setMetric] = useState<MetricKey>('follows');
  const [compare, setCompare] = useState(true);
  const [board, setBoard] = useState<'chat' | 'cheer' | 'gift' | 'raid'>('chat');

  const pick = (d: number) => {
    setDays(d);
    try { localStorage.setItem(RANGE_KEY, String(d)); } catch { /* private window */ }
  };

  const starts = s ? s.series.map((d) => d.start) : [];
  const col = (k: keyof StatTotals) => (s ? s.series.map((d) => d[k]) : []);
  const t = s?.totals, p = s?.previous, b4 = s?.before;
  const vs = `vs the ${RANGE_NAMES[days] ?? `${days} days`} before`;

  const streams = s?.streams ?? [];
  const viewerStats = useMemo(() => {
    const v = s?.viewers ?? [];
    if (!v.length) return null;
    return { peak: Math.max(...v.map((x) => x.viewers)), avg: Math.round(v.reduce((a, x) => a + x.viewers, 0) / v.length) };
  }, [s]);
  const liveMs = streams.reduce((a, r) => a + ((r.endedAt ?? Date.now()) - r.startedAt), 0);
  const liveH = liveMs / 3_600_000, prevH = (b4?.liveMs ?? 0) / 3_600_000;
  const returning = t && s ? Math.max(0, t.chatters - s.newChatters) : null;
  const prevReturning = p && b4 ? Math.max(0, p.chatters - b4.newChatters) : null;

  const m = METRICS.find((x) => x.key === metric)!;
  const mainTotal = t ? t[metric] : 0;
  const mainPrev = p ? p[metric] : 0;

  const boards = {
    chat: { label: 'Chatters', rows: s?.topChatters ?? [], unit: 'messages', c: 'c-chat', empty: 'Nobody has chatted in this range yet.' },
    cheer: { label: 'Cheerers', rows: s?.topCheerers ?? [], unit: 'bits', c: 'c-bits', empty: 'No cheers in this range yet.' },
    gift: { label: 'Gifters', rows: s?.topGifters ?? [], unit: 'subs', c: 'c-gift', empty: 'No gifted subs in this range yet.' },
    raid: { label: 'Raiders', rows: s?.topRaiders ?? [], unit: 'viewers', c: 'c-raid', empty: 'No raids in this range yet.' },
  };
  const board_ = boards[board];

  return (
    <div className="page page-wide">
      <PageHead title="Stats">
        <button className="btn" type="button" disabled={!data} onClick={() => data && exportCsv(data)}><Icon id="download" />Export CSV</button>
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={days === r} onClick={() => pick(r)}>{RANGE_NAMES[r]}</button>
          ))}
        </div>
      </PageHead>

      {failed && !s && <div className="notice">Could not load your stats. Refresh to try again.</div>}

      <h2 className="section-label">Growth</h2>
      <div className={'kpis four' + (s && !data ? ' loading' : '')} role="group" aria-label="Growth">
        <Kpi c="c-follow" label="Followers gained" value={t ? t.follows : null} pct={t && p ? change(t.follows, p.follows) : undefined} spark={col('follows')} note={vs} />
        <Kpi c="c-sub" label="Subs and gifts" value={t ? t.subs + t.gifted : null} pct={t && p ? change(t.subs + t.gifted, p.subs + p.gifted) : undefined} note={vs}
          spark={s ? s.series.map((d) => d.subs + d.gifted) : []} />
        <Kpi c="c-viewers" label="Average viewers" value={s ? viewerStats?.avg ?? null : null}
          pct={viewerStats && b4?.avgViewers ? change(viewerStats.avg, b4.avgViewers) : undefined}
          note={viewerStats ? `Peak ${num(viewerStats.peak)}, ${vs}` : 'Counted while you are live'} />
        <Kpi c="c-chat" label="New chatters" value={s ? s.newChatters : null} pct={s && b4 ? change(s.newChatters, b4.newChatters) : undefined}
          note="First message ever" spark={col('chatters')} />
      </div>

      <h2 className="section-label">Everything else</h2>
      <div className={'card cells' + (s && !data ? ' loading' : '')} role="group" aria-label="More numbers">
        <Cell label="Peak viewers" value={s ? viewerStats?.peak ?? null : null} before={b4?.peakViewers} />
        <Cell label="Hours live" value={s ? liveH : null} text={hours(liveMs)} before={b4 ? prevH : undefined} />
        <Cell label="Streams" value={s ? streams.length : null} before={b4?.streams} />
        <Cell label="Average stream" value={s && streams.length ? liveMs / streams.length : null} text={hours(streams.length ? liveMs / streams.length : 0)}
          before={b4 && b4.streams ? b4.liveMs / b4.streams : undefined} />
        <Cell label="Followers per hour live" value={t && liveH ? t.follows / liveH : null} text={t && liveH ? one.format(t.follows / liveH) : undefined}
          before={p && prevH ? p.follows / prevH : undefined} hint="Followers gained divided by hours live" />
        <Cell label="New subs" value={t ? t.subs : null} before={p?.subs} />
        <Cell label="Gifted subs" value={t ? t.gifted : null} before={p?.gifted} />
        <Cell label="Bits" value={t ? t.bits : null} before={p?.bits} />
        <Cell label="Raids received" value={t ? t.raids : null} before={p?.raids} />
        <Cell label="Raid viewers" value={t ? t.raiders : null} before={p?.raiders} />
        <Cell label="Chat messages" value={t ? t.chat : null} before={p?.chat} />
        <Cell label="People who chatted" value={t ? t.chatters : null} before={p?.chatters} />
        <Cell label="Returning chatters" value={returning} before={prevReturning} hint="Chatted before this range too" />
        <Cell label="Messages per chatter" value={t && t.chatters ? t.chat / t.chatters : null} text={t && t.chatters ? one.format(t.chat / t.chatters) : undefined}
          before={p && p.chatters ? p.chat / p.chatters : undefined} />
        <Cell label="Redemptions" value={t ? t.redemptions : null} before={p?.redemptions} />
      </div>

      <section className="card chart-card" aria-labelledby="trend-title">
        <div className="card-head">
          <div>
            <h2 id="trend-title">{m.label} each day</h2>
            {s && <p><b className="big-num">{num(mainTotal)}</b> in {RANGE_NAMES[days] ? `the last ${RANGE_NAMES[days]}` : 'this range'} <DeltaInline now={mainTotal} before={mainPrev} /></p>}
          </div>
          <div className="trend-tools">
            <label className="check-pill">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />Compare with the period before
            </label>
            <select className="select sm fit" aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
              {METRICS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
          </div>
        </div>
        <div className="card-body">
          {s
            ? <DayBars starts={starts} series={[{ key: metric, label: m.label, c: m.c, values: col(metric) }]} ghost={compare ? s.previousSeries?.map((d) => d[metric]) : undefined} height={280} />
            : <div className="chart-skeleton" style={{ height: 280 }} />}
        </div>
      </section>

      <div className="tabs" role="tablist" aria-label="Details">
        {TABS.map((x) => (
          <button key={x.id} role="tab" id={'tab-' + x.id} aria-selected={tab === x.id} aria-controls="stats-panel" type="button" onClick={() => setTab(x.id)}>{x.label}</button>
        ))}
      </div>

      <section className="card" id="stats-panel" role="tabpanel" aria-labelledby={'tab-' + tab}>
        {tab === 'viewers' && (
          <>
            <div className="card-head"><div>
              <h2>{s && s.days > 7 ? 'Peak viewers each day' : 'Viewers while live'}</h2>
              <p>{viewerStats ? `Peak ${num(viewerStats.peak)}, average ${num(viewerStats.avg)}` : 'Sylva asks Twitch every 5 minutes while you are live'}</p>
            </div></div>
            <div className="card-body">
              {s && s.viewers.length > 0
                ? <TimeLine points={viewerPoints(s)} gap={s.days > 7 ? 5 * 86_400_000 : 20 * 60_000} from={s.from} to={s.from + s.days * 86_400_000} height={280} label={s.days > 7 ? 'Peak viewers each day' : 'Viewers over time'} />
                : <Empty text="Viewer counts start with your next stream." />}
            </div>
          </>
        )}
        {tab === 'streams' && (
          <>
            <div className="card-head"><div>
              <h2>Each stream</h2>
              <p>{streams.length ? `${num(streams.length)} streams, ${hours(liveMs)} live. Pick a column to sort.` : 'Streams show here once they end.'}</p>
            </div></div>
            {streams.length ? <StreamTable streams={streams} /> : <div className="card-body"><Empty text="After your next stream ends it shows here next to the others." /></div>}
          </>
        )}
        {tab === 'people' && (
          <>
            <div className="card-head">
              <div><h2>Top {board_.label.toLowerCase()}</h2><p>{RANGE_NAMES[days] ? `The last ${RANGE_NAMES[days]}` : ''}</p></div>
              <div className="segmented sm" role="group" aria-label="Who">
                {Object.entries(boards).map(([k, v]) => (
                  <button key={k} type="button" aria-pressed={board === k} onClick={() => setBoard(k as typeof board)}>{v.label}</button>
                ))}
              </div>
            </div>
            <div className="card-body narrow"><RankList rows={board_.rows} unit={board_.unit} c={board_.c} empty={board_.empty} /></div>
          </>
        )}
        {tab === 'chat' && (
          <div className="chat-tab">
            <div>
              <div className="card-head"><div><h2>When chat is busiest</h2><p>Messages by weekday and hour, in your time</p></div></div>
              <div className="card-body">{s ? <Heatmap cells={s.heatmap} /> : <div className="chart-skeleton" style={{ height: 180 }} />}</div>
            </div>
            <div>
              <div className="card-head"><div><h2>Commands used most</h2><p>{t ? `${num(t.chat)} messages in total` : ''}</p></div></div>
              <div className="card-body"><RankList rows={s?.commands ?? []} unit="uses" c="c-reward" empty="No commands used in this range yet." /></div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** Every sample for a week; for longer ranges, each day's peak at midday. */
function viewerPoints(s: Stats) {
  if (s.days <= 7) return s.viewers.map((v) => ({ at: v.at, value: v.viewers }));
  const peaks = new Map<number, number>();
  for (const v of s.viewers) {
    const d = Math.floor((v.at - s.from) / 86_400_000);
    peaks.set(d, Math.max(peaks.get(d) ?? 0, v.viewers));
  }
  return [...peaks].sort((a, b) => a[0] - b[0]).map(([d, value]) => ({ at: s.from + d * 86_400_000 + 43_200_000, value }));
}

function DeltaInline({ now, before }: { now: number; before: number }) {
  const pct = change(now, before);
  if (pct === null || !before) return null;
  return <Delta pct={pct} label="vs the period before" />;
}

function Empty({ text }: { text: string }) {
  return <div className="chart-empty"><p>{text}</p></div>;
}

type SortKey = 'startedAt' | 'length' | 'peakViewers' | 'avgViewers' | 'follows' | 'subs' | 'bits' | 'chatLines' | 'chatters';
const COLS: { key: SortKey; label: string; c?: string }[] = [
  { key: 'startedAt', label: 'Stream' },
  { key: 'length', label: 'Length' },
  { key: 'peakViewers', label: 'Peak viewers', c: 'c-viewers' },
  { key: 'avgViewers', label: 'Avg viewers', c: 'c-viewers' },
  { key: 'follows', label: 'Followers', c: 'c-follow' },
  { key: 'subs', label: 'Subs', c: 'c-sub' },
  { key: 'bits', label: 'Bits', c: 'c-bits' },
  { key: 'chatLines', label: 'Messages', c: 'c-chat' },
  { key: 'chatters', label: 'Chatters', c: 'c-raid' },
];

function StreamTable({ streams }: { streams: Recap[] }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'startedAt', desc: true });
  const [all, setAll] = useState(false);
  const val = (r: Recap, k: SortKey): number =>
    k === 'length' ? (r.endedAt ?? Date.now()) - r.startedAt
      : k === 'subs' ? r.subs + r.gifted
        : k === 'peakViewers' || k === 'avgViewers' ? r[k] ?? 0
          : (r[k] as number);
  const rows = [...streams].sort((a, b) => (sort.desc ? val(b, sort.key) - val(a, sort.key) : val(a, sort.key) - val(b, sort.key)));
  const max = Object.fromEntries(COLS.map((c) => [c.key, Math.max(1, ...streams.map((r) => val(r, c.key)))]));
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                <button type="button" onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : true }))}>
                  {c.label}{sort.key === c.key && <span aria-hidden="true">{sort.desc ? ' ↓' : ' ↑'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, all ? undefined : 10).map((r) => (
            <tr key={r.startedAt}>
              <th scope="row">
                {!r.endedAt && <span className="live-pill">Live</span>}
                {streamDay(r.startedAt)}
              </th>
              <td>{hours(val(r, 'length'))}</td>
              {COLS.slice(2).map((c) => {
                const v = val(r, c.key);
                const missing = (c.key === 'peakViewers' || c.key === 'avgViewers') && r[c.key] == null;
                return (
                  <td key={c.key} className={c.c}>
                    {missing ? <span className="faint">-</span> : <span className="cell-bar"><i style={{ width: `${(v / max[c.key]) * 100}%` }} />{num(v)}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 10 && (
        <div className="card-foot"><span className="card-text">{all ? `All ${rows.length} streams` : `10 of ${rows.length} streams`}</span>
          <button className="btn sm" type="button" onClick={() => setAll(!all)}>{all ? 'Show fewer' : 'Show all'}</button></div>
      )}
    </div>
  );
}

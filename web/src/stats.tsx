// The Stats page: how the channel is doing over 7, 30 or 90 days, compared
// with the period before. Worked out by the channel from its event log
// (workers/edge/src/stats.rs); viewer counts are sampled while live.

import { useEffect, useMemo, useState } from 'react';
import { api, type Recap, type StatTotals, type Stats } from './api';
import { useChannel } from './channel';
import { DayBars, Heatmap, RankList, Sparkline, TimeLine, type Series } from './charts';
import { Card, PageHead } from './pages';
import { num } from './ui';

const RANGES = [7, 30, 90] as const;
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
        {num(value)}{unit && value !== null && <small>{unit}</small>}
        {pct !== undefined && value !== null && <Delta pct={pct} label={note} />}
      </div>
      <div className="kpi-foot">
        <span>{note}</span>
        {spark && <Sparkline values={spark} />}
      </div>
    </div>
  );
}

type MetricKey = 'follows' | 'subs' | 'bits' | 'chat' | 'chatters' | 'raiders';
const METRICS: { key: MetricKey; label: string; c: string; unit: string }[] = [
  { key: 'follows', label: 'Followers', c: 'c-follow', unit: 'followers' },
  { key: 'subs', label: 'Subs', c: 'c-sub', unit: 'subs' },
  { key: 'bits', label: 'Bits', c: 'c-bits', unit: 'bits' },
  { key: 'chat', label: 'Chat messages', c: 'c-chat', unit: 'messages' },
  { key: 'chatters', label: 'Chatters', c: 'c-raid', unit: 'people' },
  { key: 'raiders', label: 'Raid viewers', c: 'c-raid', unit: 'viewers' },
];

const hours = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const streamDay = (at: number) => new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function StatsPage() {
  const [days, setDays] = useState(savedRange);
  const { data, stale, failed } = useStats(days);
  const s = data ?? stale;
  const [metric, setMetric] = useState<MetricKey>('follows');
  const [board, setBoard] = useState<'chat' | 'cheer' | 'gift' | 'raid'>('chat');

  const pick = (d: number) => {
    setDays(d);
    try { localStorage.setItem(RANGE_KEY, String(d)); } catch { /* private window */ }
  };

  const starts = s ? s.series.map((d) => d.start) : [];
  const col = (k: keyof StatTotals) => (s ? s.series.map((d) => d[k]) : []);
  const subsAll = s ? s.series.map((d) => d.subs + d.gifted) : [];
  const t = s?.totals, p = s?.previous;
  const vs = `vs prior ${days}d`;

  const streams = s?.streams ?? [];
  const viewerStats = useMemo(() => {
    const v = s?.viewers ?? [];
    if (!v.length) return null;
    const peak = Math.max(...v.map((x) => x.viewers));
    const avg = Math.round(v.reduce((a, x) => a + x.viewers, 0) / v.length);
    return { peak, avg };
  }, [s]);
  const hoursLive = streams.reduce((a, r) => a + ((r.endedAt ?? Date.now()) - r.startedAt), 0);

  const m = METRICS.find((x) => x.key === metric)!;
  const mainSeries: Series[] = metric === 'subs'
    ? [
      { key: 'subs', label: 'Subs', c: 'c-sub', values: col('subs') },
      { key: 'gifted', label: 'Gifted subs', c: 'c-gift', values: col('gifted') },
    ]
    : [{ key: metric, label: m.label, c: m.c, values: col(metric) }];
  const mainTotal = metric === 'subs' ? (t ? t.subs + t.gifted : 0) : t ? t[metric] : 0;
  const mainPrev = metric === 'subs' ? (p ? p.subs + p.gifted : 0) : p ? p[metric] : 0;

  const mix: Series[] = [
    { key: 'f', label: 'Follows', c: 'c-follow', values: col('follows') },
    { key: 's', label: 'Subs', c: 'c-sub', values: col('subs') },
    { key: 'g', label: 'Gifted subs', c: 'c-gift', values: col('gifted') },
    { key: 'r', label: 'Raids', c: 'c-raid', values: col('raids') },
  ];

  const boards = {
    chat: { label: 'Chatters', rows: s?.topChatters ?? [], unit: 'messages', c: 'c-chat', empty: 'Nobody has chatted in this range yet.' },
    cheer: { label: 'Cheerers', rows: s?.topCheerers ?? [], unit: 'bits', c: 'c-bits', empty: 'No cheers in this range yet.' },
    gift: { label: 'Gifters', rows: s?.topGifters ?? [], unit: 'subs', c: 'c-gift', empty: 'No gifted subs in this range yet.' },
    raid: { label: 'Raiders', rows: s?.topRaiders ?? [], unit: 'viewers', c: 'c-raid', empty: 'No raids in this range yet.' },
  };
  const b = boards[board];

  return (
    <div className="page page-wide">
      <PageHead title="Stats" desc="How your channel is growing, when chat is busiest and how each stream compares.">
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={days === r} onClick={() => pick(r)}>{r} days</button>
          ))}
        </div>
      </PageHead>

      {failed && !s && <div className="notice">Could not load your stats. Refresh to try again.</div>}

      <div className={'kpis' + (s && !data ? ' loading' : '')} role="group" aria-label={`Last ${days} days`}>
        <Kpi c="c-follow" label="New followers" value={t ? t.follows : null} pct={t && p ? change(t.follows, p.follows) : undefined} spark={col('follows')} note={vs} />
        <Kpi c="c-sub" label="Subs and gifts" value={t ? t.subs + t.gifted : null} pct={t && p ? change(t.subs + t.gifted, p.subs + p.gifted) : undefined} spark={subsAll} note={vs} />
        <Kpi c="c-bits" label="Bits" value={t ? t.bits : null} pct={t && p ? change(t.bits, p.bits) : undefined} spark={col('bits')} note={vs} />
        <Kpi c="c-chat" label="Chat messages" value={t ? t.chat : null} pct={t && p ? change(t.chat, p.chat) : undefined} spark={col('chat')} note={vs} />
        <Kpi c="c-raid" label="Unique chatters" value={t ? t.chatters : null} pct={t && p ? change(t.chatters, p.chatters) : undefined} spark={col('chatters')} note={vs} />
        <Kpi
          c="c-viewers" label="Average viewers" value={s ? viewerStats?.avg ?? 0 : null}
          note={viewerStats ? `Peak ${num(viewerStats.peak)} · ${hours(hoursLive)} live` : streams.length ? `${hours(hoursLive)} live` : 'Counted while live'}
        />
      </div>

      <Card
        id="trend"
        className="chart-card"
        title={m.label}
        desc={s ? <><b className="big-num">{num(mainTotal)}</b> in the last {days} days <DeltaInline now={mainTotal} before={mainPrev} /></> : 'Loading'}
        action={
          <div className="segmented sm metric-tabs" role="group" aria-label="Metric">
            {METRICS.map((x) => (
              <button key={x.key} type="button" aria-pressed={metric === x.key} onClick={() => setMetric(x.key)}>{x.label}</button>
            ))}
          </div>
        }
      >
        <div className="card-body">
          {mainSeries.length > 1 && <Legend series={mainSeries} />}
          {s ? <DayBars starts={starts} series={mainSeries} height={260} /> : <div className="chart-skeleton" style={{ height: 260 }} />}
        </div>
      </Card>

      <div className="grid-2 stats-grid">
        <Card id="viewers" className="chart-card" title="Viewers" desc={viewerStats ? `Peak ${num(viewerStats.peak)}, average ${num(viewerStats.avg)}` : 'Sampled every 5 minutes while you are live'}>
          <div className="card-body">
            {s && s.viewers.length > 0
              ? <TimeLine points={viewerPoints(s)} gap={s.days > 7 ? 5 * 86_400_000 : 20 * 60_000} from={s.from} to={s.from + s.days * 86_400_000} label={s.days > 7 ? 'Peak viewers each day' : 'Viewers over time'} />
              : <Empty text="Viewer counts start with your next stream. Sylva asks Twitch every 5 minutes while you are live." />}
          </div>
        </Card>
        <Card id="mix" className="chart-card" title="Community growth" desc="Follows, subs, gifts and raids each day">
          <div className="card-body">
            <Legend series={mix} />
            {s ? <DayBars starts={starts} series={mix} height={220} unit="events" /> : <div className="chart-skeleton" style={{ height: 220 }} />}
          </div>
        </Card>
      </div>

      <Card id="streams-table" title="Streams" desc={streams.length ? `${num(streams.length)} streams, ${hours(hoursLive)} live in the last ${days} days` : undefined}>
        {streams.length ? <StreamTable streams={streams} /> : <div className="card-body"><Empty text="After your next stream ends it shows here, side by side with the others: length, viewers, followers, subs, bits and chat." /></div>}
      </Card>

      <div className="grid-3 stats-grid">
        <Card
          id="leaders"
          title="Top supporters"
          action={
            <select className="select sm fit" aria-label="Leaderboard" value={board} onChange={(e) => setBoard(e.target.value as typeof board)}>
              {Object.entries(boards).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          }
        >
          <div className="card-body"><RankList rows={b.rows} unit={b.unit} c={b.c} empty={b.empty} /></div>
        </Card>
        <Card id="commands" title="Commands used" desc="Chat lines that start with !">
          <div className="card-body"><RankList rows={s?.commands ?? []} unit="uses" c="c-reward" empty="No commands used in this range yet." /></div>
        </Card>
        <Card id="heat" title="When chat is busiest" desc="Messages by weekday and hour, your time">
          <div className="card-body">{s ? <Heatmap cells={s.heatmap} /> : <div className="chart-skeleton" style={{ height: 180 }} />}</div>
        </Card>
      </div>
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

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="legend" aria-label="Legend">
      {series.map((s) => <li key={s.key} className={s.c}><i />{s.label}</li>)}
    </ul>
  );
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

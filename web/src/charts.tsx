// Small SVG charts for the Stats and Overview pages. No chart library: each
// chart measures its box, draws thin marks on recessive gridlines, and shows
// a tooltip on hover or keyboard focus. Colors come from the kind tokens.

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { num } from './ui';

/** The width of an element, kept up to date as it resizes. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round axis steps: 1, 2 or 5 times a power of ten. */
export function niceMax(max: number, ticks = 4): { top: number; step: number } {
  if (max <= 0) return { top: ticks, step: 1 };
  const raw = max / ticks;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const s = step < 1 ? 1 : step;
  return { top: Math.ceil(max / s) * s, step: s };
}

export const short = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k'
      : String(Math.round(n));

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const dayLabel = (ms: number) => dayFmt.format(ms);

/** A tiny trend line for stat tiles. Decorative: the number beside it says it. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const w = 120, h = 32;
  if (values.length < 2) return <svg className={'spark ' + (className || '')} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" />;
  const max = Math.max(1, ...values);
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => h - 2 - (v / max) * (h - 6);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg className={'spark ' + (className || '')} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="spark-area" d={`${line}L${w},${h}L0,${h}Z`} />
      <path className="spark-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface Tip { x: number; y: number; body: ReactNode }

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 70), Math.max(70, width - 70));
  return <div className="chart-tip" style={{ left, top: tip.y }} role="status">{tip.body}</div>;
}

export interface Series { key: string; label: string; c: string; values: number[] }

/**
 * Bars per day, one series or several stacked. `starts` are the days' local
 * midnights. One y axis, gridlines at round steps, a 2px gap between stacked
 * pieces, and a tooltip listing every series for the day under the pointer.
 */
export function DayBars({ starts, series, height = 220, unit }: {
  starts: number[]; series: Series[]; height?: number; unit?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = starts.length;
  const totals = starts.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const { top, step } = niceMax(Math.max(0, ...totals));
  const padL = 36, padB = 24, padT = 8;
  const plotW = Math.max(0, width - padL - 4);
  const plotH = height - padB - padT;
  const slot = n ? plotW / n : 0;
  const barW = Math.max(2, Math.min(28, slot * 0.62));
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const ticks: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64))));
  const tip: Tip | null = hover === null ? null : {
    x: padL + slot * hover + slot / 2,
    y: y(totals[hover]) - 8,
    body: (
      <>
        <b>{longDay.format(starts[hover])}</b>
        {series.map((s) => (
          <span key={s.key} className={'tip-row ' + s.c}><i />{s.label}<em>{num(s.values[hover] || 0)}</em></span>
        ))}
        {series.length > 1 && <span className="tip-row total">Total<em>{num(totals[hover])}{unit ? ' ' + unit : ''}</em></span>}
      </>
    ),
  };
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${series.map((s) => s.label).join(', ')} by day`}>
          {ticks.map((t) => (
            <g key={t} className="grid">
              <line x1={padL} x2={width} y1={y(t)} y2={y(t)} />
              <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end">{short(t)}</text>
            </g>
          ))}
          {starts.map((d, i) => {
            const cx = padL + slot * i + slot / 2;
            let acc = 0;
            return (
              <g key={d} className={hover !== null && hover !== i ? 'dim' : undefined}>
                {series.map((s, si) => {
                  const v = s.values[i] || 0;
                  if (!v) return null;
                  const y0 = y(acc), y1 = y(acc + v);
                  acc += v;
                  const gap = si > 0 ? 1 : 0;
                  const hgt = Math.max(1, y0 - y1 - gap);
                  const isTop = series.slice(si + 1).every((o) => !(o.values[i] || 0));
                  const r = isTop ? Math.min(3, barW / 2, hgt) : 0;
                  const x0 = cx - barW / 2, yt = y1, yb = y1 + hgt;
                  const d2 = `M${x0},${yb}V${yt + r}Q${x0},${yt} ${x0 + r},${yt}H${x0 + barW - r}Q${x0 + barW},${yt} ${x0 + barW},${yt + r}V${yb}Z`;
                  return <path key={s.key} className={'bar ' + s.c} d={d2} />;
                })}
                {i % every === 0 && (
                  <text className="axis" x={cx} y={height - 6} textAnchor="middle">{dayLabel(d)}</text>
                )}
                <rect
                  className="hit" x={padL + slot * i} y={padT} width={slot} height={plotH}
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            );
          })}
          <line className="baseline" x1={padL} x2={width} y1={y(0)} y2={y(0)} />
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/** A line over time (viewer counts), with an area under it and a crosshair. */
export function TimeLine({ points, from, to, height = 220, label, gap = 20 * 60_000 }: {
  points: { at: number; value: number }[]; from: number; to: number; height?: number; label: string; gap?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { top, step } = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const padL = 36, padB = 24, padT = 8;
  const plotW = Math.max(1, width - padL - 4);
  const plotH = height - padB - padT;
  const x = (t: number) => padL + ((t - from) / Math.max(1, to - from)) * plotW;
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const ticks: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);

  // Break the line where samples are further apart than `gap` (offline).
  const runs: { at: number; value: number }[][] = [];
  for (const p of points) {
    const last = runs[runs.length - 1];
    if (last && p.at - last[last.length - 1].at <= gap) last.push(p);
    else runs.push([p]);
  }
  const days = Math.round((to - from) / 86_400_000);
  const labelEvery = Math.max(1, Math.ceil(days / Math.max(1, Math.floor(plotW / 64))));
  const dayTicks: number[] = [];
  for (let d = 0; d < days; d += labelEvery) dayTicks.push(from + d * 86_400_000);

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    if (!points.length) return;
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const t = from + ((e.clientX - box.left) / box.width) * (to - from);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].at - t) < Math.abs(points[best].at - t)) best = i;
    setHover(best);
  };
  const hp = hover === null ? null : points[hover];
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t} className="grid">
              <line x1={padL} x2={width} y1={y(t)} y2={y(t)} />
              <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end">{short(t)}</text>
            </g>
          ))}
          {dayTicks.map((d) => <text key={d} className="axis" x={x(d + 43_200_000)} y={height - 6} textAnchor="middle">{dayLabel(d)}</text>)}
          {runs.map((r) => {
            const line = r.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
            return (
              <g key={r[0].at}>
                {r.length > 1 && <path className="area" d={`${line}L${x(r[r.length - 1].at)},${y(0)}L${x(r[0].at)},${y(0)}Z`} />}
                {r.length > 1 ? <path className="line" d={line} /> : <circle className="pt" cx={x(r[0].at)} cy={y(r[0].value)} r={3} />}
              </g>
            );
          })}
          <line className="baseline" x1={padL} x2={width} y1={y(0)} y2={y(0)} />
          {hp && (
            <g className="cross">
              <line x1={x(hp.at)} x2={x(hp.at)} y1={padT} y2={y(0)} />
              <circle cx={x(hp.at)} cy={y(hp.value)} r={4} />
            </g>
          )}
          <rect className="hit" x={padL} y={padT} width={plotW} height={plotH} onMouseMove={onMove} />
        </svg>
      )}
      <Tooltip
        width={width}
        tip={hp ? { x: x(hp.at), y: y(hp.value) - 10, body: <><b>{gap > 3_600_000 ? longDay.format(hp.at) : timeFmt.format(hp.at)}</b><span className="tip-row"><i />{gap > 3_600_000 ? 'Peak viewers' : 'Viewers'}<em>{num(hp.value)}</em></span></> } : null}
      />
    </div>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hourName = (h: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2000, 0, 1, h));

/** Chat lines by weekday and hour, one hue from faint to strong. */
export function Heatmap({ cells }: { cells: number[][] }) {
  const [tip, setTip] = useState<{ d: number; h: number } | null>(null);
  const max = Math.max(1, ...cells.flat());
  // Monday first reads more naturally on a weekly schedule.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="heat" onMouseLeave={() => setTip(null)}>
      <div className="heat-grid" role="table" aria-label="Chat messages by day and hour">
        <div className="heat-row heat-hours" role="row" aria-hidden="true">
          <span />
          {Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 6 === 0 ? hourName(h) : ''}</span>)}
        </div>
        {order.map((d) => (
          <div className="heat-row" role="row" key={d}>
            <span role="rowheader">{DAYS[d]}</span>
            {cells[d]?.map((v, h) => (
              <span
                key={h}
                role="cell"
                className={'heat-cell' + (tip && tip.d === d && tip.h === h ? ' on' : '')}
                style={{ ['--a' as string]: v ? 0.12 + 0.88 * Math.sqrt(v / max) : 0 }}
                aria-label={`${DAYS[d]} ${hourName(h)}: ${num(v)} messages`}
                onMouseEnter={() => setTip({ d, h })}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="heat-foot">
        <span>{tip ? <><b>{DAYS[tip.d]}, {hourName(tip.h)}</b> {num(cells[tip.d][tip.h])} messages</> : 'Point at a square for the count'}</span>
        <span className="heat-scale" aria-hidden="true">Less<i style={{ ['--a' as string]: 0.12 }} /><i style={{ ['--a' as string]: 0.4 }} /><i style={{ ['--a' as string]: 0.7 }} /><i style={{ ['--a' as string]: 1 }} />More</span>
      </div>
    </div>
  );
}

/** A ranked list with a bar under each name, for leaderboards and commands. */
export function RankList({ rows, unit, c, empty }: { rows: { name: string; amount: number }[]; unit: string; c: string; empty: string }) {
  if (!rows.length) return <p className="card-text">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <ol className={'rank ' + c}>
      {rows.map((r, i) => (
        <li key={r.name + i}>
          <span className="rank-n">{i + 1}</span>
          <span className="rank-name">{r.name}</span>
          <span className="rank-v">{num(Math.round(r.amount))} <small>{unit}</small></span>
          <span className="rank-bar" style={{ width: `${(r.amount / max) * 100}%` }} />
        </li>
      ))}
    </ol>
  );
}

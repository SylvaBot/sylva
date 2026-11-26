// Stream summaries: the live stream so far and the ones before it, worked
// out by the channel when each stream ends (workers/edge/src/streams.rs).

import { useEffect, useState } from 'react';
import { api, type Recap } from './api';
import { useChannel } from './channel';
import { Card } from './pages';
import { num } from './ui';

const hours = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
};
const when = (at: number) => new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function RecapBody({ r }: { r: Recap }) {
  const facts: [string, string][] = [];
  if (r.peakViewers != null) facts.push(['Peak viewers', num(r.peakViewers)]);
  if (r.avgViewers != null) facts.push(['Average viewers', num(r.avgViewers)]);
  facts.push(
    ['Followers', num(r.follows)],
    ['Subs', num(r.subs)],
    ['Gifted subs', num(r.gifted)],
    ['Bits', num(r.bits)],
    ['Raids', r.raids ? `${num(r.raids)} \u00b7 ${num(r.raiders)} viewers` : '0'],
    ['Chat messages', num(r.chatLines)],
    ['People who chatted', num(r.chatters)],
  );
  if (r.tips) facts.push(['Tips', num(r.tips)]);
  if (r.redemptions) facts.push(['Redemptions', num(r.redemptions)]);
  const leaders = ([
    ['Most messages', r.topChatter, 'messages'],
    ['Most bits', r.topCheerer, 'bits'],
    ['Most gifted subs', r.topGifter, 'subs'],
  ] as const).filter(([, l]) => l);
  return (
    <>
      <dl className="cells flat">
        {facts.map(([k, v]) => <div key={k} className="cell"><dt className="cell-label">{k}</dt><dd className="cell-num">{v}</dd></div>)}
      </dl>
      {leaders.length > 0 && (
        <dl className="standouts">
          {leaders.map(([k, l, unit]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd><b>{l!.name}</b><span>{num(l!.amount)} {unit}</span></dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/** The latest stream's summary, with earlier ones a click away. */
export function StreamRecaps() {
  const ch = useChannel();
  const [data, setData] = useState<{ live: Recap | null; past: Recap[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    api.streams(ch.key).then(setData).catch(() => setFailed(true));
  }, [ch.key]);

  const list: Recap[] = data ? [...(data.live ? [data.live] : []), ...data.past] : [];
  const r = list[Math.min(pick, list.length - 1)];
  return (
    <Card
      id="streams"
      title={r && !r.endedAt ? 'This stream so far' : 'Last stream'}
      desc={r ? `${when(r.startedAt)}, ${hours((r.endedAt ?? Date.now()) - r.startedAt)}` : undefined}
      action={list.length > 1 ? (
        <select className="select sm" aria-label="Pick a stream" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
          {list.map((x, i) => <option key={x.startedAt} value={i}>{x.endedAt ? when(x.startedAt) : 'Live now'}</option>)}
        </select>
      ) : undefined}
    >
      <div className="card-body">
        {failed && <p className="card-text">Could not load your streams. Refresh to try again.</p>}
        {!data && !failed && <p className="card-text">Loading</p>}
        {data && !r && <p className="card-text">After your next stream ends, its summary shows here: followers, subs, bits, raids and who chatted the most.</p>}
        {r && <RecapBody r={r} />}
      </div>
    </Card>
  );
}

// The activity feed, ported from Cortex (ui/app.js): one color per kind of
// event, a mix bar for the last 24 hours, filter chips, and one plain
// sentence per event with small pills for the details.

import { useEffect, useState, type ReactNode } from 'react';
import type { Kind, SylvaEvent } from './api';
import { ago, Icon, num } from './ui';

export interface Group { id: string; label: string; color: string; icon: string; kinds: Kind[] }

export const GROUPS: Group[] = [
  { id: 'follow', label: 'Follows', color: 'c-follow', icon: 'heart', kinds: ['follow'] },
  { id: 'sub', label: 'Subs', color: 'c-sub', icon: 'star', kinds: ['subscriber'] },
  { id: 'gift', label: 'Gifts', color: 'c-gift', icon: 'gift', kinds: ['giftedSub', 'communityGift'] },
  { id: 'cheer', label: 'Bits', color: 'c-bits', icon: 'gem', kinds: ['cheer'] },
  { id: 'tip', label: 'Tips', color: 'c-tip', icon: 'tip', kinds: ['tip'] },
  { id: 'redemption', label: 'Rewards', color: 'c-reward', icon: 'sparkles', kinds: ['redemption'] },
  { id: 'raid', label: 'Raids', color: 'c-raid', icon: 'swords', kinds: ['raid'] },
  { id: 'other', label: 'Other', color: 'c-other', icon: 'dot', kinds: ['other'] },
];

const KNOWN = new Set<Kind>(GROUPS.flatMap((g) => g.kinds));
const DAY = 86_400_000;

export const groupOf = (kind: Kind) => GROUPS.find((g) => g.kinds.includes(kind)) ?? GROUPS[GROUPS.length - 1];

/** Kinds that play as alerts, so they can be replayed. Matches EventKind::is_alert. */
export const ALERT_KINDS = new Set<Kind>(['follow', 'subscriber', 'communityGift', 'cheer', 'tip', 'redemption', 'raid']);

const TIERS: Record<string, string> = { '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3', prime: 'Prime' };

function rawText(e: SylvaEvent, key: string): string | null {
  const v = e.raw?.[key];
  return typeof v === 'string' && v ? v : null;
}

/** One sentence that says what happened, names in bold, plus pills for details. */
export function describe(e: SylvaEvent): { title: ReactNode; pills: string[]; message?: string } {
  const name = e.actor?.displayName || 'Anonymous';
  const n = e.amount;
  const has = n !== undefined && n !== null;
  const plural = (one: string, many: string) => (n === 1 ? one : many);
  const tier = e.tier ? TIERS[e.tier] : undefined;
  const pills: string[] = [];
  let message = e.message;
  let title: ReactNode;
  switch (e.kind) {
    case 'follow':
      title = <><b>{name}</b> followed</>;
      break;
    case 'subscriber':
      title = <><b>{name}</b> {has && n > 1 ? 'resubscribed' : 'subscribed'}</>;
      if (tier) pills.push(tier);
      if (has && n > 1) pills.push(num(n) + ' months');
      break;
    case 'giftedSub':
      // Twitch does not say who gave it here; the matching gift event does.
      title = e.sender
        ? <><b>{e.sender}</b> gifted a sub to <b>{name}</b></>
        : <><b>{name}</b> got a gifted sub</>;
      if (tier) pills.push(tier);
      break;
    case 'communityGift':
      title = <><b>{name}</b> {has && n !== 1 ? `gifted ${num(n)} subs` : 'gifted a sub'}</>;
      if (tier) pills.push(tier);
      break;
    case 'cheer':
      title = <><b>{name}</b> {has ? `cheered ${num(n)} ${plural('bit', 'bits')}` : 'cheered'}</>;
      break;
    case 'tip':
      title = <><b>{name}</b> tipped</>;
      break;
    case 'redemption':
      title = <><b>{name}</b> redeemed <b>{e.redemption || 'a reward'}</b></>;
      break;
    case 'raid':
      title = <><b>{name}</b> {has ? `raided with ${num(n)} ${plural('viewer', 'viewers')}` : 'raided'}</>;
      break;
    default:
      switch (e.rawType) {
        case 'stream.online': title = <><b>You</b> went live</>; break;
        case 'stream.offline': title = <><b>Stream</b> ended</>; break;
        case 'channel.update':
          title = <><b>Stream info</b> changed</>;
          message = [rawText(e, 'title'), rawText(e, 'category_name')].filter(Boolean).join(' · ') || undefined;
          break;
        case 'channel.raid':
          title = <><b>You</b> raided <b>{rawText(e, 'to_broadcaster_user_name') || 'a channel'}</b></>;
          if (has) pills.push(num(n) + ' ' + plural('viewer', 'viewers'));
          break;
        default:
          title = <b>{name}</b>;
          pills.push(e.rawType);
      }
  }
  if (e.platform === 'sylva') pills.push('Test');
  return { title, pills, message };
}

function Item({ e, fresh, onReplay }: { e: SylvaEvent; fresh: boolean; onReplay(e: SylvaEvent): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const g = groupOf(e.kind);
  const d = describe(e);
  const kind = KNOWN.has(e.kind) ? e.kind : 'other';
  return (
    <li className={`item k-${kind}${fresh ? ' fresh' : ''}`}>
      <span className="tile"><Icon id={g.icon} /></span>
      <div className="item-main">
        <div className="item-title">{d.title}</div>
        {d.message && <p className="item-msg">{d.message}</p>}
        {d.pills.length > 0 && (
          <div className="pills">{d.pills.map((p) => <span key={p} className="pill">{p}</span>)}</div>
        )}
      </div>
      <div className="item-side">
        <time dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString()}>{ago(e.createdAt)}</time>
      </div>
      {ALERT_KINDS.has(e.kind) && (
        <button
          className="replay"
          type="button"
          title="Play this alert again"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onReplay(e); } finally { setBusy(false); }
          }}
        >
          <Icon id="replay" />Replay
        </button>
      )}
    </li>
  );
}

function loadShown(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem('shownGroups') || '[]');
    return new Set((Array.isArray(v) ? v : []).filter((g) => GROUPS.some((x) => x.id === g)));
  } catch {
    return new Set();
  }
}

function saveShown(s: Set<string>) {
  try { localStorage.setItem('shownGroups', JSON.stringify([...s])); } catch { /* private window */ }
}

export function Feed(props: {
  events: SylvaEvent[];
  freshFrom: number;
  hasMore: boolean;
  loadingMore: boolean;
  onMore(): void;
  onReplay(e: SylvaEvent): Promise<void>;
}) {
  const [shown, setShown] = useState(loadShown);
  // Re-render every 30 s so "5m ago" and the 24 hour mix stay true.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const recent = props.events.filter((e) => Date.now() - Date.parse(e.createdAt) < DAY);
  const counts: Record<string, number> = Object.fromEntries(GROUPS.map((g) => [g.id, 0]));
  for (const e of recent) counts[groupOf(e.kind).id]++;
  const total = recent.length;
  const visible = props.events.filter((e) => !shown.size || shown.has(groupOf(e.kind).id));

  const toggle = (id: string | null) => {
    const next = new Set(shown);
    if (id === null) next.clear();
    else if (next.has(id)) next.delete(id);
    else next.add(id);
    saveShown(next);
    setShown(next);
  };

  return (
    <section className="feed-card" aria-labelledby="feed-title">
      <div className="feed-head">
        <div>
          <h2 id="feed-title">Recent activity</h2>
          <p className="feed-sub">{total === 1 ? '1 event in the last 24 hours' : `${num(total)} events in the last 24 hours`}</p>
        </div>
      </div>
      <div className={'mix' + (total === 0 ? ' empty' : '')} aria-hidden="true">
        {total === 0
          ? <span style={{ flexGrow: 1 }} />
          : GROUPS.filter((g) => counts[g.id] > 0).map((g) => (
            <span key={g.id} className={g.color} style={{ flexGrow: counts[g.id] }} title={`${num(counts[g.id])} ${g.label.toLowerCase()}`} />
          ))}
      </div>
      <div className="filters" role="group" aria-label="Filter activity">
        <button className="filter" type="button" aria-pressed={shown.size === 0} onClick={() => toggle(null)}>
          All<span className="count">{num(total)}</span>
        </button>
        {GROUPS.filter((g) => g.id !== 'other' || counts.other > 0 || shown.has('other')).map((g) => (
          <button
            key={g.id}
            className={'filter ' + g.color}
            type="button"
            title={`Show ${g.label.toLowerCase()} (click more than one to combine)`}
            aria-pressed={shown.has(g.id)}
            onClick={() => toggle(g.id)}
          >
            <span className="bar" />{g.label}<span className="count">{num(counts[g.id])}</span>
          </button>
        ))}
      </div>
      {visible.length > 0 ? (
        <ol className="feed" aria-live="polite">
          {visible.map((e) => <Item key={e.seq} e={e} fresh={e.seq > props.freshFrom} onReplay={props.onReplay} />)}
        </ol>
      ) : (
        <p className="empty">
          {props.events.length
            ? 'Nothing here for this filter yet.'
            : 'No activity yet. Follows, subs, cheers and raids appear here the moment they happen.'}
        </p>
      )}
      {props.hasMore && (
        <div className="feed-more">
          <button className="btn" type="button" disabled={props.loadingMore} onClick={props.onMore}>
            {props.loadingMore ? 'Loading' : 'Show older'}
          </button>
        </div>
      )}
    </section>
  );
}

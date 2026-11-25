// The activity feed, after Cortex's: one color per kind of event, a mix bar
// for the last 24 hours, filter chips, and one plain sentence per event with
// small pills for the details.

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

function Item({ e, fresh, onReplay }: { e: SylvaEvent; fresh: boolean; onReplay?(e: SylvaEvent): Promise<void> }) {
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
      {ALERT_KINDS.has(e.kind) && onReplay && (
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

/** Counts per group for events in the last 24 hours. */
export function lastDay(events: SylvaEvent[]): { counts: Record<string, number>; total: number } {
  const counts: Record<string, number> = Object.fromEntries(GROUPS.map((g) => [g.id, 0]));
  let total = 0;
  const now = Date.now();
  for (const e of events) {
    if (now - Date.parse(e.createdAt) >= DAY) continue;
    counts[groupOf(e.kind).id]++;
    total++;
  }
  return { counts, total };
}

/** Re-render every 30 s so "5m ago" and 24 hour counts stay true. */
export function useTick() {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
}

export function MixBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  return (
    <div className={'mix' + (total === 0 ? ' empty' : '')} aria-hidden="true">
      {total === 0
        ? <span style={{ flexGrow: 1 }} />
        : GROUPS.filter((g) => counts[g.id] > 0).map((g) => (
          <span key={g.id} className={g.color} style={{ flexGrow: counts[g.id] }} title={`${num(counts[g.id])} ${g.label.toLowerCase()}`} />
        ))}
    </div>
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

/** Which groups are shown; empty means all. Remembered in this browser. */
export function useShown(): [Set<string>, (id: string | null) => void] {
  const [shown, setShown] = useState(loadShown);
  const toggle = (id: string | null) => {
    const next = new Set(shown);
    if (id === null) next.clear();
    else if (next.has(id)) next.delete(id);
    else next.add(id);
    saveShown(next);
    setShown(next);
  };
  return [shown, toggle];
}

export function Filters(props: { shown: Set<string>; toggle(id: string | null): void; counts?: Record<string, number>; total?: number }) {
  const { shown, toggle, counts } = props;
  return (
    <div className="filters" role="group" aria-label="Filter activity by kind">
      <button className="filter" type="button" aria-pressed={shown.size === 0} onClick={() => toggle(null)}>
        All{props.total !== undefined && <span className="count">{num(props.total)}</span>}
      </button>
      {GROUPS.filter((g) => !OPTIONAL.has(g.id) || (counts?.[g.id] ?? 0) > 0 || shown.has(g.id)).map((g) => (
        <button
          key={g.id}
          className={'filter ' + g.color}
          type="button"
          title={`Show ${g.label.toLowerCase()} (choose more than one to combine)`}
          aria-pressed={shown.has(g.id)}
          onClick={() => toggle(g.id)}
        >
          <span className="bar" />{g.label}{counts && <span className="count">{num(counts[g.id])}</span>}
        </button>
      ))}
    </div>
  );
}

// Kinds Twitch alone never sends, or Sylva does not subscribe to yet: their
// filter only shows once there is something to filter.
const OPTIONAL = new Set(['tip', 'redemption', 'other']);

export const matchesShown = (shown: Set<string>) => (e: SylvaEvent) => !shown.size || shown.has(groupOf(e.kind).id);

export function FeedList(props: {
  events: SylvaEvent[];
  freshFrom: number;
  /** Left out when the viewer's role cannot replay alerts. */
  onReplay?(e: SylvaEvent): Promise<void>;
  empty: ReactNode;
  flush?: boolean;
}) {
  if (!props.events.length) {
    return <div className="empty"><Icon id="activity" />{props.empty}</div>;
  }
  return (
    <ol className={'feed' + (props.flush ? ' flush' : '')} aria-live="polite">
      {props.events.map((e) => <Item key={e.seq} e={e} fresh={e.seq > props.freshFrom} onReplay={props.onReplay} />)}
    </ol>
  );
}

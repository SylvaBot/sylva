// The activity feed, after Cortex's: one color per kind of event, a mix bar
// for the last 24 hours, filter chips, and one plain sentence per event with
// small pills for the details.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Kind, SylvaEvent } from './api';
import { ago, Icon, num, SkelRows } from './ui';

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

function rawNum(e: SylvaEvent, key: string): number | null {
  const v = e.raw?.[key];
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** "90 seconds" as "1:30", or "30 seconds". */
function seconds(n: number): string {
  if (n < 60) return `${n} seconds`;
  const m = Math.floor(n / 60);
  const r = n % 60;
  return r ? `${m}:${String(r).padStart(2, '0')}` : `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/** The option with the most votes or points, from a poll's choices or a prediction's outcomes. */
function winner(list: unknown, id?: string | null): string | null {
  if (!Array.isArray(list)) return null;
  const opts = list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const named = (o: Record<string, unknown> | undefined) => (o && typeof o.title === 'string' ? o.title : null);
  if (id) return named(opts.find((o) => o.id === id));
  const score = (o: Record<string, unknown>) => Number(o.votes ?? o.channel_points ?? 0) || 0;
  const best = opts.reduce<Record<string, unknown> | undefined>((b, o) => (!b || score(o) > score(b) ? o : b), undefined);
  return best && score(best) > 0 ? named(best) : null;
}

/** A Twitch event type nobody wrote words for yet, readable: "channel.shoutout.create" as "Shoutout create". */
function humanType(t: string): string {
  const s = t.replace(/^channel\./, '').replace(/[._]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Event';
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
        case 'channel.ad_break.begin': {
          const len = rawNum(e, 'duration_seconds');
          title = <><b>Ad break</b> started</>;
          if (len) pills.push(seconds(len));
          if (e.raw?.is_automatic === true) pills.push('Automatic');
          else if (rawText(e, 'requester_user_name')) pills.push('Started by ' + rawText(e, 'requester_user_name'));
          break;
        }
        case 'channel.hype_train.begin':
        case 'channel.hype_train.progress':
        case 'channel.hype_train.end': {
          const level = rawNum(e, 'level');
          const verb = e.rawType.endsWith('begin') ? 'started' : e.rawType.endsWith('end') ? 'ended' : 'is going';
          title = <><b>Hype train</b> {verb}</>;
          if (level) pills.push('Level ' + num(level));
          if (rawNum(e, 'total')) pills.push(num(rawNum(e, 'total') as number) + ' points');
          break;
        }
        case 'channel.prediction.begin':
        case 'channel.prediction.lock':
        case 'channel.prediction.end': {
          const verb = e.rawType.endsWith('begin') ? 'started' : e.rawType.endsWith('lock') ? 'locked' : 'ended';
          title = <><b>Prediction</b> {verb}</>;
          message = rawText(e, 'title') || undefined;
          if (e.rawType.endsWith('end')) {
            const won = winner(e.raw?.outcomes, rawText(e, 'winning_outcome_id'));
            pills.push(won ? 'Won: ' + won : 'Canceled');
          }
          break;
        }
        case 'channel.poll.begin':
        case 'channel.poll.end': {
          title = <><b>Poll</b> {e.rawType.endsWith('begin') ? 'started' : 'ended'}</>;
          message = rawText(e, 'title') || undefined;
          const top = e.rawType.endsWith('end') ? winner(e.raw?.choices) : null;
          if (top) pills.push('Top: ' + top);
          break;
        }
        case 'channel.charity_campaign.donate': {
          const who = rawText(e, 'user_name') || name;
          const charity = rawText(e, 'charity_name');
          title = charity ? <><b>{who}</b> donated to <b>{charity}</b></> : <><b>{who}</b> donated to charity</>;
          const amt = e.raw?.amount as { value?: number; decimal_places?: number; currency?: string } | undefined;
          if (amt && typeof amt.value === 'number') {
            const v = amt.value / 10 ** (amt.decimal_places || 0);
            try {
              pills.push(new Intl.NumberFormat(undefined, { style: 'currency', currency: amt.currency || 'USD' }).format(v));
            } catch {
              pills.push(num(v));
            }
          }
          break;
        }
        default:
          title = e.actor ? <><b>{name}</b> {humanType(e.rawType).toLowerCase()}</> : <b>{humanType(e.rawType)}</b>;
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
    // Test alerts never count toward real numbers.
    if (e.platform === 'sylva' || now - Date.parse(e.createdAt) >= DAY) continue;
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

/** A Filter button that opens a checklist of kinds; the feed shows every kind when none is ticked. */
export function Filters(props: { shown: Set<string>; toggle(id: string | null): void; counts?: Record<string, number>; total?: number }) {
  const { shown, toggle, counts } = props;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', esc); };
  }, [open]);
  const groups = GROUPS.filter((g) => !OPTIONAL.has(g.id) || (counts?.[g.id] ?? 0) > 0 || shown.has(g.id));
  return (
    <div className="filter-wrap" ref={wrap}>
      <button className={'btn sm' + (shown.size ? ' primary' : '')} type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        <Icon id="filter" />{shown.size ? `Filter (${shown.size})` : 'Filter'}
      </button>
      {open && (
        <div className="filter-pop" role="group" aria-label="Show these kinds">
          <button className="filter-opt" type="button" aria-pressed={shown.size === 0} onClick={() => toggle(null)}>
            <span className="check"><Icon id="tick" /></span>Everything{props.total !== undefined && <span className="count">{num(props.total)}</span>}
          </button>
          {groups.map((g) => (
            <button key={g.id} className={'filter-opt ' + g.color} type="button" aria-pressed={shown.has(g.id)} onClick={() => toggle(g.id)}>
              <span className="check"><Icon id="tick" /></span><span className="bar" />{g.label}{counts && <span className="count">{num(counts[g.id])}</span>}
            </button>
          ))}
        </div>
      )}
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
  /** Still waiting for the first events: rows in gray instead of the empty note. */
  loading?: boolean;
}) {
  if (!props.events.length && props.loading) return <div className="feed-skel"><SkelRows n={6} /></div>;
  if (!props.events.length) {
    return <div className="empty"><Icon id="activity" />{props.empty}</div>;
  }
  return (
    <ol className={'feed' + (props.flush ? ' flush' : '')} aria-live="polite">
      {props.events.map((e) => <Item key={e.seq} e={e} fresh={e.seq > props.freshFrom} onReplay={props.onReplay} />)}
    </ol>
  );
}

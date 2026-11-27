// The Games tab on the Chat bot page: !gamble, !roulette, !slots,
// !blackjack, !duel and !raffle, each with who can play, cooldowns, bets
// and what it pays. Points themselves stay on the Loyalty page. The rules
// match crates/sylva-core/src/games.rs, which checks every save again.

import { useEffect, useRef, useState } from 'react';
import { api, type GameOdds, type GameRule, type GameSettings, type LoyaltyView, type RaffleSettings, type UserLevel } from './api';
import { LEVELS, seconds } from './bot';
import { useChannel } from './channel';
import { NumberField } from './moderation';
import { Card } from './pages';
import { Link } from './router';
import { errorText, Gate, num, SkelCard, useToast } from './ui';

const MAX_BET = 10_000_000;
type GameKey = 'gamble' | 'roulette' | 'slots' | 'blackjack' | 'duel';
const KEYS: GameKey[] = ['gamble', 'roulette', 'slots', 'blackjack', 'duel'];
const CMD: Record<GameKey, { cmd: string; alias?: string; usage: string }> = {
  gamble: { cmd: '!gamble', usage: '!gamble 100' },
  roulette: { cmd: '!roulette', usage: '!roulette 100 red' },
  slots: { cmd: '!slots', usage: '!slots 100' },
  blackjack: { cmd: '!blackjack', alias: '!bj', usage: '!blackjack 100, then !hit or !stand' },
  duel: { cmd: '!duel', usage: '!duel @name 100, answered with !accept or !deny' },
};

/** A payout percent as "2x" or "1.5x". */
const times = (pct: number) => `${num(pct / 100)}x`;
const pct1 = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString()}%`;

function about(k: GameKey, o: GameOdds): string {
  switch (k) {
    case 'gamble': return `Rolls 1 to 100. ${o.gambleWinAt} or more pays ${times(o.gambleWin)}, and 100 pays ${times(o.gambleJackpot)}.`;
    case 'roulette': return `Red, black, even or odd pays ${times(o.rouletteColor)}. One number from 0 to 36 pays ${times(o.rouletteNumber)}.`;
    case 'slots': return `Three reels. Three of a kind pays ${times(o.slotsTriple)}, three 💎 ${times(o.slotsJackpot)}, two of a kind ${times(o.slotsPair)}.`;
    case 'blackjack': return `Blackjack pays ${times(o.blackjackNatural)}, a win 2x, and the dealer stands on 17.`;
    case 'duel': return `The other viewer has ${seconds(o.duelWait).toLowerCase()} to accept. The winner takes both bets.`;
  }
}

/** What a game pays back on average, as a percent of what is bet. */
function payback(k: GameKey, o: GameOdds): number | null {
  switch (k) {
    case 'gamble': return ((100 - o.gambleWinAt) * o.gambleWin + o.gambleJackpot) / 100;
    case 'roulette': return (18 / 37) * o.rouletteColor;
    case 'slots': return (5 * o.slotsTriple + o.slotsJackpot + 90 * o.slotsPair) / 216;
    default: return null;
  }
}

type Limits = { level: UserLevel; cooldown: number; globalCooldown: number; minBet: number; maxBet: number };
function limits(g: GameSettings, k: GameKey): Limits {
  const r: GameRule = g.rules?.[k] ?? { level: 'everyone', cooldown: null, globalCooldown: 0, minBet: null, maxBet: null };
  return {
    level: r.level,
    cooldown: r.cooldown ?? g.cooldown,
    globalCooldown: r.globalCooldown,
    minBet: r.minBet ?? g.minBet,
    maxBet: r.maxBet ?? g.maxBet,
  };
}

export function GamesTab() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<LoyaltyView | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const saving = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    api.loyalty(ch.key).then(setView).catch(() => setFailed(true));
  }, [ch.key]);

  if (failed && !view) return <Card><div className="card-body"><p className="card-text">Could not load the games. Refresh to try again.</p></div></Card>;
  if (!view) return <SkelCard rows={6} tile={false} />;

  const s = view.settings;
  const g = s.games;
  const name = s.name || 'points';

  // Changes show at once and save a moment after the last one.
  const commit = (next: typeof s, done: string, wait = 600) => {
    setView({ ...view, settings: next });
    clearTimeout(saving.current);
    saving.current = setTimeout(async () => {
      try {
        const v = await api.saveLoyalty(ch.key, next);
        setView((old) => (old ? { ...old, settings: v.settings } : v));
        toast(done);
      } catch (x) {
        toast(errorText(x), true);
      }
    }, wait);
  };
  const setGames = (patch: Partial<GameSettings>, done: string, wait?: number) => commit({ ...s, games: { ...g, ...patch } }, done, wait);
  const setRule = (k: GameKey, patch: Partial<Limits>) => {
    const cur = limits(g, k);
    const next = { ...cur, ...patch };
    setGames({ rules: { ...g.rules, [k]: next } }, `Saved ${CMD[k].cmd}`);
  };
  const setOdds = (k: GameKey, patch: Partial<GameOdds>) => setGames({ odds: { ...g.odds, ...patch } }, `Saved ${CMD[k].cmd}`);
  const setRaffle = (patch: Partial<RaffleSettings>, wait?: number) => commit({ ...s, raffle: { ...s.raffle, ...patch } }, 'Saved !raffle', wait);

  const odd = (k: GameKey, key: keyof GameOdds, label: string, min: number, max: number, unit: 'x' | 'roll' | 's') => (
    <div className="field">
      <span>{label}</span>
      {unit === 'x'
        ? <MultField label={`${CMD[k].cmd}: ${label}`} pct={g.odds[key]} min={min} max={max} onChange={(n) => setOdds(k, { [key]: n })} />
        : <NumberField label={`${CMD[k].cmd}: ${label}`} value={g.odds[key]} min={min} max={max} onChange={(n) => setOdds(k, { [key]: n })} />}
    </div>
  );

  return (
    <Card id="games" title="Games" desc={`Viewers bet their ${name} in chat. A bet can be a number, 2k, half, 25% or all. Changes save as you go.`}>
      {(!s.enabled || !view.botOn) && (
        <div className="card-body">
          <div className="notice">
            <span>{!s.enabled ? `Games use loyalty ${name}, which are off. Turn them on to play.` : 'Games answer only while the chat bot is on.'}</span>
            {!s.enabled && <Link className="btn sm" href="/app/points">Open Points</Link>}
          </div>
        </div>
      )}
      <ul className="types">
        {KEYS.map((k) => {
          const l = limits(g, k);
          const isOpen = open === k;
          const back = payback(k, g.odds);
          const meta = [LEVELS.find((x) => x.id === l.level)?.label ?? 'Everyone'];
          if (l.cooldown) meta.push(`${seconds(l.cooldown)} per viewer`);
          if (l.globalCooldown) meta.push(`${seconds(l.globalCooldown)} for everyone`);
          meta.push(l.maxBet ? `bets ${num(l.minBet)} to ${num(l.maxBet)}` : `bets from ${num(l.minBet)}`);
          if (back !== null) meta.push(`pays back ${pct1(back)}`);
          return (
            <li key={k} className={'type cmd' + (isOpen ? ' open' : '') + (g[k] ? '' : ' off')}>
              <div className="type-row">
                <div className="type-main">
                  <b className="cmd-name">{CMD[k].cmd}{CMD[k].alias && <span className="cmd-alias"> {CMD[k].alias}</span>}</b>
                  <span className="cmd-reply">{about(k, g.odds)}</span>
                  <span className="cmd-meta">{meta.join(' · ')}</span>
                </div>
                <button className="btn sm ghost" type="button" aria-expanded={isOpen} aria-controls={`game-edit-${k}`} onClick={() => setOpen(isOpen ? null : k)}>
                  {isOpen ? 'Close' : ch.can.edit ? 'Edit' : 'View'}
                </button>
                <button className="switch" type="button" role="switch" aria-checked={g[k]} aria-label={CMD[k].cmd} disabled={!ch.can.edit}
                  onClick={() => setGames({ [k]: !g[k] }, `${CMD[k].cmd} ${g[k] ? 'off' : 'on'}`, 0)} />
              </div>
              {isOpen && (
                <Gate on={ch.can.edit}>
                  <div className="game-edit" id={`game-edit-${k}`}>
                    <p className="builtin-usage">Type <code>{CMD[k].usage}</code></p>
                    <div className="game-fields">
                      <label className="field" htmlFor={`game-${k}-level`}>
                        Who can play
                        <select id={`game-${k}-level`} className="select" value={l.level} onChange={(e) => setRule(k, { level: e.target.value as UserLevel })}>
                          {LEVELS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                        </select>
                      </label>
                      <div className="field"><span>Seconds per viewer</span><NumberField label={`${CMD[k].cmd}: seconds per viewer`} value={l.cooldown} min={0} max={3600} onChange={(n) => setRule(k, { cooldown: n })} /></div>
                      <div className="field"><span>Seconds for everyone</span><NumberField label={`${CMD[k].cmd}: seconds for everyone`} value={l.globalCooldown} min={0} max={3600} onChange={(n) => setRule(k, { globalCooldown: n })} /></div>
                      <div className="field"><span>Smallest bet</span><NumberField label={`${CMD[k].cmd}: smallest bet`} value={l.minBet} min={1} max={MAX_BET} onChange={(n) => setRule(k, { minBet: n })} /></div>
                      <div className="field"><span>Largest bet (0 for none)</span><NumberField label={`${CMD[k].cmd}: largest bet`} value={l.maxBet} min={0} max={MAX_BET} onChange={(n) => setRule(k, { maxBet: n })} /></div>
                    </div>
                    {k !== 'duel' && <h4 className="game-sub">Payouts<span>The times a bet that comes back, so 2x doubles it.</span></h4>}
                    {k === 'duel' && <h4 className="game-sub">Answer time</h4>}
                    <div className="game-fields">
                      {k === 'gamble' && <>
                        {odd(k, 'gambleWinAt', 'Lowest winning roll', 2, 100, 'roll')}
                        {odd(k, 'gambleWin', 'A win pays', 101, 1000, 'x')}
                        {odd(k, 'gambleJackpot', 'A roll of 100 pays', 101, 100000, 'x')}
                      </>}
                      {k === 'roulette' && <>
                        {odd(k, 'rouletteColor', 'Red, black, even, odd', 101, 1000, 'x')}
                        {odd(k, 'rouletteNumber', 'A single number', 101, 10000, 'x')}
                      </>}
                      {k === 'slots' && <>
                        {odd(k, 'slotsPair', 'Two of a kind', 0, 1000, 'x')}
                        {odd(k, 'slotsTriple', 'Three of a kind', 101, 100000, 'x')}
                        {odd(k, 'slotsJackpot', 'Three 💎', 101, 100000, 'x')}
                      </>}
                      {k === 'blackjack' && odd(k, 'blackjackNatural', 'Blackjack pays', 101, 1000, 'x')}
                      {k === 'duel' && odd(k, 'duelWait', 'Seconds to accept', 15, 600, 's')}
                    </div>
                    {back !== null && (
                      <p className={'field-hint game-edge' + (back > 100 ? ' warn' : '')}>
                        On average a bet pays back {pct1(back)}.{' '}
                        {back > 100 ? `Viewers come out ahead over time, so ${name} grow.` : `Over time ${pct1(100 - back)} of what is bet leaves the economy.`}
                      </p>
                    )}
                  </div>
                </Gate>
              )}
            </li>
          );
        })}
        <li className={'type cmd' + (open === 'raffle' ? ' open' : '') + (s.raffle.enabled ? '' : ' off')}>
          <div className="type-row">
            <div className="type-main">
              <b className="cmd-name">!raffle<span className="cmd-alias"> !join</span></b>
              <span className="cmd-reply">A moderator starts it with an amount, viewers type !join, and one wins {name} that nobody paid in.</span>
              <span className="cmd-meta">Moderators start it · open {seconds(s.raffle.duration).toLowerCase()} · up to {num(s.raffle.maxAmount)}</span>
            </div>
            <button className="btn sm ghost" type="button" aria-expanded={open === 'raffle'} aria-controls="game-edit-raffle" onClick={() => setOpen(open === 'raffle' ? null : 'raffle')}>
              {open === 'raffle' ? 'Close' : ch.can.edit ? 'Edit' : 'View'}
            </button>
            <button className="switch" type="button" role="switch" aria-checked={s.raffle.enabled} aria-label="!raffle" disabled={!ch.can.edit}
              onClick={() => setRaffle({ enabled: !s.raffle.enabled }, 0)} />
          </div>
          {open === 'raffle' && (
            <Gate on={ch.can.edit}>
              <div className="game-edit" id="game-edit-raffle">
                <p className="builtin-usage">Type <code>!raffle 1000</code></p>
                <div className="game-fields">
                  <div className="field"><span>Seconds open</span><NumberField label="Raffle: seconds open" value={s.raffle.duration} min={10} max={3600} onChange={(n) => setRaffle({ duration: n })} /></div>
                  <div className="field"><span>Largest amount</span><NumberField label="Raffle: largest amount" value={s.raffle.maxAmount} min={1} max={MAX_BET} onChange={(n) => setRaffle({ maxAmount: n })} /></div>
                </div>
                {(['start', 'running', 'end'] as const).map((m) => (
                  <label key={m} className="field" htmlFor={`raffle-${m}`}>
                    {m === 'start' ? 'Start message' : m === 'running' ? 'Halfway message' : 'End message'}
                    <input id={`raffle-${m}`} className="input" maxLength={300} value={s.raffle[m]} onChange={(e) => setRaffle({ [m]: e.target.value }, 1200)} />
                  </label>
                ))}
                <p className="field-hint">Variables: {'{points}'}, {'{pointsname}'}, {'{time}'} and {'{winner}'}.</p>
              </div>
            </Gate>
          )}
        </li>
      </ul>
    </Card>
  );
}

/** A payout typed as times the bet (1.5) and kept as a percent (150). */
function MultField({ label, pct, min, max, onChange }: { label: string; pct: number; min: number; max: number; onChange(n: number): void }) {
  const [text, setText] = useState(String(pct / 100));
  useEffect(() => { setText(String(pct / 100)); }, [pct]);
  return (
    <span className="mult-field">
      <input className="input" inputMode="decimal" aria-label={label} value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
        onBlur={() => {
          const n = Math.round(Number(text) * 100);
          if (!Number.isFinite(n) || text === '') { setText(String(pct / 100)); return; }
          const c = Math.min(max, Math.max(min, n));
          setText(String(c / 100));
          if (c !== pct) onChange(c);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <span aria-hidden="true">x</span>
    </span>
  );
}

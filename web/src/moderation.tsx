// The Moderation page: pick how strict chat should be, see exactly what each
// rule catches, try a message, and read what Sylva did. The rules match
// crates/sylva-core/src/moderation.rs, which checks every save again.

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, type ModEntry, type ModPreset, type ModRule, type ModRules, type ModSettings, type ModTry, type ModView,
  type UserLevel,
} from './api';
import { useChannel } from './channel';
import { Card, PageHead } from './pages';
import { errorText, Icon, useToast } from './ui';

const PRESETS: { id: ModPreset; label: string; what: string }[] = [
  { id: 'off', label: 'Off', what: 'Sylva leaves your chat alone. Twitch AutoMod and your moderators still work as usual.' },
  { id: 'relaxed', label: 'Relaxed', what: 'Only links, banned words and glitched text. Subscribers are trusted.' },
  { id: 'standard', label: 'Standard', what: 'Catches the usual spam: links, shouting, symbol walls, emote floods and very long messages.' },
  { id: 'strict', label: 'Strict', what: 'Tighter limits, and a short timeout from the first message that breaks a rule.' },
  { id: 'custom', label: 'Custom', what: 'Your own mix. Change any rule below to start from the preset you had.' },
];

export const RULE_NAMES: Record<ModRule, string> = {
  words: 'Banned words',
  links: 'Links',
  zalgo: 'Glitched text',
  length: 'Long messages',
  repeats: 'Repeated characters',
  caps: 'Capital letters',
  symbols: 'Symbols',
  emotes: 'Emotes',
};

const STEP_CHOICES = [0, 10, 60, 300, 600, 1800, 3600, 86400];
const EXEMPT: { id: UserLevel; label: string }[] = [
  { id: 'subscriber', label: 'Subscribers, VIPs and moderators' },
  { id: 'vip', label: 'VIPs and moderators' },
  { id: 'moderator', label: 'Moderators only' },
];

function parts(s: number): [number, string] {
  return s % 86400 === 0 ? [s / 86400, 'day'] : s % 3600 === 0 ? [s / 3600, 'hour'] : s % 60 === 0 ? [s / 60, 'minute'] : [s, 'second'];
}

/** "Remove the message", "5 minute timeout". */
export function timeoutText(s: number): string {
  if (s === 0) return 'Remove the message';
  const [n, unit] = parts(s);
  return `${n} ${unit} timeout`;
}

/** "5 minutes", "1 hour". */
function lasting(s: number): string {
  const [n, unit] = parts(s);
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

const ALLOW_URL = '/auth/twitch/start?scopes=moderation&next=/app/moderation';
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function ModerationPage() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<ModView | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<ModSettings | null>(null);
  const [words, setWords] = useState('');
  const [sites, setSites] = useState('');
  const [busy, setBusy] = useState(false);

  const adopt = useCallback((v: ModView) => {
    setView(v);
    setDraft(v.settings);
    setWords(v.settings.words.join('\n'));
    setSites(v.settings.allowedLinks.join('\n'));
  }, []);

  useEffect(() => {
    api.moderation(ch.key).then(adopt).catch(() => setFailed(true));
  }, [ch.key, adopt]);

  const next = useMemo<ModSettings | null>(
    () => draft && { ...draft, words: lines(words), allowedLinks: lines(sites) },
    [draft, words, sites],
  );
  const changed = !!view && !!next && !same(next, view.settings);

  const presetInfo = (p: ModPreset) => view?.presets.find(([id]) => id === p)?.[1];
  const pick = (p: ModPreset) => {
    if (!draft) return;
    const info = presetInfo(p);
    setDraft(info ? { ...draft, preset: p, ...info } : { ...draft, preset: p });
  };
  // Changing any rule by hand makes it Custom.
  const tune = (patch: Partial<ModSettings>) => draft && setDraft({ ...draft, ...patch, preset: 'custom' });
  const rule = <K extends keyof ModRules>(k: K, v: ModRules[K]) => draft && tune({ rules: { ...draft.rules, [k]: v } });

  const save = async () => {
    if (!next) return;
    setBusy(true);
    try {
      adopt(await api.saveModeration(ch.key, next));
      toast(next.preset === 'off' ? 'Moderation is off' : 'Moderation saved');
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  const off = draft?.preset === 'off';
  const what = PRESETS.find((p) => p.id === draft?.preset)?.what;

  return (
    <div className="page">
      <PageHead title="Moderation" desc="Rules that keep spam out of your chat. Sylva removes the message first, and times out chatters who keep going." />
      {failed && !view && <Card><div className="card-body"><p className="card-text">Could not load moderation. Refresh to try again.</p></div></Card>}
      {!view && !failed && <Card><div className="card-body"><p className="card-text">Loading</p></div></Card>}
      {view && draft && next && (
        <div className="stack">
          {view.permission !== 'ok' && (
            <div className="notice">
              <span>
                {view.permission === 'expired'
                  ? 'Twitch no longer accepts Sylva’s permission to moderate. Allow it again to keep your rules working.'
                  : 'Sylva needs your permission to remove messages and time out chatters in your chat.'}
              </span>
              <a className="btn primary sm" href={ALLOW_URL}><Icon id="twitch" />Allow moderation</a>
            </div>
          )}

          <Card id="mod-level" title="How strict" desc={what}>
            <div className="card-body mod-presets">
              <div className="segmented" role="group" aria-label="How strict">
                {PRESETS.map((p) => (
                  <button key={p.id} type="button" aria-pressed={draft.preset === p.id} onClick={() => pick(p.id)}>{p.label}</button>
                ))}
              </div>
            </div>
            <fieldset className="mod-rules" disabled={off}>
              <legend className="sr-only">Rules</legend>
              <ul className="types">
                <RuleRow name="Links" desc="Any website that is not on your allowed list below." on={draft.rules.links} onToggle={(v) => rule('links', v)} />
                <RuleRow name="Capital letters" on={draft.rules.caps.on} onToggle={(v) => rule('caps', { ...draft.rules.caps, on: v })}>
                  <NumberField label="Percent capitals" value={draft.rules.caps.percent} min={10} max={100} onChange={(n) => rule('caps', { ...draft.rules.caps, percent: n })} />
                  <span>% or more, in messages with at least</span>
                  <NumberField label="Letters" value={draft.rules.caps.min} min={1} max={500} onChange={(n) => rule('caps', { ...draft.rules.caps, min: n })} />
                  <span>letters</span>
                </RuleRow>
                <RuleRow name="Symbols" on={draft.rules.symbols.on} onToggle={(v) => rule('symbols', { ...draft.rules.symbols, on: v })}>
                  <NumberField label="Percent symbols" value={draft.rules.symbols.percent} min={10} max={100} onChange={(n) => rule('symbols', { ...draft.rules.symbols, percent: n })} />
                  <span>% or more, in messages with at least</span>
                  <NumberField label="Characters" value={draft.rules.symbols.min} min={1} max={500} onChange={(n) => rule('symbols', { ...draft.rules.symbols, min: n })} />
                  <span>characters</span>
                </RuleRow>
                <RuleRow name="Emotes" on={draft.rules.emotes.on} onToggle={(v) => rule('emotes', { ...draft.rules.emotes, on: v })}>
                  <span>More than</span>
                  <NumberField label="Most emotes" value={draft.rules.emotes.max} min={1} max={100} onChange={(n) => rule('emotes', { ...draft.rules.emotes, max: n })} />
                  <span>in one message</span>
                </RuleRow>
                <RuleRow name="Long messages" on={draft.rules.length.on} onToggle={(v) => rule('length', { ...draft.rules.length, on: v })}>
                  <span>More than</span>
                  <NumberField label="Most characters" value={draft.rules.length.max} min={20} max={500} onChange={(n) => rule('length', { ...draft.rules.length, max: n })} />
                  <span>characters</span>
                </RuleRow>
                <RuleRow name="Repeated characters" on={draft.rules.repeats.on} onToggle={(v) => rule('repeats', { ...draft.rules.repeats, on: v })}>
                  <span>More than</span>
                  <NumberField label="Most in a row" value={draft.rules.repeats.max} min={3} max={100} onChange={(n) => rule('repeats', { ...draft.rules.repeats, max: n })} />
                  <span>of one character in a row</span>
                </RuleRow>
                <RuleRow name="Glitched text" desc="Letters with stacked marks, often used to cover up chat." on={draft.rules.zalgo} onToggle={(v) => rule('zalgo', v)} />
              </ul>
              <div className="card-body mod-steps">
                <div className="mod-step-grid">
                  {(['First time', 'Second time', 'Third time and after'] as const).map((label, i) => (
                    <label key={label} className="field" htmlFor={`mod-step-${i}`}>
                      {label}
                      <select
                        id={`mod-step-${i}`}
                        className="select"
                        value={draft.steps[i]}
                        onChange={(e) => {
                          const steps = [...draft.steps] as ModSettings['steps'];
                          steps[i] = Number(e.target.value);
                          tune({ steps });
                        }}
                      >
                        {(STEP_CHOICES.includes(draft.steps[i]) ? STEP_CHOICES : [...STEP_CHOICES, draft.steps[i]].sort((a, b) => a - b)).map((s) => (
                          <option key={s} value={s}>{timeoutText(s)}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label className="field" htmlFor="mod-exempt">
                    Never moderated
                    <select id="mod-exempt" className="select" value={draft.exempt} onChange={(e) => tune({ exempt: e.target.value as UserLevel })}>
                      {EXEMPT.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                  </label>
                </div>
                <p className="field-hint">Strikes are forgotten after an hour without one. You and your moderators are never moderated.</p>
              </div>
            </fieldset>
          </Card>

          <Card id="mod-lists" title="Words and sites" desc="One per line. Banned words apply whatever the preset, and match whole words, ignoring capitals.">
            <fieldset className="card-body mod-lists" disabled={off}>
              <legend className="sr-only">Words and sites</legend>
              <label className="field" htmlFor="mod-words">
                <span className="field-row">Banned words and phrases<span className="field-hint">{lines(words).length} / 200</span></span>
                <textarea id="mod-words" className="input textarea" rows={6} value={words} placeholder={'one word\nor a whole phrase'} onChange={(e) => setWords(e.target.value)} />
              </label>
              <label className="field" htmlFor="mod-sites">
                <span className="field-row">Allowed sites<span className="field-hint">Their subdomains count too</span></span>
                <textarea id="mod-sites" className="input textarea" rows={6} value={sites} placeholder="clips.twitch.tv" onChange={(e) => setSites(e.target.value)} />
              </label>
              <div className="field inline wide">
                <span>Say why in chat, such as &ldquo;@Maple, links are not allowed here (message removed).&rdquo;</span>
                <button className="switch" type="button" role="switch" aria-checked={draft.notice} aria-label="Say why in chat"
                  onClick={() => setDraft({ ...draft, notice: !draft.notice })} />
              </div>
            </fieldset>
          </Card>

          {changed && (
            <div className="save-bar" role="region" aria-label="Unsaved changes">
              <span>You have changes that are not saved yet.</span>
              <button className="btn ghost" type="button" disabled={busy} onClick={() => adopt(view)}>Discard</button>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving' : 'Save changes'}</button>
            </div>
          )}

          <TryMessage settings={next} />
          <ActionLog permission={view.permission} />
        </div>
      )}
    </div>
  );
}

function RuleRow({ name, desc, on, onToggle, children }: {
  name: string; desc?: string; on: boolean; onToggle(v: boolean): void; children?: ReactNode;
}) {
  return (
    <li className={'type mod-rule' + (on ? '' : ' off')}>
      <div className="type-row">
        <div className="type-main">
          <b>{name}</b>
          {desc ? <span>{desc}</span> : <div className="mod-limits">{children}</div>}
        </div>
        <button className="switch" type="button" role="switch" aria-checked={on} aria-label={name} onClick={() => onToggle(!on)} />
      </div>
    </li>
  );
}

function NumberField({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange(n: number): void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <input
      className="input num-input"
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
    />
  );
}

function TryMessage({ settings }: { settings: ModSettings }) {
  const ch = useChannel();
  const [text, setText] = useState('');
  const [level, setLevel] = useState<UserLevel>('everyone');
  const [result, setResult] = useState<{ text: string; r: ModTry } | { text: string; error: string } | null>(null);

  const run = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      setResult({ text: t, r: await api.tryModeration(ch.key, t, level, settings) });
    } catch (x) {
      setResult({ text: t, error: errorText(x) });
    }
  };

  let answer: ReactNode = null;
  if (result && 'error' in result) answer = <p className="bubble bad">{result.error}</p>;
  else if (result) {
    const { r } = result;
    if (settings.preset === 'off') answer = <p className="bubble muted">Moderation is off, so this message stays.</p>;
    else if (r.skipped) answer = <p className="bubble muted">This chatter is never moderated, so the message stays.</p>;
    else if (!r.rule) answer = <p className="bubble ok">This message is fine. It stays in chat.</p>;
    else {
      answer = (
        <div className="bubble">
          <p><b className="bad-text">Caught by {RULE_NAMES[r.rule]}.</b></p>
          <ol className="mod-ladder">
            {r.steps.map((s, i) => (
              <li key={i}><span>{['First time', 'Second time', 'Third time and after'][i]}</span>{timeoutText(s)}</li>
            ))}
          </ol>
        </div>
      );
    }
  }

  return (
    <Card id="mod-try" title="Try a message" desc="See what your rules, saved or not, would do with a message. Nothing goes to Twitch.">
      <form className="test-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label className="sr-only" htmlFor="mod-try-level">Send as</label>
        <select id="mod-try-level" className="select" value={level} onChange={(e) => setLevel(e.target.value as UserLevel)}>
          <option value="everyone">As a viewer</option>
          <option value="subscriber">As a subscriber</option>
          <option value="vip">As a VIP</option>
          <option value="moderator">As a moderator</option>
        </select>
        <label className="sr-only" htmlFor="mod-try-text">Message</label>
        <input id="mod-try-text" className="input" placeholder="FREE FOLLOWERS at cheap.xyz" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" type="submit" disabled={!text.trim()}>Check</button>
      </form>
      <div className="mod-answer" aria-live="polite">
        {result ? <><p className="mod-quote">{result.text}</p>{answer}</> : <p className="bubble muted">Try a link, a line in capitals, or a word from your list.</p>}
      </div>
    </Card>
  );
}

function when(at: number): string {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ActionLog({ permission }: { permission: ModView['permission'] }) {
  const ch = useChannel();
  const toast = useToast();
  const [entries, setEntries] = useState<ModEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [, tick] = useState(0);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const { entries: fresh } = await api.modLog(ch.key);
      if (!loaded.current) setMore(fresh.length === 50);
      loaded.current = true;
      // Keep older pages that were shown below the newest one.
      const oldest = fresh.at(-1)?.id ?? Infinity;
      setEntries((old) => [...fresh, ...(old ?? []).filter((e) => e.id < oldest)]);
    } catch {
      setEntries((old) => old ?? []);
    }
  }, [ch.key]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) { void load(); tick((n) => n + 1); } }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const older = async () => {
    if (!entries?.length) return;
    try {
      const { entries: page } = await api.modLog(ch.key, entries[entries.length - 1].id);
      setEntries([...entries, ...page]);
      setMore(page.length === 50);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const lift = async (e: ModEntry) => {
    try {
      const done = await api.undoModAction(ch.key, e.id);
      setEntries((list) => list?.map((x) => (x.id === e.id ? done : x)) ?? null);
      toast(`${e.user} can chat again`);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const now = Date.now();
  return (
    <Card
      id="mod-log"
      title="What Sylva did"
      desc="Every message Sylva removed and every timeout. A timeout can be lifted while it lasts; Twitch cannot bring back a removed message."
      action={<button className="btn sm ghost" type="button" onClick={() => void load()}><Icon id="refresh" />Refresh</button>}
    >
      {entries === null && <p className="empty">Loading</p>}
      {entries?.length === 0 && (
        <p className="empty">
          <Icon id="shield" />
          {permission === 'ok' ? 'Nothing yet. When a message breaks a rule, it shows here.' : 'Nothing yet. Allow moderation and turn on a preset, and actions show here.'}
        </p>
      )}
      {!!entries?.length && (
        <ul className="types mod-log">
          {entries.map((e) => {
            const active = e.action === 'timeout' && e.result === 'done' && !e.undoneAt && e.at + e.seconds * 1000 > now;
            return (
              <li key={e.id} className="type">
                <div className="type-row">
                  <div className="type-main">
                    <b>{e.user}<span className="mod-tag">{RULE_NAMES[e.rule]}</span></b>
                    <span className="mod-msg">{e.message}</span>
                    <span className={'mod-what' + (e.result === 'failed' ? ' bad-text' : '')}>
                      {e.result === 'failed'
                        ? `Not done: ${e.detail ?? 'Twitch said no'}`
                        : e.action === 'delete' ? 'Message removed' : `Timed out for ${lasting(e.seconds)}`}
                      {e.undoneAt ? ' · lifted' : ''}
                      {' · '}
                      <time dateTime={new Date(e.at).toISOString()}>{when(e.at)}</time>
                    </span>
                  </div>
                  {active && <button className="btn sm" type="button" onClick={() => void lift(e)}><Icon id="undo" />Lift timeout</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more && <div className="card-body load-more"><button className="btn sm" type="button" onClick={() => void older()}>Show older</button></div>}
    </Card>
  );
}

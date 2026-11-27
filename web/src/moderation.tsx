// The Moderation page: pick how strict chat should be, tune each filter,
// and read what Sylva did. Saves as you go. The rules match
// crates/sylva-core/src/moderation.rs, which checks every save again.

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  api, type ModEntry, type ModPreset, type ModRule, type ModRules, type ModSettings, type ModView,
  type UserLevel,
} from './api';
import { useChannel } from './channel';
import { Card, PageHead } from './pages';
import { errorText, Gate, Icon, SaveState, Seg, Skel, SkelRows, Switch, useAutosave, useToast } from './ui';

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
  nuke: 'Nuke',
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
  const [view, setView] = useState<ModView | null>(null);
  const [failed, setFailed] = useState(false);
  const mod = useAutosave<ModSettings>((v) => api.saveModeration(ch.key, v).then((r) => { setView(r); return r.settings; }));
  const [words, setWords] = useState('');
  const [sites, setSites] = useState('');

  useEffect(() => {
    setFailed(false);
    api.moderation(ch.key).then((v) => {
      setView(v);
      mod.reset(v.settings);
      setWords(v.settings.words.join('\n'));
      setSites(v.settings.allowedLinks.join('\n'));
    }).catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch.key]);

  const draft = mod.value;
  // The lists follow the settings (after an undo, say) unless you are typing in them.
  const listKey = draft ? JSON.stringify([draft.words, draft.allowedLinks]) : '';
  useEffect(() => {
    if (!draft) return;
    const typing = document.activeElement?.id === 'mod-words' || document.activeElement?.id === 'mod-sites';
    if (!typing) { setWords(draft.words.join('\n')); setSites(draft.allowedLinks.join('\n')); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);
  const presetInfo = (p: ModPreset) => view?.presets.find(([id]) => id === p)?.[1];
  const pick = (p: ModPreset) => {
    if (!draft) return;
    const info = presetInfo(p);
    mod.set(info ? { ...draft, preset: p, ...info } : { ...draft, preset: p }, true);
  };
  // Changing any rule by hand makes it Custom.
  const tune = (patch: Partial<ModSettings>, now = true) => draft && mod.set({ ...draft, ...patch, preset: 'custom' }, now);
  const rule = <K extends keyof ModRules>(k: K, v: ModRules[K]) => draft && tune({ rules: { ...draft.rules, [k]: v } });
  const commitLists = () => {
    if (!draft) return;
    const w = lines(words);
    const a = lines(sites);
    if (!same(w, draft.words) || !same(a, draft.allowedLinks)) mod.set({ ...draft, words: w, allowedLinks: a }, true);
  };

  const off = draft?.preset === 'off';
  const what = PRESETS.find((p) => p.id === draft?.preset)?.what;
  const steps = ['First time', 'Second time', 'Third time and after'] as const;

  return (
    <div className="page moderation-page">
      <PageHead title="Moderation" desc="Sylva cleans up chat for you. It removes the message first, and times out chatters who keep going.">
        <SaveState saving={mod.saving} savedAt={mod.savedAt} canUndo={mod.canUndo} onUndo={mod.undo} />
      </PageHead>
      {failed && !view && <div className="notice">Could not load moderation. Refresh to try again.</div>}
      {view?.permission === 'notMod' && (
        <div className="notice">
          <span>
            Sylva moderates as <b>Sylva_Bot</b>, so deletes, timeouts and bans never show as {ch.can.own ? 'you' : ch.name}.
            Make it a moderator first: type <code>/mod sylva_bot</code> in {ch.can.own ? 'your' : `${ch.name}'s`} chat.
          </span>
        </div>
      )}
      {view?.permission === 'botMissing' && (view.operator && ch.can.own ? (
        <div className="notice">
          <span>
            Your rules are paused because Sylva_Bot has not given Sylva permission to moderate yet.
            Sign in to Twitch as <b>sylva_bot</b> (a private window is easiest), then open Set up Sylva_Bot and choose Authorize.
          </span>
          <a className="btn primary sm" href="/auth/twitch/bot" target="_blank" rel="noopener"><Icon id="twitch" />Set up Sylva_Bot</a>
        </div>
      ) : (
        <div className="notice"><span>Sylva_Bot is not set up to moderate yet, so your rules are paused. Sylva is fixing this, and nothing is needed from you.</span></div>
      ))}
      {(view?.permission === 'missing' || view?.permission === 'expired') && (
        <div className="notice">
          <span>
            {!ch.can.own
              ? `Sylva cannot moderate ${ch.name}'s chat until ${ch.name} allows it on this page.`
              : view.permission === 'expired'
                ? 'Twitch no longer accepts Sylva’s permission to moderate. Allow it again to keep your rules working.'
                : 'Sylva needs your permission to remove messages and time out chatters in your chat.'}
          </span>
          {ch.can.own && <a className="btn primary sm" href={ALLOW_URL}><Icon id="twitch" />Allow moderation</a>}
        </div>
      )}

      <div className="mod-cols">
        <div className="stack">
          <Gate on={ch.can.edit} className="stack">
            <section className="sect" aria-labelledby="mod-filters">
              <div className="sect-head">
                <div><h2 id="mod-filters">Filters</h2>{what && <p>{what}</p>}</div>
                <div className="page-actions">
                  {draft ? <Seg label="How strict" small options={PRESETS.map((p) => ({ id: p.id, label: p.label }))} value={draft.preset} onChange={pick} /> : <Skel w={300} h={32} round />}
                </div>
              </div>
              {!draft ? <div className="grp"><SkelRows n={7} tile={false} /></div> : (
                <fieldset className="grp mod-rules" disabled={off}>
                  <legend className="sr-only">Filters</legend>
                  <RuleRow name="Links" desc="Any website that is not on your allowed list" on={draft.rules.links} onToggle={(v) => rule('links', v)} />
                  <RuleRow name="All caps" on={draft.rules.caps.on} onToggle={(v) => rule('caps', { ...draft.rules.caps, on: v })}>
                    <NumberField label="Percent capitals" value={draft.rules.caps.percent} min={10} max={100} onChange={(n) => rule('caps', { ...draft.rules.caps, percent: n })} />
                    <span>% or more, from</span>
                    <NumberField label="Letters" value={draft.rules.caps.min} min={1} max={500} onChange={(n) => rule('caps', { ...draft.rules.caps, min: n })} />
                    <span>letters</span>
                  </RuleRow>
                  <RuleRow name="Symbols" on={draft.rules.symbols.on} onToggle={(v) => rule('symbols', { ...draft.rules.symbols, on: v })}>
                    <NumberField label="Percent symbols" value={draft.rules.symbols.percent} min={10} max={100} onChange={(n) => rule('symbols', { ...draft.rules.symbols, percent: n })} />
                    <span>% or more, from</span>
                    <NumberField label="Characters" value={draft.rules.symbols.min} min={1} max={500} onChange={(n) => rule('symbols', { ...draft.rules.symbols, min: n })} />
                    <span>characters</span>
                  </RuleRow>
                  <RuleRow name="Emote spam" on={draft.rules.emotes.on} onToggle={(v) => rule('emotes', { ...draft.rules.emotes, on: v })}>
                    <span>More than</span>
                    <NumberField label="Most emotes" value={draft.rules.emotes.max} min={1} max={100} onChange={(n) => rule('emotes', { ...draft.rules.emotes, max: n })} />
                    <span>emotes</span>
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
                  <RuleRow name="Glitched text" desc="Letters with stacked marks, often used to cover up chat" on={draft.rules.zalgo} onToggle={(v) => rule('zalgo', v)} />
                </fieldset>
              )}
            </section>

            <section className="sect" aria-labelledby="mod-steps">
              <div className="sect-head"><div><h2 id="mod-steps">Timeouts</h2></div></div>
              {!draft ? <div className="grp"><SkelRows n={4} tile={false} /></div> : (
                <fieldset className="grp" disabled={off}>
                  <legend className="sr-only">Timeouts</legend>
                  {steps.map((label, i) => (
                    <div className="gr" key={label}>
                      <div className="gr-main"><label className="t1" htmlFor={`mod-step-${i}`}>{label}</label></div>
                      <div className="gr-ctl">
                        <select id={`mod-step-${i}`} className="select sm" value={draft.steps[i]}
                          onChange={(e) => { const next = [...draft.steps] as ModSettings['steps']; next[i] = Number(e.target.value); tune({ steps: next }); }}>
                          {(STEP_CHOICES.includes(draft.steps[i]) ? STEP_CHOICES : [...STEP_CHOICES, draft.steps[i]].sort((a, b) => a - b)).map((x) => (
                            <option key={x} value={x}>{timeoutText(x)}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                  <div className="gr">
                    <div className="gr-main"><label className="t1" htmlFor="mod-exempt">Never moderated</label><div className="t2">You and your moderators never are</div></div>
                    <div className="gr-ctl">
                      <select id="mod-exempt" className="select sm" value={draft.exempt} onChange={(e) => tune({ exempt: e.target.value as UserLevel })}>
                        {EXEMPT.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="gr">
                    <div className="gr-main"><div className="t1">Say why in chat</div><div className="t2">Such as &ldquo;@Maple, links are not allowed here (message removed)&rdquo;</div></div>
                    <div className="gr-ctl"><Switch label="Say why in chat" on={draft.notice} onChange={(v) => mod.set({ ...draft, notice: v }, true)} /></div>
                  </div>
                </fieldset>
              )}
              <p className="sect-foot">Strikes are forgotten after an hour without one.</p>
            </section>

            <section className="sect" aria-labelledby="mod-lists">
              <div className="sect-head"><div><h2 id="mod-lists">Words and sites</h2><p>One per line. Banned words apply whatever the filters, and match whole words, ignoring capitals.</p></div></div>
              <fieldset className="grp mod-lists" disabled={!draft || off}>
                <legend className="sr-only">Words and sites</legend>
                <label className="field" htmlFor="mod-words">
                  <span className="field-row">Banned words and phrases<span className="field-hint">{lines(words).length} / 200</span></span>
                  <textarea id="mod-words" className="input" rows={6} value={words} placeholder={'one word\nor a whole phrase'} onChange={(e) => setWords(e.target.value)} onBlur={commitLists} />
                </label>
                <label className="field" htmlFor="mod-sites">
                  <span className="field-row">Allowed sites<span className="field-hint">Their subdomains count too</span></span>
                  <textarea id="mod-sites" className="input" rows={6} value={sites} placeholder="clips.twitch.tv" onChange={(e) => setSites(e.target.value)} onBlur={commitLists} />
                </label>
              </fieldset>
              <p className="sect-foot">Lists save when you click away from them.</p>
            </section>
          </Gate>
        </div>
        <ActionLog permission={view?.permission ?? 'ok'} />
      </div>
    </div>
  );
}

function RuleRow({ name, desc, on, onToggle, children }: {
  name: string; desc?: string; on: boolean; onToggle(v: boolean): void; children?: ReactNode;
}) {
  return (
    <div className={'gr mod-rule' + (on ? '' : ' off')}>
      <div className="gr-main">
        <div className="t1">{name}</div>
        {desc ? <div className="t2">{desc}</div> : <div className="mod-limits">{children}</div>}
      </div>
      <div className="gr-ctl"><Switch label={name} on={on} onChange={onToggle} /></div>
    </div>
  );
}

export function NumberField({ label, value, min, max, onChange }: {
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
      title="Recent actions"
      action={<button className="btn sm ghost" type="button" onClick={() => void load()}><Icon id="refresh" />Refresh</button>}
    >
      {entries === null && <SkelRows n={4} tile={false} />}
      {entries?.length === 0 && (
        <p className="empty">
          <Icon id="shield" />
          {permission === 'ok' ? 'Nothing yet. When a message breaks a rule, it shows here.' : 'Nothing yet. Allow moderation and turn on a preset, and actions show here.'}
        </p>
      )}
      {!!entries?.length && (
        <ul className="types mod-log">
          {entries.map((e) => {
            const active = e.result === 'done' && !e.undoneAt && (e.action === 'ban' || (e.action === 'timeout' && e.at + e.seconds * 1000 > now));
            return (
              <li key={e.id} className="type">
                <div className="type-row">
                  <div className="type-main">
                    <b>{e.user}<span className="mod-tag">{RULE_NAMES[e.rule]}</span></b>
                    <span className="mod-msg">{e.message}</span>
                    <span className={'mod-what' + (e.result === 'failed' ? ' bad-text' : '')}>
                      {e.result === 'failed'
                        ? `Not done: ${e.detail ?? 'Twitch said no'}`
                        : e.action === 'delete' ? 'Message removed' : e.action === 'ban' ? 'Banned' : `Timed out for ${lasting(e.seconds)}`}
                      {e.undoneAt ? (e.action === 'ban' ? ' · unbanned' : ' · lifted') : ''}
                      {' · '}
                      <time dateTime={new Date(e.at).toISOString()}>{when(e.at)}</time>
                    </span>
                  </div>
                  {active && ch.can.moderate && <button className="btn sm" type="button" onClick={() => void lift(e)}><Icon id="undo" />{e.action === 'ban' ? 'Unban' : 'Lift timeout'}</button>}
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

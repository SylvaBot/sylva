// The Commands page: the chat bot's commands, the built-in ones, timers,
// counters and quotes. A side panel edits one at a time, with a preview of
// how it looks in Twitch chat. The rules match crates/sylva-core/src/bot.rs,
// which checks every save again.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type BotCommand, type BotSettings, type BotTimer, type BotView, type Builtin, type BuiltinSetting, type TimerStatus, type UserLevel } from './api';
import { useChannel } from './channel';
import { Counters, Quotes } from './community';
import { PageHead } from './pages';
import { Link, navigate, useSearch } from './router';
import { ArmedButton, Drawer, errorText, Gate, Icon, MOD_BADGE, num, Seg, Skel, Switch, Tile, useToast } from './ui';

export const LEVELS: { id: UserLevel; label: string; short: string }[] = [
  { id: 'everyone', label: 'Everyone', short: 'Everyone' },
  { id: 'subscriber', label: 'Subscribers and up', short: 'Subs' },
  { id: 'vip', label: 'VIPs and up', short: 'VIPs' },
  { id: 'moderator', label: 'Moderators', short: 'Mods' },
  { id: 'broadcaster', label: 'Only you', short: 'Only you' },
];
const levelOf = (id: UserLevel) => LEVELS.find((l) => l.id === id) ?? LEVELS[0];
const LEVEL_ORDER: UserLevel[] = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];

const COOLDOWNS = [0, 5, 10, 30, 60, 300];
/** A cooldown in a few characters: 30s, 1m, 1h. */
export function short(n: number): string {
  if (n === 0) return 'None';
  if (n < 60) return `${n}s`;
  if (n < 3600) return n % 60 === 0 ? `${n / 60}m` : `${Math.round(n / 60)}m`;
  return n % 3600 === 0 ? `${n / 3600}h` : `${Math.round(n / 60)}m`;
}
export function seconds(n: number): string {
  if (n === 0) return 'None';
  if (n < 60) return `${n} seconds`;
  if (n < 3600) return n % 60 === 0 ? `${n / 60} minute${n === 60 ? '' : 's'}` : `${Math.round(n / 60)} minutes`;
  return '1 hour';
}
const withValue = (list: number[], n: number) => (list.includes(n) ? list : [...list, n].sort((a, b) => a - b));

const MAX_REPLY = 500;
const VARIABLES: { v: string; what: string }[] = [
  { v: '${user}', what: 'The viewer who used the command' },
  { v: '${touser}', what: 'The name after the command, or the viewer' },
  { v: '${1}', what: 'The first word after the command (up to ${9})' },
  { v: '${args}', what: 'Everything after the command' },
  { v: '${channel}', what: 'Your name' },
  { v: '${count}', what: 'How many times it has been used' },
  { v: '${uptime}', what: 'How long you have been live' },
  { v: '${random.1-100}', what: 'A random number in that range' },
  { v: '${commands}', what: 'Every command anyone can use' },
];
const blank = (): BotCommand => ({ name: '', aliases: [], reply: '', level: 'everyone', cooldown: 0, userCooldown: 0, enabled: true, count: 0 });

type Tab = 'commands' | 'timers' | 'counters' | 'quotes';
const TABS: { id: Tab; label: string }[] = [
  { id: 'commands', label: 'Commands' }, { id: 'timers', label: 'Timers' }, { id: 'counters', label: 'Counters' }, { id: 'quotes', label: 'Quotes' },
];
const ALLOW_COMMANDS_URL = '/auth/twitch/start?scopes=commands&next=/app/commands';
type Save = (next: BotSettings, done?: string, undo?: BotSettings) => Promise<boolean>;

function tabOf(search: string): Tab {
  const t = new URLSearchParams(search).get('tab') ?? location.hash.slice(1);
  return TABS.some((x) => x.id === t) ? (t as Tab) : 'commands';
}

export function CommandsPage() {
  const ch = useChannel();
  const toast = useToast();
  const search = useSearch();
  const tab = tabOf(search);
  const [view, setView] = useState<BotView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    api.bot(ch.key).then(setView).catch(() => setFailed(true));
  }, [ch.key]);

  const save: Save = async (next, done, undo) => {
    try {
      setView(await api.saveBot(ch.key, next));
      if (done) toast(done, false, undo && { label: 'Undo', run: () => { void save(undo, 'Brought back'); } });
      return true;
    } catch (x) {
      toast(errorText(x), true);
      return false;
    }
  };
  const go = (t: Tab) => navigate('/app/commands' + (t === 'commands' ? '' : '?tab=' + t));
  const settings = view?.settings;
  const sender = view?.sender.kind === 'streamer' ? ch.name : 'Sylva_Bot';

  return (
    <div className="page commands-page">
      <PageHead title="Commands" desc="Words viewers type in chat, and what Sylva replies with.">
        <Seg label="Show" options={TABS} value={tab} onChange={go} />
      </PageHead>

      <div className="grp link-card">
        <Tile icon="bot" />
        <div className="gr-main">
          <div className="t1">Chat bot</div>
          <div className="t2">
            {!settings ? ' ' : settings.enabled
              ? `On. Replies come from ${sender}${view?.sender.kind === 'streamer' ? ' with Twitch’s Chat Bot badge' : ''}`
              : 'Off. Nothing on this page answers in chat until it is on'}
          </div>
        </div>
        <div className="link-ctl">
          {settings ? <Switch label="Chat bot" on={settings.enabled} disabled={!ch.can.edit}
            onChange={(v) => void save({ ...settings, enabled: v }, v ? 'The bot is on' : 'The bot is off')} /> : <Skel w={40} h={22} round />}
        </div>
      </div>

      {failed && !view && <div className="notice">Could not load your commands. Refresh to try again.</div>}
      {tab === 'commands' && <CommandsTab view={view} save={save} sender={sender} />}
      {tab === 'timers' && (view ? <Gate on={ch.can.edit}><Timers view={view} onSave={save} onView={setView} /></Gate> : <TableSkel cols="tm-cols" />)}
      {tab === 'counters' && (view ? <Counters view={view} onSave={save} onView={setView} /> : <TableSkel cols="tm-cols" />)}
      {tab === 'quotes' && (view ? <Quotes view={view} onSave={save} /> : <TableSkel cols="tm-cols" />)}
    </div>
  );
}

function TableSkel({ cols, n = 4 }: { cols: string; n?: number }) {
  return (
    <section className="sect">
      <div className="sect-head"><div><Skel w={110} h={13} /></div></div>
      <div className="grp">
        {Array.from({ length: n }, (_, i) => (
          <div className={'gr ' + cols} key={i}><Skel w={80} h={14} /><Skel w="70%" h={14} /><Skel w={60} h={14} /><Skel w={40} h={14} /><Skel w={40} h={22} round /></div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Commands */

function CommandsTab({ view, save, sender }: { view: BotView | null; save: Save; sender: string }) {
  const ch = useChannel();
  const search = useSearch();
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [builtin, setBuiltin] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // The search's New command action opens the editor.
  useEffect(() => {
    if (new URLSearchParams(search).get('new') && view && ch.can.edit) {
      setOpen('new');
      navigate('/app/commands', true);
    }
  }, [search, view, ch.can.edit]);

  if (!view) return <><TableSkel cols="cm-cols" /><TableSkel cols="cm-cols" /></>;
  const settings = view.settings;
  const q = query.trim().toLowerCase().replace(/^!/, '');
  const match = (name: string, aliases: string[], text: string) =>
    !q || name.toLowerCase().includes(q) || aliases.some((a) => a.toLowerCase().includes(q)) || text.toLowerCase().includes(q);
  const mine = (b: Builtin): BuiltinSetting => settings.builtins.find((s) => s.name === b.name) ?? { name: b.name, enabled: b.on, level: b.level, cooldown: b.cooldown };
  const replaced = (b: Builtin) => settings.commands.some((c) => c.name === b.name || c.aliases.includes(b.name)) || settings.counters.some((c) => c.name === b.name);
  const setBuiltinSetting = (b: Builtin, patch: Partial<BuiltinSetting>, done: string) => save({
    ...settings, builtins: view.builtins.map((x) => (x.name === b.name ? { ...mine(x), ...patch } : mine(x))),
  }, done);
  const waiting = (needs: 'commands' | 'moderation') => view.permissions[needs] !== 'ok'
    && view.builtins.some((b) => b.needs === needs && mine(b).enabled && !replaced(b));
  const commands = settings.commands.map((c, i) => ({ c, i })).filter(({ c }) => match(c.name, c.aliases, c.reply));
  const builtins = view.builtins.filter((b) => match(b.name, b.aliases, b.about));
  const editing = open === 'new' ? blank() : open !== null ? settings.commands[open] : undefined;
  const editingBuiltin = builtin ? view.builtins.find((b) => b.name === builtin) : undefined;

  return (
    <>
      <section className="sect" aria-labelledby="cmds-title">
        <div className="sect-head">
          <div><h2 id="cmds-title">Your commands</h2></div>
          <div className="page-actions">
            {(settings.commands.length + view.builtins.length) > 10 && (
              <label className="search cmd-search">
                <Icon id="search" /><span className="sr-only">Find a command</span>
                <input className="input sm" type="search" placeholder="Find a command" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
            )}
            <button className="btn sm primary" type="button" disabled={!ch.can.edit || settings.commands.length >= 100} onClick={() => setOpen('new')}><Icon id="plus" />New command</button>
          </div>
        </div>
        <div className="tbl-head cm-cols" aria-hidden="true"><span>Command</span><span>Reply</span><span>Who can use</span><span>Cooldown</span><span /></div>
        <div className="grp">
          {settings.commands.length === 0 && <div className="empty">No commands yet. Add one, such as !discord with a link to your server.</div>}
          {settings.commands.length > 0 && commands.length === 0 && <div className="empty">No command of yours matches that.</div>}
          {commands.map(({ c, i }) => (
            <div className={'gr cm-cols cm-row' + (c.enabled ? '' : ' off')} key={c.name + i}>
              <button className="cm-open" type="button" onClick={() => setOpen(i)} aria-label={`Edit !${c.name}`}>
                <span className="cm-name mono">!{c.name}</span>
              </button>
              <button className="cm-open cm-reply" type="button" tabIndex={-1} onClick={() => setOpen(i)}>{c.reply}</button>
              <span className="muted">{levelOf(c.level).short}</span>
              <span className="muted">{c.cooldown ? short(c.cooldown) : c.userCooldown ? `${short(c.userCooldown)} each` : 'None'}</span>
              <Switch label={`!${c.name}`} on={c.enabled} disabled={!ch.can.edit}
                onChange={(v) => void save({ ...settings, commands: settings.commands.map((x, j) => (j === i ? { ...x, enabled: v } : x)) }, `!${c.name} ${v ? 'on' : 'off'}`)} />
            </div>
          ))}
        </div>
      </section>

      <section className="sect" aria-labelledby="builtin-title">
        <div className="sect-head"><div><h2 id="builtin-title">Built in</h2><p>Ready in every channel. A command of yours with the same name takes its place.</p></div></div>
        {waiting('commands') && (
          <div className="notice">
            <span>Some built-in commands need {ch.can.own ? 'your' : `${ch.name}'s`} permission{view.permissions.commands === 'expired' ? ' again, because Twitch no longer accepts the old one.' : ' to make clips, change the title and category, and see followers.'}</span>
            {ch.can.own && <a className="btn primary sm" href={ALLOW_COMMANDS_URL}><Icon id="twitch" />Allow</a>}
          </div>
        )}
        {waiting('moderation') && (
          <div className="notice">
            <span>
              Moderation commands need
              {view.permissions.moderation === 'notMod' ? ' Sylva_Bot to be a moderator. Type /mod sylva_bot in chat.'
                : view.permissions.moderation === 'botMissing' ? ' Sylva_Bot, which is not set up to moderate yet.'
                  : ' Sylva to be allowed to moderate, on the Moderation page.'}
            </span>
            <Link className="btn sm" href="/app/moderation">Open Moderation</Link>
          </div>
        )}
        <div className="grp">
          {builtins.length === 0 && <div className="empty">No built-in command matches that.</div>}
          {builtins.map((b) => {
            const s = mine(b);
            const over = replaced(b);
            const quotesOff = b.group === 'quotes' && !settings.quotes.enabled;
            return (
              <div className={'gr cm-cols cm-row' + (s.enabled && !over && !quotesOff ? '' : ' off')} key={b.name}>
                <button className="cm-open" type="button" onClick={() => setBuiltin(b.name)} aria-label={`Edit !${b.name}`}>
                  <span className="cm-name mono">!{b.name}</span>
                </button>
                <button className="cm-open cm-reply" type="button" tabIndex={-1} onClick={() => setBuiltin(b.name)}>
                  {over ? `Replaced by your own !${b.name}` : quotesOff ? 'Quotes are off in chat' : b.about}
                </button>
                <span className="muted">{levelOf(s.level).short}</span>
                <span className="muted">{short(s.cooldown)}</span>
                <Switch label={`!${b.name}`} on={s.enabled} disabled={!ch.can.edit}
                  onChange={(v) => void setBuiltinSetting(b, { enabled: v }, `!${b.name} ${v ? 'on' : 'off'}`)} />
              </div>
            );
          })}
        </div>
        <p className="sect-foot">Moderators skip cooldowns. Viewers see every command at the link the bot gives for !commands.</p>
      </section>

      {editing && (
        <CommandDrawer key={String(open)} command={editing} isNew={open === 'new'} index={open === 'new' ? undefined : (open as number)}
          settings={settings} sender={sender} readOnly={!ch.can.edit} onClose={() => setOpen(null)}
          onDelete={open === 'new' ? undefined : async () => {
            const i = open as number;
            if (await save({ ...settings, commands: settings.commands.filter((_, j) => j !== i) }, `!${editing.name} deleted`, settings)) setOpen(null);
          }}
          onSave={async (c) => {
            const next = open === 'new' ? [...settings.commands, c] : settings.commands.map((x, j) => (j === open ? c : x));
            if (await save({ ...settings, commands: next }, open === 'new' ? `!${c.name.toLowerCase()} added` : `!${c.name} saved`)) setOpen(null);
          }} />
      )}
      {editingBuiltin && (
        <BuiltinDrawer b={editingBuiltin} s={mine(editingBuiltin)} readOnly={!ch.can.edit} onClose={() => setBuiltin(null)}
          onSet={(patch) => void setBuiltinSetting(editingBuiltin, patch, `Saved !${editingBuiltin.name}`)} />
      )}
    </>
  );
}

/** Who can use it, as a segmented choice. */
function WhoSeg({ value, min = 'everyone', onChange, disabled }: { value: UserLevel; min?: UserLevel; onChange(v: UserLevel): void; disabled?: boolean }) {
  const levels = LEVELS.filter((l) => LEVEL_ORDER.indexOf(l.id) >= LEVEL_ORDER.indexOf(min));
  return <Seg label="Who can use it" small options={levels.map((l) => ({ id: l.id, label: l.short }))} value={value} onChange={onChange} disabled={disabled} />;
}
function CooldownSeg({ label, value, onChange, disabled }: { label: string; value: number; onChange(v: number): void; disabled?: boolean }) {
  return <Seg label={label} small options={withValue(COOLDOWNS, value).map((n) => ({ id: n, label: short(n) }))} value={value} onChange={onChange} disabled={disabled} />;
}

function BuiltinDrawer({ b, s, readOnly, onClose, onSet }: { b: Builtin; s: BuiltinSetting; readOnly: boolean; onClose(): void; onSet(p: Partial<BuiltinSetting>): void }) {
  return (
    <Drawer title={<span className="mono">!{b.name}</span>} label={`!${b.name}`} onClose={onClose}>
      <p className="muted small">{b.about}</p>
      <div className="grp">
        <div className="gr"><div className="gr-main"><div className="t1">Type</div></div><div className="gr-ctl"><code className="mono">{b.usage}</code></div></div>
        {b.aliases.length > 0 && <div className="gr"><div className="gr-main"><div className="t1">Also answers to</div></div><div className="gr-ctl mono">{b.aliases.map((a) => '!' + a).join(' ')}</div></div>}
        <div className="gr"><div className="gr-main"><div className="t1">On</div></div><div className="gr-ctl"><Switch label={`!${b.name}`} on={s.enabled} disabled={readOnly} onChange={(v) => onSet({ enabled: v })} /></div></div>
        <div className="gr stack-sm"><div className="gr-main"><div className="t1">Who can use it</div></div><div className="gr-ctl"><WhoSeg value={s.level} min={b.min} disabled={readOnly} onChange={(v) => onSet({ level: v })} /></div></div>
        <div className="gr stack-sm"><div className="gr-main"><div className="t1">Cooldown</div><div className="t2">For all of chat</div></div><div className="gr-ctl"><CooldownSeg label="Cooldown" value={s.cooldown} disabled={readOnly} onChange={(v) => onSet({ cooldown: v })} /></div></div>
      </div>
      <p className="sect-foot">Changes save as you make them.</p>
    </Drawer>
  );
}

function CommandDrawer({ command, isNew, index, settings, sender, readOnly, onSave, onClose, onDelete }: {
  command: BotCommand; isNew: boolean; index?: number; settings: BotSettings; sender: string; readOnly: boolean;
  onSave(c: BotCommand): Promise<void>; onClose(): void; onDelete?(): Promise<void>;
}) {
  const ch = useChannel();
  const [draft, setDraft] = useState(command);
  const [alias, setAlias] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ text: string; bad: boolean } | null>(null);
  const reply = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<BotCommand>) => setDraft((d) => ({ ...d, ...patch }));
  const per: 'all' | 'each' = draft.cooldown === 0 && draft.userCooldown > 0 ? 'each' : 'all';
  const cool = per === 'each' ? draft.userCooldown : draft.cooldown;

  const full = useMemo<BotCommand>(() => ({ ...draft, name: draft.name.trim().replace(/^!+/, '').toLowerCase() }), [draft]);
  const addAlias = () => {
    const a = alias.trim().replace(/^!+/, '').toLowerCase();
    if (a && !draft.aliases.includes(a) && draft.aliases.length < 5 && a !== full.name) set({ aliases: [...draft.aliases, a] });
    setAlias('');
  };

  // The preview runs the unsaved command through the server's own bot.
  useEffect(() => {
    if (!full.name || !full.reply.trim()) { setPreview(null); return; }
    const t = setTimeout(async () => {
      const commands = index === undefined ? [...settings.commands, full] : settings.commands.map((c, j) => (j === index ? full : c));
      try {
        const r = await api.tryBot(ch.key, `!${full.name}`, 'broadcaster', {
          settings: { ...settings, commands: commands.map((c) => ({ ...c, enabled: true })) }, user: 'Hazel', channel: ch.name,
        });
        setPreview(r.reply !== undefined ? { text: r.reply, bad: false } : null);
      } catch (x) {
        setPreview({ text: errorText(x), bad: true });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [full, settings, index, ch.key, ch.name]);

  const insert = (v: string) => {
    const el = reply.current;
    const at = el ? el.selectionStart : draft.reply.length;
    const end = el ? el.selectionEnd : at;
    set({ reply: (draft.reply.slice(0, at) + v + draft.reply.slice(end)).slice(0, MAX_REPLY) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + v.length, at + v.length); });
  };
  const changed = isNew || JSON.stringify(full) !== JSON.stringify(command);

  return (
    <Drawer
      title={isNew ? 'New command' : <>Edit <span className="mono sage">!{command.name}</span></>}
      label={isNew ? 'New command' : `Edit !${command.name}`}
      onClose={onClose}
      foot={readOnly ? <><span className="spacer" /><button className="btn sm" type="button" onClick={onClose}>Close</button></> : <>
        {onDelete && <ArmedButton className="sm danger" armedText="Click again to delete" icon="trash" onConfirm={() => void onDelete()}>Delete</ArmedButton>}
        <span className="spacer" />
        <button className="btn sm" type="button" onClick={onClose}>Cancel</button>
        <button className="btn sm primary" type="submit" form="cmd-form" disabled={busy || !changed || !full.name || !full.reply.trim()}>{busy ? 'Saving' : isNew ? 'Add command' : 'Save'}</button>
      </>}
    >
      <form id="cmd-form" className="stack" onSubmit={async (e) => {
        e.preventDefault();
        if (readOnly || !full.name || !full.reply.trim()) return;
        setBusy(true);
        try { await onSave(full); } finally { setBusy(false); }
      }}>
        <fieldset className="plain" disabled={readOnly}>
          <label className="field" htmlFor="cmd-name">Command
            <span className="prefixed mono"><span aria-hidden="true">!</span>
              <input id="cmd-name" className="input mono" maxLength={26} required autoFocus={isNew} placeholder="discord"
                value={draft.name.replace(/^!+/, '')} onChange={(e) => set({ name: e.target.value.replace(/\s/g, '') })} />
            </span>
          </label>
          <div className="field">
            <label htmlFor="cmd-alias">Also answers to</label>
            <div className="alias-box">
              {draft.aliases.map((a) => (
                <span className="alias" key={a}>!{a}<button type="button" aria-label={`Remove !${a}`} onClick={() => set({ aliases: draft.aliases.filter((x) => x !== a) })}><Icon id="x" /></button></span>
              ))}
              {draft.aliases.length < 5 && (
                <input id="cmd-alias" className="alias-input" placeholder={draft.aliases.length ? 'Add another' : 'Other names, such as !dc'} value={alias}
                  onChange={(e) => setAlias(e.target.value.replace(/\s/g, ''))} onBlur={addAlias}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === ',') { e.preventDefault(); addAlias(); }
                    if (e.key === 'Backspace' && !alias && draft.aliases.length) set({ aliases: draft.aliases.slice(0, -1) });
                  }} />
              )}
            </div>
          </div>
          <div className="field">
            <label htmlFor="cmd-reply">Reply</label>
            <textarea id="cmd-reply" ref={reply} className="input" rows={3} maxLength={MAX_REPLY} required
              placeholder="Join us on Discord: https://discord.gg/..." value={draft.reply} onChange={(e) => set({ reply: e.target.value })} />
            <div className="chat-msg-foot">
              <span className="vars" aria-label="Insert a variable">
                {VARIABLES.map((v) => <button key={v.v} type="button" className="var" title={v.what} onClick={() => insert(v.v)}>{v.v}</button>)}
              </span>
              <span className="faint mono count">{draft.reply.length}/{MAX_REPLY}</span>
            </div>
          </div>
          <div className="grp">
            <div className="gr stack-sm"><div className="gr-main"><div className="t1">Who can use it</div></div><div className="gr-ctl"><WhoSeg value={draft.level} onChange={(v) => set({ level: v })} /></div></div>
            <div className="gr stack-sm"><div className="gr-main"><div className="t1">Cooldown</div></div>
              <div className="gr-ctl"><CooldownSeg label="Cooldown" value={cool} onChange={(v) => set(per === 'each' ? { userCooldown: v, cooldown: 0 } : { cooldown: v, userCooldown: 0 })} /></div>
            </div>
            <div className="gr stack-sm">
              <div className="gr-main"><div className="t1">Cooldown is for</div><div className="t2">{cool ? (per === 'each' ? `Each viewer waits ${seconds(cool)}` : `Once every ${seconds(cool)} for all of chat`) : 'No wait'}</div></div>
              <div className="gr-ctl">
                <Seg label="Cooldown is for" small options={[{ id: 'all', label: 'Whole chat' }, { id: 'each', label: 'Each viewer' }]} value={per}
                  onChange={(v) => set(v === 'each' ? { userCooldown: cool, cooldown: 0 } : { cooldown: cool, userCooldown: 0 })} />
              </div>
            </div>
            {!isNew && <div className="gr"><div className="gr-main"><div className="t1">Used</div></div><div className="gr-ctl muted">{command.count === 1 ? 'Once' : `${num(command.count)} times`}</div></div>}
          </div>
        </fieldset>
        <section className="sect" aria-labelledby="cmd-preview-title">
          <div className="sect-head"><div><h2 id="cmd-preview-title">Preview in chat</h2></div></div>
          <TwitchChat lines={[
            { name: 'Hazel', color: '#9147ff', text: `!${full.name || 'command'}` },
            preview
              ? preview.bad ? { note: preview.text } : { name: sender, color: '#1e90ff', mod: sender === 'Sylva_Bot', text: preview.text }
              : { note: 'Write a reply to see it here.' },
          ]} />
        </section>
      </form>
    </Drawer>
  );
}

export type ChatLine = { name: string; color: string; text: ReactNode; mod?: boolean; reply?: string } | { note: string };

/** A few lines of chat as Twitch shows them. */
export function TwitchChat({ lines }: { lines: ChatLine[] }) {
  return (
    <div className="twitch-chat" aria-live="polite">
      {lines.map((l, i) => 'note' in l
        ? <div className="tc-line tc-note" key={i}>{l.note}</div>
        : (
          <div className="tc-line" key={i}>
            {l.reply && <div className="tc-reply"><Icon id="reply" /><span>Replying to {l.reply}</span></div>}
            {l.mod && <img className="tc-badge" src={MOD_BADGE} alt="Moderator" width={18} height={18} />}
            <span className="tc-name" style={{ color: l.color }}>{l.name}</span>: {l.text}
          </div>
        ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Timers */

const INTERVALS = [5, 10, 15, 30, 60];
const LINES = [0, 1, 5, 10, 20];
const TIMER_VARIABLES = VARIABLES.filter((v) => ['${channel}', '${uptime}', '${commands}', '${random.1-100}'].includes(v.v));

function minutes(n: number): string {
  if (n < 60) return `${n} min`;
  if (n === 60) return '1 hour';
  return n % 60 === 0 ? `${n / 60} hours` : `${Math.floor(n / 60)} h ${n % 60} min`;
}
function when(at: number, now: number): string {
  const m = Math.round((at - now) / 60_000);
  if (m <= 0) return 'With the next chat line';
  if (m === 1) return 'In about 1 minute';
  if (m < 60) return `In about ${m} minutes`;
  return `At ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
function statusText(st: TimerStatus | undefined, now: number): string {
  if (!st) return '';
  switch (st.waiting) {
    case 'off': return 'Off';
    case 'bot': return 'Waits for the bot';
    case 'live': return 'Waits for you to go live';
    case 'chat': return st.linesNeeded === 1 ? 'Waits for 1 chat line' : `Waits for ${st.linesNeeded} chat lines`;
    default: return st.nextAt ? when(st.nextAt, now) : '';
  }
}
const blankTimer = (): BotTimer => ({ id: '', name: '', message: '', interval: 15, lines: 5, liveOnly: true, enabled: true });

function Timers({ view, onSave, onView }: { view: BotView; onSave: Save; onView(v: BotView): void }) {
  const ch = useChannel();
  const toast = useToast();
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const settings = view.settings;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const sendNow = async (t: BotTimer) => {
    try { onView(await api.sendTimer(ch.key, t.id)); toast(`${t.name} posted in your chat`); } catch (x) { toast(errorText(x), true); }
  };
  const editing = open === 'new' ? blankTimer() : open !== null ? settings.timers[open] : undefined;

  return (
    <section className="sect" aria-labelledby="timers-title">
      <div className="sect-head">
        <div><h2 id="timers-title">Timers</h2><p>Messages Sylva posts on a schedule. A timer can wait for chat to be active, so it never talks to an empty room.</p></div>
        <div className="page-actions"><button className="btn sm primary" type="button" onClick={() => setOpen('new')} disabled={settings.timers.length >= 20}><Icon id="plus" />New timer</button></div>
      </div>
      <div className="tbl-head tm-cols" aria-hidden="true"><span>Timer</span><span>Message</span><span>Every</span><span>Next</span><span /></div>
      <div className="grp">
        {settings.timers.length === 0 && <div className="empty">No timers yet. Add one to remind viewers to follow, or to share your Discord every half hour.</div>}
        {settings.timers.map((t, i) => (
          <div className={'gr tm-cols cm-row' + (t.enabled ? '' : ' off')} key={t.id || i}>
            <button className="cm-open" type="button" onClick={() => setOpen(i)} aria-label={`Edit ${t.name}`}><span className="t1">{t.name}</span></button>
            <button className="cm-open cm-reply" type="button" tabIndex={-1} onClick={() => setOpen(i)}>{t.message}</button>
            <span className="muted">{minutes(t.interval)}</span>
            <span className="muted small">{statusText(view.timers.find((x) => x.id === t.id), now)}</span>
            <Switch label={t.name} on={t.enabled}
              onChange={(v) => void onSave({ ...settings, timers: settings.timers.map((x, j) => (j === i ? { ...x, enabled: v } : x)) }, `${t.name} ${v ? 'on' : 'off'}`)} />
          </div>
        ))}
      </div>
      {editing && (
        <TimerDrawer key={String(open)} timer={editing} isNew={open === 'new'} canSend={settings.enabled && editing.enabled && open !== 'new'}
          onSend={() => void sendNow(editing)} onClose={() => setOpen(null)}
          onDelete={open === 'new' ? undefined : async () => {
            const i = open as number;
            if (await onSave({ ...settings, timers: settings.timers.filter((_, j) => j !== i) }, `${editing.name} deleted`, settings)) setOpen(null);
          }}
          onSave={async (next) => {
            const timers = open === 'new' ? [...settings.timers, next] : settings.timers.map((x, j) => (j === open ? next : x));
            if (await onSave({ ...settings, timers }, open === 'new' ? `${next.name.trim()} added` : `${next.name.trim()} saved`)) setOpen(null);
          }} />
      )}
    </section>
  );
}

function TimerDrawer({ timer, isNew, canSend, onSave, onSend, onClose, onDelete }: {
  timer: BotTimer; isNew: boolean; canSend: boolean; onSave(t: BotTimer): Promise<void>; onSend(): void; onClose(): void; onDelete?(): Promise<void>;
}) {
  const [draft, setDraft] = useState(timer);
  const [busy, setBusy] = useState(false);
  const message = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<BotTimer>) => setDraft((d) => ({ ...d, ...patch }));
  const changed = isNew || JSON.stringify(draft) !== JSON.stringify(timer);
  const insert = (v: string) => {
    const el = message.current;
    const at = el ? el.selectionStart : draft.message.length;
    const end = el ? el.selectionEnd : at;
    set({ message: (draft.message.slice(0, at) + v + draft.message.slice(end)).slice(0, MAX_REPLY) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + v.length, at + v.length); });
  };
  return (
    <Drawer title={isNew ? 'New timer' : timer.name} icon="timer" onClose={onClose}
      actions={!isNew ? <button className="btn sm" type="button" disabled={!canSend} title={canSend ? 'Post it in your chat now' : 'Turn the bot and this timer on first'} onClick={onSend}><Icon id="send" />Send now</button> : undefined}
      foot={<>
        {onDelete && <ArmedButton className="sm danger" armedText="Click again to delete" icon="trash" onConfirm={() => void onDelete()}>Delete</ArmedButton>}
        <span className="spacer" />
        <button className="btn sm" type="button" onClick={onClose}>Cancel</button>
        <button className="btn sm primary" type="submit" form="timer-form" disabled={busy || !changed || !draft.name.trim() || !draft.message.trim()}>{busy ? 'Saving' : isNew ? 'Add timer' : 'Save'}</button>
      </>}>
      <form id="timer-form" className="stack" onSubmit={async (e) => {
        e.preventDefault();
        if (!draft.name.trim() || !draft.message.trim()) return;
        setBusy(true);
        try { await onSave(draft); } finally { setBusy(false); }
      }}>
        <label className="field" htmlFor="tm-name">Name
          <input id="tm-name" className="input" maxLength={40} required autoFocus={isNew} placeholder="Follow reminder" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          <span className="field-hint">Only you see this.</span>
        </label>
        <div className="field">
          <label htmlFor="tm-msg">Message</label>
          <textarea id="tm-msg" ref={message} className="input" rows={3} maxLength={MAX_REPLY} required
            placeholder="Enjoying the stream? Hit follow so you know when I am live." value={draft.message} onChange={(e) => set({ message: e.target.value })} />
          <div className="chat-msg-foot">
            <span className="vars" aria-label="Insert a variable">{TIMER_VARIABLES.map((v) => <button key={v.v} type="button" className="var" title={v.what} onClick={() => insert(v.v)}>{v.v}</button>)}</span>
            <span className="faint mono count">{draft.message.length}/{MAX_REPLY}</span>
          </div>
        </div>
        <div className="grp">
          <div className="gr stack-sm"><div className="gr-main"><div className="t1">Post every</div></div>
            <div className="gr-ctl"><Seg label="Post every" small options={withValue(INTERVALS, draft.interval).map((n) => ({ id: n, label: n < 60 ? `${n}m` : `${n / 60}h` }))} value={draft.interval} onChange={(n) => set({ interval: n })} /></div>
          </div>
          <div className="gr stack-sm"><div className="gr-main"><div className="t1">Chat lines in between</div><div className="t2">So it never posts to a quiet chat</div></div>
            <div className="gr-ctl"><Seg label="Chat lines in between" small options={withValue(LINES, draft.lines).map((n) => ({ id: n, label: n === 0 ? 'None' : String(n) }))} value={draft.lines} onChange={(n) => set({ lines: n })} /></div>
          </div>
          <div className="gr"><div className="gr-main"><div className="t1">Only while live</div></div>
            <div className="gr-ctl"><Switch label="Only while live" on={draft.liveOnly} onChange={(v) => set({ liveOnly: v })} /></div>
          </div>
        </div>
        <p className="sect-foot">
          {draft.liveOnly ? 'While you are live, ' : ''}Sylva posts this every {minutes(draft.interval)}
          {draft.lines > 0 ? `, once at least ${draft.lines} chat ${draft.lines === 1 ? 'line has' : 'lines have'} come in since the last time` : ''}.
          Timers are spaced at least 30 seconds apart.
        </p>
      </form>
    </Drawer>
  );
}

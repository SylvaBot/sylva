// The Chat bot page: turn the bot on, edit its commands, and try them in a
// test chat that never reaches Twitch. The rules match
// crates/sylva-core/src/bot.rs, which checks every save again.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type BotCommand, type BotSettings, type BotTimer, type BotView, type Builtin, type BuiltinGroup, type BuiltinSetting, type TimerStatus, type UserLevel } from './api';
import { useChannel } from './channel';
import { Counters, Quotes } from './community';
import { Card, PageHead } from './pages';
import { Link } from './router';
import { errorText, Gate, Icon, num, useToast } from './ui';

export const LEVELS: { id: UserLevel; label: string; who: string }[] = [
  { id: 'everyone', label: 'Everyone', who: 'everyone' },
  { id: 'subscriber', label: 'Subscribers and up', who: 'subscribers' },
  { id: 'vip', label: 'VIPs and up', who: 'VIPs' },
  { id: 'moderator', label: 'Moderators', who: 'moderators' },
  { id: 'broadcaster', label: 'Only you', who: 'you' },
];
const levelOf = (id: UserLevel) => LEVELS.find((l) => l.id === id) ?? LEVELS[0];

const COOLDOWNS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
export function seconds(n: number): string {
  if (n === 0) return 'None';
  if (n < 60) return `${n} seconds`;
  if (n < 3600) return n % 60 === 0 ? `${n / 60} minute${n === 60 ? '' : 's'}` : `${Math.round(n / 60)} minutes`;
  return '1 hour';
}

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

const blank = (): BotCommand => ({
  name: '', aliases: [], reply: '', level: 'everyone', cooldown: 0, userCooldown: 0, enabled: true, count: 0,
});

export function BotPage() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<BotView | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<number | 'new' | null>(null);

  useEffect(() => {
    api.bot(ch.key).then(setView).catch(() => setFailed(true));
  }, [ch.key]);

  const save = async (next: BotSettings, done?: string, undo?: BotSettings) => {
    try {
      setView(await api.saveBot(ch.key, next));
      if (done) {
        toast(done, false, undo && {
          label: 'Undo',
          run: () => { void save(undo, 'Brought back'); },
        });
      }
      return true;
    } catch (x) {
      toast(errorText(x), true);
      return false;
    }
  };

  const settings = view?.settings;
  const who = view?.sender.kind === 'sylva'
    ? <>Sylva&apos;s bot, <b>{view.sender.login || 'the shared bot account'}</b></>
    : ch.can.own
      ? <>your own account, <b>{ch.name}</b>, with Twitch&apos;s Chat Bot badge</>
      : <><b>{ch.name}</b>&apos;s own account, with Twitch&apos;s Chat Bot badge</>;

  return (
    <div className="page">
      <PageHead title="Chat bot" desc="Commands, timers, counters and quotes for your chat. Try them here before your viewers do." />
      {failed && !view && <Card><div className="card-body"><p className="card-text">Could not load your bot. Refresh to try again.</p></div></Card>}
      {!view && !failed && <Card><div className="card-body"><p className="card-text">Loading</p></div></Card>}
      {settings && (
        <div className="stack">
          <Card id="bot-on">
            <Gate on={ch.can.edit} className="bot-status">
              <span className={'tile ' + (settings.enabled ? 'c-follow' : '')}><Icon id="bot" /></span>
              <div className="type-main">
                <b>{settings.enabled ? 'The bot is on' : 'The bot is off'}</b>
                <span>{settings.enabled ? <>It answers commands in {ch.can.own ? 'your' : 'the'} chat as {who}.</> : <>Turn it on to answer commands in {ch.can.own ? 'your' : 'the'} chat. Replies come from {who}.</>}</span>
              </div>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                aria-label="Chat bot"
                onClick={() => save({ ...settings, enabled: !settings.enabled }, settings.enabled ? 'The bot is off' : 'The bot is on')}
              />
            </Gate>
          </Card>

          <Card
            id="commands"
            title="Commands"
            desc="A viewer types the command in chat and the bot replies. Moderators skip cooldowns."
            action={
              <button className="btn sm" type="button" onClick={() => setOpen('new')} disabled={!ch.can.edit || open === 'new' || settings.commands.length >= 100}>
                <Icon id="plus" />New command
              </button>
            }
          >
            <ul className="types">
              {open === 'new' && (
                <li className="type open">
                  <CommandEditor
                    command={blank()}
                    isNew
                    settings={settings}
                    onCancel={() => setOpen(null)}
                    onSave={async (c) => {
                      if (await save({ ...settings, commands: [...settings.commands, c] }, `!${c.name.replace(/^!/, '').toLowerCase()} added`)) setOpen(null);
                    }}
                  />
                </li>
              )}
              {settings.commands.length === 0 && open !== 'new' && (
                <li className="empty">No commands yet. Add one, such as !discord with a link to your server.</li>
              )}
              {settings.commands.map((c, i) => {
                const isOpen = open === i;
                const meta = [levelOf(c.level).label];
                if (c.cooldown) meta.push(`${seconds(c.cooldown)} cooldown`);
                if (c.userCooldown) meta.push(`${seconds(c.userCooldown)} per viewer`);
                meta.push(c.count === 1 ? 'used once' : `used ${num(c.count)} times`);
                return (
                  <li key={c.name} className={'type cmd' + (isOpen ? ' open' : '') + (c.enabled ? '' : ' off')}>
                    <div className="type-row">
                      <div className="type-main">
                        <b className="cmd-name">!{c.name}{c.aliases.length > 0 && <span className="cmd-alias"> {c.aliases.map((a) => '!' + a).join(' ')}</span>}</b>
                        <span className="cmd-reply">{c.reply}</span>
                        <span className="cmd-meta">{meta.join(' · ')}</span>
                      </div>
                      <button
                        className="btn sm ghost"
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={`cmd-edit-${i}`}
                        onClick={() => setOpen(isOpen ? null : i)}
                      >
                        {isOpen ? 'Close' : ch.can.edit ? 'Edit' : 'View'}
                      </button>
                      <button
                        className="switch"
                        type="button"
                        role="switch"
                        aria-checked={c.enabled}
                        aria-label={`!${c.name}`}
                        disabled={!ch.can.edit}
                        onClick={() => save(
                          { ...settings, commands: settings.commands.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)) },
                          `!${c.name} ${c.enabled ? 'off' : 'on'}`,
                        )}
                      />
                    </div>
                    {isOpen && (
                      <Gate on={ch.can.edit}>
                        <CommandEditor
                          id={`cmd-edit-${i}`}
                          command={c}
                          settings={settings}
                          index={i}
                          onCancel={() => setOpen(null)}
                          onDelete={async () => {
                            const next = { ...settings, commands: settings.commands.filter((_, j) => j !== i) };
                            if (await save(next, `!${c.name} deleted`, settings)) setOpen(null);
                          }}
                          onSave={async (next) => {
                            if (await save({ ...settings, commands: settings.commands.map((x, j) => (j === i ? next : x)) }, `!${c.name} saved`)) setOpen(null);
                          }}
                        />
                      </Gate>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>

          <Builtins view={view!} onSave={save} />

          <Gate on={ch.can.edit}><Timers view={view!} onSave={save} onView={setView} /></Gate>

          <Counters view={view!} onSave={save} onView={setView} />

          <Quotes view={view!} onSave={save} />

          <Gate on={ch.can.moderate}><TestChat settings={settings} /></Gate>
        </div>
      )}
    </div>
  );
}

const GROUPS: { id: BuiltinGroup; label: string }[] = [
  { id: 'info', label: 'Stream info' },
  { id: 'fun', label: 'Fun' },
  { id: 'commands', label: 'Commands and counters' },
  { id: 'quotes', label: 'Quotes' },
  { id: 'stream', label: 'Your stream' },
  { id: 'moderation', label: 'Moderation' },
];
const LEVEL_ORDER: UserLevel[] = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];
const ALLOW_COMMANDS_URL = '/auth/twitch/start?scopes=commands&next=/app/bot';

/** Commands every channel has, each with a switch, who may use it and a cooldown. */
function Builtins({ view, onSave }: {
  view: BotView;
  onSave(next: BotSettings, done?: string): Promise<boolean>;
}) {
  const ch = useChannel();
  const [open, setOpen] = useState<string | null>(null);
  const { settings, builtins, permissions } = view;
  const mine = (b: Builtin) => settings.builtins.find((s) => s.name === b.name) ?? { name: b.name, enabled: b.on, level: b.level, cooldown: b.cooldown };
  const replaced = (b: Builtin) => settings.commands.some((c) => c.name === b.name || c.aliases.includes(b.name))
    || settings.counters.some((c) => c.name === b.name);
  const set = (b: Builtin, patch: Partial<BuiltinSetting>, done: string) => onSave({
    ...settings,
    builtins: builtins.map((x) => (x.name === b.name ? { ...mine(x), ...patch } : mine(x))),
  }, done);
  const waiting = (needs: 'commands' | 'moderation') => permissions[needs] !== 'ok'
    && builtins.some((b) => b.needs === needs && mine(b).enabled && !replaced(b));
  const names = (needs: 'commands' | 'moderation') => builtins.filter((b) => b.needs === needs && mine(b).enabled).map((b) => '!' + b.name);
  const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

  return (
    <Card
      id="builtins"
      title="Built-in commands"
      desc="Ready in every channel. Turn each one on or off and choose who can use it. A command of yours with the same name replaces the built-in one."
    >
      {(waiting('commands') || waiting('moderation')) && (
        <div className="card-body builtin-notes">
          {waiting('commands') && (
            <div className="notice">
              <span>
                {list(names('commands'))} {names('commands').length === 1 ? 'needs' : 'need'} {ch.can.own ? 'your' : `${ch.name}'s`} permission
                {permissions.commands === 'expired' ? ' again, because Twitch no longer accepts the old one.' : ' to make clips, change the title and category, and see followers.'}
                {!ch.can.own && ` Only ${ch.name} can allow it.`}
              </span>
              {ch.can.own && <a className="btn primary sm" href={ALLOW_COMMANDS_URL}><Icon id="twitch" />Allow</a>}
            </div>
          )}
          {waiting('moderation') && (
            <div className="notice">
              <span>
                {list(names('moderation'))} {names('moderation').length === 1 ? 'needs' : 'need'} Sylva to be allowed to moderate
                {ch.can.own ? '. You can allow it on the Moderation page.' : `. Only ${ch.name} can allow it, on the Moderation page.`}
              </span>
              <Link className="btn sm" href="/app/moderation">Open Moderation</Link>
            </div>
          )}
        </div>
      )}
      {GROUPS.map((g) => {
        const items = builtins.filter((b) => b.group === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="builtin-group" aria-labelledby={`builtin-${g.id}`}>
            <h3 id={`builtin-${g.id}`} className="builtin-head">{g.label}</h3>
            <ul className="types">
              {items.map((b) => {
                const s = mine(b);
                const over = replaced(b);
                const quotesOff = b.group === 'quotes' && !settings.quotes.enabled;
                const isOpen = open === b.name;
                const meta = [levelOf(s.level).label];
                if (s.cooldown) meta.push(`${seconds(s.cooldown)} cooldown`);
                const levels = LEVELS.filter((l) => LEVEL_ORDER.indexOf(l.id) >= LEVEL_ORDER.indexOf(b.min));
                return (
                  <li key={b.name} className={'type cmd' + (isOpen ? ' open' : '') + (s.enabled && !over && !quotesOff ? '' : ' off')}>
                    <div className="type-row">
                      <div className="type-main">
                        <b className="cmd-name">!{b.name}{b.aliases.length > 0 && <span className="cmd-alias"> {b.aliases.map((a) => '!' + a).join(' ')}</span>}</b>
                        <span className="cmd-reply">{b.about}</span>
                        <span className="cmd-meta">
                          {over ? `Replaced by your own !${b.name}` : quotesOff ? 'Quotes are off in chat' : meta.join(' · ')}
                        </span>
                      </div>
                      <button
                        className="btn sm ghost"
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={`builtin-edit-${b.name}`}
                        aria-label={`${isOpen ? 'Close' : ch.can.edit ? 'Edit' : 'View'} !${b.name}`}
                        onClick={() => setOpen(isOpen ? null : b.name)}
                      >
                        {isOpen ? 'Close' : ch.can.edit ? 'Edit' : 'View'}
                      </button>
                      <button
                        className="switch"
                        type="button"
                        role="switch"
                        aria-checked={s.enabled}
                        aria-label={`!${b.name}`}
                        disabled={!ch.can.edit}
                        onClick={() => void set(b, { enabled: !s.enabled }, `!${b.name} ${s.enabled ? 'off' : 'on'}`)}
                      />
                    </div>
                    {isOpen && (
                      <Gate on={ch.can.edit}>
                        <div className="builtin-edit" id={`builtin-edit-${b.name}`}>
                          <p className="builtin-usage">Type <code>{b.usage}</code></p>
                          <label className="field" htmlFor={`builtin-${b.name}-level`}>
                            Who can use it
                            <select id={`builtin-${b.name}-level`} className="select" value={s.level}
                              onChange={(e) => void set(b, { level: e.target.value as UserLevel }, `Saved !${b.name}`)}>
                              {levels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                            </select>
                          </label>
                          <label className="field" htmlFor={`builtin-${b.name}-cooldown`}>
                            Cooldown
                            <select id={`builtin-${b.name}-cooldown`} className="select" value={s.cooldown}
                              onChange={(e) => void set(b, { cooldown: Number(e.target.value) }, `Saved !${b.name}`)}>
                              {(COOLDOWNS.includes(s.cooldown) ? COOLDOWNS : [...COOLDOWNS, s.cooldown].sort((x, y) => x - y)).map((n) => <option key={n} value={n}>{seconds(n)}</option>)}
                            </select>
                          </label>
                        </div>
                      </Gate>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}

function CommandEditor({ id, command, settings, index, isNew, onSave, onCancel, onDelete }: {
  id?: string; command: BotCommand; settings: BotSettings; index?: number; isNew?: boolean;
  onSave(c: BotCommand): Promise<void>; onCancel(): void; onDelete?(): Promise<void>;
}) {
  const ch = useChannel();
  const [draft, setDraft] = useState(command);
  const [aliases, setAliases] = useState(command.aliases.map((a) => '!' + a).join(' '));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ text: string; bad: boolean } | null>(null);
  const reply = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<BotCommand>) => setDraft((d) => ({ ...d, ...patch }));
  const f = (name: string) => `${id ?? 'cmd-new'}-${name}`;

  const full = useMemo<BotCommand>(() => ({
    ...draft,
    name: draft.name.trim().replace(/^!+/, ''),
    aliases: aliases.split(/[\s,]+/).map((a) => a.replace(/^!+/, '')).filter(Boolean),
  }), [draft, aliases]);

  // The preview runs the unsaved command through the server's own bot.
  useEffect(() => {
    if (!full.name || !full.reply.trim()) { setPreview(null); return; }
    const t = setTimeout(async () => {
      const commands = index === undefined ? [...settings.commands, full] : settings.commands.map((c, j) => (j === index ? full : c));
      try {
        const r = await api.tryBot(ch.key, `!${full.name} @Juniper hello`, 'broadcaster', {
          settings: { ...settings, commands: commands.map((c) => ({ ...c, enabled: true })) },
          user: 'Maple',
          channel: ch.name,
        });
        setPreview(r.reply !== undefined ? { text: r.reply, bad: false } : null);
      } catch (x) {
        setPreview({ text: errorText(x), bad: true });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [full, settings, index, ch.key]);

  const insert = (v: string) => {
    const el = reply.current;
    const at = el ? el.selectionStart : draft.reply.length;
    const end = el ? el.selectionEnd : at;
    const next = (draft.reply.slice(0, at) + v + draft.reply.slice(end)).slice(0, MAX_REPLY);
    set({ reply: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + v.length, at + v.length);
    });
  };

  const cooldowns = (n: number) => (COOLDOWNS.includes(n) ? COOLDOWNS : [...COOLDOWNS, n].sort((a, b) => a - b));
  const changed = isNew || JSON.stringify(full) !== JSON.stringify(command);

  return (
    <form
      className="cmd-edit"
      id={id}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onSave(full); } finally { setBusy(false); }
      }}
    >
      <div className="cmd-fields">
        <label className="field" htmlFor={f('name')}>
          Command
          <span className="prefixed"><span aria-hidden="true">!</span>
            <input id={f('name')} className="input" maxLength={26} required autoFocus={isNew} placeholder="discord"
              value={draft.name.replace(/^!+/, '')} onChange={(e) => set({ name: e.target.value })} />
          </span>
        </label>
        <label className="field" htmlFor={f('aliases')}>
          Other names
          <input id={f('aliases')} className="input" placeholder="!dc !server" value={aliases} onChange={(e) => setAliases(e.target.value)} />
          <span className="field-hint">Optional. Up to 5, separated by spaces.</span>
        </label>
        <label className="field wide" htmlFor={f('reply')}>
          <span className="field-row">Reply<span className="field-hint">{draft.reply.length} / {MAX_REPLY}</span></span>
          <textarea id={f('reply')} ref={reply} className="input textarea" rows={3} maxLength={MAX_REPLY} required
            placeholder="Join us on Discord: https://discord.gg/..." value={draft.reply} onChange={(e) => set({ reply: e.target.value })} />
        </label>
        <div className="field wide">
          <span id={f('vars')}>Add to the reply</span>
          <div className="chips" role="group" aria-labelledby={f('vars')}>
            {VARIABLES.map((v) => (
              <button key={v.v} type="button" className="chip" title={v.what} onClick={() => insert(v.v)}>{v.v}</button>
            ))}
          </div>
        </div>
        <label className="field" htmlFor={f('level')}>
          Who can use it
          <select id={f('level')} className="select" value={draft.level} onChange={(e) => set({ level: e.target.value as UserLevel })}>
            {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        <div className="cmd-pair">
          <label className="field" htmlFor={f('cooldown')}>
            Cooldown
            <select id={f('cooldown')} className="select" value={draft.cooldown} onChange={(e) => set({ cooldown: Number(e.target.value) })}>
              {cooldowns(draft.cooldown).map((n) => <option key={n} value={n}>{seconds(n)}</option>)}
            </select>
          </label>
          <label className="field" htmlFor={f('ucooldown')}>
            Per viewer
            <select id={f('ucooldown')} className="select" value={draft.userCooldown} onChange={(e) => set({ userCooldown: Number(e.target.value) })}>
              {cooldowns(draft.userCooldown).map((n) => <option key={n} value={n}>{seconds(n)}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="cmd-preview" aria-live="polite">
        <span className="cmd-preview-label">Preview</span>
        <div className="bubble you"><b>Maple</b>!{full.name || 'command'} @Juniper hello</div>
        {preview
          ? <div className={'bubble bot' + (preview.bad ? ' bad' : '')}>{!preview.bad && <b>Bot</b>}{preview.text}</div>
          : <div className="bubble bot muted">Write a reply to see it here.</div>}
      </div>
      <div className="type-actions">
        {onDelete && <button className="btn ghost danger push-left" type="button" onClick={() => onDelete()}><Icon id="trash" />Delete</button>}
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn primary" type="submit" disabled={busy || !changed || !full.name || !full.reply.trim()}>{busy ? 'Saving' : isNew ? 'Add command' : 'Save'}</button>
      </div>
    </form>
  );
}

interface Line { id: number; who: 'you' | 'bot' | 'note'; text: string; name?: string }

function TestChat({ settings }: { settings: BotSettings }) {
  const ch = useChannel();
  const [level, setLevel] = useState<UserLevel>('everyone');
  const [text, setText] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const list = useRef<HTMLOListElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [lines]);

  const add = (l: Omit<Line, 'id'>[]) => setLines((x) => [...x, ...l.map((y) => ({ ...y, id: nextId.current++ }))].slice(-40));

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setText('');
    const name = level === 'broadcaster' ? ch.name : 'Maple';
    const you: Omit<Line, 'id'> = { who: 'you', text: message, name };
    try {
      const r = await api.tryBot(ch.key, message, level, { user: name, channel: ch.name });
      if (r.reply !== undefined) { add([you, { who: 'bot', text: r.reply }]); return; }
      const c = settings.commands.find((x) => x.name === r.command);
      const trigger = message.trim().split(/\s+/)[0];
      const note = {
        notACommand: 'Not a command, so the bot stays quiet. Commands start with !.',
        unknown: `There is no ${trigger.toLowerCase()} command.`,
        off: `!${r.command} is turned off.`,
        level: `Only ${c ? levelOf(c.level).who : 'some viewers'} can use !${r.command}.`,
        cooldown: `!${r.command} is cooling down.`,
      }[r.skip ?? 'unknown'];
      add([you, { who: 'note', text: note }]);
    } catch (x) {
      add([you, { who: 'note', text: errorText(x) }]);
    }
  };

  return (
    <Card id="test-chat" title="Test chat" desc="Type a command to see what the bot would say. Nothing here goes to Twitch, and cooldowns are skipped.">
      <ol className="test-log" ref={list} aria-live="polite" aria-label="Test messages">
        {lines.length === 0 && <li className="empty">Try !commands or !lurk.</li>}
        {lines.map((l) => (
          <li key={l.id} className={'test-line ' + l.who}>
            {l.who === 'you' && <b>{l.name}</b>}
            {l.who === 'bot' && <b className="bot-name"><Icon id="bot" />Bot</b>}
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
      <form className="test-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="test-level">Send as</label>
        <select id="test-level" className="select" value={level} onChange={(e) => setLevel(e.target.value as UserLevel)}>
          <option value="everyone">As Maple, a viewer</option>
          <option value="subscriber">As Maple, a subscriber</option>
          <option value="vip">As Maple, a VIP</option>
          <option value="moderator">As Maple, a moderator</option>
          <option value="broadcaster">As you</option>
        </select>
        <label className="sr-only" htmlFor="test-text">Message</label>
        <input id="test-text" className="input" placeholder="!lurk" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" type="submit" disabled={!text.trim()}><Icon id="send" />Send</button>
      </form>
    </Card>
  );
}

/* ---------------------------------------------------------------- Timers */

const INTERVALS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180];
const LINES = [0, 1, 2, 3, 5, 10, 20, 50, 100];
const TIMER_VARIABLES = VARIABLES.filter((v) => ['${channel}', '${uptime}', '${commands}', '${random.1-100}'].includes(v.v));

function minutes(n: number): string {
  if (n < 60) return `${n} minutes`;
  if (n === 60) return '1 hour';
  return n % 60 === 0 ? `${n / 60} hours` : `${Math.floor(n / 60)} h ${n % 60} min`;
}

function when(at: number, now: number): string {
  const m = Math.round((at - now) / 60_000);
  if (m <= 0) return 'Next with the next chat line';
  if (m === 1) return 'Next in about 1 minute';
  if (m < 60) return `Next in about ${m} minutes`;
  return `Next at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function statusText(st: TimerStatus | undefined, now: number): string {
  if (!st) return '';
  switch (st.waiting) {
    case 'off': return 'Off';
    case 'bot': return 'Waits for the bot to be on';
    case 'live': return 'Waits for you to go live';
    case 'chat': return st.linesNeeded === 1 ? 'Waits for 1 more chat line' : `Waits for ${st.linesNeeded} more chat lines`;
    default: return st.nextAt ? when(st.nextAt, now) : '';
  }
}

const blankTimer = (): BotTimer => ({ id: '', name: '', message: '', interval: 15, lines: 5, liveOnly: true, enabled: true });

function Timers({ view, onSave, onView }: {
  view: BotView;
  onSave(next: BotSettings, done?: string, undo?: BotSettings): Promise<boolean>;
  onView(v: BotView): void;
}) {
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
    try {
      onView(await api.sendTimer(ch.key, t.id));
      toast(`${t.name} posted in your chat`);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  return (
    <Card
      id="timers"
      className="timers-card"
      title="Timers"
      desc="Messages the bot posts on a schedule. A timer can wait for chat to be active, so the bot never talks to an empty room."
      action={
        <button className="btn sm" type="button" onClick={() => setOpen('new')} disabled={open === 'new' || settings.timers.length >= 20}>
          <Icon id="plus" />New timer
        </button>
      }
    >
      <ul className="types">
        {open === 'new' && (
          <li className="type open">
            <TimerEditor
              timer={blankTimer()}
              isNew
              onCancel={() => setOpen(null)}
              onSave={async (t) => {
                if (await onSave({ ...settings, timers: [...settings.timers, t] }, `${t.name.trim()} added`)) setOpen(null);
              }}
            />
          </li>
        )}
        {settings.timers.length === 0 && open !== 'new' && (
          <li className="empty">No timers yet. Add one to remind viewers to follow, or to share your Discord every half hour.</li>
        )}
        {settings.timers.map((t, i) => {
          const isOpen = open === i;
          const st = view.timers.find((x) => x.id === t.id);
          const rule = [`Every ${minutes(t.interval)}`];
          if (t.lines > 0) rule.push(t.lines === 1 ? 'after a chat line' : `after ${t.lines} chat lines`);
          if (t.liveOnly) rule.push('only while live');
          return (
            <li key={t.id} className={'type cmd' + (isOpen ? ' open' : '') + (t.enabled ? '' : ' off')}>
              <div className="type-row">
                <div className="type-main">
                  <b className="timer-name">{t.name}</b>
                  <span className="cmd-reply">{t.message}</span>
                  <span className="cmd-meta">{rule.join(' · ')}</span>
                  <span className={'timer-status' + (st?.nextAt && !st.waiting ? ' due' : '')}>{statusText(st, now)}</span>
                </div>
                <button className="btn sm ghost" type="button" disabled={!settings.enabled || !t.enabled} title={settings.enabled ? 'Post it in your chat now' : 'Turn the bot on first'} onClick={() => sendNow(t)}>
                  Send now
                </button>
                <button className="btn sm ghost" type="button" aria-expanded={isOpen} aria-controls={`timer-edit-${i}`} onClick={() => setOpen(isOpen ? null : i)}>
                  {isOpen ? 'Close' : 'Edit'}
                </button>
                <button
                  className="switch"
                  type="button"
                  role="switch"
                  aria-checked={t.enabled}
                  aria-label={t.name}
                  onClick={() => onSave(
                    { ...settings, timers: settings.timers.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)) },
                    `${t.name} ${t.enabled ? 'off' : 'on'}`,
                  )}
                />
              </div>
              {isOpen && (
                <TimerEditor
                  id={`timer-edit-${i}`}
                  timer={t}
                  onCancel={() => setOpen(null)}
                  onDelete={async () => {
                    if (await onSave({ ...settings, timers: settings.timers.filter((_, j) => j !== i) }, `${t.name} deleted`, settings)) setOpen(null);
                  }}
                  onSave={async (next) => {
                    if (await onSave({ ...settings, timers: settings.timers.map((x, j) => (j === i ? next : x)) }, `${next.name.trim()} saved`)) setOpen(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function TimerEditor({ id, timer, isNew, onSave, onCancel, onDelete }: {
  id?: string; timer: BotTimer; isNew?: boolean;
  onSave(t: BotTimer): Promise<void>; onCancel(): void; onDelete?(): Promise<void>;
}) {
  const [draft, setDraft] = useState(timer);
  const [busy, setBusy] = useState(false);
  const message = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<BotTimer>) => setDraft((d) => ({ ...d, ...patch }));
  const f = (name: string) => `${id ?? 'timer-new'}-${name}`;
  const changed = isNew || JSON.stringify(draft) !== JSON.stringify(timer);
  const options = (list: number[], n: number) => (list.includes(n) ? list : [...list, n].sort((a, b) => a - b));

  const insert = (v: string) => {
    const el = message.current;
    const at = el ? el.selectionStart : draft.message.length;
    const end = el ? el.selectionEnd : at;
    set({ message: (draft.message.slice(0, at) + v + draft.message.slice(end)).slice(0, MAX_REPLY) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + v.length, at + v.length);
    });
  };

  return (
    <form
      className="cmd-edit timer-edit"
      id={id}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onSave(draft); } finally { setBusy(false); }
      }}
    >
      <div className="cmd-fields">
        <label className="field wide" htmlFor={f('name')}>
          Name
          <input id={f('name')} className="input" maxLength={40} required autoFocus={isNew} placeholder="Follow reminder"
            value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          <span className="field-hint">Only you see this.</span>
        </label>
        <label className="field wide" htmlFor={f('message')}>
          <span className="field-row">Message<span className="field-hint">{draft.message.length} / {MAX_REPLY}</span></span>
          <textarea id={f('message')} ref={message} className="input textarea" rows={3} maxLength={MAX_REPLY} required
            placeholder="Enjoying the stream? Hit follow so you know when I am live." value={draft.message} onChange={(e) => set({ message: e.target.value })} />
        </label>
        <div className="field wide">
          <span id={f('vars')}>Add to the message</span>
          <div className="chips" role="group" aria-labelledby={f('vars')}>
            {TIMER_VARIABLES.map((v) => (
              <button key={v.v} type="button" className="chip" title={v.what} onClick={() => insert(v.v)}>{v.v}</button>
            ))}
          </div>
        </div>
        <label className="field" htmlFor={f('interval')}>
          Post every
          <select id={f('interval')} className="select" value={draft.interval} onChange={(e) => set({ interval: Number(e.target.value) })}>
            {options(INTERVALS, draft.interval).map((n) => <option key={n} value={n}>{minutes(n)}</option>)}
          </select>
        </label>
        <label className="field" htmlFor={f('lines')}>
          Chat lines in between
          <select id={f('lines')} className="select" value={draft.lines} onChange={(e) => set({ lines: Number(e.target.value) })}>
            {options(LINES, draft.lines).map((n) => <option key={n} value={n}>{n === 0 ? 'None needed' : `At least ${n}`}</option>)}
          </select>
        </label>
        <div className="field inline wide">
          <span>Only while you are live</span>
          <button className="switch" type="button" role="switch" aria-checked={draft.liveOnly} aria-label="Only while you are live"
            onClick={() => set({ liveOnly: !draft.liveOnly })} />
        </div>
      </div>
      <div className="cmd-preview">
        <span className="cmd-preview-label">How it runs</span>
        <p className="bubble">
          {draft.liveOnly ? 'While you are live, ' : ''}the bot posts this every {minutes(draft.interval)}
          {draft.lines > 0 ? `, once at least ${draft.lines} chat ${draft.lines === 1 ? 'line has' : 'lines have'} been sent since the last time` : ''}.
          Timers are spaced at least 30 seconds apart.
        </p>
      </div>
      <div className="type-actions">
        {onDelete && <button className="btn ghost danger push-left" type="button" onClick={() => onDelete()}><Icon id="trash" />Delete</button>}
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn primary" type="submit" disabled={busy || !changed || !draft.name.trim() || !draft.message.trim()}>{busy ? 'Saving' : isNew ? 'Add timer' : 'Save'}</button>
      </div>
    </form>
  );
}

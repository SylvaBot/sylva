// The Chat bot page: turn the bot on, edit its commands, and try them in a
// test chat that never reaches Twitch. The rules match
// crates/sylva-core/src/bot.rs, which checks every save again.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type BotCommand, type BotSettings, type BotView, type UserLevel } from './api';
import { useChannel } from './channel';
import { Card, PageHead } from './pages';
import { errorText, Icon, num, useToast } from './ui';

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
    : <>your own account, <b>{ch.name}</b>, with Twitch&apos;s Chat Bot badge</>;

  return (
    <div className="page">
      <PageHead title="Chat bot" desc="Commands that answer in your chat. Try them here before your viewers do." />
      {failed && !view && <Card><div className="card-body"><p className="card-text">Could not load your bot. Refresh to try again.</p></div></Card>}
      {!view && !failed && <Card><div className="card-body"><p className="card-text">Loading</p></div></Card>}
      {settings && (
        <div className="stack">
          <Card id="bot-on">
            <div className="bot-status">
              <span className={'tile ' + (settings.enabled ? 'c-follow' : '')}><Icon id="bot" /></span>
              <div className="type-main">
                <b>{settings.enabled ? 'The bot is on' : 'The bot is off'}</b>
                <span>{settings.enabled ? <>It answers commands in your chat as {who}.</> : <>Turn it on to answer commands in your chat. Replies come from {who}.</>}</span>
              </div>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                aria-label="Chat bot"
                onClick={() => save({ ...settings, enabled: !settings.enabled }, settings.enabled ? 'The bot is off' : 'The bot is on')}
              />
            </div>
          </Card>

          <Card
            id="commands"
            title="Commands"
            desc="A viewer types the command in chat and the bot replies. Moderators skip cooldowns."
            action={
              <button className="btn sm" type="button" onClick={() => setOpen('new')} disabled={open === 'new' || settings.commands.length >= 100}>
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
                        {isOpen ? 'Close' : 'Edit'}
                      </button>
                      <button
                        className="switch"
                        type="button"
                        role="switch"
                        aria-checked={c.enabled}
                        aria-label={`!${c.name}`}
                        onClick={() => save(
                          { ...settings, commands: settings.commands.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)) },
                          `!${c.name} ${c.enabled ? 'off' : 'on'}`,
                        )}
                      />
                    </div>
                    {isOpen && (
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
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>

          <TestChat settings={settings} />
        </div>
      )}
    </div>
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

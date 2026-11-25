// Counters and quotes on the Chat bot page. The rules match
// crates/sylva-core/src/community.rs, which checks every save again.

import { useEffect, useMemo, useState } from 'react';
import { api, type BotCounter, type BotSettings, type BotView, type Quote, type UserLevel } from './api';
import { useChannel } from './channel';
import { Card } from './pages';
import { errorText, Gate, Icon, num, useToast } from './ui';

type Save = (next: BotSettings, done?: string, undo?: BotSettings) => Promise<boolean>;

export function Counters({ view, onSave, onView }: { view: BotView; onSave: Save; onView(v: BotView): void }) {
  const ch = useChannel();
  const toast = useToast();
  const settings = view.settings;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');

  const change = async (c: BotCounter, value: number) => {
    try {
      onView(await api.setCounter(ch.key, c.name, value));
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const add = async () => {
    const n = name.trim().replace(/^!/, '').toLowerCase();
    if (await onSave({ ...settings, counters: [...settings.counters, { name: n, label: label.trim(), value: 0, enabled: true }] }, `!${n} added`)) {
      setAdding(false);
      setName('');
      setLabel('');
    }
  };

  return (
    <Card
      id="counters"
      className="counters-card"
      title="Counters"
      desc={<>Numbers your chat can see, such as deaths or wins. Anyone can type <code>!deaths</code>; moderators change it with <code>!deaths +</code>, <code>!deaths -</code> or <code>!deaths = 10</code>.</>}
      action={
        <button className="btn sm" type="button" onClick={() => setAdding(true)} disabled={!ch.can.edit || adding || settings.counters.length >= 30}>
          <Icon id="plus" />New counter
        </button>
      }
    >
      <ul className="types">
        {adding && (
          <li className="type open">
            <form className="counter-new" onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <label className="field" htmlFor="counter-name">
                Command
                <span className="prefixed"><span aria-hidden="true">!</span>
                  <input id="counter-name" className="input" required maxLength={26} autoFocus placeholder="deaths" value={name} onChange={(e) => setName(e.target.value)} />
                </span>
              </label>
              <label className="field" htmlFor="counter-label">
                What chat sees
                <input id="counter-label" className="input" maxLength={40} placeholder="Deaths" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <div className="type-actions">
                <button className="btn ghost" type="button" onClick={() => setAdding(false)}>Cancel</button>
                <button className="btn primary" type="submit" disabled={!name.trim()}>Add counter</button>
              </div>
            </form>
          </li>
        )}
        {settings.counters.length === 0 && !adding && (
          <li className="empty">No counters yet. Add one, such as !deaths, and keep score from chat or from here.</li>
        )}
        {settings.counters.map((c, i) => (
          <li key={c.name} className={'type cmd' + (c.enabled ? '' : ' off')}>
            <div className="type-row">
              <div className="type-main">
                <b className="cmd-name">!{c.name}</b>
                <span className="cmd-reply">{c.label}: {num(c.value)}</span>
              </div>
              <Gate on={ch.can.moderate}>
                <div className="stepper" role="group" aria-label={`${c.label} value`}>
                  <button className="btn sm" type="button" aria-label={`One less ${c.label}`} onClick={() => void change(c, c.value - 1)}>−</button>
                  <CounterValue counter={c} onSet={(v) => void change(c, v)} />
                  <button className="btn sm" type="button" aria-label={`One more ${c.label}`} onClick={() => void change(c, c.value + 1)}><Icon id="plus" /></button>
                </div>
              </Gate>
              <button
                className="btn sm ghost"
                type="button"
                aria-label={`Delete !${c.name}`}
                title="Delete"
                disabled={!ch.can.edit}
                onClick={() => void onSave({ ...settings, counters: settings.counters.filter((_, j) => j !== i) }, `!${c.name} deleted`, settings)}
              >
                <Icon id="trash" />
              </button>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-checked={c.enabled}
                aria-label={`!${c.name}`}
                disabled={!ch.can.edit}
                onClick={() => void onSave(
                  { ...settings, counters: settings.counters.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)) },
                  `!${c.name} ${c.enabled ? 'off' : 'on'}`,
                )}
              />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CounterValue({ counter, onSet }: { counter: BotCounter; onSet(v: number): void }) {
  const [text, setText] = useState(String(counter.value));
  useEffect(() => setText(String(counter.value)), [counter.value]);
  const commit = () => {
    const n = Math.trunc(Number(text));
    if (text.trim() === '' || !Number.isFinite(n)) { setText(String(counter.value)); return; }
    if (n !== counter.value) onSet(n);
  };
  return (
    <input
      className="input num-input"
      type="number"
      inputMode="numeric"
      aria-label={`${counter.label} now`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
    />
  );
}

const ADD_LEVELS: { id: UserLevel; label: string }[] = [
  { id: 'moderator', label: 'Moderators' },
  { id: 'vip', label: 'VIPs and up' },
  { id: 'subscriber', label: 'Subscribers and up' },
  { id: 'broadcaster', label: 'Only you' },
];

function day(at: number): string {
  return new Date(at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

const PAGE = 50;

export function Quotes({ view, onSave }: { view: BotView; onSave: Save }) {
  const ch = useChannel();
  const toast = useToast();
  const qs = view.settings.quotes;
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  useEffect(() => {
    api.quotes(ch.key).then((r) => setQuotes(r.quotes)).catch(() => setQuotes([]));
  }, [ch.key]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = [...(quotes ?? [])].reverse();
    if (!q) return all;
    return all.filter((x) => `#${x.id} ${x.text} ${x.by} ${x.game}`.toLowerCase().includes(q));
  }, [quotes, search]);

  const put = (q: Quote) => setQuotes((old) => [...(old ?? []).filter((x) => x.id !== q.id), q].sort((a, b) => a.id - b.id));

  const remove = async (q: Quote) => {
    try {
      await api.deleteQuote(ch.key, q.id);
      setQuotes((old) => (old ?? []).filter((x) => x.id !== q.id));
      toast(`Quote #${q.id} removed`, false, {
        label: 'Undo',
        run: () => {
          api.addQuote(ch.key, { text: q.text, by: q.by, game: q.game, id: q.id, at: q.at })
            .then((back) => { put(back); toast(`Quote #${back.id} is back`); })
            .catch((x) => toast(errorText(x), true));
        },
      });
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  return (
    <Card
      id="quotes"
      className="quotes-card"
      title="Quotes"
      desc={<>Viewers type <code>!quote</code> for a random one, <code>!quote 12</code> for that one, or <code>!quote word</code> to search. <code>!addquote</code> and <code>!delquote 12</code> add and remove them from chat.</>}
      action={
        <button className="btn sm" type="button" onClick={() => setEditing('new')} disabled={!ch.can.moderate || editing === 'new'}>
          <Icon id="plus" />New quote
        </button>
      }
    >
      <div className="card-body quote-settings">
        <div className="field inline">
          <span>Quotes in chat</span>
          <button className="switch" type="button" role="switch" aria-checked={qs.enabled} aria-label="Quotes in chat" disabled={!ch.can.edit}
            onClick={() => void onSave({ ...view.settings, quotes: { ...qs, enabled: !qs.enabled } }, qs.enabled ? 'Quotes are off in chat' : 'Quotes are on in chat')} />
        </div>
        <label className="field" htmlFor="quote-level">
          Who can add and remove from chat
          <select id="quote-level" className="select" value={qs.addLevel} disabled={!qs.enabled || !ch.can.edit}
            onChange={(e) => void onSave({ ...view.settings, quotes: { ...qs, addLevel: e.target.value as UserLevel } }, 'Saved')}>
            {ADD_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        <label className="field" htmlFor="quote-search">
          Search
          <input id="quote-search" className="input" type="search" placeholder="Words, a name, a game or #12" value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }} />
        </label>
      </div>
      <ul className="types quote-list">
        {editing === 'new' && (
          <li className="type open">
            <QuoteEditor
              isNew
              onCancel={() => setEditing(null)}
              onSave={async (q) => {
                try {
                  const added = await api.addQuote(ch.key, q);
                  put(added);
                  setEditing(null);
                  toast(`Quote #${added.id} added`);
                } catch (x) {
                  toast(errorText(x), true);
                }
              }}
            />
          </li>
        )}
        {quotes === null && <li className="empty">Loading</li>}
        {quotes?.length === 0 && editing !== 'new' && <li className="empty">No quotes yet. Add the first one here, or with !addquote in chat.</li>}
        {quotes !== null && quotes.length > 0 && list.length === 0 && <li className="empty">No quote matches that search.</li>}
        {list.slice(0, shown).map((q) => (
          <li key={q.id} className={'type' + (editing === q.id ? ' open' : '')}>
            <div className="type-row">
              <span className="quote-id">#{q.id}</span>
              <div className="type-main">
                <span className="quote-text">&ldquo;{q.text}&rdquo;</span>
                <span className="cmd-meta">{[q.by || ch.name, q.game, day(q.at)].filter(Boolean).join(' · ')}</span>
              </div>
              {ch.can.moderate && (
                <>
                  <button className="btn sm ghost" type="button" aria-expanded={editing === q.id} onClick={() => setEditing(editing === q.id ? null : q.id)}>
                    {editing === q.id ? 'Close' : 'Edit'}
                  </button>
                  <button className="btn sm ghost" type="button" aria-label={`Remove quote #${q.id}`} title="Remove" onClick={() => void remove(q)}><Icon id="trash" /></button>
                </>
              )}
            </div>
            {editing === q.id && (
              <QuoteEditor
                quote={q}
                onCancel={() => setEditing(null)}
                onSave={async (next) => {
                  try {
                    put(await api.editQuote(ch.key, q.id, next));
                    setEditing(null);
                    toast(`Quote #${q.id} saved`);
                  } catch (x) {
                    toast(errorText(x), true);
                  }
                }}
              />
            )}
          </li>
        ))}
      </ul>
      {list.length > shown && (
        <div className="card-body load-more">
          <button className="btn sm" type="button" onClick={() => setShown(shown + PAGE)}>Show more ({num(list.length - shown)} left)</button>
        </div>
      )}
    </Card>
  );
}

function QuoteEditor({ quote, isNew, onSave, onCancel }: {
  quote?: Quote; isNew?: boolean;
  onSave(q: { text: string; by: string; game: string }): Promise<void>; onCancel(): void;
}) {
  const [text, setText] = useState(quote?.text ?? '');
  const [by, setBy] = useState(quote?.by ?? '');
  const [game, setGame] = useState(quote?.game ?? '');
  const [busy, setBusy] = useState(false);
  const id = isNew ? 'quote-new' : `quote-${quote?.id}`;
  const changed = isNew || text !== quote?.text || by !== quote?.by || game !== quote?.game;
  return (
    <form
      className="cmd-edit quote-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onSave({ text, by, game }); } finally { setBusy(false); }
      }}
    >
      <div className="cmd-fields">
        <label className="field wide" htmlFor={`${id}-text`}>
          <span className="field-row">Quote<span className="field-hint">{text.length} / 300</span></span>
          <textarea id={`${id}-text`} className="input textarea" rows={2} maxLength={300} required autoFocus={isNew} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="field" htmlFor={`${id}-by`}>
          Who said it
          <input id={`${id}-by`} className="input" maxLength={40} placeholder="You, if left empty" value={by} onChange={(e) => setBy(e.target.value)} />
        </label>
        <label className="field" htmlFor={`${id}-game`}>
          Game
          <input id={`${id}-game`} className="input" maxLength={40} placeholder="Optional" value={game} onChange={(e) => setGame(e.target.value)} />
        </label>
      </div>
      <div className="type-actions">
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn primary" type="submit" disabled={busy || !changed || !text.trim()}>{busy ? 'Saving' : isNew ? 'Add quote' : 'Save'}</button>
      </div>
    </form>
  );
}

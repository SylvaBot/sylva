// The Store page (rewards viewers buy with points, and the queue of what
// they bought) and the public page viewers open at /s/{login}. The rules
// match crates/sylva-core/src/store.rs, which checks every save again.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type PublicStore, type Redemption, type StoreItem, type StoreSettings, type StoreView } from './api';
import { useChannel } from './channel';
import { NumberField } from './moderation';
import { Card, PageHead } from './pages';
import { Link } from './router';
import { SiteFooter, SiteHeader } from './site';
import { errorText, Icon, num, useToast } from './ui';

const COOLDOWNS = [0, 1, 5, 10, 15, 30, 60, 120, 360, 720, 1440, 10080];

function wait(m: number): string {
  if (m === 0) return 'No wait';
  if (m % 1440 === 0) return m === 1440 ? '1 day' : m === 10080 ? '1 week' : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  return m === 1 ? '1 minute' : `${m} minutes`;
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

const blank = (): StoreItem => ({ id: '', name: '', description: '', cost: 500, enabled: true, stock: null, cooldown: 0, input: false });

export function StorePage() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<StoreView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.store(ch.key).then(setView).catch(() => setFailed(true));
  }, [ch.key]);

  const save = async (settings: StoreSettings, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      setView(await api.saveStore(ch.key, settings));
      toast(done);
      return true;
    } catch (x) {
      toast(errorText(x), true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const login = view?.login ?? ch.twitch?.login;
  const link = login ? `${location.origin}/s/${login}` : null;

  return (
    <div className="page">
      <PageHead title="Store" desc="Rewards viewers buy with their points. What they buy waits here until you mark it done." />
      {failed && !view && <Card><div className="card-body"><p className="card-text">Could not load the store. Refresh to try again.</p></div></Card>}
      {!view && !failed && <Card><div className="card-body"><p className="card-text">Loading</p></div></Card>}
      {view && (
        <div className="stack">
          {!view.pointsOn && (
            <div className="notice">
              <span>The store sells rewards for loyalty points, which are off. Turn points on first.</span>
              <Link className="btn primary sm" href="/app/loyalty">Open Loyalty</Link>
            </div>
          )}
          {view.pointsOn && view.settings.enabled && !view.botOn && (
            <div className="notice">
              <span>Viewers redeem with <code>!redeem</code> in chat, which only answers while the chat bot is on.</span>
              <Link className="btn sm" href="/app/bot">Open Chat bot</Link>
            </div>
          )}
          <Queue view={view} name={view.pointsName} onChanged={() => api.store(ch.key).then(setView).catch(() => {})} />
          <Rewards view={view} link={link} busy={busy} onSave={save} />
        </div>
      )}
    </div>
  );
}

function Queue({ view, name, onChanged }: { view: StoreView; name: string; onChanged(): void }) {
  const ch = useChannel();
  const toast = useToast();
  const [tab, setTab] = useState<'pending' | 'done'>('pending');
  const [list, setList] = useState<Redemption[] | null>(null);
  const [more, setMore] = useState(false);
  const [, tick] = useState(0);
  const asked = useRef(0);

  const load = useCallback(async () => {
    const n = ++asked.current;
    try {
      const r = await api.redemptions(ch.key, tab);
      if (n !== asked.current) return;
      setList(r.redemptions);
      // The queue shows up to 200 waiting at once; history pages by 50.
      setMore(tab === 'done' && r.redemptions.length === 50);
    } catch {
      if (n === asked.current) setList((old) => old ?? []);
    }
  }, [ch.key, tab]);

  useEffect(() => {
    setList(null);
    void load();
    const t = setInterval(() => { if (!document.hidden) { void load(); tick((x) => x + 1); } }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const older = async () => {
    if (!list?.length) return;
    try {
      const r = await api.redemptions(ch.key, 'done', list[list.length - 1].id);
      setList([...list, ...r.redemptions]);
      setMore(r.redemptions.length === 50);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const act = async (r: Redemption, action: 'done' | 'reopen' | 'refund') => {
    try {
      const next = await api.settle(ch.key, r.id, action);
      setList((old) => old?.filter((x) => x.id !== r.id) ?? null);
      onChanged();
      if (action === 'done') {
        toast(`${r.name}’s ${r.itemName} is done`, false, { label: 'Undo', run: () => void act(next, 'reopen') });
      } else if (action === 'refund') {
        toast(`${r.name} got ${num(r.cost)} ${name} back`);
      } else {
        toast(`${r.itemName} is back in the queue`);
        if (tab === 'pending') void load();
      }
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  return (
    <Card
      id="store-queue"
      className="store-queue"
      title="Redemptions"
      desc={tab === 'pending'
        ? 'Oldest first. Mark each one done when you have done it, or refund it to give the points back.'
        : 'Done and refunded, newest first.'}
      action={
        <div className="segmented sm" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === 'pending'} onClick={() => setTab('pending')}>
            Waiting{view.pending ? ` (${num(view.pending)})` : ''}
          </button>
          <button type="button" aria-pressed={tab === 'done'} onClick={() => setTab('done')}>History</button>
        </div>
      }
    >
      {list === null && <p className="empty">Loading</p>}
      {list?.length === 0 && (
        <p className="empty">
          <Icon id="gift" />
          {tab === 'pending' ? 'Nothing waiting. When a viewer redeems a reward, it shows here.' : 'Nothing done yet.'}
        </p>
      )}
      {!!list?.length && (
        <ul className="types store-list">
          {list.map((r) => (
            <li key={r.id} className="type">
              <div className="type-row">
                <div className="type-main">
                  <b>{r.itemName}<span className="store-who">for {r.name}</span></b>
                  {r.input && <span className="store-input">&ldquo;{r.input}&rdquo;</span>}
                  <span className="cmd-meta">
                    {num(r.cost)} {name}
                    {' · '}
                    <time dateTime={new Date(r.at).toISOString()}>{when(r.at)}</time>
                    {r.status !== 'pending' && <> · <span className={r.status === 'refunded' ? 'store-refunded' : ''}>{r.status === 'done' ? 'Done' : 'Refunded'}</span></>}
                  </span>
                </div>
                <div className="store-actions">
                  {r.status !== 'refunded' && (
                    <button className="btn sm ghost" type="button" aria-label={`Refund ${r.itemName} for ${r.name}`} onClick={() => void act(r, 'refund')}>Refund</button>
                  )}
                  {r.status === 'pending' && (
                    <button className="btn sm primary" type="button" aria-label={`Mark ${r.itemName} for ${r.name} done`} onClick={() => void act(r, 'done')}><Icon id="tick" />Done</button>
                  )}
                  {r.status === 'done' && (
                    <button className="btn sm" type="button" aria-label={`Put ${r.itemName} for ${r.name} back in the queue`} onClick={() => void act(r, 'reopen')}><Icon id="undo" />Not done</button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {more && <div className="card-body load-more"><button className="btn sm" type="button" onClick={() => void older()}>Show more</button></div>}
    </Card>
  );
}

function Rewards({ view, link, busy, onSave }: {
  view: StoreView; link: string | null; busy: boolean;
  onSave(s: StoreSettings, done: string): Promise<boolean>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const s = view.settings;
  const name = view.pointsName;

  const put = (item: StoreItem) => {
    const items = item.id && s.items.some((i) => i.id === item.id)
      ? s.items.map((i) => (i.id === item.id ? item : i))
      : [...s.items, item];
    return onSave({ ...s, items }, item.id ? `${item.name} saved` : `${item.name} added`);
  };

  const remove = async (item: StoreItem) => {
    const at = s.items.findIndex((i) => i.id === item.id);
    const ok = await onSave({ ...s, items: s.items.filter((i) => i.id !== item.id) }, `${item.name} removed`);
    if (ok) {
      setEditing(null);
      toast(`${item.name} removed`, false, {
        label: 'Undo',
        run: () => {
          const items = [...view.settings.items.filter((i) => i.id !== item.id)];
          items.splice(Math.min(at, items.length), 0, item);
          void onSave({ ...view.settings, items }, `${item.name} is back`);
        },
      });
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied');
    } catch {
      toast('Could not copy. Select the link and copy it instead.', true);
    }
  };

  const shown = s.items.filter((i) => i.enabled);
  return (
    <Card
      id="store-rewards"
      className="store-rewards"
      title="Rewards"
      desc={<>Viewers see them with <code>!store</code> and buy one with <code>!redeem</code> and its number or name, such as <code>!redeem 1</code>.</>}
      action={
        <button className="btn sm" type="button" onClick={() => setEditing('new')} disabled={editing === 'new'}>
          <Icon id="plus" />New reward
        </button>
      }
    >
      <div className="card-body store-settings">
        <div className="field inline">
          <span>Store open</span>
          <button className="switch" type="button" role="switch" aria-checked={s.enabled} aria-label="Store open" disabled={busy}
            onClick={() => void onSave({ ...s, enabled: !s.enabled }, s.enabled ? 'The store is closed' : 'The store is open')} />
        </div>
        {link && (
          <div className="store-link">
            <span className="field-hint">Public page</span>
            <a href={link} target="_blank" rel="noreferrer">{link.replace(/^https?:\/\//, '')}<Icon id="external" /></a>
            <button className="btn sm ghost" type="button" onClick={() => void copy()}><Icon id="copy" />Copy</button>
          </div>
        )}
      </div>
      <ul className="types store-items">
        {editing === 'new' && (
          <li className="type open">
            <RewardEditor item={blank()} isNew name={name} onCancel={() => setEditing(null)}
              onSave={async (i) => { if (await put(i)) setEditing(null); }} />
          </li>
        )}
        {s.items.length === 0 && editing !== 'new' && (
          <li className="empty">No rewards yet. Add one, such as Hydrate for 100 {name} or a song request for 500.</li>
        )}
        {s.items.map((item) => {
          const number = shown.indexOf(item) + 1;
          return (
            <li key={item.id} className={'type' + (editing === item.id ? ' open' : '') + (item.enabled ? '' : ' off')}>
              <div className="type-row">
                <span className="quote-id">{item.enabled ? number : 'Off'}</span>
                <div className="type-main">
                  <b>{item.name}</b>
                  <span className="cmd-meta">
                    {[
                      `${num(item.cost)} ${name}`,
                      item.stock === null ? null : item.stock === 0 ? 'Sold out' : `${num(item.stock)} left`,
                      item.cooldown ? `Once every ${wait(item.cooldown)} per viewer` : null,
                      item.input ? 'Asks for a message' : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <button className="btn sm ghost" type="button" aria-expanded={editing === item.id} aria-label={`${editing === item.id ? 'Close' : 'Edit'} ${item.name}`}
                  onClick={() => setEditing(editing === item.id ? null : item.id)}>
                  {editing === item.id ? 'Close' : 'Edit'}
                </button>
              </div>
              {editing === item.id && (
                <RewardEditor item={item} name={name} onCancel={() => setEditing(null)} onDelete={() => remove(item)}
                  onSave={async (i) => { if (await put(i)) setEditing(null); }} />
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RewardEditor({ item, isNew, name, onSave, onCancel, onDelete }: {
  item: StoreItem; isNew?: boolean; name: string;
  onSave(i: StoreItem): Promise<void>; onCancel(): void; onDelete?(): Promise<void>;
}) {
  const [draft, setDraft] = useState(item);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<StoreItem>) => setDraft((d) => ({ ...d, ...patch }));
  const f = (k: string) => `reward-${item.id || 'new'}-${k}`;
  const changed = isNew || JSON.stringify(draft) !== JSON.stringify(item);
  const limited = draft.stock !== null;
  return (
    <form
      className="cmd-edit reward-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onSave(draft); } finally { setBusy(false); }
      }}
    >
      <div className="cmd-fields">
        <label className="field" htmlFor={f('name')}>
          Name
          <input id={f('name')} className="input" maxLength={40} required autoFocus={isNew} placeholder="Hydrate"
            value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="field">
          <span id={f('cost-label')}>Cost</span>
          <div className="reward-cost" role="group" aria-labelledby={f('cost-label')}>
            <NumberField label="Cost" value={draft.cost} min={1} max={10_000_000} onChange={(n) => set({ cost: n })} />
            <span>{name}</span>
          </div>
        </div>
        <label className="field wide" htmlFor={f('desc')}>
          <span className="field-row">Description<span className="field-hint">{draft.description.length} / 200</span></span>
          <input id={f('desc')} className="input" maxLength={200} placeholder="I take a drink of water on stream"
            value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className="field" htmlFor={f('cooldown')}>
          Each viewer waits
          <select id={f('cooldown')} className="select" value={draft.cooldown} onChange={(e) => set({ cooldown: Number(e.target.value) })}>
            {(COOLDOWNS.includes(draft.cooldown) ? COOLDOWNS : [...COOLDOWNS, draft.cooldown].sort((a, b) => a - b)).map((m) => (
              <option key={m} value={m}>{m === 0 ? 'No wait' : `${wait(m)} between buys`}</option>
            ))}
          </select>
        </label>
        <div className="field">
          <span id={f('stock-label')}>How many</span>
          <div className="reward-stock" role="group" aria-labelledby={f('stock-label')}>
            <select className="select" aria-label="Limit" value={limited ? 'limited' : 'unlimited'}
              onChange={(e) => set({ stock: e.target.value === 'limited' ? (item.stock ?? 10) : null })}>
              <option value="unlimited">Unlimited</option>
              <option value="limited">Limited</option>
            </select>
            {limited && <NumberField label="How many are left" value={draft.stock ?? 0} min={0} max={1_000_000} onChange={(n) => set({ stock: n })} />}
          </div>
        </div>
        <div className="field inline wide">
          <span>Viewers add a message, such as a song name</span>
          <button className="switch" type="button" role="switch" aria-checked={draft.input} aria-label="Viewers add a message"
            onClick={() => set({ input: !draft.input })} />
        </div>
        <div className="field inline wide">
          <span>Shown in the store</span>
          <button className="switch" type="button" role="switch" aria-checked={draft.enabled} aria-label="Shown in the store"
            onClick={() => set({ enabled: !draft.enabled })} />
        </div>
      </div>
      <div className="cmd-preview">
        <span className="cmd-preview-label">In chat</span>
        <p className="bubble">
          <code>!redeem {draft.name.trim() || 'Hydrate'}{draft.input ? ' your message' : ''}</code> costs {num(draft.cost)} {name}
          {limited ? `, while ${num(draft.stock ?? 0)} ${draft.stock === 1 ? 'is' : 'are'} left` : ''}
          {draft.cooldown ? `, once every ${wait(draft.cooldown)} per viewer` : ''}.
          It then waits under Redemptions until you mark it done.
        </p>
      </div>
      <div className="type-actions">
        {onDelete && <button className="btn ghost danger push-left" type="button" onClick={() => void onDelete()}><Icon id="trash" />Remove</button>}
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn primary" type="submit" disabled={busy || !changed || !draft.name.trim()}>{busy ? 'Saving' : isNew ? 'Add reward' : 'Save'}</button>
      </div>
    </form>
  );
}

/** The public page at /s/{login}: anyone can see the rewards and the leaderboard. */
export function PublicStorePage({ login, signedIn }: { login: string; signedIn: boolean }) {
  const [data, setData] = useState<PublicStore | null | 'missing' | 'failed'>(null);
  const [who, setWho] = useState('');
  const [found, setFound] = useState<PublicStore['viewer'] | null>(null);
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    api.publicStore(login)
      .then((d) => { setData(d); document.title = `${d.channel}’s ${d.pointsName} · Sylva`; })
      .catch((x) => { setData(x?.status === 404 ? 'missing' : 'failed'); document.title = 'Store · Sylva'; });
  }, [login]);

  const look = async () => {
    const q = who.trim().replace(/^@/, '');
    if (!q) return;
    setLooking(true);
    try {
      setFound((await api.publicStore(login, q)).viewer ?? null);
    } catch {
      setFound(null);
    } finally {
      setLooking(false);
    }
  };

  const header = (
    <SiteHeader>
      <span className="spacer" />
      {signedIn ? <Link className="btn" href="/app">Open dashboard</Link> : <Link className="btn" href="/">What is Sylva?</Link>}
    </SiteHeader>
  );

  if (data === null || data === 'missing' || data === 'failed') {
    return (
      <div className="site">
        {header}
        <main id="content" className="prose wrap">
          {data === null
            ? <p className="prose-lede" role="status">Loading</p>
            : <>
                <h1>{data === 'missing' ? 'No points here' : 'Something went wrong'}</h1>
                <p className="prose-lede">
                  {data === 'missing'
                    ? `${login} does not have loyalty points on Sylva, or the link is mistyped.`
                    : 'Sylva could not be reached. Refresh to try again.'}
                </p>
              </>}
        </main>
        <SiteFooter />
      </div>
    );
  }

  const pts = data.pointsName;
  return (
    <div className="site">
      {header}
      <main id="content" className="wrap pub">
        <div className="pub-head">
          <p className="pub-eyebrow">twitch.tv/{login}</p>
          <h1>{data.channel}’s {pts}</h1>
          <p className="prose-lede">
            Earn {pts} by watching and chatting while {data.channel} is live. Type <code>!{pts.replace(/ /g, '')}</code> in chat to see yours.
          </p>
          <form className="pub-look" onSubmit={(e) => { e.preventDefault(); void look(); }}>
            <label className="sr-only" htmlFor="pub-who">Your Twitch name</label>
            <input id="pub-who" className="input" placeholder="Your Twitch name" maxLength={25} value={who} onChange={(e) => { setWho(e.target.value); setFound(null); }} />
            <button className="btn primary" type="submit" disabled={looking || !who.trim()}>Check {pts}</button>
          </form>
          <p className="pub-found" aria-live="polite">
            {found && (found.balance > 0
              ? <><b>{found.name}</b> has <b>{num(found.balance)}</b> {pts}, rank {num(found.rank)}.</>
              : <><b>{found.name}</b> has no {pts} yet.</>)}
          </p>
        </div>

        <div className="pub-grid">
          <section className="card" aria-labelledby="pub-rewards">
            <div className="card-head"><div><h2 id="pub-rewards">Rewards</h2>
              {data.items.length > 0 && <p>Type <code>!redeem</code> and the number in chat, such as <code>!redeem {data.items[0].number}</code>.</p>}
            </div></div>
            {data.items.length === 0
              ? <p className="empty"><Icon id="gift" />{data.storeOn ? 'No rewards yet. Check back soon.' : 'The store is closed right now.'}</p>
              : (
                <ul className="pub-items">
                  {data.items.map((i) => (
                    <li key={i.number} className={i.stock === 0 ? 'sold' : ''}>
                      <span className="pub-num">{i.number}</span>
                      <div className="pub-item">
                        <b>{i.name}</b>
                        {i.description && <span>{i.description}</span>}
                        <span className="pub-tags">
                          {[
                            i.stock === 0 ? 'Sold out' : i.stock != null ? `${num(i.stock)} left` : null,
                            i.cooldown ? `Once every ${wait(i.cooldown)}` : null,
                            i.input ? `Add a message: !redeem ${i.number} your message` : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      <span className="pub-cost">{num(i.cost)}<span className="sr-only"> {pts}</span></span>
                    </li>
                  ))}
                </ul>
              )}
          </section>
          <section className="card" aria-labelledby="pub-top">
            <div className="card-head"><div><h2 id="pub-top">Leaderboard</h2><p>The viewers with the most {pts}.</p></div></div>
            {data.top.length === 0
              ? <p className="empty">Nobody has any {pts} yet.</p>
              : (
                <ol className="pub-top">
                  {data.top.map((v) => (
                    <li key={v.rank}>
                      <span className="pub-num">{v.rank}</span>
                      <b>{v.name}</b>
                      <span className="pub-cost">{num(v.balance)}</span>
                    </li>
                  ))}
                </ol>
              )}
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

// The Points page: rewards viewers buy with their points, how they earn
// them, every viewer's balance, and the chat games. Saves as you go. The
// rules match crates/sylva-core/src/loyalty.rs and store.rs, which check
// every save again. What viewers buy waits in Activity to be marked done.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type LoyaltySettings, type LoyaltyView, type PointsEntry, type PointsViewer, type StoreItem, type StoreSettings, type StoreView } from './api';
import { AmountField } from './alertsPage';
import { useChannel } from './channel';
import { GamesTab } from './games';
import { PageHead } from './pages';
import { Link, navigate, useSearch } from './router';
import { ArmedButton, Drawer, errorText, Gate, Icon, num, SaveState, Seg, Skel, Switch, useAutosave, useToast } from './ui';
import { Select } from './dropdown';

type Tab = 'rewards' | 'viewers' | 'games';
const TABS: { id: Tab; label: string }[] = [{ id: 'rewards', label: 'Rewards' }, { id: 'viewers', label: 'Viewers' }, { id: 'games', label: 'Games' }];
const ALLOW_URL = '/auth/twitch/start?scopes=loyalty&next=/app/points';
const COOLDOWNS = [0, 1, 5, 10, 15, 30, 60, 120, 360, 720, 1440, 10080];
const MAX_RULE = 100_000;

function wait(m: number): string {
  if (m === 0) return 'None';
  if (m % 1440 === 0) return m === 1440 ? '1 day' : m === 10080 ? '1 week' : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  return `${m} min`;
}

function tabFromUrl(): Tab {
  const t = new URLSearchParams(location.search).get('tab');
  if (t === 'viewers' || t === 'games') return t;
  return location.hash === '#games' ? 'games' : 'rewards';
}

export function PointsPage() {
  useSearch();
  const tab = tabFromUrl();
  const [name, setName] = useState<string | null>(null);
  const go = (t: Tab) => navigate('/app/points' + (t === 'rewards' ? '' : '?tab=' + t));

  return (
    <div className="page points-page">
      <PageHead
        title="Points"
        desc={<>Viewers earn {name ? <b className="strong">{name}</b> : 'points'} by watching and chatting, then spend them on rewards.</>}
      >
        <Seg label="Show" options={TABS} value={tab} onChange={go} />
      </PageHead>
      {tab === 'rewards' && (
        <div className="points-cols">
          <Rewards />
          <Earning onName={setName} />
        </div>
      )}
      {tab === 'viewers' && <Viewers />}
      {tab === 'games' && <GamesTab />}
      {tab !== 'rewards' && <NameOnly onName={setName} />}
    </div>
  );
}

/** Loads the points name for the heading when the earning panel is not shown. */
function NameOnly({ onName }: { onName(n: string): void }) {
  const ch = useChannel();
  useEffect(() => { api.loyalty(ch.key).then((v) => onName(v.settings.name || 'points')).catch(() => {}); }, [ch.key, onName]);
  return null;
}

/* ------------------------------------------------------------- Rewards */

const blank = (): StoreItem => ({ id: '', name: '', description: '', cost: 500, enabled: true, stock: null, cooldown: 0, input: false });

function Rewards() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<StoreView | null>(null);
  const [failed, setFailed] = useState(false);
  const store = useAutosave<StoreSettings>((s) => api.saveStore(ch.key, s).then((v) => { setView(v); return v.settings; }));
  const [editing, setEditing] = useState<string | 'new' | null>(new URLSearchParams(location.search).get('new') ? 'new' : null);
  const [drag, setDrag] = useState<number | null>(null);

  useEffect(() => {
    api.store(ch.key).then((v) => { setView(v); store.reset(v.settings); }).catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch.key]);

  const s = store.value;
  const name = view?.pointsName || 'points';
  const login = view?.login || ch.login;
  const link = login ? `${location.origin}/s/${login}` : null;

  const put = (item: StoreItem) => store.set((cur) => ({
    ...cur,
    items: item.id && cur.items.some((i) => i.id === item.id) ? cur.items.map((i) => (i.id === item.id ? item : i)) : [...cur.items, item],
  }), true);
  const move = (from: number, to: number) => store.set((cur) => {
    if (to < 0 || to >= cur.items.length || from === to) return cur;
    const items = [...cur.items];
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    return { ...cur, items };
  }, true);
  const remove = (item: StoreItem) => {
    store.set((cur) => ({ ...cur, items: cur.items.filter((i) => i.id !== item.id) }), true);
    setEditing(null);
    toast(`${item.name} removed`);
  };
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); toast('Store link copied'); } catch { toast('Could not copy the link.', true); }
  };

  const shown = s?.items.filter((i) => i.enabled) ?? [];
  const current = editing === 'new' ? blank() : s?.items.find((i) => i.id === editing);

  return (
    <section className="sect" aria-labelledby="rewards-title">
      <div className="sect-head">
        <div><h2 id="rewards-title">Rewards</h2></div>
        <div className="page-actions">
          <SaveState saving={store.saving} savedAt={store.savedAt} canUndo={store.canUndo} onUndo={store.undo} />
          <button className="btn sm primary" type="button" disabled={!s || !ch.can.edit} onClick={() => setEditing('new')}><Icon id="plus" />New reward</button>
        </div>
      </div>
      {failed && !s && <div className="notice">Could not load your rewards. Refresh to try again.</div>}
      {view && !view.pointsOn && <div className="notice"><span>Rewards are bought with points, which are off. Turn points on in How viewers earn.</span></div>}
      {view && view.pointsOn && s?.enabled && !view.botOn && (
        <div className="notice"><span>Viewers buy with <code>!redeem</code> in chat, which only answers while the chat bot is on.</span><Link className="btn sm" href="/app/commands">Open Commands</Link></div>
      )}
      <div className="tbl-head rw-cols" aria-hidden="true"><span /><span>Reward</span><span>Cost</span><span>Cooldown</span><span>Left</span><span /></div>
      <div className="grp rw-list">
        {!s && Array.from({ length: 4 }, (_, i) => (
          <div className="gr rw-cols" key={i}><span /><Skel w={140} h={14} /><Skel w={48} h={14} /><Skel w={56} h={14} /><Skel w={40} h={14} /><Skel w={40} h={22} round /></div>
        ))}
        {s && s.items.length === 0 && (
          <div className="empty">No rewards yet. Add one, such as Hydrate for 100 {name} or a song pick for 500.</div>
        )}
        {s?.items.map((item, i) => (
          <div key={item.id} className={'gr rw-cols rw-row' + (drag === i ? ' dragging' : '') + (item.enabled ? '' : ' off')}
            draggable={ch.can.edit} onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { if (drag !== null) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); }} onDragEnd={() => setDrag(null)}>
            <button className="drag-handle" type="button" disabled={!ch.can.edit} aria-label={`Move ${item.name}. Use the up and down arrow keys.`}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
                  const btn = e.currentTarget;
                  requestAnimationFrame(() => btn.focus());
                }
              }}>
              <Icon id="drag" />
            </button>
            <button className="rw-name" type="button" onClick={() => setEditing(item.id)}>
              <span className="t1">{item.name}</span>
              <span className="t2">{item.enabled ? `!redeem ${shown.indexOf(item) + 1}` : 'Hidden from the store'}{item.input ? ', asks for a message' : ''}</span>
            </button>
            <span className="mono">{num(item.cost)}</span>
            <span className="muted">{item.cooldown ? `${wait(item.cooldown)} each` : 'None'}</span>
            <span className="muted">{item.stock === null ? 'Any' : item.stock === 0 ? 'Sold out' : num(item.stock)}</span>
            <Switch label={`${item.name} in the store`} on={item.enabled} disabled={!ch.can.edit} onChange={(v) => put({ ...item, enabled: v })} />
          </div>
        ))}
      </div>
      {s && (
        <div className="grp store-open">
          <div className="gr">
            <div className="gr-main">
              <div className="t1">Store open</div>
              <div className="t2">{link ? <>Viewers see your rewards at <a href={link} target="_blank" rel="noreferrer">{link.replace(/^https?:\/\//, '')}</a> and with !store in chat</> : 'Viewers see your rewards with !store in chat'}</div>
            </div>
            <div className="gr-ctl">
              {link && <button className="btn sm" type="button" onClick={() => void copy()}><Icon id="copy" />Copy link</button>}
              <Switch label="Store open" on={s.enabled} disabled={!ch.can.edit} onChange={(v) => store.set({ ...s, enabled: v }, true)} />
            </div>
          </div>
        </div>
      )}
      <p className="sect-foot">Drag to change the order, which sets each reward&apos;s number. What viewers buy shows in <Link href="/app/activity">Activity</Link> for you to mark done or refund.</p>
      {current && (
        <RewardDrawer key={editing} item={current} isNew={editing === 'new'} name={name}
          onClose={() => { setEditing(null); if (location.search.includes('new=')) navigate('/app/points'); }}
          onSave={(it) => { put(it); setEditing(null); toast(editing === 'new' ? `${it.name} added` : `${it.name} saved`); }}
          onDelete={editing !== 'new' ? () => remove(current) : undefined} />
      )}
    </section>
  );
}

function RewardDrawer({ item, isNew, name, onSave, onClose, onDelete }: {
  item: StoreItem; isNew: boolean; name: string; onSave(i: StoreItem): void; onClose(): void; onDelete?(): void;
}) {
  const [d, setD] = useState(item);
  const set = (p: Partial<StoreItem>) => setD((x) => ({ ...x, ...p }));
  const changed = isNew || JSON.stringify(d) !== JSON.stringify(item);
  const cooldowns = COOLDOWNS.includes(d.cooldown) ? COOLDOWNS : [...COOLDOWNS, d.cooldown].sort((a, b) => a - b);
  return (
    <Drawer title={isNew ? 'New reward' : item.name} icon="gem" onClose={onClose}
      foot={<>
        {onDelete && <ArmedButton className="sm danger" armedText="Click again to delete" icon="trash" onConfirm={onDelete}>Delete</ArmedButton>}
        <span className="spacer" />
        <button className="btn sm" type="button" onClick={onClose}>Cancel</button>
        <button className="btn sm primary" type="submit" form="reward-form" disabled={!changed || !d.name.trim()}>{isNew ? 'Add reward' : 'Save'}</button>
      </>}>
      <form id="reward-form" className="stack" onSubmit={(e) => { e.preventDefault(); if (d.name.trim()) onSave({ ...d, name: d.name.trim() }); }}>
        <label className="field" htmlFor="rw-name">Name
          <input id="rw-name" className="input" maxLength={40} required autoFocus={isNew} placeholder="Hydrate" value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field" htmlFor="rw-desc">Description
          <input id="rw-desc" className="input" maxLength={200} placeholder="I take a drink of water on stream" value={d.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="grp">
          <div className="gr">
            <div className="gr-main"><label className="t1" htmlFor="rw-cost">Cost</label><div className="t2">In {name}</div></div>
            <div className="gr-ctl"><AmountField id="rw-cost" value={d.cost} max={10_000_000} onChange={(n) => set({ cost: Math.max(1, n) })} /></div>
          </div>
          <div className="gr">
            <div className="gr-main"><label className="t1" htmlFor="rw-cool">Each viewer waits</label></div>
            <div className="gr-ctl">
              <Select<number> id="rw-cool" className="sm" value={d.cooldown} onChange={(v) => set({ cooldown: v })}
                options={cooldowns.map((m) => ({ value: m, label: m === 0 ? 'No wait' : wait(m) }))} />
            </div>
          </div>
          <div className="gr">
            <div className="gr-main"><div className="t1">How many</div></div>
            <div className="gr-ctl">
              <Seg label="How many" small options={[{ id: 'any', label: 'Unlimited' }, { id: 'some', label: 'Limited' }]} value={d.stock === null ? 'any' : 'some'}
                onChange={(v) => set({ stock: v === 'any' ? null : (item.stock ?? 10) })} />
              {d.stock !== null && <AmountField id="rw-stock" value={d.stock} onChange={(n) => set({ stock: n })} />}
            </div>
          </div>
          <div className="gr">
            <div className="gr-main"><div className="t1">Viewer adds a message</div><div className="t2">Such as a song name</div></div>
            <div className="gr-ctl"><Switch label="Viewer adds a message" on={d.input} onChange={(v) => set({ input: v })} /></div>
          </div>
          <div className="gr">
            <div className="gr-main"><div className="t1">Shown in the store</div></div>
            <div className="gr-ctl"><Switch label="Shown in the store" on={d.enabled} onChange={(v) => set({ enabled: v })} /></div>
          </div>
        </div>
        <p className="sect-foot">
          Viewers type <code>!redeem {d.name.trim() || 'Hydrate'}{d.input ? ' their message' : ''}</code> and pay {num(d.cost)} {name}
          {d.stock !== null ? `, while ${num(d.stock)} ${d.stock === 1 ? 'is' : 'are'} left` : ''}
          {d.cooldown ? `, once every ${wait(d.cooldown)} each` : ''}.
        </p>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------- Earning */

type Rule = 'watch' | 'active' | 'follow' | 'sub' | 'gift' | 'cheer';

function Earning({ onName }: { onName(n: string): void }) {
  const ch = useChannel();
  const [view, setView] = useState<LoyaltyView | null>(null);
  const [failed, setFailed] = useState(false);
  const loyalty = useAutosave<LoyaltySettings>((s) => api.saveLoyalty(ch.key, s).then((v) => { setView(v); return v.settings; }));
  const [nameText, setNameText] = useState('');

  useEffect(() => {
    api.loyalty(ch.key).then((v) => { setView(v); loyalty.reset(v.settings); setNameText(v.settings.name); onName(v.settings.name || 'points'); }).catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch.key]);

  const s = loyalty.value;
  const every = view?.everyMinutes ?? 5;
  const period = every === 1 ? 'every minute' : `every ${every} minutes`;
  const rules: { key: Rule; name: string; desc: string }[] = [
    { key: 'watch', name: 'Watching', desc: `For every viewer in chat, ${period} you are live` },
    { key: 'active', name: 'Chatting bonus', desc: `Extra for viewers who chatted, ${period}` },
    { key: 'follow', name: 'New follower bonus', desc: 'Given once' },
    { key: 'sub', name: 'Subscribing', desc: 'For each sub and resub' },
    { key: 'gift', name: 'Gifting subs', desc: 'For each sub gifted' },
    { key: 'cheer', name: 'Cheering', desc: 'For every 100 bits' },
  ];
  const commitName = () => {
    if (!s) return;
    const n = nameText.trim().slice(0, 20);
    if (!n) { setNameText(s.name); return; }
    if (n !== s.name) { loyalty.set({ ...s, name: n }, true); onName(n); }
  };
  const cmd = (s?.name || 'points').toLowerCase().replace(/ /g, '');

  return (
    <section className="sect earning" aria-labelledby="earn-title">
      <div className="sect-head"><div><h2 id="earn-title">How viewers earn</h2></div></div>
      {failed && !s && <div className="notice">Could not load points. Refresh to try again.</div>}
      {s && view && s.enabled && view.permission !== 'ok' && (
        <div className="notice">
          <span>{ch.can.own ? 'Only viewers who chat earn watch points right now. Let Sylva see who is in your chat so lurkers earn too.' : `Only viewers who chat earn watch points until ${ch.name} allows the chat list.`}</span>
          {ch.can.own && <a className="btn primary sm" href={ALLOW_URL}><Icon id="twitch" />Allow chat list</a>}
        </div>
      )}
      <Gate on={ch.can.edit}>
        <div className="grp">
          <div className="gr">
            <div className="gr-main"><div className="t1">Points</div><div className="t2">{!s ? ' ' : !s.enabled ? 'Off. Nobody earns until you turn them on' : view?.live ? 'On, and paying viewers now' : 'On. Paid while you are live'}</div></div>
            <div className="gr-ctl">{s ? <Switch label="Points" on={s.enabled} onChange={(v) => loyalty.set({ ...s, enabled: v }, true)} /> : <Skel w={40} h={22} round />}</div>
          </div>
          <div className="gr">
            <div className="gr-main"><label className="t1" htmlFor="pts-name">Points name</label><div className="t2">Viewers check with !{cmd}</div></div>
            <div className="gr-ctl">
              <input id="pts-name" className="input name-input" maxLength={20} placeholder="points" value={nameText} disabled={!s}
                onChange={(e) => setNameText(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(); } }} />
            </div>
          </div>
          {rules.map((r) => (
            <div className="gr" key={r.key}>
              <div className="gr-main"><label className="t1" htmlFor={'pts-' + r.key}>{r.name}</label><div className="t2">{r.desc}</div></div>
              <div className="gr-ctl">
                {s ? <AmountField id={'pts-' + r.key} value={s[r.key]} max={MAX_RULE} onChange={(n) => loyalty.set({ ...s, [r.key]: n }, true)} /> : <Skel w={72} h={36} round />}
              </div>
            </div>
          ))}
          <div className="gr">
            <div className="gr-main"><div className="t1">Viewers can give points</div><div className="t2">With !give @name 100</div></div>
            <div className="gr-ctl">{s ? <Switch label="Viewers can give points" on={s.give} onChange={(v) => loyalty.set({ ...s, give: v }, true)} /> : <Skel w={40} h={22} round />}</div>
          </div>
        </div>
      </Gate>
      <div className="earn-foot">
        <p className="sect-foot">You and your bot never earn. Viewers see the top five with !top, and moderators add or take away with !addpoints @name 100.</p>
        <SaveState saving={loyalty.saving} savedAt={loyalty.savedAt} canUndo={loyalty.canUndo} onUndo={loyalty.undo} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- Viewers */

const PAGE = 50;

function Viewers() {
  const ch = useChannel();
  const [q, setQ] = useState('');
  const [list, setList] = useState<PointsViewer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [name, setName] = useState('points');
  const [open, setOpen] = useState<PointsViewer | null>(null);
  const asked = useRef(0);

  useEffect(() => { api.loyalty(ch.key).then((v) => setName(v.settings.name || 'points')).catch(() => {}); }, [ch.key]);

  const load = useCallback(async (query: string, offset: number) => {
    const n = ++asked.current;
    try {
      const r = await api.pointsViewers(ch.key, query.trim(), offset, PAGE);
      if (n !== asked.current) return;
      setTotal(r.total);
      setList((old) => (offset === 0 ? r.viewers : [...(old ?? []), ...r.viewers]));
    } catch {
      if (n === asked.current) setList((old) => old ?? []);
    }
  }, [ch.key]);

  useEffect(() => {
    const t = setTimeout(() => void load(q, 0), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  const searching = q.trim() !== '';
  return (
    <section className="sect" aria-label="Viewers">
      <div className="sect-head">
        <label className="search viewers-search" htmlFor="pts-q">
          <Icon id="search" /><span className="sr-only">Search viewers</span>
          <input id="pts-q" className="input" type="search" placeholder="Search viewers" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="faint small" role="status">{list ? `${num(total)} ${total === 1 ? 'viewer' : 'viewers'}${searching ? ' found' : ''}` : ' '}</span>
      </div>
      <div className="tbl-head vw-cols" aria-hidden="true"><span>#</span><span>Viewer</span><span>Earned in all</span><span>{name}</span><span /></div>
      <div className="grp">
        {list === null && Array.from({ length: 6 }, (_, i) => (
          <div className="gr vw-cols" key={i}><Skel w={18} h={14} /><Skel w={120} h={14} /><Skel w={60} h={14} /><Skel w={60} h={14} /><span /></div>
        ))}
        {list?.length === 0 && <div className="empty">{searching ? 'No viewer matches that name.' : `Nobody has any ${name} yet. Viewers start earning once points are on and you go live.`}</div>}
        {list?.map((v, i) => (
          <button type="button" className="gr vw-cols vw-row" key={v.id} onClick={() => setOpen(v)}>
            <span className="faint mono">{searching ? '' : i + 1}</span>
            <span className="t1">{v.name}</span>
            <span className="muted mono">{num(v.earned)}</span>
            <span className="mono">{num(v.balance)}</span>
            <Icon id="chevron" />
          </button>
        ))}
      </div>
      {!!list && list.length < total && (
        <div className="sect-more"><button className="btn sm" type="button" onClick={() => void load(q, list.length)}>Show more ({num(total - list.length)} left)</button></div>
      )}
      {open && (
        <ViewerDrawer viewer={open} name={name} onClose={() => setOpen(null)}
          onSaved={(nv) => { setOpen(nv); setList((old) => old?.map((x) => (x.id === nv.id ? nv : x)) ?? null); }} />
      )}
    </section>
  );
}

function when(at: number): string {
  const d = new Date(at);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ViewerDrawer({ viewer, name, onClose, onSaved }: { viewer: PointsViewer; name: string; onClose(): void; onSaved(v: PointsViewer): void }) {
  const ch = useChannel();
  const toast = useToast();
  const [entries, setEntries] = useState<PointsEntry[] | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const loadLedger = useCallback(() => {
    api.pointsLedger(ch.key, viewer.id).then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  }, [ch.key, viewer.id]);
  useEffect(loadLedger, [loadLedger]);

  const delta = Math.round(Number(amount.replace(/,/g, '')));
  const valid = amount.trim() !== '' && Number.isFinite(delta) && delta !== 0;
  const apply = async (sign: 1 | -1) => {
    if (!valid) return;
    setBusy(true);
    try {
      const v = await api.adjustPoints(ch.key, viewer.id, sign * Math.abs(delta), reason);
      onSaved(v);
      setAmount('');
      setReason('');
      loadLedger();
      toast(`${v.name} now has ${num(v.balance)} ${name}`);
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={viewer.name} icon="user" onClose={onClose}>
      <div className="grp viewer-totals">
        <div><span className="faint small">{name}</span><b className="mono">{num(viewer.balance)}</b></div>
        <div><span className="faint small">Earned in all</span><b className="mono">{num(viewer.earned)}</b></div>
      </div>
      {ch.can.moderate && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void apply(1); }}>
          <div className="two">
            <label className="field" htmlFor="vw-amount">Amount
              <input id="vw-amount" className="input" inputMode="numeric" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d,]/g, ''))} />
            </label>
            <label className="field" htmlFor="vw-reason">Reason
              <input id="vw-reason" className="input" maxLength={60} placeholder="Won the raffle" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
          <div className="row-end">
            <button className="btn sm" type="button" disabled={busy || !valid} onClick={() => void apply(-1)}>Take away</button>
            <button className="btn sm primary" type="submit" disabled={busy || !valid}>Add</button>
          </div>
        </form>
      )}
      <section className="sect" aria-labelledby="ledger-title">
        <div className="sect-head"><div><h2 id="ledger-title">Recent changes</h2></div></div>
        <div className="grp">
          {entries === null && Array.from({ length: 3 }, (_, i) => <div className="gr" key={i}><Skel w={50} h={14} /><Skel w={140} h={14} /></div>)}
          {entries?.length === 0 && <div className="empty">No changes kept for this viewer.</div>}
          {entries?.map((e) => (
            <div className="gr ledger-row" key={e.id}>
              <span className={'mono ledger-delta' + (e.delta < 0 ? ' minus' : '')}>{e.delta > 0 ? '+' : ''}{num(e.delta)}</span>
              <span className="gr-main t2">{e.reason}</span>
              <time className="faint small" dateTime={new Date(e.at).toISOString()}>{when(e.at)}</time>
            </div>
          ))}
        </div>
      </section>
    </Drawer>
  );
}

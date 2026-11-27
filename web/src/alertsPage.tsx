// The Alerts page: one row per event with what it does on stream and in
// chat, the overlay link with the queue controls, and a side panel that
// edits one event. Everything saves as you go, with Undo. The rules match
// crates/sylva-core/src/alerts.rs and chat_alerts.rs, which check them again.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api, isSound, mediaUrl, type AlertSettings, type AlertState, type ChatAlertGroup, type ChatAlertInfo, type ChatAlertSettings,
  type ChatAlertsView, type Kind, type KindSettings, type MediaFile, type Overlay, type TipSettings,
} from './api';
import { useChannel } from './channel';
import { CustomFrame, testEvent, type Send } from './customWidget';
import { codeOf } from './overlay';
import { PageHead, sendTest, TESTS } from './pages';
import { Link } from './router';
import { ArmedButton, Drawer, errorText, Gate, Icon, num, SaveState, Seg, Skel, Switch, Tile, useAutosave, useToast } from './ui';

interface Meta { name: string; desc: string; icon: string; unit?: string; chat: string[]; smallest?: string }
const META: Partial<Record<Kind, Meta>> = {
  follow: { name: 'Follow', desc: '', icon: 'heart', chat: ['follows'] },
  subscriber: { name: 'Subscription', desc: 'New subs and resubs', icon: 'star', chat: ['subs', 'resubs'] },
  communityGift: { name: 'Gifted subs', desc: 'One alert per gift', icon: 'gift', unit: 'subs', chat: ['gifts', 'mass'], smallest: 'Fewest gifted subs that alert' },
  cheer: { name: 'Bits', desc: '', icon: 'zap', unit: 'bits', chat: ['bits'], smallest: 'Fewest bits that alert' },
  raid: { name: 'Raid', desc: '', icon: 'raid', unit: 'viewers', chat: ['raids'], smallest: 'Fewest raiders that alert' },
  tip: { name: 'Tip', desc: '', icon: 'tip', unit: '', chat: [], smallest: 'Smallest tip that alerts' },
  redemption: { name: 'Points redemption', desc: 'Channel points rewards', icon: 'gem', chat: [] },
};
/** Chat alerts with no on stream alert of their own. */
const MORE_ICONS: Record<string, string> = {
  hype: 'zap', stream: 'monitor', predictions: 'dice', polls: 'chart', charity: 'heart', ads: 'clock', streaks: 'trophy',
};
const LENGTHS = [4, 6, 8, 10, 15];
const ALLOW_URL = '/auth/twitch/start?scopes=alerts&next=/app/alerts';

function stateText(s: AlertState | null): string {
  if (!s) return 'Connecting';
  const parts: string[] = [];
  if (s.paused) parts.push('Paused');
  if (s.muted) parts.push('Muted');
  if (s.playing !== null) parts.push('An alert is on screen');
  if (s.queued) parts.push(`${num(s.queued)} waiting`);
  if (!parts.length) parts.push(s.overlaysConnected ? 'Ready' : 'No overlay open in OBS right now');
  return parts.join(', ');
}

function minText(k: KindSettings, m: Meta, money: (n: number) => string): string {
  if (m.unit === undefined || k.minAmount <= 0) return m.desc;
  return m.unit ? `From ${num(k.minAmount)} ${m.unit}` : `From ${money(k.minAmount)}`;
}

export function AlertsPage() {
  const ch = useChannel();
  const kinds = useAutosave<AlertSettings>((v) => api.saveAlertSettings(ch.key, v));
  const chat = useAutosave<ChatAlertSettings>((v) => api.saveChatAlerts(ch.key, v).then((r) => { setChatView(r); return r.settings; }));
  const [chatView, setChatView] = useState<ChatAlertsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{ kind?: Kind; group?: string } | null>(null);
  const [currency, setCurrency] = useState('USD');
  const moreRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setFailed(false);
    api.alertSettings(ch.key).then(kinds.reset).catch(() => setFailed(true));
    api.chatAlerts(ch.key).then((v) => { setChatView(v); chat.reset(v.settings); }).catch(() => setFailed(true));
    api.tips(ch.key).then((t) => setCurrency(t.settings.currency || 'USD')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch.key]);

  // Old Chat alerts links land on the chat only alerts.
  useEffect(() => {
    if (chatView && new URLSearchParams(location.search).get('tab') === 'chat') moreRef.current?.scrollIntoView({ block: 'start' });
  }, [chatView]);

  const money = useMemo(() => {
    const f = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    return (n: number) => f.format(n);
  }, [currency]);

  const groups = chatView?.groups ?? [];
  const groupOf = (id: string) => groups.find((g) => g.id === id);
  const alertsIn = (ids: string[]) => ids.flatMap((id) => groupOf(id)?.alerts ?? []);
  const chatOn = (ids: string[]) => !!chat.value && alertsIn(ids).some((a) => chat.value!.alerts[a.id]?.enabled);
  const setChat = (ids: string[], on: boolean) => chat.set((s) => {
    const alerts = { ...s.alerts };
    for (const a of alertsIn(ids)) if (alerts[a.id]) alerts[a.id] = { ...alerts[a.id], enabled: on };
    return { ...s, alerts };
  }, true);
  const setKind = (next: KindSettings, now = false) =>
    kinds.set((s) => ({ kinds: s.kinds.map((k) => (k.kind === next.kind ? next : k)) }), now);

  const used = new Set(Object.values(META).flatMap((m) => m!.chat));
  const more = groups.filter((g) => !used.has(g.id));
  const rows = kinds.value?.kinds.filter((k) => META[k.kind]) ?? [];
  const editing = open?.kind ? kinds.value?.kinds.find((k) => k.kind === open.kind) : undefined;
  const editingGroup = open?.group ? groupOf(open.group) : undefined;
  const wantsGrant = !!chatView && !!chat.value && chatView.permission !== 'ok' &&
    groups.some((g) => chatView.needsGrant.includes(g.id) && g.alerts.some((a) => chat.value!.alerts[a.id]?.enabled));

  const saving = kinds.saving || chat.saving;
  const savedAt = Math.max(kinds.savedAt ?? 0, chat.savedAt ?? 0) || null;
  const lastUndo = (kinds.savedAt ?? 0) >= (chat.savedAt ?? 0) ? kinds : chat;

  return (
    <div className="page alerts-page">
      <PageHead title="Alerts" desc="Pick what shows on stream and what Sylva says in chat.">
        <SaveState saving={saving} savedAt={savedAt} canUndo={lastUndo.canUndo} onUndo={lastUndo.undo} />
      </PageHead>

      <OverlayLink />

      {failed && !kinds.value && <div className="notice">Could not load your alert settings. Refresh to try again.</div>}
      {wantsGrant && (
        <div className="notice">
          <span>
            {!ch.can.own
              ? `Some chat alerts need ${ch.name} to allow them on this page.`
              : chatView!.permission === 'expired'
                ? 'Twitch no longer accepts Sylva’s permission to see charity, ad breaks, hype trains, predictions and polls. Allow it again so those alerts keep working.'
                : 'Charity, ad break, hype train, prediction and poll alerts need your permission on Twitch first.'}
          </span>
          {ch.can.own && <a className="btn primary sm" href={ALLOW_URL}><Icon id="twitch" />Allow on Twitch</a>}
        </div>
      )}

      <div className="ev-head" aria-hidden="true">
        <span className="ev-tile" /><span className="ev-name">Event</span><span className="ev-col">On stream</span><span className="ev-col">In chat</span><span className="ev-go" />
      </div>
      <div className="grp ev-list">
        {!kinds.value || !chat.value
          ? Object.keys(META).map((k) => (
            <div className="gr ev-row" key={k}>
              <Skel w={32} h={32} round /><span className="ev-name"><Skel w={120} h={14} /></span>
              <span className="ev-col"><Skel w={40} h={22} round /></span><span className="ev-col"><Skel w={40} h={22} round /></span><span className="ev-go" />
            </div>
          ))
          : rows.map((k) => {
            const m = META[k.kind]!;
            const desc = minText(k, m, money);
            return (
              <div className={'gr ev-row' + (open?.kind === k.kind ? ' on' : '')} key={k.kind}>
                <Tile icon={m.icon} />
                <button className="ev-name ev-open" type="button" onClick={() => setOpen({ kind: k.kind })}>
                  <span className="t1">{m.name}</span>{desc && <span className="t2">{desc}</span>}
                </button>
                <span className="ev-col">
                  <Switch label={`${m.name} on stream`} on={k.enabled} disabled={!ch.can.edit} onChange={(v) => setKind({ ...k, enabled: v }, true)} />
                </span>
                <span className="ev-col">
                  {m.chat.length > 0 && <Switch label={`${m.name} in chat`} on={chatOn(m.chat)} disabled={!ch.can.edit} onChange={(v) => setChat(m.chat, v)} />}
                </span>
                <button className="icon-btn ev-go" type="button" aria-label={`Edit ${m.name}`} onClick={() => setOpen({ kind: k.kind })}><Icon id="chevron" /></button>
              </div>
            );
          })}
      </div>

      <section className="sect" id="chat-more" ref={moreRef} aria-labelledby="chat-more-title">
        <div className="sect-head"><div><h2 id="chat-more-title">More chat alerts</h2><p>Moments Sylva_Bot announces in chat, with nothing on stream.</p></div></div>
        <div className="grp ev-list">
          {!chat.value
            ? Array.from({ length: 7 }, (_, i) => (
              <div className="gr ev-row" key={i}>
                <Skel w={32} h={32} round /><span className="ev-name"><Skel w={140} h={14} /></span><span className="ev-col" />
                <span className="ev-col"><Skel w={40} h={22} round /></span><span className="ev-go" />
              </div>
            ))
            : more.map((g) => {
              const on = g.alerts.filter((a) => chat.value!.alerts[a.id]?.enabled).length;
              return (
                <div className={'gr ev-row' + (open?.group === g.id ? ' on' : '')} key={g.id}>
                  <Tile icon={MORE_ICONS[g.id] ?? 'message'} />
                  <button className="ev-name ev-open" type="button" onClick={() => setOpen({ group: g.id })}>
                    <span className="t1">{g.title}</span>
                    <span className="t2">{on ? (g.alerts.length > 1 ? `${on} of ${g.alerts.length} on` : 'On') : 'Off'}</span>
                  </button>
                  <span className="ev-col" />
                  <span className="ev-col"><Switch label={`${g.title} in chat`} on={on > 0} disabled={!ch.can.edit} onChange={(v) => setChat([g.id], v)} /></span>
                  <button className="icon-btn ev-go" type="button" aria-label={`Edit ${g.title}`} onClick={() => setOpen({ group: g.id })}><Icon id="chevron" /></button>
                </div>
              );
            })}
        </div>
        {chatView && (
          <p className="sect-foot">
            Chat alerts come from {chatView.sender.kind === 'sylva' ? 'Sylva_Bot' : 'your own account'}.
          </p>
        )}
      </section>

      {editing && kinds.value && chat.value && (
        <KindDrawer
          k={editing}
          meta={META[editing.kind]!}
          groups={META[editing.kind]!.chat.map(groupOf).filter((g): g is ChatAlertGroup => !!g)}
          chat={chat.value}
          money={money}
          currency={currency}
          saveState={{ saving, savedAt, canUndo: lastUndo.canUndo, undo: lastUndo.undo }}
          onKind={setKind}
          onChat={(s) => chat.set(s)}
          onClose={() => setOpen(null)}
        />
      )}
      {editingGroup && chat.value && (
        <Drawer title={editingGroup.title} icon={MORE_ICONS[editingGroup.id] ?? 'message'} onClose={() => setOpen(null)}
          foot={<><span className="spacer" /><SaveState saving={saving} savedAt={savedAt} canUndo={lastUndo.canUndo} onUndo={lastUndo.undo} /></>}>
          {editingGroup.desc && <p className="muted small">{editingGroup.desc}</p>}
          <Gate on={ch.can.edit} className="stack">
            <ChatGroupEditor group={editingGroup} chat={chat.value} onChat={(s) => chat.set(s)} />
          </Gate>
        </Drawer>
      )}
    </div>
  );
}

/** The alert overlay's link, with pause, mute and skip for the queue. */
function OverlayLink() {
  const ch = useChannel();
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const s = ch.alerts;

  useEffect(() => {
    setUrl(null);
    if (ch.can.edit) api.overlay(ch.key).then((r) => setUrl(r.url)).catch(() => {});
  }, [ch.key, ch.can.edit]);

  const run = async (id: string, action: 'pause' | 'resume' | 'mute' | 'unmute' | 'skip', ok: string) => {
    setBusy(id);
    try { ch.setAlerts(await api.alert(ch.key, action)); toast(ok); } catch (x) { toast(errorText(x), true); } finally { setBusy(null); }
  };
  const copy = async () => {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast('Alert overlay link copied. Paste it into a Browser Source in OBS.'); }
    catch { toast('Could not copy the link. Open Overlays to copy it.', true); }
  };

  return (
    <div className="grp link-card">
      <Tile icon="monitor" />
      <div className="gr-main">
        <div className="t1">Alert overlay link</div>
        <div className="t2" aria-live="polite">{ch.can.edit ? 'Add it to OBS as a browser source. ' : ''}{stateText(s)}</div>
      </div>
      <div className="link-ctl">
        {ch.can.moderate && (
          <>
            <button className="btn sm icon" type="button" aria-pressed={!!s?.paused} disabled={!s || busy === 'pause'}
              aria-label={s?.paused ? 'Resume alerts' : 'Pause alerts'} title={s?.paused ? 'Resume alerts' : 'Pause alerts'}
              onClick={() => run('pause', s?.paused ? 'resume' : 'pause', s?.paused ? 'Alerts resumed' : 'Alerts paused')}>
              <Icon id={s?.paused ? 'play' : 'pause'} />
            </button>
            <button className="btn sm icon" type="button" aria-pressed={!!s?.muted} disabled={!s || busy === 'mute'}
              aria-label={s?.muted ? 'Unmute alerts' : 'Mute alerts'} title={s?.muted ? 'Unmute alerts' : 'Mute alerts'}
              onClick={() => run('mute', s?.muted ? 'unmute' : 'mute', s?.muted ? 'Alerts unmuted' : 'Alerts muted')}>
              <Icon id={s?.muted ? 'volx' : 'vol'} />
            </button>
            <button className="btn sm icon" type="button" disabled={!s || s.playing === null || busy === 'skip'}
              aria-label="Skip the alert on screen" title="Skip the alert on screen" onClick={() => run('skip', 'skip', 'Skipped the alert on screen')}>
              <Icon id="skip" />
            </button>
          </>
        )}
        {ch.can.edit && <button className="btn sm" type="button" disabled={!url} onClick={() => void copy()}><Icon id="copy" />Copy link</button>}
      </div>
    </div>
  );
}

function KindDrawer({ k, meta, groups, chat, money, currency, saveState, onKind, onChat, onClose }: {
  k: KindSettings; meta: Meta; groups: ChatAlertGroup[]; chat: ChatAlertSettings; money(n: number): string; currency: string;
  saveState: { saving: boolean; savedAt: number | null; canUndo: boolean; undo(): void };
  onKind(k: KindSettings, now?: boolean): void; onChat(s: ChatAlertSettings | ((s: ChatAlertSettings) => ChatAlertSettings)): void; onClose(): void;
}) {
  const ch = useChannel();
  const toast = useToast();
  const [tab, setTab] = useState<'stream' | 'chat'>('stream');
  const [testing, setTesting] = useState(false);
  const test = TESTS.find((t) => t.kind === k.kind);
  const runTest = async () => {
    if (!test) return;
    setTesting(true);
    try {
      const r = await sendTest(ch.key, test);
      toast(r.alert ? `Test ${meta.name.toLowerCase()} sent to your overlay` : `Test ${meta.name.toLowerCase()} added to Activity. Its alert is off.`);
    } catch (x) { toast(errorText(x), true); } finally { setTesting(false); }
  };

  return (
    <Drawer
      title={meta.name}
      icon={meta.icon}
      onClose={onClose}
      actions={ch.can.moderate && test ? <button className="btn sm" type="button" disabled={testing} onClick={() => void runTest()}><Icon id="play" />Test</button> : undefined}
      foot={<><span className="spacer" /><SaveState saving={saveState.saving} savedAt={saveState.savedAt} canUndo={saveState.canUndo} onUndo={saveState.undo} /></>}
    >
      {groups.length > 0 && (
        <Seg<'stream' | 'chat'> label="Where" full options={[{ id: 'stream', label: 'On stream' }, { id: 'chat', label: 'In chat' }]} value={tab} onChange={setTab} />
      )}
      <Gate on={ch.can.edit} className="stack">
        {tab === 'stream'
          ? <StreamTab k={k} meta={meta} money={money} currency={currency} onKind={onKind} />
          : groups.map((g) => <ChatGroupEditor key={g.id} group={g} chat={chat} onChat={onChat} titled={groups.length > 1} />)}
      </Gate>
    </Drawer>
  );
}

function StreamTab({ k, meta, money, currency, onKind }: {
  k: KindSettings; meta: Meta; money(n: number): string; currency: string; onKind(k: KindSettings, now?: boolean): void;
}) {
  const ch = useChannel();
  const toast = useToast();
  const [media, setMedia] = useState<MediaFile[] | null>(null);
  const set = (patch: Partial<KindSettings>, now = false) => onKind({ ...k, ...patch }, now);
  const seconds = Math.round(k.durationMs / 1000);
  const lengths = LENGTHS.includes(seconds) ? LENGTHS : [...LENGTHS, seconds].sort((a, b) => a - b);
  const hasMessage = k.kind === 'cheer' || k.kind === 'subscriber' || k.kind === 'tip';

  useEffect(() => { api.media(ch.key).then(setMedia).catch(() => setMedia([])); }, [ch.key]);

  const upload = async (file: File): Promise<MediaFile | null> => {
    try {
      const added = await api.uploadMedia(ch.key, file);
      setMedia((m) => [added, ...(m ?? [])]);
      toast(`${added.name} uploaded`);
      return added;
    } catch (x) { toast(errorText(x), true); return null; }
  };
  const remove = async (id: string) => {
    try {
      setMedia(await api.deleteMedia(ch.key, id));
      if (k.sound === id) set({ sound: undefined }, true);
      if (k.image === id) set({ image: undefined }, true);
      toast('File deleted. Alerts that used it no longer play it.');
    } catch (x) { toast(errorText(x), true); }
  };

  return (
    <>
      <AlertPreview kind={k.kind} />
      <div className="grp">
        {meta.unit !== undefined && (
          <div className="gr">
            <div className="gr-main">
              <label className="t1" htmlFor="min-amount">{meta.smallest}</label>
              <div className="t2">Smaller {meta.unit || 'tips'} still show in Activity</div>
            </div>
            <div className="gr-ctl">
              <AmountField id="min-amount" value={k.minAmount} money={meta.unit === '' ? currency : null} onChange={(n) => set({ minAmount: n })} />
            </div>
          </div>
        )}
        <div className="gr">
          <div className="gr-main"><div className="t1">Length</div></div>
          <div className="gr-ctl"><Seg label="Length" options={lengths.map((s) => ({ id: s, label: `${s}s` }))} value={seconds} onChange={(s) => set({ durationMs: s * 1000 }, true)} /></div>
        </div>
        <div className="gr">
          <div className="gr-main"><div className="t1">Look</div><div className="t2">Shared by every alert</div></div>
          <div className="gr-ctl"><Link className="btn sm" href="/app/alerts/style"><Icon id="palette" />Edit style</Link></div>
        </div>
        <div className="gr">
          <div className="gr-main"><label className="t1" htmlFor="alert-sound">Sound</label></div>
          <div className="gr-ctl">
            <MediaPick what="sound" id="alert-sound" value={k.sound} files={media?.filter((f) => isSound(f.id)) ?? null} volume={k.volume}
              onPick={(v) => set({ sound: v }, true)} onUpload={upload} onDelete={remove} />
          </div>
        </div>
        {k.sound && (
          <div className="gr">
            <div className="gr-main"><div className="t1">Sound volume</div></div>
            <div className="gr-ctl"><Range label="Sound volume" value={k.volume} onChange={(v) => set({ volume: v })} /></div>
          </div>
        )}
        <div className="gr">
          <div className="gr-main"><label className="t1" htmlFor="alert-image">Image or GIF</label></div>
          <div className="gr-ctl">
            <MediaPick what="image" id="alert-image" value={k.image} files={media?.filter((f) => !isSound(f.id)) ?? null} volume={k.volume}
              onPick={(v) => set({ image: v }, true)} onUpload={upload} onDelete={remove} />
          </div>
        </div>
        {hasMessage && (
          <div className="gr">
            <div className="gr-main"><div className="t1">Show what the viewer wrote</div></div>
            <div className="gr-ctl"><Switch label="Show what the viewer wrote" on={k.showMessage} onChange={(v) => set({ showMessage: v }, true)} /></div>
          </div>
        )}
      </div>
      {k.kind === 'tip' && <TipSpeech money={money} />}
      <p className="sect-foot">{meta.unit === '' ? 'Amounts are in your tip currency, ' + currency + '.' : 'Turned off, these still show in Activity.'}</p>
    </>
  );
}

/** The real alert code playing one sample of this event. */
function AlertPreview({ kind }: { kind: Kind }) {
  const ch = useChannel();
  const [list, setList] = useState<Overlay[] | null>(null);
  const [play, setPlay] = useState(0);
  useEffect(() => { api.overlays(ch.key).then(setList).catch(() => setList([])); }, [ch.key]);
  const alerts = list?.find((o) => o.builtin === 'alerts');
  const code = useMemo(() => {
    if (!alerts) return null;
    const c = codeOf(alerts);
    return { ...c, values: { ...c.values, duration: 3600, maxQueue: 1, position: 'middle-center', alertSound: '' } };
  }, [alerts]);
  const bind = (send: Send | null) => { if (send) setTimeout(() => testEvent(send, kind, true), 200); };
  return (
    <div className="checker alert-preview">
      {code ? <CustomFrame key={kind + play} code={code} bind={bind} /> : list ? null : <Skel w={260} h={48} round />}
      {code && <button className="btn sm bare replay-btn" type="button" onClick={() => setPlay((n) => n + 1)} aria-label="Play the preview again"><Icon id="replay" /></button>}
    </div>
  );
}

/** Read tips aloud and how loud, from the Tips settings. */
function TipSpeech({ money }: { money(n: number): string }) {
  const ch = useChannel();
  const tips = useAutosave<TipSettings>((s) => api.saveTipSettings(ch.key, s));
  const [failed, setFailed] = useState(false);
  useEffect(() => { api.tips(ch.key).then((v) => tips.reset(v.settings)).catch(() => setFailed(true)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ch.key]);
  const t = tips.value;
  if (failed) return null;
  return (
    <div className="grp">
      <div className="gr">
        <div className="gr-main"><div className="t1">Read the message aloud</div><div className="t2">{t && t.ttsMin > 0 ? `From ${money(t.ttsMin)}. ` : ''}The tipper picks a voice on your tip page</div></div>
        <div className="gr-ctl">{t ? <Switch label="Read the message aloud" on={t.tts} onChange={(v) => tips.set({ ...t, tts: v }, true)} /> : <Skel w={40} h={22} round />}</div>
      </div>
      <div className="gr">
        <div className="gr-main"><div className="t1">Voice volume</div></div>
        <div className="gr-ctl">{t ? <Range label="Voice volume" value={t.ttsVolume} disabled={!t.tts} onChange={(v) => tips.set({ ...t, ttsVolume: v })} /> : <Skel w={150} h={16} />}</div>
      </div>
      <div className="gr">
        <div className="gr-main"><div className="t1">Voices, filters and timing</div></div>
        <div className="gr-ctl"><Link className="btn sm" href="/app/tips">Open Tips</Link></div>
      </div>
    </div>
  );
}

/** One chat alert group's messages, each with its switch and variables. */
function ChatGroupEditor({ group, chat, onChat, titled }: {
  group: ChatAlertGroup; chat: ChatAlertSettings; onChat(s: ChatAlertSettings | ((s: ChatAlertSettings) => ChatAlertSettings)): void; titled?: boolean;
}) {
  const setAlert = (id: string, patch: Partial<{ enabled: boolean; message: string }>) =>
    onChat((s) => ({ ...s, alerts: { ...s.alerts, [id]: { ...s.alerts[id], ...patch } } }));
  const setNum = (patch: Partial<ChatAlertSettings>) => onChat((s) => ({ ...s, ...patch }));
  return (
    <div className="stack">
      {titled && <h3 className="lbl">{group.title}</h3>}
      {group.alerts.map((a) => <ChatMessage key={a.id} info={a} alert={chat.alerts[a.id]} many={group.alerts.length > 1} onChange={(p) => setAlert(a.id, p)} />)}
      {group.id === 'raids' && <NumRow label="Fewest raiders" value={chat.raidMin} max={1_000_000} onChange={(n) => setNum({ raidMin: n })} />}
      {group.id === 'bits' && <NumRow label="Fewest bits" value={chat.bitsMin} max={1_000_000} onChange={(n) => setNum({ bitsMin: n })} />}
      {group.id === 'streaks' && <NumRow label="Fewest streams in a row" value={chat.watchStreakMin} max={10_000} onChange={(n) => setNum({ watchStreakMin: n })} />}
      {group.id === 'charity' && (
        <div className="grp">
          <div className="gr">
            <div className="gr-main"><label className="t1" htmlFor="charity-min">Smallest donation</label><div className="t2">In US dollars</div></div>
            <div className="gr-ctl"><AmountField id="charity-min" value={chat.charityMin} money="USD" onChange={(n) => setNum({ charityMin: n })} /></div>
          </div>
        </div>
      )}
      {group.id === 'ads' && (
        <div className="grp">
          <div className="gr">
            <div className="gr-main"><div className="t1">Automated ad breaks</div><div className="t2">Also announce the ads Twitch runs on your schedule</div></div>
            <div className="gr-ctl"><Switch label="Automated ad breaks" on={chat.adAutomatic} onChange={(v) => setNum({ adAutomatic: v })} /></div>
          </div>
        </div>
      )}
    </div>
  );
}

const MAX_CHAT = 500;
function ChatMessage({ info, alert, many, onChange }: {
  info: ChatAlertInfo; alert?: { enabled: boolean; message: string }; many: boolean; onChange(p: Partial<{ enabled: boolean; message: string }>): void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  if (!alert) return null;
  const id = 'chat-msg-' + info.id;
  const used = [...alert.message].length;
  const insert = (v: string) => {
    const el = box.current;
    const text = `\${${v}}`;
    if (!el) return onChange({ message: alert.message + text });
    const start = el.selectionStart ?? alert.message.length;
    const end = el.selectionEnd ?? start;
    onChange({ message: alert.message.slice(0, start) + text + alert.message.slice(end) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
  };
  return (
    <div className="grp chat-msg">
      <div className="gr">
        <div className="gr-main"><label className="t1" htmlFor={id}>{many ? info.label : 'Message'}</label></div>
        <div className="gr-ctl">
          {alert.message !== info.default && <button className="btn sm ghost" type="button" onClick={() => onChange({ message: info.default })}><Icon id="undo" />Default</button>}
          <Switch label={`${info.label} in chat`} on={alert.enabled} onChange={(v) => onChange({ enabled: v })} />
        </div>
      </div>
      <div className="chat-msg-body">
        <textarea id={id} ref={box} className="input" rows={2} maxLength={MAX_CHAT} value={alert.message}
          onChange={(e) => onChange({ message: e.target.value.replace(/[\r\n]+/g, ' ') })} />
        <div className="chat-msg-foot">
          <span className="vars" aria-label="Insert a variable">
            {info.variables.map((v) => <button key={v} type="button" className="var" onClick={() => insert(v)}>{`\${${v}}`}</button>)}
          </span>
          <span className={'faint mono count' + (used > MAX_CHAT ? ' over' : '')}>{used}/{MAX_CHAT}</span>
        </div>
      </div>
    </div>
  );
}

function NumRow({ label, value, max, onChange }: { label: string; value: number; max: number; onChange(n: number): void }) {
  const id = 'num-' + label.replace(/\W+/g, '-').toLowerCase();
  return (
    <div className="grp">
      <div className="gr">
        <div className="gr-main"><label className="t1" htmlFor={id}>{label}</label></div>
        <div className="gr-ctl"><AmountField id={id} value={value} max={max} onChange={onChange} /></div>
      </div>
    </div>
  );
}

/** A number box that saves when you leave it or press Enter. */
export function AmountField({ id, value, money, max = 1_000_000, onChange }: {
  id: string; value: number; money?: string | null; max?: number; onChange(n: number): void;
}) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => setText(value ? String(value) : ''), [value]);
  const commit = () => {
    const raw = Number(text.replace(/[^\d.]/g, ''));
    const n = money ? Math.round(raw * 100) / 100 : Math.round(raw);
    const v = Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : value;
    setText(v ? String(v) : '');
    if (v !== value) onChange(v);
  };
  const sign = money ? new Intl.NumberFormat(undefined, { style: 'currency', currency: money }).formatToParts(0).find((p) => p.type === 'currency')?.value : null;
  const input = (
    <input id={id} className="input amount" type="text" inputMode={money ? 'decimal' : 'numeric'} value={text} placeholder="Any"
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  );
  return sign ? <span className="prefixed amount-wrap">{sign}{input}</span> : input;
}

/** A 0 to 100 slider with its value. */
export function Range({ label, value, disabled, onChange }: { label: string; value: number; disabled?: boolean; onChange(n: number): void }) {
  return (
    <span className="slider">
      <input type="range" min={0} max={100} step={5} aria-label={label} value={value} disabled={disabled}
        style={{ '--p': value + '%' } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mono faint">{value}%</span>
    </span>
  );
}

/** Choose an uploaded sound or image, upload a new one, or delete one. */
function MediaPick({ what, id, value, files, volume, onPick, onUpload, onDelete }: {
  what: 'sound' | 'image'; id: string; value?: string; files: MediaFile[] | null; volume: number;
  onPick(v: string | undefined): void; onUpload(f: File): Promise<MediaFile | null>; onDelete(id: string): Promise<void>;
}) {
  const ch = useChannel();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const play = () => {
    if (!value) return;
    const a = new Audio(mediaUrl(ch.key, value));
    a.volume = volume / 100;
    void a.play().catch(() => {});
  };
  return (
    <span className="media-pick">
      {what === 'sound' && value && <button className="icon-btn" type="button" aria-label="Play the sound" title="Play" onClick={play}><Icon id="play" /></button>}
      {value && (
        <ArmedButton className="sm icon bare" armedText="Delete?" onConfirm={() => void onDelete(value)}>
          <Icon id="trash" />
        </ArmedButton>
      )}
      <select id={id} className="select sm" value={value ?? ''} disabled={!files} onChange={(e) => onPick(e.target.value || undefined)}>
        <option value="">None</option>
        {(files ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <button className="btn sm" type="button" disabled={busy} onClick={() => input.current?.click()} title={what === 'sound' ? 'MP3, OGG or WAV, up to 3 MB' : 'PNG, JPG, GIF or WebP, up to 3 MB'}>
        <Icon id="upload" />{busy ? 'Uploading' : 'Upload'}
      </button>
      <input ref={input} type="file" hidden
        accept={what === 'sound' ? 'audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav' : 'image/png,image/jpeg,image/gif,image/webp'}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          const added = await onUpload(f);
          setBusy(false);
          if (added) onPick(added.id);
        }} />
    </span>
  );
}

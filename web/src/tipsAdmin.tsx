// The dashboard's Tips page (/app/tips). Tabs keep it short: incoming tips,
// the tip page itself (a live preview you click to change pictures),
// protection rules, text to speech and payouts. Saves as you go.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, mediaUrl, type MediaFile, type Tip, type TipSettings, type TipsView } from './api';
import { useChannel } from './channel';
import { ImageEditor, type ImageKind } from './imageEditor';
import { countryName, methodName, money } from './tips';
import { PageHead } from './pages';
import { ArmedButton, errorText, Gate, Icon, SaveState, Seg as UiSeg, Sect, SkelCard, Switch as UiSwitch, Tile, useAutosave, useToast } from './ui';
import { useDemo, VoiceGrid } from './voices';
import { Select } from './dropdown';
import { createPortal } from 'react-dom';



const STATUS: Record<Tip['status'], [string, string]> = {
  held: ['Waiting', 'var(--warn)'],
  shown: ['Shown', 'var(--ok)'],
  rejected: ['Turned back', 'var(--faint)'],
  refunded: ['Refunded', 'var(--faint)'],
  disputed: ['Disputed', 'var(--danger)'],
  failed: ['Failed', 'var(--faint)'],
};

const SWATCHES = ['#070606', '#0f1115', '#14161f', '#1a1222', '#10201a', '#221612', '#f6f4f2', '#e9eef5'];

type Tab = 'tips' | 'page' | 'safety' | 'voice' | 'stripe';
type Act = 'approve' | 'reject' | 'refund' | 'block' | 'unblock';
type Target = 'avatar' | 'banner' | 'background';

function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

export function TipsPage() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<TipsView | null>(null);
  const tips = useAutosave<TipSettings>((d) => api.saveTipSettings(ch.key, d).then((s) => { setView((v) => v && { ...v, settings: s }); return s; }));
  const draft = tips.value;
  const loaded = useRef('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState('');
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [twitchBanner, setTwitchBanner] = useState('');
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(location.search).get('tab');
    return (['tips', 'page', 'safety', 'voice', 'stripe'] as Tab[]).includes(t as Tab) ? (t as Tab) : 'tips';
  });

  const load = useCallback(() => {
    api.tips(ch.key).then((v) => {
      setView(v);
      if (loaded.current !== ch.key) { loaded.current = ch.key; tips.reset(v.settings); }
      setCountry((c) => c || v.account?.country || (v.countries.includes('US') ? 'US' : v.countries[0]));
    }).catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch.key]);

  useEffect(() => {
    load();
    // Held tips change from Stripe's side: keep the list fresh while open.
    const t = setInterval(load, 15000);
    if (new URLSearchParams(location.search).has('stripe')) history.replaceState(null, '', location.pathname);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (ch.can.own) api.media(ch.key).then(setFiles).catch(() => {});
  }, [ch.key, ch.can.own]);

  // The Twitch offline image, the default banner (the public page knows it).
  useEffect(() => {
    if (ch.login) api.publicTip(ch.login).then((p) => setTwitchBanner(p.banner || '')).catch(() => {});
  }, [ch.login]);

  const set = (p: Partial<TipSettings>) => tips.set((d) => ({ ...d, ...p }));

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await api.connectStripe(ch.key, country);
      location.href = url;
    } catch (x) {
      toast(errorText(x), true);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnectStripe(ch.key);
      load();
      toast('Stripe is no longer connected');
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  const act = async (t: Tip, action: Act) => {
    try {
      const next = await api.tipAction(ch.key, t.id, action);
      setView((v) => v && { ...v, tips: v.tips.map((x) => (x.id === t.id ? next : x)) });
      toast({ approve: 'Tip sent to the stream', reject: 'Tip refunded', refund: 'Tip refunded', block: 'Tipper blocked here', unblock: 'Tipper unblocked' }[action]);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const upload = async (f: File) => {
    try {
      const added = await api.uploadMedia(ch.key, f);
      setFiles((x) => [added, ...x]);
      return added;
    } catch (x) {
      toast(errorText(x), true);
      return null;
    }
  };

  const pick = (t: Tab) => {
    setTab(t);
    const u = new URL(location.href);
    u.searchParams.set('tab', t);
    history.replaceState(null, '', u.pathname + u.search);
  };

  const acct = view?.account;
  const held = view?.tips.filter((t) => t.status === 'held') ?? [];
  const recent = view?.tips.filter((t) => t.status !== 'held') ?? [];
  const status = !acct ? ['Not connected', 'var(--faint)'] : acct.chargesEnabled ? ['Taking tips', 'var(--ok)'] : ['Setup not finished', 'var(--warn)'];
  if (acct?.chargesEnabled && draft && !draft.enabled) status.splice(0, 2, 'Paused', 'var(--faint)');

  return (
    <div className="page ta">
      <PageHead title="Tips" desc="Your own tip page. Viewers pay by card, and the money goes straight to your Stripe account.">
        <SaveState saving={tips.saving} savedAt={tips.savedAt} canUndo={tips.canUndo} onUndo={tips.undo} />
        {acct?.chargesEnabled && view?.pageUrl && <a className="btn" href={view.pageUrl} target="_blank" rel="noreferrer"><Icon id="external" />Open tip page</a>}
      </PageHead>
      <div className="grp link-card">
        <Tile icon="link" />
        <div className="gr-main">
          <div className="t1 mono">{view?.pageUrl && acct?.chargesEnabled ? view.pageUrl.replace(/^https?:\/\//, '') : 'Your tip page'}</div>
          <div className="t2">{!view ? '\u00a0' : status[0]}{view?.testMode ? '. Test mode, so no real money moves and tips stay out of your stats' : acct?.chargesEnabled && draft?.enabled ? '. Put it in your panels and chat commands' : ''}</div>
        </div>
        <div className="link-ctl">
          {acct?.chargesEnabled && view?.pageUrl && (
            <button className="btn sm primary" type="button" onClick={() => { void navigator.clipboard.writeText(view.pageUrl!).then(() => toast('Link copied'), () => toast('Could not copy the link.', true)); }}><Icon id="copy" />Copy link</button>
          )}
        </div>
      </div>

      {failed && !view && <div className="notice">Could not load tips. Refresh to try again.</div>}
      {!view && !failed && <SkelCard rows={4} />}

      {view && draft && <>
        {!view.platformReady && <p className="notice">Tips are almost ready. Sylva is finishing its own Stripe setup.</p>}

        {!acct && (
          <section className="grp ta-hero">
            <div>
              <h2>Take tips with your own Stripe account</h2>
              <p>Viewers pay with cards, Apple Pay, Google Pay and local methods from around the world. Money goes straight to you. Sylva never holds it and takes no cut.</p>
            </div>
            <Gate on={ch.can.own} className="ta-connect">
              <Select className="ta-select" label="Where you live" value={country} onChange={setCountry}
                options={[...view.countries].sort((a, b) => countryName(a).localeCompare(countryName(b))).map((c) => ({ value: c, label: countryName(c) }))} />
              <button className="btn primary" type="button" disabled={busy || !view.platformReady} onClick={() => void connect()}>Connect Stripe</button>
            </Gate>
          </section>
        )}

        {acct && !acct.chargesEnabled && (
          <section className="grp ta-hero">
            <div>
              <h2>{acct.detailsSubmitted ? 'Stripe is checking your details' : 'Finish your Stripe setup'}</h2>
              <p>
                {acct.detailsSubmitted ? 'Tips open as soon as Stripe is done.' : 'Stripe needs a few more details before tips can open.'}
                {acct.stripeStatus && ` Card payments are ${acct.stripeStatus}${acct.reasons?.length ? ` (${acct.reasons.join(', ').replace(/_/g, ' ')})` : ''}.`}
                {acct.needs && acct.needs.length > 0 && ` Still needed: ${acct.needs.join(', ').replace(/_/g, ' ')}.`}
              </p>
            </div>
            {ch.can.own && <button className="btn primary" type="button" disabled={busy} onClick={() => void connect()}>{acct.detailsSubmitted ? 'Check with Stripe' : 'Finish setup'}</button>}
          </section>
        )}

        <div className="ta-tabs">
          <UiSeg<Tab> label="Tips sections" options={([['tips', 'Tips'], ['page', 'Tip page'], ['safety', 'Protection'], ['voice', 'Voice'], ['stripe', 'Payouts']] as [Tab, string][]).map(([id, label]) => ({
            id, label: <>{label}{id === 'tips' && held.length > 0 && <span className="ta-count">{held.length}</span>}</>,
          }))} value={tab} onChange={pick} />
        </div>

        {tab === 'tips' && (
          <div className="ta-stack">
            {held.length > 0 && (
              <Sect title="Waiting for you" desc="Paid, not shown yet. Send them to the stream or refund them in full.">
                <ul className="ta-tips">{held.map((t) => <TipItem key={t.id} t={t} canMod={ch.can.moderate} canEdit={ch.can.edit} act={act} />)}</ul>
              </Sect>
            )}
            <Sect title="Recent">
              {recent.length === 0
                ? <p className="ta-empty">No tips yet. Share your tip page link to get the first one.</p>
                : <ul className="ta-tips">{recent.map((t) => <TipItem key={t.id} t={t} canMod={ch.can.moderate} canEdit={ch.can.edit} act={act} />)}</ul>}
            </Sect>
          </div>
        )}

        {tab === 'page' && (
          <Gate on={ch.can.own}>
            <PageTab draft={draft} set={set} files={files} upload={upload} channel={ch.key} name={ch.name} twitchAvatar={ch.avatar} twitchBanner={twitchBanner} currencies={view.currencies} />
          </Gate>
        )}

        {tab === 'safety' && (
          <Gate on={ch.can.own}>
            <Sect title="Chargeback protection" desc="Every card tip asks for 3D Secure. Bank debits, buy now pay later and PayPal are never offered. Anyone who disputes a tip on any Sylva channel can't tip anywhere on Sylva again.">
              <Row label="Hold tips before they show">
                <Seg value={draft.hold} onChange={(v) => set({ hold: v })} options={[['approve', 'Until I approve'], ['delay', 'For a delay'], ['off', 'Never']]} />
              </Row>
              {draft.hold === 'delay' && (
                <Row label="Delay" hint="Then the tip shows on its own.">
                  <NumField value={draft.delaySeconds} step={1} suffix="sec" onChange={(n) => set({ delaySeconds: Math.round(n) })} />
                </Row>
              )}
              {draft.hold !== 'off' && <>
                <Row label="Hold tips of at least" hint="0 holds no tip for its size.">
                  <NumField value={draft.holdOver} suffix={draft.currency} onChange={(n) => set({ holdOver: n })} />
                </Row>
                <Row label="Hold someone's first tip"><Switch on={draft.holdFirst} label="Hold someone's first tip" set={(v) => set({ holdFirst: v })} /></Row>
                <Row label="Hold card tips the bank did not verify"><Switch on={draft.holdUnverified} label="Hold card tips the bank did not verify" set={(v) => set({ holdUnverified: v })} /></Row>
              </>}
              <Row label="Card from another country than the viewer">
                <Seg value={draft.mismatch} onChange={(v) => set({ mismatch: v })} options={[['block', 'Refuse'], ['hold', 'Hold'], ['allow', 'Allow']]} />
              </Row>
              <Row label="Refund when the bank warns of fraud" hint="Stops most chargebacks before they happen. Stripe keeps its fee.">
                <Switch on={draft.refundOnWarning} label="Refund when the bank warns of fraud" set={(v) => set({ refundOnWarning: v })} />
              </Row>
              <Row label="Answer disputes on their own" hint="Sends Stripe the message, times, IP country, 3D Secure result and a clip.">
                <Switch on={draft.autoEvidence} label="Answer disputes on their own" set={(v) => set({ autoEvidence: v })} />
              </Row>
            </Sect>
          </Gate>
        )}

        {tab === 'voice' && (
          <Gate on={ch.can.own}>
            <Sect title="Text to speech" desc="Tips are read aloud on your overlay after the alert sound, in the voice the tipper picked. Links are never read.">
              <Row label="Read tips aloud"><Switch on={draft.tts} label="Read tips aloud" set={(v) => set({ tts: v })} /></Row>
              <Row label="Only tips of at least"><NumField value={draft.ttsMin} suffix={draft.currency} onChange={(n) => set({ ttsMin: n })} /></Row>
            </Sect>
            <SpeechSettings draft={draft} set={set} />
            <Sect title="Voices">
              <VoiceSettings view={view} draft={draft} set={set} />
            </Sect>
          </Gate>
        )}

        {tab === 'stripe' && (
          <Sect title="Stripe account" desc="Payouts, receipts and taxes live in your Stripe dashboard.">
            {acct ? <>
              <Row label="Status"><span className="muted">{acct.chargesEnabled ? 'Card payments on' : 'Not ready yet'}</span></Row>
              <Row label="Country"><span className="ta-value">{countryName(acct.country)}</span></Row>
              <Row label="Account"><span className="ta-value mono">{acct.id}</span></Row>
              {acct.chargesEnabled && acct.due > 0 && (
                <Row label="Stripe needs more details" hint="Payouts may pause until you add them.">
                  {ch.can.own && <button className="btn sm" type="button" disabled={busy} onClick={() => void connect()}>Update in Stripe</button>}
                </Row>
              )}
              <Row label="Dashboard"><a className="btn sm" href="https://dashboard.stripe.com" target="_blank" rel="noreferrer"><Icon id="external" />Open Stripe</a></Row>
              {ch.can.own && (
                <Row label="Disconnect" hint="Closes your tip page. Your Stripe account and its money are untouched.">
                  <ArmedButton className="sm danger" armedText="Click again to disconnect" disabled={busy} onConfirm={() => void disconnect()}>Disconnect</ArmedButton>
                </Row>
              )}
            </> : <p className="ta-empty">Not connected yet.</p>}
          </Sect>
        )}

      </>}
    </div>
  );
}

/* ---------------- The Tip page tab ---------------- */

function PageTab({ draft, set, files, upload, channel, name, twitchAvatar, twitchBanner, currencies }: {
  draft: TipSettings; set(p: Partial<TipSettings>): void; files: MediaFile[]; upload(f: File): Promise<MediaFile | null>;
  channel: string; name: string; twitchAvatar: string; twitchBanner: string; currencies: string[];
}) {
  const [menu, setMenu] = useState<{ target: Target; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ file: File; kind: ImageKind; target: Target } | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<Target>('avatar');
  const images = files.filter((f) => /\.(png|jpg|gif|webp)$/.test(f.id));
  const file = (id: string) => (id && id !== 'none' ? mediaUrl(channel, id) : '');

  const avatar = file(draft.avatar) || twitchAvatar;
  const banner = draft.banner === 'none' ? '' : file(draft.banner) || twitchBanner;
  const bg = file(draft.background);

  const open = (target: Target, e: { currentTarget: Element; clientX?: number; clientY?: number }) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ target, x: Math.min(r.left + 12, window.innerWidth - 300), y: Math.min(r.top + 12, window.innerHeight - 340) });
  };
  const choose = (target: Target, value: string) => {
    set(target === 'avatar' ? { avatar: value } : target === 'banner' ? { banner: value } : { background: value });
    setMenu(null);
  };
  const kindFor = (t: Target): ImageKind => (t === 'avatar' ? 'avatar' : t === 'banner' ? 'banner' : draft.bgTile ? 'tile' : 'fill');

  const done = async (blob: Blob) => {
    if (!editing) return;
    setSaving(true);
    const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'webp';
    const added = await upload(new File([blob], `${editing.target}.${ext}`, { type: blob.type }));
    setSaving(false);
    if (added) {
      choose(editing.target, added.id);
      setEditing(null);
    }
  };

  const stage: CSSProperties = { backgroundColor: draft.bgColor || undefined };
  if (bg) {
    stage.backgroundImage = `url("${bg}")`;
    stage.backgroundRepeat = draft.bgTile ? 'repeat' : 'no-repeat';
    stage.backgroundSize = draft.bgTile ? `${draft.tileSize * 0.75}px ${draft.tileSize * 0.75}px` : 'cover';
    stage.backgroundPosition = draft.bgTile ? 'center top' : 'center';
  }
  const amounts = draft.suggested.length ? draft.suggested : [5];

  return (
    <div className="ta-page">
      <div className="ta-preview-col">
        <div className="tp-stage" style={stage} onClick={(e) => { if (e.target === e.currentTarget) open('background', e); }}>
          <button type="button" className="tp-bg-btn" onClick={(e) => open('background', e)}><Icon id="image" />Background</button>
          <div className="tp-card">
            <button type="button" className={'tp-banner' + (banner ? '' : ' empty')} style={banner ? { backgroundImage: `url("${banner}")` } : undefined} onClick={(e) => open('banner', e)} aria-label="Change the banner">
              <span className="tp-hover"><Icon id="image" />{banner ? 'Change banner' : 'Add a banner'}</span>
            </button>
            <div className="tp-who">
              <button type="button" className="tp-avatar" onClick={(e) => open('avatar', e)} aria-label="Change the picture">
                {avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : <span>{(name || '?').charAt(0).toUpperCase()}</span>}
                <span className="tp-cam"><Icon id="camera" /></span>
              </button>
              <b>{name}</b>
            </div>
            <p className={'tp-note' + (draft.note ? '' : ' empty')}>{draft.note || 'Your note shows here'}</p>
            <div className="tp-body" aria-hidden="true">
              <div className="tp-row"><span>Amount</span><span className="tp-chip">{draft.currency}</span></div>
              <div className="tp-amounts">
                {[...amounts.slice(0, 5), 0].map((a, i) => <span key={i} className={'tp-amt' + (i === Math.min(1, amounts.length - 1) ? ' on' : '')}>{a ? money(a, draft.currency).replace(/\.00$/, '') : 'Other'}</span>)}
              </div>
              <span className="tp-field">Name</span>
              <span className="tp-field tall">Message</span>
              <span className="tp-pay"><Icon id="tip" />Card, Apple Pay, Google Pay and local methods</span>
              <span className="tp-submit">Tip {money(amounts[Math.min(1, amounts.length - 1)], draft.currency).replace(/\.00$/, '')}</span>
            </div>
          </div>
        </div>
        <p className="ta-caption">Click the picture, banner or background to change them.</p>
      </div>

      <div className="ta-stack">
        <Sect title="Look">
          <Row label="Note" hint="Shown under your name." stack>
            <textarea className="ta-input ta-textarea" rows={2} maxLength={300} value={draft.note} placeholder="Thanks for supporting the stream!" onChange={(e) => set({ note: e.target.value })} />
          </Row>
          <Row label="Background colour" stack>
            <div className="ta-swatches">
              <button type="button" className={'ta-swatch auto' + (draft.bgColor ? '' : ' on')} title="Default" aria-label="Default colour" onClick={() => set({ bgColor: '' })} />
              {SWATCHES.map((c) => <button key={c} type="button" className={'ta-swatch' + (draft.bgColor === c ? ' on' : '')} style={{ background: c }} title={c} aria-label={c} onClick={() => set({ bgColor: c })} />)}
              <label className={'ta-swatch custom' + (draft.bgColor && !SWATCHES.includes(draft.bgColor) ? ' on' : '')} title="Pick any colour" style={draft.bgColor && !SWATCHES.includes(draft.bgColor) ? { background: draft.bgColor } : undefined}>
                <Icon id="plus" />
                <input type="color" aria-label="Pick any colour" value={draft.bgColor || '#0b0a0a'} onChange={(e) => set({ bgColor: e.target.value })} />
              </label>
            </div>
          </Row>
          {bg && <>
            <Row label="Background image">
              <Seg value={draft.bgTile ? 'tile' : 'fill'} onChange={(v) => set({ bgTile: v === 'tile' })} options={[['tile', 'Tile'], ['fill', 'Fill']]} />
            </Row>
            {draft.bgTile && (
              <Row label="Tile size" stack>
                <div className="ta-range">
                  <input type="range" min={16} max={512} step={4} value={Math.min(draft.tileSize, 512)} onChange={(e) => set({ tileSize: Number(e.target.value) })} />
                  <span className="ta-value">{draft.tileSize} px</span>
                </div>
              </Row>
            )}
          </>}
        </Sect>

        <Sect title="Amounts" desc="Viewers paying in another currency see these converted and rounded.">
          <Row label="Take tips"><Switch on={draft.enabled} label="Take tips" set={(v) => set({ enabled: v })} /></Row>
          <Row label="Your currency">
            <Select className="ta-select" label="Currency" value={draft.currency} onChange={(v) => set({ currency: v })}
              options={currencies.map((c) => ({ value: c, label: c }))} />
          </Row>
          <Row label="Buttons" hint="Up to 6 amounts." stack>
            <AmountChips values={draft.suggested} currency={draft.currency} onChange={(v) => set({ suggested: v })} />
          </Row>
          <Row label="Smallest tip"><NumField value={draft.min} suffix={draft.currency} onChange={(n) => set({ min: n })} /></Row>
          <Row label="Largest tip"><NumField value={draft.max} suffix={draft.currency} onChange={(n) => set({ max: n })} /></Row>
        </Sect>
      </div>

      {menu && (
        <ImageMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          title={menu.target === 'avatar' ? 'Picture' : menu.target === 'banner' ? 'Banner' : 'Background'}
          defaults={menu.target === 'avatar' ? [['', 'Twitch picture']] : menu.target === 'banner' ? [['', 'Twitch offline image'], ['none', 'No banner']] : [['', 'No image']]}
          value={menu.target === 'avatar' ? draft.avatar : menu.target === 'banner' ? draft.banner : draft.background}
          images={images} channel={channel}
          onPick={(v) => choose(menu.target, v)}
          onUpload={() => { pending.current = menu.target; setMenu(null); fileInput.current?.click(); }} />
      )}
      <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) setEditing({ file: f, kind: kindFor(pending.current), target: pending.current });
      }} />
      {editing && <ImageEditor file={editing.file} kind={editing.kind} busy={saving} onCancel={() => setEditing(null)} onDone={(b) => void done(b)} />}
    </div>
  );
}

function ImageMenu({ x, y, title, defaults, value, images, channel, onPick, onUpload, onClose }: {
  x: number; y: number; title: string; defaults: [string, string][]; value: string; images: MediaFile[]; channel: string;
  onPick(v: string): void; onUpload(): void; onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('mousedown', down));
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="ta-menu" role="dialog" aria-label={title} style={{ left: x, top: y }}>
      <div className="ta-menu-title">{title}</div>
      <button type="button" className="ta-menu-item" onClick={onUpload}><Icon id="upload" />Upload and edit</button>
      {defaults.map(([v, t]) => (
        <button key={v} type="button" className={'ta-menu-item' + (value === v ? ' on' : '')} onClick={() => onPick(v)}>
          {value === v ? <Icon id="check" /> : <span className="ta-menu-gap" />}{t}
        </button>
      ))}
      {images.length > 0 && <>
        <div className="ta-menu-title">Your images</div>
        <div className="ta-thumbs">
          {images.map((f) => (
            <button key={f.id} type="button" className={'ta-thumb' + (value === f.id ? ' on' : '')} title={f.name} aria-label={f.name} onClick={() => onPick(f.id)}>
              <img src={mediaUrl(channel, f.id)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </>}
    </div>,
    document.body,
  );
}

/* ---------------- Building blocks ---------------- */


const TTS_FULL = '{name} tipped {amount}. {message}';
const TTS_MESSAGE = '{message}';

/** What is read for a sample tip, as the server reads it. */
function sampleSpeech(d: TipSettings) {
  const fold = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const blocked = (w: string) => { const f = fold(w); return !!f && d.ttsWords.some((b) => f.includes(b)); };
  let words = 'Love the stream, you earned a snack!'.split(' ');
  if (words.some(blocked)) words = d.ttsWordMode === 'skip' ? [] : words.filter((w) => !blocked(w));
  let msg = '';
  for (const w of words) {
    if ((msg ? msg.length + 1 : 0) + w.length > d.ttsMaxChars) { if (!msg) msg = w.slice(0, d.ttsMaxChars); break; }
    msg += (msg ? ' ' : '') + w;
  }
  const out = (d.ttsTemplate.trim() || TTS_FULL)
    .split('{name}').join('Ann').split('{amount}').join(d.currency === 'USD' ? '5 dollars' : `5 ${d.currency}`).split('{message}').join(msg)
    .split(/\s+/).filter(Boolean).join(' ');
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}

/** What is read, how loud and when, and which words are never read. */
function SpeechSettings({ draft, set }: { draft: TipSettings; set(p: Partial<TipSettings>): void }) {
  const mode = draft.ttsTemplate === TTS_FULL ? 'full' : draft.ttsTemplate === TTS_MESSAGE ? 'message' : 'custom';
  const [template, setTemplate] = useState(draft.ttsTemplate);
  useEffect(() => setTemplate(draft.ttsTemplate), [draft.ttsTemplate]);
  const [words, setWords] = useState(draft.ttsWords.join(', '));
  useEffect(() => setWords(draft.ttsWords.join(', ')), [draft.ttsWords]);
  const commitWords = () => {
    const list = [...new Set(words.split(/[,\n]/).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean))];
    if (list.join() !== draft.ttsWords.join()) set({ ttsWords: list });
    else setWords(draft.ttsWords.join(', '));
  };
  const commitTemplate = (t: string) => { const v = t.trim() || TTS_FULL; setTemplate(v); if (v !== draft.ttsTemplate) set({ ttsTemplate: v }); };
  const insert = (tag: string) => commitTemplate(`${template.trim()} ${tag}`);
  const sample = sampleSpeech(draft);
  return <>
    <Sect title="What's read">
      <Row label="Read">
        <Seg value={mode} onChange={(v) => {
          if (v === 'full') set({ ttsTemplate: TTS_FULL });
          else if (v === 'message') set({ ttsTemplate: TTS_MESSAGE });
          else set({ ttsTemplate: draft.ttsTemplate === TTS_FULL ? '{name} says {message}' : draft.ttsTemplate === TTS_MESSAGE ? '{name}: {message}' : draft.ttsTemplate });
        }} options={[['full', 'Name, amount and message'], ['message', 'Message only'], ['custom', 'Custom']]} />
      </Row>
      {mode === 'custom' && (
        <Row label="Custom text" hint="Fill in {name}, {amount} and {message}." stack>
          <div className="ta-tts-template">
            <input className="ta-input" value={template} maxLength={200} aria-label="Custom text"
              onChange={(e) => setTemplate(e.target.value)} onBlur={() => commitTemplate(template)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTemplate(template); } }} />
            {['{name}', '{amount}', '{message}'].map((t) => <button key={t} type="button" className="btn sm" onClick={() => insert(t)}>{t}</button>)}
          </div>
        </Row>
      )}
      <Row label="Longest message read" stack>
        <div className="ta-range">
          <input type="range" min={20} max={500} step={10} value={draft.ttsMaxChars} aria-label="Longest message read" onChange={(e) => set({ ttsMaxChars: Number(e.target.value) })} />
          <span className="ta-value">{draft.ttsMaxChars} chars</span>
        </div>
      </Row>
      <Row label="Example" hint="For a 5 tip from Ann that says “Love the stream, you earned a snack!”" stack>
        <p className="ta-tts-sample">{sample ? `“${sample}”` : 'Nothing is read.'}</p>
      </Row>
    </Sect>
    <Sect title="Playback">
      <Row label="Voice volume" hint="Separate from the alert sound." stack>
        <div className="ta-range">
          <input type="range" min={0} max={100} step={5} value={draft.ttsVolume} aria-label="Voice volume" onChange={(e) => set({ ttsVolume: Number(e.target.value) })} />
          <span className="ta-value">{draft.ttsVolume}%</span>
        </div>
      </Row>
      <Row label="Wait after the alert sound" hint="Before the message is read." stack>
        <div className="ta-range">
          <input type="range" min={0} max={10000} step={500} value={draft.ttsDelayMs} aria-label="Wait after the alert sound" onChange={(e) => set({ ttsDelayMs: Number(e.target.value) })} />
          <span className="ta-value">{(draft.ttsDelayMs / 1000).toFixed(1)} s</span>
        </div>
      </Row>
    </Sect>
    <Sect title="Word filter" desc="Words that are never read aloud. Parts of words count, so “darn” also catches “darnit”. A tipper's name with one of them is read as “Someone”.">
      <Row label="Words" hint="Separate them with commas." stack>
        <textarea className="ta-input ta-tts-words" rows={3} value={words} placeholder="word, another word" aria-label="Filtered words"
          onChange={(e) => setWords(e.target.value)} onBlur={commitWords} />
      </Row>
      <Row label="When a message has one">
        <Seg value={draft.ttsWordMode} onChange={(v) => set({ ttsWordMode: v })} options={[['remove', 'Leave the word out'], ['skip', 'Skip the message']]} />
      </Row>
    </Sect>
  </>;
}

/** The default voice and the voices tippers can pick. */
function VoiceSettings({ view, draft, set }: { view: TipsView; draft: TipSettings; set(p: Partial<TipSettings>): void }) {
  const demo = useDemo();
  const all = view.voices.map((v) => v.id);
  const allowed = draft.ttsVoices.length ? draft.ttsVoices : all;
  const pickable = view.voices.filter((v) => allowed.includes(v.id));
  const allow = (ids: string[]) => {
    if (!ids.length) return;
    const sorted = all.filter((id) => ids.includes(id));
    set({
      ttsVoices: sorted.length === all.length ? [] : sorted,
      ttsVoice: sorted.includes(draft.ttsVoice) ? draft.ttsVoice : sorted[0],
    });
  };
  const playing = demo.playing === draft.ttsVoice;
  return <>
    <Row label="Default voice" hint="Used when the tipper does not pick one.">
      <span className="ta-voice-default">
        <button type="button" className="vp-play" aria-label={`${playing ? 'Stop' : 'Play'} the default voice`} aria-pressed={playing} onClick={() => demo.toggle(draft.ttsVoice)}>
          <Icon id={playing ? 'pause' : 'play'} />
        </button>
        <Select className="ta-select" label="Default voice" value={draft.ttsVoice} onChange={(v) => set({ ttsVoice: v })}
          options={pickable.map((v) => ({ value: v.id, label: v.name }))} />
      </span>
    </Row>
    {!view.brianReady && (
      <p className="ta-note">Brian (Amazon Polly) is hidden from tippers until AWS lets Sylva use Polly. Tips set to Brian are read by the stand-in voice meanwhile.</p>
    )}
    <Row label="Voices tippers can pick" hint={`${allowed.length} of ${all.length} on. Press play to hear one.`} stack>
      <VoiceGrid voices={view.voices} mode="allow" value={allowed} onChange={allow} first={9} label="Voices tippers can pick" />
    </Row>
  </>;
}

function Row({ label, hint, stack, children }: { label: string; hint?: string; stack?: boolean; children: ReactNode }) {
  return (
    <div className={'gr' + (stack ? ' stack-sm' : '')}>
      <div className="gr-main"><div className="t1">{label}</div>{hint && <div className="t2">{hint}</div>}</div>
      <div className="gr-ctl">{children}</div>
    </div>
  );
}

function Switch({ on, label, set }: { on: boolean; label: string; set(v: boolean): void }) {
  return <UiSwitch label={label} on={on} onChange={set} />;
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void }) {
  return <UiSeg<T> label="Choose" small options={options.map(([id, label]) => ({ id, label }))} value={value} onChange={onChange} />;
}

function NumField({ value, suffix, step = 0.01, onChange }: { value: number; suffix?: string; step?: number; onChange(n: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    const v = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : value;
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <label className="prefixed ta-num">
      <input className="input amount" type="number" inputMode="decimal" min={0} step={step} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

function AmountChips({ values, currency, onChange }: { values: number[]; currency: string; onChange(v: number[]): void }) {
  const [text, setText] = useState('');
  const add = () => {
    const n = Math.round(Number(text) * 100) / 100;
    if (Number.isFinite(n) && n > 0 && !values.includes(n) && values.length < 6) onChange([...values, n].sort((a, b) => a - b));
    setText('');
  };
  return (
    <div className="ta-chips">
      {values.map((v) => (
        <span key={v} className="ta-amount-chip">{money(v, currency).replace(/\.00$/, '')}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><Icon id="x" /></button>
        </span>
      ))}
      {values.length < 6 && (
        <input className="ta-chip-input" type="number" inputMode="decimal" min={0} placeholder="Add" value={text} aria-label="Add an amount"
          onChange={(e) => setText(e.target.value)} onBlur={() => text && add()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
      )}
    </div>
  );
}

function TipItem({ t, canMod, canEdit, act }: { t: Tip; canMod: boolean; canEdit: boolean; act(t: Tip, a: Act): void }) {
  const [label, color] = STATUS[t.status] ?? [t.status, 'var(--faint)'];
  const facts = [
    methodName(t.method),
    t.method === 'card' ? (t.verified ? '3D Secure' : 'Not verified by the bank') : null,
    t.country ? countryName(t.country) : null,
    t.cardCountry && t.cardCountry !== t.country ? `Card from ${countryName(t.cardCountry)}` : null,
    t.risk && t.risk !== 'normal' ? `Radar: ${t.risk}` : null,
    t.email || null,
  ].filter(Boolean);
  const when = t.paidAt ?? t.createdAt;
  return (
    <li className="ta-tip">
      <span className="ta-tip-av" aria-hidden="true">{(t.name || '?').charAt(0).toUpperCase()}</span>
      <div className="ta-tip-body">
        <div className="ta-tip-top">
          <b>{t.name}</b>
          <span className="ta-tip-amt">{money(t.amount, t.currency)}</span>
          <span className="ta-tag" style={{ ['--c' as string]: color }}>{label}</span>
          {t.blocked && <span className="ta-tag" style={{ ['--c' as string]: 'var(--danger)' }}>Blocked</span>}
          {t.test && <span className="ta-tag" style={{ ['--c' as string]: 'var(--warn)' }}>Test</span>}
          <time className="ta-tip-time" dateTime={new Date(when).toISOString()} title={new Date(when).toLocaleString()}>{ago(when)}</time>
        </div>
        {t.message && <p className="ta-tip-msg">{t.message}</p>}
        {facts.length > 0 && <p className="ta-tip-meta">{facts.join(' · ')}</p>}
        {t.status === 'held' && t.holdReason && (
          <p className="ta-tip-meta">Held: {t.holdReason}.{t.releaseAt && !t.needsApproval ? ` Shows on its own at ${new Date(t.releaseAt).toLocaleTimeString()}.` : ''}</p>
        )}
        {t.status === 'disputed' && <p className="ta-tip-meta">Dispute {t.disputeStatus?.replace(/_/g, ' ') || 'open'}. {t.evidenceSent ? 'Evidence sent to Stripe.' : 'Answer it in your Stripe dashboard.'}</p>}
        {t.note && t.status !== 'held' && <p className="ta-tip-meta">{t.note}</p>}
        {t.clip && <a className="ta-tip-meta ta-tip-link" href={t.clip} target="_blank" rel="noreferrer">Clip of the moment</a>}
      </div>
      <div className="ta-tip-actions">
        {t.status === 'held' && canMod && <>
          <button className="btn primary sm" type="button" onClick={() => act(t, 'approve')}>Show it</button>
          <button className="btn sm" type="button" onClick={() => act(t, 'reject')}>Refund</button>
        </>}
        {t.status === 'shown' && canEdit && <button className="btn ghost sm" type="button" onClick={() => act(t, 'refund')}>Refund</button>}
        {canEdit && t.status !== 'failed' && (
          <button className="btn ghost sm" type="button" onClick={() => act(t, t.blocked ? 'unblock' : 'block')}>{t.blocked ? 'Unblock' : 'Block'}</button>
        )}
      </div>
    </li>
  );
}

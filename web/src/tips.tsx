// Tips. The dashboard page (/app/tips) connects the streamer's own Stripe
// account, sets limits and holds, and approves or refunds tips. The public
// page (/tip/{login}) is where viewers pay. Money goes straight to the
// streamer's Stripe account; the rules live in crates/sylva-core/src/tips.rs.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, mediaUrl, type MediaFile, type PublicTipPage, type Tip, type TipSettings, type TipsView } from './api';
import { useChannel } from './channel';
import { Card, PageHead } from './pages';
import { Link } from './router';
import { Avatar, errorText, Gate, Icon, SkelCard, SkelRows, useToast } from './ui';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const METHOD_NAMES: Record<string, string> = {
  card: 'Card', apple_pay: 'Apple Pay', google_pay: 'Google Pay', link: 'Link', ideal: 'iDEAL',
  bancontact: 'Bancontact', blik: 'BLIK', eps: 'EPS', p24: 'Przelewy24', twint: 'TWINT', swish: 'Swish',
  pix: 'Pix', promptpay: 'PromptPay', paynow: 'PayNow', grabpay: 'GrabPay', fpx: 'FPX', oxxo: 'OXXO',
  boleto: 'Boleto', konbini: 'Konbini', mobilepay: 'MobilePay',
};
const methodName = (m?: string) => (m ? METHOD_NAMES[m] || m.replace(/_/g, ' ') : '');

const STATUS: Record<Tip['status'], [string, string]> = {
  held: ['Waiting', 'var(--warn)'],
  shown: ['Shown', 'var(--ok)'],
  rejected: ['Turned back', 'var(--muted)'],
  refunded: ['Refunded', 'var(--muted)'],
  disputed: ['Disputed', 'var(--danger)'],
  failed: ['Failed', 'var(--muted)'],
};

const LANGS: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', zh: 'Chinese', jp: 'Japanese', kr: 'Korean' };

const COUNTRY_NAMES = (() => {
  try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; }
})();
const countryName = (c: string) => COUNTRY_NAMES?.of(c) || c;

/* ---------------- Dashboard ---------------- */

export function TipsPage() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<TipsView | null>(null);
  const [draft, setDraft] = useState<TipSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState('');
  const [files, setFiles] = useState<MediaFile[]>([]);

  const load = useCallback(() => {
    api.tips(ch.key).then((v) => {
      setView(v);
      setDraft((d) => d ?? v.settings);
      setCountry((c) => c || v.account?.country || (v.countries.includes('US') ? 'US' : v.countries[0]));
    }).catch(() => setFailed(true));
  }, [ch.key]);

  useEffect(() => {
    if (ch.can.own) api.media(ch.key).then(setFiles).catch(() => {});
  }, [ch.key, ch.can.own]);

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

  useEffect(() => {
    load();
    // Held tips change from Stripe's side: keep the list fresh while open.
    const t = setInterval(load, 15000);
    if (new URLSearchParams(location.search).has('stripe')) history.replaceState(null, '', location.pathname);
    return () => clearInterval(t);
  }, [load]);

  const changed = !!view && !!draft && !same(draft, view.settings);
  const set = (p: Partial<TipSettings>) => draft && setDraft({ ...draft, ...p });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const s = await api.saveTipSettings(ch.key, draft);
      setDraft(s);
      setView((v) => v && { ...v, settings: s });
      toast('Tip settings saved');
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

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
      toast('Stripe is no longer connected. Your Stripe account and its money are untouched.');
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  const act = async (t: Tip, action: 'approve' | 'reject' | 'refund' | 'block' | 'unblock') => {
    try {
      const next = await api.tipAction(ch.key, t.id, action);
      setView((v) => v && { ...v, tips: v.tips.map((x) => (x.id === t.id ? next : x)) });
      toast({ approve: 'Tip sent to the stream', reject: 'Tip refunded', refund: 'Tip refunded', block: 'Tipper blocked here', unblock: 'Tipper unblocked' }[action]);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const acct = view?.account;
  const held = view?.tips.filter((t) => t.status === 'held') ?? [];

  return (
    <div className="page">
      <PageHead title="Tips" desc="Viewers tip you on your own page with cards, wallets and local payment methods from around the world. Money goes straight to your Stripe account.">
        {view?.testMode && <span className="pill test-mode" style={{ ['--g' as string]: 'var(--warn, #d97706)' }}>Test mode</span>}
      </PageHead>
      {view?.testMode && <div className="notice"><span>Test mode. Sylva is using Stripe test keys, so tips use test cards, no real money moves, and tips stay out of your stats.</span></div>}
      {failed && !view && <Card><div className="card-body"><p className="card-text">Could not load tips. Refresh to try again.</p></div></Card>}
      {!view && !failed && <SkelCard rows={4} />}
      {view && draft && (
        <div className="stack">
          {!view.platformReady && (
            <div className="notice"><span>Tips are almost ready. Sylva is finishing its own Stripe setup, and this page will let you connect as soon as it is done.</span></div>
          )}

          <Card title="Stripe" desc={acct?.chargesEnabled ? 'Connected. Payouts, receipts and taxes are handled in your Stripe dashboard.' : 'Tips are paid into your own Stripe account. Sylva never holds your money and takes no cut.'}
            action={acct?.chargesEnabled ? <a className="btn sm" href="https://dashboard.stripe.com" target="_blank" rel="noreferrer"><Icon id="external" />Open Stripe</a> : undefined}>
            <div className="card-body stack">
              {!acct && (
                <Gate on={ch.can.own} className="tips-connect">
                  <label className="field" htmlFor="tips-country">
                    Where you live
                    <select id="tips-country" className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
                      {[...view.countries].sort((a, b) => countryName(a).localeCompare(countryName(b))).map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
                    </select>
                  </label>
                  <button className="btn primary" type="button" disabled={busy || !view.platformReady} onClick={() => void connect()}>Connect Stripe</button>
                  <span className="field-hint">Stripe asks for your details and bank account. If you already use Stripe, you can sign in to it.</span>
                </Gate>
              )}
              {acct && !acct.chargesEnabled && (
                <div className="notice">
                  <span>{acct.detailsSubmitted ? 'Stripe is checking your details. Tips open as soon as it is done.' : 'Finish your Stripe setup to start taking tips.'}
                    {acct.stripeStatus && <span className="field-hint"> Stripe says card payments are {acct.stripeStatus}{acct.reasons?.length ? ` (${acct.reasons.join(', ').replace(/_/g, ' ')})` : ''}.</span>}
                    {acct.needs && acct.needs.length > 0 && <span className="field-hint"> Still needed: {acct.needs.join(', ').replace(/_/g, ' ')}.</span>}
                  </span>
                  {ch.can.own && <button className="btn primary sm" type="button" disabled={busy} onClick={() => void connect()}>{acct.detailsSubmitted ? 'Check with Stripe' : 'Finish setup'}</button>}
                </div>
              )}
              {acct?.chargesEnabled && view.pageUrl && (
                <div className="tips-link">
                  <span className="field-hint">Your tip page</span>
                  <a href={view.pageUrl} target="_blank" rel="noreferrer">{view.pageUrl.replace(/^https?:\/\//, '')}</a>
                  <button className="btn sm" type="button" onClick={() => { void navigator.clipboard.writeText(view.pageUrl!); toast('Link copied'); }}><Icon id="copy" />Copy</button>
                </div>
              )}
              {acct?.chargesEnabled && acct.due > 0 && (
                <div className="notice"><span>Stripe needs more details from you. Payouts may pause until you add them.</span>
                  {ch.can.own && <button className="btn sm" type="button" disabled={busy} onClick={() => void connect()}>Update in Stripe</button>}
                </div>
              )}
              {acct && ch.can.own && (
                <div><button className="btn ghost sm danger" type="button" disabled={busy} onClick={() => void disconnect()}>Disconnect Stripe</button></div>
              )}
            </div>
          </Card>

          {held.length > 0 && (
            <Card title={`Waiting for you (${held.length})`} desc="These tips are paid but not shown yet. Send them to the stream, or refund them in full.">
              <ul className="tips-list">{held.map((t) => <TipRow key={t.id} t={t} canMod={ch.can.moderate} canEdit={ch.can.edit} act={act} />)}</ul>
            </Card>
          )}

          <Card title="Recent tips">
            {view.tips.filter((t) => t.status !== 'held').length === 0
              ? <p className="empty"><Icon id="tip" />No tips yet. Share your tip page in your panels and chat.</p>
              : <ul className="tips-list">{view.tips.filter((t) => t.status !== 'held').map((t) => <TipRow key={t.id} t={t} canMod={ch.can.moderate} canEdit={ch.can.edit} act={act} />)}</ul>}
          </Card>

          <Gate on={ch.can.own} className="stack">
            <Card title="Tip page" desc="Limits are in your currency. Viewers paying in another currency see them converted and rounded.">
              <div className="card-body tips-grid">
                <div className="field inline wide">
                  <span>Take tips</span>
                  <button className="switch" type="button" role="switch" aria-checked={draft.enabled} aria-label="Take tips" onClick={() => set({ enabled: !draft.enabled })} />
                </div>
                <label className="field">Your currency
                  <select className="select" value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
                    {view.currencies.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
                <Amount label="Smallest tip" value={draft.min} onChange={(n) => set({ min: n })} />
                <Amount label="Largest tip" value={draft.max} onChange={(n) => set({ max: n })} />
                <Amount label="Largest first tip" hint="Until someone has a tip here that went through." value={draft.firstMax} onChange={(n) => set({ firstMax: n })} />
                <label className="field">Suggested amounts
                  <input className="input" value={draft.suggested.join(', ')} onChange={(e) => set({ suggested: e.target.value.split(/[,\s]+/).map(Number).filter((n) => n > 0) })} />
                </label>
                <label className="field wide">Note on your page
                  <textarea className="input textarea" rows={2} maxLength={300} value={draft.note} onChange={(e) => set({ note: e.target.value })} placeholder="Thanks for supporting the stream!" />
                </label>
              </div>
            </Card>

            <Card title="Page look" desc="Your tip page uses your Twitch picture and offline image until you pick your own. Images come from your uploaded files.">
              <div className="card-body tips-grid">
                <ImagePick label="Picture" value={draft.avatar} files={files} defaults={[['', 'Twitch profile picture']]} onPick={(v) => set({ avatar: v })} upload={upload} />
                <ImagePick label="Banner" value={draft.banner} files={files} defaults={[['', 'Twitch offline image'], ['none', 'No banner']]} onPick={(v) => set({ banner: v })} upload={upload} />
                <ImagePick label="Background image" value={draft.background} files={files} defaults={[['', 'None']]} onPick={(v) => set({ background: v })} upload={upload} />
                <div className="field">
                  <span>Background colour</span>
                  <span className="tip-color">
                    <input type="color" aria-label="Pick a colour" value={draft.bgColor || '#0b0a0a'} onChange={(e) => set({ bgColor: e.target.value })} />
                    <input className="input" value={draft.bgColor} placeholder="Default" maxLength={7} onChange={(e) => set({ bgColor: e.target.value.trim() })} />
                    {draft.bgColor && <button className="btn ghost sm" type="button" onClick={() => set({ bgColor: '' })}>Reset</button>}
                  </span>
                </div>
                {draft.background && <>
                  <label className="field">Background style
                    <select className="select" value={draft.bgTile ? 'tile' : 'fill'} onChange={(e) => set({ bgTile: e.target.value === 'tile' })}>
                      <option value="tile">Tile (repeat a square image)</option>
                      <option value="fill">Fill the page</option>
                    </select>
                  </label>
                  {draft.bgTile && (
                    <label className="field">Tile size: {draft.tileSize} px
                      <input type="range" min={16} max={512} step={4} value={Math.min(draft.tileSize, 512)} onChange={(e) => set({ tileSize: Number(e.target.value) })} />
                    </label>
                  )}
                  <div className="field wide">
                    <span>Preview</span>
                    <div className="tip-bg-preview" style={{
                      backgroundColor: draft.bgColor || undefined,
                      backgroundImage: `url("${mediaUrl(ch.key, draft.background)}")`,
                      backgroundRepeat: draft.bgTile ? 'repeat' : 'no-repeat',
                      backgroundSize: draft.bgTile ? `${draft.tileSize}px ${draft.tileSize}px` : 'cover',
                      backgroundPosition: draft.bgTile ? 'center top' : 'center',
                    }} />
                    {draft.bgTile && <span className="field-hint">Tiles join without seams when the image is square and its edges match.</span>}
                  </div>
                </>}
              </div>
            </Card>

            <Card title="Chargeback protection" desc="Every card tip asks for 3D Secure. Methods that can be reversed for weeks, buy now pay later and PayPal are never offered. Anyone who disputes a tip on any Sylva channel can no longer tip anywhere on Sylva.">
              <div className="card-body tips-grid">
                <label className="field">Hold tips before they show
                  <select className="select" value={draft.hold} onChange={(e) => set({ hold: e.target.value as TipSettings['hold'] })}>
                    <option value="approve">Until I approve them</option>
                    <option value="delay">For a delay, then show</option>
                    <option value="off">Never (risky tips still wait)</option>
                  </select>
                </label>
                {draft.hold === 'delay' && <Amount label="Delay in seconds" value={draft.delaySeconds} step={1} onChange={(n) => set({ delaySeconds: Math.round(n) })} />}
                {draft.hold !== 'off' && <>
                  <Amount label="Hold tips of at least" hint="0 holds no tip for its size." value={draft.holdOver} onChange={(n) => set({ holdOver: n })} />
                  <Toggle label="Hold someone’s first tip" on={draft.holdFirst} set={(v) => set({ holdFirst: v })} />
                  <Toggle label="Hold card tips the bank did not verify" on={draft.holdUnverified} set={(v) => set({ holdUnverified: v })} />
                </>}
                <label className="field">Card from another country than the viewer
                  <select className="select" value={draft.mismatch} onChange={(e) => set({ mismatch: e.target.value as TipSettings['mismatch'] })}>
                    <option value="block">Refuse it</option>
                    <option value="hold">Hold it</option>
                    <option value="allow">Allow it</option>
                  </select>
                </label>
                <Toggle label="Refund on its own when the bank warns of fraud" hint="Stops most chargebacks before they happen. Stripe keeps its fee." on={draft.refundOnWarning} set={(v) => set({ refundOnWarning: v })} />
                <Toggle label="Answer disputes on their own" hint="Sends Stripe the tip’s message, times, IP country, 3D Secure result and a clip." on={draft.autoEvidence} set={(v) => set({ autoEvidence: v })} />
              </div>
            </Card>

            <Card title="Text to speech" desc="Reads the tipper’s name, amount and message aloud on your overlay after the alert sound. Links are skipped.">
              <div className="card-body tips-grid">
                <Toggle label="Read tips aloud" on={draft.tts} set={(v) => set({ tts: v })} />
                <Amount label="Only tips of at least" value={draft.ttsMin} onChange={(n) => set({ ttsMin: n })} />
                <label className="field">Voice
                  <select className="select" value={draft.ttsLang} onChange={(e) => set({ ttsLang: e.target.value })}>
                    {view.ttsLangs.map((l) => <option key={l} value={l}>{LANGS[l] || l}</option>)}
                  </select>
                </label>
              </div>
            </Card>
          </Gate>

          {changed && (
            <div className="save-bar" role="region" aria-label="Unsaved changes">
              <span>You have changes that are not saved yet.</span>
              <button className="btn ghost" type="button" disabled={busy} onClick={() => setDraft(view.settings)}>Discard</button>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving' : 'Save changes'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ImagePick({ label, value, files, defaults, onPick, upload }: {
  label: string; value: string; files: MediaFile[]; defaults: [string, string][];
  onPick(v: string): void; upload(f: File): Promise<MediaFile | null>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const images = files.filter((f) => /\.(png|jpg|gif|webp)$/.test(f.id));
  const missing = value && !defaults.some(([v]) => v === value) && !images.some((f) => f.id === value);
  return (
    <div className="field">
      <span>{label}</span>
      <span className="media-pick">
        <select className="select" value={value} onChange={(e) => onPick(e.target.value)}>
          {defaults.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          {missing && <option value={value}>Deleted file</option>}
          {images.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button className="btn sm" type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading' : 'Upload'}</button>
        <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          const added = await upload(f);
          setBusy(false);
          if (added) onPick(added.id);
        }} />
      </span>
    </div>
  );
}

function Toggle({ label, hint, on, set }: { label: string; hint?: string; on: boolean; set(v: boolean): void }) {
  return (
    <div className="field inline wide">
      <span>{label}{hint && <span className="field-hint"> {hint}</span>}</span>
      <button className="switch" type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)} />
    </div>
  );
}

function Amount({ label, hint, value, step = 0.01, onChange }: { label: string; hint?: string; value: number; step?: number; onChange(n: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    const v = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : value;
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <label className="field">{label}
      <input className="input num-input" type="number" inputMode="decimal" min={0} step={step} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function TipRow({ t, canMod, canEdit, act }: { t: Tip; canMod: boolean; canEdit: boolean; act(t: Tip, a: 'approve' | 'reject' | 'refund' | 'block' | 'unblock'): void }) {
  const [label, color] = STATUS[t.status] ?? [t.status, 'var(--muted)'];
  const facts = [
    methodName(t.method),
    t.method === 'card' ? (t.verified ? '3D Secure' : 'Not verified by the bank') : null,
    t.country ? `From ${countryName(t.country)}` : null,
    t.cardCountry && t.cardCountry !== t.country ? `Card from ${countryName(t.cardCountry)}` : null,
    t.risk && t.risk !== 'normal' ? `Radar: ${t.risk}` : null,
    t.email,
    new Date(t.paidAt ?? t.createdAt).toLocaleString(),
  ].filter(Boolean);
  return (
    <li className="tips-row">
      <div className="tips-main">
        <div className="tips-top">
          <b>{t.name}</b>
          <span className="tips-amount">{money(t.amount, t.currency)}</span>
          <span className="pill" style={{ ['--g' as string]: color }}>{label}</span>
          {t.blocked && <span className="pill" style={{ ['--g' as string]: 'var(--danger)' }}>Blocked</span>}
          {t.test && <span className="pill" style={{ ['--g' as string]: 'var(--warn, #d97706)' }}>Test</span>}
        </div>
        {t.message && <p className="tips-msg">{t.message}</p>}
        <p className="field-hint">{facts.join(' · ')}</p>
        {t.status === 'held' && t.holdReason && (
          <p className="field-hint">Held: {t.holdReason}.{t.releaseAt && !t.needsApproval ? ` Shows on its own at ${new Date(t.releaseAt).toLocaleTimeString()}.` : ''}</p>
        )}
        {t.status === 'disputed' && <p className="field-hint">Dispute {t.disputeStatus?.replace(/_/g, ' ') || 'open'}. {t.evidenceSent ? 'Evidence sent to Stripe.' : 'Answer it in your Stripe dashboard.'}</p>}
        {t.note && t.status !== 'held' && <p className="field-hint">{t.note}</p>}
        {t.clip && <a className="field-hint" href={t.clip} target="_blank" rel="noreferrer">Clip of the moment</a>}
      </div>
      <div className="tips-actions">
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

/* ---------------- Public tip page ---------------- */

// Stripe.js, loaded once, only on tip pages.
type StripeJs = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let stripeScript: Promise<void> | null = null;
function loadStripe(): Promise<void> {
  if ((window as any).Stripe) return Promise.resolve(); // eslint-disable-line @typescript-eslint/no-explicit-any
  stripeScript ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = () => ok();
    s.onerror = () => { stripeScript = null; fail(new Error('Stripe could not be loaded')); };
    document.head.appendChild(s);
  });
  return stripeScript;
}

function cssVar(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function PublicTipPage({ login }: { login: string; signedIn?: boolean }) {
  const [page, setPage] = useState<PublicTipPage | null | 'missing' | 'failed'>(null);
  const [currency, setCurrency] = useState('USD');
  const [amountText, setAmountText] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'pending' | 'paid' | 'failed' | null>(null);
  const [ready, setReady] = useState(false);
  const stripe = useRef<StripeJs>(null);
  const elements = useRef<StripeJs>(null);
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.publicTip(login)
      .then((p) => {
        setPage(p);
        setCurrency(p.currency);
        const c = p.currencies.find((x) => x.code === p.currency);
        if (c?.suggested.length) setAmountText(String(c.suggested[Math.min(1, c.suggested.length - 1)]));
        document.title = `Tip ${p.name || login} · Sylva`;
      })
      .catch((x) => { setPage(x?.status === 404 ? 'missing' : 'failed'); document.title = 'Tip · Sylva'; });
  }, [login]);

  const cur = typeof page === 'object' && page ? page.currencies.find((c) => c.code === currency) : undefined;
  const amount = Number(amountText);
  const scale = cur ? 10 ** cur.decimals : 100;
  const minor = Number.isFinite(amount) && amount > 0 ? Math.round(amount * scale) : 0;

  // Back from a bank or wallet page: follow the tip it paid.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('tip');
    if (id && id.startsWith('tip_')) follow(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stripe's payment form, built once the page knows the streamer's account.
  useEffect(() => {
    if (typeof page !== 'object' || !page || !page.open || !page.publishableKey || !page.account || !cur) return;
    if (elements.current) return;
    let gone = false;
    loadStripe().then(() => {
      if (gone || !mount.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stripe.current = (window as any).Stripe(page.publishableKey, { stripeAccount: page.account });
      const light = document.documentElement.dataset.theme === 'light';
      elements.current = stripe.current.elements({
        mode: 'payment',
        amount: Math.max(minor, 1),
        currency: currency.toLowerCase(),
        // An allow list, so nothing Stripe turns on later (like Klarna) shows up.
        ...(page.allowed?.length ? { allowedPaymentMethodTypes: page.allowed } : { excludedPaymentMethodTypes: page.excluded }),
        appearance: {
          theme: light ? 'stripe' : 'night',
          variables: {
            colorPrimary: cssVar('--primary', '#8b5cf6'),
            colorBackground: cssVar('--surface', light ? '#ffffff' : '#161618'),
            colorText: cssVar('--text', light ? '#111' : '#ededef'),
            borderRadius: '8px',
            fontFamily: 'Inter, system-ui, sans-serif',
          },
        },
      });
      const pe = elements.current.create('payment', {
        layout: { type: 'tabs' },
        paymentMethodOrder: page.order,
        fields: { billingDetails: { email: 'never' } },
        wallets: { applePay: 'auto', googlePay: 'auto' },
      });
      pe.on('ready', () => setReady(true));
      pe.mount(mount.current);
    }).catch(() => setError('The payment form could not load. Turn off any blocker for js.stripe.com and refresh.'));
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, !!cur]);

  // The form shows the methods that fit this amount and currency.
  useEffect(() => {
    if (elements.current && minor > 0) elements.current.update({ amount: minor, currency: currency.toLowerCase() });
  }, [minor, currency]);

  const follow = (id: string) => {
    setDone('pending');
    let tries = 0;
    const tick = () => {
      api.tipStatus(login, id).then((s) => {
        if (s.status === 'paid') setDone('paid');
        else if (s.status === 'failed' || s.status === 'closed') { setDone(null); setError(s.note || 'The payment did not go through. Nothing was charged.'); }
        else if (++tries < 40) setTimeout(tick, 2500);
      }).catch(() => { if (++tries < 40) setTimeout(tick, 4000); });
    };
    tick();
  };

  const pay = async () => {
    if (typeof page !== 'object' || !page || !cur || !stripe.current || !elements.current) return;
    setError(null);
    if (!(minor > 0) || amount < cur.min || amount > cur.max) { setError(`Tips here are ${money(cur.min, currency)} to ${money(cur.max, currency)}.`); return; }
    if (!name.trim()) { setError('Add a name to show with your tip.'); return; }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('Enter your email for the receipt.'); return; }
    if (!agreed) { setError('Tick the box to confirm the tip is a gift.'); return; }
    setBusy(true);
    try {
      const submitted = await elements.current.submit();
      if (submitted.error) { setError(submitted.error.message); return; }
      const back = `${location.origin}/tip/${login}`;
      const { error: e, confirmationToken } = await stripe.current.createConfirmationToken({
        elements: elements.current,
        params: { return_url: back, payment_method_data: { billing_details: { email: email.trim() } } },
      });
      if (e) { setError(e.message); return; }
      const res = await api.sendTip(login, { amount, currency, name, email, message, agreed, confirmationToken: confirmationToken.id });
      // Bank pages come back to this page with the tip's id.
      history.replaceState(null, '', `${location.pathname}?tip=${res.id}`);
      if (res.status === 'requires_action' && res.clientSecret) {
        const next = await stripe.current.handleNextAction({ clientSecret: res.clientSecret });
        if (next.error) { setError(next.error.message); return; }
      }
      follow(res.id);
    } catch (x) {
      setError(errorText(x));
    } finally {
      setBusy(false);
    }
  };

  const left = useMemo(() => (typeof page === 'object' && page ? page.messageMax - [...message].length : 0), [page, message]);

  if (page === null || page === 'missing' || page === 'failed' || !page.open) {
    return (
      <div className="tip-site">
        <main id="content" className="tip-main">
          {page === null ? <div className="tip-card tip-pad"><SkelRows n={4} tile={false} /></div> : (
            <div className="tip-card tip-pad tip-done">
              <h1>{page === 'failed' ? 'Something went wrong' : 'No tips here yet'}</h1>
              <p>{page === 'failed' ? 'Sylva could not be reached. Refresh to try again.' : `${typeof page === 'object' ? page.name : login} is not taking tips right now, or the link is mistyped.`}</p>
            </div>
          )}
        </main>
      </div>
    );
  }

  const look = page.look;
  const file = (id?: string) => (id && page.key ? mediaUrl(page.key, id) : '');
  const avatar = file(look?.avatar) || page.avatar;
  const banner = look?.banner === 'none' ? '' : file(look?.banner) || page.banner || '';
  const bg = file(look?.background);
  const siteStyle: CSSProperties = {};
  if (look?.bgColor) siteStyle.backgroundColor = look.bgColor;
  if (bg) {
    siteStyle.backgroundImage = `url("${bg}")`;
    if (look?.bgTile) {
      siteStyle.backgroundRepeat = 'repeat';
      siteStyle.backgroundSize = `${look.tileSize}px ${look.tileSize}px`;
      siteStyle.backgroundPosition = 'center top';
    } else {
      siteStyle.backgroundRepeat = 'no-repeat';
      siteStyle.backgroundSize = 'cover';
      siteStyle.backgroundPosition = 'center';
      siteStyle.backgroundAttachment = 'fixed';
    }
  }

  const chips = cur?.suggested ?? [];
  const picked = chips.includes(amount) && !custom;
  const other = custom || (!picked && amountText !== '');
  const top = page.top ?? [];

  return (
    <div className="tip-site" style={siteStyle}>
      <main id="content" className="tip-main">
        <div className="tip-layout">
          <section className="tip-card">
            {banner ? <div className="tip-banner" style={{ backgroundImage: `url("${banner}")` }} /> : <div className="tip-banner plain" />}
            <div className="tip-who">
              <Avatar name={page.name} url={avatar} large />
              <h1>{page.name}</h1>
            </div>
            {page.note && <p className="tip-note">{page.note}</p>}

            {done === 'paid' ? (
              <div className="tip-done">
                <Icon id="check" />
                <h2>Thank you</h2>
                <p>Your tip went through and will show on stream soon. The receipt is in your email.</p>
              </div>
            ) : done === 'pending' ? (
              <div className="tip-done">
                <h2>Confirming your payment</h2>
                <p>This can take a moment. Keep this page open.</p>
              </div>
            ) : (
              <form className="tip-form" onSubmit={(e) => { e.preventDefault(); void pay(); }}>
                {page.testMode && <p className="tip-test">Test mode. Use a Stripe test card, no real money moves.</p>}
                <div className="tip-section">
                  <div className="tip-label-row">
                    <span className="tip-label">Amount</span>
                    <select className="tip-currency" aria-label="Currency" value={currency} onChange={(e) => {
                      const next = page.currencies.find((c) => c.code === e.target.value);
                      setCurrency(e.target.value);
                      setCustom(false);
                      if (next?.suggested.length) setAmountText(String(next.suggested[Math.min(1, next.suggested.length - 1)]));
                    }}>
                      {page.currencies.map((c) => <option key={c.code}>{c.code}</option>)}
                    </select>
                  </div>
                  <div className="tip-amounts" role="group" aria-label="Amount">
                    {chips.map((v) => (
                      <button key={v} type="button" className="tip-amount-btn" aria-pressed={picked && amount === v}
                        onClick={() => { setCustom(false); setAmountText(String(v)); }}>{money(v, currency)}</button>
                    ))}
                    <button type="button" className="tip-amount-btn" aria-pressed={other}
                      onClick={() => { setCustom(true); setAmountText(''); }}>Other</button>
                  </div>
                  {other && (
                    <input className="input tip-other" type="number" inputMode="decimal" autoFocus placeholder={cur ? `${money(cur.min, currency)} to ${money(cur.max, currency)}` : ''}
                      aria-label="Your amount" min={cur?.min} max={cur?.max} step={cur?.decimals ? 0.01 : 1}
                      value={amountText} onChange={(e) => setAmountText(e.target.value)} required />
                  )}
                </div>

                <div className="tip-fields">
                  <label className="field">Name
                    <input className="input" maxLength={page.nameMax} value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" required />
                  </label>
                  <label className="field">Email
                    <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
                  </label>
                </div>
                <label className="field">Message
                  <span className="tip-message">
                    <textarea className="input textarea" rows={3} maxLength={page.messageMax} value={message} onChange={(e) => setMessage(e.target.value)} />
                    <span className="tip-count" aria-hidden="true">{left}</span>
                  </span>
                </label>

                <div className="tip-pay" ref={mount} />
                {!ready && <SkelRows n={2} tile={false} />}

                <label className="tip-agree">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span>This tip is a gift and is not refundable.</span>
                </label>
                {error && <p className="tip-error" role="alert">{error}</p>}
                <button className="btn primary tip-submit" type="submit" disabled={busy || !ready}>
                  {busy ? 'Working' : minor > 0 ? `Tip ${money(amount, currency)}` : 'Tip'}
                </button>
                <p className="tip-fine">Your email is only for the receipt. Payments by Stripe, page by <Link href="/">Sylva</Link>.</p>
              </form>
            )}
          </section>

          {top.length > 0 && (
            <aside className="tip-card tip-top" aria-labelledby="tip-top-h">
              <h2 id="tip-top-h">Top this week</h2>
              <ol>
                {top.map((t, i) => (
                  <li key={i}><span className="tip-rank">{i + 1}</span><span className="tip-top-name">{t.name}</span><span className="tip-top-amt">{money(t.amount, page.baseCurrency)}</span></li>
                ))}
              </ol>
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}

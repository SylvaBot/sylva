// Tips. The dashboard page (/app/tips) connects the streamer's own Stripe
// account, sets limits and holds, and approves or refunds tips. The public
// page (/tip/{login}) is where viewers pay. Money goes straight to the
// streamer's Stripe account; the rules live in crates/sylva-core/src/tips.rs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type PublicTipPage, type Tip, type TipSettings, type TipsView } from './api';
import { useChannel } from './channel';
import { Card, PageHead } from './pages';
import { Link } from './router';
import { SiteFooter, SiteHeader } from './site';
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

  const load = useCallback(() => {
    api.tips(ch.key).then((v) => {
      setView(v);
      setDraft((d) => d ?? v.settings);
      setCountry((c) => c || v.account?.country || (v.countries.includes('US') ? 'US' : v.countries[0]));
    }).catch(() => setFailed(true));
  }, [ch.key]);

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

export function PublicTipPage({ login, signedIn }: { login: string; signedIn: boolean }) {
  const [page, setPage] = useState<PublicTipPage | null | 'missing' | 'failed'>(null);
  const [currency, setCurrency] = useState('USD');
  const [amountText, setAmountText] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [agreed, setAgreed] = useState(false);
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
        excludedPaymentMethodTypes: page.excluded,
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
        layout: { type: 'accordion', defaultCollapsed: false },
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

  const header = (
    <SiteHeader>
      <span className="spacer" />
      {signedIn ? <Link className="btn" href="/app">Open dashboard</Link> : <Link className="btn" href="/">What is Sylva?</Link>}
    </SiteHeader>
  );

  const left = useMemo(() => (typeof page === 'object' && page ? page.messageMax - [...message].length : 0), [page, message]);

  if (page === null || page === 'missing' || page === 'failed' || !page.open) {
    return (
      <div className="site">
        {header}
        <main id="content" className="prose wrap">
          {page === null ? <SkelRows n={4} tile={false} /> : <>
            <h1>{page === 'failed' ? 'Something went wrong' : 'No tips here yet'}</h1>
            <p className="prose-lede">{page === 'failed' ? 'Sylva could not be reached. Refresh to try again.' : `${typeof page === 'object' ? page.name : login} is not taking tips on Sylva right now, or the link is mistyped.`}</p>
          </>}
        </main>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div className="site">
      {header}
      <main id="content" className="wrap tip-page">
        <div className="tip-head">
          <Avatar name={page.name} url={page.avatar} large />
          <div>
            <p className="pub-eyebrow">twitch.tv/{page.login}</p>
            <h1>Tip {page.name}</h1>
          </div>
        </div>
        {page.testMode && <div className="notice"><span>Test mode. This page takes Stripe test cards only, and no real money moves.</span></div>}
        {page.note && <p className="prose-lede">{page.note}</p>}

        {done === 'paid' ? (
          <section className="card"><div className="card-body tip-done">
            <Icon id="check" />
            <h2>Thank you!</h2>
            <p className="card-text">Your tip went through and will show on stream soon. Your receipt is on its way by email.</p>
          </div></section>
        ) : done === 'pending' ? (
          <section className="card"><div className="card-body tip-done">
            <h2>Confirming your payment</h2>
            <p className="card-text">This can take a moment. Keep this page open.</p>
          </div></section>
        ) : (
          <form className="card tip-form" onSubmit={(e) => { e.preventDefault(); void pay(); }}>
            <div className="card-body stack">
              <div className="tip-amount-row">
                <label className="field">Amount
                  <input className="input tip-amount" type="number" inputMode="decimal" min={cur?.min} max={cur?.max} step={cur?.decimals ? 0.01 : 1}
                    value={amountText} onChange={(e) => setAmountText(e.target.value)} required />
                </label>
                <label className="field">Currency
                  <select className="select" value={currency} onChange={(e) => {
                    const next = page.currencies.find((c) => c.code === e.target.value);
                    setCurrency(e.target.value);
                    if (next?.suggested.length) setAmountText(String(next.suggested[Math.min(1, next.suggested.length - 1)]));
                  }}>
                    {page.currencies.map((c) => <option key={c.code}>{c.code}</option>)}
                  </select>
                </label>
              </div>
              {cur && cur.suggested.length > 0 && (
                <div className="chips tip-chips">
                  {cur.suggested.map((s) => (
                    <button key={s} type="button" className="chip" aria-pressed={amount === s} onClick={() => setAmountText(String(s))}>{money(s, currency)}</button>
                  ))}
                </div>
              )}
              {cur && <span className="field-hint">{money(cur.min, currency)} to {money(cur.max, currency)}. A first tip here can be up to {money(cur.firstMax, currency)}.</span>}
              <label className="field">Name shown on stream
                <input className="input" maxLength={page.nameMax} value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" required />
              </label>
              <label className="field">Email for your receipt
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
                <span className="field-hint">Not shown on stream or to {page.name}.</span>
              </label>
              <label className="field">Message (optional)
                <textarea className="input textarea" rows={3} maxLength={page.messageMax} value={message} onChange={(e) => setMessage(e.target.value)} />
                <span className="field-hint">{left} characters left. It may be read aloud on stream.</span>
              </label>
              <div className="tip-pay" ref={mount} />
              {!ready && <SkelRows n={2} tile={false} />}
              <label className="tip-agree">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>I understand this tip is a voluntary gift to {page.name} and is not refundable.</span>
              </label>
              {error && <p className="tip-error" role="alert">{error}</p>}
              <button className="btn primary tip-submit" type="submit" disabled={busy || !ready}>
                {busy ? 'Working' : minor > 0 ? `Tip ${money(amount, currency)}` : 'Tip'}
              </button>
              <p className="field-hint">Payments go straight to {page.name} through Stripe. Sylva never sees your card.</p>
            </div>
          </form>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

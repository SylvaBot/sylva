// The public tip page (/tip/{login}), where viewers pay, and helpers the
// dashboard's Tips page (tipsAdmin.tsx) shares. Money goes straight to the
// streamer's Stripe account; the rules live in crates/sylva-core/src/tips.rs.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, mediaUrl, type PublicTipPage } from './api';
import { Link } from './router';
import { Avatar, errorText, Icon, SkelRows } from './ui';
import { VoiceGrid } from './voices';
import { Select } from './dropdown';


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
export const methodName = (m?: string) => (m ? METHOD_NAMES[m] || m.replace(/_/g, ' ') : '');



const COUNTRY_NAMES = (() => {
  try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; }
})();
export const countryName = (c: string) => COUNTRY_NAMES?.of(c) || c;

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
  const [message, setMessage] = useState('');
  const [voice, setVoice] = useState('');
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
        if (p.speech) setVoice(p.speech.voice);
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
        // Must match the charge: automatic methods minus the excluded ones.
        // (An allow list here makes Stripe refuse the charge.)
        excludedPaymentMethodTypes: page.excluded,
        appearance: {
          theme: light ? 'stripe' : 'night',
          variables: {
            colorPrimary: cssVar('--primary', '#8b5cf6'),
            colorBackground: cssVar('--surface', light ? '#ffffff' : '#161618'),
            colorText: cssVar('--text', light ? '#111' : '#ededef'),
            colorTextSecondary: cssVar('--muted', light ? '#52525a' : '#a39f9b'),
            colorTextPlaceholder: cssVar('--faint', light ? '#65656c' : '#8a8580'),
            colorDanger: cssVar('--danger', '#f0686a'),
            borderRadius: '10px',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSizeBase: '14px',
            spacingUnit: '3px',
          },
          rules: {
            '.Input': { backgroundColor: cssVar('--sunken', light ? '#f4f4f6' : '#0d0c0c'), border: '1px solid transparent', boxShadow: 'none' },
            '.Input:focus': { border: `1px solid ${cssVar('--focus', '#e9e4df')}`, boxShadow: 'none' },
            '.Tab': { backgroundColor: cssVar('--sunken', light ? '#f4f4f6' : '#0d0c0c'), border: '1px solid transparent', boxShadow: 'none' },
            '.Tab:hover': { backgroundColor: cssVar('--surface-2', light ? '#f4f4f6' : '#1b1a19') },
            '.Tab--selected': { backgroundColor: cssVar('--surface-3', light ? '#ebebee' : '#262422'), border: '1px solid transparent', boxShadow: 'none' },
            '.Label': { fontSize: '12.5px', fontWeight: '500', color: cssVar('--muted', light ? '#52525a' : '#a39f9b') },
          },
        },
      });
      const pe = elements.current.create('payment', {
        layout: { type: 'tabs' },
        paymentMethodOrder: page.order,
        // Stripe asks for an email only when a method needs one (OXXO, Boleto).
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
    if (!agreed) { setError('Tick the box to confirm the tip is a gift.'); return; }
    setBusy(true);
    try {
      const submitted = await elements.current.submit();
      if (submitted.error) { setError(submitted.error.message); return; }
      const back = `${location.origin}/tip/${login}`;
      const { error: e, confirmationToken } = await stripe.current.createConfirmationToken({
        elements: elements.current,
        params: { return_url: back },
      });
      if (e) { setError(e.message); return; }
      const res = await api.sendTip(login, { amount, currency, name, message, voice: voice || undefined, agreed, confirmationToken: confirmationToken.id });
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

  const best = top[0]?.amount || 1;

  return (
    <div className="tip-site" style={siteStyle}>
      <main id="content" className="tip-main">
        <div className="tip-layout">
          <section className="tip-card" aria-label={`Tip ${page.name}`}>
            {banner ? <div className="tip-banner" style={{ backgroundImage: `url("${banner}")` }} /> : <div className="tip-banner plain" />}
            <div className="tip-who">
              <Avatar name={page.name} url={avatar} large />
              <div className="tip-id">
                <h1>{page.name}</h1>
                <a href={`https://twitch.tv/${page.login}`} target="_blank" rel="noreferrer"><Icon id="twitch" />{page.login}</a>
              </div>
            </div>
            {page.note && <p className="tip-note">{page.note}</p>}

            {done === 'paid' ? (
              <div className="tip-done">
                <span className="tip-done-icon"><Icon id="check" /></span>
                <h2>Thank you</h2>
                <p>Your tip went through and will show on stream soon.</p>
              </div>
            ) : done === 'pending' ? (
              <div className="tip-done">
                <span className="tip-spinner" aria-hidden="true" />
                <h2>Confirming your payment</h2>
                <p>This can take a moment. Keep this page open.</p>
              </div>
            ) : (
              <form className="tip-form" onSubmit={(e) => { e.preventDefault(); void pay(); }}>
                {page.testMode && <p className="tip-test"><span className="tip-test-dot" />Test mode. Use a Stripe test card, no real money moves.</p>}
                <div className="tip-section">
                  <div className="tip-label-row">
                    <span className="tip-label">Amount</span>
                    <Select className="sm tip-currency" label="Currency" value={currency} onChange={(code) => {
                      const next = page.currencies.find((c) => c.code === code);
                      setCurrency(code);
                      setCustom(false);
                      if (next?.suggested.length) setAmountText(String(next.suggested[Math.min(1, next.suggested.length - 1)]));
                    }} options={page.currencies.map((c) => ({ value: c.code, label: c.code }))} />
                  </div>
                  <div className="tip-amounts" role="group" aria-label="Amount">
                    {chips.map((v) => (
                      <button key={v} type="button" className="tip-amount-btn" aria-pressed={picked && amount === v}
                        onClick={() => { setCustom(false); setAmountText(String(v)); }}>{money(v, currency).replace(/\.00$/, '')}</button>
                    ))}
                    <button type="button" className="tip-amount-btn" aria-pressed={other}
                      onClick={() => { setCustom(true); setAmountText(''); }}>Other</button>
                  </div>
                  {other && (
                    <input className="tip-input tip-other" type="number" inputMode="decimal" autoFocus placeholder={cur ? `${money(cur.min, currency)} to ${money(cur.max, currency)}` : ''}
                      aria-label="Your amount" min={cur?.min} max={cur?.max} step={cur?.decimals ? 0.01 : 1}
                      value={amountText} onChange={(e) => setAmountText(e.target.value)} required />
                  )}
                </div>

                <label className="tip-field">
                  <span>Name</span>
                  <input className="tip-input" maxLength={page.nameMax} value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" placeholder="Shown on stream" required />
                </label>
                <label className="tip-field">
                  <span>Message <em>optional</em></span>
                  <span className="tip-message">
                    <textarea className="tip-input" rows={3} maxLength={page.messageMax} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Say something nice" />
                    <span className="tip-count" aria-hidden="true">{left}</span>
                  </span>
                </label>

                {page.speech && page.speech.voices.length > 0 && (
                  <div className="tip-field">
                    <span className="tip-label-row">
                      <span className="tip-label">Voice</span>
                      <span className="tip-voice-hint">Reads your message on stream{page.speech.min > 0 ? ` from ${money(page.speech.min, page.baseCurrency)}` : ''}</span>
                    </span>
                    <VoiceGrid voices={page.speech.voices} mode="pick" value={voice ? [voice] : []} onChange={(v) => setVoice(v[0])} label="Voice" />
                  </div>
                )}

                <div className="tip-pay" ref={mount} />
                {!ready && !error && <SkelRows n={2} tile={false} />}

                <label className="tip-agree">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span>This tip is a gift and is not refundable.</span>
                </label>
                {error && <p className="tip-error" role="alert">{error}</p>}
                <button className="tip-submit" type="submit" disabled={busy || !ready}>
                  {busy ? 'Working' : minor > 0 ? `Tip ${money(amount, currency).replace(/\.00$/, '')}` : 'Tip'}
                </button>
                <p className="tip-fine">Secure payment by Stripe · Page by <Link href="/">Sylva</Link></p>
              </form>
            )}
          </section>

          <aside className="tip-board" aria-labelledby="tip-board-h">
            <div className="tip-board-head">
              <h2 id="tip-board-h">Leaderboard</h2>
              <span>Last 7 days</span>
            </div>
            {top.length === 0 ? (
              <p className="tip-board-empty">No tips this week yet. Yours could be first.</p>
            ) : (
              <ol className="tip-board-list">
                {top.map((t, i) => (
                  <li key={i} className={i === 0 ? 'first' : undefined} style={{ ['--share' as string]: `${Math.max(6, Math.round((t.amount / best) * 100))}%` }}>
                    <span className="tip-rank">{i + 1}</span>
                    <span className="tip-board-who">
                      <span className="tip-board-name">{t.name}</span>
                      <span className="tip-board-bar" aria-hidden="true"><i /></span>
                    </span>
                    <span className="tip-board-amt">{money(t.amount, page.baseCurrency).replace(/\.00$/, '')}</span>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

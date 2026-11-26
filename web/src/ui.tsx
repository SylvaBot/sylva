// Small shared pieces: icons from the sprite, avatars, toasts and formatting.
// Behavior matches Cortex's ui/app.js helpers.

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export function Icon({ id }: { id: string }) {
  return (
    <svg aria-hidden="true">
      <use href={`#i-${id}`} />
    </svg>
  );
}

export function Avatar({ name, url, large }: { name: string; url?: string; large?: boolean }) {
  const [broken, setBroken] = useState(false);
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const src = url && url.startsWith('https://') && !broken ? url : null;
  return (
    <span className={large ? 'avatar lg' : 'avatar'}>
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : letter}
    </span>
  );
}

const fmt = new Intl.NumberFormat();
export const num = (n: number | null | undefined) => (n === null || n === undefined ? '-' : fmt.format(n));

export function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export interface ToastAction { label: string; run(): void }
interface Toast { id: number; text: string; bad: boolean; action?: ToastAction }
type ShowToast = (text: string, bad?: boolean, action?: ToastAction) => void;
const ToastContext = createContext<ShowToast>(() => {});

export function Toasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback<ShowToast>((text, bad = false, action) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, bad, action }]);
    // A toast with Undo stays long enough to reach the button.
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : bad ? 6500 : 3000);
  }, []);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} className={'toast' + (t.bad ? ' bad' : '') + (t.action ? ' has-action' : '')}>
            {t.text}
            {t.action && (
              <button className="toast-action" type="button" onClick={() => { dismiss(t.id); t.action!.run(); }}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Turns off every control inside when `on` is false, for the parts of a page
 * a teammate's role cannot change. With a className it is always a box, so
 * the layout is the same either way. */
export function Gate({ on, className, children }: { on: boolean; className?: string; children: ReactNode }) {
  if (on) return className ? <div className={className}>{children}</div> : <>{children}</>;
  return <fieldset className={'gate' + (className ? ' ' + className : '')} disabled>{children}</fieldset>;
}

/* ---------- Skeletons: gray shapes that hold the place of what is loading ---------- */

/** One shimmering bar. Width and height in px or any CSS length. */
export function Skel({ w, h = 12, round }: { w?: number | string; h?: number | string; round?: boolean }) {
  return <span className={'skel' + (round ? ' round' : '')} style={{ width: w, height: h }} aria-hidden="true" />;
}

/** List rows the shape of an activity item or a setting row: a tile and two lines. */
export function SkelRows({ n = 4, tile = true }: { n?: number; tile?: boolean }) {
  const widths = ['58%', '44%', '66%', '38%', '52%', '61%'];
  return (
    <div className="skel-rows" role="status" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skel-row">
          {tile && <Skel w={40} h={40} />}
          <div className="skel-lines"><Skel w={widths[i % widths.length]} h={13} /><Skel w="28%" h={10} /></div>
        </div>
      ))}
    </div>
  );
}

/** A whole card that is still loading: a title, a line under it and some rows. */
export function SkelCard({ rows = 3, tile = true }: { rows?: number; tile?: boolean }) {
  return (
    <section className="card skel-card" aria-busy="true">
      <div className="card-head"><div className="skel-lines"><Skel w={150} h={15} /><Skel w={260} h={11} /></div></div>
      <div className="card-body"><SkelRows n={rows} tile={tile} /></div>
    </section>
  );
}

/** A dashboard page in gray: its heading, four number tiles and two cards. */
export function PageSkel({ kpis = true }: { kpis?: boolean }) {
  return (
    <div className="page" role="status" aria-label="Loading">
      <div className="boot-head"><Skel w={260} h={26} /><Skel w={220} h={13} /></div>
      {kpis && <div className="kpis four">{[0, 1, 2, 3].map((i) => <div key={i} className="card skel-kpi"><Skel w={90} h={11} /><Skel w={70} h={30} /><Skel w="60%" h={10} /></div>)}</div>}
      <div className="stack"><SkelCard rows={2} tile={false} /><SkelCard rows={5} /></div>
    </div>
  );
}

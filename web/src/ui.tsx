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

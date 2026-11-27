// Small shared pieces: icons from the sprite, avatars, toasts and formatting.
// Behavior matches Sylva Desktop's ui/app.js helpers.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

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
  const src = url && (url.startsWith('https://') || url.startsWith('/media/')) && !broken ? url : null;
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

/* ---------- The 2026-11-27 look: shared pieces every page uses ---------- */

/** Sylva's leaf. */
export function Leaf({ size = 24 }: { size?: number }) {
  return (
    <svg className="leaf" width={size} height={size} viewBox="17 10 30 42" aria-hidden="true" style={{ width: size, height: size }}>
      <path className="leaf-body" d="M32 12c-9 8-13 17-13 25a13 13 0 0 0 26 0c0-8-4-17-13-25z" />
      <path className="leaf-vein" d="M32 22v30M32 38l-7-6M32 44l7-6" strokeWidth="2.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** A section: a small label (and optional note and actions) over a filled box. */
export function Sect({ title, desc, action, children, id, className, boxClass, foot }: {
  title?: ReactNode; desc?: ReactNode; action?: ReactNode; children: ReactNode; id?: string; className?: string; boxClass?: string; foot?: ReactNode;
}) {
  const hid = id ? id + '-title' : undefined;
  return (
    <section className={'sect' + (className ? ' ' + className : '')} aria-labelledby={title ? hid : undefined} id={id}>
      {(title || action) && (
        <div className="sect-head">
          <div>{title && <h2 id={hid}>{title}</h2>}{desc && <p>{desc}</p>}</div>
          {action && <div className="page-actions">{action}</div>}
        </div>
      )}
      <div className={'grp' + (boxClass ? ' ' + boxClass : '')}>{children}</div>
      {foot && <p className="sect-foot">{foot}</p>}
    </section>
  );
}

/** One row in a section: a title and note on the left, controls on the right. */
export function Row({ title, desc, children, className, htmlFor }: {
  title: ReactNode; desc?: ReactNode; children?: ReactNode; className?: string; htmlFor?: string;
}) {
  return (
    <div className={'gr' + (className ? ' ' + className : '')}>
      <div className="gr-main">
        {htmlFor ? <label className="t1" htmlFor={htmlFor}>{title}</label> : <div className="t1">{title}</div>}
        {desc && <div className="t2">{desc}</div>}
      </div>
      {children !== undefined && children !== null && children !== false && <div className="gr-ctl">{children}</div>}
    </div>
  );
}

/** A segmented control: one choice of a few, the chosen one in sage. */
export function Seg<T extends string | number>({ label, options, value, onChange, disabled, full, small }: {
  label: string; options: readonly (T | { id: T; label: ReactNode })[]; value: T; onChange(v: T): void; disabled?: boolean; full?: boolean; small?: boolean;
}) {
  return (
    <div className={'seg' + (full ? ' full' : '') + (small ? ' sm' : '')} role="group" aria-label={label}>
      {options.map((o) => {
        const id = (typeof o === 'object' ? o.id : o) as T;
        const text = typeof o === 'object' ? o.label : String(o);
        return (
          <button key={String(id)} type="button" aria-pressed={id === value} disabled={disabled} onClick={() => id !== value && onChange(id)}>
            {text}
          </button>
        );
      })}
    </div>
  );
}

/** An on and off switch. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return <button type="button" className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

/** Twitch's mod badge, the exact image, for chat previews. */
export const MOD_BADGE = '/mod-badge.png';

/** Event tiles: one solid tile and a light glyph, the same for every kind. */
export function Tile({ icon, size }: { icon: string; size?: 'sm' | 'lg' }) {
  return <span className={'tile' + (size ? ' ' + size : '')} aria-hidden="true"><Icon id={icon} /></span>;
}

/** Times follow the 12 or 24 hour clock chosen in Settings. */
export function clock24(): boolean {
  try { return localStorage.getItem('sylva.clock') === '24'; } catch { return false; }
}
export function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !clock24() });
}

/**
 * Settings that save as you change them. `set` changes the value now and
 * saves it a moment after the last change; `undo` puts back what was saved
 * before the latest change. A save that fails keeps the change on screen
 * and says so.
 */
export function useAutosave<T>(persist: (v: T) => Promise<T>, delay = 600) {
  const toast = useToast();
  const [value, setValue] = useState<T | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const saved = useRef<T | null>(null);
  const before = useRef<T | null>(null);
  const latest = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => () => clearTimeout(timer.current), []);

  /** Start from what the server has (after a load, or a channel switch). */
  const reset = useCallback((v: T) => {
    clearTimeout(timer.current);
    saved.current = v;
    latest.current = v;
    before.current = null;
    dirty.current = false;
    setValue(v);
    setCanUndo(false);
    setSavedAt(null);
  }, []);

  const flush = useCallback(async (v: T, undoing: boolean) => {
    const prior = saved.current;
    dirty.current = false;
    setSaving(true);
    try {
      const r = await persistRef.current(v);
      saved.current = r;
      if (!dirty.current) { latest.current = r; setValue(r); }
      setSavedAt(Date.now());
      if (undoing) { before.current = null; setCanUndo(false); } else { before.current = prior; setCanUndo(prior !== null); }
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setSaving(false);
    }
  }, [toast]);

  const set = useCallback((next: T | ((v: T) => T), now = false) => {
    const cur = latest.current;
    if (cur === null) return;
    const v = typeof next === 'function' ? (next as (v: T) => T)(cur) : next;
    latest.current = v;
    dirty.current = true;
    setValue(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(v, false), now ? 0 : delay);
  }, [delay, flush]);

  const undo = useCallback(() => {
    const b = before.current;
    if (b === null) return;
    clearTimeout(timer.current);
    latest.current = b;
    setValue(b);
    void flush(b, true);
  }, [flush]);

  return { value, set, reset, undo, canUndo, saving, savedAt };
}

/** "Saved just now" and an Undo button, for pages that save as you go. */
export function SaveState({ saving, savedAt, canUndo, onUndo }: { saving: boolean; savedAt: number | null; canUndo: boolean; onUndo(): void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!savedAt) return;
    const t = setInterval(() => tick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, [savedAt]);
  let text = 'Changes save as you go';
  if (saving) text = 'Saving';
  else if (savedAt) {
    const s = (Date.now() - savedAt) / 1000;
    text = s < 10 ? 'Saved just now' : s < 60 ? 'Saved a few seconds ago' : s < 3600 ? `Saved ${Math.floor(s / 60)}m ago` : 'Saved';
  }
  return (
    <div className="save-state-row">
      <span className="faint" role="status">{text}</span>
      <button className="btn sm" type="button" disabled={!canUndo || saving} onClick={onUndo}><Icon id="undo" />Undo</button>
    </div>
  );
}

/** A side panel over the page, for editing one thing. Escape or the close
 * button closes it, and focus goes back to what opened it. */
export function Drawer({ title, icon, actions, foot, onClose, children, label }: {
  title: ReactNode; icon?: string; actions?: ReactNode; foot?: ReactNode; onClose(): void; children: ReactNode; label?: string;
}) {
  const box = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close.current(); }
      if (e.key !== 'Tab' || !box.current) return;
      const all = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (!all.length) return;
      const [first, last] = [all[0], all[all.length - 1]];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); back?.focus?.(); };
  }, []);
  return (
    <>
      <div className="drawer-back" onMouseDown={() => close.current()} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : undefined)} ref={box} tabIndex={-1}>
        <div className="drawer-head">
          {icon && <Tile icon={icon} />}
          <h2>{title}</h2>
          {actions}
          <button className="icon-btn" type="button" aria-label="Close" onClick={() => close.current()}><Icon id="x" /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {foot && <div className="drawer-foot">{foot}</div>}
      </aside>
    </>
  );
}

/** A button that asks for a second click before it does something final. */
export function ArmedButton({ children, armedText, onConfirm, className, disabled, icon }: {
  children: ReactNode; armedText: string; onConfirm(): void; className?: string; disabled?: boolean; icon?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={'btn' + (className ? ' ' + className : '') + (armed ? ' armed' : '')} disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }} onBlur={() => setArmed(false)}>
      {icon && <Icon id={icon} />}{armed ? armedText : children}
    </button>
  );
}

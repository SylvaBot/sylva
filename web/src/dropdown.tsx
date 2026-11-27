// Sylva's own dropdown, used everywhere instead of the browser's <select>.
// A button shows the picked option; its list opens in a layer above the page
// (so cards that clip their content never cut it off), lands on a spring, and
// works with the mouse, touch and the keyboard: arrows, Home, End, Enter,
// Space, Escape, Tab and typing the first letters of an option.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui';

export type Option<T extends string | number> = { value: T; label: ReactNode; text?: string; disabled?: boolean };

type Props<T extends string | number> = {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  id?: string;
  label?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  placeholder?: string;
};

type Place = { left: number; width: number; top?: number; bottom?: number; maxHeight: number };

const GAP = 6;

/** Words to match typed letters against: the option's text, or its label when that is plain text. */
function words<T extends string | number>(o: Option<T>): string {
  if (o.text) return o.text.toLowerCase();
  return typeof o.label === 'string' || typeof o.label === 'number' ? String(o.label).toLowerCase() : String(o.value).toLowerCase();
}

export function Select<T extends string | number>({ value, options, onChange, id, label, className, style, disabled, placeholder }: Props<T>) {
  const autoId = useId();
  const listId = autoId + '-list';
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<Place | null>(null);
  const typed = useRef({ text: '', at: 0 });

  const picked = options.findIndex((o) => o.value === value);
  const current = picked >= 0 ? options[picked] : null;

  const measure = useCallback(() => {
    const b = btn.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const want = Math.min(320, options.length * 36 + 12);
    const width = Math.max(r.width, 180);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    if (below >= Math.min(want, 200) || below >= above) setPlace({ left, width, top: r.bottom + GAP, maxHeight: Math.max(120, below) });
    else setPlace({ left, width, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.max(120, above) });
  }, [options.length]);

  const show = (start?: number) => {
    if (disabled) return;
    measure();
    setActive(start ?? (picked >= 0 ? picked : nextEnabled(-1, 1)));
    setOpen(true);
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    hide();
    if (o.value !== value) onChange(o.value);
  };

  function nextEnabled(from: number, step: 1 | -1): number {
    for (let k = 1; k <= options.length; k++) {
      const i = from + step * k;
      if (i < 0 || i >= options.length) break;
      if (!options[i].disabled) return i;
    }
    return from;
  }

  // Keep the list under its button while the page scrolls or the window changes size.
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onMove = () => measure();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, measure]);

  // A press anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || list.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // The highlighted option stays in view.
  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const typeahead = (key: string) => {
    const now = Date.now();
    const t = typed.current;
    t.text = (now - t.at > 700 ? '' : t.text) + key.toLowerCase();
    t.at = now;
    const start = open ? active : picked;
    const order = options.map((_, k) => (Math.max(0, start) + k + (t.text.length === 1 ? 1 : 0)) % options.length);
    const hit = order.find((i) => !options[i].disabled && words(options[i]).startsWith(t.text));
    if (hit === undefined) return;
    if (open) setActive(hit);
    else if (options[hit].value !== value) onChange(options[hit].value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        show(k === 'ArrowUp' && picked < 0 ? nextEnabled(options.length, -1) : undefined);
      } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        typeahead(k);
      }
      return;
    }
    if (k === 'ArrowDown') { e.preventDefault(); setActive((a) => nextEnabled(a, 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive((a) => nextEnabled(a, -1)); }
    else if (k === 'Home') { e.preventDefault(); setActive(nextEnabled(-1, 1)); }
    else if (k === 'End') { e.preventDefault(); setActive(nextEnabled(options.length, -1)); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active); }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (k === 'Tab') { setOpen(false); }
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeahead(k);
  };

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={'select dd' + (className ? ' ' + className : '') + (open ? ' open' : '')}
        style={style}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKeyDown}
        onBlur={(e) => { if (!list.current?.contains(e.relatedTarget as Node)) setOpen(false); }}
      >
        <span className={'dd-value' + (current ? '' : ' dd-placeholder')}>{current ? current.label : placeholder ?? 'Pick one'}</span>
      </button>
      {open && place && createPortal(
        <ul
          ref={list}
          id={listId}
          className="dd-list"
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          style={{ left: place.left, minWidth: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
          data-up={place.bottom !== undefined ? '' : undefined}
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((o, i) => (
            <li
              key={String(o.value)}
              id={`${listId}-${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={'dd-opt' + (i === active ? ' active' : '')}
              onPointerMove={() => { if (!o.disabled && i !== active) setActive(i); }}
              onClick={() => choose(i)}
            >
              <span className="dd-label">{o.label}</span>
              {o.value === value && <Icon id="check" />}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
}

/**
 * A popover (menu, date picker) drawn in a layer above everything else, next
 * to the button that opened it, so no card or section can hide or clip it.
 * A press outside it or Escape closes it.
 */
export function Floating({ anchor, onClose, align = 'end', children }: {
  anchor: React.RefObject<HTMLElement | null>; onClose: () => void; align?: 'start' | 'end'; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  const measure = useCallback(() => {
    const a = anchor.current;
    const b = box.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const h = b?.offsetHeight ?? 0;
    const w = b?.offsetWidth ?? 0;
    const up = h > 0 && r.bottom + GAP + h > window.innerHeight - 8 && r.top - GAP - h > 8;
    const left = align === 'end' ? r.right - w : r.left;
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, [anchor, align]);

  useLayoutEffect(() => {
    measure();
    // Once more after the first paint, when its own size is known.
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={box} className="floating" style={{ ...(pos ?? { left: 0, top: 0, visibility: 'hidden' }) }}>{children}</div>,
    document.body,
  );
}

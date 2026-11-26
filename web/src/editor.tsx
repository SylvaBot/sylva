// The overlay editor: every widget on one 1920 by 1080 canvas, shown by a
// single OBS Browser Source. Changes save to a draft as you go; Publish puts
// the draft on every open overlay at once, and History brings back an
// earlier version.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { api, type CustomCode, type Goal, type SceneItem, type SceneState, type WidgetKind } from './api';
import { CodeDialog, CustomFrame, STARTER } from './customWidget';
import { useChannel } from './channel';
import { Card, sendTest, TESTS } from './pages';
import { errorText, Icon, num, useToast } from './ui';

const W = 1920;
const H = 1080;
const MIN = 40;
const SNAP = 10;
const MAX_ITEMS = 24;

interface WidgetMeta { name: string; icon: string; c: string; w: number; h: number; text: string }

export const WIDGET_META: Record<WidgetKind, WidgetMeta> = {
  alerts: { name: 'Alert box', icon: 'bell', c: 'c-sub', w: 800, h: 300, text: 'Plays your alerts one at a time.' },
  feed: { name: 'Event list', icon: 'activity', c: 'c-follow', w: 420, h: 360, text: 'The latest follows, subs, cheers and raids.' },
  latest: { name: 'Latest label', icon: 'star', c: 'c-bits', w: 480, h: 60, text: 'The latest follower, sub, gifter, cheer or raid.' },
  top: { name: 'Top label', icon: 'trophy', c: 'c-reward', w: 480, h: 60, text: 'The top cheerer or gifter this stream.' },
  goal: { name: 'Goal bar', icon: 'zap', c: 'c-raid', w: 600, h: 90, text: 'Progress toward your goal.' },
  chat: { name: 'Chat box', icon: 'message', c: 'c-gift', w: 420, h: 520, text: 'Your chat, on stream.' },
  custom: { name: 'Custom code', icon: 'code', c: 'c-tip', w: 600, h: 160, text: 'Your own HTML, CSS and JavaScript.' },
};
const ADDABLE: WidgetKind[] = ['alerts', 'feed', 'latest', 'top', 'goal', 'chat', 'custom'];
const playsAlerts = (i: SceneItem) => i.widget === 'alerts' || (i.widget === 'custom' && !!i.code?.alerts);

export const LATEST_KINDS = [
  { id: 'follow', label: 'Follower' },
  { id: 'subscriber', label: 'Sub' },
  { id: 'communityGift', label: 'Gifter' },
  { id: 'cheer', label: 'Cheer' },
  { id: 'raid', label: 'Raid' },
];
export const TOP_KINDS = [
  { id: 'cheer', label: 'Cheerer' },
  { id: 'communityGift', label: 'Gifter' },
];

type Template = { id: string; name: string; text: string; items: Omit<SceneItem, 'id'>[] };

/** Three starting points. Each replaces the draft; Undo brings it back. */
export const TEMPLATES: Template[] = [
  {
    id: 'gameplay',
    name: 'Gameplay',
    text: 'Alerts at the top, a row of labels and the goal along the bottom, the game in between.',
    items: [
      { widget: 'alerts', x: 560, y: 40, w: 800, h: 260 },
      { widget: 'latest', kind: 'follow', x: 24, y: 1000, w: 440, h: 60 },
      { widget: 'latest', kind: 'subscriber', x: 480, y: 1000, w: 440, h: 60 },
      { widget: 'top', kind: 'cheer', x: 936, y: 1000, w: 440, h: 60 },
      { widget: 'goal', x: 1392, y: 984, w: 504, h: 76 },
    ],
  },
  {
    id: 'chatting',
    name: 'Just chatting',
    text: 'Chat down the right, recent events on the left, alerts and the goal in the middle.',
    items: [
      { widget: 'chat', limit: 14, x: 1476, y: 120, w: 420, h: 840 },
      { widget: 'feed', limit: 6, x: 24, y: 120, w: 420, h: 420 },
      { widget: 'alerts', x: 560, y: 60, w: 800, h: 280 },
      { widget: 'goal', x: 660, y: 980, w: 600, h: 80 },
    ],
  },
  {
    id: 'minimal',
    name: 'Minimal',
    text: 'Just alerts in the middle and a small goal in the corner.',
    items: [
      { widget: 'alerts', x: 560, y: 390, w: 800, h: 300 },
      { widget: 'goal', x: 1296, y: 24, w: 600, h: 80 },
    ],
  },
];

let idCounter = 0;
const newId = (widget: WidgetKind) => `${widget}-${Date.now().toString(36)}${(idCounter++).toString(36)}`;
const fromTemplate = (t: Template): SceneItem[] => t.items.map((i) => ({ ...i, id: newId(i.widget) }));
/** The same layout, whatever order the fields came in and with the server's defaults filled in. */
const norm = (items: SceneItem[]) => JSON.stringify(items.map((i) => [
  i.id, i.widget, i.x, i.y, i.w, i.h,
  i.widget === 'latest' ? i.kind ?? 'follow' : i.widget === 'top' ? i.kind ?? 'cheer' : null,
  i.widget === 'feed' ? i.limit ?? 5 : i.widget === 'chat' ? i.limit ?? 12 : null,
  i.widget === 'custom' ? JSON.stringify(i.code ?? null) : null,
]));
const same = (a: SceneItem[], b: SceneItem[]) => norm(a) === norm(b);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Keep an item whole and on the canvas. */
function fit(it: SceneItem): SceneItem {
  const w = Math.round(clamp(it.w, MIN, W));
  const h = Math.round(clamp(it.h, MIN, H));
  return { ...it, w, h, x: Math.round(clamp(it.x, 0, W - w)), y: Math.round(clamp(it.y, 0, H - h)) };
}

/** Where a moving edge may snap: the canvas edges and middle, and every other widget's edges and middle. */
function targets(items: SceneItem[], skip: string, axis: 'x' | 'y') {
  const size = axis === 'x' ? W : H;
  const out = [0, size / 2, size];
  for (const o of items) {
    if (o.id === skip) continue;
    const p = axis === 'x' ? o.x : o.y;
    const l = axis === 'x' ? o.w : o.h;
    out.push(p, p + l / 2, p + l);
  }
  return out;
}

/** The closest snap for any of these edges, as the shift to apply and the line to draw. */
function snapShift(edges: number[], lines: number[]): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  for (const e of edges) {
    for (const l of lines) {
      const d = l - e;
      if (Math.abs(d) <= SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: l };
    }
  }
  return best;
}

type Drag = {
  id: string;
  mode: 'move' | 'nw' | 'ne' | 'sw' | 'se';
  px: number; py: number;
  start: SceneItem;
  before: SceneItem[];
};

export function SceneEditor({ url }: { url: string | null }) {
  const ch = useChannel();
  const toast = useToast();
  const [items, setItems] = useState<SceneItem[] | null>(null);
  const [server, setServer] = useState<SceneState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [past, setPast] = useState<SceneItem[][]>([]);
  const [future, setFuture] = useState<SceneItem[][]>([]);
  const [save, setSave] = useState<'saved' | 'saving' | 'waiting' | 'error'>('saved');
  const [publishing, setPublishing] = useState(false);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [goal, setGoal] = useState<Goal | null>(null);
  const [menu, setMenu] = useState<null | 'add' | 'templates' | 'try'>(null);
  const [showHistory, setShowHistory] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const drag = useRef<Drag | null>(null);
  // The latest items, for pointer handlers that may run before a re-render.
  const itemsRef = useRef<SceneItem[] | null>(null);
  itemsRef.current = items;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSaved = useRef<string>('');

  useEffect(() => {
    api.scene(ch.key).then((s) => {
      setServer(s);
      setItems(s.draft.items);
      lastSaved.current = norm(s.draft.items);
    }).catch((x) => toast('Could not load the editor: ' + errorText(x), true));
    api.widgetSettings(ch.key).then((s) => setGoal(s.goal ?? null)).catch(() => setGoal(null));
  }, [ch.key, toast]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / W));
    ro.observe(el);
    setScale(el.clientWidth / W);
    return () => ro.disconnect();
  }, [items === null]);

  // Save the draft a moment after the last change.
  const flush = useCallback(async (next: SceneItem[]) => {
    clearTimeout(saveTimer.current);
    const body = norm(next);
    if (body === lastSaved.current) { setSave('saved'); return true; }
    setSave('saving');
    try {
      const s = await api.saveScene(ch.key, { items: next });
      lastSaved.current = body;
      setServer(s);
      setSave('saved');
      return true;
    } catch (x) {
      setSave('error');
      toast('Could not save the layout: ' + errorText(x), true);
      return false;
    }
  }, [ch.key, toast]);

  useEffect(() => {
    if (!items || drag.current) return;
    if (norm(items) === lastSaved.current) { setSave('saved'); return; }
    setSave('waiting');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(items), 700);
  }, [items, flush]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  /** A change that Undo can take back. */
  const commit = useCallback((next: SceneItem[], before?: SceneItem[]) => {
    const prev = before ?? items ?? [];
    if (!same(prev, next)) {
      setPast((p) => [...p.slice(-49), prev]);
      setFuture([]);
    }
    setItems(next);
  }, [items]);

  const undo = useCallback(() => {
    if (!past.length || !items) return;
    setFuture((f) => [items, ...f]);
    setItems(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  }, [past, items]);
  const redo = useCallback(() => {
    if (!future.length || !items) return;
    setPast((p) => [...p, items]);
    setItems(future[0]);
    setFuture((f) => f.slice(1));
  }, [future, items]);

  // Undo and redo from the keyboard while the editor is in use.
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !editorRef.current?.contains(document.activeElement)) return;
      const t = e.target as HTMLElement;
      if (t.matches('input, select, textarea')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const update = (id: string, patch: Partial<SceneItem>) => {
    if (!items) return;
    commit(items.map((it) => (it.id === id ? fit({ ...it, ...patch }) : it)));
  };

  const add = (widget: WidgetKind) => {
    if (!items) return;
    const m = WIDGET_META[widget];
    const n = items.length;
    const it = fit({
      id: newId(widget), widget, w: m.w, h: m.h,
      x: (W - m.w) / 2 + (n % 5) * 24, y: (H - m.h) / 2 + (n % 5) * 24,
      kind: widget === 'latest' ? 'follow' : widget === 'top' ? 'cheer' : undefined,
      limit: widget === 'feed' ? 5 : widget === 'chat' ? 12 : undefined,
      code: widget === 'custom' ? { ...STARTER } : undefined,
    });
    commit([...items, it]);
    setSelected(it.id);
    setMenu(null);
  };

  const remove = (id: string) => {
    if (!items) return;
    commit(items.filter((it) => it.id !== id));
    setSelected(null);
  };

  const reorder = (id: string, dir: 1 | -1) => {
    if (!items) return;
    const i = items.findIndex((it) => it.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  };

  const applyTemplate = (t: Template) => {
    if (!items) return;
    commit(fromTemplate(t));
    setSelected(null);
    setMenu(null);
    toast(`${t.name} template applied. Undo brings back what you had.`);
  };

  /* ---------- Dragging and resizing ---------- */

  const begin = (e: ReactPointerEvent, it: SceneItem, mode: Drag['mode']) => {
    if (e.button !== 0 || !items) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(it.id);
    const el = e.currentTarget as HTMLElement;
    // preventDefault above stops the browser focusing the widget, so focus it
    // here: the arrow keys and Delete then work on what was just clicked.
    el.closest<HTMLElement>('.slot')?.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    drag.current = { id: it.id, mode, px: e.clientX, py: e.clientY, start: it, before: items };
  };

  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    const items = itemsRef.current;
    if (!d || !items) return;
    const dx = (e.clientX - d.px) / scale;
    const dy = (e.clientY - d.py) / scale;
    const s = d.start;
    let r = { x: s.x, y: s.y, w: s.w, h: s.h };
    const free = e.altKey;
    const gx = targets(items, d.id, 'x');
    const gy = targets(items, d.id, 'y');
    const g: { x?: number; y?: number } = {};
    if (d.mode === 'move') {
      r.x = clamp(s.x + dx, 0, W - s.w);
      r.y = clamp(s.y + dy, 0, H - s.h);
      if (!free) {
        const sx = snapShift([r.x, r.x + r.w / 2, r.x + r.w], gx);
        if (sx) { r.x += sx.d; g.x = sx.at; }
        const sy = snapShift([r.y, r.y + r.h / 2, r.y + r.h], gy);
        if (sy) { r.y += sy.d; g.y = sy.at; }
      }
    } else {
      const west = d.mode === 'nw' || d.mode === 'sw';
      const north = d.mode === 'nw' || d.mode === 'ne';
      let left = s.x, right = s.x + s.w, top = s.y, bottom = s.y + s.h;
      if (west) left = clamp(s.x + dx, 0, right - MIN); else right = clamp(right + dx, left + MIN, W);
      if (north) top = clamp(s.y + dy, 0, bottom - MIN); else bottom = clamp(bottom + dy, top + MIN, H);
      if (!free) {
        const sx = snapShift([west ? left : right], gx);
        if (sx) { if (west) left = Math.min(left + sx.d, right - MIN); else right = Math.max(right + sx.d, left + MIN); g.x = sx.at; }
        const sy = snapShift([north ? top : bottom], gy);
        if (sy) { if (north) top = Math.min(top + sy.d, bottom - MIN); else bottom = Math.max(bottom + sy.d, top + MIN); g.y = sy.at; }
      }
      r = { x: left, y: top, w: right - left, h: bottom - top };
    }
    setGuides(g);
    const next = items.map((it) => (it.id === d.id ? fit({ ...it, ...r }) : it));
    itemsRef.current = next;
    setItems(next);
  };

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setGuides({});
    const items = itemsRef.current;
    if (items && !same(items, d.before)) {
      setPast((p) => [...p.slice(-49), d.before]);
      setFuture([]);
    }
    // A new array, so the draft saves now that the drag is over.
    if (items) setItems([...items]);
  };

  const onItemKey = (e: KeyboardEvent, it: SceneItem) => {
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      const [mx, my] = moves[e.key];
      update(it.id, { x: it.x + mx, y: it.y + my });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(it.id);
    } else if (e.key === 'Escape') {
      setSelected(null);
      (e.currentTarget as HTMLElement).blur();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSelected(it.id);
    }
  };

  /* ---------- Publishing ---------- */

  const publish = async () => {
    if (!items) return;
    setPublishing(true);
    try {
      if (!(await flush(items))) return;
      const s = await api.publishScene(ch.key);
      setServer(s);
      toast(`Published version ${s.published?.version}. Your overlay updated.`);
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setPublishing(false);
    }
  };

  const restore = async (version: number) => {
    if (!items) return;
    try {
      const s = await api.restoreScene(ch.key, version);
      commit(s.draft.items, items);
      lastSaved.current = norm(s.draft.items);
      setServer(s);
      setSave('saved');
      setSelected(null);
      toast(`Version ${version} is back in your draft. Publish to show it.`);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const copyLink = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url + '&scene');
      try { localStorage.setItem('sylva.overlayCopied', '1'); } catch { /* private window */ }
      toast('Overlay link copied');
    } catch {
      toast('Your browser blocked copying. Open the overlay and copy its address instead.', true);
    }
  };

  const published = server?.published ?? null;
  const changed = !!items && (published ? !same(items, published.scene.items) : items.length > 0);
  const sel = items?.find((it) => it.id === selected) ?? null;
  const hasAlerts = !!items?.some(playsAlerts);

  const status = save === 'error' ? 'Not saved'
    : save !== 'saved' ? 'Saving'
    : !published && !items?.length ? 'Empty'
    : !published ? 'Draft saved, not published yet'
    : changed ? 'Draft saved, not published'
    : `Published, version ${published.version}`;

  if (!items) {
    return <Card id="editor" title="Overlay editor"><div className="card-body"><p className="card-text">Loading the editor</p></div></Card>;
  }

  return (
    <Card
      id="editor"
      title="Overlay editor"
      className="editor-card"
      desc="Place every widget on one 1920 × 1080 canvas. Drag to move, pull a corner to resize, hold Alt to place freely."
    >
      <div className="editor" ref={editorRef}>
        <div className="editor-bar" role="toolbar" aria-label="Editor">
          <Popover
            open={menu === 'add'}
            onOpen={(o) => setMenu(o ? 'add' : null)}
            label={<><Icon id="plus" />Add widget</>}
            disabled={items.length >= MAX_ITEMS}
          >
            {ADDABLE.map((k) => {
              const m = WIDGET_META[k];
              const taken = k === 'alerts' && hasAlerts;
              return (
                <button key={k} className={'menu-item ' + m.c} type="button" role="menuitem" disabled={taken} onClick={() => add(k)}>
                  <span className="tile sm"><Icon id={m.icon} /></span>
                  <span><b>{m.name}</b><small>{taken ? 'Already on the canvas' : m.text}</small></span>
                </button>
              );
            })}
          </Popover>
          <Popover open={menu === 'templates'} onOpen={(o) => setMenu(o ? 'templates' : null)} label={<><Icon id="template" />Templates</>}>
            {TEMPLATES.map((t) => (
              <button key={t.id} className="menu-item" type="button" role="menuitem" onClick={() => applyTemplate(t)}>
                <TemplateThumb t={t} />
                <span><b>{t.name}</b><small>{t.text}</small></span>
              </button>
            ))}
          </Popover>
          <span className="bar-sep" />
          <button className="icon-btn" type="button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}><Icon id="undo" /></button>
          <button className="icon-btn" type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={redo}><Icon id="redo" /></button>
          <span className="bar-sep" />
          <Popover open={menu === 'try'} onOpen={(o) => setMenu(o ? 'try' : null)} label={<><Icon id="sparkles" />Try it</>}>
            {TESTS.map((t) => (
              <button
                key={t.kind}
                className={'menu-item ' + t.c}
                type="button"
                role="menuitem"
                onClick={async () => {
                  setMenu(null);
                  try {
                    const r = await sendTest(ch.key, t);
                    toast(r.alert ? `Test ${t.label.toLowerCase()} sent to your overlay` : `${t.label} alerts are off, so only the widgets got the test`);
                  } catch (x) {
                    toast(errorText(x), true);
                  }
                }}
              >
                <span className="tile sm"><Icon id={t.icon} /></span><span><b>{t.label}</b></span>
              </button>
            ))}
          </Popover>
          <span className="spacer" />
          <span className={'save-state' + (save === 'error' ? ' bad' : changed ? ' pending' : '')} role="status">{status}</span>
          <button className="btn primary" type="button" disabled={publishing || save === 'error' || !changed} onClick={publish}>
            <Icon id="send" />{publishing ? 'Publishing' : 'Publish'}
          </button>
        </div>

        <div className="editor-main">
          <div className="canvas-wrap">
            <div
              ref={stage}
              className="canvas"
              onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
              aria-label="Overlay canvas, 1920 by 1080"
              role="group"
            >
              {items.map((it) => {
                const m = WIDGET_META[it.widget];
                const isSel = it.id === selected;
                return (
                  <div
                    key={it.id}
                    className={'slot ' + m.c + (isSel ? ' selected' : '') + (it.y * scale < 22 ? ' tag-inside' : '')}
                    style={{ left: it.x * scale, top: it.y * scale, width: it.w * scale, height: it.h * scale }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSel}
                    aria-label={`${m.name}${it.kind ? ` (${kindLabel(it)})` : ''}, at ${it.x}, ${it.y}, ${it.w} by ${it.h}. Arrow keys move it.`}
                    onPointerDown={(e) => begin(e, it, 'move')}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={end}
                    onKeyDown={(e) => onItemKey(e, it)}
                    onFocus={() => setSelected(it.id)}
                  >
                    <div className="slot-preview" style={{ width: it.w, height: it.h, transform: `scale(${scale})` }} aria-hidden="true">
                      <Preview it={it} goal={goal} />
                    </div>
                    <span className="slot-tag" aria-hidden="true"><Icon id={m.icon} />{m.name}</span>
                    {isSel && (['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                      <span
                        key={h}
                        className={'handle ' + h}
                        aria-hidden="true"
                        onPointerDown={(e) => begin(e, it, h)}
                        onPointerMove={move}
                        onPointerUp={end}
                        onPointerCancel={end}
                      />
                    ))}
                  </div>
                );
              })}
              {guides.x !== undefined && <span className="guide v" style={{ left: guides.x * scale }} />}
              {guides.y !== undefined && <span className="guide h" style={{ top: guides.y * scale }} />}
              {items.length === 0 && (
                <div className="canvas-empty">
                  <p><b>Start with a template</b> or add widgets one by one.</p>
                  <div className="template-row">
                    {TEMPLATES.map((t) => (
                      <button key={t.id} className="template-pick" type="button" onClick={() => applyTemplate(t)}>
                        <TemplateThumb t={t} />
                        <b>{t.name}</b>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="inspector" role="group" aria-label="Selected widget">
            {sel ? (
              <Inspector
                it={sel}
                canPlayAlerts={!items.some((i) => i.id !== sel.id && playsAlerts(i))}
                first={items[0]?.id === sel.id}
                last={items[items.length - 1]?.id === sel.id}
                onChange={(p) => update(sel.id, p)}
                onRemove={() => remove(sel.id)}
                onOrder={(d) => reorder(sel.id, d)}
              />
            ) : (
              <>
                <h3>Widgets</h3>
                {items.length === 0
                  ? <p className="field-hint">Nothing on the canvas yet.</p>
                  : (
                    <ul className="layers">
                      {[...items].reverse().map((it) => {
                        const m = WIDGET_META[it.widget];
                        return (
                          <li key={it.id}>
                            <button type="button" className={'layer ' + m.c} onClick={() => setSelected(it.id)}>
                              <span className="tile sm"><Icon id={m.icon} /></span>
                              <span>{m.name}{it.kind ? <small> {kindLabel(it)}</small> : null}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                <p className="field-hint">Select a widget to move, resize or change it. Ones higher in this list sit on top.</p>
              </>
            )}
          </div>
        </div>

        <div className="editor-foot">
          <div className="overlay-link">
            <div>
              <b>Your overlay link</b>
              <span>In OBS, add one Browser Source with this link at 1920 × 1080. It shows what you publish here.</span>
            </div>
            <div className="widget-actions">
              <button className="btn sm" type="button" disabled={!url} onClick={copyLink}><Icon id="copy" />Copy link</button>
              <a className="btn sm" href={url ? url + '&scene&debug' : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!url}><Icon id="external" />Open</a>
            </div>
          </div>
          <div className="history">
            <button className="btn ghost sm" type="button" aria-expanded={showHistory} aria-controls="scene-history" onClick={() => setShowHistory((v) => !v)}>
              <Icon id="history" />History{server?.versions.length ? ` (${server.versions.length})` : ''}
            </button>
            {showHistory && (
              <div id="scene-history">
                {!server?.versions.length ? <p className="field-hint">Nothing published yet.</p> : (
                  <ul className="versions">
                    {server.versions.map((v, i) => (
                      <li key={v.version}>
                        <span>
                          <b>Version {v.version}</b>{i === 0 && <span className="pill-live">Live</span>}
                          <small>{new Date(v.publishedAt).toLocaleString()} · {num(v.items)} {v.items === 1 ? 'widget' : 'widgets'}</small>
                        </span>
                        <button className="btn sm" type="button" onClick={() => restore(v.version)}>Restore to draft</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function kindLabel(it: SceneItem) {
  const list = it.widget === 'top' ? TOP_KINDS : LATEST_KINDS;
  return list.find((k) => k.id === it.kind)?.label ?? '';
}

function Popover({ open, onOpen, label, disabled, children }: {
  open: boolean; onOpen: (open: boolean) => void; label: ReactNode; disabled?: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onOpen(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { onOpen(false); ref.current?.querySelector('button')?.focus(); } };
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    ref.current?.querySelector<HTMLElement>('[role=menu] button:not(:disabled)')?.focus();
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', esc); };
  }, [open, onOpen]);
  return (
    <div className="popover" ref={ref}>
      <button className="btn" type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => onOpen(!open)}>
        {label}<Icon id="chevron" />
      </button>
      {open && <div className="menu" role="menu">{children}</div>}
    </div>
  );
}

function TemplateThumb({ t }: { t: Template }) {
  return (
    <span className="thumb" aria-hidden="true">
      {t.items.map((i, n) => (
        <span
          key={n}
          className={WIDGET_META[i.widget].c}
          style={{ left: `${(i.x / W) * 100}%`, top: `${(i.y / H) * 100}%`, width: `${(i.w / W) * 100}%`, height: `${(i.h / H) * 100}%` }}
        />
      ))}
    </span>
  );
}

function Inspector({ it, first, last, canPlayAlerts, onChange, onRemove, onOrder }: {
  it: SceneItem; first: boolean; last: boolean; canPlayAlerts: boolean;
  onChange: (p: Partial<SceneItem>) => void; onRemove: () => void; onOrder: (d: 1 | -1) => void;
}) {
  const m = WIDGET_META[it.widget];
  const numField = (label: string, k: 'x' | 'y' | 'w' | 'h') => (
    <label className="field">
      {label}
      <NumberInput value={it[k]} min={k === 'w' || k === 'h' ? MIN : 0} max={k === 'x' || k === 'w' ? W : H} onCommit={(v) => onChange({ [k]: v })} />
    </label>
  );
  return (
    <>
      <div className={'insp-head ' + m.c}>
        <span className="tile sm"><Icon id={m.icon} /></span>
        <div><h3>{m.name}</h3><p className="field-hint">{m.text}</p></div>
      </div>
      <div className="insp-grid">
        {numField('X', 'x')}
        {numField('Y', 'y')}
        {numField('Width', 'w')}
        {numField('Height', 'h')}
      </div>
      {(it.widget === 'latest' || it.widget === 'top') && (
        <label className="field">
          Shows
          <select className="select" value={it.kind ?? ''} onChange={(e) => onChange({ kind: e.target.value })}>
            {(it.widget === 'top' ? TOP_KINDS : LATEST_KINDS).map((k) => (
              <option key={k.id} value={k.id}>{it.widget === 'top' ? `Top ${k.label.toLowerCase()} this stream` : `Latest ${k.label.toLowerCase()}`}</option>
            ))}
          </select>
        </label>
      )}
      {(it.widget === 'feed' || it.widget === 'chat') && (
        <label className="field">
          {it.widget === 'feed' ? 'Events shown' : 'Messages shown'}
          <NumberInput value={it.limit ?? (it.widget === 'feed' ? 5 : 12)} min={1} max={it.widget === 'feed' ? 20 : 30} onCommit={(v) => onChange({ limit: v })} />
        </label>
      )}
      {it.widget === 'goal' && <p className="field-hint">Set the goal itself in the Goal card below.</p>}
      {it.widget === 'custom' && <CustomInspector it={it} canPlayAlerts={canPlayAlerts} onChange={(code) => onChange({ code })} />}
      <div className="insp-actions">
        <button className="btn sm" type="button" disabled={last} onClick={() => onOrder(1)}>Bring forward</button>
        <button className="btn sm" type="button" disabled={first} onClick={() => onOrder(-1)}>Send backward</button>
        <button className="btn sm danger" type="button" onClick={onRemove}><Icon id="trash" />Remove</button>
      </div>
    </>
  );
}

function CustomInspector({ it, canPlayAlerts, onChange }: { it: SceneItem; canPlayAlerts: boolean; onChange: (c: CustomCode) => void }) {
  const [open, setOpen] = useState(false);
  const code = it.code ?? STARTER;
  return (
    <>
      <p className="field-hint">
        <b>{code.name || 'Custom widget'}</b>{code.alerts ? ', plays alerts' : ''}. It runs in a sandbox on your overlay, so it cannot reach your Sylva account.
      </p>
      <button className="btn sm" type="button" onClick={() => setOpen(true)}><Icon id="code" />Edit code</button>
      {open && (
        <CodeDialog
          initial={code}
          width={it.w}
          height={it.h}
          canPlayAlerts={canPlayAlerts}
          onClose={() => setOpen(false)}
          onSave={(c) => { onChange(c); setOpen(false); }}
        />
      )}
    </>
  );
}

/** A number box that applies on Enter or when it loses focus. */
function NumberInput({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const apply = () => {
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) { setText(String(value)); return; }
    const c = Math.round(clamp(v, min, max));
    setText(String(c));
    if (c !== value) onCommit(c);
  };
  return (
    <input
      className="input"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
    />
  );
}

/* ---------- What each widget looks like on the canvas ---------- */

const SAMPLE_FEED = [
  { c: 'c-sub', who: 'Juniper', what: 'resubscribed, 6 months' },
  { c: 'c-bits', who: 'Rowan', what: 'cheered 500 bits' },
  { c: 'c-follow', who: 'Maple', what: 'followed' },
  { c: 'c-raid', who: 'Hazel', what: 'raided with 42 viewers' },
  { c: 'c-gift', who: 'Aspen', what: 'gifted 5 subs' },
  { c: 'c-follow', who: 'Cedar', what: 'followed' },
];
const SAMPLE_CHAT = [
  ['Maple', 'that was so clean'], ['Rowan', 'GG'], ['Juniper', 'hi chat!'], ['Hazel', 'raid incoming'],
  ['Aspen', 'what game is next?'], ['Cedar', 'lets go'], ['Willow', 'the new overlay looks great'],
];
const LATEST_SAMPLE: Record<string, [string, string, string?]> = {
  follow: ['c-follow', 'Maple'], subscriber: ['c-sub', 'Juniper'], communityGift: ['c-gift', 'Aspen', '5'],
  cheer: ['c-bits', 'Rowan', '500'], raid: ['c-raid', 'Hazel', '42'],
};

function Preview({ it, goal }: { it: SceneItem; goal: Goal | null }) {
  const limit = it.limit ?? (it.widget === 'feed' ? 5 : 12);
  switch (it.widget) {
    case 'alerts':
      return (
        <div className="pv-stage">
          <div className="pv-card c-sub">
            <div className="pv-label">New subscriber</div>
            <div className="pv-name">Juniper</div>
            <div className="pv-detail">Thanks for subscribing!</div>
          </div>
        </div>
      );
    case 'feed':
      return (
        <div className="pv-list">
          {Array.from({ length: limit }, (_, i) => SAMPLE_FEED[i % SAMPLE_FEED.length]).map((r, i) => (
            <div key={i} className={'pv-row ' + r.c}><span className="pv-dot" /><span><b>{r.who}</b> {r.what}</span></div>
          ))}
        </div>
      );
    case 'latest':
    case 'top': {
      const k = it.kind ?? (it.widget === 'top' ? 'cheer' : 'follow');
      const [c, who, amount] = LATEST_SAMPLE[k] ?? LATEST_SAMPLE.follow;
      const label = it.widget === 'top'
        ? (k === 'cheer' ? 'Top cheer' : 'Top gifter')
        : ({ follow: 'Latest follower', subscriber: 'Latest sub', communityGift: 'Latest gifter', cheer: 'Latest cheer', raid: 'Latest raid' } as Record<string, string>)[k];
      return (
        <div className={'pv-label-box ' + c}>
          <span className="pv-label">{label}</span><span className="pv-who">{who}</span>{amount && <span className="pv-amount">{amount}</span>}
        </div>
      );
    }
    case 'goal': {
      const g = goal ?? { title: 'Sub goal', kind: 'subs', target: 50 };
      const cur = Math.round(g.target * 0.36);
      return (
        <div className={'pv-goal ' + (g.kind === 'follows' ? 'c-follow' : g.kind === 'bits' ? 'c-bits' : 'c-sub')}>
          <div className="pv-goal-top"><span>{g.title}{goal ? '' : ' (example)'}</span><span><b>{num(cur)}</b> / {num(g.target)}</span></div>
          <div className="pv-track"><div style={{ width: '36%' }} /></div>
        </div>
      );
    }
    case 'chat':
      return (
        <div className="pv-chat">
          {Array.from({ length: Math.min(limit, 12) }, (_, i) => SAMPLE_CHAT[i % SAMPLE_CHAT.length]).map(([who, msg], i) => (
            <div key={i} className="pv-line"><b>{who}</b>{msg}</div>
          ))}
        </div>
      );
    case 'custom':
      return it.code ? <CustomFrame code={it.code} /> : null;
    default:
      return null;
  }
}


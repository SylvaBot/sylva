// Custom code widgets: the streamer's own HTML, CSS and JavaScript, run in a
// sandboxed frame (/overlay-frame) on stream and in the editor alike. The
// frame takes the code and live data by postMessage; see
// workers/edge/overlay/frame.html for the API the code gets.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CustomCode } from './api';
import { Icon } from './ui';

export const STARTER: CustomCode = {
  name: 'My widget',
  html: '<div class="box">\n  <span class="label">Latest follower</span>\n  <b id="who">Nobody yet</b>\n</div>',
  css: '.box {\n  display: flex; flex-direction: column; justify-content: center; height: 100vh;\n  padding: 0 24px; box-sizing: border-box; border-radius: 12px;\n  font: 600 28px/1.3 Inter, system-ui, sans-serif; color: #fff;\n  background: {{background}};\n}\n.label { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: {{accent}}; }\n.pop { animation: pop .5s cubic-bezier(.2, .8, .2, 1); }\n@keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.97); } }',
  js: "// Sylva.on('follow', fn) runs for each new follower. Also 'subscriber',\n// 'cheer', 'raid', 'chat', 'event' (all of them) and 'data'.\nconst who = document.getElementById('who');\nconst show = (name) => {\n  who.textContent = name;\n  who.classList.remove('pop');\n  void who.offsetWidth;\n  who.classList.add('pop');\n};\nSylva.on('data', (d) => {\n  const f = d.latest.find((e) => e.kind === 'follow');\n  if (f) who.textContent = f.actor.displayName;\n});\nSylva.on('follow', (e) => show(e.actor.displayName));",
  fields: '{\n  "accent": { "type": "colorpicker", "label": "Accent", "value": "#3ecf74" },\n  "background": { "type": "colorpicker", "label": "Background", "value": "rgba(22, 22, 24, 0.85)" }\n}',
  values: {},
  alerts: false,
};

const actor = (name: string, id: string) => ({ id, login: name.toLowerCase(), displayName: name });
let seq = 1_000_000;
export const sampleEvent = (kind: string) => {
  const base = { seq: ++seq, receivedAt: Date.now(), kind };
  switch (kind) {
    case 'follow': return { ...base, actor: actor('Maple', '1') };
    case 'subscriber': return { ...base, actor: actor('Juniper', '2'), amount: 3, message: 'Three months!' };
    case 'communityGift': return { ...base, actor: actor('Aspen', '3'), amount: 5 };
    case 'cheer': return { ...base, actor: actor('Rowan', '4'), amount: 500, message: 'Cheer500 great stream' };
    case 'raid': return { ...base, actor: actor('Hazel', '5'), amount: 42 };
    default: return { ...base, kind: 'chat', actor: actor('Willow', '6'), message: 'hello chat!' };
  }
};
const SAMPLE_DATA = {
  recent: [sampleEvent('raid'), sampleEvent('cheer'), sampleEvent('subscriber'), sampleEvent('follow')],
  latest: ['follow', 'subscriber', 'communityGift', 'cheer', 'raid'].map(sampleEvent),
  top: [{ kind: 'cheer', name: 'Rowan', amount: 500 }],
  chat: [sampleEvent('chat')],
  goal: null,
};
const VIEW: Record<string, { label: string; name: string; detail: string }> = {
  follow: { label: 'New follower', name: 'Maple', detail: '' },
  subscriber: { label: 'New subscriber', name: 'Juniper', detail: '3 months' },
  communityGift: { label: 'Gifted subs', name: 'Aspen', detail: 'gave 5 subs' },
  cheer: { label: 'Cheer', name: 'Rowan', detail: '500 bits' },
  raid: { label: 'Raid', name: 'Hazel', detail: 'with 42 viewers' },
};

type Send = (m: Record<string, unknown>) => void;

/** One custom widget in a sandboxed frame, fed with sample data. */
export function CustomFrame({ code, bind, interactive }: { code: CustomCode; bind?: (send: Send | null) => void; interactive?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  // A new frame whenever the code changes, so the code runs from scratch.
  const key = useMemo(() => JSON.stringify([code.html, code.css, code.js, code.fields, code.values, code.alerts]), [code]);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ready = false;
    const send: Send = (m) => frame.contentWindow?.postMessage({ sylva: true, ...m }, '*');
    const onMessage = (m: MessageEvent) => {
      if (m.source !== frame.contentWindow || !m.data || m.data.sylvaFrame !== true) return;
      if (m.data.type === 'ready' && !ready) {
        ready = true;
        send({
          type: 'load', html: code.html, css: code.css, js: code.js, fields: code.fields,
          values: code.values, alerts: code.alerts, data: SAMPLE_DATA, channel: '', preview: true,
        });
        bind?.(send);
      }
    };
    addEventListener('message', onMessage);
    return () => { removeEventListener('message', onMessage); bind?.(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <iframe
      key={key}
      ref={ref}
      className="custom-frame"
      src="/overlay-frame"
      sandbox="allow-scripts"
      title={code.name || 'Custom widget'}
      tabIndex={interactive ? 0 : -1}
    />
  );
}

/** Send a test event (or, in alert mode, a test alert) to a preview. */
export function testEvent(send: Send, kind: string, alerts: boolean) {
  const e = sampleEvent(kind);
  if (alerts && kind !== 'chat') {
    send({ type: 'alert', id: e.seq, event: e, view: { ...VIEW[kind], message: (e as { message?: string }).message, durationMs: 5000 } });
  } else {
    send({ type: 'event', event: e });
  }
}

interface Field {
  type?: string; label?: string; value?: unknown; options?: Record<string, string>;
  min?: number; max?: number; step?: number; group?: string;
}

function parseFields(text: string): { fields: Record<string, Field>; error: string | null } {
  if (!text.trim()) return { fields: {}, error: null };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { fields: {}, error: 'Fields must be a JSON object.' };
    return { fields: v as Record<string, Field>, error: null };
  } catch (x) {
    return { fields: {}, error: `Fields are not valid JSON: ${(x as Error).message}` };
  }
}

const TABS = ['html', 'css', 'js', 'fields'] as const;
type Tab = typeof TABS[number];
const TAB_NAMES: Record<Tab, string> = { html: 'HTML', css: 'CSS', js: 'JavaScript', fields: 'Fields' };
const TESTS = ['follow', 'subscriber', 'communityGift', 'cheer', 'raid', 'chat'] as const;
const TEST_NAMES: Record<string, string> = { follow: 'Follow', subscriber: 'Sub', communityGift: 'Gift', cheer: 'Cheer', raid: 'Raid', chat: 'Chat' };

/** The code editor: tabs for each part, the settings form, a live preview. */
export function CodeDialog({ initial, width, height, canPlayAlerts, onSave, onClose }: {
  initial: CustomCode; width: number; height: number; canPlayAlerts: boolean;
  onSave: (c: CustomCode) => void; onClose: () => void;
}) {
  const [code, setCode] = useState<CustomCode>(initial);
  const [tab, setTab] = useState<Tab>('html');
  const [shown, setShown] = useState<CustomCode>(initial);
  const send = useRef<Send | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const { fields, error } = parseFields(code.fields);
  const bytes = new Blob([code.html, code.css, code.js, code.fields, JSON.stringify(code.values)]).size;
  const tooBig = bytes > 100_000;

  // The preview catches up a moment after typing stops.
  useEffect(() => {
    const t = window.setTimeout(() => setShown(code), 700);
    return () => window.clearTimeout(t);
  }, [code]);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  // Tab types a tab; Shift+Tab still leaves the box.
  const onCodeKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const t = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = t;
    const next = value.slice(0, a) + '  ' + value.slice(b);
    setCode((c) => ({ ...c, [tab]: next }));
    requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 2; });
  };

  const setValue = (k: string, v: unknown) => setCode((c) => ({ ...c, values: { ...c.values, [k]: v } }));
  const valueOf = (k: string, f: Field) => (k in code.values ? code.values[k] : f.value);
  const scale = Math.min(1, 520 / width, 300 / height);

  return (
    <div className="code-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="code-dialog" role="dialog" aria-modal="true" aria-label="Edit custom widget" tabIndex={-1} ref={dialog}>
        <div className="code-head">
          <label className="field code-name" htmlFor="code-name">
            <span>Name</span>
            <input id="code-name" className="input" maxLength={40} value={code.name} onChange={(e) => setCode({ ...code, name: e.target.value })} />
          </label>
          <div className="code-head-actions">
            <button className="btn ghost sm" type="button" onClick={onClose}>Cancel</button>
            <button className="btn primary sm" type="button" disabled={!!error || tooBig} onClick={() => onSave(code)}>Apply</button>
          </div>
        </div>
        <div className="code-body">
          <div className="code-edit">
            <div className="code-tabs" role="tablist" aria-label="Code">
              {TABS.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={'code-tab' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>
                  {TAB_NAMES[t]}
                </button>
              ))}
            </div>
            <textarea
              className="code-area"
              aria-label={TAB_NAMES[tab]}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              value={code[tab]}
              onChange={(e) => setCode({ ...code, [tab]: e.target.value })}
              onKeyDown={onCodeKey}
            />
            <p className={'field-hint' + (error || tooBig ? ' bad-text' : '')}>
              {error ?? (tooBig ? `This widget is ${Math.round(bytes / 1000)} KB; the most is 100 KB.` : tab === 'fields'
                ? 'The settings form, in StreamElements’ format. Use a field in your code as {{name}}, or read Sylva.fields.name.'
                : 'Plain HTML, CSS and JavaScript, the way OBS runs them. Animate transform and opacity for the smoothest motion.')}
            </p>
          </div>
          <div className="code-side">
            <div className="code-preview" style={{ width: width * scale, height: height * scale }}>
              <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0', position: 'absolute', left: 0, top: 0 }}>
                <CustomFrame code={shown} interactive bind={(s) => { send.current = s; }} />
              </div>
            </div>
            <div className="code-tests" role="group" aria-label="Send a test event">
              {TESTS.map((k) => (
                <button key={k} className="btn sm" type="button" onClick={() => send.current && testEvent(send.current, k, shown.alerts)}>{TEST_NAMES[k]}</button>
              ))}
              <button className="btn ghost sm" type="button" onClick={() => setShown({ ...code })}><Icon id="refresh" />Reload</button>
            </div>
            <label className={'field inline code-alerts' + (!canPlayAlerts && !code.alerts ? ' off' : '')}>
              <span>
                Plays alerts in place of the alert box
                <small>{canPlayAlerts || code.alerts
                  ? 'Use Sylva.on(\'alert\', fn) and call Sylva.done() when each one ends. StreamElements code can call SE_API.resumeQueue().'
                  : 'The canvas already has an alert box or another widget that plays alerts.'}</small>
              </span>
              <input type="checkbox" checked={code.alerts} disabled={!canPlayAlerts && !code.alerts} onChange={(e) => setCode({ ...code, alerts: e.target.checked })} />
            </label>
            {Object.keys(fields).length > 0 && (
              <div className="code-fields">
                <h4>Settings</h4>
                {Object.entries(fields).map(([k, f], n, all) => (
                  <div key={k} className="code-field">
                    {f.group && f.group !== all[n - 1]?.[1].group && <h5>{f.group}</h5>}
                    <FieldInput
                      id={k}
                      f={f}
                      value={valueOf(k, f)}
                      onChange={(v) => setValue(k, v)}
                      onPress={() => send.current?.({ type: 'button', field: k, value: f.value })}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldInput({ id, f, value, onChange, onPress }: {
  id: string; f: Field; value: unknown; onChange: (v: unknown) => void; onPress: () => void;
}) {
  const label = f.label || id;
  const htmlId = `field-${id}`;
  switch (f.type) {
    case 'button':
      // StreamElements sends the widget a "widget-button" event.
      return <button className="btn sm" type="button" onClick={onPress}>{label}</button>;
    case 'checkbox':
      return (
        <label className="field inline" htmlFor={htmlId}>
          <span>{label}</span>
          <input id={htmlId} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        </label>
      );
    case 'dropdown':
      return (
        <label className="field" htmlFor={htmlId}>
          <span>{label}</span>
          <select id={htmlId} className="select" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            {Object.entries(f.options ?? {}).map(([v, name]) => <option key={v} value={v}>{name}</option>)}
          </select>
        </label>
      );
    case 'number':
    case 'slider':
      return (
        <label className="field" htmlFor={htmlId}>
          <span>{label}</span>
          <input
            id={htmlId}
            className="input"
            type={f.type === 'slider' ? 'range' : 'number'}
            min={f.min}
            max={f.max}
            step={f.step}
            value={Number(value ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </label>
      );
    case 'colorpicker': {
      const hex = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
      return (
        <label className="field" htmlFor={htmlId}>
          <span>{label}</span>
          <span className="code-color">
            {hex && <input type="color" aria-label={`${label} picker`} value={hex} onChange={(e) => onChange(e.target.value)} />}
            <input id={htmlId} className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
          </span>
        </label>
      );
    }
    default:
      return (
        <label className="field" htmlFor={htmlId}>
          <span>{label}</span>
          <input id={htmlId} className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
  }
}

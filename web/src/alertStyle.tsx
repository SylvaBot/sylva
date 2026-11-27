// Alert style: a simple editor for how alerts look on stream. Layout,
// roundness, padding, icon, colors, size, and how they come in and go out,
// with a live preview that runs the real alert code. It edits the built in
// Alerts overlay's settings (web/src/widgets/pill-alerts.*), so every OBS
// link that shows alerts picks the change up. Saves as you go, with Undo.

import { useEffect, useState, type ReactNode } from 'react';
import { api, type Overlay } from './api';
import { useChannel } from './channel';
import { CustomFrame, testEvent, type Send } from './customWidget';
import { codeOf } from './overlay';
import { PageHead } from './pages';
import { Link } from './router';
import { Gate, Icon, SaveState, Seg, Skel, Switch, useAutosave, useToast } from './ui';

type Values = Record<string, unknown>;
const DEFAULTS: Values = {
  layout: 'pill', radius: 20, padding: 18, showIcon: true, textSize: 'L', animIn: 'pop', animOut: 'pop', speed: 'normal',
  styleKinds: '', cardColor: '#161616', textColor: '#FFFFFF', accentColor: '#FFFFFF', mutedColor: '#A3A3A3', badgeTextColor: '#000000',
};
const KINDS = [
  { id: 'follow', label: 'Follows', sample: 'follow' },
  { id: 'sub', label: 'Subs', sample: 'subscriber' },
  { id: 'gift', label: 'Gifts', sample: 'communityGift' },
  { id: 'tip', label: 'Tips', sample: 'tip' },
  { id: 'cheer', label: 'Bits', sample: 'cheer' },
  { id: 'raid', label: 'Raids', sample: 'raid' },
  { id: 'redemption', label: 'Redemptions', sample: 'redemption' },
];
const PREVIEW_AS = [
  { id: 'follow', label: 'Follow' }, { id: 'subscriber', label: 'Sub' }, { id: 'tip', label: 'Tip' },
  { id: 'raid', label: 'Raid' }, { id: 'cheer', label: 'Bits' },
] as const;

/** The color halfway to the background, for the second line of text. */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => { const x = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
  const [ca, cb] = [p(a), p(b)];
  return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Black or white, whichever reads better on a color. */
function onColor(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#000000' : '#FFFFFF';
}

export function AlertStylePage() {
  const ch = useChannel();
  const toast = useToast();
  const [failed, setFailed] = useState(false);
  const { value: list, set, reset, undo, canUndo, saving, savedAt } = useAutosave<Overlay[]>((v) => api.saveOverlays(ch.key, v));
  const [as, setAs] = useState<(typeof PREVIEW_AS)[number]['id']>('subscriber');
  const [play, setPlay] = useState(0);

  useEffect(() => {
    api.overlays(ch.key).then(reset).catch(() => setFailed(true));
  }, [ch.key, reset]);

  const alerts = list?.find((o) => o.builtin === 'alerts');
  const v = { ...DEFAULTS, ...(alerts?.values ?? {}) };
  const get = <T,>(k: string) => v[k] as T;
  const put = (patch: Values, now = false) => {
    if (!alerts) return;
    set((l) => l.map((o) => (o.id === alerts.id ? { ...o, values: { ...(o.values ?? {}), ...patch } } : o)), now);
  };
  const someKinds = String(get<string>('styleKinds') || '').split(/[\s,]+/).filter(Boolean);
  const pill = get<string>('layout') === 'pill';

  // The preview holds the alert on screen; Play animation runs it again.
  const previewCode = alerts ? (() => {
    const c = codeOf(alerts);
    return { ...c, values: { ...c.values, duration: 3600, maxQueue: 1, position: 'middle-center', alertSound: '' } };
  })() : null;

  return (
    <div className="page alert-style">
      <PageHead
        title="Alert style"
        desc="Design how your alerts look on stream. They start neutral so they fit any layout."
        tag="/alerts/style"
      >
        <SaveState saving={saving} savedAt={savedAt} canUndo={canUndo} onUndo={undo} />
        <button className="btn sm" type="button" disabled={!alerts || !ch.can.edit} onClick={() => { put(DEFAULTS, true); toast('Alert style is back to the default'); }}>
          Reset to default
        </button>
      </PageHead>
      <p className="back-link"><Link href="/app/alerts"><Icon id="chevron-left" />Alerts</Link></p>

      {failed && !list && <div className="notice">Could not load your alert style. Refresh to try again.</div>}

      <section className="grp style-preview" aria-label="Preview">
        <div className="style-preview-head">
          <div className="style-as"><span className="faint">Preview as</span>
            <Seg label="Preview as" options={PREVIEW_AS.map((p) => ({ id: p.id, label: p.label }))} value={as} onChange={(k) => { setAs(k); setPlay((n) => n + 1); }} />
          </div>
          <button className="btn sm primary" type="button" disabled={!previewCode} onClick={() => setPlay((n) => n + 1)}><Icon id="play" />Play animation</button>
        </div>
        <div className="checker style-stage">
          {previewCode ? <StylePreview key={play} code={previewCode} kind={as} /> : <Skel w={360} h={64} round />}
        </div>
      </section>

      <Gate on={ch.can.edit} className="style-cols">
        <Group title="Shape">
          <SRow title="Layout"><Seg label="Layout" options={[{ id: 'pill', label: 'Pill' }, { id: 'card', label: 'Card' }, { id: 'banner', label: 'Banner' }]} value={get<string>('layout')} onChange={(x) => put({ layout: x }, true)} disabled={!alerts} /></SRow>
          <SRow title="Roundness" desc={pill ? 'A pill is always round' : undefined}>
            <Slider label="Roundness" value={get<number>('radius')} min={0} max={40} disabled={!alerts || pill} onChange={(n) => put({ radius: n })} />
          </SRow>
          <SRow title="Padding"><Slider label="Padding" value={get<number>('padding')} min={6} max={40} disabled={!alerts} onChange={(n) => put({ padding: n })} /></SRow>
          <SRow title="Show icon"><Switch label="Show icon" on={get<boolean>('showIcon') !== false} disabled={!alerts} onChange={(x) => put({ showIcon: x }, true)} /></SRow>
        </Group>
        <Group title="Colors">
          <SRow title="Background"><ColorPick label="Background" value={get<string>('cardColor')} disabled={!alerts} onChange={(c) => put({ cardColor: c, mutedColor: mix(get<string>('textColor'), c, 0.36) })} /></SRow>
          <SRow title="Text"><ColorPick label="Text" value={get<string>('textColor')} disabled={!alerts} onChange={(c) => put({ textColor: c, mutedColor: mix(c, get<string>('cardColor'), 0.36) })} /></SRow>
          <SRow title="Accent"><ColorPick label="Accent" value={get<string>('accentColor')} disabled={!alerts} onChange={(c) => put({ accentColor: c, badgeTextColor: onColor(c) })} /></SRow>
          <SRow title="Size" desc="How much of the OBS source it fills"><Seg label="Size" options={['S', 'M', 'L']} value={get<string>('textSize')} onChange={(x) => put({ textSize: x }, true)} disabled={!alerts} /></SRow>
        </Group>
        <Group title="Animation">
          <SRow title="Comes in"><Seg label="Comes in" options={[{ id: 'fade', label: 'Fade' }, { id: 'slide', label: 'Slide' }, { id: 'pop', label: 'Pop' }]} value={get<string>('animIn')} onChange={(x) => { put({ animIn: x }, true); setPlay((n) => n + 1); }} disabled={!alerts} /></SRow>
          <SRow title="Goes out"><Seg label="Goes out" options={[{ id: 'fade', label: 'Fade' }, { id: 'slide', label: 'Slide' }, { id: 'pop', label: 'Pop' }]} value={get<string>('animOut')} onChange={(x) => put({ animOut: x }, true)} disabled={!alerts} /></SRow>
          <SRow title="Speed"><Seg label="Speed" options={[{ id: 'slow', label: 'Slow' }, { id: 'normal', label: 'Normal' }, { id: 'fast', label: 'Fast' }]} value={get<string>('speed')} onChange={(x) => { put({ speed: x }, true); setPlay((n) => n + 1); }} disabled={!alerts} /></SRow>
          <SRow title="Applies to" desc={someKinds.length ? 'The rest keep the default pill' : undefined}>
            <Seg label="Applies to" options={[{ id: 'all', label: 'All events' }, { id: 'some', label: 'Some' }]} value={someKinds.length ? 'some' : 'all'}
              onChange={(x) => put({ styleKinds: x === 'all' ? '' : 'sub,gift,tip,cheer,raid' }, true)} disabled={!alerts} />
          </SRow>
          {someKinds.length > 0 && (
            <div className="gr style-kinds" role="group" aria-label="Events that use this style">
              {KINDS.map((k) => {
                const on = someKinds.includes(k.id);
                return (
                  <button key={k.id} type="button" className="btn sm" aria-pressed={on} disabled={!alerts || (on && someKinds.length === 1)}
                    onClick={() => put({ styleKinds: (on ? someKinds.filter((x) => x !== k.id) : [...someKinds, k.id]).join(',') }, true)}>
                    {k.label}
                  </button>
                );
              })}
            </div>
          )}
        </Group>
      </Gate>
      <p className="sect-foot">Every overlay link that shows your alerts uses this style. Fonts, position and the rest live with the Alerts overlay on <Link href="/app/overlays?o=alerts">Overlays</Link>.</p>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sect" aria-label={title}>
      <div className="sect-head"><div><h2>{title}</h2></div></div>
      <div className="grp">{children}</div>
    </section>
  );
}

function SRow({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="gr style-row">
      <div className="gr-main"><div className="t1">{title}</div>{desc && <div className="t2">{desc}</div>}</div>
      <div className="gr-ctl">{children}</div>
    </div>
  );
}

/** A range slider with its value beside it. */
export function Slider({ label, value, min, max, step = 1, unit = 'px', disabled, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; disabled?: boolean; onChange(n: number): void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <span className="slider">
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled}
        style={{ '--p': pct + '%' } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mono faint">{value}{unit}</span>
    </span>
  );
}

/** A swatch and its hex code; clicking opens the color picker. */
export function ColorPick({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange(c: string): void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return (
    <label className={'color-pick' + (disabled ? ' off' : '')}>
      <span className="swatch" style={{ background: hex }} />
      <span className="mono">{hex.toUpperCase()}</span>
      <input type="color" className="sr-only" aria-label={`${label} color`} value={hex.toLowerCase()} disabled={disabled} onChange={(e) => onChange(e.target.value.toUpperCase())} />
    </label>
  );
}

/** The real alert code at the size of the box, playing one sample alert. */
function StylePreview({ code, kind }: { code: ReturnType<typeof codeOf>; kind: string }) {
  const bind = (send: Send | null) => {
    if (send) setTimeout(() => testEvent(send, kind, true), 250);
  };
  return <CustomFrame code={code} bind={bind} />;
}

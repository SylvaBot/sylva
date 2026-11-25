// The Alerts page's "Alert types" card: for each kind of alert, whether it
// plays, the least amount that plays it, how long it stays, and its text.
// The rules match crates/sylva-core/src/alerts.rs, which checks them again.

import { useEffect, useState } from 'react';
import { api, type AlertSettings, type Kind, type KindSettings } from './api';
import { useChannel } from './channel';
import { errorText, Icon, num, useToast } from './ui';

const META: Partial<Record<Kind, { name: string; c: string; icon: string; unit?: string; sample: number; hint?: string }>> = {
  follow: { name: 'Follows', c: 'c-follow', icon: 'heart', sample: 0 },
  subscriber: { name: 'Subs and resubs', c: 'c-sub', icon: 'star', sample: 6 },
  communityGift: { name: 'Gifted subs', c: 'c-gift', icon: 'gift', unit: 'subs', sample: 5, hint: 'One alert per gift, however many subs it gives.' },
  cheer: { name: 'Cheers', c: 'c-bits', icon: 'gem', unit: 'bits', sample: 500 },
  raid: { name: 'Raids', c: 'c-raid', icon: 'swords', unit: 'viewers', sample: 42 },
  tip: { name: 'Tips', c: 'c-tip', icon: 'tip', unit: '', sample: 5, hint: 'Tips arrive once a tipping service is connected.' },
  redemption: { name: 'Channel points', c: 'c-reward', icon: 'sparkles', sample: 0, hint: 'Redemptions arrive once channel points are connected.' },
};

const DURATIONS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20];
const MAX_LABEL = 40;
const MAX_TEMPLATE = 120;

/** Mirrors sylva_core::alerts::fill for the preview. */
function fill(template: string, name: string, amount: number, kind: Kind): string {
  return template
    .replaceAll('{name}', name)
    .replaceAll('{amount}', amount ? num(amount) : '')
    .replaceAll('{reward}', kind === 'redemption' ? 'Hydrate' : 'a reward');
}

function summary(k: KindSettings): string {
  const m = META[k.kind];
  if (!k.enabled) return 'Off. These still show in your activity.';
  const parts = [`${k.durationMs / 1000} seconds on screen`];
  if (m?.unit !== undefined && k.minAmount > 0) parts.push(`from ${num(k.minAmount)}${m.unit ? ' ' + m.unit : ''}`);
  return parts.join(' · ');
}

export function AlertTypes() {
  const ch = useChannel();
  const toast = useToast();
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Kind | null>(null);

  useEffect(() => {
    api.alertSettings(ch.key).then(setSettings).catch(() => setFailed(true));
  }, [ch.key]);

  const save = async (next: KindSettings, done?: string) => {
    if (!settings) return false;
    const body = { kinds: settings.kinds.map((k) => (k.kind === next.kind ? next : k)) };
    try {
      setSettings(await api.saveAlertSettings(ch.key, body));
      if (done) toast(done);
      return true;
    } catch (x) {
      toast(errorText(x), true);
      return false;
    }
  };

  return (
    <section className="card" aria-labelledby="types-title">
      <div className="card-head">
        <div>
          <h2 id="types-title">Alert types</h2>
          <p>Choose what plays, from how much, for how long, and what it says.</p>
        </div>
      </div>
      {failed && !settings && <div className="card-body"><p className="card-text">Could not load your alert settings. Refresh to try again.</p></div>}
      {!settings && !failed && <div className="card-body"><p className="card-text">Loading</p></div>}
      {settings && (
        <ul className="types">
          {settings.kinds.filter((k) => META[k.kind]).map((k) => {
            const m = META[k.kind]!;
            const isOpen = open === k.kind;
            return (
              <li key={k.kind} className={'type ' + m.c + (isOpen ? ' open' : '')}>
                <div className="type-row">
                  <span className="tile"><Icon id={m.icon} /></span>
                  <div className="type-main">
                    <b>{m.name}</b>
                    <span>{summary(k)}</span>
                  </div>
                  <button
                    className="btn sm ghost"
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`edit-${k.kind}`}
                    onClick={() => setOpen(isOpen ? null : k.kind)}
                  >
                    {isOpen ? 'Close' : 'Edit'}
                  </button>
                  <button
                    className="switch"
                    type="button"
                    role="switch"
                    aria-checked={k.enabled}
                    aria-label={`${m.name} alerts`}
                    onClick={() => save({ ...k, enabled: !k.enabled }, `${m.name} alerts ${k.enabled ? 'off' : 'on'}`)}
                  />
                </div>
                {isOpen && (
                  <Editor
                    k={k}
                    login={ch.name}
                    onCancel={() => setOpen(null)}
                    onSave={async (next) => {
                      if (await save(next, `${m.name} saved`)) setOpen(null);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Editor({ k, login, onSave, onCancel }: { k: KindSettings; login: string; onSave(k: KindSettings): Promise<void>; onCancel(): void }) {
  const m = META[k.kind]!;
  const [draft, setDraft] = useState(k);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<KindSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const id = (f: string) => `${k.kind}-${f}`;
  const sample = 'Juniper';
  const changed = JSON.stringify(draft) !== JSON.stringify(k);
  const hasMessage = k.kind === 'cheer' || k.kind === 'subscriber' || k.kind === 'tip';

  return (
    <form
      className="type-edit"
      id={`edit-${k.kind}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onSave(draft); } finally { setBusy(false); }
      }}
    >
      <div className="type-fields">
        <label className="field" htmlFor={id('label')}>
          Label
          <input id={id('label')} className="input" maxLength={MAX_LABEL} value={draft.label} onChange={(e) => set({ label: e.target.value })} />
          <span className="field-hint">The small line above the name.</span>
        </label>
        <label className="field" htmlFor={id('template')}>
          Message
          <input id={id('template')} className="input" maxLength={MAX_TEMPLATE} value={draft.template} onChange={(e) => set({ template: e.target.value })} />
          <span className="field-hint">
            Under the name. {'{name}'}{m.unit !== undefined ? <>, {'{amount}'}</> : null}{k.kind === 'redemption' ? <>, {'{reward}'}</> : null} are filled in.
          </span>
        </label>
        <label className="field" htmlFor={id('duration')}>
          On screen for
          <select id={id('duration')} className="select" value={draft.durationMs / 1000} onChange={(e) => set({ durationMs: Number(e.target.value) * 1000 })}>
            {DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
          </select>
        </label>
        {m.unit !== undefined && (
          <label className="field" htmlFor={id('min')}>
            Play from
            <input
              id={id('min')}
              className="input"
              type="number"
              min={0}
              max={1000000}
              step={k.kind === 'tip' ? 0.01 : 1}
              value={draft.minAmount || ''}
              placeholder="Any amount"
              onChange={(e) => set({ minAmount: Math.max(0, Number(e.target.value) || 0) })}
            />
            <span className="field-hint">{m.unit ? `Smaller amounts of ${m.unit} only show in your activity.` : 'Smaller tips only show in your activity.'}</span>
          </label>
        )}
        {hasMessage && (
          <div className="field inline">
            <span>Show what the viewer wrote</span>
            <button
              className="switch"
              type="button"
              role="switch"
              aria-checked={draft.showMessage}
              aria-label="Show what the viewer wrote"
              onClick={() => set({ showMessage: !draft.showMessage })}
            />
          </div>
        )}
        {m.hint && <p className="field-hint">{m.hint}</p>}
      </div>
      <div className="type-preview" aria-label="Preview">
        <div className={'stage small'}>
          <div className={'alert-card ' + m.c}>
            {draft.label.trim() && <div className="label">{draft.label}</div>}
            <div className="name">{sample}</div>
            {draft.template.trim() && <div className="detail">{fill(draft.template.trim(), sample, m.sample, k.kind)}</div>}
            {hasMessage && draft.showMessage && <div className="message">Love the stream, {login}!</div>}
          </div>
        </div>
      </div>
      <div className="type-actions">
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn primary" type="submit" disabled={busy || !changed}>{busy ? 'Saving' : 'Save'}</button>
      </div>
    </form>
  );
}

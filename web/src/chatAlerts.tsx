// The Chat alerts page: the bot announces subs, raids, hype trains,
// predictions and more in chat. The rules match
// crates/sylva-core/src/chat_alerts.rs, which checks every save again.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ChatAlertGroup, type ChatAlertInfo, type ChatAlertSettings, type ChatAlertsView } from './api';
import { useChannel } from './channel';
import { NumberField } from './moderation';
import { Card, PageHead } from './pages';
import { errorText, Gate, Icon, SkelCard, useToast } from './ui';

const ALLOW_URL = '/auth/twitch/start?scopes=alerts&next=/app/chat-alerts';
const MAX = 500;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Platform = 'twitch' | 'youtube' | 'kick';

export function ChatAlertsPage() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<ChatAlertsView | null>(null);
  const [draft, setDraft] = useState<ChatAlertSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Platform>('twitch');

  const adopt = useCallback((v: ChatAlertsView) => {
    setView(v);
    setDraft(v.settings);
  }, []);

  useEffect(() => {
    api.chatAlerts(ch.key).then(adopt).catch(() => setFailed(true));
  }, [ch.key, adopt]);

  const changed = !!view && !!draft && !same(draft, view.settings);
  const set = (patch: Partial<ChatAlertSettings>) => draft && setDraft({ ...draft, ...patch });
  const setAlert = (id: string, patch: Partial<{ enabled: boolean; message: string }>) =>
    draft && setDraft({ ...draft, alerts: { ...draft.alerts, [id]: { ...draft.alerts[id], ...patch } } });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      adopt(await api.saveChatAlerts(ch.key, draft));
      toast('Chat alerts saved');
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  // Alerts that need the extra Twitch permission and are turned on.
  const wantsGrant = !!view && !!draft && view.groups.some((g) =>
    view.needsGrant.includes(g.id) && g.alerts.some((a) => draft.alerts[a.id]?.enabled));

  return (
    <div className="page">
      <PageHead title="Chat alerts" desc="Announce special moments with your chat and keep everyone involved." />
      <div className="segmented ca-tabs" role="group" aria-label="Platform">
        <button type="button" aria-pressed={tab === 'twitch'} onClick={() => setTab('twitch')}>Twitch</button>
        <button type="button" aria-pressed={tab === 'youtube'} onClick={() => setTab('youtube')}>YouTube<span className="ca-soon">Soon</span></button>
        <button type="button" aria-pressed={tab === 'kick'} onClick={() => setTab('kick')}>Kick<span className="ca-soon">Soon</span></button>
      </div>

      {tab !== 'twitch' && (
        <Card>
          <div className="card-body">
            <p className="card-text">
              {tab === 'youtube' ? 'YouTube' : 'Kick'} chat alerts are coming soon. Sylva works with Twitch today, and these settings will appear here once {tab === 'youtube' ? 'YouTube' : 'Kick'} is connected.
            </p>
          </div>
        </Card>
      )}

      {tab === 'twitch' && failed && !view && <Card><div className="card-body"><p className="card-text">Could not load chat alerts. Refresh to try again.</p></div></Card>}
      {tab === 'twitch' && !view && !failed && <SkelCard rows={4} />}
      {tab === 'twitch' && view && draft && (
        <div className="stack">
          <p className="field-hint">
            Alerts are posted by {view.sender.kind === 'sylva' ? <strong>{view.sender.login || 'Sylva’s bot'}</strong> : 'your own account'}.
            Twitch’s chat API has no <code>/me</code>, so a message that starts with it is sent as a normal line.
          </p>
          {wantsGrant && view.permission !== 'ok' && (
            <div className="notice">
              <span>
                {!ch.can.own
                  ? `Charity, ad break, hype train, prediction and poll alerts need ${ch.name} to allow them on this page.`
                  : view.permission === 'expired'
                    ? 'Twitch no longer accepts Sylva’s permission to see charity, ad breaks, hype trains, predictions and polls. Allow it again so those alerts keep working.'
                    : 'Charity, ad break, hype train, prediction and poll alerts need your permission on Twitch before Sylva can see them.'}
              </span>
              {ch.can.own && <a className="btn primary sm" href={ALLOW_URL}><Icon id="twitch" />Allow alerts</a>}
            </div>
          )}

          <Gate on={ch.can.edit} className="stack">
            {view.groups.map((g) => (
              <GroupCard key={g.id} group={g} draft={draft} setAlert={setAlert}>
                {g.id === 'raids' && (
                  <MinRow label="Minimum raid viewers" value={draft.raidMin} max={1_000_000} unit="viewers"
                    hint="Minimum number of viewers required to trigger the alert" onChange={(n) => set({ raidMin: n })} />
                )}
                {g.id === 'bits' && (
                  <MinRow label="Minimum bits" value={draft.bitsMin} max={1_000_000} unit="bits"
                    hint="Minimum number of bits required in message to trigger the alert" onChange={(n) => set({ bitsMin: n })} />
                )}
                {g.id === 'charity' && (
                  <>
                    <div className="ca-min">
                      <span>$</span>
                      <MoneyField value={draft.charityMin} onChange={(n) => set({ charityMin: n })} />
                      <span>Minimum donation required to trigger the chat alert</span>
                    </div>
                    <div className="ca-min">
                      <a className="btn sm" href="https://dashboard.twitch.tv/charity" target="_blank" rel="noreferrer"><Icon id="external" />Open Twitch’s charity dashboard</a>
                    </div>
                  </>
                )}
                {g.id === 'ads' && (
                  <div className="ca-min">
                    <button className="switch" type="button" role="switch" aria-checked={draft.adAutomatic} aria-label="Automated ad breaks"
                      onClick={() => set({ adAutomatic: !draft.adAutomatic })} />
                    <span>Automated ad breaks</span>
                    <span className="field-hint">Also announce the ads Twitch runs on your schedule.</span>
                    <a className="btn ghost sm" href="https://help.twitch.tv/s/article/ad-manager" target="_blank" rel="noreferrer"><Icon id="external" />Learn more about ad breaks</a>
                  </div>
                )}
                {g.id === 'streaks' && (
                  <MinRow label="Minimum streams" value={draft.watchStreakMin} max={10_000} unit="streams"
                    hint="Minimum number of streams required to trigger the alert" onChange={(n) => set({ watchStreakMin: n })} />
                )}
              </GroupCard>
            ))}
          </Gate>

          {changed && (
            <div className="save-bar" role="region" aria-label="Unsaved changes">
              <span>You have changes that are not saved yet.</span>
              <button className="btn ghost" type="button" disabled={busy} onClick={() => adopt(view)}>Discard</button>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving' : 'Save changes'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GroupCard({ group, draft, setAlert, children }: {
  group: ChatAlertGroup; draft: ChatAlertSettings;
  setAlert(id: string, patch: Partial<{ enabled: boolean; message: string }>): void;
  children?: React.ReactNode;
}) {
  const on = group.alerts.filter((a) => draft.alerts[a.id]?.enabled).length;
  return (
    <Card id={'ca-' + group.id} title={group.title}
      desc={<>{group.desc ? group.desc + ' ' : ''}{on ? `${on} of ${group.alerts.length} on.` : 'Off.'}</>}>
      <ul className="ca-list">
        {group.alerts.map((a) => (
          <AlertRow key={a.id} info={a} many={group.alerts.length > 1} alert={draft.alerts[a.id]} onChange={(p) => setAlert(a.id, p)} />
        ))}
      </ul>
      {children}
    </Card>
  );
}

function AlertRow({ info, many, alert, onChange }: {
  info: ChatAlertInfo; many: boolean; alert: { enabled: boolean; message: string } | undefined;
  onChange(p: Partial<{ enabled: boolean; message: string }>): void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  if (!alert) return null;
  const id = 'ca-msg-' + info.id;
  const used = [...alert.message].length;
  const insert = (v: string) => {
    const el = box.current;
    const text = `\${${v}}`;
    if (!el) return onChange({ message: alert.message + text });
    const start = el.selectionStart ?? alert.message.length;
    const end = el.selectionEnd ?? start;
    const next = alert.message.slice(0, start) + text + alert.message.slice(end);
    onChange({ message: next });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
  };
  return (
    <li className={'ca-row' + (alert.enabled ? '' : ' off')}>
      <div className="ca-row-head">
        <button className="switch" type="button" role="switch" aria-checked={alert.enabled}
          aria-label={`${info.label} alert`} onClick={() => onChange({ enabled: !alert.enabled })} />
        <label htmlFor={id}>{many ? info.label : 'Message'}</label>
        {alert.message !== info.default && (
          <button className="btn ghost sm ca-reset" type="button" onClick={() => onChange({ message: info.default })}>
            <Icon id="undo" />Default
          </button>
        )}
      </div>
      <textarea id={id} ref={box} className="input textarea" rows={2} maxLength={MAX} value={alert.message}
        onChange={(e) => onChange({ message: e.target.value.replace(/[\r\n]+/g, ' ') })} />
      <div className="ca-row-foot">
        <span className={'ca-count' + (used > MAX ? ' over' : '')}>{used} out of {MAX} characters used.</span>
        <span className="chips" aria-label="Insert a variable">
          {info.variables.map((v) => (
            <button key={v} type="button" className="chip" onClick={() => insert(v)}>{`\${${v}}`}</button>
          ))}
        </span>
      </div>
    </li>
  );
}

function MinRow({ label, value, max, unit, hint, onChange }: {
  label: string; value: number; max: number; unit: string; hint: string; onChange(n: number): void;
}) {
  return (
    <div className="ca-min">
      <NumberField label={label} value={value} min={0} max={max} onChange={onChange} />
      <span>{unit}</span>
      <span className="field-hint">{hint}</span>
    </div>
  );
}

function MoneyField({ value, onChange }: { value: number; onChange(n: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text) * 100) / 100;
    const v = Number.isFinite(n) ? Math.min(1_000_000, Math.max(0, n)) : value;
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <input className="input num-input" type="number" inputMode="decimal" step="0.01" min={0} aria-label="Minimum donation"
      value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  );
}

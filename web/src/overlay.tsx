// The Overlay page: the private overlay link, the widgets that share it (each
// its own OBS Browser Source), the goal, and how to add them to OBS.

import { useEffect, useRef, useState } from 'react';
import { api, type Goal, type GoalKind } from './api';
import { useChannel } from './channel';
import { LATEST_KINDS, SceneEditor, TOP_KINDS } from './editor';
import { Card, PageHead, remember } from './pages';
import { Link } from './router';
import { errorText, Icon, num, useToast } from './ui';

interface WidgetDef {
  id: string;
  name: string;
  icon: string;
  c: string;
  text: string;
  size: string;
  query: string;
}


const GOAL_KINDS: { id: GoalKind; label: string; unit: string }[] = [
  { id: 'follows', label: 'Followers', unit: 'followers' },
  { id: 'subs', label: 'Subs', unit: 'subs' },
  { id: 'bits', label: 'Bits', unit: 'bits' },
];

export function OverlayPage() {
  const ch = useChannel();
  if (ch.can.edit) return <OverlayEditorPage />;
  return (
    <div className="page">
      <PageHead title="Overlay" desc="The alert box and widgets that show on stream." />
      <Card id="overlay-locked" title="Only the owner and editors change the overlay">
        <div className="card-body">
          <p className="card-text">
            The overlay links show this channel&apos;s alerts to anyone who has them, so they stay with the owner and editors.
            You can still pause, mute, skip and replay alerts from <Link href="/app/alerts">Alerts</Link>.
          </p>
        </div>
      </Card>
    </div>
  );
}

function OverlayEditorPage() {
  const ch = useChannel();
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [latestKind, setLatestKind] = useState('follow');
  const [topKind, setTopKind] = useState('cheer');
  const disarm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api.overlay(ch.key).then((r) => setUrl(r.url)).catch((x) => toast('Could not load the overlay link: ' + errorText(x), true));
  }, [ch.key, toast]);
  useEffect(() => () => clearTimeout(disarm.current), []);

  const connected = ch.alerts?.overlaysConnected ?? 0;
  const widgets: WidgetDef[] = [
    { id: 'alerts', name: 'Alert box', icon: 'bell', c: 'c-sub', text: 'Plays your alerts one at a time.', size: '1920 × 1080', query: '' },
    { id: 'feed', name: 'Event list', icon: 'activity', c: 'c-follow', text: 'The last five follows, subs, cheers and raids.', size: '400 × 360', query: '&widget=feed' },
    { id: 'latest', name: 'Latest label', icon: 'star', c: 'c-bits', text: 'One line with the latest follower, sub, gifter, cheer or raid.', size: '500 × 60', query: `&widget=latest&kind=${latestKind}` },
    { id: 'top', name: 'Top label', icon: 'trophy', c: 'c-reward', text: 'The top cheerer or gifter since the stream went live.', size: '500 × 60', query: `&widget=top&kind=${topKind}` },
    { id: 'goal', name: 'Goal bar', icon: 'zap', c: 'c-raid', text: 'Progress toward the goal you set below.', size: '600 × 90', query: '&widget=goal' },
    { id: 'chat', name: 'Chat box', icon: 'message', c: 'c-gift', text: 'Your chat, on stream.', size: '400 × 500', query: '&widget=chat' },
  ];

  const copy = async (w: WidgetDef) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url + w.query);
      if (w.id === 'alerts') remember('sylva.overlayCopied');
      toast(`${w.name} link copied`);
    } catch {
      toast('Your browser blocked copying. Open the widget and copy its address instead.', true);
    }
  };

  const replace = async () => {
    if (!armed) {
      setArmed(true);
      clearTimeout(disarm.current);
      disarm.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    try {
      setUrl((await api.rotateOverlay(ch.key)).url);
      toast('New links made. The old ones stopped working, so update them in OBS.');
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  return (
    <div className="page">
      <PageHead
        title="Overlay"
        desc={connected === 0 ? 'No alert box is connected right now.' : connected === 1 ? '1 alert box is connected right now.' : `${num(connected)} alert boxes are connected right now.`}
      >
        {ch.can.own && (
          <button className={'btn' + (armed ? ' armed' : '')} type="button" disabled={!url} onClick={replace} title="Make new links and stop the old ones">
            <Icon id="refresh" />{armed ? 'Click again to replace' : 'New links'}
          </button>
        )}
      </PageHead>
      <div className="stack">
        <SceneEditor url={url} />
        <GoalCard />
        <Card id="widgets" title="One widget per source" desc="For more control in OBS, add widgets as separate Browser Sources instead. Anyone with a link can show it, so keep them private.">
          <ul className="widgets">
            {widgets.map((w) => (
              <li key={w.id} className={'widget ' + w.c}>
                <span className="tile"><Icon id={w.icon} /></span>
                <div className="widget-main">
                  <b>{w.name}</b>
                  <span>{w.text} Size {w.size}.</span>
                  {w.id === 'top' && (
                    <div className="segmented sm" role="group" aria-label="Top label shows">
                      {TOP_KINDS.map((k) => (
                        <button key={k.id} type="button" aria-pressed={topKind === k.id} onClick={() => setTopKind(k.id)}>{k.label}</button>
                      ))}
                    </div>
                  )}
                  {w.id === 'latest' && (
                    <div className="segmented sm" role="group" aria-label="Latest label shows">
                      {LATEST_KINDS.map((k) => (
                        <button key={k.id} type="button" aria-pressed={latestKind === k.id} onClick={() => setLatestKind(k.id)}>{k.label}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="widget-actions">
                  <button className="btn sm" type="button" disabled={!url} onClick={() => copy(w)}><Icon id="copy" />Copy link</button>
                  <a className="btn sm" href={url ? url + w.query + '&debug' : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!url}>
                    <Icon id="external" />Open
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <div className="grid-2">
          <Card id="obs" title="Add your overlay to OBS">
            <div className="card-body">
              <ol className="steps">
                <li>Lay out your widgets above and click <b>Publish</b>, then <b>Copy link</b>.</li>
                <li>In OBS, under <b>Sources</b>, click <b>+</b> and choose <b>Browser</b>. Give it a name and click <b>OK</b>.</li>
                <li>Paste the link into <b>URL</b>, set <b>Width</b> to 1920 and <b>Height</b> to 1080, and click <b>OK</b>.</li>
                <li>Use <b>Try it</b> in the editor, or <Link href="/app/alerts">Alerts</Link>, to check it.</li>
              </ol>
            </div>
          </Card>
          <Card id="look" title="What an alert looks like" desc="Change the text and timing in Alerts.">
            <div className="card-body">
              <div className="stage" aria-hidden="true">
                <div className="alert-card c-sub">
                  <div className="label">New subscriber</div>
                  <div className="name">Juniper</div>
                  <div className="detail">Thanks for subscribing!</div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function GoalCard() {
  const ch = useChannel();
  const toast = useToast();
  const [goal, setGoal] = useState<Goal | null | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<GoalKind>('subs');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);

  const load = (g: Goal | null) => {
    setGoal(g);
    setTitle(g?.title ?? '');
    setKind(g?.kind ?? 'subs');
    setTarget(g ? String(g.target) : '');
  };

  useEffect(() => {
    api.widgetSettings(ch.key).then((s) => load(s.goal ?? null)).catch(() => load(null));
  }, [ch.key]);

  // Progress, counted the same way the goal bar counts it.
  useEffect(() => {
    if (!goal) { setCurrent(null); return; }
    api.summary(ch.key, goal.since).then((s) => {
      const c = s.counts;
      setCurrent(goal.kind === 'follows' ? c.follow || 0 : goal.kind === 'subs' ? (c.subscriber || 0) + (c.giftedSub || 0) : s.bits);
    }).catch(() => setCurrent(null));
  }, [ch.key, goal, ch.summary]);

  const save = async (next: Goal | null, done: string) => {
    setBusy(true);
    try {
      const r = await api.saveWidgetSettings(ch.key, { goal: next });
      load(r.goal ?? null);
      toast(done);
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  const unit = GOAL_KINDS.find((k) => k.id === kind)!.unit;
  const n = Number(target);
  const valid = title.trim().length > 0 && Number.isFinite(n) && n >= 1;
  const changed = !goal || goal.title !== title.trim() || goal.kind !== kind || goal.target !== n;
  const pct = goal && current !== null ? Math.min(100, (current / goal.target) * 100) : 0;

  return (
    <Card id="goal" title="Goal" desc="Shown by the goal bar widget. It counts from when you start it.">
      <form
        className="card-body goal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          // Changing what is counted starts the count again.
          const since = goal && goal.kind === kind ? goal.since : Date.now();
          save({ title: title.trim(), kind, target: n, since }, goal ? 'Goal saved' : 'Goal started');
        }}
      >
        {goal === undefined ? <p className="card-text">Loading</p> : (
          <>
            <div className="goal-fields">
              <label className="field">
                Title
                <input className="input" maxLength={60} value={title} placeholder="Sub goal" onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field">
                Counts
                <select className="select" value={kind} onChange={(e) => setKind(e.target.value as GoalKind)}>
                  {GOAL_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                </select>
              </label>
              <label className="field">
                Target
                <input className="input" type="number" min={1} max={10000000} step={1} value={target} placeholder="50" onChange={(e) => setTarget(e.target.value)} />
              </label>
            </div>
            {goal && (
              <div className={'goal-preview ' + (goal.kind === 'follows' ? 'c-follow' : goal.kind === 'subs' ? 'c-sub' : 'c-bits')}>
                <div className="goal-line">
                  <b>{goal.title}</b>
                  <span>{current === null ? '-' : num(current)} / {num(goal.target)} {GOAL_KINDS.find((k) => k.id === goal.kind)!.unit}</span>
                </div>
                <div className="goal-track"><div className="goal-fill" style={{ width: pct + '%' }} /></div>
                <p className="field-hint">Counting since {new Date(goal.since).toLocaleString()}.</p>
              </div>
            )}
            <div className="goal-actions">
              {goal && (
                <>
                  <button className="btn ghost danger" type="button" disabled={busy} onClick={() => save(null, 'Goal removed')}>Remove</button>
                  <button className="btn" type="button" disabled={busy} onClick={() => save({ ...goal, since: Date.now() }, 'Counting from zero again')}>Start again</button>
                </>
              )}
              <button className="btn primary" type="submit" disabled={busy || !valid || !changed}>
                {goal ? 'Save' : `Start counting ${unit}`}
              </button>
            </div>
          </>
        )}
      </form>
    </Card>
  );
}

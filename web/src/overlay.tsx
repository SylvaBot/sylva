// The Overlays page. Each overlay is one element that fills its own OBS
// Browser Source; the streamer sizes and places it in OBS, not here. Alerts
// and Chat are built in. Any overlay can play sounds, and its settings are a
// plain form. Saved as you go (workers/edge/src/overlays.rs).

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, isSound, mediaUrl, type CustomCode, type MediaFile, type Overlay, type OverlaySound, type SoundOn } from './api';
import { useChannel } from './channel';
import { useWidth } from './charts';
import { CodeDialog, CustomFrame, FieldInput, parseFields, STARTER, testEvent, type Field, type Send } from './customWidget';
import { Card, PageHead, remember } from './pages';
import { Link } from './router';
import { errorText, Icon, num, Skel, useToast } from './ui';
import { PILL_ALERTS, TWITCH_CHAT } from './widgets';

const BUILTIN: Record<'alerts' | 'chat', CustomCode> = { alerts: PILL_ALERTS, chat: TWITCH_CHAT };
const MAX = 24;

/** The code an overlay runs: Sylva's for the built-ins, with the streamer's values. */
export function codeOf(o: Overlay): CustomCode {
  if (o.builtin) {
    const base = BUILTIN[o.builtin];
    return { ...base, values: { ...base.values, ...(o.values ?? {}) } };
  }
  return o.code ?? STARTER;
}

const SOUND_ON: { id: SoundOn; label: string }[] = [
  { id: 'alert', label: 'Every alert' },
  { id: 'follow', label: 'A follow' },
  { id: 'subscriber', label: 'A sub' },
  { id: 'communityGift', label: 'Gifted subs' },
  { id: 'cheer', label: 'A cheer' },
  { id: 'raid', label: 'A raid' },
  { id: 'redemption', label: 'A redemption' },
  { id: 'chat', label: 'A chat message' },
  { id: 'any', label: 'Anything' },
];
const TRY = [
  { kind: 'follow', label: 'Follow' }, { kind: 'subscriber', label: 'Sub' }, { kind: 'communityGift', label: 'Gift' },
  { kind: 'cheer', label: 'Cheer' }, { kind: 'raid', label: 'Raid' }, { kind: 'chat', label: 'Chat' },
];

const newId = () => 'o' + Math.random().toString(36).slice(2, 9);

export function OverlayPage() {
  const ch = useChannel();
  if (ch.can.edit) return <Overlays />;
  return (
    <div className="page">
      <PageHead title="Overlays" desc="What shows on stream." />
      <Card id="overlay-locked" title="Only the owner and editors change overlays">
        <div className="card-body">
          <p className="card-text">
            Overlay links show this channel&apos;s alerts to anyone who has them, so they stay with the owner and editors.
            You can still pause, mute, skip and replay alerts from <Link href="/app/alerts">Alerts</Link>.
          </p>
        </div>
      </Card>
    </div>
  );
}

function Overlays() {
  const ch = useChannel();
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [list, setList] = useState<Overlay[] | null>(null);
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(location.search).get('o'));
  const [save, setSave] = useState<'saved' | 'saving' | 'error'>('saved');
  const [armed, setArmed] = useState(false);
  const [adding, setAdding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api.overlay(ch.key).then((r) => setUrl(r.url)).catch((x) => toast('Could not load your overlay links: ' + errorText(x), true));
    api.overlays(ch.key).then(setList).catch((x) => toast('Could not load your overlays: ' + errorText(x), true));
  }, [ch.key, toast]);
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(disarm.current); }, []);

  // Keep the open overlay in the address, so a reload comes back to it.
  useEffect(() => {
    const u = new URL(location.href);
    if (open) u.searchParams.set('o', open); else u.searchParams.delete('o');
    history.replaceState(history.state, '', u.pathname + u.search);
  }, [open]);

  /** Change the list now and save it shortly after the last change. */
  const update = (next: Overlay[], now = false) => {
    setList(next);
    setSave('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await api.saveOverlays(ch.key, next);
        setSave('saved');
      } catch (x) {
        setSave('error');
        toast(errorText(x), true);
      }
    }, now ? 0 : 600);
  };

  const linkOf = (o: Overlay) => (url ? (o.id === 'alerts' ? url : o.id === 'chat' ? url + '&widget=chat' : `${url}&overlay=${o.id}`) : null);
  const copy = async (o: Overlay) => {
    const link = linkOf(o);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      if (o.id === 'alerts') remember('sylva.overlayCopied');
      toast(`${o.name} link copied. Paste it into a Browser Source in OBS.`);
    } catch {
      toast('Your browser blocked copying. Open the overlay and copy its address instead.', true);
    }
  };
  const add = (code: CustomCode, name: string) => {
    if (!list) return;
    const o: Overlay = { id: newId(), name, code: { ...code, values: { ...code.values } }, sounds: [] };
    update([...list, o], true);
    setAdding(false);
    setOpen(o.id);
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

  const current = list?.find((o) => o.id === open);
  if (list && current) {
    return (
      <OverlayEditor
        o={current}
        link={linkOf(current)}
        save={save}
        onBack={() => setOpen(null)}
        onCopy={() => copy(current)}
        onChange={(next) => update(list.map((x) => (x.id === next.id ? next : x)))}
        onDelete={() => { update(list.filter((x) => x.id !== current.id), true); setOpen(null); toast(`${current.name} deleted`); }}
      />
    );
  }

  const connected = ch.alerts?.overlaysConnected ?? 0;
  return (
    <div className="page">
      <PageHead
        title="Overlays"
        desc={<>Each overlay is one link. Add it to OBS as a browser source, then size and place it there.{connected > 0 && <> Alerts are on screen in {num(connected)} {connected === 1 ? 'place' : 'places'} now.</>}</>}
      >
        {ch.can.own && (
          <button className={'btn' + (armed ? ' armed' : '')} type="button" disabled={!url} onClick={replace} title="Make new links and stop the old ones">
            <Icon id="refresh" />{armed ? 'Click again to replace' : 'New links'}
          </button>
        )}
        <div className="filter-wrap">
          <button className="btn primary" type="button" disabled={!list || list.length >= MAX} aria-expanded={adding} onClick={() => setAdding(!adding)}>
            <Icon id="plus" />New overlay
          </button>
          {adding && (
            <div className="filter-pop add-pop">
              <button className="filter-opt" type="button" onClick={() => add(PILL_ALERTS, 'Alerts copy')}><Icon id="bell" />Alerts<span className="count">Pill alerts</span></button>
              <button className="filter-opt" type="button" onClick={() => add(TWITCH_CHAT, 'Chat copy')}><Icon id="message" />Chat<span className="count">Twitch style</span></button>
              <button className="filter-opt" type="button" onClick={() => add(STARTER, 'My overlay')}><Icon id="code" />Your own code<span className="count">HTML, CSS, JS</span></button>
            </div>
          )}
        </div>
      </PageHead>

      {!list && <div className="overlay-grid">{[0, 1, 2].map((i) => <div key={i} className="grp overlay-card"><div className="checker overlay-thumb" /><div className="overlay-meta"><Skel w={90} h={16} /><Skel w={160} h={12} /></div><div className="overlay-actions"><Skel w="100%" h={30} round /></div></div>)}</div>}
      {list && (
        <div className="overlay-grid">
          {list.map((o) => (
            <article key={o.id} className="grp overlay-card">
              <button className="checker overlay-thumb" type="button" onClick={() => setOpen(o.id)} aria-label={`Edit ${o.name}`}>
                <Preview code={codeOf(o)} demo />
              </button>
              <div className="overlay-meta">
                <h2 className="t1">{o.name}</h2>
                <p className="t2">
                  {o.builtin === 'alerts' ? 'Every alert, styled in Alert style' : o.builtin === 'chat' ? 'Your chat, with emotes and badges' : codeOf(o).alerts ? 'Your own code, plays alerts' : 'Your own code'}
                  {o.sounds.length ? `, ${o.sounds.length} sound${o.sounds.length === 1 ? '' : 's'}` : ''}
                </p>
              </div>
              <div className="overlay-actions">
                <button className="btn sm primary" type="button" disabled={!url} onClick={() => copy(o)}><Icon id="copy" />Copy OBS link</button>
                <button className="btn sm" type="button" onClick={() => setOpen(o.id)}><Icon id="edit" />Edit</button>
                <MoreMenu link={linkOf(o)} name={o.name} onDelete={o.builtin ? undefined : () => { update(list.filter((x) => x.id !== o.id), true); toast(`${o.name} deleted`); }} />
              </div>
            </article>
          ))}
        </div>
      )}
      <section className="sect overlay-steps" aria-labelledby="obs-steps">
        <div className="sect-head"><div><h2 id="obs-steps">Adding an overlay to OBS</h2></div></div>
        <ol className="grp steps">
          <li className="gr"><span className="mono faint">1</span><span className="t1">Copy the overlay link</span></li>
          <li className="gr"><span className="mono faint">2</span><span className="t1">In OBS, add a Browser source and paste the link</span></li>
          <li className="gr"><span className="mono faint">3</span><span className="t1">Set it to 1920 by 1080, then drag and resize it where you want it</span></li>
        </ol>
        <p className="sect-foot">Links work without signing in, so keep them private. If one leaks, use New links at the top of this page.</p>
      </section>
    </div>
  );
}

/** Open an overlay in a new tab, or delete one of your own. */
function MoreMenu({ link, name, onDelete }: { link: string | null; name: string; onDelete?(): void }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setArmed(false); return; }
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="more-wrap" ref={box}>
      <button className="btn sm icon" type="button" aria-label={`More for ${name}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon id="dots" /></button>
      {open && (
        <div className="menu more-menu" role="menu">
          <a className="menu-item" role="menuitem" href={link ? link + '&debug' : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!link} onClick={() => setOpen(false)}>
            <Icon id="external" />Open in a new tab
          </a>
          {onDelete && (
            <button className={'menu-item' + (armed ? ' danger' : '')} role="menuitem" type="button" onClick={() => { if (armed) { setOpen(false); onDelete(); } else setArmed(true); }}>
              <Icon id="trash" />{armed ? 'Click again to delete' : 'Delete'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A live preview at 1920 by 1080, scaled to fit its box. `demo` plays a
 * sample so a thumbnail is not blank.
 */
function Preview({ code, demo, bind }: { code: CustomCode; demo?: boolean; bind?: (send: Send | null) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const scale = width / 1920 || 0;
  const onBind = (send: Send | null) => {
    bind?.(send);
    if (!send) return;
    if (code.alerts) { if (demo) setTimeout(() => testEvent(send, 'subscriber', true), 600); }
    else for (let i = 0; i < 4; i++) testEvent(send, 'chat', false);
  };
  return (
    <div className="preview-box" ref={ref}>
      {scale > 0 && (
        <div className="preview-canvas" style={{ transform: `scale(${scale})` }}>
          <CustomFrame code={code} bind={onBind} />
        </div>
      )}
    </div>
  );
}

function OverlayEditor({ o, link, save, onBack, onCopy, onChange, onDelete }: {
  o: Overlay; link: string | null; save: 'saved' | 'saving' | 'error';
  onBack(): void; onCopy(): void; onChange(o: Overlay): void; onDelete(): void;
}) {
  const ch = useChannel();
  const toast = useToast();
  const code = codeOf(o);
  const send = useRef<Send | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [sureDelete, setSureDelete] = useState(false);
  const [media, setMedia] = useState<MediaFile[]>([]);
  const { fields, error } = parseFields(code.fields);
  const groups = useMemo(() => {
    const g = new Map<string, [string, Field][]>();
    for (const [k, f] of Object.entries(fields)) {
      const name = f.group || 'Settings';
      g.set(name, [...(g.get(name) ?? []), [k, f]]);
    }
    return [...g];
  }, [fields]);

  useEffect(() => {
    api.media(ch.key).then(setMedia).catch(() => {});
  }, [ch.key]);

  const setValue = (k: string, v: unknown) => {
    if (o.builtin) onChange({ ...o, values: { ...(o.values ?? {}), [k]: v } });
    else onChange({ ...o, code: { ...code, values: { ...code.values, [k]: v } } });
  };
  const valueOf = (k: string, f: Field) => (k in code.values ? code.values[k] : f.value);
  const setSounds = (sounds: OverlaySound[]) => onChange({ ...o, sounds });
  const sounds = media.filter((m) => isSound(m.id));

  const upload = async (file: File) => {
    try {
      const added = await api.uploadMedia(ch.key, file);
      setMedia((m) => [added, ...m.filter((x) => x.id !== added.id)]);
      return added;
    } catch (x) {
      toast(errorText(x), true);
      return null;
    }
  };

  return (
    <div className="page page-wide">
      <div className="editor-head">
        <button className="btn ghost" type="button" onClick={onBack}><Icon id="chevron-left" />All overlays</button>
        <span className={'save-state ' + save} role="status">{save === 'saving' ? 'Saving' : save === 'error' ? 'Not saved' : 'Saved'}</span>
      </div>
      <PageHead title={o.name}>
        <a className="btn" href={link ? link + '&debug' : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!link}><Icon id="external" />Open</a>
        <button className="btn primary" type="button" disabled={!link} onClick={onCopy}><Icon id="copy" />Copy link</button>
      </PageHead>

      <div className="overlay-edit">
        <div className="stack">
          <div className="card overlay-stage">
            <Preview code={code} bind={(s) => { send.current = s; }} />
          </div>
          <div className="try-row" role="group" aria-label="Try it">
            <span>Try it</span>
            {TRY.map((t) => (
              <button key={t.kind} className="btn sm" type="button" onClick={() => send.current && testEvent(send.current, t.kind, !!code.alerts)}>{t.label}</button>
            ))}
          </div>
          <p className="overlay-hint">This is the whole Browser Source at 1920 by 1080. Make it smaller and move it in OBS.</p>
        </div>

        <div className="stack">
          <Card id="ov-name" title="Name">
            <div className="card-body">
              <input className="input" aria-label="Name" value={o.name} maxLength={60} onChange={(e) => onChange({ ...o, name: e.target.value })} />
            </div>
          </Card>

          {groups.length > 0 && groups.map(([g, items]) => (
            <details key={g} className="card fold" open={groups.length <= 2 || g === groups[0][0]}>
              <summary><h2>{g}</h2><Icon id="chevron" /></summary>
              <div className="card-body field-grid">
                {items.map(([k, f]) => (
                  <FieldInput key={k} id={k} f={f} value={valueOf(k, f)} onChange={(v) => setValue(k, v)}
                    onPress={() => send.current?.({ type: 'button', field: k, value: f.value })} />
                ))}
              </div>
            </details>
          ))}
          {error && <div className="notice">{error}</div>}

          <details className="card fold" open={o.sounds.length > 0}>
            <summary><h2>Sounds{o.sounds.length > 0 && <span className="tab-count">{o.sounds.length}</span>}</h2><Icon id="chevron" /></summary>
            <div className="card-body">
              <p className="card-text">Play a sound on this overlay when something happens. Sounds stay quiet while alerts are muted.</p>
              <ul className="sound-list">
                {o.sounds.map((s, i) => (
                  <li key={i}>
                    <select className="select sm" aria-label="When" value={s.on} onChange={(e) => setSounds(o.sounds.map((x, j) => (j === i ? { ...x, on: e.target.value as SoundOn } : x)))}>
                      {SOUND_ON.filter((x) => x.id !== 'alert' || code.alerts).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                    <select className="select sm" aria-label="Sound" value={s.media} onChange={(e) => setSounds(o.sounds.map((x, j) => (j === i ? { ...x, media: e.target.value } : x)))}>
                      {!sounds.some((m) => m.id === s.media) && <option value={s.media}>{s.media || 'Pick a sound'}</option>}
                      {sounds.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <input className="volume" type="range" min={0} max={1} step={0.05} aria-label="Volume" value={s.volume}
                      onChange={(e) => setSounds(o.sounds.map((x, j) => (j === i ? { ...x, volume: Number(e.target.value) } : x)))} />
                    <button className="icon-btn" type="button" aria-label="Play" disabled={!s.media}
                      onClick={() => { const a = new Audio(mediaUrl(ch.key, s.media)); a.volume = s.volume; void a.play().catch(() => {}); }}><Icon id="play" /></button>
                    <button className="icon-btn" type="button" aria-label="Remove sound" onClick={() => setSounds(o.sounds.filter((_, j) => j !== i))}><Icon id="trash" /></button>
                  </li>
                ))}
              </ul>
              <div className="sound-add">
                <label className="btn sm">
                  <Icon id="plus" />{sounds.length ? 'Upload a sound' : 'Upload your first sound'}
                  <input type="file" accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav" hidden onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    const added = await upload(f);
                    if (added) setSounds([...o.sounds, { on: code.alerts ? 'alert' : 'chat', media: added.id, volume: 0.8 }]);
                  }} />
                </label>
                {sounds.length > 0 && (
                  <button className="btn sm" type="button" disabled={o.sounds.length >= 12}
                    onClick={() => setSounds([...o.sounds, { on: code.alerts ? 'alert' : 'chat', media: sounds[0].id, volume: 0.8 }])}>
                    Add a sound
                  </button>
                )}
              </div>
            </div>
          </details>

          <details className="card fold">
            <summary><h2>Advanced</h2><Icon id="chevron" /></summary>
            <div className="card-body adv">
              {o.builtin ? (
                <>
                  <p className="card-text">This overlay uses Sylva&apos;s own code, so it gets updates. To change the code, make a copy with New overlay.</p>
                  <button className="btn sm" type="button" onClick={() => onChange({ ...o, values: {} })}>Reset settings</button>
                </>
              ) : (
                <>
                  <p className="card-text">The overlay&apos;s HTML, CSS, JavaScript and fields. It runs in a sandbox, so it cannot reach your Sylva account.</p>
                  <div className="adv-row">
                    <button className="btn sm" type="button" onClick={() => setCodeOpen(true)}><Icon id="code" />Edit code</button>
                    <button className={'btn sm danger' + (sureDelete ? ' armed' : '')} type="button"
                      onClick={() => (sureDelete ? onDelete() : setSureDelete(true))}>
                      <Icon id="trash" />{sureDelete ? 'Click again to delete' : 'Delete overlay'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </details>
        </div>
      </div>

      {codeOpen && !o.builtin && (
        <CodeDialog
          initial={code}
          width={1920}
          height={1080}
          canPlayAlerts
          onClose={() => setCodeOpen(false)}
          onSave={(c) => { onChange({ ...o, code: c }); setCodeOpen(false); }}
        />
      )}
    </div>
  );
}

// The Song requests page: what is playing, the queue, and the rules for !sr.
// Sylva Control plays the audio; this page drives it through Sylva, and the
// rules match crates/sylva-core/src/songs.rs.

import { useCallback, useEffect, useState } from 'react';
import { api, type Builtin, type BotView, type BuiltinSetting, type Song, type SongSettings, type SongsView, type SongWho, type UserLevel } from './api';
import { useChannel } from './channel';
import { Select } from './dropdown';
import { NumberField } from './moderation';
import { Card, PageHead } from './pages';
import { errorText, Icon, SkelCard, Switch, useToast } from './ui';

export const SONG_WHO: { id: SongWho; label: string }[] = [
  { id: 'everyone', label: 'Everyone' },
  { id: 'followers', label: 'Followers and up' },
  { id: 'subscriber', label: 'Subscribers and up' },
  { id: 'vip', label: 'VIPs and up' },
  { id: 'moderator', label: 'Moderators only' },
];
const CMD_WHO: { id: UserLevel; label: string }[] = [
  { id: 'everyone', label: 'Everyone' },
  { id: 'subscriber', label: 'Subscribers and up' },
  { id: 'vip', label: 'VIPs and up' },
  { id: 'moderator', label: 'Moderators' },
  { id: 'broadcaster', label: 'Only you' },
];
const ORDER: UserLevel[] = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];
const LENGTHS = [180, 300, 420, 600, 900, 1200, 1800, 3600];
const CONTROL_URL = 'https://github.com/SylvaBot/sylva-control/releases/latest';

export function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Where the song is now, moving on between reports while it plays. */
export function usePosition(positionMs: number, at: number, playing: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [playing]);
  return playing ? positionMs + Math.max(0, now - at) : positionMs;
}

export function SongsPage() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<SongsView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api.songs(ch.key).then((v) => { setView(v); setFailed(false); }).catch(() => setFailed(true));
  }, [ch.key]);

  useEffect(() => {
    load();
    // Requests arrive from chat and Sylva Control reports as it plays.
    const t = setInterval(() => { if (!document.hidden) load(); }, 3_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (p: Promise<SongsView>, done?: string) => {
    try {
      setView(await p);
      if (done) toast(done);
    } catch (x) {
      toast(errorText(x), true);
    }
  };

  const saveSettings = (s: SongSettings, done: string) => run(api.saveSongSettings(ch.key, s), done);

  return (
    <div className="page">
      <PageHead title="Song requests" desc="Viewers ask for songs with !sr. Sylva Control plays the audio on your PC, so only you choose what reaches the stream.">
        {view && (
          <label className="sr-master">
            <span>{view.settings.enabled ? 'Taking requests' : 'Requests off'}</span>
            <Switch label="Song requests" on={view.settings.enabled} disabled={!ch.can.edit}
              onChange={(v) => void saveSettings({ ...view.settings, enabled: v }, v ? 'Song requests are on' : 'Song requests are off')} />
          </label>
        )}
      </PageHead>
      {failed && !view && <Card><div className="card-body"><p className="card-text">Could not load song requests. Refresh to try again.</p></div></Card>}
      {!view && !failed && <SkelCard rows={4} />}
      {view && (
        <div className="stack">
          {!view.playerOnline && (
            <div className="notice">
              <span>Sylva Control plays the songs. Open it on your streaming PC and the queue starts there.</span>
              <a className="btn sm" href={CONTROL_URL} target="_blank" rel="noreferrer"><Icon id="download" />Get Sylva Control</a>
            </div>
          )}
          <NowPlaying view={view} onRun={run} />
          <Queue view={view} onRun={run} />
          <Rules view={view} onSave={saveSettings} />
          <SongCommands />
          {view.history.length > 0 && <History list={view.history} />}
        </div>
      )}
    </div>
  );
}

function NowPlaying({ view, onRun }: { view: SongsView; onRun(p: Promise<SongsView>, done?: string): void }) {
  const ch = useChannel();
  const s = view.current;
  const p = view.playback;
  const loaded = !!s && p.songId === s.id && view.playerOnline;
  const playing = loaded && p.playing;
  const pos = usePosition(loaded ? p.positionMs : 0, p.at, playing);
  const total = (s?.durationS ?? 0) * 1000;
  const pct = total ? Math.min(100, (pos / total) * 100) : 0;
  const can = ch.can.moderate;

  return (
    <section className="sect" aria-labelledby="sr-now-title">
      <div className="sect-head"><div><h2 id="sr-now-title">Now playing</h2></div></div>
      <div className="card sr-now">
        {!s ? (
          <p className="empty"><Icon id="music" />Nothing is playing. The next request starts right away.</p>
        ) : (
          <>
            <div className="sr-now-row">
              <span className="tile" aria-hidden="true"><Icon id="music" /></span>
              <div className="sr-now-text">
                <a className="t1 sr-title" href={`https://youtu.be/${s.videoId}`} target="_blank" rel="noreferrer">{s.title}</a>
                <div className="t2">{[s.author, `asked by ${s.by}`].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="sr-ctl">
                <button className="icon-btn lg" type="button" disabled={!can || !view.playerOnline}
                  aria-label={playing ? 'Pause' : 'Play'}
                  onClick={() => onRun(api.songControl(ch.key, { action: playing ? 'pause' : 'play' }))}>
                  <Icon id={playing ? 'pause' : 'play'} />
                </button>
                <button className="icon-btn lg" type="button" disabled={!can} aria-label="Skip"
                  onClick={() => onRun(api.nextSong(ch.key, s.id), 'Skipped')}>
                  <Icon id="skip" />
                </button>
              </div>
            </div>
            <div className="sr-time">
              <span className="mono">{clock(pos / 1000)}</span>
              <input type="range" className="sr-seek" min={0} max={Math.max(1, total)} step={1000} value={Math.min(pos, total)}
                aria-label="Position" disabled={!can || !loaded || !total}
                style={{ '--p': pct + '%' } as React.CSSProperties}
                onChange={(e) => onRun(api.songControl(ch.key, { action: 'seek', positionMs: Number(e.target.value) }))} />
              <span className="mono">{total ? clock(total / 1000) : '-'}</span>
            </div>
            <div className="sr-foot">
              <span className="t2">{!view.playerOnline ? 'Waiting for Sylva Control' : p.status ? p.status : playing ? 'Playing in Sylva Control' : loaded ? 'Paused' : 'Loading in Sylva Control'}</span>
              <span className="slider">
                <Icon id="vol" />
                <input type="range" min={0} max={100} step={5} aria-label="Volume" value={p.volume} disabled={!can || !view.playerOnline}
                  style={{ '--p': p.volume + '%' } as React.CSSProperties}
                  onChange={(e) => onRun(api.songControl(ch.key, { action: 'volume', volume: Number(e.target.value) }))} />
                <span className="mono faint">{p.volume}%</span>
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Queue({ view, onRun }: { view: SongsView; onRun(p: Promise<SongsView>, done?: string): void }) {
  const ch = useChannel();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const can = ch.can.moderate;
  const q = view.queue;
  const total = q.reduce((n, s) => n + s.durationS, 0);

  const add = async () => {
    setBusy(true);
    await onRun(api.addSong(ch.key, query), 'Added to the queue');
    setBusy(false);
    setQuery('');
  };

  return (
    <Card id="sr-queue" title="Queue" desc={q.length ? `${q.length} song${q.length === 1 ? '' : 's'}, ${clock(total)} in all` : undefined}
      action={can && q.length > 0 ? <button className="btn sm" type="button" onClick={() => onRun(api.clearSongs(ch.key), 'Queue cleared')}>Clear</button> : undefined}>
      {can && (
        <form className="sr-add" onSubmit={(e) => { e.preventDefault(); if (query.trim()) void add(); }}>
          <label className="search sr-add-field">
            <Icon id="search" /><span className="sr-only">Add a song</span>
            <input className="input" placeholder="YouTube link or song name" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy || !query.trim()}><Icon id="plus" />{busy ? 'Adding' : 'Add'}</button>
        </form>
      )}
      <div className="grp">
        {q.length === 0 && <div className="empty">No songs waiting. Viewers add them with !sr and a link or a song name.</div>}
        {q.map((s, i) => (
          <div className="gr sr-row" key={s.id}>
            <div className="gr-main">
              <a className="t1 sr-title" href={`https://youtu.be/${s.videoId}`} target="_blank" rel="noreferrer">{s.title}</a>
              <div className="t2">{s.by} · {clock(s.durationS)}</div>
            </div>
            {can && (
              <div className="gr-ctl">
                <button className="icon-btn" type="button" aria-label={`Play ${s.title} next`} disabled={i === 0} onClick={() => onRun(api.moveSong(ch.key, s.id, 0))}><Icon id="arrow-up" /></button>
                <button className="icon-btn" type="button" aria-label={`Move ${s.title} down`} disabled={i === q.length - 1} onClick={() => onRun(api.moveSong(ch.key, s.id, i + 1))}><Icon id="arrow-down" /></button>
                <button className="icon-btn" type="button" aria-label={`Remove ${s.title}`} onClick={() => onRun(api.removeSong(ch.key, s.id), 'Removed')}><Icon id="trash" /></button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Rules({ view, onSave }: { view: SongsView; onSave(s: SongSettings, done: string): void }) {
  const ch = useChannel();
  const s = view.settings;
  const ro = !ch.can.edit;
  const set = (p: Partial<SongSettings>) => onSave({ ...s, ...p }, 'Saved');
  const lengths = LENGTHS.includes(s.maxDurationS) ? LENGTHS : [...LENGTHS, s.maxDurationS].sort((a, b) => a - b);
  return (
    <Card id="sr-rules" title="Rules" desc="Moderators and you skip the per viewer limit.">
      <div className="grp">
        <div className="gr">
          <div className="gr-main"><div className="t1">Who can request</div><div className="t2">Followers needs the commands permission on the Commands page.</div></div>
          <div className="gr-ctl"><Select<SongWho> id="sr-who" value={s.who} disabled={ro} onChange={(v) => set({ who: v })} options={SONG_WHO.map((w) => ({ value: w.id, label: w.label }))} /></div>
        </div>
        <div className="gr">
          <div className="gr-main"><div className="t1">Longest song</div></div>
          <div className="gr-ctl"><Select<number> id="sr-len" value={s.maxDurationS} disabled={ro} onChange={(v) => set({ maxDurationS: v })} options={lengths.map((n) => ({ value: n, label: `${Math.round(n / 60)} minutes` }))} /></div>
        </div>
        <div className="gr">
          <div className="gr-main"><div className="t1">Songs in the queue</div><div className="t2">Requests wait for room once it is full.</div></div>
          <div className="gr-ctl"><NumberField label="Songs in the queue" value={s.maxQueue} min={1} max={200} onChange={(n) => set({ maxQueue: n })} /></div>
        </div>
        <div className="gr">
          <div className="gr-main"><div className="t1">Songs each viewer can have waiting</div></div>
          <div className="gr-ctl"><NumberField label="Songs each viewer can have waiting" value={s.maxPerUser} min={1} max={20} onChange={(n) => set({ maxPerUser: n })} /></div>
        </div>
        <div className="gr">
          <div className="gr-main"><div className="t1">Only while live</div><div className="t2">Viewers can't request songs while you are offline.</div></div>
          <div className="gr-ctl"><Switch label="Only while live" on={s.liveOnly} disabled={ro} onChange={(v) => set({ liveOnly: v })} /></div>
        </div>
      </div>
    </Card>
  );
}

/** The song commands, saved with the rest of the bot's settings. */
function SongCommands() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<BotView | null>(null);
  useEffect(() => { api.bot(ch.key).then(setView).catch(() => setView(null)); }, [ch.key]);
  if (!view) return null;
  const list = view.builtins.filter((b) => b.group === 'music');
  const mine = (b: Builtin): BuiltinSetting => view.settings.builtins.find((x) => x.name === b.name) ?? { name: b.name, enabled: b.on, level: b.level, cooldown: b.cooldown };
  const setOne = async (b: Builtin, patch: Partial<BuiltinSetting>) => {
    const builtins = view.builtins.map((x) => (x.name === b.name ? { ...mine(x), ...patch } : mine(x)));
    try {
      setView(await api.saveBot(ch.key, { ...view.settings, builtins }));
      toast(`Saved !${b.name}`);
    } catch (x) {
      toast(errorText(x), true);
    }
  };
  return (
    <Card id="sr-cmds" title="Chat commands" desc={view.settings.enabled ? 'Who can use each one. !sr follows the Who can request rule too.' : 'These answer once the chat bot is on, on the Commands page.'}>
      <div className="grp">
        {list.map((b) => {
          const s = mine(b);
          const levels = CMD_WHO.filter((l) => ORDER.indexOf(l.id) >= ORDER.indexOf(b.min));
          return (
            <div className={'gr' + (s.enabled ? '' : ' off')} key={b.name}>
              <div className="gr-main">
                <div className="t1"><span className="mono">!{b.name}</span></div>
                <div className="t2">{b.about}{b.aliases.length ? `. Also ${b.aliases.map((a) => '!' + a).join(', ')}` : ''}</div>
              </div>
              <div className="gr-ctl">
                {b.name !== 'sr' && (
                  <Select<UserLevel> id={`sr-c-${b.name}`} value={s.level} disabled={!ch.can.edit} onChange={(v) => void setOne(b, { level: v })}
                    options={levels.map((l) => ({ value: l.id, label: l.label }))} />
                )}
                <Switch label={`!${b.name}`} on={s.enabled} disabled={!ch.can.edit} onChange={(v) => void setOne(b, { enabled: v })} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function History({ list }: { list: Song[] }) {
  return (
    <Card id="sr-history" title="Played">
      <div className="grp">
        {list.slice(0, 10).map((s) => (
          <div className="gr" key={s.id}>
            <div className="gr-main">
              <a className="t1 sr-title" href={`https://youtu.be/${s.videoId}`} target="_blank" rel="noreferrer">{s.title}</a>
              <div className="t2">{s.by} · {clock(s.durationS)}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

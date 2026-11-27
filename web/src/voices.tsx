// Kokoro voices: a grid to pick one (the tip page) or several (the
// dashboard), each with a short demo to play.

import { useEffect, useRef, useState } from 'react';
import type { TipVoice } from './api';
import { Icon } from './ui';

export const voiceMeta = (v: TipVoice) => `${v.accent === 'uk' ? 'British' : 'American'} · ${v.gender === 'f' ? 'Female' : 'Male'}`;

/** One demo plays at a time. */
export function useDemo() {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = (id: string) => {
    audio.current?.pause();
    if (playing === id) { setPlaying(null); return; }
    const a = new Audio(`/kokoro/demos/${encodeURIComponent(id)}.mp3`);
    const stop = () => setPlaying((p) => (p === id ? null : p));
    a.onended = stop;
    a.onerror = stop;
    audio.current = a;
    setPlaying(id);
    a.play().catch(stop);
  };
  return { playing, toggle };
}

/**
 * `pick`: one voice, as radio buttons. `allow`: switch voices on and off.
 * Shows `first` voices until "More voices" is pressed; picked ones always
 * show.
 */
export function VoiceGrid({ voices, mode, value, onChange, first = 6, label }: {
  voices: TipVoice[];
  mode: 'pick' | 'allow';
  value: string[];
  onChange(ids: string[]): void;
  first?: number;
  label: string;
}) {
  const demo = useDemo();
  const [all, setAll] = useState(false);
  const shown = all || voices.length <= first + 2 ? voices : voices.filter((v, i) => i < first || value.includes(v.id));
  const press = (id: string) => {
    if (mode === 'pick') onChange([id]);
    else onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };
  return (
    <div className="vp">
      <div className="vp-grid" role={mode === 'pick' ? 'radiogroup' : 'group'} aria-label={label}>
        {shown.map((v) => {
          const on = value.includes(v.id);
          const playing = demo.playing === v.id;
          return (
            <div key={v.id} className="vp-item" data-on={on || undefined}>
              <button type="button" className="vp-play" aria-label={`${playing ? 'Stop' : 'Play'} ${v.name}`} aria-pressed={playing} onClick={() => demo.toggle(v.id)}>
                <Icon id={playing ? 'pause' : 'play'} />
              </button>
              <button type="button" className="vp-pick" role={mode === 'pick' ? 'radio' : 'switch'} aria-checked={on} onClick={() => press(v.id)}>
                <span className="vp-name">{v.name}</span>
                <span className="vp-meta">{voiceMeta(v)}</span>
                {mode === 'allow' && <span className="vp-tick" aria-hidden="true">{on && <Icon id="check" />}</span>}
              </button>
            </div>
          );
        })}
      </div>
      {shown.length < voices.length && (
        <button type="button" className="vp-more" onClick={() => setAll(true)}>
          More voices<span>{voices.length - shown.length}</span>
        </button>
      )}
    </div>
  );
}

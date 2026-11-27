// Crop, zoom and position an image before it is uploaded. Drag to move,
// scroll or use the slider to zoom. The result is drawn on a canvas at a
// fixed size for its use, so uploads stay small and sharp.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui';

export type ImageKind = 'avatar' | 'banner' | 'tile' | 'fill';

const SPEC: Record<ImageKind, { title: string; aspect: number; out: [number, number] }> = {
  avatar: { title: 'Edit picture', aspect: 1, out: [512, 512] },
  banner: { title: 'Edit banner', aspect: 3, out: [1500, 500] },
  tile: { title: 'Edit background tile', aspect: 1, out: [512, 512] },
  fill: { title: 'Edit background', aspect: 16 / 9, out: [1920, 1080] },
};

const MAX_BYTES = 2_900_000;

function toBlob(c: HTMLCanvasElement, type: string, q: number) {
  return new Promise<Blob | null>((res) => c.toBlob(res, type, q));
}

export function ImageEditor({ file, kind, busy, onCancel, onDone }: {
  file: File; kind: ImageKind; busy: boolean; onCancel(): void; onDone(b: Blob): void;
}) {
  const spec = SPEC[kind];
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [bad, setBad] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [seamless, setSeamless] = useState(false);
  const [width, setWidth] = useState(() => Math.min(440, window.innerWidth - 64));
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setBad(true);
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const r = () => setWidth(Math.min(440, window.innerWidth - 64));
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('resize', r);
    document.addEventListener('keydown', key);
    dialog.current?.focus();
    return () => { window.removeEventListener('resize', r); document.removeEventListener('keydown', key); };
  }, [onCancel]);

  const fw = width;
  const fh = Math.round(width / spec.aspect);
  const base = img ? Math.max(fw / img.naturalWidth, fh / img.naturalHeight) : 1;
  const dw = img ? img.naturalWidth * base * zoom : fw;
  const dh = img ? img.naturalHeight * base * zoom : fh;
  const clamp = (p: { x: number; y: number }, w = dw, h = dh) => ({
    x: Math.max(-(w - fw) / 2, Math.min((w - fw) / 2, p.x)),
    y: Math.max(-(h - fh) / 2, Math.min((h - fh) / 2, p.y)),
  });
  const shown = clamp(pos);

  const setZoomKeep = (z: number) => {
    const nz = Math.max(1, Math.min(5, z));
    const k = nz / zoom;
    setZoom(nz);
    if (img) setPos((p) => clamp({ x: p.x * k, y: p.y * k }, img.naturalWidth * base * nz, img.naturalHeight * base * nz));
  };

  const save = async () => {
    if (!img) return;
    const [ow, oh] = spec.out;
    const crop = document.createElement('canvas');
    const cw = seamless ? ow / 2 : ow;
    const chh = seamless ? oh / 2 : oh;
    crop.width = cw;
    crop.height = chh;
    const g = crop.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    const k = cw / fw;
    g.drawImage(img, cw / 2 + shown.x * k - (dw * k) / 2, chh / 2 + shown.y * k - (dh * k) / 2, dw * k, dh * k);
    let out = crop;
    if (seamless) {
      // Mirror the crop into a 2 x 2 tile: every edge meets its own mirror.
      out = document.createElement('canvas');
      out.width = ow;
      out.height = oh;
      const m = out.getContext('2d')!;
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        m.setTransform(sx, 0, 0, sy, sx < 0 ? ow : 0, sy < 0 ? oh : 0);
        m.drawImage(crop, 0, 0);
      }
      m.setTransform(1, 0, 0, 1, 0, 0);
    }
    let blob = await toBlob(out, 'image/webp', 0.9);
    if (!blob || blob.type !== 'image/webp' || blob.size > MAX_BYTES) blob = await toBlob(out, 'image/jpeg', 0.88);
    if (blob && blob.size > MAX_BYTES) blob = await toBlob(out, 'image/jpeg', 0.7);
    if (blob) onDone(blob);
  };

  return (
    <div className="ie-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div ref={dialog} className="ie-dialog" role="dialog" aria-modal="true" aria-label={spec.title} tabIndex={-1}>
        <div className="ie-head">
          <h2>{spec.title}</h2>
          <button className="ta-icon" type="button" aria-label="Close" onClick={onCancel} disabled={busy}><Icon id="x" /></button>
        </div>
        {bad ? <p className="ie-bad">That file could not be opened. Pick a PNG, JPG, GIF or WebP image.</p> : (
          <div
            className={'ie-frame' + (kind === 'avatar' ? ' round' : '')}
            style={{ width: fw, height: fh }}
            onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: shown.x, py: shown.y }; }}
            onPointerMove={(e) => { const d = drag.current; if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })); }}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
            onWheel={(e) => setZoomKeep(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
          >
            {img && <img src={img.src} alt="" draggable={false} style={{ width: dw, height: dh, transform: `translate(calc(-50% + ${shown.x}px), calc(-50% + ${shown.y}px))` }} />}
            {kind === 'avatar' && <span className="ie-mask" />}
          </div>
        )}
        <div className="ie-controls">
          <Icon id="image" />
          <input type="range" min={1} max={5} step={0.01} value={zoom} aria-label="Zoom" onChange={(e) => setZoomKeep(Number(e.target.value))} />
          <button className="btn ghost sm" type="button" onClick={() => { setZoom(1); setPos({ x: 0, y: 0 }); }}>Reset</button>
        </div>
        {kind === 'tile' && (
          <label className="ie-option">
            <button className="switch" type="button" role="switch" aria-checked={seamless} aria-label="Make it seamless" onClick={() => setSeamless(!seamless)} />
            <span>Make it seamless<span>Mirrors the image so every edge meets itself when it repeats.</span></span>
          </label>
        )}
        {file.type === 'image/gif' && <p className="ie-note">Animated GIFs are saved as a still image.</p>}
        <div className="ie-foot">
          <span className="ie-hint">Drag to move. Scroll to zoom.</span>
          <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn primary" type="button" onClick={() => void save()} disabled={busy || !img}>{busy ? 'Uploading' : 'Use image'}</button>
        </div>
      </div>
    </div>
  );
}

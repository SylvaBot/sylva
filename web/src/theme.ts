// Dark is Sylva's default. "System" follows the device. The choice is kept in
// this browser only; index.html applies it, and the density and motion
// choices, before the page paints.

export type Theme = 'dark' | 'light' | 'system';
export type Density = 'comfortable' | 'compact';
/** "system" follows the device's reduce motion setting. */
export type Motion = 'system' | 'reduce' | 'full';
const KEY = 'sylva.theme';
const media = () => matchMedia('(prefers-color-scheme: light)');
const motionMedia = () => matchMedia('(prefers-reduced-motion: reduce)');

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window: still applies for this visit */ }
}

export function getTheme(): Theme {
  const t = read(KEY);
  return t === 'light' || t === 'system' ? t : 'dark';
}

function apply(t: Theme) {
  const light = t === 'light' || (t === 'system' && media().matches);
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f6f6f3' : '#0a0a0a');
}

export function setTheme(t: Theme) {
  write(KEY, t);
  apply(t);
}

export const getDensity = (): Density => (read('sylva.density') === 'compact' ? 'compact' : 'comfortable');
export function setDensity(d: Density) {
  write('sylva.density', d);
  if (d === 'compact') document.documentElement.dataset.density = 'compact';
  else delete document.documentElement.dataset.density;
}

export function getMotion(): Motion {
  const m = read('sylva.motion');
  return m === 'reduce' || m === 'full' ? m : 'system';
}
function applyMotion(m: Motion) {
  if (m === 'reduce' || (m === 'system' && motionMedia().matches)) document.documentElement.dataset.motion = 'reduce';
  else delete document.documentElement.dataset.motion;
}
export function setMotion(m: Motion) {
  write('sylva.motion', m);
  applyMotion(m);
}

/** Keep "System" in step with the device, and set the browser's bar color. */
export function watchTheme() {
  apply(getTheme());
  applyMotion(getMotion());
  media().addEventListener('change', () => {
    if (getTheme() === 'system') apply('system');
  });
  motionMedia().addEventListener('change', () => applyMotion(getMotion()));
}

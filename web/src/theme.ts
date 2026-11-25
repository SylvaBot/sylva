// Dark is Sylva's default. "System" follows the device. The choice is kept in
// this browser only; index.html applies it before the page paints.

export type Theme = 'dark' | 'light' | 'system';
const KEY = 'sylva.theme';
const media = () => matchMedia('(prefers-color-scheme: light)');

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'system' ? t : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(t: Theme) {
  const light = t === 'light' || (t === 'system' && media().matches);
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f7f7f8' : '#0e0e10');
}

export function setTheme(t: Theme) {
  try { localStorage.setItem(KEY, t); } catch { /* private window: still applies for this visit */ }
  apply(t);
}

/** Keep "System" in step with the device, and set the browser's bar color. */
export function watchTheme() {
  apply(getTheme());
  media().addEventListener('change', () => {
    if (getTheme() === 'system') apply('system');
  });
}

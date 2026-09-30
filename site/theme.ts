/**
 * Applies the viewer's stored light/dark choice before first paint. Loaded as a classic,
 * render-blocking script in <head> so the prerendered page never flashes the other theme;
 * site/app.ts owns the toggle and writes the same `a0-theme` key.
 */
try {
  const t = localStorage.getItem('a0-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  // storage unavailable: the system setting applies
}

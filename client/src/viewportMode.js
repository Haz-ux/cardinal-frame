// ─── Viewport Mode Toggle ──────────────────────────────────────────
// Lets mobile webviews force the desktop layout by overriding the
// viewport meta width. Some Android webviews / in-app browsers only
// flip the user-agent for "Desktop Mode" and keep a phone-width
// layout viewport, so CSS media queries never switch to desktop.
// Here we change the viewport meta itself: width=1280 makes every
// md:/lg: breakpoint fire, rendering the real desktop layout scaled
// to fit the screen.
//
// Persisted in localStorage. Applied on app boot via applyViewportMode().

const KEY = 'cf_viewport_mode';
const DESKTOP_WIDTH = 1280;
const MOBILE_CONTENT = 'width=device-width, initial-scale=1.0, viewport-fit=cover';

export function isDesktopMode() {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(KEY) === 'desktop';
}

export function applyViewportMode() {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute('content', isDesktopMode() ? `width=${DESKTOP_WIDTH}, initial-scale=1` : MOBILE_CONTENT);
}

export function toggleDesktopMode() {
  const next = isDesktopMode() ? 'mobile' : 'desktop';
  localStorage.setItem(KEY, next);
  applyViewportMode();
  return next === 'desktop';
}

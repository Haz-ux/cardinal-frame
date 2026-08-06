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

// Detect the viewing browser's own mode rather than the physical device:
// mobile browsers advertise Mobile/Android/iPhone (or userAgentData.mobile);
// "Desktop site" / desktop browsers do not. Touch + narrow viewport is a
// fallback for webviews that omit the mobile UA token.
export function detectBrowserMode() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'mobile';
  const uad = navigator.userAgentData;
  if (uad && typeof uad.mobile === 'boolean') return uad.mobile ? 'mobile' : 'desktop';
  const ua = navigator.userAgent || '';
  if (/Mobi|Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(ua)) return 'mobile';
  const touch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (touch && window.innerWidth < 768) return 'mobile';
  return 'desktop';
}

export function getViewportMode() {
  const saved = localStorage.getItem(KEY);
  return saved === 'mobile' || saved === 'desktop' ? saved : detectBrowserMode();
}

export function applyViewportMode() {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute('content', getViewportMode() === 'desktop' ? `width=${DESKTOP_WIDTH}, initial-scale=1` : MOBILE_CONTENT);
}

// Boot-time applier for the pre-auth screens (login + splash): always follows
// the browser's detected mode, ignoring any stale persisted preference.
export function applyDetectedViewport() {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute('content', detectBrowserMode() === 'desktop' ? `width=${DESKTOP_WIDTH}, initial-scale=1` : MOBILE_CONTENT);
}

export function toggleDesktopMode() {
  const next = isDesktopMode() ? 'mobile' : 'desktop';
  localStorage.setItem(KEY, next);
  applyViewportMode();
  return next === 'desktop';
}

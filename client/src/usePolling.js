/**
 * Visibility-aware polling hook.
 * Replaces raw setInterval(fn, ms) with automatic pause/resume:
 *   - Pauses when document.hidden = true (tab in background)
 *   - Resumes immediately on visibility change to visible
 *   - Calls fn once on mount (like the old pattern)
 *   - Cleans up on unmount
 *
 * Usage:
 *   usePolling(load, 15000);              // standard
 *   usePolling(load, 8000, active);       // conditional (active = boolean)
 */
import { useEffect, useRef } from 'react';

export function usePolling(fn, interval, active = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!active) return;

    // Initial call
    fnRef.current();

    let id = setInterval(() => {
      if (!document.hidden) fnRef.current();
    }, interval);

    const onVisible = () => {
      if (!document.hidden) {
        clearInterval(id);
        fnRef.current();
        id = setInterval(() => {
          if (!document.hidden) fnRef.current();
        }, interval);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [interval, active]);
}

/**
 * WebSocket-first resource hook with polling fallback.
 *
 * When WebSocket is connected and broadcasts matching messages,
 * the hook uses the pushed data and skips polling.
 * When WebSocket is disconnected, it falls back to polling.
 *
 * Usage:
 *   useWsResource(load, 'telemetry', 5000);
 *   useWsResource(load, ['task:status', 'task:deleted', 'task:created'], 15000);
 *   // load = async fn that fetches data
 *   // 'telemetry' = WS message type (or array of types) that triggers a reload
 *   // 5000 = fallback polling interval
 */
import { useEffect, useRef, useCallback } from 'react';
import { useWebSocket } from './useWebSocket.js';

export function useWsResource(fn, wsType, interval = 10000) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const { lastMsg, connected } = useWebSocket();
  const lastPollRef = useRef(0);

  // Normalize wsType to array for matching
  const wsTypes = Array.isArray(wsType) ? wsType : [wsType];

  // Reload when matching WS message arrives
  useEffect(() => {
    if (lastMsg && wsTypes.includes(lastMsg.type)) {
      fnRef.current();
    }
  }, [lastMsg, wsType]);

  // Fallback polling — only when WS is NOT connected
  useEffect(() => {
    if (connected) return; // WS handles updates, skip polling

    // Initial load
    fnRef.current();

    let id = setInterval(() => {
      if (!document.hidden) fnRef.current();
    }, interval);

    const onVisible = () => {
      if (!document.hidden && !connected) {
        clearInterval(id);
        fnRef.current();
        id = setInterval(() => {
          if (!document.hidden && !connected) fnRef.current();
        }, interval);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [interval, connected, wsType]);
}

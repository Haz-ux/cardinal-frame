import { useEffect, useRef, useState, useCallback } from 'react';

// Singleton WebSocket — shared across all components
let wsInstance = null;
let listeners = new Set();
let connectedState = false;

function getWS() {
  if (wsInstance && wsInstance.readyState <= 1) return wsInstance;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(url);
  wsInstance = ws;

  ws.onopen = () => {
    connectedState = true;
    listeners.forEach(l => l.setConnected(true));
  };
  ws.onclose = () => {
    connectedState = false;
    listeners.forEach(l => l.setConnected(false));
    wsInstance = null;
    setTimeout(() => { if (listeners.size > 0) getWS(); }, 3000);
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      listeners.forEach(l => l.setLastMsg(msg));
    } catch {}
  };

  return ws;
}

export function useWebSocket() {
  const [lastMsg, setLastMsg] = useState(null);
  const [connected, setConnected] = useState(connectedState);
  const ref = useRef({ setLastMsg, setConnected });
  const subscriptionsRef = useRef(new Set());

  useEffect(() => {
    ref.current = { setLastMsg, setConnected };
    const listener = { setLastMsg: (m) => ref.current.setLastMsg(m), setConnected: (c) => ref.current.setConnected(c) };
    listeners.add(listener);
    getWS();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && wsInstance) {
        wsInstance.close();
        wsInstance = null;
      }
    };
  }, []);

  const subscribe = useCallback((taskId) => {
    subscriptionsRef.current.add(taskId);
    const ws = getWS();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'subscribe', taskId }));
    }
  }, []);

  const unsubscribe = useCallback((taskId) => {
    subscriptionsRef.current.delete(taskId);
    const ws = getWS();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'unsubscribe', taskId }));
    }
  }, []);

  return { lastMsg, connected, subscribe, unsubscribe };
}

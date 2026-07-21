import { useEffect, useRef, useState, useCallback } from "react";

interface WSMessage {
  type: string;
  payload: any;
  ts: number;
}

interface UseWSReturn {
  messages: WSMessage[];
  connected: boolean;
  lastMessage: WSMessage | null;
}

export function useWebSocket(): UseWSReturn {
  const [messages, setMessages] = useState<WSMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        setMessages((prev) => [...prev.slice(-49), msg]); // keep last 50
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  return { messages, connected, lastMessage };
}

/** Subscribe to specific WS event types */
export function useWSEvent(eventType: string) {
  const { messages } = useWebSocket();
  return messages.filter((m) => m.type === eventType);
}

/** Task status tracker via WS */
export function useTaskStatusWS() {
  const { lastMessage, connected } = useWebSocket();
  const [taskUpdates, setTaskUpdates] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "task:status" || lastMessage.type === "task:created" || lastMessage.type === "task:deleted") {
      const { id, ...rest } = lastMessage.payload;
      setTaskUpdates((prev) => ({ ...prev, [id]: { type: lastMessage.type, ...rest, ts: lastMessage.ts } }));
    }
  }, [lastMessage]);

  return { taskUpdates, connected };
}

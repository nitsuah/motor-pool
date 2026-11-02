import { useState, useRef, useEffect } from 'react';

/**
 * Manages a WebSocket connection to /ws/events with auto-reconnect.
 * onEvent is called for each valid event payload — store it in a ref on the
 * call-site so the effect never needs to re-run when the handler changes.
 */
export function useWebSocket({ onEvent }) {
  const [wsConnected, setWsConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    let destroyed = false;
    const connect = () => {
      if (destroyed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${scheme}://${window.location.host}/ws/events`);
      wsRef.current = socket;
      socket.onopen = () => { attemptRef.current = 0; setWsConnected(true); };
      socket.onclose = () => {
        setWsConnected(false);
        if (!destroyed) {
          const base = Math.min(30000, 1000 * Math.pow(2, attemptRef.current));
          const jitter = typeof crypto !== 'undefined' && crypto.getRandomValues
            ? crypto.getRandomValues(new Uint32Array(1))[0] / 0xFFFFFFFF
            : Math.random();
          const delay = base * (0.8 + 0.4 * jitter);
          attemptRef.current += 1;
          reconnectTimerRef.current = setTimeout(connect, delay);
        }
      };
      socket.onerror = () => setWsConnected(false);
      socket.onmessage = (msg) => {
        try {
          const payload = JSON.parse(msg.data);
          if (payload.type !== 'event' || !payload.event) return;
          onEventRef.current?.(payload.event);
        } catch { /* ignore malformed payloads */ }
      };
    };
    connect();
    return () => {
      destroyed = true;
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { wsConnected };
}

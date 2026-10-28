import { useState, useRef, useCallback } from 'react';
import { toast } from '../components/Toast.jsx';

/**
 * Encapsulates all session message-sending state: streaming, queuing, pausing.
 *
 * Mutable dependencies (activeSession, setActiveSessionMessages, useNemoClaw,
 * fetchSessions, fetchSessionDetails) are kept in refs so the core callbacks
 * stay stable (no re-creation on every render).
 */
export function useSessionStreaming({
  activeSession,
  setActiveSessionMessages,
  useNemoClaw,
  fetchSessions,
  fetchSessionDetails,
  nineRouterCombo,
}) {
  // ── Streaming state ───────────────────────────────────────────────────────
  const [loadingSessions, setLoadingSessions] = useState(new Set());
  const [streamingBySession, setStreamingBySession] = useState({});
  const [sessionPendingReply, setSessionPendingReply] = useState(new Set());
  const [sessionErrors, setSessionErrors] = useState(new Set());

  // ── Queue + pause state ───────────────────────────────────────────────────
  const messageQueuesRef = useRef({});
  const [queueLengths, setQueueLengths] = useState({});
  const pausedSessionsRef = useRef(new Set());
  const [pausedSessions, setPausedSessions] = useState(new Set());

  // Abort controllers keyed by sessionId
  const abortControllersRef = useRef(new Map());
  // Sessions where forceSend owns the next drain (finally block must not drain)
  const skipDrainRef = useRef(new Set());

  // Keep mutable prop values current in refs so stable callbacks below always
  // read the latest value without needing to be recreated.
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

  const setActiveSessionMessagesRef = useRef(setActiveSessionMessages);
  setActiveSessionMessagesRef.current = setActiveSessionMessages;

  const useNemoClawRef = useRef(useNemoClaw);
  useNemoClawRef.current = useNemoClaw;

  const fetchSessionsRef = useRef(fetchSessions);
  fetchSessionsRef.current = fetchSessions;

  const fetchSessionDetailsRef = useRef(fetchSessionDetails);
  fetchSessionDetailsRef.current = fetchSessionDetails;

  const nineRouterComboRef = useRef(nineRouterCombo);
  nineRouterComboRef.current = nineRouterCombo;

  // ── Queue helpers ─────────────────────────────────────────────────────────
  const enqueueMessage = useCallback((sessionId, message) => {
    if (!messageQueuesRef.current[sessionId]) messageQueuesRef.current[sessionId] = [];
    messageQueuesRef.current[sessionId].push(message);
    setQueueLengths(prev => ({ ...prev, [sessionId]: messageQueuesRef.current[sessionId].length }));
  }, []);

  const dequeueNext = useCallback((sessionId) => {
    const queue = messageQueuesRef.current[sessionId];
    if (!queue || queue.length === 0) return null;
    const msg = queue.shift();
    setQueueLengths(prev => {
      const len = (messageQueuesRef.current[sessionId] || []).length;
      const next = { ...prev };
      if (len === 0) delete next[sessionId]; else next[sessionId] = len;
      return next;
    });
    return msg;
  }, []);

  // ── Core streaming ────────────────────────────────────────────────────────
  const sendMessageCore = useCallback(async (sessionId, messageText) => {
    const currentActive = activeSessionRef.current;
    const setMessages = setActiveSessionMessagesRef.current;
    const useSafeMode = useNemoClawRef.current;

    const optimisticMsg = { role: 'user', content: messageText, timestamp: new Date() };
    if (sessionId === currentActive) setMessages(prev => [...prev, optimisticMsg]);

    setLoadingSessions(prev => new Set([...prev, sessionId]));
    setStreamingBySession(prev => ({ ...prev, [sessionId]: '' }));
    setSessionPendingReply(prev => { const n = new Set(prev); n.delete(sessionId); return n; });
    setSessionErrors(prev => { const n = new Set(prev); n.delete(sessionId); return n; });

    const controller = new AbortController();
    abortControllersRef.current.set(sessionId, controller);

    try {
      const res = await fetch(`/api/sessions/${sessionId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageText, useSafeMode, combo: nineRouterComboRef.current || undefined }),
        signal: controller.signal,
      });
      if (!res.ok) throw Object.assign(new Error(`Stream request failed: ${res.status}`), { isHttpError: true });
      if (!res.body) throw Object.assign(new Error('No response body'), { isHttpError: true });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          try {
            const event = JSON.parse(json);
            if (event.type === 'token') {
              accumulated += event.content;
              setStreamingBySession(prev => ({ ...prev, [sessionId]: accumulated }));
            } else if (event.type === 'reset') {
              // A model may stream a short preamble before choosing a tool. It
              // is provisional until the tool decision is known; clear it before
              // showing the final post-tool answer.
              accumulated = '';
              setStreamingBySession(prev => ({ ...prev, [sessionId]: '' }));
            } else if (event.type === 'tool_call') {
              const toolMsg = { role: 'tool_call', tool: event.tool, args: event.args, result: event.result, timestamp: new Date() };
              if (sessionId === activeSessionRef.current) setActiveSessionMessagesRef.current(prev => [...prev, toolMsg]);
            } else if (event.type === 'done' || event.type === 'error') {
              if (event.type === 'error') {
                toast.error(event.message || 'LLM stream error');
                setSessionErrors(prev => new Set([...prev, sessionId]));
              } else {
                setSessionPendingReply(prev => new Set([...prev, sessionId]));
              }
              setStreamingBySession(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
              fetchSessionsRef.current?.();
              fetchSessionDetailsRef.current?.(sessionId);
            }
          } catch { /* skip malformed SSE */ }
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        // intentional abort — nothing to do
      } else if (error.isHttpError) {
        setSessionErrors(prev => new Set([...prev, sessionId]));
        toast.error(error.message);
      } else {
        setSessionErrors(prev => new Set([...prev, sessionId]));
        try {
          const res = await fetch(`/api/sessions/${sessionId}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: messageText, useSafeMode: useNemoClawRef.current }),
          });
          const data = await res.json();
          fetchSessionsRef.current?.();
          fetchSessionDetailsRef.current?.(sessionId);
          if (data.success) {
            setSessionErrors(prev => { const n = new Set(prev); n.delete(sessionId); return n; });
          } else {
            toast.error(data.response || 'LLM error');
          }
        } catch (fbErr) {
          toast.error(`Send failed: ${fbErr.message}`);
          if (sessionId === activeSessionRef.current) {
            setActiveSessionMessagesRef.current(prev => prev.filter(m => m !== optimisticMsg));
          }
        }
      }
    } finally {
      abortControllersRef.current.delete(sessionId);
      setLoadingSessions(prev => { const next = new Set(prev); next.delete(sessionId); return next; });
      setStreamingBySession(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
      const skipDrain = skipDrainRef.current.has(sessionId);
      skipDrainRef.current.delete(sessionId);
      if (!skipDrain && !pausedSessionsRef.current.has(sessionId)) {
        const nextMsg = dequeueNext(sessionId);
        if (nextMsg) setTimeout(() => sendMessageCore(sessionId, nextMsg), 50);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dequeueNext]);

  // ── Session control ───────────────────────────────────────────────────────
  const stopSession = useCallback((sessionId) => {
    const ctrl = abortControllersRef.current.get(sessionId);
    if (ctrl) { ctrl.abort(); abortControllersRef.current.delete(sessionId); }
    setLoadingSessions(prev => { const next = new Set(prev); next.delete(sessionId); return next; });
    setStreamingBySession(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
  }, []);

  const togglePause = useCallback((sessionId) => {
    const next = new Set(pausedSessionsRef.current);
    if (next.has(sessionId)) {
      next.delete(sessionId);
      pausedSessionsRef.current = next;
      setPausedSessions(next);
      if (!abortControllersRef.current.has(sessionId)) {
        const nextMsg = dequeueNext(sessionId);
        if (nextMsg) sendMessageCore(sessionId, nextMsg);
      }
    } else {
      next.add(sessionId);
      pausedSessionsRef.current = next;
      setPausedSessions(next);
    }
  }, [dequeueNext, sendMessageCore]);

  const forceSend = useCallback((sessionId) => {
    skipDrainRef.current.add(sessionId);
    stopSession(sessionId);
    const nextMsg = dequeueNext(sessionId);
    if (nextMsg) setTimeout(() => sendMessageCore(sessionId, nextMsg), 50);
  }, [stopSession, dequeueNext, sendMessageCore]);

  return {
    loadingSessions,
    streamingBySession,
    sessionPendingReply,
    sessionErrors,
    queueLengths,
    pausedSessions,
    sendMessageCore,
    enqueueMessage,
    togglePause,
    stopSession,
    forceSend,
  };
}

import axios from 'axios';
import { buildSystemMessages, outputFiltersActive } from '../safety.js';
import { preflightTurn, ensureTurnTool, finalizeReply, recordTurnError } from '../modules/session-turn.js';

/**
 * POST /api/sessions/:id/stream — SSE frames: token | reset | tool_call | done | error.
 *
 * Runs the same safety pipeline as /message (modules/session-turn.js):
 * prompt handlers, input classification/blocking, output sanitization, output
 * controls, events. Streaming vs. filtering trade-off: when the session's safety
 * mode has active output filters (strict: PII redaction + harmful-content block),
 * tokens are buffered and the sanitized reply is sent as one token, so unfiltered
 * text never reaches the client. Otherwise tokens stream live and the persisted
 * reply (after output controls such as truncation) is what the UI shows once it
 * refetches the session on `done`.
 */
export async function handleSessionStream(req, res, deps) {
  const {
    sessions, LLM_CONFIG, DEVICE_PROFILE,
    resolveEndpointUrl, prepareSessionForLlmCall,
    getExperienceTools, runAgentLoop, activeDockerRunnerModelRef, logStructured,
  } = deps;
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

  const { message, useSafeMode = false } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Message is required' });
  if (typeof useSafeMode !== 'boolean') return res.status(400).json({ success: false, error: 'useSafeMode must be a boolean' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const end = () => { if (!res.writableEnded) res.end(); };

  // Client disconnect is tracked from the start, so leaving during preflight or
  // model prep isn't missed; the streaming phase installs what to tear down.
  let clientGone = false;
  let onClientGone = null;
  res.on('close', () => {
    if (res.writableFinished) return;
    clientGone = true;
    onClientGone?.();
  });

  const turn = await preflightTurn(session, message, useSafeMode, deps);
  if (turn.kind !== 'proceed') {
    send({ type: 'token', content: turn.response });
    send({ type: 'done', messageCount: session.messages.length, blocked: turn.blocked, classification: turn.classification });
    return end();
  }

  const tool = await ensureTurnTool(session, deps);
  if (!tool.ready) {
    send({ type: 'error', message: tool.error });
    return end();
  }

  const { safetyMode } = turn;
  const buffered = outputFiltersActive(safetyMode);
  const msgStart = Date.now();
  session.status = 'running';
  session.lastActivity = new Date();

  // Exactly one terminal outcome per turn, whichever path gets there first.
  let finished = false;
  const finishReply = (raw, { partial = false, toolLog } = {}) => {
    if (finished) return null;
    finished = true;
    return finalizeReply(session, raw, safetyMode, deps, { latencyMs: Date.now() - msgStart, partial, toolLog });
  };
  const finishError = (errMsg, error) => {
    if (finished) return;
    finished = true;
    recordTurnError(session, errMsg, error, deps);
  };

  let llmUrl = session.llmUrl;
  try {
    if (session.endpoint === 'primary') {
      session.llmUrl = await resolveEndpointUrl('primary');
    }
    const prepared = await prepareSessionForLlmCall(session);
    if (LLM_CONFIG[session.endpoint]?.backendType === 'docker-runner') {
      activeDockerRunnerModelRef.current = { key: session.endpoint, model: session.model, at: new Date() };
    }
    llmUrl = prepared.llmUrl;
    const { apiStyle, apiKey } = prepared;
    const streamHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const systemMessages = buildSystemMessages({ ...session, safetyMode });
    const historyMessages = session.messages.map(m => ({ role: m.role, content: m.content }));
    const msgs = [...systemMessages, ...historyMessages];

    const experienceStreamTools = useSafeMode ? [] : getExperienceTools(session.experience);

    // Tool-enabled experiences stream model tokens and each completed tool
    // result through the same safety/finalization path as ordinary turns.
    if (experienceStreamTools.length > 0) {
      const upstream = new AbortController();
      onClientGone = () => upstream.abort();
      if (clientGone) upstream.abort();
      let streamedContent = false;
      try {
        const { content: loopContent, toolLog } = await runAgentLoop(
          msgs, apiStyle, llmUrl, streamHeaders, experienceStreamTools, session,
          {
            stream: true,
            signal: upstream.signal,
            onToken: buffered ? undefined : (content) => {
              streamedContent = true;
              send({ type: 'token', content });
            },
            onReset: buffered ? undefined : () => {
              streamedContent = false;
              send({ type: 'reset' });
            },
            onToolCall: (entry) => send({ type: 'tool_call', tool: entry.name, args: entry.args, result: entry.result }),
          },
        );
        const reply = finishReply(loopContent, { toolLog });
        // Truncation changes the text after it has been streamed. Replace the
        // provisional chunks with the persisted, output-capped reply so the UI
        // and transcript stay consistent.
        if (reply.truncated && streamedContent) {
          streamedContent = false;
          send({ type: 'reset' });
        }
        if (buffered || !streamedContent) send({ type: 'token', content: reply.content });
        send({ type: 'done', messageCount: session.messages.length, blocked: reply.blocked, redacted: reply.redacted, truncated: reply.truncated });
      } catch (error) {
        if (clientGone) {
          finishError('[Error] Client disconnected before the agent replied', error);
          return end();
        }
        const errMsg = `[Error] Agent loop failed: ${error.message}`;
        finishError(errMsg, error);
        send({ type: 'error', message: errMsg });
      }
      return end();
    }

    // A disconnect before the model answers cancels the upstream request
    // instead of waiting on it (a cold model load can take minutes).
    const upstream = new AbortController();
    onClientGone = () => upstream.abort();
    if (clientGone) upstream.abort();
    const streamResponse = await axios.post(
      apiStyle === 'openai' ? `${llmUrl}/chat/completions` : `${llmUrl}/api/chat`,
      { model: session.model, messages: msgs, stream: true },
      { headers: streamHeaders, responseType: 'stream', timeout: 120000, signal: upstream.signal }
    );

    let raw = '';
    const completeReply = ({ partial = false } = {}) => {
      const reply = finishReply(raw || 'No response received', { partial });
      if (!reply) return null;
      // Buffered: the sanitized reply is the only token. Live: tokens already
      // went out — unless the model sent nothing, then show the placeholder.
      if (buffered || !raw) send({ type: 'token', content: reply.content });
      return reply;
    };

    const STALL_TIMEOUT_MS = 30_000;
    let stallTimer = null;
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        streamResponse.data.destroy();
        if (raw) {
          const reply = completeReply({ partial: true });
          if (reply) send({ type: 'done', messageCount: session.messages.length, truncated: true, blocked: reply.blocked, redacted: reply.redacted });
        } else {
          finishError('[Error] LLM stream stalled — no data for 30s');
          send({ type: 'error', message: '[Error] LLM stream stalled — no data for 30s' });
        }
        end();
      }, STALL_TIMEOUT_MS);
    };
    resetStallTimer();

    // Upstream chunks don't align with lines: buffer partial lines across chunks.
    let lineBuf = '';
    const consumeLine = (line) => {
      if (!line.trim()) return;
      const text = line.startsWith('data: ') ? line.slice(6) : line;
      if (text.trim() === '[DONE]') return;
      try {
        const parsed = JSON.parse(text);
        const token = parsed.choices?.[0]?.delta?.content ?? parsed.message?.content ?? '';
        if (token) {
          raw += token;
          if (!buffered) send({ type: 'token', content: token });
        }
      } catch { /* non-JSON line, skip */ }
    };
    streamResponse.data.on('data', (chunk) => {
      resetStallTimer();
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      lines.forEach(consumeLine);
    });

    streamResponse.data.on('end', () => {
      clearTimeout(stallTimer);
      consumeLine(lineBuf);
      lineBuf = '';
      const reply = completeReply();
      if (reply) send({ type: 'done', messageCount: session.messages.length, blocked: reply.blocked, redacted: reply.redacted, truncated: reply.truncated });
      end();
    });

    streamResponse.data.on('error', (err) => {
      clearTimeout(stallTimer);
      if (finished) return end();
      logStructured('warn', 'stream_data_error', { session_id: session.id, error: err.message });
      const errMsg = `[Error] Stream failed: ${err.message}`;
      if (raw) completeReply({ partial: true }); // keep (sanitized) partial content
      else finishError(errMsg, err);
      send({ type: 'error', message: errMsg });
      end();
    });

    // Client went away: stop the upstream stream and keep whatever arrived, or
    // record the turn as ended so the session never stays "running".
    onClientGone = () => {
      clearTimeout(stallTimer);
      streamResponse.data.destroy();
      if (raw) finishReply(raw, { partial: true });
      else finishError('[Error] Client disconnected before the model replied');
    };
    if (clientGone) onClientGone();
  } catch (error) {
    if (clientGone) {
      finishError('[Error] Client disconnected before the model replied', error);
      return end();
    }
    logStructured('error', 'llm_stream_failed', { sessionId: session.id, endpoint: session.endpoint, model: session.model, error: error.message });
    const backendType = LLM_CONFIG[session.endpoint]?.backendType || '';
    let errMsg;
    if (error.response?.status === 500 && backendType === 'docker-runner') {
      errMsg = `[Error] Docker Model Runner returned 500 for ${session.model}. ` +
        `The model may be too large for this device (${DEVICE_PROFILE} profile), or ` +
        `Docker Desktop's Model Runner feature may not be fully enabled. ` +
        `Try a smaller model or check Docker Desktop → Settings → Features in Development → Docker Model Runner.`;
    } else {
      errMsg = `[Error] Could not reach LLM at ${llmUrl}: ${error.message}`;
    }
    finishError(errMsg, error);
    send({ type: 'error', message: errMsg });
    end();
  }
}

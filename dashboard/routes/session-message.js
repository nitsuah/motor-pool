import { buildSystemMessages } from '../safety.js';
import { preflightTurn, ensureTurnTool, finalizeReply, recordTurnError } from '../modules/session-turn.js';

export async function handleSessionMessage(req, res, deps) {
  const {
    sessions, LLM_CONFIG, prepareSessionForLlmCall,
    getExperienceTools, runAgentLoop, activeDockerRunnerModelRef, logStructured,
  } = deps;
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

  const { message, useSafeMode = false } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Message is required' });
  if (typeof useSafeMode !== 'boolean') return res.status(400).json({ success: false, error: 'useSafeMode must be a boolean' });

  const turn = await preflightTurn(session, message, useSafeMode, deps);

  if (turn.kind === 'handled') {
    return res.json({
      success: true, response: turn.response, classification: turn.classification, blocked: turn.blocked,
      endpoint: useSafeMode ? `${session.endpoint} (safe)` : session.endpoint,
      messageCount: session.messages.length,
    });
  }
  if (turn.kind === 'blocked') {
    return res.json({ success: true, response: turn.response, classification: turn.classification, blocked: true, endpoint: session.endpoint, messageCount: session.messages.length });
  }

  const tool = await ensureTurnTool(session, deps);
  if (!tool.ready) return res.status(503).json({ success: false, error: tool.error });

  const msgStart = Date.now();
  session.status = 'running';
  session.lastActivity = new Date();

  try {
    const prepared = await prepareSessionForLlmCall(session);
    if (LLM_CONFIG[session.endpoint]?.backendType === 'docker-runner') {
      activeDockerRunnerModelRef.current = { key: session.endpoint, model: session.model, at: new Date() };
    }
    const { llmUrl, apiStyle } = prepared;
    const apiKey = LLM_CONFIG[session.endpoint]?.apiKey || null;
    const llmHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

    const systemMessages = buildSystemMessages({ ...session, safetyMode: turn.safetyMode });
    const historyMessages = session.messages.map(m => ({ role: m.role, content: m.content }));
    const msgs = [...systemMessages, ...historyMessages];

    const experienceTools = useSafeMode ? [] : getExperienceTools(session.experience);
    const { content: assistantMessage, toolLog } = await runAgentLoop(msgs, apiStyle, llmUrl, llmHeaders, experienceTools, session);

    const reply = finalizeReply(session, assistantMessage, turn.safetyMode, deps, { latencyMs: Date.now() - msgStart, toolLog });

    res.json({
      success: true, response: reply.content, classification: turn.classification,
      filterFlags: reply.flags, blocked: reply.blocked, redacted: reply.redacted,
      endpoint: useSafeMode ? `${session.endpoint} (safe)` : session.endpoint,
      messageCount: session.messages.length,
      toolLog: toolLog?.length ? toolLog : undefined,
    });
  } catch (error) {
    logStructured('error', 'llm_call_failed', { sessionId: session.id, endpoint: session.endpoint, model: session.model, error: error.message });
    const errorMsg = `[Error] Could not reach the configured model service for ${session.endpoint}: ${error.message}`;
    recordTurnError(session, errorMsg, error, deps);
    res.json({ success: false, response: errorMsg, endpoint: session.endpoint, messageCount: session.messages.length });
  }
}

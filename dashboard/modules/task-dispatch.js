import { randomBytes } from 'crypto';

/**
 * Build the task runner's dispatchMessage: run one task through the agent loop
 * in a fresh session. Extracted from server.js so the TokenEconomizer wiring
 * (repoRoot, microskill injection, per-call tool evidence, session history)
 * is covered by unit tests rather than only by a live server.
 */
export function createTaskDispatcher({
  sessions, LLM_CONFIG, repoRoot,
  resolveEndpointUrl, prepareSessionForLlmCall, buildSystemMessages,
  getExperienceTools, runAgentLoop, upsertSessionContext, logStructured,
  createToolUseRecorder, recordSession, summarizeSession,
}) {
  return async function dispatchTaskMessage(task) {
    const sessionId = `sess_task_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const endpoint = 'primary';
    const resolvedLlmUrl = await resolveEndpointUrl(endpoint);
    const experience = task.experience || 'developer';
    const session = {
      id: sessionId,
      name: `[task] ${task.title.slice(0, 40)}`,
      model: LLM_CONFIG[endpoint]?.defaultModel || 'llama3',
      endpoint,
      llmUrl: resolvedLlmUrl,
      messages: [],
      createdAt: new Date(), updatedAt: new Date(),
      userId: task.assignedUserId || 'task-runner',
      userRole: null, experience, safetyMode: null, useSafeModeEnabled: false,
      repoRoot,
    };
    sessions.set(sessionId, session);
    upsertSessionContext(session, logStructured);

    session.messages.push({ role: 'user', content: task.title, timestamp: new Date() });
    const prepared = await prepareSessionForLlmCall(session);
    const { llmUrl, apiStyle, microskills = [] } = prepared;
    const apiKey = LLM_CONFIG[session.endpoint]?.apiKey || null;
    const streamHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const systemMessages = buildSystemMessages({ ...session, safetyMode: null }, microskills);
    const historyMessages = session.messages.map(m => ({ role: m.role, content: m.content }));
    const msgs = [...systemMessages, ...historyMessages];
    const tools = getExperienceTools(experience);
    const result = await runAgentLoop(msgs, apiStyle, llmUrl, streamHeaders, tools, session, {
      repoRoot,
      onToolCall: createToolUseRecorder({ session, repoRoot, logStructured }),
    });
    session.messages.push({ role: 'assistant', content: result.content, timestamp: new Date(), toolLog: result.toolLog?.length ? result.toolLog : undefined });
    session.updatedAt = new Date();
    upsertSessionContext(session, logStructured);
    task.sessionId = sessionId;
    // A task session is complete once its single turn returns.
    await Promise.resolve()
      .then(() => recordSession(summarizeSession(session, repoRoot, { kind: 'task' })))
      .catch(e => logStructured?.('warn', 'token_economizer_session_record_failed', { error: e.message }));
    return result;
  };
}

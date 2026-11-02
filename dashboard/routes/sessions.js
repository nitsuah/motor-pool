import express from 'express';
import { rmSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { handleSessionMessage } from './session-message.js';
import { handleSessionStream } from './session-stream.js';

export function createSessionsRouter({
  sessions,
  sessionCounterRef,
  eventBus,
  logStructured,
  LLM_CONFIG,
  PUBLIC_DEMO_MODE,
  DEMO_EXPERIENCE,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_CHARS,
  DEVICE_PROFILE,
  resolveRequestedExperience,
  isKnownExperience,
  isKnownSafetyMode,
  resolveSessionEndpoint,
  resolveConfiguredSafetyMode,
  isEndpointAllowed,
  getExperienceConfig,
  getAllowedEndpoints,
  coerceModelForEndpoint,
  resolveEndpointUrl,
  prepareSessionForLlmCall,
  ensureRunnableModelForSession,
  getExperienceTools,
  runPromptHandlers,
  runAgentLoop,
  upsertSessionContext,
  markSessionEnded,
  persistEvent,
  activeDockerRunnerModelRef,
  TOOL_SERVERS,
  serviceRegistry,
  dockerControlEnabled,
  runComposeAction,
}) {
  const router = express.Router();

  // Shared deps passed to the extracted message/stream handlers
  const handlerDeps = {
    sessions, eventBus, logStructured,
    LLM_CONFIG, MAX_OUTPUT_CHARS, DEVICE_PROFILE,
    runPromptHandlers, prepareSessionForLlmCall, resolveEndpointUrl,
    getExperienceTools, runAgentLoop,
    upsertSessionContext, activeDockerRunnerModelRef,
    TOOL_SERVERS, serviceRegistry, dockerControlEnabled, runComposeAction,
  };

  router.post('/', async (req, res) => {
    const {
      endpoint: requestedEndpoint = 'primary',
      name = `session-${++sessionCounterRef.current}`,
      userId,
      userRole,
      experience: requestedExperience = 'developer',
      safetyMode,
    } = req.body;

    const experience = resolveRequestedExperience(requestedExperience);

    if (!isKnownExperience(experience)) {
      return res.status(400).json({ success: false, error: 'Invalid experience' });
    }

    if (safetyMode && !isKnownSafetyMode(safetyMode)) {
      return res.status(400).json({ success: false, error: 'Invalid safety mode' });
    }

    const endpoint = resolveSessionEndpoint(experience, requestedEndpoint);
    const endpointWasAdjusted = endpoint !== requestedEndpoint;
    const model = endpointWasAdjusted
      ? LLM_CONFIG[endpoint]?.defaultModel || LLM_CONFIG.primary.defaultModel
      : coerceModelForEndpoint(endpoint, req.body.model) || LLM_CONFIG[endpoint]?.defaultModel || LLM_CONFIG.primary.defaultModel;
    const resolvedSafetyMode = resolveConfiguredSafetyMode(experience, safetyMode);

    const sessionId = `sess_${Date.now()}_${randomBytes(5).toString('hex')}`;
    const resolvedLlmUrl = await resolveEndpointUrl(endpoint);

    const session = {
      id: sessionId, name, model, endpoint,
      llmUrl: resolvedLlmUrl, messages: [],
      createdAt: new Date(), updatedAt: new Date(),
      userId: userId || 'anonymous', userRole: userRole || null,
      experience, safetyMode: resolvedSafetyMode, useSafeModeEnabled: false,
      status: 'idle', lastActivity: new Date(), errorCount: 0,
    };

    sessions.set(sessionId, session);
    upsertSessionContext(session, logStructured);

    eventBus.emit('session_start', {
      session_id: sessionId, user_id: session.userId,
      model, endpoint, experience,
      metadata: {
        safetyMode: resolvedSafetyMode, userRole: session.userRole,
        endpointAdjusted: endpointWasAdjusted, publicDemoMode: PUBLIC_DEMO_MODE,
        requestedExperience: requestedExperience || null, resolvedExperience: experience,
      },
    });

    res.json({
      success: true,
      session: { id: sessionId, name, model, endpoint, experience, safetyMode: resolvedSafetyMode, endpointAdjusted: endpointWasAdjusted, createdAt: session.createdAt },
    });
  });

  router.get('/', (req, res) => {
    const { experience, userId: filterUserId, endpoint: filterEndpoint } = req.query;
    let sessionList = Array.from(sessions.values());
    if (experience) sessionList = sessionList.filter(s => s.experience === experience);
    if (filterUserId) sessionList = sessionList.filter(s => s.userId === filterUserId);
    if (filterEndpoint) sessionList = sessionList.filter(s => s.endpoint === filterEndpoint);
    res.json({
      success: true,
      sessions: sessionList.map(s => ({
        id: s.id, name: s.name, model: s.model, endpoint: s.endpoint,
        messageCount: s.messages.length, createdAt: s.createdAt, updatedAt: s.updatedAt,
        userId: s.userId, experience: s.experience, safetyMode: s.safetyMode,
        status: s.status || 'idle', lastActivity: s.lastActivity, errorCount: s.errorCount || 0,
      })),
    });
  });

  router.get('/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    res.json({
      success: true,
      session: {
        id: session.id, name: session.name, model: session.model,
        endpoint: session.endpoint, llmUrl: session.llmUrl, messages: session.messages,
        createdAt: session.createdAt, userId: session.userId, userRole: session.userRole,
        experience: session.experience, safetyMode: session.safetyMode,
        useSafeModeEnabled: session.useSafeModeEnabled,
        status: session.status || 'idle',
        lastActivity: session.lastActivity,
        errorCount: session.errorCount || 0,
      },
    });
  });

  router.get('/:id/health', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    // Probe the endpoint to verify reachability
    let endpointReachable = false;
    try {
      const epUrl = session.llmUrl || LLM_CONFIG[session.endpoint]?.url;
      if (epUrl) {
        const ctrl = AbortSignal.timeout(2000);
        const probe = await fetch(`${epUrl}/api/tags`, { signal: ctrl }).catch(() =>
          fetch(`${epUrl}/v1/models`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
        );
        endpointReachable = !!(probe?.ok);
      }
    } catch { /* unreachable */ }

    res.json({
      success: true,
      health: {
        sessionId: session.id,
        status: session.status || 'idle',
        lastActivity: session.lastActivity || session.updatedAt,
        messageCount: session.messages.length,
        errorCount: session.errorCount || 0,
        endpoint: session.endpoint,
        endpointReachable,
        uptime: Math.floor((Date.now() - new Date(session.createdAt).getTime()) / 1000),
      },
    });
  });

  router.post('/:id/fork', express.json(), (req, res) => {
    const parent = sessions.get(req.params.id);
    if (!parent) return res.status(404).json({ success: false, error: 'Session not found' });

    const { atMessageIndex } = req.body || {};
    const cutoff = typeof atMessageIndex === 'number'
      ? Math.min(Math.max(0, atMessageIndex + 1), parent.messages.length)
      : parent.messages.length;

    const forkId = `sess_${Date.now()}_${randomBytes(5).toString('hex')}`;
    const forkName = `${parent.name} (fork)`.slice(0, 80);
    const fork = {
      id: forkId,
      name: forkName,
      model: parent.model,
      endpoint: parent.endpoint,
      llmUrl: parent.llmUrl,
      messages: parent.messages.slice(0, cutoff).map(m => ({ ...m })),
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: parent.userId,
      userRole: parent.userRole,
      experience: parent.experience,
      safetyMode: parent.safetyMode,
      useSafeModeEnabled: false,
      status: 'idle',
      lastActivity: new Date(),
      errorCount: 0,
    };

    sessions.set(forkId, fork);
    upsertSessionContext(fork, logStructured);
    eventBus.emit('session_fork', {
      session_id: forkId, user_id: fork.userId,
      model: fork.model, endpoint: fork.endpoint, experience: fork.experience,
      metadata: { parentId: parent.id, cutoff },
    });
    logStructured('info', 'session_forked', { parentId: parent.id, forkId, cutoff });

    res.json({
      success: true,
      session: { id: forkId, name: forkName, messageCount: fork.messages.length, endpoint: fork.endpoint, model: fork.model, experience: fork.experience },
    });
  });

  router.post('/:id/restart', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    const cleared = session.messages.length;
    session.messages = [];
    session.status = 'idle';
    session.errorCount = 0;
    session.lastActivity = new Date();
    session.updatedAt = new Date();
    upsertSessionContext(session, logStructured);
    eventBus.emit('session_restart', {
      session_id: session.id, user_id: session.userId,
      model: session.model, endpoint: session.endpoint, experience: session.experience,
      metadata: { cleared },
    });
    logStructured('info', 'session_restarted', { sessionId: session.id, cleared });
    res.json({ success: true, cleared, status: 'idle' });
  });

  router.post('/:id/stop', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.status === 'stopped') return res.json({ success: true, already: true });
    session.status = 'stopped';
    session.lastActivity = new Date();
    session.updatedAt = new Date();
    upsertSessionContext(session, logStructured);
    eventBus.emit('session_stopped', {
      session_id: session.id, user_id: session.userId,
      model: session.model, endpoint: session.endpoint, experience: session.experience,
      metadata: { messageCount: session.messages.length },
    });
    logStructured('info', 'session_stopped', { sessionId: session.id });
    res.json({ success: true, status: 'stopped' });
  });

  router.post('/:id/message', (req, res) => handleSessionMessage(req, res, handlerDeps));

  router.post('/:id/stream', (req, res) => handleSessionStream(req, res, handlerDeps));

  router.patch('/:id/name', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'name must be a non-empty string' });
    }
    session.name = name.trim().slice(0, 80);
    session.updatedAt = new Date();
    upsertSessionContext(session, logStructured);
    res.json({ success: true, name: session.name });
  });

  router.patch('/:id/experience', express.json(), (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    const { experience } = req.body || {};
    if (!experience || !isKnownExperience(experience)) {
      return res.status(400).json({ success: false, error: 'Invalid experience' });
    }
    if (PUBLIC_DEMO_MODE && experience !== 'safechat') {
      return res.status(403).json({ success: false, error: 'Demo mode locked to safechat' });
    }
    session.experience = experience;
    session.updatedAt = new Date();
    upsertSessionContext(session, logStructured);
    logStructured('info', 'session_experience_changed', { session_id: session.id, experience });
    res.json({ success: true, experience });
  });

  router.put('/:id/model', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    const { endpoint, model } = req.body;
    if (!endpoint || !LLM_CONFIG[endpoint]) {
      return res.status(400).json({ success: false, error: 'Invalid endpoint' });
    }
    if (!isEndpointAllowed(session.experience, endpoint)) {
      return res.status(403).json({ success: false, error: 'Endpoint is not allowed for this experience' });
    }
    if (PUBLIC_DEMO_MODE && endpoint !== 'primary') {
      return res.status(403).json({ success: false, error: 'Public demo mode only allows the primary endpoint' });
    }

    const prevEndpoint = session.endpoint;
    session.endpoint = endpoint;
    session.model = coerceModelForEndpoint(endpoint, model) || LLM_CONFIG[endpoint].defaultModel;
    session.llmUrl = await resolveEndpointUrl(endpoint);
    session.updatedAt = new Date();
    upsertSessionContext(session, logStructured);

    eventBus.emit('model_switched', {
      session_id: session.id, user_id: session.userId,
      model: session.model, endpoint, experience: session.experience,
      metadata: { from: prevEndpoint, to: endpoint },
    });

    res.json({
      success: true,
      message: `Switched to ${LLM_CONFIG[endpoint].name}`,
      session: { endpoint, model: session.model, llmUrl: session.llmUrl },
    });
  });

  router.delete('/', express.json(), (req, res) => {
    const { ids, deleteAll } = req.body || {};
    if (!Array.isArray(ids) && !deleteAll) {
      return res.status(400).json({ success: false, error: 'Provide an ids array or set deleteAll: true' });
    }
    const toDelete = Array.isArray(ids) ? ids : Array.from(sessions.keys());
    let deleted = 0;
    for (const id of toDelete) {
      if (!sessions.has(id)) continue;
      const session = sessions.get(id);
      session.endedAt = new Date();
      eventBus.emit('session_end', {
        session_id: id, user_id: session?.userId,
        model: session?.model, endpoint: session?.endpoint, experience: session?.experience,
        metadata: { messageCount: session?.messages.length },
      });
      upsertSessionContext(session, logStructured);
      markSessionEnded(id, session.endedAt, logStructured);
      sessions.delete(id);
      try { rmSync(path.join(process.cwd(), 'tmp', id), { recursive: true, force: true }); } catch { /* non-fatal */ }
      deleted++;
    }
    res.json({ success: true, deleted });
  });

  router.delete('/:id', (req, res) => {
    const exists = sessions.has(req.params.id);
    if (exists) {
      const session = sessions.get(req.params.id);
      session.endedAt = new Date();
      eventBus.emit('session_end', {
        session_id: req.params.id, user_id: session?.userId,
        model: session?.model, endpoint: session?.endpoint, experience: session?.experience,
        metadata: { messageCount: session?.messages.length },
      });
      upsertSessionContext(session, logStructured);
      markSessionEnded(req.params.id, session.endedAt, logStructured);
      sessions.delete(req.params.id);
      // Clean up any session output files
      try {
        rmSync(path.join(process.cwd(), 'tmp', req.params.id), { recursive: true, force: true });
      } catch { /* non-fatal */ }
    }
    res.json({ success: true, deleted: exists });
  });

  router.delete('/:id/messages', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    const count = session.messages.length;
    session.messages = [];
    session.updatedAt = new Date();
    logStructured?.('info', 'session_messages_cleared', { sessionId: session.id, cleared: count });
    eventBus.emit('session_messages_cleared', {
      session_id: session.id, user_id: session.userId,
      model: session.model, endpoint: session.endpoint, experience: session.experience,
      metadata: { cleared: count },
    });
    res.json({ success: true, cleared: count });
  });

  router.post('/:id/feedback', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    const { messageIndex, positive } = req.body;
    if (typeof positive !== 'boolean') return res.status(400).json({ success: false, error: 'positive (boolean) is required' });
    if (!Number.isInteger(messageIndex)) return res.status(400).json({ success: false, error: 'messageIndex must be an integer' });
    if (messageIndex < 0 || messageIndex >= session.messages.length) return res.status(400).json({ success: false, error: 'messageIndex is out of range' });
    if (session.messages[messageIndex]?.role !== 'assistant') return res.status(400).json({ success: false, error: 'Feedback can only be recorded for assistant messages' });
    if (session.messages[messageIndex]?.feedback) return res.status(409).json({ success: false, error: 'Feedback already submitted for this message' });

    session.messages[messageIndex].feedback = positive ? 'up' : 'down';
    session.messages[messageIndex].feedbackAt = new Date();
    session.updatedAt = new Date();
    upsertSessionContext(session, logStructured);

    const eventType = positive ? 'feedback_positive' : 'feedback_negative';
    eventBus.emit(eventType, {
      session_id: session.id, user_id: session.userId,
      model: session.model, endpoint: session.endpoint, experience: session.experience,
      metadata: { messageIndex },
    });

    res.json({ success: true, recorded: eventType });
  });

  router.get('/:id/export', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    const fmt = (req.query.format || 'markdown').toLowerCase();
    if (fmt === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${session.id}.json"`);
      return res.json({
        id: session.id, name: session.name, experience: session.experience,
        endpoint: session.endpoint, model: session.model,
        createdAt: session.createdAt, updatedAt: session.updatedAt,
        messages: session.messages.map(m => ({
          role: m.role, content: m.content,
          timestamp: m.timestamp, feedback: m.feedback || undefined,
        })),
      });
    }

    // Default: Markdown
    const lines = [
      `# ${session.name}`,
      ``,
      `*Experience: ${session.experience} · Endpoint: ${session.endpoint} · Model: ${session.model}*`,
      `*Exported: ${new Date().toISOString()}*`,
      ``,
    ];
    for (const m of session.messages) {
      const role = m.role === 'user' ? '**You**' : '**AI**';
      const ts = m.timestamp ? ` *(${new Date(m.timestamp).toISOString()})*` : '';
      lines.push(`${role}${ts}`, ``, m.content, ``);
    }

    const filename = session.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.md"`);
    res.send(lines.join('\n'));
  });

  // Replay endpoint — returns messages as ordered steps for step-through UI
  router.get('/:id/replay', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    const steps = session.messages.map((m, i) => ({
      step: i,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      blocked: m.blocked || false,
      redacted: m.redacted || false,
      toolLog: m.toolLog || null,
      feedback: m.feedback || null,
      filterFlags: m.filterFlags || [],
    }));

    res.json({
      success: true,
      replay: {
        sessionId: session.id,
        name: session.name,
        experience: session.experience,
        endpoint: session.endpoint,
        model: session.model,
        createdAt: session.createdAt,
        totalSteps: steps.length,
        steps,
      },
    });
  });

  return router;
}

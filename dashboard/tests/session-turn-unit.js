/**
 * Unit tests for modules/session-turn.js
 *
 * All functions receive their dependencies explicitly so no server is needed.
 * We build minimal fakes for eventBus, upsertSessionContext, logStructured,
 * and a session object matching the shape the module expects.
 */
import assert from 'node:assert/strict';
import {
  BLOCKED_INPUT_REFUSAL,
  preflightTurn,
  ensureTurnTool,
  finalizeReply,
  recordTurnError,
} from '../modules/session-turn.js';
import { resolveEffectiveSafetyMode } from '../safety.js';

// ── Fakes ──────────────────────────────────────────────────────────────────────
const events = [];
const eventBus = {
  emit: (type, payload) => events.push({ type, payload }),
};
const upsertSessionContext = () => {};
const logStructured = () => {};

function freshSession(overrides = {}) {
  return {
    id: 's1',
    userId: 'u1',
    model: 'm',
    endpoint: 'e',
    experience: 'chat',
    messages: [],
    status: 'running',
    useSafeModeEnabled: false,
    safetyMode: undefined,
    ...overrides,
  };
}

function freshDeps(overrides = {}) {
  return {
    eventBus,
    upsertSessionContext,
    logStructured,
    ...overrides,
  };
}

function resetEvents() {
  events.length = 0;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

// 1. preflightTurn handled path
{
  const session = freshSession();
  const deps = freshDeps({
    runPromptHandlers: async () => ({
      handled: true,
      response: 'hello',
      blocked: false,
    }),
  });

  const result = await preflightTurn(session, 'user message', false, deps);

  assert.strictEqual(result.kind, 'handled', 'kind is handled');
  assert.strictEqual(result.response, 'hello', 'response is hello');
  assert.strictEqual(session.messages.length, 2, 'two messages persisted');
  assert.strictEqual(session.messages[0].role, 'user', 'first message is user');
  assert.strictEqual(session.messages[1].role, 'assistant', 'second message is assistant');
  assert.strictEqual(session.messages[1].blocked, false, 'assistant message not blocked');

  const invoked = events.find((e) => e.type === 'prompt_handler_invoked');
  assert.ok(invoked, 'prompt_handler_invoked event emitted');
  assert.strictEqual(invoked.payload.metadata.blocked, false, 'event metadata blocked is false');
  console.log('  ✅ preflightTurn handled path');
}

resetEvents();

// 2. preflightTurn safe mode toggle: first call emits, second with same value does not
{
  const session = freshSession({ useSafeModeEnabled: false });
  const deps = freshDeps({
    runPromptHandlers: async () => ({ handled: true, response: 'hi', blocked: false }),
  });

  await preflightTurn(session, 'msg', true, deps); // toggles on
  const toggled1 = events.filter((e) => e.type === 'safe_mode_toggled');
  assert.strictEqual(toggled1.length, 1, 'first call emits safe_mode_toggled');
  assert.strictEqual(toggled1[0].payload.metadata.enabled, true, 'enabled is true');
  assert.strictEqual(session.useSafeModeEnabled, true, 'session flag updated');

  events.length = 0;
  await preflightTurn(session, 'msg2', true, deps); // same value, no toggle
  const toggled2 = events.filter((e) => e.type === 'safe_mode_toggled');
  assert.strictEqual(toggled2.length, 0, 'second call with same value emits no toggle');
  console.log('  ✅ preflightTurn safe_mode_toggled emits once then not again');
}

resetEvents();

// 3. ensureTurnTool with TOOL_SERVERS: {} resolves ready and emits nothing
{
  const session = freshSession();
  const deps = freshDeps({
    TOOL_SERVERS: {},
    serviceRegistry: {},
    dockerControlEnabled: false,
    runComposeAction: async () => {},
  });

  const result = await ensureTurnTool(session, deps);
  assert.deepStrictEqual(result, { ready: true }, 'returns { ready: true }');
  assert.strictEqual(events.length, 0, 'no events emitted');
  console.log('  ✅ ensureTurnTool with empty TOOL_SERVERS returns ready and emits nothing');
}

resetEvents();

// 4. finalizeReply truncates, emits output_control_applied and message_received
{
  const session = freshSession();
  // Use the safety mode that resolveEffectiveSafetyMode returns for this session
  const safetyMode = resolveEffectiveSafetyMode(session, false); // 'standard'
  const longReply = 'x'.repeat(50);
  const deps = freshDeps({ MAX_OUTPUT_CHARS: 10 });

  const result = finalizeReply(session, longReply, safetyMode, deps);

  assert.strictEqual(result.truncated, true, 'returns truncated: true');
  assert.ok(result.content.length > 10, 'content is truncated with notice');
  assert.strictEqual(session.status, 'idle', 'session status set to idle');
  assert.strictEqual(session.messages.length, 1, 'assistant message pushed');
  assert.strictEqual(session.messages[0].role, 'assistant', 'message role is assistant');

  const applied = events.find((e) => e.type === 'output_control_applied');
  assert.ok(applied, 'output_control_applied event emitted');
  assert.strictEqual(applied.payload.metadata.type, 'truncate', 'event metadata type is truncate');
  assert.strictEqual(applied.payload.metadata.maxChars, 10, 'event metadata maxChars is 10');

  const received = events.find((e) => e.type === 'message_received');
  assert.ok(received, 'message_received event emitted');
  assert.strictEqual(received.payload.metadata.responseLength, result.content.length, 'responseLength matches');
  console.log('  ✅ finalizeReply truncates, emits both events, sets idle');
}

resetEvents();

// 5. finalizeReply with partial: true marks stored message partial
{
  const session = freshSession();
  const safetyMode = resolveEffectiveSafetyMode(session, false);
  const deps = freshDeps({ MAX_OUTPUT_CHARS: 100 });

  finalizeReply(session, 'short reply', safetyMode, deps, { partial: true });

  assert.strictEqual(session.messages[0].partial, true, 'stored message marked partial');

  const received = events.find((e) => e.type === 'message_received');
  assert.strictEqual(received.payload.metadata.partial, true, 'event metadata includes partial');
  console.log('  ✅ finalizeReply partial: true marks message partial');
}

resetEvents();

// 6. recordTurnError pushes error message, sets status error, increments errorCount, emits error event
{
  const session = freshSession({ errorCount: 0 });
  const deps = freshDeps({});

  recordTurnError(session, 'boom', new Error('x'), deps);

  assert.strictEqual(session.messages.length, 1, 'error message pushed');
  assert.strictEqual(session.messages[0].content, 'boom', 'message content is boom');
  assert.strictEqual(session.status, 'error', 'session status is error');
  assert.strictEqual(session.errorCount, 1, 'errorCount incremented to 1');

  const errEvent = events.find((e) => e.type === 'error');
  assert.ok(errEvent, 'error event emitted');
  assert.strictEqual(errEvent.payload.metadata.error, 'x', 'event metadata error is x');
  console.log('  ✅ recordTurnError first call works');
}

resetEvents();

// 7. recordTurnError called twice increments errorCount to 2
{
  const session = freshSession({ errorCount: 1 });
  const deps = freshDeps({});

  recordTurnError(session, 'boom2', new Error('y'), deps);

  assert.strictEqual(session.errorCount, 2, 'errorCount incremented to 2 on second call');
  const errEvent = events.find((e) => e.type === 'error');
  assert.strictEqual(errEvent.payload.metadata.error, 'y', 'second event metadata error is y');
  console.log('  ✅ recordTurnError second call increments to 2');
}

console.log('All session-turn tests passed.');

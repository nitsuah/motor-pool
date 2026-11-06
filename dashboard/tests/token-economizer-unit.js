/**
 * Unit tests for the TokenEconomizer integration: evidence/session persistence,
 * config validation, prompt injection after restart, the shared tool-use
 * recorder, the task dispatcher wiring, fork repoRoot, and the panel helpers.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

// Isolate state before the module computes its paths.
const ownDir = !process.env.TOKEN_ECONOMIZER_DIR;
if (ownDir) process.env.TOKEN_ECONOMIZER_DIR = mkdtempSync(join(tmpdir(), 'te-unit-'));
const TE_DIR = process.env.TOKEN_ECONOMIZER_DIR;
mkdirSync(TE_DIR, { recursive: true });

const { TokenEconomizer, CONFIG_SCHEMA } = await import('../modules/token-economizer.js');
const { createTaskDispatcher } = await import('../modules/task-dispatch.js');
const { buildForkSession } = await import('../routes/sessions.js');
const { createTokenEconomizerRouter } = await import('../routes/token-economizer.js');
const { healthUrlCandidates } = await import('../routes/tools.js');
const { teUrl, TE_SETTINGS_SECTIONS, parseSettingValue } = await import('../src/utils/tokenEconomizerApi.js');

const TE = TokenEconomizer;
const REPO = '/workspace';

async function reload() {
  await TE._flushWritesForTest();
  TE._resetCachesForTest();
}

function wipe() {
  for (const f of [TE.TOOL_EVIDENCE_FILE, TE.SESSION_HISTORY_FILE, TE.CONFIG_FILE, TE.MICROSKILLS_FILE]) {
    rmSync(f, { force: true });
  }
  TE._resetCachesForTest();
}

try {
  console.log('TokenEconomizer unit tests');

  // ── evidence: every record survives a reload as an array ──────────────────
  wipe();
  await TE.recordToolUse('read_file', 'developer', REPO, 'sess_a');
  await TE.recordToolUse('bash', 'developer', REPO, 'sess_a');
  await reload();
  // Touch only one record after the reload; the other must not be corrupted.
  await TE.recordToolUse('read_file', 'developer', REPO, 'sess_b');
  await reload();
  const onDisk = JSON.parse(readFileSync(TE.TOOL_EVIDENCE_FILE, 'utf8'));
  const bashRec = onDisk[`${REPO}::developer::bash`];
  const readRec = onDisk[`${REPO}::developer::read_file`];
  assert.deepEqual(bashRec.sessions, ['sess_a'], 'untouched record keeps its session array on disk');
  assert.deepEqual(readRec.sessions, ['sess_a', 'sess_b'], 'touched record keeps both session ids');
  assert.equal(readRec.uses, 2, 'uses accumulate across a reload');
  const loaded = await TE.loadToolEvidence();
  for (const rec of Object.values(loaded)) {
    assert.ok(Array.isArray(rec.sessions), 'in-memory sessions are arrays, not Sets');
  }
  console.log('  ✅ multi-record evidence round-trips through reloads without corruption');

  // ── evidence: sessions are counted by session id, not calendar day ────────
  wipe();
  await TE.recordToolUse('grep', 'developer', REPO, 'sess_1');
  await TE.recordToolUse('grep', 'developer', REPO, 'sess_1');
  await TE.recordToolUse('grep', 'developer', REPO, 'sess_2');
  const status = await TE.getStatus(REPO);
  assert.equal(status.tools.totalPrompts, 3, 'three tool calls recorded');
  assert.equal(status.tools.totalSessions, 2, 'two same-day sessions count as two');
  console.log('  ✅ same-day sessions are counted separately');

  // ── evidence: pruning thresholds work on reloaded records ─────────────────
  wipe();
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  writeFileSync(TE.TOOL_EVIDENCE_FILE, JSON.stringify({
    [`${REPO}::developer::stale`]: { tool: 'stale', experience: 'developer', repo: REPO, uses: 12, sessions: ['s1', 's2', 's3'], firstSeen: old, lastUsed: old },
    [`${REPO}::developer::fresh`]: { tool: 'fresh', experience: 'developer', repo: REPO, uses: 12, sessions: ['s1', 's2'], firstSeen: old, lastUsed: new Date().toISOString() },
  }));
  TE._resetCachesForTest();
  assert.deepEqual(await TE.getPrunableTools(REPO, 'developer'), ['stale'], 'a reloaded stale record meets the session threshold');
  console.log('  ✅ getPrunableTools counts sessions on reloaded records');

  // ── evidence: concurrent first calls on a cold cache lose nothing ─────────
  wipe();
  await Promise.all(Array.from({ length: 10 }, (_, i) => TE.recordToolUse('ls', 'developer', REPO, `sess_${i % 3}`)));
  await reload();
  const concurrent = (await TE.loadToolEvidence())[`${REPO}::developer::ls`];
  assert.equal(concurrent.uses, 10, 'all concurrent uses persisted');
  assert.equal(concurrent.sessions.length, 3, 'distinct sessions persisted');
  console.log('  ✅ concurrent recordToolUse calls share one cache and persist every use');

  // ── microskills: injection loads the store after a restart ────────────────
  wipe();
  writeFileSync(TE.MICROSKILLS_FILE, JSON.stringify({
    confirmed: [
      { id: '1', fact: 'use pnpm', repo: REPO },
      { id: '2', fact: 'global fact', repo: '/other', global: true },
      { id: '3', fact: 'other repo', repo: '/other' },
    ],
    proposed: [], rejected: [],
  }));
  TE._resetCachesForTest();
  assert.deepEqual(await TE.getMicroskillsForInjection(REPO), ['use pnpm', 'global fact'], 'confirmed facts load without a prior call');
  console.log('  ✅ getMicroskillsForInjection loads persisted facts on a cold cache');

  // ── config: validation, merge, and stored-file hygiene ────────────────────
  wipe();
  assert.equal(TE.validateConfigUpdate({ toolprune_evidence: -1 }).ok, false, 'negative rejected');
  assert.equal(TE.validateConfigUpdate({ toolprune_evidence: 2.5 }).ok, false, 'non-integer rejected');
  assert.equal(TE.validateConfigUpdate({ toolprune_evidence: '10' }).ok, false, 'string rejected');
  assert.equal(TE.validateConfigUpdate({ toolprune_evidence: Number.NaN }).ok, false, 'NaN rejected');
  assert.equal(TE.validateConfigUpdate({ loopguard_judge_confidence: 1.5 }).ok, false, 'out of range rejected');
  assert.equal(TE.validateConfigUpdate({ 'loopguard.thresholds.min_turns': 3 }).ok, false, 'unknown/nested key rejected');
  assert.equal(TE.validateConfigUpdate(JSON.parse('{"__proto__": 1}')).ok, false, 'own __proto__ key rejected');
  assert.equal(TE.validateConfigUpdate([]).ok, false, 'array body rejected');
  const unknownErr = TE.validateConfigUpdate({ sentinel_secret_key: 1 }).error;
  assert.ok(!unknownErr.includes('sentinel_secret_key'), 'unknown-key error does not echo the submitted key');
  const saved = await TE.saveConfig({ toolprune_evidence: 7 });
  assert.equal(saved.toolprune_evidence, 7, 'valid value saved');
  assert.equal(saved.toolprune_min_sessions, CONFIG_SCHEMA.toolprune_min_sessions.default, 'other keys keep defaults');
  await assert.rejects(() => TE.saveConfig({ toolprune_evidence: 0 }), /between/, 'saveConfig itself refuses invalid values');
  await reload();
  assert.equal((await TE.loadConfig()).toolprune_evidence, 7, 'saved config persists');
  writeFileSync(TE.CONFIG_FILE, JSON.stringify({ toolprune_evidence: 'oops', toolprune_sessions: 9, junk: true }));
  TE._resetCachesForTest();
  const cleaned = await TE.loadConfig();
  assert.equal(cleaned.toolprune_evidence, CONFIG_SCHEMA.toolprune_evidence.default, 'invalid stored value falls back to default');
  assert.equal(cleaned.toolprune_sessions, 9, 'valid stored value kept');
  assert.equal('junk' in cleaned, false, 'unknown stored keys dropped');
  console.log('  ✅ config updates are validated and stored config is sanitized on load');

  // ── shared tool-use recorder ──────────────────────────────────────────────
  wipe();
  const recorded = [];
  const rec = TE.createToolUseRecorder({
    session: { id: 'sess_x', experience: 'research' }, repoRoot: REPO,
    record: async (...args) => { recorded.push(args); },
  });
  await rec({ name: 'search' });
  await rec({});
  assert.deepEqual(recorded, [['search', 'research', REPO, 'sess_x']], 'recorder passes tool, experience, repo and session id; ignores nameless calls');
  const warnings = [];
  const failing = TE.createToolUseRecorder({
    session: { id: 's' }, repoRoot: REPO,
    logStructured: (level, event) => warnings.push([level, event]),
    record: async () => { throw new Error('disk full'); },
  });
  await failing({ name: 'x' });
  assert.deepEqual(warnings, [['warn', 'token_economizer_record_failed']], 'record failures are logged, not thrown');
  console.log('  ✅ createToolUseRecorder records per call and contains failures');

  // ── session history: summary is counts only, and persists ─────────────────
  wipe();
  const summary = TE.summarizeSession({
    id: 'sess_h', experience: 'developer',
    messages: [
      { role: 'user', content: 'secret prompt' },
      { role: 'assistant', content: 'reply', toolLog: [{ name: 'a', args: { k: 'secret-arg' } }, { name: 'b' }] },
      { role: 'assistant', content: 'reply 2' },
    ],
  }, REPO, { kind: 'chat' });
  assert.deepEqual(summary, { repo: REPO, sessionId: 'sess_h', kind: 'chat', experience: 'developer', turns: 2, toolsUsed: 2 });
  assert.ok(!JSON.stringify(summary).includes('secret'), 'no message content or tool args in the summary');
  await TE.recordSession(summary);
  await reload();
  const history = await TE.loadSessionHistory();
  assert.equal(history.length, 1, 'session history persisted');
  assert.equal(history[0].sessionId, 'sess_h', 'history keeps the session id');
  console.log('  ✅ summarizeSession/recordSession persist bounded counts only');

  // ── task dispatcher: repoRoot, onToolCall, microskills, session record ────
  wipe();
  const sessions = new Map();
  let loopOptions = null;
  let systemArgs = null;
  const sessionRecords = [];
  const dispatch = createTaskDispatcher({
    sessions, LLM_CONFIG: { primary: { defaultModel: 'm' } }, repoRoot: REPO,
    resolveEndpointUrl: async () => 'http://llm',
    prepareSessionForLlmCall: async () => ({ llmUrl: 'http://llm', apiStyle: 'ollama', microskills: ['fact one'] }),
    buildSystemMessages: (s, ms) => { systemArgs = { repoRoot: s.repoRoot, ms }; return [{ role: 'system', content: 'sys' }]; },
    getExperienceTools: () => [],
    runAgentLoop: async (_msgs, _style, _url, _headers, _tools, session, options) => {
      loopOptions = options;
      options.onToolCall({ name: 'read_file', args: {}, result: {}, callId: '1' });
      options.onToolCall({ name: 'read_file', args: {}, result: {}, callId: '2' });
      options.onToolCall({ name: 'bash', args: {}, result: {}, callId: '3' });
      return { content: 'done', toolLog: [{ name: 'read_file' }, { name: 'read_file' }, { name: 'bash' }] };
    },
    upsertSessionContext: () => {},
    logStructured: () => {},
    createToolUseRecorder: TE.createToolUseRecorder,
    recordSession: async (data) => { sessionRecords.push(data); },
    summarizeSession: TE.summarizeSession,
  });
  const task = { title: 'do the thing', experience: 'developer' };
  const result = await dispatch(task);
  await TE._flushWritesForTest();
  await new Promise(r => setTimeout(r, 20));
  await TE._flushWritesForTest();
  assert.equal(result.content, 'done');
  assert.equal(loopOptions.repoRoot, REPO, 'task loop gets the repo root');
  assert.equal(typeof loopOptions.onToolCall, 'function', 'task loop gets an onToolCall recorder');
  assert.deepEqual(systemArgs, { repoRoot: REPO, ms: ['fact one'] }, 'task session carries repoRoot and microskills into the prompt');
  const taskSession = sessions.get(task.sessionId);
  assert.equal(taskSession.repoRoot, REPO, 'task session stores repoRoot');
  const ev = await TE.loadToolEvidence();
  assert.equal(ev[`${REPO}::developer::read_file`].uses, 2, 'one evidence use per read_file call');
  assert.equal(ev[`${REPO}::developer::bash`].uses, 1, 'one evidence use per bash call');
  assert.deepEqual(ev[`${REPO}::developer::bash`].sessions, [task.sessionId], 'evidence is keyed by the task session id');
  assert.equal(sessionRecords.length, 1, 'task completion records one history entry');
  assert.equal(sessionRecords[0].kind, 'task');
  assert.equal(sessionRecords[0].toolsUsed, 3);
  console.log('  ✅ task dispatcher records tool evidence per call and session history on completion');

  // ── fork keeps repoRoot ───────────────────────────────────────────────────
  const parent = { name: 'p', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], repoRoot: '/repo-a', experience: 'developer' };
  const fork = buildForkSession(parent, { forkId: 'f1', cutoff: 1, defaultRepoRoot: '/default' });
  assert.equal(fork.repoRoot, '/repo-a', 'fork copies the parent repoRoot');
  assert.equal(fork.messages.length, 1, 'fork honours the cutoff');
  assert.equal(buildForkSession({ ...parent, repoRoot: undefined }, { forkId: 'f2', cutoff: 0, defaultRepoRoot: '/default' }).repoRoot,
    '/default', 'a parent restored without repoRoot falls back to the server default');
  console.log('  ✅ forked sessions keep repoRoot');

  // ── router: default repo root and config validation ───────────────────────
  wipe();
  await TE.recordToolUse('read_file', 'developer', REPO, 'sess_r');
  const app = express();
  app.use(express.json());
  app.use('/api/tokeneconomizer', createTokenEconomizerRouter({ TokenEconomizer: TE, logStructured: () => {}, defaultRepoRoot: REPO }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/tokeneconomizer`;
  try {
    const st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.status.tools.tracked, 1, 'status without repoRoot uses the server default root');
    const tp = await (await fetch(`${base}/toolprune?experience=developer`)).json();
    assert.equal(tp.evidence.length, 1, 'toolprune without repoRoot uses the server default root');
    const bad = await fetch(`${base}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolprune_evidence: -5 }) });
    assert.equal(bad.status, 400, 'invalid config is a 400');
    const badBody = await bad.json();
    assert.ok(!JSON.stringify(badBody).includes('-5'), 'the 400 does not echo the submitted value');
    const good = await fetch(`${base}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolprune_min_sessions: 4 }) });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).config.toolprune_min_sessions, 4, 'valid config is saved as a flat key');
    const cfg = await (await fetch(`${base}/config`)).json();
    assert.equal(cfg.config.toolprune_min_sessions, 4, 'GET /config returns the same flat key');
  } finally {
    server.close();
  }
  console.log('  ✅ router defaults repoRoot to the server root and validates config');

  // ── panel helpers ─────────────────────────────────────────────────────────
  assert.equal(teUrl('/toolprune', { repoRoot: '', experience: 'developer' }), '/api/tokeneconomizer/toolprune?experience=developer');
  assert.equal(teUrl('/sessions', { repoRoot: '', limit: 50 }), '/api/tokeneconomizer/sessions?limit=50');
  assert.equal(teUrl('/sessions', { repoRoot: '/a b&c', limit: 50 }), '/api/tokeneconomizer/sessions?repoRoot=%2Fa+b%26c&limit=50');
  assert.equal(teUrl('/status', { repoRoot: '' }), '/api/tokeneconomizer/status');
  assert.equal(teUrl('/config'), '/api/tokeneconomizer/config');
  for (const section of TE_SETTINGS_SECTIONS) {
    for (const field of section.fields) {
      const spec = CONFIG_SCHEMA[field.key];
      assert.ok(spec, `panel field ${field.key} exists in CONFIG_SCHEMA`);
      assert.equal(field.min, spec.min, `${field.key} min matches the server`);
      assert.equal(field.max, spec.max, `${field.key} max matches the server`);
      assert.equal(field.step >= 1, spec.integer, `${field.key} integer-ness matches the server`);
    }
  }
  const evidenceField = TE_SETTINGS_SECTIONS[0].fields[0];
  assert.equal(parseSettingValue(evidenceField, '12'), 12);
  assert.equal(parseSettingValue(evidenceField, ''), null);
  assert.equal(parseSettingValue(evidenceField, '0'), null);
  console.log('  ✅ panel URLs always use "?" and settings fields match the server schema');

  // ── tool health probe order ───────────────────────────────────────────────
  const tool = { url: 'http://remote-host:3202', ports: '3202:3202' };
  assert.deepEqual(healthUrlCandidates(tool, false), ['http://remote-host:3202/health', 'http://localhost:3202/health'], 'host: configured URL first, localhost fallback');
  assert.deepEqual(healthUrlCandidates(tool, true), ['http://remote-host:3202/health'], 'in Docker: configured URL only');
  assert.deepEqual(healthUrlCandidates({ url: 'http://localhost:3202', ports: '3202:3202' }, false), ['http://localhost:3202/health'], 'no duplicate probe');
  console.log('  ✅ tool health probes the configured URL before the localhost fallback');

  console.log('All TokenEconomizer unit tests passed');
} finally {
  await TE._flushWritesForTest();
  if (ownDir) rmSync(TE_DIR, { recursive: true, force: true });
}

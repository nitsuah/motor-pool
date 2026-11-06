import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join as joinPath } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// TOKEN_ECONOMIZER_DIR lets tests (and deployments with a mounted volume) keep
// this state out of the process owner's home directory.
const TOK_ECON_DIR = process.env.TOKEN_ECONOMIZER_DIR || joinPath(homedir(), '.tokeneconomizer');
const MICROSKILLS_FILE = joinPath(TOK_ECON_DIR, 'microskills.json');
const TOOL_EVIDENCE_FILE = joinPath(TOK_ECON_DIR, 'tool-evidence.json');
const CONFIG_FILE = joinPath(TOK_ECON_DIR, 'config.json');
const SESSION_HISTORY_FILE = joinPath(TOK_ECON_DIR, 'session-history.json');

// Only keys that this module actually reads. Each entry bounds the value so a
// bad POST /config cannot make pruning or the loop guard misfire (for example
// a zero minimum, a negative quiet period, or a NaN threshold).
export const CONFIG_SCHEMA = {
  toolprune_evidence: { min: 1, max: 1000, integer: true, default: 10 },
  toolprune_min_sessions: { min: 1, max: 100, integer: true, default: 2 },
  toolprune_sessions: { min: 1, max: 365, integer: true, default: 5 },
  loopguard_judge_confidence: { min: 0, max: 1, integer: false, default: 0.7 },
  loopguard_nudges: { min: 1, max: 1000, integer: true, default: 1 },
  loopguard_backstop_mult: { min: 0.1, max: 1440, integer: false, default: 2.5 },
};

const DEFAULT_CONFIG = Object.fromEntries(
  Object.entries(CONFIG_SCHEMA).map(([key, spec]) => [key, spec.default]),
);

let configCache = null;
let microskillsCache = null;
let toolEvidenceCache = null;
let sessionHistoryCache = null;
// In-flight loads, so concurrent first callers share one cache object instead
// of each building its own and overwriting the other's changes on save.
const pendingLoads = new Map();
// Per-file write chain: writes land in call order and never interleave.
const writeChains = new Map();

async function ensureDir() {
  try {
    await mkdir(TOK_ECON_DIR, { recursive: true });
  } catch {
    // Directory creation is best-effort; downstream reads and writes handle failures.
  }
}

// Serialize at call time (so later in-memory mutation can't change what this
// write stores), then write to a temp file and rename it into place.
function writeJsonAtomic(file, data) {
  const body = JSON.stringify(data, null, 2);
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await ensureDir();
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, file);
  });
  writeChains.set(file, next);
  return next;
}

async function readJson(file, fallback) {
  await ensureDir();
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback();
  }
}

function memoLoad(name, getCache, load) {
  const cached = getCache();
  if (cached) return Promise.resolve(cached);
  if (!pendingLoads.has(name)) {
    pendingLoads.set(name, load().finally(() => pendingLoads.delete(name)));
  }
  return pendingLoads.get(name);
}

/**
 * Validate a partial config update against CONFIG_SCHEMA.
 * Returns { ok: true, value } or { ok: false, error }. Error strings name the
 * key and its bounds only; they never echo the submitted value.
 */
export function validateConfigUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return { ok: false, error: 'config body must be an object' };
  }
  const value = {};
  for (const [key, raw] of Object.entries(update)) {
    if (!Object.hasOwn(CONFIG_SCHEMA, key)) return { ok: false, error: 'unknown config key' };
    const spec = CONFIG_SCHEMA[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, error: `${key} must be a finite number` };
    }
    if (spec.integer && !Number.isInteger(raw)) {
      return { ok: false, error: `${key} must be an integer` };
    }
    if (raw < spec.min || raw > spec.max) {
      return { ok: false, error: `${key} must be between ${spec.min} and ${spec.max}` };
    }
    value[key] = raw;
  }
  return { ok: true, value };
}

// Drop unknown or out-of-range keys from a stored file instead of trusting it.
function pickKnownConfig(obj) {
  const out = { ...DEFAULT_CONFIG };
  if (!obj || typeof obj !== 'object') return out;
  for (const key of Object.keys(CONFIG_SCHEMA)) {
    if (obj[key] !== undefined && validateConfigUpdate({ [key]: obj[key] }).ok) out[key] = obj[key];
  }
  return out;
}

function loadConfig() {
  return memoLoad('config', () => configCache, async () => {
    configCache = pickKnownConfig(await readJson(CONFIG_FILE, () => ({})));
    return configCache;
  });
}

/** Merge a validated partial update into the stored config. */
async function saveConfig(update) {
  const check = validateConfigUpdate(update);
  if (!check.ok) {
    const err = new Error(check.error);
    err.code = 'INVALID_CONFIG';
    throw err;
  }
  const current = await loadConfig();
  configCache = { ...current, ...check.value };
  await writeJsonAtomic(CONFIG_FILE, configCache);
  return configCache;
}

function loadMicroskills() {
  return memoLoad('microskills', () => microskillsCache, async () => {
    const parsed = await readJson(MICROSKILLS_FILE, () => null);
    microskillsCache = {
      confirmed: Array.isArray(parsed?.confirmed) ? parsed.confirmed : [],
      proposed: Array.isArray(parsed?.proposed) ? parsed.proposed : [],
      rejected: Array.isArray(parsed?.rejected) ? parsed.rejected : [],
    };
    return microskillsCache;
  });
}

async function saveMicroskills(data) {
  microskillsCache = data;
  await writeJsonAtomic(MICROSKILLS_FILE, data);
}

// Evidence records keep `sessions` as a plain array of distinct session ids in
// memory and on disk, so every record round-trips through JSON unchanged.
function normalizeEvidenceRecord(record) {
  const sessions = record?.sessions;
  let list = [];
  if (Array.isArray(sessions)) list = sessions;
  else if (sessions instanceof Set) list = Array.from(sessions);
  return { ...record, sessions: Array.from(new Set(list.filter(s => typeof s === 'string' && s))) };
}

function loadToolEvidence() {
  return memoLoad('evidence', () => toolEvidenceCache, async () => {
    const parsed = await readJson(TOOL_EVIDENCE_FILE, () => ({}));
    const evidence = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, record] of Object.entries(parsed)) {
        if (record && typeof record === 'object') evidence[key] = normalizeEvidenceRecord(record);
      }
    }
    toolEvidenceCache = evidence;
    return toolEvidenceCache;
  });
}

async function saveToolEvidence(data) {
  toolEvidenceCache = data;
  await writeJsonAtomic(TOOL_EVIDENCE_FILE, data);
}

function loadSessionHistory() {
  return memoLoad('history', () => sessionHistoryCache, async () => {
    const parsed = await readJson(SESSION_HISTORY_FILE, () => []);
    sessionHistoryCache = Array.isArray(parsed) ? parsed : [];
    return sessionHistoryCache;
  });
}

async function saveSessionHistory(data) {
  sessionHistoryCache = data;
  await writeJsonAtomic(SESSION_HISTORY_FILE, data);
}

/** Confirmed facts for a repo, loading the store first so a restart doesn't drop them. */
async function getMicroskillsForInjection(repoRoot) {
  const microskills = await loadMicroskills();
  return microskills.confirmed
    .filter(m => m.repo === repoRoot || m.global)
    .map(m => m.fact);
}

async function proposeMicroskill(fact, repoRoot, source = 'auto') {
  const microskills = await loadMicroskills();
  const existing = [...microskills.confirmed, ...microskills.proposed].find(
    m => m.fact === fact && m.repo === repoRoot
  );
  if (existing) return { status: 'exists', skill: existing };

  const skill = {
    id: randomUUID(),
    fact,
    repo: repoRoot,
    source,
    proposedAt: new Date().toISOString(),
    confirmations: 0,
  };
  microskills.proposed.push(skill);
  await saveMicroskills(microskills);
  return { status: 'proposed', skill };
}

async function confirmMicroskill(skillId) {
  const microskills = await loadMicroskills();
  const idx = microskills.proposed.findIndex(s => s.id === skillId);
  if (idx === -1) return { status: 'not_found' };

  const skill = microskills.proposed.splice(idx, 1)[0];
  skill.confirmedAt = new Date().toISOString();
  skill.confirmations++;
  microskills.confirmed.push(skill);
  await saveMicroskills(microskills);
  return { status: 'confirmed', skill };
}

async function rejectMicroskill(skillId) {
  const microskills = await loadMicroskills();
  const idx = microskills.proposed.findIndex(s => s.id === skillId);
  if (idx === -1) return { status: 'not_found' };

  const skill = microskills.proposed.splice(idx, 1)[0];
  skill.rejectedAt = new Date().toISOString();
  microskills.rejected.push(skill);
  await saveMicroskills(microskills);
  return { status: 'rejected', skill };
}

/**
 * Record one tool call. `sessionId` identifies the chat/task session, so two
 * sessions on the same day count as two (the date is only a fallback).
 */
async function recordToolUse(toolName, experience, repoRoot, sessionId = null) {
  const evidence = await loadToolEvidence();
  const key = `${repoRoot}::${experience}::${toolName}`;
  const now = new Date().toISOString();

  if (!evidence[key]) {
    evidence[key] = {
      tool: toolName,
      experience,
      repo: repoRoot,
      uses: 0,
      sessions: [],
      firstSeen: now,
      lastUsed: now,
    };
  }
  const record = normalizeEvidenceRecord(evidence[key]);
  const sessionKey = sessionId ? String(sessionId) : now.split('T')[0];
  if (!record.sessions.includes(sessionKey)) record.sessions.push(sessionKey);
  record.uses = (record.uses || 0) + 1;
  record.lastUsed = now;
  evidence[key] = record;

  await saveToolEvidence(evidence);
  return record;
}

/**
 * Build the runAgentLoop onToolCall callback that feeds tool evidence. Shared
 * by the message, stream and task-runner paths so none of them can drift.
 * Returns the recording promise (already guarded) so tests can await it.
 */
function createToolUseRecorder({ session, repoRoot, logStructured, record = recordToolUse }) {
  return ({ name } = {}) => {
    if (!name) return Promise.resolve();
    return Promise.resolve()
      .then(() => record(name, session?.experience || 'developer', repoRoot, session?.id || null))
      .catch(e => logStructured?.('warn', 'token_economizer_record_failed', { tool: name, error: e.message }));
  };
}

async function getPrunableTools(repoRoot, experience) {
  const config = await loadConfig();
  const evidence = await loadToolEvidence();
  const now = new Date();

  return Object.values(evidence)
    .filter(e => e.repo === repoRoot && e.experience === experience)
    .filter(e => {
      const sessionCount = Array.isArray(e.sessions) ? e.sessions.length : 0;
      const promptCount = e.uses || 0;
      return (
        sessionCount >= config.toolprune_min_sessions &&
        promptCount >= config.toolprune_evidence &&
        (now - new Date(e.lastUsed)) / (1000 * 60 * 60 * 24) > config.toolprune_sessions
      );
    })
    .map(e => e.tool);
}

async function pruneTools(repoRoot, experience, toolsToPrune) {
  const evidence = await loadToolEvidence();
  const pruned = {};

  for (const tool of toolsToPrune) {
    const key = `${repoRoot}::${experience}::${tool}`;
    if (evidence[key]) {
      pruned[tool] = { ...evidence[key], prunedAt: new Date().toISOString() };
      delete evidence[key];
    }
  }

  await saveToolEvidence(evidence);
  return pruned;
}

async function restoreTool(repoRoot, experience, toolName) {
  const evidence = await loadToolEvidence();
  const key = `${repoRoot}::${experience}::${toolName}`;
  // Restore with reset counters
  evidence[key] = {
    tool: toolName,
    experience,
    repo: repoRoot,
    uses: 0,
    sessions: [],
    firstSeen: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    restoredAt: new Date().toISOString(),
  };
  await saveToolEvidence(evidence);
  return evidence[key];
}

/**
 * Summarize a finished chat/task session for the history log. Only counts and
 * identifiers are kept, never message content or tool arguments/results.
 */
function summarizeSession(session, repoRoot, { kind = 'chat' } = {}) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const toolsUsed = messages.reduce((n, m) => n + (Array.isArray(m?.toolLog) ? m.toolLog.length : 0), 0);
  return {
    repo: repoRoot,
    sessionId: session?.id || null,
    kind,
    experience: session?.experience || null,
    turns: messages.filter(m => m?.role === 'assistant').length,
    toolsUsed,
  };
}

async function recordSession(sessionData) {
  const history = await loadSessionHistory();
  history.push({
    ...sessionData,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  });
  // Keep last 1000 sessions
  if (history.length > 1000) history.splice(0, history.length - 1000);
  await saveSessionHistory(history);
}

async function getStatus(repoRoot) {
  const config = await loadConfig();
  const microskills = await loadMicroskills();
  const evidence = await loadToolEvidence();
  const history = await loadSessionHistory();

  const repoMicroskills = microskills.confirmed.filter(m => m.repo === repoRoot || m.global);
  const repoProposed = microskills.proposed.filter(m => m.repo === repoRoot);
  const repoEvidence = Object.values(evidence).filter(e => e.repo === repoRoot);
  const repoHistory = history.filter(h => h.repo === repoRoot);

  const totalPrompts = repoEvidence.reduce((sum, e) => sum + (e.uses || 0), 0);
  const totalSessions = new Set(repoEvidence.flatMap(e => (Array.isArray(e.sessions) ? e.sessions : []))).size;

  return {
    config,
    microskills: {
      confirmed: repoMicroskills.length,
      proposed: repoProposed.length,
      rejected: microskills.rejected.filter(m => m.repo === repoRoot).length,
      facts: repoMicroskills.map(m => m.fact),
    },
    tools: {
      tracked: repoEvidence.length,
      totalPrompts,
      totalSessions,
      prunable: (await getPrunableTools(repoRoot, 'developer')).length,
    },
    sessions: {
      total: repoHistory.length,
      recent: repoHistory.slice(-10),
    },
  };
}

async function getLoopGuardNudge(sessionId, turnCount, lastTurnTime) {
  const config = await loadConfig();
  const now = Date.now();
  const timeSinceLastTurn = now - new Date(lastTurnTime).getTime();
  const backstopMs = config.loopguard_backstop_mult * 60 * 1000; // Convert to ms

  if (turnCount >= config.loopguard_nudges && timeSinceLastTurn > backstopMs) {
    return {
      shouldNudge: true,
      message: `Loop guard: No progress for ${Math.round(timeSinceLastTurn / 60000)} minutes. Consider interrupting or changing approach.`,
      confidence: config.loopguard_judge_confidence,
    };
  }
  return { shouldNudge: false };
}

export const TokenEconomizer = {
  // Config
  CONFIG_SCHEMA,
  validateConfigUpdate,
  loadConfig,
  saveConfig,
  getConfig: () => loadConfig(),

  // Micro-skills
  loadMicroskills,
  getMicroskillsForInjection,
  proposeMicroskill,
  confirmMicroskill,
  rejectMicroskill,

  // Tool pruning
  loadToolEvidence,
  recordToolUse,
  createToolUseRecorder,
  getPrunableTools,
  pruneTools,
  restoreTool,

  // Session history
  loadSessionHistory,
  recordSession,
  summarizeSession,

  // Status & monitoring
  getStatus,

  // Loop guard
  getLoopGuardNudge,

  // Paths
  TOK_ECON_DIR,
  MICROSKILLS_FILE,
  TOOL_EVIDENCE_FILE,
  CONFIG_FILE,
  SESSION_HISTORY_FILE,

  // Test hook: drop in-memory caches so the next load re-reads disk.
  _resetCachesForTest() {
    configCache = null;
    microskillsCache = null;
    toolEvidenceCache = null;
    sessionHistoryCache = null;
  },
  // Test hook: resolves once every queued write has landed.
  async _flushWritesForTest() {
    await Promise.all([...writeChains.values()].map(p => p.catch(() => {})));
  },
};

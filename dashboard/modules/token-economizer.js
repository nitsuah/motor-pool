import { readFile, writeFile, mkdir, readdir, stat, rm } from 'fs/promises';
import { resolve as resolvePath, join as joinPath, dirname as dirnamePath } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const TOK_ECON_DIR = joinPath(homedir(), '.tokeneconomizer');
const MICROSKILLS_FILE = joinPath(TOK_ECON_DIR, 'microskills.json');
const TOOL_EVIDENCE_FILE = joinPath(TOK_ECON_DIR, 'tool-evidence.json');
const CONFIG_FILE = joinPath(TOK_ECON_DIR, 'config.json');
const SESSION_HISTORY_FILE = joinPath(TOK_ECON_DIR, 'session-history.json');

const DEFAULT_CONFIG = {
  microskills_propose_every: 3,
  toolprune_evidence: 10,
  toolprune_min_sessions: 2,
  toolprune_sessions: 5,
  loopguard_judge_confidence: 0.7,
  loopguard_nudges: 1,
  loopguard_backstop_mult: 2.5,
};

let configCache = null;
let microskillsCache = null;
let toolEvidenceCache = null;
let sessionHistoryCache = null;

async function ensureDir() {
  try {
    await mkdir(TOK_ECON_DIR, { recursive: true });
  } catch {}
}

async function loadConfig() {
  if (configCache) return configCache;
  await ensureDir();
  try {
    const data = await readFile(CONFIG_FILE, 'utf8');
    configCache = { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch {
    configCache = { ...DEFAULT_CONFIG };
  }
  return configCache;
}

async function saveConfig(config) {
  await ensureDir();
  configCache = { ...DEFAULT_CONFIG, ...config };
  await writeFile(CONFIG_FILE, JSON.stringify(configCache, null, 2));
  return configCache;
}

async function loadMicroskills() {
  if (microskillsCache) return microskillsCache;
  await ensureDir();
  try {
    const data = await readFile(MICROSKILLS_FILE, 'utf8');
    microskillsCache = JSON.parse(data);
  } catch {
    microskillsCache = { confirmed: [], proposed: [], rejected: [] };
  }
  return microskillsCache;
}

async function saveMicroskills(data) {
  await ensureDir();
  microskillsCache = data;
  await writeFile(MICROSKILLS_FILE, JSON.stringify(data, null, 2));
}

async function loadToolEvidence() {
  if (toolEvidenceCache) return toolEvidenceCache;
  await ensureDir();
  try {
    const data = await readFile(TOOL_EVIDENCE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    // Restore Sets from arrays
    for (const key of Object.keys(parsed)) {
      if (parsed[key].sessions && Array.isArray(parsed[key].sessions)) {
        parsed[key].sessions = new Set(parsed[key].sessions);
      }
    }
    toolEvidenceCache = parsed;
  } catch {
    toolEvidenceCache = {};
  }
  return toolEvidenceCache;
}

async function saveToolEvidence(data) {
  await ensureDir();
  toolEvidenceCache = data;
  await writeFile(TOOL_EVIDENCE_FILE, JSON.stringify(data, null, 2));
}

async function loadSessionHistory() {
  if (sessionHistoryCache) return sessionHistoryCache;
  await ensureDir();
  try {
    const data = await readFile(SESSION_HISTORY_FILE, 'utf8');
    sessionHistoryCache = JSON.parse(data);
  } catch {
    sessionHistoryCache = [];
  }
  return sessionHistoryCache;
}

async function saveSessionHistory(data) {
  await ensureDir();
  sessionHistoryCache = data;
  await writeFile(SESSION_HISTORY_FILE, JSON.stringify(data, null, 2));
}

function getMicroskillsForInjection(repoRoot) {
  return microskillsCache?.confirmed
    ?.filter(m => m.repo === repoRoot || m.global)
    ?.map(m => m.fact) || [];
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

async function recordToolUse(toolName, experience, repoRoot) {
  const evidence = await loadToolEvidence();
  const key = `${repoRoot}::${experience}::${toolName}`;
  const now = new Date().toISOString();

  if (!evidence[key]) {
    evidence[key] = {
      tool: toolName,
      experience,
      repo: repoRoot,
      uses: 0,
      sessions: new Set(),
      firstSeen: now,
      lastUsed: now,
    };
  }
  // Ensure sessions is a Set (may be array after load)
  if (!(evidence[key].sessions instanceof Set)) {
    evidence[key].sessions = new Set(evidence[key].sessions);
  }
  evidence[key].uses++;
  evidence[key].sessions.add(now.split('T')[0]);
  evidence[key].lastUsed = now;

  // Keep as Set for future operations, convert to array only for saving
  const evidenceToSave = { ...evidence };
  evidenceToSave[key] = { ...evidence[key], sessions: Array.from(evidence[key].sessions) };
  await saveToolEvidence(evidenceToSave);
  return evidence[key];
}

async function getPrunableTools(repoRoot, experience) {
  const config = await loadConfig();
  const evidence = await loadToolEvidence();
  const now = new Date();

  return Object.values(evidence)
    .filter(e => e.repo === repoRoot && e.experience === experience)
    .filter(e => {
      const sessionCount = e.sessions?.length || 0;
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
  const totalSessions = new Set(repoEvidence.flatMap(e => e.sessions || [])).size;

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
  getPrunableTools,
  pruneTools,
  restoreTool,

  // Session history
  loadSessionHistory,
  recordSession,

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
};
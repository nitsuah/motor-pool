/**
 * File-based session snapshot — persists full session state (including messages)
 * to data/sessions-snapshot.json so sessions survive container restarts without
 * requiring a PostgreSQL DATABASE_URL.
 *
 * Write path: debounced 2s after each upsert call to avoid thrashing disk.
 * Read path: called once at server startup to restore sessions into the in-memory Map.
 *
 * When DATABASE_URL is set, the DB remains the authority for session *metadata*;
 * this file layer covers full message history in all cases.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const SNAPSHOT_PATH = process.env.SESSION_SNAPSHOT_PATH || join(process.cwd(), 'data', 'sessions-snapshot.json');
const SNAPSHOT_DIR = dirname(SNAPSHOT_PATH);
const WRITE_DEBOUNCE_MS = 2000;

let writeTimer = null;
let sessionsRef = null;

function ensureDir() {
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
}

export function initSessionSnapshot(sessions, logStructured) {
  sessionsRef = sessions;
  ensureDir();

  // Load existing snapshot
  if (existsSync(SNAPSHOT_PATH)) {
    try {
      const raw = readFileSync(SNAPSHOT_PATH, 'utf8');
      const saved = JSON.parse(raw);
      let restored = 0;
      for (const s of (saved.sessions || [])) {
        // Re-hydrate dates
        s.createdAt = s.createdAt ? new Date(s.createdAt) : new Date();
        s.updatedAt = s.updatedAt ? new Date(s.updatedAt) : new Date();
        s.lastActivity = s.lastActivity ? new Date(s.lastActivity) : s.updatedAt;
        if (Array.isArray(s.messages)) {
          s.messages = s.messages.map(m => ({
            ...m,
            timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
          }));
        }
        // Don't restore sessions that were explicitly ended
        if (!s.endedAt) {
          sessions.set(s.id, s);
          restored++;
        }
      }
      logStructured?.('info', 'session_snapshot_restored', { restored });
    } catch (err) {
      logStructured?.('warn', 'session_snapshot_load_failed', { error: err.message });
    }
  }
}

export function scheduleSnapshotWrite(logStructured) {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (!sessionsRef) return;
    try {
      ensureDir();
      const payload = {
        savedAt: new Date().toISOString(),
        sessions: Array.from(sessionsRef.values()).filter(s => !s.endedAt),
      };
      const tmp = SNAPSHOT_PATH + '.tmp';
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, SNAPSHOT_PATH);
    } catch (err) {
      logStructured?.('warn', 'session_snapshot_write_failed', { error: err.message });
    }
  }, WRITE_DEBOUNCE_MS);
}

import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

const DATABASE_URL = process.env.DATABASE_URL || '';

// TLS options for the Postgres connection. Certificates are verified by default.
// DATABASE_SSL_CA is a PEM string or a path to a PEM file (for a private CA).
// DATABASE_SSL_INSECURE=1 skips verification for local development only and is
// ignored under NODE_ENV=production.
function buildSslOption(env = process.env) {
  if (!isTruthyEnv(env.DATABASE_SSL)) return false;
  const insecure = isTruthyEnv(env.DATABASE_SSL_INSECURE) && env.NODE_ENV !== 'production';
  if (insecure) return { rejectUnauthorized: false };
  const ssl = { rejectUnauthorized: true };
  const ca = String(env.DATABASE_SSL_CA || '').trim();
  if (ca) ssl.ca = readCa(ca);
  return ssl;
}

// Inline PEM is used as-is; anything else must be a readable PEM file. A bad
// value throws (initPersistence reports it) instead of reaching pg as a CA.
function readCa(value) {
  if (value.startsWith('-----BEGIN ')) return value;
  let pem;
  try {
    pem = readFileSync(value, 'utf8');
  } catch (err) {
    throw new Error(`DATABASE_SSL_CA is neither inline PEM nor a readable file (${err.code || err.message})`, { cause: err });
  }
  if (!pem.includes('-----BEGIN ')) throw new Error('DATABASE_SSL_CA file does not contain a PEM certificate');
  return pem;
}

let pool = null;
let enabled = false;
let lastError = null;

function getStatus() {
  return {
    enabled,
    configured: Boolean(DATABASE_URL),
    lastError,
  };
}

async function initPersistence(logStructured) {
  if (!DATABASE_URL) {
    enabled = false;
    return getStatus();
  }

  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: buildSslOption(),
      max: 5,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT,
        user_id TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        event_type TEXT NOT NULL,
        model TEXT,
        endpoint TEXT,
        experience TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_contexts (
        session_id TEXT PRIMARY KEY,
        user_id TEXT,
        user_role TEXT,
        name TEXT,
        experience TEXT,
        safety_mode TEXT,
        endpoint TEXT,
        model TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        ended_at TIMESTAMPTZ
      );
    `);

    enabled = true;
    lastError = null;
    logStructured('info', 'persistence_ready', { enabled: true });
    return getStatus();
  } catch (error) {
    enabled = false;
    lastError = error.message;
    logStructured('warn', 'persistence_unavailable', { error: error.message });
    return getStatus();
  }
}

async function persistEvent(event, logStructured) {
  if (!enabled || !pool) return;

  try {
    await pool.query(
      `
      INSERT INTO events (
        event_id, session_id, user_id, timestamp, event_type, model, endpoint, experience, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (event_id) DO NOTHING
      `,
      [
        event.event_id,
        event.session_id,
        event.user_id,
        event.timestamp,
        event.event_type,
        event.model,
        event.endpoint,
        event.experience,
        event.metadata || {},
      ]
    );
  } catch (error) {
    lastError = error.message;
    if (logStructured) {
      logStructured('warn', 'event_persist_failed', { error: error.message, eventType: event.event_type });
    }
  }
}

async function upsertSessionContext(session, logStructured) {
  if (!enabled || !pool || !session) return;

  try {
    await pool.query(
      `
      INSERT INTO session_contexts (
        session_id, user_id, user_role, name, experience, safety_mode, endpoint, model,
        created_at, updated_at, message_count, ended_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (session_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        user_role = EXCLUDED.user_role,
        name = EXCLUDED.name,
        experience = EXCLUDED.experience,
        safety_mode = EXCLUDED.safety_mode,
        endpoint = EXCLUDED.endpoint,
        model = EXCLUDED.model,
        updated_at = EXCLUDED.updated_at,
        message_count = EXCLUDED.message_count,
        ended_at = EXCLUDED.ended_at
      `,
      [
        session.id,
        session.userId || 'anonymous',
        session.userRole || null,
        session.name || null,
        session.experience || null,
        session.safetyMode || null,
        session.endpoint || null,
        session.model || null,
        session.createdAt || new Date(),
        session.updatedAt || new Date(),
        Array.isArray(session.messages) ? session.messages.length : 0,
        session.endedAt || null,
      ]
    );
  } catch (error) {
    lastError = error.message;
    if (logStructured) {
      logStructured('warn', 'session_context_persist_failed', { error: error.message, sessionId: session.id });
    }
  }
}

async function markSessionEnded(sessionId, endedAt = new Date(), logStructured) {
  if (!enabled || !pool || !sessionId) return;

  try {
    await pool.query(
      `UPDATE session_contexts SET ended_at = $2, updated_at = $2 WHERE session_id = $1`,
      [sessionId, endedAt]
    );
  } catch (error) {
    lastError = error.message;
    if (logStructured) {
      logStructured('warn', 'session_end_persist_failed', { error: error.message, sessionId });
    }
  }
}

export {
  buildSslOption,
  getStatus,
  initPersistence,
  markSessionEnded,
  persistEvent,
  upsertSessionContext,
};

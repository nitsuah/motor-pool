/**
 * Principals and API tokens (imps plan D6).
 *
 * A principal is an identity (a person, a device, a service) with one role:
 * superadmin, operator, dispatcher or runner. A principal holds any number of
 * API tokens. Tokens are `mp_<id>_<secret>`: `id` is 12 hex chars and is the
 * lookup key (safe to show), `secret` is 32 random bytes. Only the SHA-256 of
 * the whole token is stored; the plaintext is returned once, when minted.
 *
 * Storage is Postgres when persistence is enabled (tables are created in
 * persistence.js), otherwise an in-memory store that lasts for the process.
 *
 * Bootstrap: on a start with no principals at all, MP_BOOTSTRAP_TOKEN (env,
 * at least 32 characters, never defaulted) becomes the token of a
 * `superadmin` principal. Use it to mint real tokens, then revoke it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ROLES = Object.freeze(['superadmin', 'operator', 'dispatcher', 'runner']);
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;
export const BOOTSTRAP_PRINCIPAL_ID = 'superadmin';
export const BOOTSTRAP_TOKEN_ID = 'bootstrap';
/** Reserved for the dev-mode principal; never stored. */
export const DEV_PRINCIPAL_ID = 'dev';
export const DEFAULT_TOKEN_TTL_DAYS = 90;
export const MAX_TOKEN_TTL_DAYS = 3650;

const MAX_TOKEN_LENGTH = 512;
const TOKEN_RE = /^mp_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCOPE_RE = /^[a-z0-9:._-]{1,64}$/;
const TOUCH_INTERVAL_MS = 60_000;

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// Compared against when no row matches, so a miss costs the same as a hit.
const DUMMY_HASH = hashToken(randomBytes(32).toString('hex'));

/** A fresh token. The plaintext leaves this module only through mintToken's return value. */
export function generateToken() {
  const id = randomBytes(6).toString('hex');
  return { id, token: `mp_${id}_${randomBytes(32).toString('base64url')}` };
}

/** The row id a presented token is looked up by. Tokens not in mp_ form can only be the bootstrap token. */
export function tokenLookupId(token) {
  const m = TOKEN_RE.exec(token);
  return m ? m[1] : BOOTSTRAP_TOKEN_ID;
}

function hashesEqual(storedHex, computedHex) {
  const a = Buffer.from(String(storedHex), 'hex');
  const b = Buffer.from(computedHex, 'hex');
  // Both are SHA-256 digests; a length mismatch means a corrupt row, not a secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function isValidSlug(v) {
  return typeof v === 'string' && SLUG_RE.test(v);
}

export function publicPrincipal(p) {
  if (!p) return null;
  return {
    id: p.id, name: p.name, role: p.role, tenant: p.tenant,
    createdAt: p.createdAt ?? null, disabledAt: p.disabledAt ?? null,
  };
}

export function publicToken(t) {
  if (!t) return null;
  return {
    id: t.id,
    display: t.id === BOOTSTRAP_TOKEN_ID ? 'bootstrap' : `mp_${t.id}_…`,
    principalId: t.principalId, label: t.label ?? null, scopes: t.scopes ?? [],
    createdAt: t.createdAt ?? null, expiresAt: t.expiresAt ?? null,
    lastUsedAt: t.lastUsedAt ?? null, revokedAt: t.revokedAt ?? null,
  };
}

const toDate = (v) => (v == null ? null : new Date(v));

// ── Stores ────────────────────────────────────────────────────────────────

export function createMemoryStore() {
  const principals = new Map();
  const tokens = new Map();
  const copy = (v) => (v ? { ...v } : null);
  return {
    kind: 'memory',
    async countPrincipals() { return principals.size; },
    async insertPrincipal(p) {
      if (principals.has(p.id)) return false;
      principals.set(p.id, { ...p });
      return true;
    },
    async getPrincipal(id) { return copy(principals.get(id)); },
    async listPrincipals() {
      return [...principals.values()].map(copy).sort((a, b) => a.createdAt - b.createdAt);
    },
    async countActiveSuperadmins() {
      return [...principals.values()].filter(p => p.role === 'superadmin' && !p.disabledAt).length;
    },
    async disablePrincipal(id, at) {
      const p = principals.get(id);
      if (!p) return false;
      if (!p.disabledAt) p.disabledAt = at;
      for (const t of tokens.values()) if (t.principalId === id && !t.revokedAt) t.revokedAt = at;
      return true;
    },
    async insertToken(t) {
      if (tokens.has(t.id)) return false;
      if ([...tokens.values()].some(x => x.tokenHash === t.tokenHash)) return false;
      tokens.set(t.id, { ...t });
      return true;
    },
    async getToken(id) { return copy(tokens.get(id)); },
    async listTokens(principalId) {
      return [...tokens.values()]
        .filter(t => !principalId || t.principalId === principalId)
        .map(copy)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async revokeToken(id, at) {
      const t = tokens.get(id);
      if (!t) return false;
      if (!t.revokedAt) t.revokedAt = at;
      return true;
    },
    async touchToken(id, at) {
      const t = tokens.get(id);
      if (t) t.lastUsedAt = at;
    },
  };
}

function principalFromRow(r) {
  return r && {
    id: r.id, name: r.name, role: r.role, tenant: r.tenant,
    createdAt: toDate(r.created_at), disabledAt: toDate(r.disabled_at),
  };
}

function tokenFromRow(r) {
  return r && {
    id: r.id, principalId: r.principal_id, tokenHash: r.token_hash, label: r.label,
    scopes: r.scopes || [], createdAt: toDate(r.created_at), expiresAt: toDate(r.expires_at),
    lastUsedAt: toDate(r.last_used_at), revokedAt: toDate(r.revoked_at),
  };
}

const TOKEN_COLUMNS = 'id, principal_id, token_hash, label, scopes, created_at, expires_at, last_used_at, revoked_at';

export function createPgStore(pool) {
  const q = (text, params) => pool.query(text, params);
  return {
    kind: 'postgres',
    async countPrincipals() {
      const { rows } = await q('SELECT count(*)::int AS n FROM principals');
      return rows[0].n;
    },
    async insertPrincipal(p) {
      const { rowCount } = await q(
        `INSERT INTO principals (id, name, role, tenant, created_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.role, p.tenant, p.createdAt],
      );
      return rowCount === 1;
    },
    async getPrincipal(id) {
      const { rows } = await q('SELECT * FROM principals WHERE id = $1', [id]);
      return principalFromRow(rows[0]);
    },
    async listPrincipals() {
      const { rows } = await q('SELECT * FROM principals ORDER BY created_at');
      return rows.map(principalFromRow);
    },
    async countActiveSuperadmins() {
      const { rows } = await q(`SELECT count(*)::int AS n FROM principals WHERE role = 'superadmin' AND disabled_at IS NULL`);
      return rows[0].n;
    },
    async disablePrincipal(id, at) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rowCount } = await client.query(
          'UPDATE principals SET disabled_at = COALESCE(disabled_at, $2) WHERE id = $1', [id, at]);
        await client.query(
          'UPDATE api_tokens SET revoked_at = $2 WHERE principal_id = $1 AND revoked_at IS NULL', [id, at]);
        await client.query('COMMIT');
        return rowCount === 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async insertToken(t) {
      const { rowCount } = await q(
        `INSERT INTO api_tokens (id, principal_id, token_hash, label, scopes, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [t.id, t.principalId, t.tokenHash, t.label, t.scopes, t.createdAt, t.expiresAt],
      );
      return rowCount === 1;
    },
    async getToken(id) {
      const { rows } = await q(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE id = $1`, [id]);
      return tokenFromRow(rows[0]);
    },
    async listTokens(principalId) {
      const { rows } = principalId
        ? await q(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE principal_id = $1 ORDER BY created_at`, [principalId])
        : await q(`SELECT ${TOKEN_COLUMNS} FROM api_tokens ORDER BY created_at`);
      return rows.map(tokenFromRow);
    },
    async revokeToken(id, at) {
      const { rowCount } = await q('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [id, at]);
      return rowCount === 1;
    },
    async touchToken(id, at) {
      await q('UPDATE api_tokens SET last_used_at = $2 WHERE id = $1', [id, at]);
    },
  };
}

// ── Service ───────────────────────────────────────────────────────────────

export function createPrincipalService({ store, now = () => new Date(), logStructured = () => {} } = {}) {
  if (!store) throw new Error('createPrincipalService requires a store');
  const lastTouch = new Map();

  function touch(id) {
    const t = Date.now();
    if ((lastTouch.get(id) ?? 0) + TOUCH_INTERVAL_MS > t) return;
    lastTouch.set(id, t);
    if (lastTouch.size > 5000) lastTouch.delete(lastTouch.keys().next().value);
    Promise.resolve(store.touchToken(id, now())).catch((err) => {
      logStructured('warn', 'auth_token_touch_failed', { tokenId: id, error: err.message });
    });
  }

  function tokenUsable(row) {
    if (!row || row.revokedAt) return false;
    return !(row.expiresAt && row.expiresAt.getTime() <= now().getTime());
  }

  async function activePrincipal(id) {
    const p = await store.getPrincipal(id);
    return p && !p.disabledAt ? publicPrincipal(p) : null;
  }

  /**
   * Checks MP_BOOTSTRAP_TOKEN and, when no principal exists yet, creates the
   * superadmin from it. Throws when the variable is set but too short.
   */
  async function bootstrap(env = process.env) {
    const token = String(env.MP_BOOTSTRAP_TOKEN ?? '').trim();
    if (!token) return { bootstrapped: false, reason: 'unset' };
    if (token.length < MIN_BOOTSTRAP_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
      throw new Error(`MP_BOOTSTRAP_TOKEN must be ${MIN_BOOTSTRAP_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} characters`);
    }
    if (await store.countPrincipals() > 0) return { bootstrapped: false, reason: 'principals_exist' };
    const at = now();
    await store.insertPrincipal({
      id: BOOTSTRAP_PRINCIPAL_ID, name: 'Bootstrap superadmin', role: 'superadmin', tenant: 'default', createdAt: at, disabledAt: null,
    });
    await store.insertToken({
      id: tokenLookupId(token), principalId: BOOTSTRAP_PRINCIPAL_ID, tokenHash: hashToken(token),
      label: 'bootstrap', scopes: [], createdAt: at, expiresAt: null,
    });
    logStructured('info', 'auth_bootstrap_created', { principalId: BOOTSTRAP_PRINCIPAL_ID });
    return { bootstrapped: true };
  }

  /** Presented token -> { principal, tokenId } or null. Never throws on bad input. */
  async function verifyToken(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return null;
    const row = await store.getToken(tokenLookupId(token));
    const matches = hashesEqual(row?.tokenHash ?? DUMMY_HASH, hashToken(token));
    if (!row || !matches || !tokenUsable(row)) return null;
    const principal = await activePrincipal(row.principalId);
    if (!principal) return null;
    touch(row.id);
    return { principal, tokenId: row.id };
  }

  /** For sessions created from a token: still valid only while that token is. */
  async function verifyTokenId(tokenId, principalId) {
    const row = await store.getToken(tokenId);
    if (!tokenUsable(row) || row.principalId !== principalId) return null;
    return activePrincipal(principalId);
  }

  async function createPrincipal({ id, name, role, tenant } = {}) {
    if (!isValidSlug(id) || id === DEV_PRINCIPAL_ID) throw new AuthError(400, 'id must be a lowercase slug (a-z, 0-9, . _ -), up to 64 characters');
    if (!ROLES.includes(role)) throw new AuthError(400, `role must be one of ${ROLES.join(', ')}`);
    const t = tenant ?? 'default';
    if (!isValidSlug(t)) throw new AuthError(400, 'tenant must be a lowercase slug');
    const displayName = name == null ? id : String(name).trim().slice(0, 100);
    const principal = { id, name: displayName || id, role, tenant: t, createdAt: now(), disabledAt: null };
    if (!(await store.insertPrincipal(principal))) throw new AuthError(409, 'principal already exists');
    return publicPrincipal(principal);
  }

  async function disablePrincipal(id) {
    const p = await store.getPrincipal(id);
    if (!p) throw new AuthError(404, 'principal not found');
    if (p.role === 'superadmin' && !p.disabledAt && await store.countActiveSuperadmins() <= 1) {
      throw new AuthError(409, 'cannot disable the last active superadmin');
    }
    await store.disablePrincipal(id, now());
    return publicPrincipal(await store.getPrincipal(id));
  }

  async function mintToken({ principalId, label, expiresInDays = DEFAULT_TOKEN_TTL_DAYS, scopes = [] } = {}) {
    const p = await store.getPrincipal(principalId);
    if (!p || p.disabledAt) throw new AuthError(404, 'principal not found or disabled');
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_TTL_DAYS) {
      throw new AuthError(400, `expiresInDays must be an integer from 1 to ${MAX_TOKEN_TTL_DAYS}`);
    }
    if (!Array.isArray(scopes) || scopes.length > 20 || !scopes.every(s => typeof s === 'string' && SCOPE_RE.test(s))) {
      throw new AuthError(400, 'scopes must be up to 20 short lowercase strings');
    }
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + days * 86_400_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { id, token } = generateToken();
      const row = {
        id, principalId, tokenHash: hashToken(token), label: label == null ? null : String(label).trim().slice(0, 100) || null,
        scopes, createdAt, expiresAt,
      };
      if (await store.insertToken(row)) return { ...publicToken(row), token };
    }
    throw new AuthError(500, 'could not allocate a token id');
  }

  async function revokeToken(id) {
    if (typeof id !== 'string' || !(await store.revokeToken(id, now()))) throw new AuthError(404, 'token not found');
    return publicToken(await store.getToken(id));
  }

  return {
    storeKind: store.kind,
    bootstrap,
    verifyToken,
    verifyTokenId,
    createPrincipal,
    disablePrincipal,
    mintToken,
    revokeToken,
    getPrincipal: async (id) => publicPrincipal(await store.getPrincipal(id)),
    listPrincipals: async () => (await store.listPrincipals()).map(publicPrincipal),
    listTokens: async (principalId) => (await store.listTokens(principalId)).map(publicToken),
  };
}

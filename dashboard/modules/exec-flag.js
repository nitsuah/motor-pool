import { timingSafeEqual, createHash } from 'node:crypto';

const isOn = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/**
 * Opt-in switch for workspace shell execution: the `/workspace/exec` route and
 * the agent `bash` tool. Off unless WORKSPACE_EXEC is `1` or `true`, and always
 * off in public demo mode (PUBLIC_DEMO_MODE).
 * Read at call time so the value can change between requests (and in tests).
 */
export function shellExecEnabled(env = process.env) {
  if (isOn(env.PUBLIC_DEMO_MODE)) return false;
  return ['1', 'true'].includes(String(env.WORKSPACE_EXEC ?? '').trim().toLowerCase());
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function sameSecret(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Who may call the exec route. With WORKSPACE_EXEC_TOKEN set, the request must
 * carry it as `Authorization: Bearer <token>`. Without a token, only a loopback
 * peer is accepted, and never under NODE_ENV=production.
 * Returns { ok: true } or { ok: false, status, error }.
 */
export function authorizeExec(req, env = process.env) {
  const token = String(env.WORKSPACE_EXEC_TOKEN ?? '');
  if (token) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization ?? ''));
    if (m && sameSecret(m[1].trim(), token)) return { ok: true };
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  const peer = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (env.NODE_ENV !== 'production' && LOOPBACK.has(peer)) return { ok: true };
  return { ok: false, status: 403, error: 'Shell execution requires WORKSPACE_EXEC_TOKEN' };
}

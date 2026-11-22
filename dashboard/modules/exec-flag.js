import { timingSafeEqual, createHash } from 'node:crypto';

export const isOn = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/**
 * Opt-in switch for workspace shell execution: the `/workspace/exec` route and
 * the agent `bash` tool. Off unless WORKSPACE_EXEC is `1` or `true`, and always
 * off in public demo mode (PUBLIC_DEMO_MODE).
 * The parsing is deliberately asymmetric: PUBLIC_DEMO_MODE only ever turns
 * execution off, so it accepts any common truthy spelling, while
 * WORKSPACE_EXEC turns on shell access and accepts only `1` or `true`.
 * Read at call time so the value can change between requests (and in tests).
 */
export function shellExecEnabled(env = process.env) {
  if (isOn(env.PUBLIC_DEMO_MODE)) return false;
  return ['1', 'true'].includes(String(env.WORKSPACE_EXEC ?? '').trim().toLowerCase());
}

// remoteAddress is always an IP literal, never a hostname.
const LOOPBACK = new Set(['127.0.0.1', '::1']);

function sameSecret(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Parses `Bearer <token>` without a regex (no backtracking on long input).
function bearerToken(header) {
  const value = String(header ?? '');
  if (value.slice(0, 7).toLowerCase() !== 'bearer ') return '';
  return value.slice(7).trim();
}

/**
 * Who may call the exec route. With WORKSPACE_EXEC_TOKEN set, the request must
 * carry it as `Authorization: Bearer <token>`. Without a token, only a loopback
 * peer is accepted, and never under NODE_ENV=production.
 * Returns { ok: true } or { ok: false, status, error }.
 */
export function authorizeExec(req, env = process.env) {
  const token = String(env.WORKSPACE_EXEC_TOKEN ?? '').trim();
  if (token) {
    const presented = bearerToken(req.headers?.authorization);
    if (presented && sameSecret(presented, token)) return { ok: true };
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  const peer = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (env.NODE_ENV !== 'production' && LOOPBACK.has(peer)) return { ok: true };
  return { ok: false, status: 403, error: 'Shell execution requires WORKSPACE_EXEC_TOKEN' };
}

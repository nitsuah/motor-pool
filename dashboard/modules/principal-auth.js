/**
 * Request -> principal, and the requireAuth guard.
 *
 * A request is attributed to a principal by, in order:
 *   1. `Authorization: Bearer mp_…` (an API token). A bearer that is presented
 *      but not a valid token yields no principal; there is no fallback.
 *   2. The dashboard session cookie, when that session was opened by signing in
 *      with an API token. It stays valid only while that token is.
 *   3. Dev mode: MP_AUTH_DEV_MODE=1 makes an unauthenticated loopback request
 *      act as a local superadmin (`dev`). Off by default, ignored under
 *      NODE_ENV=production, and only honored for a loopback socket with a
 *      loopback Host and no proxy headers (the same test as the dashboard's
 *      loopback opt-out).
 *
 * requireAuth answers 401 (no detail) without a principal and 403 when the
 * principal's role is not allowed. Tokens are never logged.
 */
import { bearerToken, hasProxyHeader, isLoopbackAddress, isLoopbackHost } from './dashboard-auth.js';
import { DEV_PRINCIPAL_ID } from './principals.js';

export const DEV_PRINCIPAL = Object.freeze({
  id: DEV_PRINCIPAL_ID, name: 'Local dev (MP_AUTH_DEV_MODE)', role: 'superadmin', tenant: 'default',
});

const isOn = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

export function createPrincipalAuth({ service, env = process.env, sessionBinding = () => null, logStructured = () => {} } = {}) {
  if (!service) throw new Error('createPrincipalAuth requires a principal service');

  const isProduction = () => String(env.NODE_ENV || '').toLowerCase() === 'production';
  const devModeRequested = () => isOn(env.MP_AUTH_DEV_MODE);

  function devModeApplies(req) {
    if (!devModeRequested() || isProduction()) return false;
    const h = req.headers || {};
    if (hasProxyHeader(h)) return false;
    return isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHost(h.host);
  }

  /** Works for express requests and raw WebSocket upgrade requests. */
  async function authenticate(req) {
    const presented = bearerToken(req.headers?.authorization);
    if (presented !== null) {
      const result = await service.verifyToken(presented);
      return result ? { ...result.principal, via: 'token', tokenId: result.tokenId } : null;
    }
    const binding = sessionBinding(req);
    if (binding) {
      const principal = await service.verifyTokenId(binding.tokenId, binding.principalId);
      if (principal) return { ...principal, via: 'session', tokenId: binding.tokenId };
    }
    if (devModeApplies(req)) return { ...DEV_PRINCIPAL, via: 'dev' };
    return null;
  }

  /**
   * Re-checks a principal attributed earlier (a long-lived WebSocket): null once
   * its token is revoked or expired, its principal disabled, or dev mode is off.
   */
  async function revalidate(principal) {
    if (!principal) return null;
    if (principal.via === 'dev') return devModeRequested() && !isProduction() ? principal : null;
    if (!principal.tokenId) return null;
    const current = await service.verifyTokenId(principal.tokenId, principal.id);
    return current ? { ...current, via: principal.via, tokenId: principal.tokenId } : null;
  }

  /** A bare token (e.g. a WebSocket auth message) -> principal or null. */
  async function authenticateToken(token) {
    const result = await service.verifyToken(token);
    return result ? { ...result.principal, via: 'token', tokenId: result.tokenId } : null;
  }

  async function resolveInto(req) {
    if (req.principal !== undefined) return req.principal;
    try {
      req.principal = await authenticate(req);
    } catch (err) {
      // A store failure must not let the request through.
      logStructured('warn', 'principal_auth_failed', { error: err.message });
      req.principal = null;
    }
    return req.principal;
  }

  /** Never blocks: attaches req.principal (or null) for later guards and filters. */
  function resolve() {
    return async function resolvePrincipal(req, _res, next) {
      await resolveInto(req);
      next();
    };
  }

  /** roles: optional allow-list. Missing/invalid credential -> 401; wrong role -> 403. */
  function requireAuth(roles = null) {
    return async function requirePrincipal(req, res, next) {
      const principal = await resolveInto(req);
      if (!principal) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      if (roles && !roles.includes(principal.role)) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
      return next();
    };
  }

  return { authenticate, authenticateToken, revalidate, resolve, requireAuth, devModeRequested, isProduction };
}

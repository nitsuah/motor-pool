/**
 * Rejects state-changing browser requests that come from a foreign origin.
 *
 * Requests without an Origin header (curl, server-to-server, same-origin GETs)
 * are not affected. A request with an Origin is allowed only when it is
 * same-host (the Origin host equals the Host header) or is listed in the
 * allowlist returned by getAllowedOrigins().
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function createOriginGuard(getAllowedOrigins) {
  return function originGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();

    let originHost = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch { /* unparseable (or "null"): only the allowlist can admit it */ }

    const host = String(req.headers.host || '').toLowerCase();
    if (originHost && host && originHost === host) return next();

    const allowed = (getAllowedOrigins() || []).map(normalizeOrigin);
    if (allowed.includes(normalizeOrigin(origin))) return next();

    return res.status(403).json({ success: false, error: 'Cross-origin request refused' });
  };
}

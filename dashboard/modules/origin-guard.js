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
  const origin = String(value || '').trim();
  let end = origin.length;
  while (end > 0 && origin[end - 1] === '/') end--;
  return origin.slice(0, end).toLowerCase();
}

// Hostname part of a Host header value or host[:port] entry (lowercased).
function hostnameOf(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end === -1 ? v : v.slice(0, end + 1);
  }
  const i = v.lastIndexOf(':');
  return i === -1 ? v : v.slice(0, i);
}

const BUILTIN_HOSTS = [
  'localhost', '127.0.0.1', '[::1]',
  // Compose service name used by sibling containers.
  'agent-dashboard',
];

/**
 * Refuses requests whose Host header is not a known name for this server, so a
 * page on another domain that resolves to this machine cannot reach the API.
 * Allowed: loopback names (any port), the Compose service name, hostnames of
 * the CORS allowlist, and ALLOWED_HOSTS (comma-separated hostnames).
 */
export function isHostAllowed(hostHeader, { getCorsOrigins, getAllowedHosts }) {
  const host = hostnameOf(hostHeader);
  const allowed = new Set(BUILTIN_HOSTS);
  for (const h of getAllowedHosts() || []) allowed.add(hostnameOf(h));
  for (const o of getCorsOrigins() || []) {
    try { allowed.add(new URL(o).hostname.toLowerCase()); } catch { /* ignore bad entry */ }
  }
  return Boolean(host) && allowed.has(host);
}

// Same-host (Origin host equals Host header) or listed in the allowlist.
export function isOriginAllowed(origin, hostHeader, allowedOrigins) {
  let originHost = null;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch { /* unparseable (or "null"): only the allowlist can admit it */ }
  const host = String(hostHeader || '').toLowerCase();
  if (originHost && host && originHost === host) return true;
  return (allowedOrigins || []).map(normalizeOrigin).includes(normalizeOrigin(origin));
}

export function createHostGuard(opts) {
  return function hostGuard(req, res, next) {
    if (isHostAllowed(req.headers.host, opts)) return next();
    return res.status(403).json({ success: false, error: 'Host not allowed' });
  };
}

/** Verifier for WebSocket upgrades: known Host, and any Origin same-host or allowlisted. */
export function createUpgradeVerifier({ getCorsOrigins, getAllowedHosts }) {
  return function verifyUpgrade(request) {
    if (!isHostAllowed(request.headers.host, { getCorsOrigins, getAllowedHosts })) return false;
    const origin = request.headers.origin;
    return !origin || isOriginAllowed(origin, request.headers.host, getCorsOrigins());
  };
}

export function createOriginGuard(getAllowedOrigins) {
  return function originGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();

    if (isOriginAllowed(origin, req.headers.host, getAllowedOrigins())) return next();

    return res.status(403).json({ success: false, error: 'Cross-origin request refused' });
  };
}

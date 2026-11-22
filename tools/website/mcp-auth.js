import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (v) => createHash('sha256').update(String(v)).digest();

// The credential from `Authorization: Bearer <token>`, or null. Plain string
// parsing (no regex) so a long run of spaces costs linear time.
export function bearerToken(header) {
  const h = String(header ?? '');
  const sp = h.indexOf(' ');
  if (sp < 0 || h.slice(0, sp).toLowerCase() !== 'bearer') return null;
  const value = h.slice(sp + 1).trim();
  return value || null;
}

// Express middleware for /mcp. When MCP_AUTH_TOKEN is set, a request must send
// `Authorization: Bearer <token>`; otherwise it is refused with 401.
// Read per request so the value can change without a restart.
export function createMcpAuth(env = process.env) {
  return function mcpAuth(req, res, next) {
    const token = String(env.MCP_AUTH_TOKEN ?? '');
    if (!token) return next();
    const sent = bearerToken(req.headers?.authorization);
    if (sent !== null && timingSafeEqual(digest(sent), digest(token))) return next();
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Authentication required' });
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopbackBind = (host) => LOOPBACK.has(String(host ?? "").trim().toLowerCase());

// Fail closed: a server that listens beyond loopback must have MCP_AUTH_TOKEN set.
export function assertAuthConfigured(host, env = process.env) {
  if (!isLoopbackBind(host) && !String(env.MCP_AUTH_TOKEN ?? "")) {
    throw new Error("MCP_AUTH_TOKEN is required when the server binds a non-loopback address");
  }
}

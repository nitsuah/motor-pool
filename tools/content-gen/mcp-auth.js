import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (v) => createHash('sha256').update(String(v)).digest();

// Express middleware for /mcp. When MCP_AUTH_TOKEN is set, a request must send
// `Authorization: Bearer <token>`; otherwise it is refused with 401.
// Read per request so the value can change without a restart.
export function createMcpAuth(env = process.env) {
  return function mcpAuth(req, res, next) {
    const token = String(env.MCP_AUTH_TOKEN ?? '');
    if (!token) return next();
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization ?? ''));
    if (m && timingSafeEqual(digest(m[1].trim()), digest(token))) return next();
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Authentication required' });
  };
}

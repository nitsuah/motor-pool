/**
 * Dashboard-wide authentication (HTTP and WebSocket).
 *
 * Credential: DASHBOARD_TOKEN, or a random token generated at startup and
 * printed once. Accepted as `Authorization: Bearer <token>` or as the session
 * cookie issued by POST /auth/login (the browser path, which also covers
 * WebSocket upgrades). Only the login page, POST /auth/login and /health are
 * reachable without it (plus the signed webhook trigger when WEBHOOK_SECRET is
 * set, because that route verifies its own HMAC).
 *
 * Local-dev opt-out: DASHBOARD_ALLOW_LOOPBACK_NOAUTH=1. It is ignored in
 * production and only honored for a request that arrives over a loopback
 * socket, carries no proxy-forwarding headers, and has a loopback Host.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

export const SESSION_COOKIE = 'mp_dashboard_session';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title>
<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:20vh auto;padding:0 1rem}
input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin-top:.5rem}</style></head>
<body><h1>Sign in</h1>
<form method="post" action="/auth/login">
<label for="token">Access token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button>
</form>
__ERROR__</body></html>`;

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

/** Constant-time string comparison (both sides hashed to equal length first). */
export function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

export function isLoopbackAddress(addr) {
  const a = String(addr || '').replace(/^::ffff:/i, '').toLowerCase();
  return a === '::1' || a === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

export function isLoopbackHost(host) {
  const v = String(host || '').trim().toLowerCase();
  let name = v;
  if (v.startsWith('[')) name = v.slice(0, v.indexOf(']') + 1);
  else if (v.includes(':')) name = v.slice(0, v.lastIndexOf(':'));
  return LOOPBACK_HOSTNAMES.has(name);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createDashboardAuth({ env = process.env } = {}) {
  const configuredToken = String(env.DASHBOARD_TOKEN || '').trim();
  const generated = !configuredToken;
  const token = configuredToken || randomBytes(24).toString('hex');
  const sessionValue = () => createHmac('sha256', token).update('dashboard-session-v1').digest('hex');
  const failures = new Map(); // ip -> { count, resetAt }

  const isProduction = () => String(env.NODE_ENV || '').toLowerCase() === 'production';
  const optOutRequested = () => ['1', 'true', 'yes'].includes(String(env.DASHBOARD_ALLOW_LOOPBACK_NOAUTH || '').toLowerCase());

  function loopbackOptOutApplies(req) {
    if (!optOutRequested() || isProduction()) return false;
    const h = req.headers;
    if (h['x-forwarded-for'] || h.forwarded || h['x-real-ip'] || h['x-forwarded-host']) return false;
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
    return isLoopbackHost(h.host);
  }

  function hasValidCredential(req) {
    const authz = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    if (m && safeEqual(m[1].trim(), token)) return true;
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return Boolean(cookie) && safeEqual(cookie, sessionValue());
  }

  /** Works for both express requests and raw WebSocket upgrade requests. */
  function isAuthorized(req) {
    return hasValidCredential(req) || loopbackOptOutApplies(req);
  }

  /** Startup policy: throws when the bind address is not loopback and no token was configured. */
  function assertStartupPolicy(host) {
    if (!isLoopbackAddress(host) && generated) {
      throw new Error('DASHBOARD_TOKEN is required when HOST is not a loopback address');
    }
  }

  function throttled(ip) {
    const f = failures.get(ip);
    return Boolean(f) && f.resetAt > Date.now() && f.count >= 10;
  }
  function recordFailure(ip) {
    const now = Date.now();
    const f = failures.get(ip);
    if (!f || f.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + 60_000 });
    else f.count += 1;
  }

  function loginRouter() {
    const router = express.Router();
    router.get('/login', (req, res) => {
      res.type('html').send(LOGIN_PAGE.replace('__ERROR__', req.query.error ? '<p role="alert">Invalid token.</p>' : ''));
    });
    router.post('/auth/login',
      express.urlencoded({ extended: false, limit: '4kb' }),
      express.json({ limit: '4kb' }),
      (req, res) => {
        const ip = req.socket?.remoteAddress || 'unknown';
        const wantsJson = /json/i.test(String(req.headers['content-type'] || ''));
        const fail = (status) => (wantsJson
          ? res.status(status).json({ success: false, error: 'Authentication failed' })
          : res.redirect(303, '/login?error=1'));
        if (throttled(ip)) return wantsJson ? res.status(429).json({ success: false, error: 'Too many attempts' }) : res.status(429).type('text').send('Too many attempts');
        const supplied = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
        if (!supplied || !safeEqual(supplied, token)) { recordFailure(ip); return fail(401); }
        failures.delete(ip);
        const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=43200'];
        if (req.secure || String(req.headers['x-forwarded-proto'] || '') === 'https') flags.push('Secure');
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionValue()}; ${flags.join('; ')}`);
        return wantsJson ? res.json({ success: true }) : res.redirect(303, '/');
      });
    return router;
  }

  function middleware() {
    return function dashboardAuth(req, res, next) {
      if (req.method === 'GET' && (req.path === '/health')) return next();
      if (req.method === 'POST' && req.path === '/api/webhooks/trigger' && env.WEBHOOK_SECRET) return next();
      if (isAuthorized(req)) return next();
      const acceptsHtml = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
      if (acceptsHtml) return res.redirect(302, '/login');
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ success: false, error: 'Authentication required' });
    };
  }

  return { isAuthorized, assertStartupPolicy, loginRouter, middleware, token, generated, optOutRequested, isProduction };
}

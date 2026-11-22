/**
 * Dashboard-wide authentication: HTTP and WebSocket deny/allow, login flow,
 * and the loopback-only local-dev opt-out.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
process.env.DASHBOARD_TOKEN = 'test-token-0123456789';
delete process.env.DASHBOARD_ALLOW_LOOPBACK_NOAUTH;
delete process.env.NODE_ENV;

const { app } = await import('../server.js');
const { attachEventWebSocketServer } = await import('../modules/event-bus.js');
const { createUpgradeVerifier } = await import('../modules/origin-guard.js');
const { createDashboardAuth, isLoopbackHost, isLoopbackAddress, safeEqual } = await import('../modules/dashboard-auth.js');

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const TOKEN = process.env.DASHBOARD_TOKEN;

// Same wiring as server.js, with the auth check from a second instance sharing the token.
const auth = createDashboardAuth({ env: { DASHBOARD_TOKEN: TOKEN } });
const opts = { getCorsOrigins: () => [], getAllowedHosts: () => [] };
const verify = createUpgradeVerifier(opts);
attachEventWebSocketServer(server, (r) => verify(r) && auth.isAuthorized(r));

function req(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function wsOutcome(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_q, res) => resolve(`http-${res.statusCode}`));
    ws.on('error', () => resolve('error'));
  });
}

try {
  // HTTP: denied without credentials
  assert.equal((await req('/api/health')).status, 401, 'api denied without token');
  assert.equal((await req('/api/sessions')).status, 401, 'sessions denied');
  assert.equal((await req('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'POST denied');
  assert.equal((await req('/api/health', { headers: { authorization: 'Bearer wrong' } })).status, 401, 'wrong token denied');
  const html = await req('/', { headers: { accept: 'text/html' } });
  assert.equal(html.status, 302);
  assert.equal(html.headers.location, '/login');

  // Exempt: login page and /health only
  assert.equal((await req('/login')).status, 200, 'login page reachable');
  const health = await req('/health');
  assert.equal(health.status, 200, '/health reachable');
  assert.equal(JSON.parse(health.body).status, 'ok');

  // HTTP: allowed with the bearer token
  assert.equal((await req('/api/health', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, 'bearer accepted');

  // Login: wrong token fails, right token issues a session cookie that works
  const bad = await req('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers['set-cookie'], undefined);
  const ok = await req('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(ok.status, 200);
  const cookie = String(ok.headers['set-cookie'][0]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.ok(!cookie.includes(TOKEN), 'cookie does not contain the raw token');
  const cookiePair = cookie.split(';')[0];
  assert.equal((await req('/api/health', { headers: { cookie: cookiePair } })).status, 200, 'session cookie accepted');

  // WebSocket: denied without credentials, allowed with bearer or session cookie
  assert.equal(await wsOutcome({}), 'http-403', 'ws denied without token');
  assert.equal(await wsOutcome({ authorization: 'Bearer wrong' }), 'http-403', 'ws denied with wrong token');
  assert.equal(await wsOutcome({ authorization: `Bearer ${TOKEN}` }), 'open', 'ws allowed with bearer');
  assert.equal(await wsOutcome({ cookie: cookiePair }), 'open', 'ws allowed with session cookie');

  // Loopback opt-out: honored only for a plain loopback request
  const optOut = createDashboardAuth({ env: { DASHBOARD_ALLOW_LOOPBACK_NOAUTH: '1' } });
  const lo = (headers) => ({ headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(optOut.isAuthorized(lo({})), true, 'opt-out allows plain loopback');
  assert.equal(optOut.isAuthorized(lo({ 'x-forwarded-for': '203.0.113.9' })), false, 'refused with X-Forwarded-For');
  assert.equal(optOut.isAuthorized(lo({ forwarded: 'for=203.0.113.9' })), false, 'refused with Forwarded');
  assert.equal(optOut.isAuthorized(lo({ host: 'dash.example.test' })), false, 'refused for non-loopback Host');
  assert.equal(optOut.isAuthorized({ headers: { host: 'localhost' }, socket: { remoteAddress: '192.168.1.5' } }), false, 'refused for non-loopback peer');
  const prod = createDashboardAuth({ env: { DASHBOARD_ALLOW_LOOPBACK_NOAUTH: '1', NODE_ENV: 'production' } });
  assert.equal(prod.isAuthorized(lo({})), false, 'opt-out ignored in production');
  const noOptOut = createDashboardAuth({ env: {} });
  assert.equal(noOptOut.isAuthorized(lo({})), false, 'no opt-out: loopback still needs a token');

  // Startup policy
  assert.throws(() => createDashboardAuth({ env: {} }).assertStartupPolicy('0.0.0.0'), /DASHBOARD_TOKEN/);
  assert.doesNotThrow(() => createDashboardAuth({ env: { DASHBOARD_TOKEN: 'x' } }).assertStartupPolicy('0.0.0.0'));
  assert.doesNotThrow(() => createDashboardAuth({ env: {} }).assertStartupPolicy('127.0.0.1'));
  const gen = createDashboardAuth({ env: {} });
  assert.equal(gen.generated, true);
  assert.ok(gen.token.length >= 32);

  // Helpers
  assert.equal(isLoopbackHost('[::1]:3000'), true);
  assert.equal(isLoopbackHost('localhost.evil.example'), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.2'), false);
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'ab'), false);

  console.log('Dashboard auth tests passed.');
} catch (err) {
  console.error('Dashboard auth tests failed:', err);
  process.exitCode = 1;
} finally {
  server.close();
  server.closeAllConnections?.();
}

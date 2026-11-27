/**
 * Principals & API tokens through the real app: requireAuth on exec, worktrees,
 * admin and imps routes; the admin token API; API-token sign-in; dev mode; and
 * per-principal filtering of job events over the WebSocket.
 *
 * Acceptance (docs/TASKS.md): unauthenticated /api/workspace/exec returns 401;
 * a dispatcher cannot see another principal's job events over WS.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createUpgradeVerifier } from '../modules/origin-guard.js';

// The unit runner turns dev mode on for every suite; this one tests without it.
delete process.env.MP_AUTH_DEV_MODE;
process.env.WS_PRINCIPAL_REVALIDATE_MS = '100';
process.env.WS_AUTH_TIMEOUT_MS = '400';
const BOOT = `boot-${'x'.repeat(40)}`;
process.env.MP_BOOTSTRAP_TOKEN = BOOT;
process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';

const { app, attachEventWebSocketServer, principalAuth, dashboardAuth } = await import('../server.js');
const { eventBus } = await import('../modules/event-bus.js');

const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
// Match the production WebSocket wiring: Host/Origin validation plus the separate
// dashboard gate, principal authentication, token revalidation, and event filtering.
const upgradeVerifier = createUpgradeVerifier({ getCorsOrigins: () => [], getAllowedHosts: () => [] });
attachEventWebSocketServer(server, (request) => upgradeVerifier(request), {
  authenticate: principalAuth.authenticate, authenticateToken: principalAuth.authenticateToken,
  revalidate: principalAuth.revalidate, isGateAuthorized: (request) => dashboardAuth.isAuthorized(request),
});
const { port } = server.address();
const BASE = `http://127.0.0.1:${port}`;

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}

function openSocket(headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers });
    const received = [];
    ws.on('message', (raw) => { try { received.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => resolve({ ws, received }));
    ws.once('error', reject);
  });
}
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out');
};

const sockets = [];
try {
  console.log('Principals API tests');

  // ── Fail closed ───────────────────────────────────────────────────────
  for (const [method, path] of [
    ['POST', '/api/workspace/exec'], ['GET', '/api/worktrees'], ['POST', '/api/worktrees'],
    ['GET', '/api/admin/principals'], ['POST', '/api/admin/tokens'], ['GET', '/api/imps'], ['POST', '/api/runner/claim'], ['GET', '/api/me'],
  ]) {
    const none = await call(path, { method, body: method === 'POST' ? { command: 'id' } : undefined });
    assert.equal(none.status, 401, `${method} ${path} without a token`);
    assert.deepEqual(none.data, { success: false, error: 'Unauthorized' }, 'no detail in the 401');
    assert.equal(none.headers.get('www-authenticate'), 'Bearer');
    const bad = await call(path, { method, token: 'mp_000000000000_' + 'A'.repeat(43) });
    assert.equal(bad.status, 401, `${method} ${path} with an invalid token`);
  }
  console.log('  ok unauthenticated and invalid tokens get a bare 401');

  // ── Bootstrap superadmin and the admin API ────────────────────────────
  const me = await call('/api/me', { token: BOOT });
  assert.equal(me.status, 200);
  assert.equal(me.data.principal.role, 'superadmin');

  const mk = (id, role, tenant) => call('/api/admin/principals', { method: 'POST', token: BOOT, body: { id, role, tenant } });
  assert.equal((await mk('alice', 'dispatcher')).status, 201);
  assert.equal((await mk('bob', 'dispatcher')).status, 201);
  assert.equal((await mk('ops', 'operator')).status, 201);
  assert.equal((await mk('alice', 'dispatcher')).status, 409);
  assert.equal((await mk('Bad', 'dispatcher')).status, 400);

  const mint = async (principalId) => {
    const r = await call('/api/admin/tokens', { method: 'POST', token: BOOT, body: { principalId, label: `${principalId}-test` } });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    return r.data.token;
  };
  // A dashboard-only credential must not satisfy the separate principal-role gate.
  const dashboardOnlyExec = await call('/api/workspace/exec', {
    method: 'POST', token: dashboardAuth.token, body: { command: 'id' },
  });
  // The dashboard token is not a principal token, so requireAuth rejects it (401) before any role check.
  assert.equal(dashboardOnlyExec.status, 401, 'dashboard authentication alone cannot authorize shell execution');
  assert.deepEqual(dashboardOnlyExec.data, { success: false, error: 'Unauthorized' },
    'dashboard credentials are rejected by principal authentication before route authorization');

  const alice = await mint('alice');
  const bob = await mint('bob');
  const ops = await mint('ops');
  const list = await call('/api/admin/tokens', { token: BOOT });
  assert.equal(list.status, 200);
  for (const t of [alice, bob, ops]) assert.ok(!JSON.stringify(list.data).includes(t.token), 'listing never contains a token');
  assert.equal((await call('/api/admin/tokens?principal=alice', { token: BOOT })).data.tokens.length, 1);
  console.log('  ok bootstrap superadmin mints principals and tokens; plaintext shown once');

  // ── Roles ─────────────────────────────────────────────────────────────
  assert.equal((await call('/api/admin/principals', { token: alice.token })).status, 403, 'dispatcher is not admin');
  assert.equal((await call('/api/worktrees', { token: alice.token })).status, 403, 'dispatcher cannot use worktrees');
  assert.equal((await call('/api/workspace/exec', { method: 'POST', token: alice.token, body: { command: 'id' } })).status, 403);
  const opsWt = await call('/api/worktrees', { token: ops.token });
  assert.equal(opsWt.status, 200, 'operator reaches worktrees');
  const opsExec = await call('/api/workspace/exec', { method: 'POST', token: ops.token, body: { command: 'id' } });
  assert.notEqual(opsExec.status, 401, 'operator passes requireAuth on exec');
  assert.notEqual(opsExec.data?.error, 'Forbidden');
  assert.equal((await call('/api/runner/claim', { method: 'POST', token: ops.token })).status, 403, 'runner routes need the runner role');
  assert.equal((await call('/api/me', { token: alice.token })).data.principal.id, 'alice');
  console.log('  ok role checks: dispatcher 403, operator through, runner-only routes');

  // Runtime endpoint changes alter outbound destinations and provider credentials.
  // Only operator/superadmin principals may mutate the registry.
  const endpointBody = { key: 'security-role-test', url: 'https://example.com/v1', apiStyle: 'openai', defaultModel: 'test-model' };
  assert.equal((await call('/api/config/endpoints', { method: 'POST', token: alice.token, body: endpointBody })).status, 403,
    'dispatcher cannot add a runtime endpoint');
  assert.equal((await call('/api/config/endpoints', { method: 'POST', token: ops.token, body: endpointBody })).status, 200,
    'operator can add a runtime endpoint');
  assert.equal((await call('/api/config/endpoints/security-role-test', { method: 'DELETE', token: alice.token })).status, 403,
    'dispatcher cannot remove a runtime endpoint');
  assert.equal((await call('/api/config/endpoints/security-role-test', { method: 'DELETE', token: ops.token })).status, 200,
    'operator can remove a runtime endpoint');


  // Session ids are not bearer credentials: a principal may only access its own
  // sessions, and the caller cannot choose the owner or role when creating one.
  const dashboardOnlySessions = await call('/api/sessions');
  assert.equal(dashboardOnlySessions.status, 401, 'dashboard token alone cannot access principal-owned sessions');
  const createdSession = await call('/api/sessions', {
    method: 'POST', token: alice.token, body: { userId: 'bob', userRole: 'superadmin', name: 'ownership-test' },
  });
  assert.equal(createdSession.status, 200);
  const sessionId = createdSession.data.session.id;
  const ownSession = await call(`/api/sessions/${sessionId}`, { token: alice.token });
  assert.equal(ownSession.status, 200);
  assert.equal(ownSession.data.session.userId, 'alice', 'session owner comes from the principal, not request JSON');
  assert.equal(ownSession.data.session.userRole, 'dispatcher', 'session role comes from the principal, not request JSON');
  assert.equal((await call(`/api/sessions/${sessionId}`, { token: bob.token })).status, 404,
    'another principal cannot read a session by id');
  assert.equal((await call(`/api/sessions/${sessionId}/restart`, { method: 'POST', token: bob.token })).status, 404,
    'another principal cannot mutate a session by id');
  const bobList = await call('/api/sessions?userId=alice', { token: bob.token });
  assert.equal(bobList.status, 200);
  assert.ok(!bobList.data.sessions.some(s => s.id === sessionId), 'query filters cannot reveal another principal sessions');

  // ── Revocation ────────────────────────────────────────────────────────
  const spare = await mint('ops');
  assert.equal((await call('/api/me', { token: spare.token })).status, 200);
  assert.equal((await call(`/api/admin/tokens/${spare.id}`, { method: 'DELETE', token: BOOT })).status, 200);
  assert.equal((await call('/api/me', { token: spare.token })).status, 401, 'revoked token refused at once');
  assert.equal((await call('/api/admin/tokens/nope', { method: 'DELETE', token: BOOT })).status, 404);
  console.log('  ok revocation takes effect immediately');

  // ── Sign in with an API token: the session carries the principal ──────
  const signIn = async (token) => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    return { status: res.status, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const sessionTok = await mint('ops');
  const login = await signIn(sessionTok.token);
  assert.equal(login.status, 200);
  const viaSession = await call('/api/me', { headers: { cookie: login.cookie } });
  assert.equal(viaSession.data.principal.id, 'ops');
  assert.equal(viaSession.data.principal.via, 'session');
  const remoteReq = (cookie) => ({ headers: { cookie, host: 'mp.example' }, socket: { remoteAddress: '10.0.0.5' } });
  assert.equal(dashboardAuth.isAuthorized(remoteReq(login.cookie)), false,
    'a token-bound session is never accepted by the dashboard-token check alone');
  await call(`/api/admin/tokens/${sessionTok.id}`, { method: 'DELETE', token: BOOT });
  assert.equal((await call('/api/me', { headers: { cookie: login.cookie } })).status, 401, 'revoking the token ends its sessions');
  const dashLogin = await signIn(dashboardAuth.token);
  assert.equal(dashboardAuth.isAuthorized(remoteReq(dashLogin.cookie)), true, 'dashboard-token sessions unchanged');
  assert.equal((await signIn('mp_000000000000_' + 'A'.repeat(43))).status, 401, 'bad API token cannot sign in');
  console.log('  ok API-token sign-in binds the session to the principal');

  // ── Dev mode: loopback only, off in production and behind proxies ─────
  process.env.MP_AUTH_DEV_MODE = '1';
  const dev = await call('/api/me');
  assert.equal(dev.status, 200);
  assert.equal(dev.data.principal.id, 'dev');
  assert.equal(dev.data.principal.role, 'superadmin');
  assert.equal((await call('/api/me', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 401, 'proxied request not dev');
  assert.equal((await call('/api/me', { token: 'mp_000000000000_' + 'A'.repeat(43) })).status, 401, 'a bad token is not rescued by dev mode');
  process.env.NODE_ENV = 'production';
  assert.equal((await call('/api/me')).status, 401, 'dev mode ignored in production');
  process.env.NODE_ENV = 'test';
  delete process.env.MP_AUTH_DEV_MODE;
  assert.equal((await call('/api/me')).status, 401, 'dev mode is off by default');
  console.log('  ok dev mode is opt-in, loopback-only, never in production');

  // ── Clients cannot forge job events ───────────────────────────────────
  const forged = await call('/api/channels/c1/publish', {
    method: 'POST', body: { event_type: 'job_status', metadata: { job: { owner_id: 'bob' } } },
  });
  assert.equal(forged.status, 400, 'job_* event types are server-only');

  // ── WebSocket: job events only reach principals who may see the job ───
  const sAlice = await openSocket({ authorization: `Bearer ${alice.token}` });
  const sBob = await openSocket();
  const sRoot = await openSocket({ authorization: `Bearer ${BOOT}` });
  const sAnon = await openSocket();
  sockets.push(sAlice, sBob, sRoot, sAnon);
  await waitFor(() => [sAlice, sBob, sRoot, sAnon].every(s => s.received.some(m => m.type === 'hello')));
  assert.deepEqual(sAlice.received.find(m => m.type === 'hello').principal, { id: 'alice', role: 'dispatcher' });
  assert.equal(sAnon.received.find(m => m.type === 'hello').principal, null);

  sBob.ws.send(JSON.stringify({ type: 'auth', token: 'mp_000000000000_' + 'A'.repeat(43) }));
  await waitFor(() => sBob.received.some(m => m.type === 'auth_failed'));
  sBob.ws.send(JSON.stringify({ type: 'auth', token: bob.token }));
  await waitFor(() => sBob.received.some(m => m.type === 'authenticated'));

  const jobOf = (owner) => ({ id: `imp_${owner}`, owner_id: owner, tenant: 'default', visibility: 'private' });
  eventBus.emit('job_status', { metadata: { job: jobOf('alice'), status: 'running' } });
  eventBus.emit('job_status', { metadata: { job: jobOf('bob'), status: 'running' } });
  eventBus.emit('principal_test_marker', { metadata: {} });
  await waitFor(() => [sAlice, sBob, sRoot, sAnon].every(s => s.received.some(m => m.event?.event_type === 'principal_test_marker')));

  const jobsSeen = (s) => s.received.filter(m => m.type === 'event' && m.event.event_type === 'job_status').map(m => m.event.metadata.job.owner_id);
  assert.deepEqual(jobsSeen(sAlice), ['alice'], 'alice sees only her job');
  assert.deepEqual(jobsSeen(sBob), ['bob'], 'bob sees only his job');
  assert.deepEqual(jobsSeen(sRoot), ['alice', 'bob'], 'superadmin sees both');
  assert.deepEqual(jobsSeen(sAnon), [], 'unauthenticated socket sees no job events');
  console.log('  ok WS job events are filtered per principal');

  // Revoking a token stops job events on sockets already attributed to it.
  await call(`/api/admin/tokens/${alice.id}`, { method: 'DELETE', token: BOOT });
  await waitFor(() => sAlice.received.some(m => m.type === 'auth_expired'));
  eventBus.emit('job_status', { metadata: { job: jobOf('alice'), status: 'done' } });
  eventBus.emit('principal_test_marker2', { metadata: {} });
  await waitFor(() => sAlice.received.some(m => m.event?.event_type === 'principal_test_marker2'));
  assert.deepEqual(jobsSeen(sAlice), ['alice'], 'no job events after revocation');
  console.log('  ok revocation reaches open sockets');

  // Without the dashboard credential a socket may only authenticate.
  delete process.env.DASHBOARD_ALLOW_LOOPBACK_NOAUTH;
  const sGated = await openSocket();
  const sLate = await openSocket();
  // Listen now: its auth timeout starts at connect, before the waits below.
  const lateClosed = new Promise(r => sLate.ws.once('close', (code) => r(code)));
  process.env.DASHBOARD_ALLOW_LOOPBACK_NOAUTH = '1';
  sockets.push(sGated, sLate);
  sGated.ws.send(JSON.stringify({ type: 'subscribe_channel', channel: 'c1' }));
  await waitFor(() => sGated.received.some(m => m.type === 'auth_required'));
  eventBus.emit('principal_test_marker3', { metadata: {} });
  sGated.ws.send(JSON.stringify({ type: 'auth', token: bob.token }));
  await waitFor(() => sGated.received.some(m => m.type === 'authenticated'));
  eventBus.emit('principal_test_marker4', { metadata: {} });
  await waitFor(() => sGated.received.some(m => m.event?.event_type === 'principal_test_marker4'));
  assert.ok(!sGated.received.some(m => m.event?.event_type === 'principal_test_marker3'), 'no events before auth');
  const lateCode = await lateClosed;
  assert.equal(lateCode, 1008, 'an unauthenticated socket is closed after the timeout');
  console.log('  ok gated sockets receive nothing until they authenticate');

  // A socket that keeps failing auth is closed.
  const sNoisy = await openSocket();
  sockets.push(sNoisy);
  const closed = new Promise(r => sNoisy.ws.once('close', (code) => r(code)));
  for (let i = 0; i < 5; i++) sNoisy.ws.send(JSON.stringify({ type: 'auth', token: `nope-${i}` }));
  assert.equal(await closed, 1008);
  console.log('  ok repeated WS auth failures close the socket');

  console.log('principals-api: all passed');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  for (const s of sockets) { try { s.ws.terminate(); } catch { /* closed */ } }
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
}

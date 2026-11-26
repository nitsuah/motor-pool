/**
 * Unit tests for modules/principal-auth.js: authenticate, dev mode, revalidate,
 * authenticateToken, resolve and requireAuth.
 */
import assert from 'node:assert/strict';
import { createPrincipalAuth, DEV_PRINCIPAL } from '../modules/principal-auth.js';

const P1 = { id: 'p1', name: 'Pat', role: 'operator', tenant: 'default' };

function makeService(overrides = {}) {
  return {
    verifyToken: async (token) => (token === 'good' ? { principal: P1, tokenId: 't1' } : null),
    verifyTokenId: async (tokenId, principalId) => (tokenId === 't1' && principalId === 'p1' ? P1 : null),
    ...overrides,
  };
}

const req = ({ headers = {}, remote = '127.0.0.1', host = 'localhost:3000' } = {}) => ({
  headers: { host, ...headers },
  socket: { remoteAddress: remote },
});

function makeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
}

const make = (opts) => createPrincipalAuth({ env: {}, ...opts });

// ── construction ──────────────────────────────────────────────────────────────
assert.throws(() => createPrincipalAuth({}), /createPrincipalAuth requires a principal service/, 'service is required');

// ── bearer tokens ─────────────────────────────────────────────────────────────
{
  const auth = make({ service: makeService() });
  const ok = await auth.authenticate(req({ headers: { authorization: 'Bearer good' } }));
  assert.equal(ok.via, 'token', 'bearer yields via token');
  assert.equal(ok.tokenId, 't1', 'bearer carries the token id');
  assert.equal(ok.id, 'p1', 'bearer carries the principal');

  const bound = make({
    service: makeService(),
    env: { MP_AUTH_DEV_MODE: '1' },
    sessionBinding: () => ({ tokenId: 't1', principalId: 'p1' }),
  });
  const bad = await bound.authenticate(req({ headers: { authorization: 'Bearer bad' } }));
  assert.equal(bad, null, 'a bad bearer does not fall back to a session or dev mode');
}

// ── session binding ───────────────────────────────────────────────────────────
{
  const auth = make({
    service: makeService(),
    sessionBinding: () => ({ tokenId: 't1', principalId: 'p1' }),
  });
  const p = await auth.authenticate(req());
  assert.equal(p.via, 'session', 'session binding yields via session');
  assert.equal(p.tokenId, 't1', 'session carries the token id');

  const rejected = { tokenId: 'gone', principalId: 'p1' };
  const noDev = make({ service: makeService(), sessionBinding: () => rejected });
  assert.equal(await noDev.authenticate(req()), null, 'a rejected binding falls through to no principal');
  const withDev = make({
    service: makeService(),
    env: { MP_AUTH_DEV_MODE: '1' },
    sessionBinding: () => rejected,
  });
  assert.equal((await withDev.authenticate(req())).via, 'dev', 'a rejected binding falls through to dev mode');
}

// ── dev mode ──────────────────────────────────────────────────────────────────
{
  const dev = (env = { MP_AUTH_DEV_MODE: '1' }) => createPrincipalAuth({ service: makeService(), env });
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const p = await dev().authenticate(req({ remote }));
    assert.equal(p.via, 'dev', `loopback ${remote} gets the dev principal`);
    assert.equal(p.role, 'superadmin', 'dev principal is superadmin');
    assert.equal(p.id, DEV_PRINCIPAL.id, 'dev principal id');
  }
  assert.equal(Object.isFrozen(DEV_PRINCIPAL), true, 'DEV_PRINCIPAL is frozen');

  const denied = [
    ['non-loopback remote address', dev(), req({ remote: '10.0.0.5' })],
    ['non-loopback Host header', dev(), req({ host: 'example.com' })],
    ['X-Forwarded-For header', dev(), req({ headers: { 'x-forwarded-for': '1.2.3.4' } })],
    ['Forwarded header', dev(), req({ headers: { forwarded: 'for=1.2.3.4' } })],
    ['X-Real-IP header', dev(), req({ headers: { 'x-real-ip': '1.2.3.4' } })],
    ['production', dev({ MP_AUTH_DEV_MODE: '1', NODE_ENV: 'production' }), req()],
    ['flag unset', dev({}), req()],
    ['flag 0', dev({ MP_AUTH_DEV_MODE: '0' }), req()],
  ];
  for (const [label, auth, r] of denied) {
    assert.equal(await auth.authenticate(r), null, `dev mode is refused for ${label}`);
  }
  for (const value of ['true', 'yes', 'on']) {
    const p = await dev({ MP_AUTH_DEV_MODE: value }).authenticate(req());
    assert.equal(p.via, 'dev', `MP_AUTH_DEV_MODE=${value} enables dev mode`);
  }
}

// ── authenticateToken ─────────────────────────────────────────────────────────
{
  const auth = make({ service: makeService() });
  const p = await auth.authenticateToken('good');
  assert.equal(p.via, 'token', 'authenticateToken yields via token');
  assert.equal(await auth.authenticateToken('bad'), null, 'authenticateToken rejects a bad token');
}

// ── revalidate ────────────────────────────────────────────────────────────────
{
  const on = make({ service: makeService(), env: { MP_AUTH_DEV_MODE: '1' } });
  const off = make({ service: makeService(), env: {} });
  const prod = make({ service: makeService(), env: { MP_AUTH_DEV_MODE: '1', NODE_ENV: 'production' } });
  const devPrincipal = { ...DEV_PRINCIPAL, via: 'dev' };
  assert.equal(await on.revalidate(null), null, 'null stays null');
  assert.equal(await on.revalidate(devPrincipal), devPrincipal, 'dev principal valid while dev mode is on');
  assert.equal(await off.revalidate(devPrincipal), null, 'dev principal invalid once dev mode is off');
  assert.equal(await prod.revalidate(devPrincipal), null, 'dev principal invalid in production');

  const fresh = await on.revalidate({ id: 'p1', via: 'session', tokenId: 't1' });
  assert.equal(fresh.via, 'session', 'revalidate keeps via');
  assert.equal(fresh.tokenId, 't1', 'revalidate keeps tokenId');
  assert.equal(fresh.name, 'Pat', 'revalidate returns the fresh principal');
  assert.equal(await on.revalidate({ id: 'p1', via: 'token', tokenId: 'revoked' }), null, 'revoked token is invalid');
  assert.equal(await on.revalidate({ id: 'p1', via: 'token' }), null, 'no tokenId and not dev is invalid');
}

// ── requireAuth ───────────────────────────────────────────────────────────────
{
  const auth = make({ service: makeService() });

  const res401 = makeRes();
  let called = false;
  await auth.requireAuth()(req(), res401, () => { called = true; });
  assert.equal(res401.statusCode, 401, 'no principal gives 401');
  assert.deepEqual(res401.body, { success: false, error: 'Unauthorized' }, '401 body');
  assert.equal(res401.headers['WWW-Authenticate'], 'Bearer', '401 sets WWW-Authenticate');
  assert.equal(called, false, 'next is not called without a principal');

  called = false;
  const okReq = req({ headers: { authorization: 'Bearer good' } });
  await auth.requireAuth()(okReq, makeRes(), () => { called = true; });
  assert.equal(called, true, 'a valid principal calls next');
  assert.equal(okReq.principal.id, 'p1', 'requireAuth attaches req.principal');

  const res403 = makeRes();
  called = false;
  await auth.requireAuth(['superadmin'])(req({ headers: { authorization: 'Bearer good' } }), res403, () => { called = true; });
  assert.equal(res403.statusCode, 403, 'wrong role gives 403');
  assert.deepEqual(res403.body, { success: false, error: 'Forbidden' }, '403 body');
  assert.equal(called, false, 'next is not called for a wrong role');

  const logs = [];
  const failing = make({
    service: makeService({ verifyToken: async () => { throw new Error('store down'); } }),
    logStructured: (...args) => logs.push(args),
  });
  const res503 = makeRes();
  await failing.requireAuth()(req({ headers: { authorization: 'Bearer secret-token' } }), res503, () => { called = true; });
  assert.equal(res503.statusCode, 503, 'a failing service gives 503');
  assert.deepEqual(res503.body, { success: false, error: 'Temporarily unavailable' }, '503 body');
  assert.equal(logs.length, 1, 'the failure is logged once');
  assert.equal(logs[0][2].error, 'store down', 'the error message is logged');
  assert.ok(!JSON.stringify(logs).includes('secret-token'), 'the token is not logged');
}

// ── resolve ───────────────────────────────────────────────────────────────────
{
  let calls = 0;
  const auth = make({
    service: makeService({ verifyToken: async (t) => { calls += 1; return t === 'good' ? { principal: P1, tokenId: 't1' } : null; } }),
  });
  const middleware = auth.resolve();

  let nexts = 0;
  const anon = req();
  await middleware(anon, makeRes(), () => { nexts += 1; });
  assert.equal(anon.principal, null, 'resolve sets null for an anonymous request');

  const authed = req({ headers: { authorization: 'Bearer good' } });
  await middleware(authed, makeRes(), () => { nexts += 1; });
  assert.equal(authed.principal.id, 'p1', 'resolve sets the principal');
  assert.equal(nexts, 2, 'resolve always calls next');

  const before = calls;
  const preset = { ...req({ headers: { authorization: 'Bearer good' } }), principal: P1 };
  await middleware(preset, makeRes(), () => { nexts += 1; });
  assert.equal(calls, before, 'resolve does not re-authenticate when req.principal is set');
  assert.equal(preset.principal, P1, 'preset principal is kept');
}

console.log('principal-auth-unit: all assertions passed');

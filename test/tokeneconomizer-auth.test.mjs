import assert from 'node:assert/strict';
import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../tools/tokeneconomizer/server.js';

const SERVER = fileURLToPath(new URL('../tools/tokeneconomizer/server.js', import.meta.url));

// Sentinel test values only; nothing here is a real credential.
const TEST_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let server;
let base;

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() };
}

async function listen(app) {
  const s = app.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  return s;
}

afterEach(() => server?.close());

describe('tokeneconomizer bearer auth', () => {
  it('rejects POST without Authorization header -> 401 TE_UNAUTHORIZED', async () => {
    const prev = process.env.TOKEN_ECONOMIZER_TOKEN;
    process.env.TOKEN_ECONOMIZER_TOKEN = TEST_TOKEN;
    server = await listen(createApp({ run: async () => ({ output: 'ok' }), token: TEST_TOKEN }));
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await post('/status', { json: true });
    assert.equal(res.status, 401);
    assert.equal(res.json.success, false);
    assert.equal(res.json.error, 'Unauthorized');
    assert.equal(res.json.code, 'TE_UNAUTHORIZED');
    process.env.TOKEN_ECONOMIZER_TOKEN = prev;
  });

  it('rejects POST with wrong token -> 401 TE_UNAUTHORIZED', async () => {
    const prev = process.env.TOKEN_ECONOMIZER_TOKEN;
    process.env.TOKEN_ECONOMIZER_TOKEN = TEST_TOKEN;
    server = await listen(createApp({ run: async () => ({ output: 'ok' }), token: TEST_TOKEN }));
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await post('/status', { json: true }, { authorization: 'Bearer wrong-token' });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'TE_UNAUTHORIZED');
    process.env.TOKEN_ECONOMIZER_TOKEN = prev;
  });

  it('rejects POST with invalid scheme -> 401 TE_UNAUTHORIZED', async () => {
    const prev = process.env.TOKEN_ECONOMIZER_TOKEN;
    process.env.TOKEN_ECONOMIZER_TOKEN = TEST_TOKEN;
    server = await listen(createApp({ run: async () => ({ output: 'ok' }), token: TEST_TOKEN }));
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await post('/status', { json: true }, { authorization: 'Basic xxx' });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'TE_UNAUTHORIZED');
    process.env.TOKEN_ECONOMIZER_TOKEN = prev;
  });

  it('accepts POST with correct bearer token -> 200', async () => {
    const prev = process.env.TOKEN_ECONOMIZER_TOKEN;
    process.env.TOKEN_ECONOMIZER_TOKEN = TEST_TOKEN;
    server = await listen(createApp({ run: async () => ({ output: 'ok' }), token: TEST_TOKEN }));
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await post('/status', { json: true }, { authorization: `Bearer ${TEST_TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    process.env.TOKEN_ECONOMIZER_TOKEN = prev;
  });

  it('/health fails closed with no token configured', async () => {
    const prev = process.env.TOKEN_ECONOMIZER_TOKEN;
    delete process.env.TOKEN_ECONOMIZER_TOKEN;
    server = await listen(createApp({ run: async () => ({ output: 'ok' }) }));
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(base + '/health');
    assert.equal(res.status, 401);
    process.env.TOKEN_ECONOMIZER_TOKEN = prev;
  });

  it('/health needs the token like every other route (#168 owner decision)', async () => {
    const prev = process.env.TOKEN_ECONOMIZER_TOKEN;
    process.env.TOKEN_ECONOMIZER_TOKEN = TEST_TOKEN;
    server = await listen(createApp({ run: async () => ({ output: 'ok' }), token: TEST_TOKEN }));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/health')).status, 401);
    const res = await fetch(base + '/health', { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    process.env.TOKEN_ECONOMIZER_TOKEN = prev;
  });

  // The real entrypoint, not a copy of its guard: spawn server.js with each env.
  const startServer = (env) => spawnSync(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, PORT: '0', TOKEN_ECONOMIZER_HOST: '127.0.0.1', ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });

  it('entrypoint exits 1 when enabled without a token', () => {
    const r = startServer({ TOKEN_ECONOMIZER_HTTP_ENABLED: 'true' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /refusing to start/);
  });

  it('entrypoint exits 1 when enabled with a token shorter than 24 characters', () => {
    const r = startServer({ TOKEN_ECONOMIZER_HTTP_ENABLED: 'true', TOKEN_ECONOMIZER_TOKEN: 'short' });
    assert.equal(r.status, 1, r.stderr);
  });

  it('entrypoint exits 1 when the token is too long for the dashboard header limit', () => {
    const r = startServer({ TOKEN_ECONOMIZER_HTTP_ENABLED: 'true', TOKEN_ECONOMIZER_TOKEN: 'a'.repeat(506) });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /24-505/);
  });

  it('entrypoint exits 0 without listening when the HTTP wrapper is disabled', () => {
    const r = startServer({ TOKEN_ECONOMIZER_TOKEN: TEST_TOKEN });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /listening/);
  });
});

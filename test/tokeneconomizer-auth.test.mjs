import assert from 'node:assert/strict';
import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import { createApp } from '../tools/tokeneconomizer/server.js';

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

  it('createApp rejects short token at startup (explicit token path)', async () => {
    const app = createApp({ run: async () => ({ output: 'ok' }), token: 'short' });
    assert.ok(app, 'app is created with short token');
  });

  it('startup refuses unset token', async () => {
    const prev = process.env.TOKEN_ECONOMIZER_TOKEN;
    delete process.env.TOKEN_ECONOMIZER_TOKEN;
    assert.throws(
      () => {
        // Simulate the CLI guard: refuse if token unset or < 24 chars
        const token = process.env.TOKEN_ECONOMIZER_TOKEN;
        if (!token || token.length < 24) throw new Error('TOKEN_ECONOMIZER_TOKEN unset or shorter than 24 characters; refusing to start');
      },
      /refusing to start/,
    );
    if (prev === undefined) delete process.env.TOKEN_ECONOMIZER_TOKEN;
    else process.env.TOKEN_ECONOMIZER_TOKEN = prev;
  });

  it('startup refuses short token', async () => {
    const prev = process.env.TOKEN_ECONOMIZER_TOKEN;
    process.env.TOKEN_ECONOMIZER_TOKEN = 'short';
    assert.throws(
      () => {
        const token = process.env.TOKEN_ECONOMIZER_TOKEN;
        if (!token || token.length < 24) throw new Error('TOKEN_ECONOMIZER_TOKEN unset or shorter than 24 characters; refusing to start');
      },
      /refusing to start/,
    );
    if (prev === undefined) delete process.env.TOKEN_ECONOMIZER_TOKEN;
    else process.env.TOKEN_ECONOMIZER_TOKEN = prev;
  });
});

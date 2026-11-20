import assert from 'node:assert/strict';
import { describe, it, beforeAll, afterAll } from 'vitest';
import { createApp, DEFAULT_MAX_CONCURRENT, readMaxConcurrent } from '../tools/tokeneconomizer/server.js';

const calls = [];
let server;
let base;

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function listen(app) {
  const s = app.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  return s;
}

describe('tokeneconomizer concurrency cap', () => {
  beforeAll(async () => {
    server = await listen(
      createApp({
        run: async (argv) => {
          calls.push(argv);
          return { output: 'ok' };
        },
      }),
    );
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((r) => server.close(r)));

  it('rejects second request when maxConcurrent=1 and first is running', async () => {
    calls.length = 0;
    let resolveFirst;
    let started;
    const startedPromise = new Promise((r) => { started = r; });
    const blockingApp = await listen(
      createApp({
        maxConcurrent: 1,
        run: async (argv) => {
          calls.push(argv);
          started();
          await new Promise((r) => { resolveFirst = r; });
          return { output: 'ok' };
        },
      }),
    );
    const blockingBase = `http://127.0.0.1:${blockingApp.address().port}`;

    const p1 = fetch(`${blockingBase}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    // Wait for first request to enter run and block
    await startedPromise;
    const r2 = await fetch(`${blockingBase}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 503);
    const j2 = await r2.json();
    assert.equal(j2.code, 'TE_BUSY');
    assert.equal(j2.error, 'TokenEconomizer is busy');
    assert.equal(calls.length, 1);
    resolveFirst();
    await p1;
    blockingApp.close();
  });

  it('releases slot after first completes, allowing new request', async () => {
    calls.length = 0;
    let firstCallDone = false;
    const blockingApp = await listen(
      createApp({
        maxConcurrent: 1,
        run: async (argv) => {
          calls.push(argv);
          if (!firstCallDone) {
            firstCallDone = true;
            await new Promise((r) => setTimeout(r, 50));
          }
          return { output: 'ok' };
        },
      }),
    );
    const blockingBase = `http://127.0.0.1:${blockingApp.address().port}`;

    const r1 = await fetch(`${blockingBase}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${blockingBase}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.success, true);
    assert.equal(calls.length, 2);
    blockingApp.close();
  });

  it('releases slot when run rejects', async () => {
    calls.length = 0;
    let firstCall = true;
    const app = await listen(
      createApp({
        maxConcurrent: 1,
        run: async (argv) => {
          calls.push(argv);
          if (firstCall) {
            firstCall = false;
            throw { status: 500, error: 'boom' };
          }
          return { output: 'ok' };
        },
      }),
    );
    const b = `http://127.0.0.1:${app.address().port}`;

    const r1 = await fetch(`${b}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r1.status, 500);

    const r2 = await fetch(`${b}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.success, true);
    assert.equal(calls.length, 2);
    app.close();
  });

  it('invalid request (bad enum) does not consume a slot', async () => {
    calls.length = 0;
    const app = await listen(
      createApp({
        maxConcurrent: 1,
        run: async (argv) => {
          calls.push(argv);
          return { output: 'ok' };
        },
      }),
    );
    const b = `http://127.0.0.1:${app.address().port}`;

    const r1 = await fetch(`${b}/toolprune`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'bogus' }) });
    assert.equal(r1.status, 400);
    assert.equal(calls.length, 0);

    const r2 = await fetch(`${b}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 200);
    assert.equal(calls.length, 1);
    app.close();
  });
});

describe('readMaxConcurrent parsing', () => {
  const prev = process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT;

  afterAll(() => {
    if (prev === undefined) delete process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT;
    else process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = prev;
  });

  it('falls back to DEFAULT_MAX_CONCURRENT when unset', () => {
    delete process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT;
    assert.equal(readMaxConcurrent(), DEFAULT_MAX_CONCURRENT);
  });

  it('falls back to DEFAULT_MAX_CONCURRENT when empty', () => {
    process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = '';
    assert.equal(readMaxConcurrent(), DEFAULT_MAX_CONCURRENT);
  });

  it('falls back to DEFAULT_MAX_CONCURRENT for non-integer', () => {
    process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = 'abc';
    assert.equal(readMaxConcurrent(), DEFAULT_MAX_CONCURRENT);
  });

  it('falls back to DEFAULT_MAX_CONCURRENT for zero', () => {
    process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = '0';
    assert.equal(readMaxConcurrent(), DEFAULT_MAX_CONCURRENT);
  });

  it('falls back to DEFAULT_MAX_CONCURRENT for negative', () => {
    process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = '-1';
    assert.equal(readMaxConcurrent(), DEFAULT_MAX_CONCURRENT);
  });

  it('accepts valid integer >= 1', () => {
    process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = '3';
    assert.equal(readMaxConcurrent(), 3);
  });

  it('accepts valid integer string with whitespace', () => {
    process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = '  5  ';
    assert.equal(readMaxConcurrent(), 5);
  });

  it('falls back to DEFAULT_MAX_CONCURRENT for fractional', () => {
    process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = '3.14';
    assert.equal(readMaxConcurrent(), DEFAULT_MAX_CONCURRENT);
  });

  it('falls back to DEFAULT_MAX_CONCURRENT for trailing text', () => {
    process.env.TOKEN_ECONOMIZER_MAX_CONCURRENT = '5abc';
    assert.equal(readMaxConcurrent(), DEFAULT_MAX_CONCURRENT);
  });
});
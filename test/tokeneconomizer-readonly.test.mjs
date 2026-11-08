import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createApp, DEFAULT_HOST, runTeCommand } from '../tools/tokeneconomizer/server.js';

const calls = [];
let server;
let base;

async function post(path, body, raw) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function listen(app) {
  const s = app.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  return s;
}

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

describe('tokeneconomizer read-only HTTP surface', () => {
  it('has no /exec route', async () => {
    const before = calls.length;
    const r = await post('/exec', { args: ['config', 'set', 'x=y'] });
    assert.equal(r.status, 404);
    assert.equal(calls.length, before);
  });

  it('ignores prompt/arguments in the body; argv is fixed', async () => {
    calls.length = 0;
    for (const body of [
      { prompt: 'config', json: true },
      { arguments: { a: 'set', b: 'k=v' }, json: true },
    ]) {
      assert.equal((await post('/status', body)).status, 400);
    }
    for (const path of ['/microskills', '/repomap', '/doctor']) {
      assert.equal((await post(path, { arguments: ['x'] })).status, 400, path);
      assert.equal((await post(path, { prompt: 'config' })).status, 400, path);
    }
    assert.equal(calls.length, 0);
    const text = await fetch(`${base}/toolprune`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"action":"apply"}',
    });
    assert.equal(text.status, 415);
    assert.equal(calls.length, 0);
    const r = await post('/status', { json: true });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [['status', '--json']]);
    assert.equal(r.json.command, 'status');
    assert.ok(!('args' in r.json));
  });

  it('maps defaults to fixed argv', async () => {
    calls.length = 0;
    await post('/toolprune', {});
    await post('/toolprune', { action: 'measure' });
    await post('/config', {});
    await post('/repos', {});
    assert.equal((await post('/doctor', { arguments: ['--evil'] })).status, 400);
    await post('/doctor', {});
    assert.deepEqual(calls, [
      ['toolprune', 'show'],
      ['toolprune', 'measure'],
      ['config', 'show'],
      ['repos', 'list'],
      ['doctor'],
    ]);
  });

  it('returns 403 for mutating actions without running anything', async () => {
    calls.length = 0;
    for (const [path, body] of [
      ['/toolprune', { action: 'apply' }],
      ['/toolprune', { action: 'restore' }],
      ['/toolprune', { action: 'refresh-catalog' }],
      ['/config', { operation: 'set' }],
      ['/config', { operation: 'unset' }],
      ['/repos', { operation: 'migrate' }],
      ['/repos', { operation: 'merge' }],
    ]) {
      const r = await post(path, body);
      assert.equal(r.status, 403, `${path} ${JSON.stringify(body)}`);
      assert.equal(r.json.success, false);
    }
    assert.equal(calls.length, 0);
  });

  it('returns 400 for bad enums, bad types and non-object bodies', async () => {
    calls.length = 0;
    assert.equal((await post('/toolprune', { action: 'bogus' })).status, 400);
    assert.equal((await post('/toolprune', { action: ['apply'] })).status, 400);
    assert.equal((await post('/status', { json: 'yes' })).status, 400);
    assert.equal((await post('/repos', { operation: 'x' })).status, 400);
    assert.equal((await post('/status', [1, 2])).status, 400);
    assert.equal((await post('/status', null, '{not json')).status, 400);
    assert.equal(calls.length, 0);
  });

  it('/health exposes no paths or settings', async () => {
    const res = await fetch(`${base}/health`);
    assert.deepEqual(await res.json(), { service: 'tokeneconomizer', ok: true });
  });

  it('404 does not list commands', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Not found' });
  });

  it('redacts failures', async () => {
    const s = await listen(
      createApp({
        run: async () => {
          throw { status: 500, error: 'secret-sentinel', output: 'secret-sentinel' };
        },
      }),
    );
    const res = await fetch(`http://127.0.0.1:${s.address().port}/doctor`, { method: 'POST' });
    const text = await res.text();
    s.close();
    assert.equal(res.status, 500);
    assert.doesNotMatch(text, /secret-sentinel/);
  });

  it('defaults to binding loopback', () => {
    assert.equal(DEFAULT_HOST, '127.0.0.1');
  });
});

describe('runTeCommand output cap', () => {
  it('rejects with a fixed error and kills the child when output exceeds the cap', async () => {
    const started = Date.now();
    await assert.rejects(
      runTeCommand(['-e', 'setInterval(() => process.stdout.write("x".repeat(4096)), 1)'], {
        cmd: process.execPath,
        maxBytes: 64 * 1024,
      }),
      (err) => err.status === 500 && err.error === 'te output too large' && !('output' in err),
    );
    assert.ok(Date.now() - started < 10000);
  });
});

describe('runTeCommand timeout escalation', () => {
  // POSIX signal handlers do not run on Windows; the service only ships in Linux containers.
  it.skipIf(process.platform === 'win32')('sends SIGTERM, then SIGKILL when the child ignores it, and returns 504', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'te-term-'));
    const marker = join(dir, 'sigterm');
    const prev = process.env.TOKEN_ECONOMIZER_TIMEOUT_MS;
    // Generous deadline so the child has installed its handler long before SIGTERM, even on a slow runner.
    const timeoutMs = 3000;
    process.env.TOKEN_ECONOMIZER_TIMEOUT_MS = String(timeoutMs);
    const script =
      `const fs = require('fs');` +
      `process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(marker)}, 'TERM'));` +
      `setTimeout(() => {}, 30000);`;
    const started = Date.now();
    try {
      await assert.rejects(
        runTeCommand(['-e', script], { cmd: process.execPath, killGraceMs: 300 }),
        (err) => err.status === 504,
      );
      const elapsed = Date.now() - started;
      assert.equal(readFileSync(marker, 'utf8'), 'TERM', 'child should have received SIGTERM');
      assert.ok(elapsed >= timeoutMs + 250, `escalated too early: ${elapsed}ms`);
      assert.ok(elapsed < 10000, `child outlived escalation: ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.TOKEN_ECONOMIZER_TIMEOUT_MS;
      else process.env.TOKEN_ECONOMIZER_TIMEOUT_MS = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

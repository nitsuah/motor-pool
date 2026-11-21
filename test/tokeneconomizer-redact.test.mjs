import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createApp } from '../tools/tokeneconomizer/server.js';
import { redactSecrets, MASK } from '../tools/tokeneconomizer/redact.mjs';

// Sentinel values only; nothing here is a real credential.
const SENTINEL = 'REDACTME-sentinel-0001';
const TEST_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('redactSecrets', () => {
  it('masks secret-named keys in key=value, key: value and JSON forms', () => {
    const text = [
      `openai_api_key = ${SENTINEL}`,
      `auth_token: ${SENTINEL}`,
      `{"client_secret": "${SENTINEL}", "model": "gpt"}`,
      `password=${SENTINEL}`,
    ].join('\n');
    const out = redactSecrets(text);
    assert.ok(!out.includes(SENTINEL), out);
    assert.ok(out.includes('"model": "gpt"'), 'non-secret values stay');
    assert.equal(out.split(MASK).length - 1, 4);
  });

  it('masks bearer and provider-shaped tokens anywhere', () => {
    const out = redactSecrets('header Bearer abcdefghijklmnop and sk-REDACTME12345678 and ghp_REDACTMEREDACTMEREDACTME');
    assert.ok(!/abcdefghijklmnop|sk-REDACTME|ghp_REDACTME/.test(out), out);
  });

  it('leaves ordinary output and non-strings alone', () => {
    assert.equal(redactSecrets('model: gpt-5\ncache: on'), 'model: gpt-5\ncache: on');
    assert.equal(redactSecrets(undefined), undefined);
    assert.equal(redactSecrets(''), '');
  });
});

describe('HTTP wrapper redacts command output', () => {
  it('a command response never returns a secret value', async () => {
    const app = createApp({ token: TEST_TOKEN, run: async () => ({ output: `provider_api_key = ${SENTINEL}
model = small` }) });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(!JSON.stringify(body).includes(SENTINEL));
      assert.ok(body.output.includes('model = small'));
    } finally {
      server.close();
    }
  });

  it('config show is disabled over HTTP (403)', async () => {
    let spawned = false;
    const app = createApp({ token: TEST_TOKEN, run: async () => { spawned = true; return { output: '' }; } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ operation: 'show' }),
      });
      assert.equal(res.status, 403);
      assert.equal(spawned, false);
    } finally {
      server.close();
    }
  });
});

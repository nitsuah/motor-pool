import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createApp } from '../tools/tokeneconomizer/server.js';
import { redactSecrets, MASK } from '../tools/tokeneconomizer/redact.mjs';

// Sentinel values only; nothing here is a real credential.
const SENTINEL = 'REDACTME-sentinel-0001';

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

  it('keeps token counters (measurements, not secrets)', () => {
    const text = 'tokens_saved: 1200\nmax_tokens: 4096\ninput_tokens = 33';
    assert.equal(redactSecrets(text), text);
    assert.equal(redactSecrets('{"max_tokens": 4096, "tokens_saved": 7}'), '{"max_tokens":4096,"tokens_saved":7}');
  });

  it('masks non-string JSON values under secret keys, keeping other fields', () => {
    const out = redactSecrets(`{"password":123456,"api_key":["${SENTINEL}"],"nested":{"auth_token":{"v":"${SENTINEL}"}},"model":"small"}`);
    assert.ok(!out.includes(SENTINEL) && !out.includes('123456'), out);
    assert.ok(out.includes('"model":"small"'), out);
  });

  it('masks every line of a YAML block scalar under a secret key', () => {
    const text = `password: |
  ${SENTINEL}
  more-${SENTINEL}
cache: on
private_key: >-
  ${SENTINEL}`;
    const out = redactSecrets(text);
    assert.ok(!out.includes(SENTINEL), out);
    assert.ok(out.includes('cache: on'), out);
  });

  it('masks credentials in URL userinfo', () => {
    const out = redactSecrets(`endpoint=https://user:${SENTINEL}@db.example.test/x and http://a:b@h`);
    assert.ok(!out.includes(SENTINEL) && !out.includes('a:b@'), out);
    assert.ok(out.includes('db.example.test/x'), out);
  });

  it('leaves ordinary output and non-strings alone', () => {
    assert.equal(redactSecrets('model: gpt-5\ncache: on'), 'model: gpt-5\ncache: on');
    assert.equal(redactSecrets(undefined), undefined);
    assert.equal(redactSecrets(''), '');
  });
});

describe('HTTP wrapper redacts command output', () => {
  it('config show output never returns a secret value', async () => {
    const app = createApp({ run: async () => ({ output: `provider_api_key = ${SENTINEL}\nmodel = small` }) });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/config`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'show' }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(!JSON.stringify(body).includes(SENTINEL));
      assert.ok(body.output.includes('model = small'));
    } finally {
      server.close();
    }
  });
});

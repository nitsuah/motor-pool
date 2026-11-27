import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getStatus, summarizeStatus } from '../src/utils/tokenEconomizerApi.js';

const reply = (status, body) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

let sent;
const ok = await getStatus(async (url, init) => {
  sent = { url, init };
  return reply(200, {
    success: true,
    result: { success: true, command: 'status', output: JSON.stringify({ learned: 3, nested: { a: 1 } }) },
  })();
});
assert.equal(sent.url, '/api/plugins/tokeneconomizer/tools/status/invoke');
assert.equal(sent.init.method, 'POST');
assert.deepEqual(JSON.parse(sent.init.body), { arguments: { json: true } });
assert.deepEqual(ok, { ok: true, status: { learned: 3, nested: { a: 1 } } });
assert.deepEqual(summarizeStatus(ok.status), ['learned: 3']);

assert.deepEqual(await getStatus(reply(409, {})), { ok: false, reason: 'disabled' });
assert.deepEqual(await getStatus(reply(404, {})), { ok: false, reason: 'not installed' });
assert.deepEqual(await getStatus(reply(502, { success: false })), { ok: false, reason: 'unreachable' });
assert.deepEqual(await getStatus(async () => { throw new Error('offline'); }), { ok: false, reason: 'unreachable' });
const plain = await getStatus(reply(200, { success: true, result: { success: true, command: 'status', output: 'not json' } }));
assert.deepEqual(plain, { ok: true, status: 'not json' });
assert.deepEqual(summarizeStatus(null), []);
assert.deepEqual(summarizeStatus('  ready '), ['ready']);

// The panel must never show an invented savings number.
const panel = readFileSync(new URL('../src/components/TokenEconomizerPanel.jsx', import.meta.url), 'utf8');
assert.match(panel, /Token savings: unmeasured/);
assert.doesNotMatch(panel, /savings[^\n]*\d/i);

console.log('token-economizer-panel: ok');

/**
 * Tests for BYOK runtime endpoint registry
 * GET/POST/DELETE /api/config/endpoints
 */
import assert from 'node:assert/strict';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';

const { app } = await import('../server.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function req(path, { method = 'GET', data } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, data: body };
}

try {
  console.log('BYOK endpoint registry tests');

  // List built-in endpoints
  const list = await req('/api/config/endpoints');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.endpoints));
  const builtins = list.data.endpoints.filter(e => e.builtin);
  assert.ok(builtins.some(e => e.key === 'primary'), 'primary endpoint should appear');
  assert.ok(builtins.some(e => e.key === 'ninerouter'), '9router endpoint should be protected as built-in');

  // Add a custom endpoint
  const add = await req('/api/config/endpoints', {
    method: 'POST',
    data: { key: 'test_claude', name: 'Claude API', url: 'https://api.anthropic.com', apiStyle: 'anthropic', apiKey: 'sk-test-123' },
  });
  assert.equal(add.status, 200);
  assert.equal(add.data.endpoint.key, 'test_claude');
  assert.equal(add.data.endpoint.hasApiKey, true);

  // List now includes the new endpoint
  const list2 = await req('/api/config/endpoints');
  const found = list2.data.endpoints.find(e => e.key === 'test_claude');
  assert.ok(found, 'added endpoint should be in list');
  assert.equal(found.builtin, false);
  assert.equal(found.hasApiKey, true);

  // Adding a builtin key is rejected
  const dupPrimary = await req('/api/config/endpoints', {
    method: 'POST',
    data: { key: 'primary', url: 'http://evil.example.com' },
  });
  assert.equal(dupPrimary.status, 400, 'overwriting builtin should fail');

  const dupNinerouter = await req('/api/config/endpoints', {
    method: 'POST',
    data: { key: 'ninerouter', url: 'https://evil.example.com', apiKey: 'evil-key' },
  });
  assert.equal(dupNinerouter.status, 400, 'overwriting 9router should fail');

  // Adding with missing key/url is rejected
  const missingUrl = await req('/api/config/endpoints', {
    method: 'POST',
    data: { key: 'no_url_ep' },
  });
  assert.equal(missingUrl.status, 400, 'missing url should fail');

  // Invalid key characters rejected
  const badKey = await req('/api/config/endpoints', {
    method: 'POST',
    data: { key: 'has spaces!', url: 'http://x.example.com' },
  });
  assert.equal(badKey.status, 400, 'invalid key chars should fail');

  // Delete the custom endpoint
  const del = await req('/api/config/endpoints/test_claude', { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.data.removed, 'test_claude');

  // Deleting a builtin is rejected
  const delBuiltin = await req('/api/config/endpoints/primary', { method: 'DELETE' });
  assert.equal(delBuiltin.status, 400, 'deleting builtin should fail');

  const delNinerouter = await req('/api/config/endpoints/ninerouter', { method: 'DELETE' });
  assert.equal(delNinerouter.status, 400, 'deleting 9router should fail');

  // Deleting nonexistent returns 404
  const delMissing = await req('/api/config/endpoints/test_claude', { method: 'DELETE' });
  assert.equal(delMissing.status, 404, 'deleting missing endpoint should 404');

  console.log('BYOK endpoint registry tests passed.');
} catch (err) {
  console.error('BYOK endpoint registry tests failed:', err.message);
  process.exit(1);
} finally {
  server.close();
}

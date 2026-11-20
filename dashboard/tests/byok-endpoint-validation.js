/**
 * Input validation for the BYOK endpoint registry: keys and URLs must be
 * strings, and metadata/link-local hosts are refused.
 */
import assert from 'node:assert/strict';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
const { app } = await import('../server.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function post(data) {
  const res = await fetch(`${base}/api/config/endpoints`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  return res.status;
}

try {
  console.log('BYOK endpoint validation tests');

  assert.equal(await post({ key: ['primary'], url: 'http://10.0.0.5:11434' }), 400, 'array key refused');
  assert.equal(await post({ key: { a: 1 }, url: 'http://10.0.0.5:11434' }), 400, 'object key refused');
  assert.equal(await post({ key: 'ok_key', url: ['http://10.0.0.5:11434'] }), 400, 'array url refused');
  const list = await (await fetch(`${base}/api/config/endpoints`)).json();
  assert.ok(list.endpoints.find(e => e.key === 'primary')?.builtin, 'primary is still the built-in endpoint');

  for (const url of [
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:169.254.169.254]/',
    'http://2852039166/',
    'http://metadata.google.internal/',
    'http://100.100.100.200/',
    'http://0.0.0.0:8080',
    'http://[fe80::1]/',
  ]) {
    assert.equal(await post({ key: 'meta_probe', url }), 400, `${url} refused`);
  }

  for (const url of ['http://127.0.0.1:11434', 'http://192.168.1.20:11434', 'https://api.example.com']) {
    assert.equal(await post({ key: 'local_ok', url }), 200, `${url} accepted`);
  }
  await fetch(`${base}/api/config/endpoints/local_ok`, { method: 'DELETE' });

  console.log('BYOK endpoint validation tests passed.');
} catch (err) {
  console.error('BYOK endpoint validation tests failed:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

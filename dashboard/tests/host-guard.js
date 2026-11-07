/**
 * Requests are served only for known Host names: loopback, the compose service
 * name, CORS_ALLOWED_ORIGINS hosts and ALLOWED_HOSTS entries.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
process.env.ALLOWED_HOSTS = 'dash.example.test, other.example.test:8443';
process.env.CORS_ALLOWED_ORIGINS = 'https://cors.example.test';
const { app } = await import('../server.js');

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

function get(host, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method, headers: { Host: host } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}

try {
  assert.equal(await get('evil.example'), 403, 'unknown host refused');
  assert.equal(await get('evil.example:3000', 'POST'), 403, 'unknown host refused for POST');
  assert.equal(await get('localhost.evil.example'), 403, 'lookalike host refused');
  assert.equal(await get('localhost:3000'), 200, 'localhost:3000 allowed');
  assert.equal(await get('127.0.0.1:3000'), 200);
  assert.equal(await get('[::1]:3000'), 200);
  assert.equal(await get('agent-dashboard:3000'), 200, 'compose service name allowed');
  assert.equal(await get('dash.example.test'), 200, 'ALLOWED_HOSTS entry allowed');
  assert.equal(await get('other.example.test:8443'), 200, 'ALLOWED_HOSTS entry with port allowed');
  assert.equal(await get('cors.example.test'), 200, 'CORS origin host allowed');
  console.log('Host guard tests passed.');
} catch (err) {
  console.error('Host guard tests failed:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

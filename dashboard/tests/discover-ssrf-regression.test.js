/**
 * Regression tests for SSRF boundaries in GET /api/discover/endpoints.
 * Run as a standalone Node script, matching the dashboard test harness.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { BASE, closeTestServer } from './helpers/test-server.js';

const testServers = [];

async function startTestServer(handler, port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      testServers.push(server);
      resolve({ server, port: server.address().port });
    });
  });
}

async function closeServers() {
  await Promise.all(testServers.map(server => new Promise(resolve => server.close(resolve))));
  closeTestServer();
}

try {
  // The limiter is bounded and prunes expired client entries.
  const limit = createRateLimiter({ windowMs: 1000, maxRequests: 1, maxClients: 2 });
  assert.equal(limit('a', 100), true);
  assert.equal(limit('a', 200), false);
  assert.equal(limit('b', 200), true);
  assert.equal(limit('c', 200), false);
  assert.equal(limit('c', 1201), true);
  console.log('✓ bounded rate-limit state and expiry');

  // Arbitrary ports are ignored, even when a local service is listening there.
  const { port: arbitraryPort } = await startTestServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'arbitrary-model' }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const arbitraryRes = await fetch(`${BASE}/api/discover/endpoints?host=localhost&ports=${arbitraryPort}`);
  assert.equal(arbitraryRes.status, 200);
  const arbitraryData = await arbitraryRes.json();
  assert.equal(arbitraryData.success, true);
  assert.equal(arbitraryData.discovered.some(entry => entry.url?.includes(':' + arbitraryPort)), false);
  console.log('✓ arbitrary ports are not scanned');

  // host.docker.internal and private IPs are rejected as caller-controlled hosts.
  const hostRes = await fetch(`${BASE}/api/discover/endpoints?host=host.docker.internal&ports=11434`);
  assert.equal(hostRes.status, 400);
  const privateRes = await fetch(`${BASE}/api/discover/endpoints?host=10.0.0.1&ports=8080`);
  assert.equal(privateRes.status, 400);
  console.log('✓ caller-controlled non-loopback hosts are rejected');

  // A service on an explicitly allowlisted port remains discoverable.
  const { server: validServer } = await startTestServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }, 5000);
  const validRes = await fetch(`${BASE}/api/discover/endpoints?host=localhost&ports=5000`);
  assert.equal(validRes.status, 200);
  const validData = await validRes.json();
  const validEntry = validData.discovered.find(entry => entry.url?.includes(':5000'));
  assert.ok(validEntry);
  assert.ok(validEntry.models.includes('test-model'));
  console.log('✓ allowlisted port remains discoverable');

  // Multiple arbitrary ports do not widen the scan.
  const multipleRes = await fetch(`${BASE}/api/discover/endpoints?host=localhost&ports=9999,8888,7777`);
  assert.equal(multipleRes.status, 200);
  const multipleData = await multipleRes.json();
  assert.equal(multipleData.discovered.some(entry => [9999, 8888, 7777].some(port => entry.url?.includes(':' + port))), false);
  console.log('✓ multiple arbitrary ports are ignored');
} finally {
  await closeServers();
}

console.log('SSRF regression tests passed.');

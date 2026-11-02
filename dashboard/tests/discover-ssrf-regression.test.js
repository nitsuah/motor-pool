/**
 * Regression tests for SSRF boundaries in GET /api/discover/endpoints.
 * Run as a standalone Node script, matching the dashboard test harness.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { BASE, closeTestServer } from './helpers/test-server.js';
import { isPrivateHost } from '../routes/discover.js';

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
  // Relative redirects stay on the probed origin; private IPv4/IPv6 targets are blocked.
  assert.equal(isPrivateHost('/api/tags', 'http://localhost:5000'), false);
  assert.equal(isPrivateHost('http://169.254.169.254/latest/meta-data', 'http://localhost:5000'), true);
  assert.equal(isPrivateHost('http://[fe80::1]/', 'http://localhost:5000'), true);
  assert.equal(isPrivateHost('http://[febf::1]/', 'http://localhost:5000'), true);
  assert.equal(isPrivateHost('http://[fec0::1]/', 'http://localhost:5000'), false);
  assert.equal(isPrivateHost('http://[fc00::1]/', 'http://localhost:5000'), true);
  assert.equal(isPrivateHost('http://[fdff::1]/', 'http://localhost:5000'), true);
  assert.equal(isPrivateHost('http://[::ffff:7f00:1]/', 'http://localhost:5000'), true);
  assert.equal(isPrivateHost('http://[::ffff:808:808]/', 'http://localhost:5000'), false);
  console.log('✓ relative and private IPv6 redirect targets are classified');

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
  // A same-origin relative redirect must not stop the remaining probes; fetch never follows it.
  const { server: validServer } = await startTestServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(302, { Location: '/api/tags' });
      res.end();
    } else if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
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

  // Five earlier requests used the discovery quota. Five more are allowed; the next is throttled.
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${BASE}/api/discover/endpoints?host=host.docker.internal&ports=11434`);
    assert.equal(res.status, 400);
  }
  const limitedRes = await fetch(`${BASE}/api/discover/endpoints?host=host.docker.internal&ports=11434`);
  assert.equal(limitedRes.status, 429);
  console.log('✓ rate limit applies to discovery scans only');
} finally {
  await closeServers();
}

console.log('SSRF regression tests passed.');

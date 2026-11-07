/**
 * WebSocket upgrades are accepted only for a known Host and a same-host or
 * allowlisted Origin.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachEventWebSocketServer } from '../modules/event-bus.js';
import { createUpgradeVerifier } from '../modules/origin-guard.js';

const server = http.createServer();
attachEventWebSocketServer(server, createUpgradeVerifier({
  getCorsOrigins: () => ['http://ok.example.test'],
  getAllowedHosts: () => [],
}));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function connect(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', () => resolve('error'));
  });
}

try {
  assert.equal(await connect({ Host: 'evil.example' }), 403, 'unknown Host refused');
  assert.equal(await connect({ Host: `localhost:${port}`, Origin: 'http://evil.example' }), 403, 'foreign Origin refused');
  assert.equal(await connect({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), 'open', 'same-host Origin accepted');
  assert.equal(await connect({ Host: `localhost:${port}`, Origin: 'http://ok.example.test' }), 'open', 'allowlisted Origin accepted');
  assert.equal(await connect({ Host: `localhost:${port}` }), 'open', 'no Origin accepted');
  console.log('WebSocket upgrade guard tests passed.');
} catch (err) {
  console.error('WebSocket upgrade guard tests failed:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}

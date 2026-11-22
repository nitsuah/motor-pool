/**
 * Exec route access control: demo mode turns exec off, a configured token is
 * required, and without a token only loopback peers are accepted.
 */
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceRouter } from '../routes/workspace.js';
import { shellExecEnabled, authorizeExec } from '../modules/exec-flag.js';

const base = mkdtempSync(join(tmpdir(), 'ws-exec-auth-'));
const root = join(base, 'ws');
const marker = join(root, 'AUTH_MARKER.txt');
mkdirSync(root, { recursive: true });
const app = express();
app.use('/api', createWorkspaceRouter(root));
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const { port } = server.address();
const KEYS = ['WORKSPACE_EXEC', 'WORKSPACE_EXEC_TOKEN', 'PUBLIC_DEMO_MODE', 'NODE_ENV'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

function post(headers = {}) {
  const payload = JSON.stringify({ command: 'touch AUTH_MARKER.txt' });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/workspace/exec',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(payload);
  });
}
const reset = () => { for (const k of KEYS) delete process.env[k]; rmSync(marker, { force: true }); };

try {
  console.log('Workspace exec access tests');
  reset();
  process.env.WORKSPACE_EXEC = '1';

  process.env.PUBLIC_DEMO_MODE = 'true';
  assert.equal(shellExecEnabled(), false, 'demo mode disables exec');
  assert.equal(await post(), 403);
  assert.equal(existsSync(marker), false, 'demo mode did not run the command');
  delete process.env.PUBLIC_DEMO_MODE;

  process.env.WORKSPACE_EXEC_TOKEN = 's3cret-token';
  assert.equal(await post(), 401, 'missing token is refused');
  assert.equal(await post({ authorization: 'Bearer wrong' }), 401, 'wrong token is refused');
  assert.equal(existsSync(marker), false);
  assert.equal(await post({ authorization: 'Bearer s3cret-token' }), 200, 'right token runs');
  assert.equal(existsSync(marker), true);
  rmSync(marker, { force: true });
  delete process.env.WORKSPACE_EXEC_TOKEN;

  assert.equal(await post(), 200, 'loopback peer without token runs outside production');
  rmSync(marker, { force: true });
  process.env.NODE_ENV = 'production';
  assert.equal(await post(), 403, 'production without token is refused');
  assert.equal(existsSync(marker), false);

  const remote = { headers: {}, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(authorizeExec(remote, {}).ok, false, 'non-loopback peer without token is refused');
  assert.equal(authorizeExec({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }, {}).ok, true);
  assert.equal(authorizeExec({ headers: {}, socket: { remoteAddress: '::1' } }, {}).ok, true, 'IPv6 loopback is accepted');
  assert.equal(authorizeExec({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, {}).ok, true, 'IPv4 loopback is accepted');
  console.log('  ok exec requires a token, loopback, and is off in demo mode');
} finally {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  server.close();
  rmSync(base, { recursive: true, force: true });
}

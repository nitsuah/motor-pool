/**
 * With the workspace root set to a filesystem root (where the root already ends in a
 * separator), operations whose target must be below the root still refuse the root
 * itself. Only non-destructive requests are used here.
 */
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { parse } from 'node:path';
import { createWorkspaceRouter } from '../routes/workspace.js';

const fsRoot = parse(process.cwd()).root; // '/' on Linux, 'C:\' on Windows

function request(port, { method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const app = express();
app.use('/api', createWorkspaceRouter(fsRoot));
const server = app.listen(0);
const { port } = server.address();

try {
  console.log('Workspace filesystem-root tests');
  let res = await request(port, { method: 'POST', path: '/api/workspace/mkdir', body: { path: '' } });
  assert.equal(res.status, 400, `mkdir of the filesystem root refused: ${res.status} ${res.text}`);
  res = await request(port, { method: 'POST', path: '/api/workspace/rename', body: { from: '', to: 'x-should-not-exist' } });
  assert.equal(res.status, 400, `rename of the filesystem root refused: ${res.status} ${res.text}`);
  res = await request(port, { path: '/api/workspace/read?path=' });
  assert.equal(res.status, 400, `read of the filesystem root refused: ${res.status}`);
  console.log('Workspace filesystem-root tests passed.');
} catch (err) {
  console.error('✗ FAIL:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

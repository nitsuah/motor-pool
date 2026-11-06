/**
 * Session output routes accept only plain session ids, so a dot-segment id
 * (sent percent-encoded so the client does not normalise it) never lists or
 * serves files from outside the per-session tmp directory.
 */
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import outputsRouter, { saveOutput } from '../routes/outputs.js';

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

const app = express();
app.use('/api', outputsRouter);
const server = app.listen(0);
const { port } = server.address();

try {
  console.log('Session output id tests');

  let res = await get(port, '/api/sessions/%2e%2e/outputs');
  assert.equal(res.status, 400, `dot-segment id listing refused: ${res.status} ${res.text.slice(0, 80)}`);

  res = await get(port, '/api/sessions/%2e%2e/outputs/package.json');
  assert.equal(res.status, 400, `dot-segment id download refused: ${res.status}`);

  assert.throws(() => saveOutput('..', 'x.txt', 'x'), /Invalid session id/);

  const id = `test-${Date.now()}`;
  saveOutput(id, 'note.txt', 'hello');
  res = await get(port, `/api/sessions/${id}/outputs`);
  assert.equal(res.status, 200);
  assert.ok(JSON.parse(res.text).some((f) => f.filename === 'note.txt'), 'saved file is listed');
  res = await get(port, `/api/sessions/${id}/outputs/note.txt`);
  assert.equal(res.status, 200);
  assert.equal(res.text, 'hello');

  console.log('✓ Session output id tests passed');
} catch (err) {
  console.error('✗ FAIL:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

/**
 * Behavioural tests for the content router's client listing and file download.
 * A sibling directory whose name shares the output directory prefix must not
 * be served, and ordinary client files must still be listed and downloaded.
 */
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContentRouter } from '../routes/content.js';

const base = mkdtempSync(join(tmpdir(), 'content-contain-'));
const outDir = join(base, 'out');
const evilDir = join(base, 'out-evil');

mkdirSync(join(outDir, 'client', 'sub'), { recursive: true });
mkdirSync(evilDir, { recursive: true });
writeFileSync(join(outDir, 'client', 'report.txt'), 'REPORT');
writeFileSync(join(outDir, 'client', 'sub', 'page.html'), '<p>PAGE</p>');
writeFileSync(join(evilDir, 'secret.txt'), 'EVIL');

function get(port, path) {
  return new Promise((resolve, reject) => {
    // Raw path string: the client must not normalise ".." segments.
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
  });
}

const app = express();
app.use('/api', createContentRouter({ WEBSITE_OUTPUT_DIR: outDir, WORKSPACE_ROOT: null }));
const server = app.listen(0);
const { port } = server.address();

try {
  console.log('Content download containment tests');

  const listing = await get(port, '/api/content/clients/client/files');
  assert.equal(listing.status, 200, `files listing: ${listing.text}`);
  const paths = JSON.parse(listing.text).files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['report.txt', 'sub/page.html'], 'client files listed with relative paths');

  const normal = await get(port, '/api/content/download/client/report.txt');
  assert.equal(normal.status, 200, `normal download: ${normal.text}`);
  assert.equal(normal.text, 'REPORT');

  const nested = await get(port, '/api/content/download/client/sub/page.html');
  assert.equal(nested.status, 200, `nested download: ${nested.text}`);

  // Resolves to <outDir>-evil/secret.txt, which shares the string prefix of outDir.
  const sibling = await get(port, '/api/content/download/client/../../out-evil/secret.txt');
  assert.equal(sibling.status, 403, `sibling-prefix directory refused: ${sibling.status} ${sibling.text}`);
  assert.ok(!sibling.text.includes('EVIL'), 'sibling file content not served');

  console.log('✓ All content download containment tests passed');
} catch (err) {
  console.error('✗ FAIL:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
  rmSync(base, { recursive: true, force: true });
}

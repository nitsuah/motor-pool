/**
 * Tests for the artifacts list and download in routes/content.js when the
 * artifacts directory contains symlinks: nothing outside the workspace may be
 * listed or served, ordinary artifacts still work.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createContentRouter } from '../routes/content.js';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ab-art-root-')));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'ab-art-outside-')));
mkdirSync(join(ROOT, 'artifacts', 'nested'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts', 'ok.txt'), 'hello artifact');
writeFileSync(join(ROOT, 'artifacts', 'nested', 'deep.txt'), 'deep');
writeFileSync(join(OUTSIDE, 'secret.txt'), 'outside secret');
symlinkSync(join(OUTSIDE, 'secret.txt'), join(ROOT, 'artifacts', 'evil.txt'));
symlinkSync(OUTSIDE, join(ROOT, 'artifacts', 'dirlink'), 'dir');

const app = express();
app.use('/api', createContentRouter({ WEBSITE_OUTPUT_DIR: join(ROOT, 'out'), WORKSPACE_ROOT: ROOT }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/api`;

try {
  const list = await (await fetch(`${BASE}/artifacts`)).json();
  const names = list.map((f) => f.name).sort();
  assert.deepEqual(names, ['nested/deep.txt', 'ok.txt'], 'only real files inside the workspace are listed');
  console.log('  \u2705 artifact list skips symlinks and does not follow them');

  const ok = await fetch(`${BASE}/artifacts/ok.txt/download`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'hello artifact', 'ordinary download works');

  for (const name of ['evil.txt', 'dirlink']) {
    const bad = await fetch(`${BASE}/artifacts/${name}/download`);
    assert.ok(bad.status >= 400, `${name} download refused (got ${bad.status})`);
    assert.ok(!(await bad.text()).includes('outside secret'), `${name} served no outside bytes`);
  }
  console.log('  \u2705 artifact download refuses a symlink pointing outside, serves ordinary files');
} finally {
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
}

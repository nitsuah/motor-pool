/**
 * Tests for the path-containment checks in routes/workspace.js when the
 * workspace contains symlinks.
 *
 * A symlink inside WORKSPACE_ROOT that points outside it must not let reads,
 * writes, or deletes reach the target. Ordinary nested paths must still work.
 * The router is mounted on an in-process express app on an ephemeral port.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createWorkspaceRouter } from '../routes/workspace.js';

// realpath: on macOS/Windows runners tmpdir is often a symlink, and the route
// compares resolved absolute paths.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ab-ws-link-root-')));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'ab-ws-link-outside-')));

mkdirSync(join(ROOT, 'sub'));
writeFileSync(join(ROOT, 'sub', 'ok.txt'), 'inside\n');
writeFileSync(join(OUTSIDE, 'secret.txt'), 'outside\n');
symlinkSync(OUTSIDE, join(ROOT, 'escape'), 'dir');

const app = express();
app.use('/api', createWorkspaceRouter(ROOT));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/api`;
const get = (p) => fetch(`${BASE}${p}`);
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

try {
  // ── read through an in-root symlink ───────────────────────────────────────
  const linkRead = await get(`/workspace/read?path=${encodeURIComponent('escape/secret.txt')}`);
  assert.ok(linkRead.status >= 400, `read through symlink must be refused (got ${linkRead.status})`);
  assert.ok(!(await linkRead.text()).includes('outside'), 'read through symlink must not return target content');
  console.log('  ✅ read through an in-root symlink to outside the root is refused');

  // ── write through an in-root symlink ──────────────────────────────────────
  const linkWrite = await post('/workspace/write', { path: 'escape/planted.txt', content: 'x' });
  assert.ok(linkWrite.status >= 400, `write through symlink must be refused (got ${linkWrite.status})`);
  assert.ok(!existsSync(join(OUTSIDE, 'planted.txt')), 'no file was written into the symlink target');
  console.log('  ✅ write through an in-root symlink to outside the root is refused');

  // ── delete through an in-root symlink ─────────────────────────────────────
  const linkDelete = await fetch(`${BASE}/workspace/file?path=${encodeURIComponent('escape/secret.txt')}`, { method: 'DELETE' });
  assert.ok(linkDelete.status >= 400, `delete through symlink must be refused (got ${linkDelete.status})`);
  assert.ok(existsSync(join(OUTSIDE, 'secret.txt')), 'target file still exists after refused delete');
  console.log('  ✅ delete through an in-root symlink to outside the root is refused');

  // ── traversal and absolute paths still refused ────────────────────────────
  const up = await post('/workspace/write', { path: '../escaped.txt', content: 'x' });
  assert.ok(up.status >= 400, 'traversal write is refused');
  assert.ok(!existsSync(join(ROOT, '..', 'escaped.txt')), 'no file was written above the root');
  const abs = await get(`/workspace/read?path=${encodeURIComponent('/etc/passwd')}`);
  assert.ok(abs.status >= 400, 'absolute path is refused');
  console.log('  ✅ traversal and absolute paths remain refused');

  // ── ordinary nested paths still work ──────────────────────────────────────
  const write = await post('/workspace/write', { path: 'sub/new.txt', content: 'written\n' });
  assert.strictEqual(write.status, 200, 'nested write succeeds');
  const read = await (await get(`/workspace/read?path=${encodeURIComponent('sub/new.txt')}`)).json();
  assert.strictEqual(read.content, 'written\n', 'nested write reads back');
  const ok = await (await get(`/workspace/read?path=${encodeURIComponent('sub/ok.txt')}`)).json();
  assert.strictEqual(ok.content, 'inside\n', 'existing nested file reads back');
  console.log('  ✅ ordinary nested paths still read and write inside the root');

  console.log('Workspace symlink containment tests passed.');
} finally {
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
}

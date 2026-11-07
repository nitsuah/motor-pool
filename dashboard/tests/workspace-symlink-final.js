/**
 * A symlink as the final path component (even one that stays inside the
 * workspace) is refused for read, write, delete and rename; regular files and
 * directories keep working. Skipped where symlinks need elevated rights.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createWorkspaceRouter } from '../routes/workspace.js';

if (process.platform === 'win32') {
  console.log('Workspace final-symlink tests skipped on Windows.');
  process.exit(0);
}

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ab-ws-final-')));
writeFileSync(join(ROOT, 'real.txt'), 'real\n');
writeFileSync(join(ROOT, 'other.txt'), 'other\n');
symlinkSync(join(ROOT, 'real.txt'), join(ROOT, 'link.txt'));

const app = express();
app.use('/api', createWorkspaceRouter(ROOT));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/api`;
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

try {
  const read = await fetch(`${BASE}/workspace/read?path=link.txt`);
  assert.equal(read.status, 400, 'read of a symlink is refused');

  const write = await post('/workspace/write', { path: 'link.txt', content: 'changed' });
  assert.equal(write.status, 400, 'write to a symlink is refused');
  assert.equal(readFileSync(join(ROOT, 'real.txt'), 'utf8'), 'real\n', 'symlink target was not modified');

  const del = await fetch(`${BASE}/workspace/file?path=link.txt`, { method: 'DELETE' });
  assert.equal(del.status, 400, 'delete of a symlink is refused');
  assert.ok(lstatSync(join(ROOT, 'link.txt')).isSymbolicLink(), 'symlink still present');

  const renameFrom = await post('/workspace/rename', { from: 'link.txt', to: 'moved.txt' });
  assert.equal(renameFrom.status, 400, 'rename of a symlink is refused');
  const renameOnto = await post('/workspace/rename', { from: 'other.txt', to: 'link.txt' });
  assert.equal(renameOnto.status, 400, 'rename onto a symlink is refused');
  assert.ok(existsSync(join(ROOT, 'other.txt')), 'source untouched after refused rename');

  // Regular files still work end to end.
  assert.equal((await post('/workspace/write', { path: 'a/b/new.txt', content: 'hi' })).status, 200);
  const ok = await (await fetch(`${BASE}/workspace/read?path=a/b/new.txt`)).json();
  assert.equal(ok.content, 'hi');
  assert.equal((await post('/workspace/rename', { from: 'a/b/new.txt', to: 'a/b/new2.txt' })).status, 200);
  assert.equal((await fetch(`${BASE}/workspace/file?path=a`, { method: 'DELETE' })).status, 200);
  assert.ok(!existsSync(join(ROOT, 'a')), 'directory removed');

  console.log('Workspace final-symlink tests passed.');
} finally {
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
}

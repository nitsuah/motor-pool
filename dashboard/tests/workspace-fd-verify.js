/**
 * Tests for the descriptor checks in modules/workspace-fs.js, exercised through
 * routes/workspace.js.
 *
 * A directory inside the workspace is replaced by a symlink to a directory
 * outside it at a chosen point between the path check and the file operation
 * (the testHooks.before seam). Every operation must refuse, or stay inside the
 * workspace, and nothing may be read from or written to the outside directory.
 * Both the /proc based mode (Linux) and the fallback mode are covered.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync, renameSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createWorkspaceRouter } from '../routes/workspace.js';
import { testHooks } from '../modules/workspace-fs.js';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ab-ws-fd-root-')));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'ab-ws-fd-outside-')));

const app = express();
app.use('/api', createWorkspaceRouter(ROOT));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/api`;
const get = (p) => fetch(`${BASE}${p}`);
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const del = (p) => fetch(`${BASE}/workspace/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
const q = (p) => encodeURIComponent(p);

function seed() {
  rmSync(join(ROOT, 'a'), { recursive: true, force: true });
  rmSync(join(ROOT, 'a.orig'), { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'a', 'b'), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(ROOT, 'a', 'f.txt'), 'inside\n');
  writeFileSync(join(ROOT, 'a', 'gone.txt'), 'inside\n');
  writeFileSync(join(ROOT, 'a', 'mv.txt'), 'inside\n');
  writeFileSync(join(OUTSIDE, 'f.txt'), 'secret\n');
  writeFileSync(join(OUTSIDE, 'gone.txt'), 'secret\n');
  writeFileSync(join(OUTSIDE, 'mv.txt'), 'secret\n');
  mkdirSync(join(OUTSIDE, 'b'));
}

// Replaces ROOT/a with a symlink to OUTSIDE once, at the given stage.
function armSwap(stage) {
  let done = false;
  testHooks.before = async (s) => {
    if (done || s !== stage) return;
    done = true;
    renameSync(join(ROOT, 'a'), join(ROOT, 'a.orig'));
    symlinkSync(OUTSIDE, join(ROOT, 'a'), 'dir');
  };
}

function outsideUntouched() {
  assert.equal(readFileSync(join(OUTSIDE, 'f.txt'), 'utf8'), 'secret\n', 'outside file was not modified');
  assert.ok(existsSync(join(OUTSIDE, 'gone.txt')), 'outside file was not removed');
  assert.ok(existsSync(join(OUTSIDE, 'mv.txt')), 'outside file was not moved');
  assert.deepEqual(readdirSync(OUTSIDE).sort(), ['b', 'f.txt', 'gone.txt', 'mv.txt'], 'nothing new appeared outside');
  assert.deepEqual(readdirSync(join(OUTSIDE, 'b')), [], 'no directory content created outside');
  for (const f of ['f.txt', 'gone.txt', 'mv.txt']) assert.equal(statSync(join(OUTSIDE, f)).size, 7);
}

const modes = [
  { name: 'proc', disableProc: false },
  { name: 'fallback', disableProc: true },
];

try {
  for (const mode of modes) {
    if (!mode.disableProc && !(process.platform === 'linux' && existsSync('/proc/self/fd'))) {
      console.log('  (skipping /proc mode: not available on this platform)');
      continue;
    }
    testHooks.disableProc = mode.disableProc;
    const label = `[${mode.name}]`;

    // ── normal operations still work ────────────────────────────────────────
    seed();
    testHooks.before = null;
    let r = await post('/workspace/write', { path: 'a/b/new.txt', content: 'hello' });
    assert.equal(r.status, 200, 'normal write works');
    assert.equal(readFileSync(join(ROOT, 'a', 'b', 'new.txt'), 'utf8'), 'hello');
    r = await post('/workspace/write', { path: 'a/f.txt', content: 'x' });
    assert.equal(r.status, 200, 'overwrite works and truncates');
    assert.equal(readFileSync(join(ROOT, 'a', 'f.txt'), 'utf8'), 'x');
    r = await get(`/workspace/read?path=${q('a/f.txt')}`);
    assert.equal((await r.json()).content, 'x');
    r = await get(`/workspace/ls?path=${q('a')}`);
    assert.ok((await r.json()).entries.some((e) => e.name === 'b'), 'normal list works');
    r = await get('/workspace/ls');
    assert.equal(r.status, 200, 'listing the root works');
    r = await post('/workspace/mkdir', { path: 'a/c/d' });
    assert.equal(r.status, 200, 'normal mkdir works');
    assert.ok(existsSync(join(ROOT, 'a', 'c', 'd')));
    r = await post('/workspace/rename', { from: 'a/mv.txt', to: 'a/mv2.txt' });
    assert.equal(r.status, 200, 'normal rename works');
    r = await del('a/mv2.txt');
    assert.equal(r.status, 200, 'normal delete works');
    assert.ok(!existsSync(join(ROOT, 'a', 'mv2.txt')));
    r = await del('a/c');
    assert.equal(r.status, 200, 'normal directory delete works');
    r = await del('');
    assert.equal(r.status, 400, 'the root itself is not deletable');
    console.log(`  ✅ ${label} normal operations pass`);

    // ── swapped before the parent is checked ────────────────────────────────
    seed();
    armSwap('before-parent');
    r = await get(`/workspace/read?path=${q('a/f.txt')}`);
    assert.ok(r.status >= 400, `${label} read refused`);
    assert.ok(!(await r.text()).includes('secret'), `${label} no outside bytes returned`);
    outsideUntouched();

    seed();
    armSwap('before-parent');
    r = await post('/workspace/write', { path: 'a/f.txt', content: 'planted' });
    assert.ok(r.status >= 400, `${label} write refused`);
    outsideUntouched();

    seed();
    armSwap('before-parent');
    r = await post('/workspace/write', { path: 'a/b/new.txt', content: 'planted' });
    assert.ok(r.status >= 400, `${label} write of a new file refused`);
    outsideUntouched();

    seed();
    armSwap('before-parent');
    r = await post('/workspace/mkdir', { path: 'a/b/made' });
    assert.ok(r.status >= 400, `${label} mkdir refused`);
    outsideUntouched();

    seed();
    armSwap('before-parent');
    r = await del('a/gone.txt');
    assert.ok(r.status >= 400, `${label} delete refused`);
    outsideUntouched();

    seed();
    armSwap('before-parent');
    r = await get(`/workspace/ls?path=${q('a')}`);
    assert.ok(r.status >= 400, `${label} list refused`);
    assert.ok(!(await r.text()).includes('gone.txt'), `${label} no outside names returned`);

    seed();
    armSwap('before-parent');
    r = await post('/workspace/rename', { from: 'a/mv.txt', to: 'a/moved.txt' });
    assert.ok(r.status >= 400, `${label} rename refused`);
    outsideUntouched();
    console.log(`  ✅ ${label} swap before the parent check: read/write/mkdir/delete/list/rename refused`);

    // ── swapped between the check and the operation ─────────────────────────
    testHooks.zeroIno = false;
    if (!mode.disableProc) {
      // The parent is pinned by descriptor, so the swap cannot redirect anything.
      seed();
      armSwap('before-op');
      r = await get(`/workspace/read?path=${q('a/f.txt')}`);
      assert.ok(!(await r.text()).includes('secret'), 'pinned read never returns outside bytes');

      seed();
      armSwap('before-op');
      await post('/workspace/write', { path: 'a/f.txt', content: 'planted' });
      outsideUntouched();

      seed();
      armSwap('before-op');
      await post('/workspace/mkdir', { path: 'a/b/made' });
      outsideUntouched();

      seed();
      armSwap('before-op');
      await del('a/gone.txt');
      outsideUntouched();

      seed();
      armSwap('before-op');
      r = await get(`/workspace/ls?path=${q('a')}`);
      assert.ok(!(await r.text()).includes('mv.txt') || existsSync(join(ROOT, 'a.orig', 'mv.txt')), 'pinned list reads the original directory');
      console.log(`  ✅ ${label} swap after the check: operations stay on the pinned directory`);
    } else {
      // Without /proc the opened file itself is verified before any byte moves.
      seed();
      armSwap('before-op');
      r = await get(`/workspace/read?path=${q('a/f.txt')}`);
      assert.ok(r.status >= 400, 'fallback read refused');
      assert.ok(!(await r.text()).includes('secret'), 'fallback returned no outside bytes');

      seed();
      armSwap('before-op');
      r = await post('/workspace/write', { path: 'a/f.txt', content: 'planted' });
      assert.ok(r.status >= 400, 'fallback write refused');
      outsideUntouched();
      console.log(`  ✅ ${label} swap after the check: opened file is verified before read/write`);
    }
  }

  // ── zero inode: only symlink-free paths are accepted ─────────────────────
  testHooks.disableProc = true;
  testHooks.zeroIno = true;
  testHooks.before = null;
  seed();
  symlinkSync(join(ROOT, 'a'), join(ROOT, 'alias'), 'dir');
  let r = await get(`/workspace/read?path=${q('a/f.txt')}`);
  assert.equal(r.status, 200, 'symlink-free path is accepted when the inode is unusable');
  r = await get(`/workspace/read?path=${q('alias/f.txt')}`);
  assert.ok(r.status >= 400, 'a path with a symlink component is refused when the inode is unusable');
  console.log('  ✅ unusable inode: symlink-free path accepted, symlinked path refused');
} finally {
  testHooks.before = null;
  testHooks.disableProc = false;
  testHooks.zeroIno = false;
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
}

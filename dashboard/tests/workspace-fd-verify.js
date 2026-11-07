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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync, renameSync, readdirSync, statSync, linkSync } from 'node:fs';
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
  rmSync(join(ROOT, 'c'), { recursive: true, force: true });
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
  mkdirSync(join(ROOT, 'c'), { recursive: true });
  writeFileSync(join(ROOT, 'c', 'y.txt'), 'inside\n');
}

// Replaces ROOT/a with a symlink to OUTSIDE once, at the given stage.
function armSwap(stage, op) {
  let done = false;
  testHooks.before = async (s, _abs, o) => {
    if (done || s !== stage || (op && o !== op)) return;
    done = true;
    renameSync(join(ROOT, 'a'), join(ROOT, 'a.orig'));
    symlinkSync(OUTSIDE, join(ROOT, 'a'), 'dir');
  };
}

// A failed check may leave an empty file behind in the fallback mode; it must never hold bytes.
function noBytesOutside(dir = OUTSIDE) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) noBytesOutside(full);
    else if (!['f.txt', 'gone.txt', 'mv.txt'].includes(e.name)) assert.equal(statSync(full).size, 0, `no bytes in ${full}`);
  }
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
      writeFileSync(join(ROOT, 'a', 'inside-only.txt'), '');
      writeFileSync(join(OUTSIDE, 'outside-only.txt'), '');
      armSwap('before-op');
      r = await get(`/workspace/ls?path=${q('a')}`);
      if (r.ok) {
        const names = (await r.json()).entries.map((e) => e.name);
        assert.ok(names.includes('inside-only.txt'), 'pinned list includes the inside entry');
        assert.ok(!names.includes('outside-only.txt'), 'pinned list excludes the outside entry');
      }
      console.log(`  ✅ ${label} swap after the check: operations stay on the pinned directory`);
    } else {
      // Without /proc a new file is created through the swapped path at worst, never with data.
      seed();
      armSwap('before-op', 'open');
      r = await post('/workspace/write', { path: 'a/b/new.txt', content: 'planted' });
      assert.ok(r.status >= 400, 'fallback new-file write refused');
      noBytesOutside();
      console.log(`  ✅ ${label} swap at the open seam: new-file write refused, no bytes outside`);
    }

    // ── opened-file verification on its own (parent checks pass) ────────────
    for (const [m, route] of [['write', 'write'], ['read', 'read']]) {
      seed();
      linkSync(join(ROOT, 'a', 'f.txt'), join(ROOT, 'a', 'keep.txt'));
      writeFileSync(join(ROOT, 'a', 'other.txt'), 'replacement\n');
      let done = false;
      testHooks.before = async (s) => {
        if (done || s !== 'after-open') return;
        done = true;
        renameSync(join(ROOT, 'a', 'other.txt'), join(ROOT, 'a', 'f.txt'));
      };
      r = m === 'write'
        ? await post('/workspace/write', { path: 'a/f.txt', content: 'planted' })
        : await get(`/workspace/read?path=${q('a/f.txt')}`);
      assert.equal(r.status, 400, `${label} ${route}: opened file that no longer matches the path is refused`);
      assert.ok(!(await r.text()).includes('inside'), 'no content returned');
      assert.equal(readFileSync(join(ROOT, 'a', 'keep.txt'), 'utf8'), 'inside\n', 'opened file was not truncated');
      assert.equal(readFileSync(join(ROOT, 'a', 'f.txt'), 'utf8'), 'replacement\n', 'replacement left alone');
    }
    console.log(`  ✅ ${label} opened-file verification refuses read/write when the path no longer matches`);

    // ── a parent that is a file is an invalid path ──────────────────────────
    seed();
    testHooks.before = null;
    for (const [name, call] of [
      ['read', () => get(`/workspace/read?path=${q('a/f.txt/x')}`)],
      ['write', () => post('/workspace/write', { path: 'a/f.txt/x', content: 'x' })],
      ['delete', () => del('a/f.txt/x')],
    ]) {
      r = await call();
      assert.equal(r.status, 400, `${label} ${name} under a file is 400`);
      assert.equal((await r.json()).error, 'Invalid path');
    }
    console.log(`  ✅ ${label} paths below a regular file return 400 Invalid path`);

    // ── rename: each parent checked separately ──────────────────────────────
    seed();
    armSwap('before-parent', 'rename-from');
    r = await post('/workspace/rename', { from: 'a/mv.txt', to: 'c/x.txt' });
    assert.ok(r.status >= 400, `${label} rename with a swapped source parent refused`);
    outsideUntouched();
    seed();
    armSwap('before-parent', 'rename-to');
    r = await post('/workspace/rename', { from: 'c/y.txt', to: 'a/z.txt' });
    assert.ok(r.status >= 400, `${label} rename with a swapped destination parent refused`);
    outsideUntouched();
    assert.ok(existsSync(join(ROOT, 'c', 'y.txt')), 'source kept');
    console.log(`  ✅ ${label} rename refuses a swapped source or destination parent`);
  }

  // ── strict mode: refuse everything that cannot be pinned ─────────────────
  testHooks.disableProc = true;
  testHooks.strict = true;
  for (const stage of ['before-parent', 'before-op']) {
    seed();
    armSwap(stage);
    let r = await del('a/gone.txt');
    assert.equal(r.status, 400, 'strict: delete refused');
    seed();
    armSwap(stage);
    r = await post('/workspace/mkdir', { path: 'a/b/made' });
    assert.equal(r.status, 400, 'strict: mkdir refused');
    seed();
    armSwap(stage);
    r = await post('/workspace/write', { path: 'a/b/new.txt', content: 'planted' });
    assert.equal(r.status, 400, 'strict: write refused');
    seed();
    armSwap(stage);
    r = await get(`/workspace/read?path=${q('a/f.txt')}`);
    assert.equal(r.status, 400, 'strict: read refused');
    seed();
    armSwap(stage);
    r = await post('/workspace/rename', { from: 'a/mv.txt', to: 'a/moved.txt' });
    assert.equal(r.status, 400, 'strict: rename refused');
    outsideUntouched();
  }
  testHooks.strict = null;
  console.log('  ✅ strict mode without /proc refuses delete/mkdir/write/read/rename even with a swap in the window');

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
  testHooks.strict = null;
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
}

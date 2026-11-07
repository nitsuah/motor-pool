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
import { readlinkSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync, renameSync, readdirSync, statSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createWorkspaceRouter } from '../routes/workspace.js';
import { testHooks, pinnedFsRequired, warnIfPinningOptOut, resetOptOutWarning } from '../modules/workspace-fs.js';

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

// Every path under dir with its type and size, to compare the whole outside state.
function treeOf(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = full.slice(base.length);
    if (e.isDirectory()) out.push(`${rel}/`, ...treeOf(full, base));
    else out.push(`${rel}:${statSync(full).size}`);
  }
  return out.sort();
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
    testHooks.strict = false;
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
      writeFileSync(join(ROOT, 'a', 'inside-only.txt'), '12345');
      writeFileSync(join(OUTSIDE, 'outside-only.txt'), '1234567890');
      writeFileSync(join(OUTSIDE, 'inside-only.txt'), '1234567890123');
      armSwap('before-op');
      r = await get(`/workspace/ls?path=${q('a')}`);
      assert.ok(r.ok, 'pinned list succeeds');
      {
        const names = (await r.clone().json()).entries.map((e) => e.name);
        assert.ok(names.includes('inside-only.txt'), 'pinned list includes the inside entry');
        const entry = (await r.clone().json()).entries.find((e) => e.name === 'inside-only.txt');
        assert.equal(entry.size, 5, 'size comes from the inside entry');
        assert.equal(entry.modified, statSync(join(ROOT, 'a.orig', 'inside-only.txt')).mtime.toISOString(), 'modified comes from the inside entry');
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

    if (mode.disableProc) {
      // Without pinning, a swap inside the window cannot be prevented for delete/mkdir/rename
      // (they are detected and refused afterwards); a new file never receives data.
      for (const [name, call] of [
        ['delete', () => del('a/gone.txt')],
        ['mkdir', () => post('/workspace/mkdir', { path: 'a/b/made' })],
        ['rename', () => post('/workspace/rename', { from: 'a/mv.txt', to: 'a/moved.txt' })],
        ['new file', () => post('/workspace/write', { path: 'a/b/new.txt', content: 'planted' })],
      ]) {
        seed();
        armSwap('before-op', name === 'new file' ? 'open' : undefined);
        const r = await call();
        assert.ok(r.status >= 400, `${label} ${name} in the window is refused`);
        noBytesOutside();
        assert.equal(readFileSync(join(OUTSIDE, 'f.txt'), 'utf8'), 'secret\n', `${label} ${name}: outside file content unchanged`);
      }
      console.log(`  ✅ ${label} mutations swapped inside the window are refused and carry no data outside`);
    }

    if (mode.disableProc) {
      // Limit of the fallback: a delete/mkdir/rename that lands in the window between the
      // last check and the operation cannot be prevented without openat(); it is detected
      // afterwards and refused. Only what is still true is asserted (no data outside, the
      // outside file contents unchanged). Strict mode (below) asserts the complete state.
      for (const [name, stageOp, call] of [
        ['rename source parent', 'rename-from', () => post('/workspace/rename', { from: 'a/mv.txt', to: 'c/x.txt' })],
        ['rename destination parent', 'rename-to', () => post('/workspace/rename', { from: 'c/y.txt', to: 'a/z.txt' })],
      ]) {
        seed();
        armSwap('before-op', stageOp);
        const r = await call();
        assert.ok(r.status >= 400, `${label} ${name} in the window is refused`);
        // Limit: a destination-parent swap can already have moved the source file outside; only the source case is checked for data.
        if (stageOp === 'rename-from') noBytesOutside();
        assert.equal(readFileSync(join(OUTSIDE, 'f.txt'), 'utf8'), 'secret\n', `${label} ${name}: outside file content unchanged`);
      }

      // Listing: a swap that is replaced by a different directory before the end of the read is refused.
      seed();
      writeFileSync(join(OUTSIDE, 'outside-only.txt'), '1234567890');
      let phase = 0;
      testHooks.before = async (st, _abs, o) => {
        if (o !== 'list') return;
        if (st === 'before-op' && phase === 0) {
          phase = 1;
          renameSync(join(ROOT, 'a'), join(ROOT, 'a.orig'));
          symlinkSync(OUTSIDE, join(ROOT, 'a'), 'dir');
        } else if (st === 'after-meta' && phase === 1) {
          phase = 2;
          rmSync(join(ROOT, 'a'), { force: true });
          mkdirSync(join(ROOT, 'a'));
          writeFileSync(join(ROOT, 'a', 'replacement.txt'), 'x');
        }
      };
      const lr = await get(`/workspace/ls?path=${q('a')}`);
      assert.equal(phase, 2, 'the swap and replacement ran');
      assert.equal(lr.status, 400, `${label} listing whose directory changed during the read is refused`);
      const lbody = await lr.text();
      assert.ok(!lbody.includes('outside-only') && !lbody.includes('entries'), 'no entries returned');
      // Limit: restoring the very same directory (same inode) inside the window is not distinguishable here.
      console.log(`  ✅ ${label} rename parents and a changed listing directory are refused`);
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

    // ── a hard link must not be written through ─────────────────────────────
    seed();
    testHooks.before = null;
    linkSync(join(OUTSIDE, 'f.txt'), join(ROOT, 'a', 'hl.txt'));
    r = await post('/workspace/write', { path: 'a/hl.txt', content: 'planted' });
    assert.equal(r.status, 400, `${label} write through a hard link is refused`);
    assert.equal(readFileSync(join(OUTSIDE, 'f.txt'), 'utf8'), 'secret\n', 'the other link target was not modified');
    r = await get(`/workspace/read?path=${q('a/f.txt')}`);
    assert.equal(r.status, 200, 'ordinary files are unaffected');
    console.log(`  ✅ ${label} writes through a hard link are refused`);

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

  // ── recursive delete walks through descriptors (Linux) ──────────────────
  if (process.platform === 'linux' && existsSync('/proc/self/fd')) {
    testHooks.disableProc = false;
    testHooks.strict = false;
    const mkTree = () => {
      seed();
      mkdirSync(join(ROOT, 'a', 'tree', 'sub'), { recursive: true });
      writeFileSync(join(ROOT, 'a', 'tree', 'sub', 'file.txt'), 'inside\n');
      writeFileSync(join(ROOT, 'a', 'tree', 'top.txt'), 'inside\n');
      writeFileSync(join(OUTSIDE, 'b', 'keep.txt'), 'keep\n');
    };
    const outsideKept = () => assert.equal(readFileSync(join(OUTSIDE, 'b', 'keep.txt'), 'utf8'), 'keep\n', 'outside contents survive');
    mkTree();
    testHooks.before = null;
    let dr = await del('a/tree');
    assert.equal(dr.status, 200, 'a normal tree is deleted');
    assert.ok(!existsSync(join(ROOT, 'a', 'tree')));

    // A child directory swapped for a symlink after it was seen as a directory.
    mkTree();
    let swapped = false;
    testHooks.before = async (st, _abs, o) => {
      if (swapped || st !== 'walk-entry' || o !== 'delete') return;
      swapped = true;
      renameSync(join(ROOT, 'a', 'tree', 'sub'), join(ROOT, 'a', 'tree', 'sub.orig'));
      symlinkSync(join(OUTSIDE, 'b'), join(ROOT, 'a', 'tree', 'sub'), 'dir');
    };
    dr = await del('a/tree');
    assert.ok(swapped, 'the swap ran mid-walk');
    assert.equal(dr.status, 400, 'a swapped child directory is refused');
    outsideKept();

    // A child directory already swapped when the walk lists it: only the link is removed.
    mkTree();
    swapped = false;
    testHooks.before = async (st, _abs, o) => {
      if (swapped || st !== 'walk' || o !== 'delete') return;
      swapped = true;
      renameSync(join(ROOT, 'a', 'tree', 'sub'), join(ROOT, 'a', 'tree', 'sub.orig'));
      symlinkSync(join(OUTSIDE, 'b'), join(ROOT, 'a', 'tree', 'sub'), 'dir');
    };
    dr = await del('a/tree');
    assert.ok(swapped, 'the swap ran before the listing');
    outsideKept();
    testHooks.before = null;

    // A tree deeper than the cap is refused before the deeper levels are opened.
    seed();
    const deep = join(ROOT, 'a', 'deep', ...Array.from({ length: 70 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(ROOT, 'a', 'deep', 'aaa-top.txt'), 'keep');
    dr = await del('a/deep');
    assert.equal(dr.status, 400, 'a tree deeper than the cap is refused');
    assert.ok(existsSync(join(ROOT, 'a', 'deep', 'aaa-top.txt')), 'a shallow file was not unlinked before the refusal');
    assert.ok(existsSync(deep), 'the deep levels were not touched');
    rmSync(join(ROOT, 'a', 'deep'), { recursive: true, force: true });
    console.log('  ✅ recursive delete never follows a directory swapped for a symlink mid-walk');
  }

  // ── without pinning, a recursive delete runs only under the explicit opt-out ──
  testHooks.strict = null;
  testHooks.disableProc = true;
  testHooks.before = null;
  seed();
  mkdirSync(join(ROOT, 'a', 'full'));
  writeFileSync(join(ROOT, 'a', 'full', 'x.txt'), 'x');
  testHooks.env = {};
  let dd = await del('a/full');
  assert.equal(dd.status, 400, 'delete refused by default without pinning');
  assert.ok(existsSync(join(ROOT, 'a', 'full', 'x.txt')), 'nothing was deleted');
  testHooks.env = { NODE_ENV: 'production', WORKSPACE_REQUIRE_PINNED_FS: 'off' };
  dd = await del('a/full');
  assert.equal(dd.status, 400, 'the opt-out is ignored in production');
  assert.ok(existsSync(join(ROOT, 'a', 'full', 'x.txt')), 'nothing was deleted in production');
  testHooks.env = { WORKSPACE_REQUIRE_PINNED_FS: 'off' };
  dd = await del('a/full');
  assert.equal(dd.status, 200, 'the explicit opt-out allows the recursive delete');
  testHooks.env = null;
  console.log('  ✅ unpinned recursive delete runs only under the explicit opt-out');

  // ── strict mode: refuse everything that cannot be pinned ─────────────────
  testHooks.disableProc = true;
  testHooks.strict = true;
  for (const stage of ['before-parent', 'before-op']) {
    const cases = [
      ['delete', () => del('a/gone.txt')],
      ['mkdir', () => post('/workspace/mkdir', { path: 'a/b/made' })],
      ['write', () => post('/workspace/write', { path: 'a/b/new.txt', content: 'planted' })],
      ['read', () => get(`/workspace/read?path=${q('a/f.txt')}`)],
      ['rename', () => post('/workspace/rename', { from: 'a/mv.txt', to: 'a/moved.txt' })],
      ['rename-dest-parent', () => post('/workspace/rename', { from: 'c/y.txt', to: 'a/z.txt' })],
      ['list', () => get(`/workspace/ls?path=${q('a')}`)],
    ];
    for (const [name, call] of cases) {
      seed();
      const snapshot = treeOf(OUTSIDE);
      armSwap(stage);
      const r = await call();
      assert.equal(r.status, 400, `strict ${stage}: ${name} refused`);
      assert.ok(!(await r.text()).includes('gone.txt'), `strict ${stage}: ${name} returned no outside names`);
      outsideUntouched();
      // Full state: deleted files still exist, no new files or directories, same sizes.
      assert.deepEqual(treeOf(OUTSIDE), snapshot, `strict ${stage}: ${name} left the outside tree unchanged`);
    }
  }
  // A swap that is replaced by a different directory (or restored) during a listing: strict never reads it.
  seed();
  writeFileSync(join(OUTSIDE, 'outside-only.txt'), '1234567890');
  let phase = 0;
  testHooks.before = async (st, _abs, o) => {
    if (o !== 'list') return;
    if (st === 'before-op' && phase === 0) {
      phase = 1;
      renameSync(join(ROOT, 'a'), join(ROOT, 'a.orig'));
      symlinkSync(OUTSIDE, join(ROOT, 'a'), 'dir');
    } else if (st === 'after-meta' && phase === 1) {
      phase = 2;
      rmSync(join(ROOT, 'a'), { force: true });
      renameSync(join(ROOT, 'a.orig'), join(ROOT, 'a'));
    }
  };
  const sr = await get(`/workspace/ls?path=${q('a')}`);
  assert.equal(sr.status, 400, 'strict listing without pinning is refused');
  assert.ok(!(await sr.text()).includes('outside-only'), 'no outside names returned');
  assert.equal(phase, 0, 'the listing was refused before any read');
  testHooks.before = null;
  testHooks.strict = null;
  console.log('  ✅ strict mode without /proc refuses delete/mkdir/write/read/rename/list even with a swap in the window');

  // ── zero inode: only symlink-free paths are accepted ─────────────────────
  testHooks.strict = false;
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

  // ── /proc present but the file descriptor lookup fails: refuse, no fallback ─
  if (process.platform === 'linux' && existsSync('/proc/self/fd')) {
    testHooks.disableProc = false;
    testHooks.strict = false;
    testHooks.before = null;
    seed();
    testHooks.procReadlink = (fd, kind) => {
      if (kind === 'file') throw new Error('lookup failed');
      return readlinkSync(`/proc/self/fd/${fd}`);
    };
    let lr = await get(`/workspace/read?path=${q('a/f.txt')}`);
    assert.equal(lr.status, 400, 'read refused when the descriptor lookup fails');
    assert.ok(!(await lr.text()).includes('inside'), 'no content returned');
    lr = await post('/workspace/write', { path: 'a/f.txt', content: 'planted' });
    assert.equal(lr.status, 400, 'write refused when the descriptor lookup fails');
    assert.equal(readFileSync(join(ROOT, 'a', 'f.txt'), 'utf8'), 'inside\n', 'file was not truncated or written');
    testHooks.procReadlink = null;
    lr = await get(`/workspace/read?path=${q('a/f.txt')}`);
    assert.equal(lr.status, 200, 'works again once the lookup works');
    console.log('  ✅ a failed descriptor lookup with /proc present is a refusal, not a fallback');
  }

  // ── /proc disappears after the strict check, before a listing reads anything ──
  if (process.platform === 'linux' && existsSync('/proc/self/fd')) {
    testHooks.env = {};
    testHooks.strict = null;
    testHooks.disableProc = false;
    seed();
    writeFileSync(join(OUTSIDE, 'outside-only.txt'), 'x');
    let gone = false;
    testHooks.before = async (st, _abs, o) => {
      if (gone || st !== 'before-parent' || o !== 'list') return;
      gone = true;
      testHooks.disableProc = true;
    };
    const lr2 = await get(`/workspace/ls?path=${q('a')}`);
    assert.ok(gone, 'pinning was lost before the listing');
    assert.equal(lr2.status, 400, 'listing refused when pinning is lost after the strict check');
    testHooks.before = null;
    testHooks.disableProc = false;

    // The first availability answer is true, the next false: the listing still refuses and returns nothing.
    seed();
    writeFileSync(join(OUTSIDE, 'outside-only.txt'), 'x');
    testHooks.procSequence = [true, false];
    const lr3 = await get(`/workspace/ls?path=${q('a')}`);
    testHooks.procSequence = null;
    assert.equal(lr3.status, 400, 'listing refused when availability flips between checks');
    const lbody3 = await lr3.text();
    assert.ok(!lbody3.includes('outside-only') && !lbody3.includes('entries'), 'no entries or outside names returned');
    console.log('  ✅ losing /proc after the strict check refuses a listing');
  }

  // ── strict is the default everywhere; the opt-out is local development only ──
  for (const platform of ['linux', 'win32', 'darwin']) {
    assert.equal(pinnedFsRequired({}, platform), true, `${platform} is strict by default`);
  }
  for (const v of ['0', 'false', 'no', 'off', ' OFF ', 'False']) {
    assert.equal(pinnedFsRequired({ WORKSPACE_REQUIRE_PINNED_FS: v }), false, `"${v}" opts out`);
  }
  for (const v of ['1', 'true', 'yes', 'on', ' TRUE ', '  ', 'bogus']) {
    assert.equal(pinnedFsRequired({ WORKSPACE_REQUIRE_PINNED_FS: v }), true, `"${v}" stays strict`);
  }
  assert.equal(pinnedFsRequired({ NODE_ENV: ' Production ', WORKSPACE_REQUIRE_PINNED_FS: 'off' }), true, 'the opt-out is ignored in production');
  assert.equal(pinnedFsRequired({ NODE_ENV: 'development', WORKSPACE_REQUIRE_PINNED_FS: 'off' }), false, 'the opt-out works in development');
  assert.equal(pinnedFsRequired({ HOST: '0.0.0.0', WORKSPACE_REQUIRE_PINNED_FS: '0' }), true, 'the opt-out is ignored for a non-loopback HOST');
  for (const h of ['127.0.0.1', '::1', '[::1]', 'localhost', ' LOCALHOST ', '']) {
    assert.equal(pinnedFsRequired({ HOST: h, WORKSPACE_REQUIRE_PINNED_FS: 'off' }), false, `loopback HOST "${h}" allows the opt-out`);
  }

  // Behaviour without /proc.
  testHooks.strict = null;
  testHooks.disableProc = true;
  testHooks.before = null;
  seed();
  const readOk = async () => (await get(`/workspace/read?path=${q('a/f.txt')}`)).status;
  for (const platform of ['linux', 'win32', 'darwin']) {
    testHooks.platform = platform;
    testHooks.env = {};
    assert.equal(await readOk(), 400, `${platform} without /proc refuses by default`);
    testHooks.env = { WORKSPACE_REQUIRE_PINNED_FS: ' Off ' };
    assert.equal(await readOk(), 200, `${platform}: the explicit opt-out uses the fallback`);
    testHooks.env = { NODE_ENV: 'Production ', WORKSPACE_REQUIRE_PINNED_FS: '0' };
    assert.equal(await readOk(), 400, `${platform}: the opt-out is ignored in production`);
    testHooks.env = { HOST: '0.0.0.0', WORKSPACE_REQUIRE_PINNED_FS: '0' };
    assert.equal(await readOk(), 400, `${platform}: the opt-out is ignored for a non-loopback HOST`);
    testHooks.env = { HOST: '127.0.0.1', WORKSPACE_REQUIRE_PINNED_FS: 'false' };
    assert.equal(await readOk(), 200, `${platform}: a loopback HOST allows the opt-out`);
  }
  testHooks.platform = null;
  console.log('  ✅ strict by default on every platform; opt-out ignored in production and for a non-loopback HOST');

  // ── one startup warning when the opt-out is active ───────────────────────
  const logged = [];
  resetOptOutWarning();
  testHooks.env = {};
  assert.equal(warnIfPinningOptOut((...a) => logged.push(a)), false, 'no warning in the default');
  testHooks.env = { NODE_ENV: 'production', WORKSPACE_REQUIRE_PINNED_FS: 'off' };
  assert.equal(warnIfPinningOptOut((...a) => logged.push(a)), false, 'no warning when the opt-out is ignored');
  testHooks.env = { WORKSPACE_REQUIRE_PINNED_FS: 'off' };
  assert.equal(warnIfPinningOptOut((...a) => logged.push(a)), true, 'warns when the opt-out is active');
  assert.equal(warnIfPinningOptOut((...a) => logged.push(a)), false, 'warns only once');
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 'warn');
  resetOptOutWarning();
  console.log('  ✅ the opt-out logs a single warning');

  // ── /proc disappearing mid-run: strict refuses instead of falling back ───
  if (process.platform === 'linux' && existsSync('/proc/self/fd')) {
    testHooks.env = {};
    testHooks.strict = null;
    testHooks.disableProc = false;
    seed();
    let lost = false;
    testHooks.before = async (st, _abs, o) => {
      if (lost || st !== 'after-open' || o !== 'open') return;
      lost = true;
      testHooks.disableProc = true;
    };
    let tr = await post('/workspace/write', { path: 'a/f.txt', content: 'planted' });
    assert.ok(lost, 'pinning was lost mid-request');
    assert.equal(tr.status, 400, 'write refused when pinning is lost after the open');
    assert.equal(readFileSync(join(ROOT, 'a', 'f.txt'), 'utf8'), 'inside\n', 'file untouched');

    testHooks.disableProc = false;
    seed();
    mkdirSync(join(ROOT, 'a', 'tree', 'sub'), { recursive: true });
    writeFileSync(join(ROOT, 'a', 'tree', 'sub', 'file.txt'), 'inside\n');
    lost = false;
    testHooks.before = async (st, _abs, o) => {
      if (lost || st !== 'before-op' || o !== 'delete') return;
      lost = true;
      testHooks.disableProc = true;
    };
    tr = await del('a/tree');
    assert.ok(lost, 'pinning was lost mid-delete');
    assert.equal(tr.status, 400, 'delete refused when pinning is lost');
    assert.ok(existsSync(join(ROOT, 'a', 'tree', 'sub', 'file.txt')), 'nothing was deleted');
    testHooks.before = null;
    testHooks.disableProc = false;
    console.log('  ✅ losing /proc mid-run refuses (strict) instead of falling back');
  }

  // ── a symlinked workspace root works for files directly under it ─────────
  testHooks.strict = null;
  testHooks.disableProc = false;
  testHooks.env = {};
  testHooks.before = null;
  if (process.platform === 'linux' && existsSync('/proc/self/fd')) {
    const linkRoot = join(tmpdir(), `ab-ws-linkroot-${process.pid}`);
    rmSync(linkRoot, { force: true });
    symlinkSync(ROOT, linkRoot, 'dir');
    writeFileSync(join(ROOT, 'top.txt'), 'top\n');
    const app2 = express();
    app2.use('/api', createWorkspaceRouter(linkRoot));
    const srv2 = app2.listen(0, '127.0.0.1');
    await new Promise((resolve) => srv2.once('listening', resolve));
    const b2 = `http://127.0.0.1:${srv2.address().port}/api`;
    try {
      const rr = await fetch(`${b2}/workspace/read?path=top.txt`);
      assert.equal(rr.status, 200, 'a file directly under a symlinked root can be read');
      assert.equal((await rr.json()).content, 'top\n');
      const ww = await fetch(`${b2}/workspace/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'top2.txt', content: 'x' }) });
      assert.equal(ww.status, 200, 'a file directly under a symlinked root can be written');
    } finally {
      srv2.close();
      rmSync(linkRoot, { force: true });
    }
    console.log('  ✅ a symlinked workspace root works');
  }
} finally {
  testHooks.platform = null;
  testHooks.env = null;
  testHooks.procReadlink = null;
  testHooks.procSequence = null;
  testHooks.before = null;
  testHooks.disableProc = false;
  testHooks.zeroIno = false;
  testHooks.strict = null;
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
}

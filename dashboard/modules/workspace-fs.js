/**
 * Descriptor-verified file operations for the workspace root.
 *
 * Callers resolve a path and check it against the workspace root (and keep
 * their own inline prefix check). Node has no openat(), so a directory on the
 * way to the file could still change between that check and the operation.
 * These helpers close the gap as far as Node allows by checking what was
 * actually opened:
 *
 *  - Linux (/proc available): the parent directory is opened first and its
 *    kernel path (/proc/self/fd/N) must be inside realpath(root). The final
 *    operation then runs relative to that descriptor (/proc/self/fd/N/name), so
 *    later changes to the path no longer matter. Opened files are verified the
 *    same way before any byte is read or written.
 *  - Elsewhere (Windows, macOS): the parent's realpath is checked immediately
 *    before and after the operation, and an opened file must have the same
 *    dev+ino as realpath(target), with realpath(target) inside the root. When
 *    the platform reports no usable inode (ino 0, as on some Windows volumes)
 *    the file is accepted only if no component below the root is a symlink.
 *    This mode cannot pin directories, so a change between the final check and
 *    the operation is detected afterwards rather than prevented. Set
 *    WORKSPACE_REQUIRE_PINNED_FS=1 to refuse every operation where pinning is
 *    unavailable instead of using this mode.
 *
 * Opening never truncates: callers truncate after the descriptor is verified.
 * Nothing is ever removed by path outside the root after a failed check.
 */
import { open, mkdir, readdir, rm, unlink, lstat, rename } from 'fs/promises';
import { realpathSync, lstatSync, statSync, readlinkSync, existsSync, constants as fsConstants } from 'fs';
import { resolve, relative, dirname, basename, join, sep, isAbsolute } from 'path';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW || 0;
const O_DIRECTORY = fsConstants.O_DIRECTORY || 0;

/** Test seam: `before(stage, abs)` runs between a check and the operation it guards. */
export const testHooks = { before: null, disableProc: false, zeroIno: false, strict: null };

export class WorkspaceVerifyError extends Error {
  constructor(message = 'Invalid path') {
    super(message);
    this.code = 'EWSVERIFY';
  }
}

function refuse() {
  throw new WorkspaceVerifyError();
}

async function seam(stage, abs, op) {
  if (testHooks.before) await testHooks.before(stage, abs, op);
}

function procAvailable() {
  return !testHooks.disableProc && process.platform === 'linux' && existsSync('/proc/self/fd');
}

/** Fail closed when pinned operations are required and /proc is unavailable. */
function requirePin() {
  const strict = testHooks.strict ?? process.env.WORKSPACE_REQUIRE_PINNED_FS === '1';
  if (strict && !procAvailable()) refuse();
}

function procPathOfFd(fd) {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/** path.relative containment: refuses '' (unless allowRoot), '..', '../x' and absolute results. */
function insideReal(rootReal, p, allowRoot) {
  const rel = relative(rootReal, p);
  if (rel === '') return !!allowRoot;
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
  return true;
}

function lexicalRoot(root, abs) {
  if (!root || typeof abs !== 'string') refuse();
  const r = resolve(root);
  const prefix = r.endsWith(sep) ? r : r + sep;
  if (abs !== r && !abs.startsWith(prefix)) refuse();
  return r;
}

function realRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    return refuse();
  }
}

function assertRealInside(rootReal, p, allowRoot) {
  let real;
  try {
    real = realpathSync(p);
  } catch {
    return refuse();
  }
  if (!insideReal(rootReal, real, allowRoot)) refuse();
}

/** True when no component below the lexical root down to abs is a symlink. */
function hasNoSymlinkComponents(rootLex, abs) {
  const parts = relative(rootLex, abs).split(sep).filter(Boolean);
  let cur = rootLex;
  for (const part of parts) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function verifyFd(fh, rootLex, rootReal, abs) {
  const kernelPath = procAvailable() ? procPathOfFd(fh.fd) : null;
  if (kernelPath !== null) {
    if (kernelPath.endsWith(' (deleted)') || !insideReal(rootReal, kernelPath, false)) refuse();
    return;
  }
  // Fallback: same file as realpath(target), and that path is inside the root.
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return refuse();
  }
  if (!insideReal(rootReal, real, false)) refuse();
  const opened = await fh.stat({ bigint: true });
  const target = statSync(real, { bigint: true });
  if (testHooks.zeroIno || opened.ino === 0n || target.ino === 0n) {
    // Identity cannot be compared on this platform: require a symlink-free path.
    if (!hasNoSymlinkComponents(rootLex, abs)) refuse();
    return;
  }
  if (opened.dev !== target.dev || opened.ino !== target.ino) refuse();
}

/**
 * Pins the parent directory of abs and runs fn(pathToChild). With /proc the
 * child path is relative to the verified descriptor; otherwise it is abs, with
 * the parent's realpath checked right before and right after.
 */
async function withParent(root, abs, fn, op = 'op') {
  const rootLex = lexicalRoot(root, abs);
  if (abs === rootLex) refuse();
  requirePin();
  const rootReal = realRoot(root);
  const parent = dirname(abs);
  await seam('before-parent', abs, op);
  let dirFh = null;
  let base = parent;
  if (procAvailable()) {
    dirFh = await open(parent, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const kernelPath = procPathOfFd(dirFh.fd);
    if (kernelPath === null || !insideReal(rootReal, kernelPath, true)) {
      await dirFh.close().catch(() => {});
      refuse();
    }
    base = `/proc/self/fd/${dirFh.fd}`;
  } else {
    assertRealInside(rootReal, parent, true);
  }
  try {
    if (!dirFh) assertRealInside(rootReal, parent, true);
    await seam('before-op', abs, op);
    const result = await fn(join(base, basename(abs)));
    if (!dirFh) assertRealInside(rootReal, parent, true);
    return result;
  } finally {
    await dirFh?.close().catch(() => {});
  }
}

/**
 * Opens abs (never following a final symlink) and verifies the descriptor is
 * inside the root before returning it. No truncation happens here.
 */
export async function openInside(root, abs, flags, mode = 0o666) {
  const rootLex = lexicalRoot(root, abs);
  // Truncation must wait until the descriptor has been verified.
  if (flags & fsConstants.O_TRUNC) refuse();
  const rootReal = realRoot(root);
  let fh = null;
  try {
    await withParent(root, abs, async (p) => {
      fh = await open(p, flags | O_NOFOLLOW, mode);
    }, 'open');
    await seam('after-open', abs, 'open');
    await verifyFd(fh, rootLex, rootReal, abs);
  } catch (err) {
    await fh?.close().catch(() => {});
    throw err;
  }
  return fh;
}

/** mkdir -p for a directory inside the root (the root itself is never a target). */
export async function mkdirInside(root, abs) {
  const rootLex = lexicalRoot(root, abs);
  if (abs === rootLex) refuse();
  requirePin();
  const rootReal = realRoot(root);
  await seam('before-parent', abs, 'mkdir');
  // Deepest component that already exists; everything below it is new.
  let anc = abs;
  const rest = [];
  for (;;) {
    try {
      lstatSync(anc);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      rest.unshift(basename(anc));
      const up = dirname(anc);
      if (up === anc) refuse();
      anc = up;
    }
  }
  assertRealInside(rootReal, anc, true);
  if (rest.length === 0) {
    // Already exists: nothing to create, it only has to be a directory.
    if (!statSync(abs).isDirectory()) refuse();
    return;
  }
  if (!procAvailable()) {
    await seam('before-op', abs, 'mkdir');
    await mkdir(abs, { recursive: true });
    assertRealInside(rootReal, abs, true);
    return;
  }
  // Create one component at a time, each relative to a verified directory descriptor.
  let dirFh = await open(realpathSync(anc), fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    for (const name of rest) {
      const kernelPath = procPathOfFd(dirFh.fd);
      if (kernelPath === null || !insideReal(rootReal, kernelPath, true)) refuse();
      await seam('before-op', abs, 'mkdir');
      const childPath = join(`/proc/self/fd/${dirFh.fd}`, name);
      await mkdir(childPath);
      const next = await open(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      await dirFh.close().catch(() => {});
      dirFh = next;
    }
    const kernelPath = procPathOfFd(dirFh.fd);
    if (kernelPath === null || !insideReal(rootReal, kernelPath, true)) refuse();
  } finally {
    await dirFh.close().catch(() => {});
  }
  assertRealInside(rootReal, abs, true);
}

/** Removes a file or directory tree inside the root; refuses the root and symlinks. */
export async function removeInside(root, abs) {
  return withParent(root, abs, async (p) => {
    const l = await lstat(p);
    if (l.isSymbolicLink()) refuse();
    if (l.isDirectory()) await rm(p, { recursive: true, force: true });
    else await unlink(p);
  }, 'delete');
}

/** Renames inside the root; neither end may be the root or a symlink. */
export async function renameInside(root, from, to) {
  return withParent(root, from, (pFrom) => withParent(root, to, async (pTo) => {
    if ((await lstat(pFrom)).isSymbolicLink()) refuse();
    try {
      if ((await lstat(pTo)).isSymbolicLink()) refuse();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await rename(pFrom, pTo);
  }, 'rename-to'), 'rename-from');
}

/**
 * Lists a directory inside the root (the root itself is allowed). Returns
 * { name, isDirectory, size, mtime } read through the same pinned directory.
 */
export async function readdirInside(root, abs) {
  lexicalRoot(root, abs);
  requirePin();
  const rootReal = realRoot(root);
  await seam('before-parent', abs, 'list');
  assertRealInside(rootReal, abs, true);
  let dirFh = null;
  let base = abs;
  if (procAvailable()) {
    dirFh = await open(realpathSync(abs), fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const kernelPath = procPathOfFd(dirFh.fd);
    if (kernelPath === null || !insideReal(rootReal, kernelPath, true)) {
      await dirFh.close().catch(() => {});
      refuse();
    }
    base = `/proc/self/fd/${dirFh.fd}`;
  }
  try {
    await seam('before-op', abs, 'list');
    const entries = await readdir(base, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const info = { name: e.name, isDirectory: e.isDirectory() };
      if (!info.isDirectory) {
        try {
          // lstat: a symlink entry reports itself, never its target.
          const st = await lstat(join(base, e.name));
          info.size = st.size;
          info.mtime = st.mtime;
        } catch { /* entry vanished: list it without metadata */ }
      }
      out.push(info);
    }
    if (!dirFh) assertRealInside(rootReal, abs, true);
    return out;
  } finally {
    await dirFh?.close().catch(() => {});
  }
}

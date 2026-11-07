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
export const testHooks = { before: null, disableProc: false, zeroIno: false };

export class WorkspaceVerifyError extends Error {
  constructor(message = 'Invalid path') {
    super(message);
    this.code = 'EWSVERIFY';
  }
}

function refuse() {
  throw new WorkspaceVerifyError();
}

async function seam(stage, abs) {
  if (testHooks.before) await testHooks.before(stage, abs);
}

function procAvailable() {
  return !testHooks.disableProc && process.platform === 'linux' && existsSync('/proc/self/fd');
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
async function withParent(root, abs, fn) {
  const rootLex = lexicalRoot(root, abs);
  if (abs === rootLex) refuse();
  const rootReal = realRoot(root);
  const parent = dirname(abs);
  await seam('before-parent', abs);
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
    await seam('before-op', abs);
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
  const rootReal = realRoot(root);
  const fh = await withParent(root, abs, (p) => open(p, flags | O_NOFOLLOW, mode));
  try {
    await verifyFd(fh, rootLex, rootReal, abs);
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
  return fh;
}

/** mkdir -p for a directory inside the root (the root itself is never a target). */
export async function mkdirInside(root, abs) {
  const rootLex = lexicalRoot(root, abs);
  if (abs === rootLex) refuse();
  const rootReal = realRoot(root);
  await seam('before-parent', abs);
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
  if (rest.length === 0 || !procAvailable()) {
    if (rest.length) assertRealInside(rootReal, anc, true);
    await seam('before-op', abs);
    await mkdir(abs, { recursive: true });
    assertRealInside(rootReal, abs, true);
    return;
  }
  const dirFh = await open(realpathSync(anc), fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const kernelPath = procPathOfFd(dirFh.fd);
    if (kernelPath === null || !insideReal(rootReal, kernelPath, true)) refuse();
    await seam('before-op', abs);
    await mkdir(join(`/proc/self/fd/${dirFh.fd}`, ...rest), { recursive: true });
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
  });
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
  }));
}

/** Lists a directory inside the root (the root itself is allowed). */
export async function readdirInside(root, abs) {
  lexicalRoot(root, abs);
  const rootReal = realRoot(root);
  await seam('before-parent', abs);
  assertRealInside(rootReal, abs, true);
  if (!procAvailable()) {
    assertRealInside(rootReal, abs, true);
    await seam('before-op', abs);
    const entries = await readdir(abs, { withFileTypes: true });
    assertRealInside(rootReal, abs, true);
    return entries;
  }
  const dirFh = await open(realpathSync(abs), fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const kernelPath = procPathOfFd(dirFh.fd);
    if (kernelPath === null || !insideReal(rootReal, kernelPath, true)) refuse();
    await seam('before-op', abs);
    return await readdir(`/proc/self/fd/${dirFh.fd}`, { withFileTypes: true });
  } finally {
    await dirFh.close().catch(() => {});
  }
}

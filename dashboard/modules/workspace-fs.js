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
 *  - Without /proc: every operation is refused by default, on every platform.
 *    Setting WORKSPACE_REQUIRE_PINNED_FS to 0/false/no/off (local development
 *    only) selects a best-effort mode instead: the parent's realpath is checked
 *    right before and right after the operation, and an opened file must
 *    match realpath(target) by dev+ino and lie inside the root (with an
 *    unusable inode, only a symlink-free path is accepted). Directories cannot
 *    be pinned there, so a change inside the window between the last check and
 *    the operation is NOT prevented: a delete, mkdir or rename can change files
 *    outside the workspace before the request fails, and a directory that is
 *    swapped and restored (same inode) during a listing is not detected. The
 *    opt-out is ignored, and operations stay refused, when NODE_ENV is
 *    production or the dashboard HOST is not loopback. It is checked on every
 *    call, so losing /proc mid-run refuses instead of falling back.
 *
 * Opening never truncates: callers truncate after the descriptor is verified.
 * Nothing is ever removed by path outside the root after a failed check.
 */
import { open, mkdir, readdir, rm, rmdir, unlink, lstat, rename } from 'fs/promises';
import { realpathSync, lstatSync, statSync, readlinkSync, existsSync, constants as fsConstants } from 'fs';
import { logStructured } from './logger.js';
import { resolve, relative, dirname, basename, join, sep, isAbsolute } from 'path';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW || 0;
const O_DIRECTORY = fsConstants.O_DIRECTORY || 0;

/** Test seam: `before(stage, abs)` runs between a check and the operation it guards. */
export const testHooks = { before: null, disableProc: false, zeroIno: false, strict: null, platform: null, env: null, procReadlink: null };

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

const currentPlatform = () => testHooks.platform || process.platform;

function procAvailable() {
  return !testHooks.disableProc && currentPlatform() === 'linux' && existsSync('/proc/self/fd');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']);
const OFF_VALUES = ['false', '0', 'no', 'off'];

/**
 * Whether operations that cannot be pinned must be refused. Strict is the
 * default everywhere. WORKSPACE_REQUIRE_PINNED_FS=0/false/no/off (trimmed,
 * case-insensitive) opts out for local development, but the opt-out is ignored
 * when NODE_ENV is production or HOST is not a loopback address.
 */
export function pinnedFsRequired(env = process.env) {
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production') return true;
  const host = String(env.HOST ?? '').trim().toLowerCase();
  if (host !== '' && !LOOPBACK_HOSTS.has(host)) return true;
  return !OFF_VALUES.includes(String(env.WORKSPACE_REQUIRE_PINNED_FS ?? '').trim().toLowerCase());
}

let optOutWarned = false;

/** Logs one warning when the local-development opt-out is active. Returns true when it logged. */
export function warnIfPinningOptOut(log = logStructured) {
  if (optOutWarned || pinnedFsRequired(testHooks.env || process.env)) return false;
  optOutWarned = true;
  log('warn', 'workspace_pinning_opt_out', {
    message: 'WORKSPACE_REQUIRE_PINNED_FS is off: workspace file operations use unpinned checks (local development only).',
  });
  return true;
}

export function resetOptOutWarning() {
  optOutWarned = false;
}

/** Fail closed when pinned operations are required and /proc is unavailable. */
function requirePin() {
  const strict = testHooks.strict ?? pinnedFsRequired(testHooks.env || process.env);
  if (strict && !procAvailable()) refuse();
}

function procPathOfFd(fd, kind = 'dir') {
  try {
    if (testHooks.procReadlink) return testHooks.procReadlink(fd, kind);
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
  if (procAvailable()) {
    // With /proc present a failed lookup is a failed verification, never a reason to fall back.
    const kernelPath = procPathOfFd(fh.fd, 'file');
    if (kernelPath === null || kernelPath.endsWith(' (deleted)') || !insideReal(rootReal, kernelPath, false)) refuse();
    return;
  }
  // Fallback: only reachable under the explicit opt-out; strict mode refuses if /proc went away mid-run.
  requirePin();
  // Same file as realpath(target), and that path is inside the root.
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
    if (!dirFh) {
      requirePin();
      assertRealInside(rootReal, parent, true);
    }
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
    // A hard link could reach an inode that also lives outside the root: never write through one.
    if (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) {
      if ((await fh.stat()).nlink > 1) refuse();
    }
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
    requirePin();
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
  requirePin();
  const rootReal = realRoot(root);
  return withParent(root, abs, async (p) => {
    const l = await lstat(p);
    if (l.isSymbolicLink()) refuse();
    if (!l.isDirectory()) {
      await unlink(p);
      return;
    }
    if (procAvailable()) {
      await removeTreeAt(p, rootReal);
      return;
    }
    // Unpinned (explicit local-development opt-out only): the walk is by path and cannot be made safe.
    requirePin();
    await rm(p, { recursive: true, force: true });
  }, 'delete');
}

/**
 * Removes the directory at dirPath (a /proc/self/fd/N/<name> path) by walking it through
 * descriptors: every child directory is opened without following symlinks and its kernel
 * path checked against the root, and entries are removed relative to that descriptor.
 */
const MAX_DELETE_DEPTH = 64;

async function removeTreeAt(dirPath, rootReal, depth = 0) {
  if (depth >= MAX_DELETE_DEPTH) refuse();
  const fh = await open(dirPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const kernelPath = procPathOfFd(fh.fd);
    if (kernelPath === null || !insideReal(rootReal, kernelPath, false)) refuse();
    const base = `/proc/self/fd/${fh.fd}`;
    await seam('walk', kernelPath, 'delete');
    for (const name of await readdir(base)) {
      const child = join(base, name);
      const l = await lstat(child);
      if (l.isDirectory()) {
        await seam('walk-entry', join(kernelPath, name), 'delete');
        await removeTreeAt(child, rootReal, depth + 1);
      } else {
        await unlink(child);
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }
  await rmdir(dirPath);
}

/** Renames inside the root; neither end may be the root or a symlink. */
export async function renameInside(root, from, to) {
  requirePin();
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
  // Without pinning, the directory must be the same one before and after the entries are read.
  const identity = () => {
    const real = realpathSync(abs);
    const st = statSync(real, { bigint: true });
    return `${real}|${st.dev}:${st.ino}`;
  };
  const before = dirFh ? null : identity();
  try {
    await seam('before-op', abs, 'list');
    const entries = await readdir(base, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const info = { name: e.name, isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() };
      if (!info.isDirectory) {
        try {
          // lstat: a symlink entry reports itself, never its target.
          const st = await lstat(join(base, e.name));
          info.size = st.size;
          info.mtime = st.mtime;
          info.birthtime = st.birthtime;
        } catch { /* entry vanished: list it without metadata */ }
      }
      out.push(info);
    }
    if (!dirFh) {
      await seam('after-meta', abs, 'list');
      assertRealInside(rootReal, abs, true);
      if (identity() !== before) refuse();
    }
    return out;
  } finally {
    await dirFh?.close().catch(() => {});
  }
}

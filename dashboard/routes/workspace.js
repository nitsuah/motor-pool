import express from 'express';
import { stat, lstat } from 'fs/promises';
import { resolve as resolvePath, relative as relativePath, dirname, basename, sep } from 'path';
import { realpathSync, lstatSync, constants as fsConstants } from 'fs';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { shellExecEnabled } from '../modules/exec-flag.js';
import { openInside, mkdirInside, removeInside, renameInside, readdirInside, warnIfPinningOptOut } from '../modules/workspace-fs.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// File operations go through modules/workspace-fs.js, which verifies the opened
// descriptor (or the pinned parent directory) against the workspace root.
// Where O_NOFOLLOW is unavailable (Windows) the lstat checks below and the
// helper's fallback verification are the guard.
const refused = (err) => err.code === 'ELOOP' || err.code === 'ENOTDIR' || err.code === 'EWSVERIFY';

// True when the final component of abs is a symlink (a missing path is not).
async function isSymlink(abs) {
  try {
    return (await lstat(abs)).isSymbolicLink();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

const BASH_BLOCKLIST = ['rm -rf /', 'dd if=', ':(){ :|:& };:', '> /dev/sd', 'mkfs'];

// Resolves symlinks on the deepest existing ancestor of abs and checks that the
// real location is the root or below it. A dangling symlink is refused because
// its target cannot be checked.
// abs is validated by resolveWorkspacePath() to be within WORKSPACE_ROOT before calling.
function isRealPathInside(root, abs) {
  // Defensive: ensure abs is absolute and within root before any filesystem ops
  if (!abs || typeof abs !== 'string') return false;
  const lexicalRoot = resolvePath(root);
  const lexicalPrefix = lexicalRoot.endsWith(sep) ? lexicalRoot : lexicalRoot + sep;
  if (abs !== lexicalRoot && !abs.startsWith(lexicalPrefix)) return false;
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    return false;
  }
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  let probe = abs;
  const tail = [];
  for (;;) {
    // The root itself is substituted with the trusted constant; any other probe must sit below it.
    const p = probe === lexicalRoot ? lexicalRoot : (probe.startsWith(lexicalPrefix) ? probe : null);
    if (p === null) return false;
    try {
      const real = realpathSync(p);
      const full = tail.length ? resolvePath(real, ...tail) : real;
      return full === rootReal || full.startsWith(rootPrefix);
    } catch {
      try {
        lstatSync(p);
        return false;
      } catch { /* does not exist: check the parent */ }
      const parent = dirname(probe);
      if (parent === probe) return false;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

export function createWorkspaceRouter(WORKSPACE_ROOT) {
  const router = express.Router();
  if (WORKSPACE_ROOT) warnIfPinningOptOut();
  const ROOT_ABS = WORKSPACE_ROOT ? resolvePath(WORKSPACE_ROOT) : null;
  const ROOT_PREFIX = ROOT_ABS && (ROOT_ABS.endsWith(sep) ? ROOT_ABS : ROOT_ABS + sep);

  function resolveWorkspacePath(reqPath) {
    if (!WORKSPACE_ROOT || typeof reqPath !== 'string') return null;
    if (reqPath.includes('\0')) return null;
    const safe = reqPath ? reqPath.replace(/\\/g, '/').replace(/^\/+/, '') : '';
    const rootAbs = resolvePath(WORKSPACE_ROOT);
    const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
    const abs = resolvePath(rootAbs, safe);
    // The containment check and the returned value are the same resolved string.
    if (abs !== rootAbs && !abs.startsWith(rootPrefix)) return null;
    if (!isRealPathInside(WORKSPACE_ROOT, abs)) return null;
    return abs;
  }

  async function gitInWorkspace(...args) {
    const { stdout } = await execFileAsync('git', args, { cwd: WORKSPACE_ROOT });
    return stdout.trim();
  }

  router.get('/workspace/status', async (req, res) => {
    if (!WORKSPACE_ROOT) {
      return res.json({ configured: false });
    }
    try {
      await stat(WORKSPACE_ROOT);
    } catch {
      return res.json({ configured: false, error: 'WORKSPACE_ROOT path does not exist' });
    }

    let git = { repo: false };
    try {
      const branch = await gitInWorkspace('rev-parse', '--abbrev-ref', 'HEAD');
      const dirtyOut = await gitInWorkspace('status', '--porcelain');
      let ahead = 0;
      try {
        const aheadOut = await gitInWorkspace('rev-list', '--count', '@{u}..HEAD');
        ahead = parseInt(aheadOut, 10) || 0;
      } catch { /* no upstream */ }
      git = { repo: true, branch, dirty: dirtyOut.length > 0, ahead };
    } catch { /* not a git repo */ }

    res.json({ configured: true, root: WORKSPACE_ROOT, git });
  });

  router.get('/workspace/ls', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const abs = resolveWorkspacePath(req.query.path || '');
    if (!abs) return res.status(400).json({ error: 'Invalid path' });
    // The root is a valid listing target: it is replaced by the trusted constant.
    let dir;
    if (abs === ROOT_ABS) dir = ROOT_ABS;
    else if (abs.startsWith(ROOT_PREFIX)) dir = abs;
    else return res.status(400).json({ error: 'Invalid path' });

    try {
      const entries = await readdirInside(WORKSPACE_ROOT, dir);
      const result = entries.map((e) => {
        const info = { name: e.name, type: e.isDirectory ? 'dir' : 'file' };
        if (!e.isDirectory && e.mtime) {
          info.size = e.size;
          info.modified = e.mtime.toISOString();
        }
        return info;
      });
      result.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ path: relativePath(WORKSPACE_ROOT, dir) || '.', entries: result });
    } catch (err) {
      if (refused(err)) return res.status(400).json({ error: 'Invalid path' });
      res.status(404).json({ error: err.message });
    }
  });

  router.get('/workspace/read', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const abs = resolveWorkspacePath(req.query.path || '');
    if (!abs || abs === ROOT_ABS) return res.status(400).json({ error: 'Invalid path' }); // the root itself is never a target (also when it is a filesystem root)
    if (!abs.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: 'Invalid path' });

    let fh;
    try {
      const l = await lstat(abs);
      if (l.isSymbolicLink()) return res.status(400).json({ error: 'Invalid path' });
      if (l.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
      // Read through the verified handle that was opened without following symlinks.
      fh = await openInside(WORKSPACE_ROOT, abs, fsConstants.O_RDONLY);
      const s = await fh.stat();
      if (s.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
      if (s.size > 1024 * 1024) return res.status(413).json({ error: 'File too large (> 1 MB)' });
      const content = await fh.readFile('utf8');
      res.json({ path: relativePath(WORKSPACE_ROOT, abs), content });
    } catch (err) {
      if (refused(err)) return res.status(400).json({ error: 'Invalid path' });
      res.status(404).json({ error: err.message });
    } finally {
      await fh?.close().catch(() => {});
    }
  });

  router.post('/workspace/write', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { path: reqPath, content } = req.body || {};
    if (!reqPath || content === undefined) {
      return res.status(400).json({ error: 'path and content are required' });
    }
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
    const abs = resolveWorkspacePath(reqPath);
    if (!abs || abs === ROOT_ABS) return res.status(400).json({ error: 'Invalid path' }); // the root itself is never a target (also when it is a filesystem root)
    if (!abs.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: 'Invalid path' });
    const parentAbs = resolvePath(abs, '..');

    let fh;
    try {
      if (parentAbs !== ROOT_ABS) {
        if (!parentAbs.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: 'Invalid path' });
        if (!isRealPathInside(WORKSPACE_ROOT, parentAbs)) return res.status(400).json({ error: 'Invalid path' });
        await mkdirInside(WORKSPACE_ROOT, parentAbs);
      }
      if (await isSymlink(abs)) return res.status(400).json({ error: 'Invalid path' });
      // Open without truncating; verify the descriptor; only then truncate and write.
      fh = await openInside(WORKSPACE_ROOT, abs, fsConstants.O_WRONLY | fsConstants.O_CREAT, 0o666);
      await fh.truncate(0);
      await fh.writeFile(content, 'utf8');
      res.json({ path: relativePath(WORKSPACE_ROOT, abs), bytes: Buffer.byteLength(content, 'utf8') });
    } catch (err) {
      if (refused(err)) return res.status(400).json({ error: 'Invalid path' });
      res.status(500).json({ error: err.message });
    } finally {
      await fh?.close().catch(() => {});
    }
  });

  router.get('/workspace/git/status', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    try {
      const porcelain = await gitInWorkspace('status', '--porcelain');
      const branch = await gitInWorkspace('rev-parse', '--abbrev-ref', 'HEAD');
      const files = porcelain.split('\n').filter(Boolean).map(line => ({
        status: line.slice(0, 2).trim(),
        file: line.slice(3),
      }));
      res.json({ branch, files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/git/commit', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { message, files } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });

    try {
      if (Array.isArray(files) && files.length > 0) {
        for (const f of files) {
          const abs = resolveWorkspacePath(f);
          if (!abs || abs === ROOT_ABS) return res.status(400).json({ error: `Invalid path: ${f}` }); // the root itself is never a target (also when it is a filesystem root)
          if (!abs.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: `Invalid path: ${f}` });
          await execFileAsync('git', ['--literal-pathspecs', 'add', '--', abs], { cwd: WORKSPACE_ROOT });
        }
      } else {
        await execFileAsync('git', ['add', '-A'], { cwd: WORKSPACE_ROOT });
      }
      await execFileAsync('git', ['commit', '-m', String(message)], { cwd: WORKSPACE_ROOT });
      const sha = await gitInWorkspace('rev-parse', '--short', 'HEAD');
      const branch = await gitInWorkspace('rev-parse', '--abbrev-ref', 'HEAD');
      res.json({ sha, branch, message });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/git/push', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    try {
      const branch = await gitInWorkspace('rev-parse', '--abbrev-ref', 'HEAD');
      await execFileAsync('git', ['push'], { cwd: WORKSPACE_ROOT });
      res.json({ branch });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/exec', express.json(), async (req, res) => {
    if (!shellExecEnabled()) {
      return res.status(403).json({ error: 'Shell execution is disabled. Set WORKSPACE_EXEC=1 to enable it.' });
    }
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command is required' });
    if (BASH_BLOCKLIST.some(p => String(command).includes(p))) {
      return res.status(403).json({ error: 'Command blocked by safety policy' });
    }
    try {
      const { stdout, stderr } = await execAsync(String(command), { cwd: WORKSPACE_ROOT, timeout: 30000, shell: true });
      res.json({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
    } catch (err) {
      res.json({ stdout: (err.stdout || '').trim(), stderr: (err.stderr || err.message).trim(), exitCode: err.code || 1 });
    }
  });

  router.delete('/workspace/file', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const abs = resolveWorkspacePath(req.query.path || '');
    // strictly below the root: the workspace root itself is never deleted
    if (!abs || abs === ROOT_ABS) return res.status(400).json({ error: 'Invalid path' }); // the root itself is never a target (also when it is a filesystem root)
    if (!abs.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: 'Invalid path' });
    try {
      // Re-check right before the destructive call; never delete through a symlink.
      if (!isRealPathInside(WORKSPACE_ROOT, abs)) return res.status(400).json({ error: 'Invalid path' });
      if (await isSymlink(abs)) return res.status(400).json({ error: 'Invalid path' });
      await removeInside(WORKSPACE_ROOT, abs);
      res.json({ deleted: relativePath(WORKSPACE_ROOT, abs) });
    } catch (err) {
      if (refused(err)) return res.status(400).json({ error: 'Invalid path' });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/mkdir', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const abs = resolveWorkspacePath(req.body?.path || '');
    if (!abs || abs === ROOT_ABS) return res.status(400).json({ error: 'Invalid path' }); // the root itself is never a target (also when it is a filesystem root)
    if (!abs.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: 'Invalid path' });
    try {
      await mkdirInside(WORKSPACE_ROOT, abs);
      res.json({ path: relativePath(WORKSPACE_ROOT, abs) });
    } catch (err) {
      if (refused(err)) return res.status(400).json({ error: 'Invalid path' });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/rename', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { from: fromPath, to: toPath } = req.body || {};
    const absFrom = resolveWorkspacePath(fromPath || '');
    const absTo = resolveWorkspacePath(toPath || '');
    if (!absFrom || absFrom === ROOT_ABS) return res.status(400).json({ error: 'Invalid path' }); // the root itself is never a target (also when it is a filesystem root)
    if (!absFrom.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: 'Invalid path' });
    if (!absTo || absTo === ROOT_ABS) return res.status(400).json({ error: 'Invalid path' }); // the root itself is never a target (also when it is a filesystem root)
    if (!absTo.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: 'Invalid path' });
    try {
      // Re-check right before the move; neither end may be a symlink.
      if (!isRealPathInside(WORKSPACE_ROOT, absFrom) || !isRealPathInside(WORKSPACE_ROOT, absTo)) {
        return res.status(400).json({ error: 'Invalid path' });
      }
      if (await isSymlink(absFrom) || await isSymlink(absTo)) return res.status(400).json({ error: 'Invalid path' });
      await renameInside(WORKSPACE_ROOT, absFrom, absTo);
      res.json({ from: relativePath(WORKSPACE_ROOT, absFrom), to: relativePath(WORKSPACE_ROOT, absTo) });
    } catch (err) {
      if (refused(err)) return res.status(400).json({ error: 'Invalid path' });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/search', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query is required' });
    try {
      const { stdout } = await execFileAsync(
        'grep',
        ['-rl', '--exclude-dir=.git', '--exclude-dir=node_modules', '-e', String(query), '.'],
        { cwd: WORKSPACE_ROOT, timeout: 10000 }
      );
      const files = stdout.split('\n').map(f => f.replace(/^\.\//, '')).filter(Boolean);
      res.json({ query, files });
    } catch (err) {
      if (err.code === 1) return res.json({ query, files: [] });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/workspace/git/branches', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    try {
      const localOut = await gitInWorkspace('branch', '--format=%(refname:short)');
      const current = await gitInWorkspace('rev-parse', '--abbrev-ref', 'HEAD');
      let remotes = [];
      try {
        const remoteOut = await gitInWorkspace('branch', '-r', '--format=%(refname:short)');
        remotes = remoteOut.split('\n').map(s => s.trim()).filter(Boolean);
      } catch { /* no remotes */ }
      const branches = localOut.split('\n').map(s => s.trim()).filter(Boolean);
      res.json({ branches, remotes, current });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/git/checkout', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { branch, create } = req.body || {};
    if (!branch) return res.status(400).json({ error: 'branch is required' });
    const safe = String(branch).replace(/[^a-zA-Z0-9/_.-]/g, '');
    if (!safe || safe.startsWith('-') || safe.includes('..')) {
      return res.status(400).json({ error: 'Invalid branch name' });
    }
    try {
      if (create) {
        await execFileAsync('git', ['checkout', '-b', safe], { cwd: WORKSPACE_ROOT });
      } else {
        await execFileAsync('git', ['checkout', safe, '--'], { cwd: WORKSPACE_ROOT }); // trailing -- forces a revision, never a pathspec
      }
      const current = await gitInWorkspace('rev-parse', '--abbrev-ref', 'HEAD');
      res.json({ branch: current });
    } catch (err) {
      res.status(500).json({ error: err.stderr || err.message });
    }
  });

  router.post('/workspace/git/pull', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    try {
      const { stdout, stderr } = await execFileAsync('git', ['pull'], { cwd: WORKSPACE_ROOT, timeout: 30000 });
      res.json({ result: (stdout || stderr).trim() });
    } catch (err) {
      res.status(500).json({ error: err.stderr || err.message });
    }
  });

  router.get('/workspace/git/log', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || 20, 100));
    try {
      const raw = await gitInWorkspace(
        'log', `--max-count=${limit}`,
        '--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ar\x1f%ad',
        '--date=short'
      );
      const commits = raw ? raw.split('\n').map(line => {
        const [hash, short, subject, author, relative, date] = line.split('\x1f');
        return { hash, short, subject, author, relative, date };
      }) : [];
      res.json({ commits });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/git/discard', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { file } = req.body || {};
    try {
      if (file) {
        const abs = resolveWorkspacePath(file);
        if (!abs || abs === ROOT_ABS) return res.status(400).json({ error: 'Invalid path' }); // the root itself is never a target (also when it is a filesystem root)
        if (!abs.startsWith(ROOT_PREFIX)) return res.status(400).json({ error: 'Invalid path' });
        await execFileAsync('git', ['--literal-pathspecs', 'checkout', '--', abs], { cwd: WORKSPACE_ROOT });
      } else {
        await execFileAsync('git', ['checkout', '--', '.'], { cwd: WORKSPACE_ROOT });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

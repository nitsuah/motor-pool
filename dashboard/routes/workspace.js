import express from 'express';
import { readdir, readFile, writeFile, mkdir, stat, unlink, rm } from 'fs/promises';
import { resolve as resolvePath, relative as relativePath, dirname, basename, sep } from 'path';
import { realpathSync, lstatSync } from 'fs';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const BASH_BLOCKLIST = ['rm -rf /', 'dd if=', ':(){ :|:& };:', '> /dev/sd', 'mkfs'];

// Resolves symlinks on the deepest existing ancestor of abs and checks that the
// real location is the root or below it. A dangling symlink is refused because
// its target cannot be checked.
function isRealPathInside(root, abs) {
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
    try {
      const real = realpathSync(probe);
      const full = tail.length ? resolvePath(real, ...tail) : real;
      return full === rootReal || full.startsWith(rootPrefix);
    } catch {
      try {
        lstatSync(probe);
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

  function resolveWorkspacePath(reqPath) {
    if (!WORKSPACE_ROOT) return null;
    const safe = reqPath ? reqPath.replace(/\\/g, '/').replace(/^\/+/, '') : '';
    const abs = resolvePath(WORKSPACE_ROOT, safe);
    if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + '/')) return null;
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

    try {
      const entries = await readdir(abs, { withFileTypes: true });
      const result = await Promise.all(entries.map(async (e) => {
        const info = { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
        if (!e.isDirectory()) {
          try {
            const s = await stat(resolvePath(abs, e.name));
            info.size = s.size;
            info.modified = s.mtime.toISOString();
          } catch { /* ignore */ }
        }
        return info;
      }));
      result.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ path: relativePath(WORKSPACE_ROOT, abs) || '.', entries: result });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.get('/workspace/read', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const abs = resolveWorkspacePath(req.query.path || '');
    if (!abs) return res.status(400).json({ error: 'Invalid path' });

    try {
      const s = await stat(abs);
      if (s.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
      if (s.size > 1024 * 1024) return res.status(413).json({ error: 'File too large (> 1 MB)' });
      const content = await readFile(abs, 'utf8');
      res.json({ path: relativePath(WORKSPACE_ROOT, abs), content });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post('/workspace/write', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { path: reqPath, content } = req.body || {};
    if (!reqPath || content === undefined) {
      return res.status(400).json({ error: 'path and content are required' });
    }
    const abs = resolveWorkspacePath(reqPath);
    if (!abs) return res.status(400).json({ error: 'Invalid path' });

    try {
      await mkdir(resolvePath(abs, '..'), { recursive: true });
      await writeFile(abs, content, 'utf8');
      res.json({ path: relativePath(WORKSPACE_ROOT, abs), bytes: Buffer.byteLength(content, 'utf8') });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
          if (!abs) return res.status(400).json({ error: `Invalid path: ${f}` });
          await execAsync(`git add "${abs.replace(/"/g, '\\"')}"`, { cwd: WORKSPACE_ROOT });
        }
      } else {
        await execAsync('git add -A', { cwd: WORKSPACE_ROOT });
      }
      const safeMsg = message.replace(/"/g, '\\"');
      await execAsync(`git commit -m "${safeMsg}"`, { cwd: WORKSPACE_ROOT });
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
      await execAsync('git push', { cwd: WORKSPACE_ROOT });
      res.json({ branch });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/exec', express.json(), async (req, res) => {
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
    if (!abs) return res.status(400).json({ error: 'Invalid path' });
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        await rm(abs, { recursive: true, force: true });
      } else {
        await unlink(abs);
      }
      res.json({ deleted: relativePath(WORKSPACE_ROOT, abs) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/mkdir', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const abs = resolveWorkspacePath(req.body?.path || '');
    if (!abs) return res.status(400).json({ error: 'Invalid path' });
    try {
      await mkdir(abs, { recursive: true });
      res.json({ path: relativePath(WORKSPACE_ROOT, abs) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/rename', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { from: fromPath, to: toPath } = req.body || {};
    const absFrom = resolveWorkspacePath(fromPath || '');
    const absTo = resolveWorkspacePath(toPath || '');
    if (!absFrom || !absTo) return res.status(400).json({ error: 'Invalid path' });
    try {
      const { rename } = await import('fs/promises');
      await rename(absFrom, absTo);
      res.json({ from: relativePath(WORKSPACE_ROOT, absFrom), to: relativePath(WORKSPACE_ROOT, absTo) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workspace/search', express.json(), async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).json({ error: 'Workspace not configured' });
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query is required' });
    try {
      const { stdout } = await execAsync(
        `grep -rl "${query.replace(/"/g, '\\"')}" --include="*" --exclude-dir=".git" --exclude-dir="node_modules" .`,
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
    const safe = branch.replace(/[^a-zA-Z0-9/_.-]/g, '');
    try {
      if (create) {
        await execAsync(`git checkout -b ${safe}`, { cwd: WORKSPACE_ROOT });
      } else {
        await execAsync(`git checkout ${safe}`, { cwd: WORKSPACE_ROOT });
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
      const { stdout, stderr } = await execAsync('git pull', { cwd: WORKSPACE_ROOT, timeout: 30000 });
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
        if (!abs) return res.status(400).json({ error: 'Invalid path' });
        await execAsync(`git checkout -- "${abs.replace(/"/g, '\\"')}"`, { cwd: WORKSPACE_ROOT });
      } else {
        await execAsync('git checkout -- .', { cwd: WORKSPACE_ROOT });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

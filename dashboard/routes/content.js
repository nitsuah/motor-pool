import express from 'express';
import { join, sep, resolve as resolvePath } from 'path';
import { pipeline } from 'node:stream';
import { readdir, stat } from 'fs/promises';
import { existsSync, constants as fsConstants } from 'fs';
import { openInside, readdirInside } from '../modules/workspace-fs.js';

export function createContentRouter({ WEBSITE_OUTPUT_DIR, WORKSPACE_ROOT }) {
  const router = express.Router();

  router.get('/content/clients', async (req, res) => {
    try {
      let entries;
      try {
        entries = await readdir(WEBSITE_OUTPUT_DIR);
      } catch {
        return res.json({ success: true, clients: [] });
      }
      const clients = [];
      for (const entry of entries) {
        try {
          const s = await stat(join(WEBSITE_OUTPUT_DIR, entry));
          if (s.isDirectory()) clients.push(entry);
        } catch { /* skip */ }
      }
      res.json({ success: true, clients });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/content/clients/:slug/files', async (req, res) => {
    const { slug } = req.params;
    if (!/^[\w-]+$/.test(slug)) return res.status(400).json({ success: false, error: 'Invalid slug' });
    const clientDirAbs = resolvePath(WEBSITE_OUTPUT_DIR, slug);
    try {
      const files = [];
      async function walk(dir, prefix) {
        // The client directory is replaced by the trusted constant; any other directory must sit below it.
        let d;
        if (dir === clientDirAbs) d = clientDirAbs;
        else if (dir.startsWith(clientDirAbs + sep)) d = dir;
        else return;
        let entries;
        try { entries = await readdir(d); } catch { return; }
        for (const entry of entries) {
          const full = resolvePath(dir, entry);
          const rel  = prefix ? `${prefix}/${entry}` : entry;
          try {
            if (!full.startsWith(clientDirAbs + sep)) continue;
            const s = await stat(full);
            if (s.isDirectory()) {
              await walk(full, rel);
            } else {
              files.push({ path: rel, size: s.size, mtime: s.mtime });
            }
          } catch { /* skip */ }
        }
      }
      await walk(clientDirAbs, '');
      res.json({ success: true, slug, files });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Artifact API ────────────────────────────────────────────────────────
  router.get('/artifacts', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.json([]);
    const root = resolvePath(join(WORKSPACE_ROOT, 'artifacts'));
    const results = [];
    // Each directory is listed through readdirInside; symlinks are never listed or followed.
    async function walk(dirAbs, rel) {
      if (dirAbs !== root && !dirAbs.startsWith(root + sep)) return;
      const entries = await readdirInside(WORKSPACE_ROOT, dirAbs);
      for (const e of entries) {
        if (e.isSymbolicLink) continue;
        const name = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory) await walk(join(dirAbs, e.name), name);
        else if (e.mtime) results.push({ name, size: e.size, createdAt: e.birthtime });
      }
    }
    try {
      await walk(root, '');
      res.json(results);
    } catch { res.json([]); }
  });

  router.get('/artifacts/:name/download', async (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).end();
    const dir = resolvePath(join(WORKSPACE_ROOT, 'artifacts'));
    const safe = resolvePath(join(dir, req.params.name));
    if (safe === dir) return res.status(404).end(); // the directory itself is not a downloadable file
    if (!safe.startsWith(dir + sep)) return res.status(403).end();
    let fh;
    try {
      // Stream from a verified handle that was opened without following symlinks.
      fh = await openInside(WORKSPACE_ROOT, safe, fsConstants.O_RDONLY);
      const st = await fh.stat();
      if (!st.isFile()) {
        await fh.close();
        return res.status(404).end();
      }
      res.attachment(req.params.name);
      res.setHeader('Content-Length', st.size);
      const stream = fh.createReadStream();
      // pipeline closes the file handle when the client goes away mid-download.
      pipeline(stream, res, (err) => { if (err) res.destroy(); });
    } catch (err) {
      await fh?.close().catch(() => {});
      if (err.code === 'ENOENT') return res.status(404).end();
      res.status(403).end();
    }
  });

  router.get('/content/download/:slug/*splat', (req, res) => {
    const { slug } = req.params;
    if (!/^[\w-]+$/.test(slug)) return res.status(400).json({ success: false, error: 'Invalid slug' });
    const filePath = Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat;
    if (!filePath) return res.status(400).json({ success: false, error: 'Missing file path' });
    const fullPath = resolvePath(join(WEBSITE_OUTPUT_DIR, slug, filePath));
    if (!fullPath.startsWith(resolvePath(WEBSITE_OUTPUT_DIR, slug) + sep)) {
      return res.status(403).json({ success: false, error: 'Path traversal blocked' });
    }
    if (!existsSync(fullPath)) return res.status(404).json({ success: false, error: 'File not found' });
    res.download(fullPath);
  });

  return router;
}

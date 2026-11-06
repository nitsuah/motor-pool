import express from 'express';
import { join, sep, resolve as resolvePath } from 'path';
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';

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
        let entries;
        try { entries = await readdir(dir); } catch { return; }
        for (const entry of entries) {
          const full = resolvePath(dir, entry);
          if (full !== clientDirAbs && !full.startsWith(clientDirAbs + sep)) continue;
          const rel  = prefix ? `${prefix}/${entry}` : entry;
          try {
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
    const dir = join(WORKSPACE_ROOT, 'artifacts');
    try {
      const files = await readdir(dir, { recursive: true }).catch(() => []);
      const results = await Promise.all(files.map(async f => {
        const full = join(dir, f);
        const s = await stat(full).catch(() => null);
        return (s && s.isFile()) ? { name: f, size: s.size, createdAt: s.birthtime } : null;
      }));
      res.json(results.filter(Boolean));
    } catch { res.json([]); }
  });

  router.get('/artifacts/:name/download', (req, res) => {
    if (!WORKSPACE_ROOT) return res.status(503).end();
    const dir = resolvePath(join(WORKSPACE_ROOT, 'artifacts'));
    const safe = resolvePath(join(dir, req.params.name));
    if (!safe.startsWith(dir + sep) && safe !== dir) return res.status(403).end();
    if (!existsSync(safe)) return res.status(404).end();
    res.download(safe);
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

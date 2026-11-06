/**
 * Session outputs — per-session file storage for generated outputs.
 * Files are saved under <cwd>/tmp/<sessionId>/<filename>.
 * Cleaned up when the session is deleted.
 */
import { Router } from 'express';
import { createReadStream, mkdirSync, writeFileSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import path from 'path';

const router = Router();
const TMP_ROOT = path.join(process.cwd(), 'tmp');

/**
 * Save a file to the session's output directory.
 * Called from server code when a tool or agent produces output.
 */
export function saveOutput(sessionId, filename, content) {
  const safeId = path.basename(sessionId);
  const safeName = path.basename(filename);
  const dir = path.join(TMP_ROOT, safeId);
  mkdirSync(dir, { recursive: true });
  const filePath = path.resolve(dir, safeName);
  if (!filePath.startsWith(dir + path.sep)) throw new Error('Invalid output path');
  writeFileSync(filePath, content);
  return filePath;
}

router.get('/sessions/:id/outputs', async (req, res) => {
  const dir = path.resolve(TMP_ROOT, path.basename(req.params.id));
  try {
    const files = await readdir(dir).catch(() => []);
    const results = await Promise.all(files.map(async f => {
      const s = await stat(path.join(dir, f)).catch(() => null);
      return s ? { filename: f, size: s.size, createdAt: s.birthtime } : null;
    }));
    res.json(results.filter(Boolean));
  } catch { res.json([]); }
});

router.get('/sessions/:id/outputs/:filename', (req, res) => {
  const dir = path.resolve(TMP_ROOT, path.basename(req.params.id));
  const safe = path.resolve(dir, req.params.filename);
  if (!safe.startsWith(dir + path.sep) && safe !== dir) return res.status(403).end();
  res.download(safe, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

export default router;

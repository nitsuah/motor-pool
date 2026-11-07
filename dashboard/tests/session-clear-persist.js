/**
 * DELETE /api/sessions/:id/messages must persist the cleared state to the
 * on-disk session snapshot (not only the in-memory map).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'clear-persist-'));
const snapshotPath = join(dir, 'sessions-snapshot.json');
process.env.SESSION_SNAPSHOT_PATH = snapshotPath;
process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';

const now = new Date().toISOString();
writeFileSync(snapshotPath, JSON.stringify({
  savedAt: now,
  sessions: [{
    id: 'sess_clear_persist', name: 'clear-persist', endpoint: 'primary', model: 'llama3.2',
    experience: 'developer', userId: 'test', createdAt: now, updatedAt: now, status: 'idle', errorCount: 0,
    messages: [{ role: 'user', content: 'old message', timestamp: now }],
  }],
}));

const { app } = await import('../server.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

try {
  console.log('Session clear-messages persistence test');
  const res = await fetch(`${base}/api/sessions/sess_clear_persist/messages`, { method: 'DELETE' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.cleared, 1, 'restored session had one message');

  // Read immediately: the snapshot must already be written, no debounce wait.
  const saved = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const snap = saved.sessions.find(s => s.id === 'sess_clear_persist');
  assert.ok(snap, 'session still present in snapshot');
  assert.deepEqual(snap.messages, [], 'snapshot has no messages after delete');

  // A failed snapshot write must surface as a 500, not a silent success.
  mkdirSync(snapshotPath + '.tmp');
  const failRes = await fetch(`${base}/api/sessions/sess_clear_persist/messages`, { method: 'DELETE' });
  assert.equal(failRes.status, 500, 'failed snapshot write returns 500');
  assert.equal((await failRes.json()).success, false);
  console.log('Session clear-messages persistence test passed.');
} catch (err) {
  console.error('Session clear-messages persistence test failed:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}

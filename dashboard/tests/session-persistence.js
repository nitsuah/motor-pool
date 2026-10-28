/**
 * Tests for file-based session snapshot persistence.
 * Verifies the snapshot module API shape and that session data
 * is preserved across the module's in-memory lifecycle.
 */
import assert from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDir = mkdtempSync(join(tmpdir(), 'session-snapshot-test-'));
const snapshotPath = join(testDir, 'sessions-snapshot.json');
process.env.SESSION_SNAPSHOT_PATH = snapshotPath;
const { flushSessionSnapshot, initSessionSnapshot, scheduleSnapshotWrite } = await import('../modules/session-snapshot.js');

// 1. initSessionSnapshot with an empty sessions Map does not throw
const map1 = new Map();
initSessionSnapshot(map1, null);

// 2. Schedule a write does not throw with null log
scheduleSnapshotWrite(null);

// 3. After init, the data directory exists
assert.ok(existsSync(testDir), 'test data directory was created by initSessionSnapshot');

// 4. A session added to the map before scheduleSnapshotWrite gets flushed
const map2 = new Map();
initSessionSnapshot(map2, null);
map2.set('test-snap-1', {
  id: 'test-snap-1', name: 'snap-test', endpoint: 'primary', model: 'llama3.2:3b',
  experience: 'developer', messages: [], createdAt: new Date(), updatedAt: new Date(),
  status: 'idle', errorCount: 0,
});
scheduleSnapshotWrite(null);

// Give the debounce time to flush (3s > 2s debounce)
await new Promise(r => setTimeout(r, 3000));

assert.ok(existsSync(snapshotPath), 'sessions-snapshot.json was written');

// 5. Snapshot file is valid JSON with expected shape
const raw = readFileSync(snapshotPath, 'utf8');
const parsed = JSON.parse(raw);
assert.ok(typeof parsed.savedAt === 'string', 'savedAt timestamp present');
assert.ok(Array.isArray(parsed.sessions), 'sessions array present');
const snap = parsed.sessions.find(s => s.id === 'test-snap-1');
assert.ok(snap, 'test session found in snapshot');
assert.strictEqual(snap.name, 'snap-test', 'session name preserved');

// 6. A new Map hydrated from the same file via initSessionSnapshot restores the session
const map3 = new Map();
initSessionSnapshot(map3, null);
assert.ok(map3.has('test-snap-1'), 'session restored from snapshot on re-init');
assert.strictEqual(map3.get('test-snap-1').name, 'snap-test', 'name preserved after restore');

// 7. A pending write can be flushed synchronously during shutdown.
map3.set('test-snap-shutdown', {
  id: 'test-snap-shutdown', name: 'shutdown-snap-test', endpoint: 'primary', model: 'llama3.2:3b',
  experience: 'developer', messages: [], createdAt: new Date(), updatedAt: new Date(),
  status: 'idle', errorCount: 0,
});
scheduleSnapshotWrite(null);
assert.equal(flushSessionSnapshot(null), true, 'flush writes the pending snapshot synchronously');
const afterFlush = JSON.parse(readFileSync(snapshotPath, 'utf8'));
assert.ok(afterFlush.sessions.some(s => s.id === 'test-snap-shutdown'), 'flush includes the latest session state');

console.log('Session persistence tests passed.');
rmSync(testDir, { recursive: true, force: true });

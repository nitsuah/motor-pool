/**
 * End-to-end (in-process) check that ending a chat session through the HTTP
 * API writes a TokenEconomizer history entry the panel's Sessions tab can read,
 * and that a fork of a session survives with the same repo key.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ownDir = !process.env.TOKEN_ECONOMIZER_DIR;
if (ownDir) process.env.TOKEN_ECONOMIZER_DIR = mkdtempSync(join(tmpdir(), 'te-session-end-'));
process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';

const { app } = await import('../server.js');
const { TokenEconomizer } = await import('../modules/token-economizer.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function req(path, { method = 'GET', data } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function waitForHistory(predicate) {
  for (let i = 0; i < 50; i++) {
    const r = await req('/api/tokeneconomizer/sessions?limit=50');
    if (predicate(r.data.sessions || [])) return r.data.sessions;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return (await req('/api/tokeneconomizer/sessions?limit=50')).data.sessions;
}

try {
  console.log('TokenEconomizer session-end tests');

  const created = await req('/api/sessions', { method: 'POST', data: { userId: 'u1', endpoint: 'primary', experience: 'developer' } });
  assert.equal(created.status, 200);
  const id = created.data.session.id;

  const forked = await req(`/api/sessions/${id}/fork`, { method: 'POST', data: {} });
  assert.equal(forked.status, 200);
  const forkId = forked.data.session.id;

  const del = await req(`/api/sessions/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  let history = await waitForHistory(list => list.some(h => h.sessionId === id));
  const entry = history.find(h => h.sessionId === id);
  assert.ok(entry, 'DELETE /api/sessions/:id records a history entry visible at the default repo root');
  assert.equal(entry.kind, 'chat');
  assert.equal(entry.experience, 'developer');
  assert.equal(entry.turns, 0);

  // The fork lives under the same repo key as its parent, so its history
  // entry shows up under the same default query.
  const bulk = await req('/api/sessions', { method: 'DELETE', data: { ids: [forkId] } });
  assert.equal(bulk.status, 200);
  history = await waitForHistory(list => list.some(h => h.sessionId === forkId));
  assert.ok(history.find(h => h.sessionId === forkId), 'bulk delete records the fork under the same repo root');
  console.log('  ✅ ending sessions (single and bulk delete) populates TokenEconomizer history');
} finally {
  server.close();
  await TokenEconomizer._flushWritesForTest();
  if (ownDir) rmSync(process.env.TOKEN_ECONOMIZER_DIR, { recursive: true, force: true });
}

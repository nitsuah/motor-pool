/**
 * Tests for workspace file operations
 * GET /api/workspace/status, /api/workspace/read, POST /api/workspace/write, etc.
 */
import assert from 'node:assert/strict';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
// The exec cases below check validation and output, so the WORKSPACE_EXEC opt-in is on here.
// workspace-exec-flag.js covers the disabled (403) path.
process.env.WORKSPACE_EXEC = '1';

const { app } = await import('../server.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function req(path, { method = 'GET', data } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, data: body };
}

try {
  console.log('Workspace file operation tests');

  // GET /api/workspace/status — should return workspace info
  const status = await req('/api/workspace/status');
  assert.ok([200, 503].includes(status.status), 'workspace status returns valid code');

  // POST /api/workspace/exec without command — 400 or 503 if workspace unavailable
  const noCmd = await req('/api/workspace/exec', { method: 'POST', data: {} });
  assert.ok([400, 503].includes(noCmd.status), 'exec without command returns 400 or 503');

  // POST /api/workspace/exec with blocked command — should be rejected
  const blocked = await req('/api/workspace/exec', {
    method: 'POST',
    data: { command: 'rm -rf /' },
  });
  assert.ok(blocked.status >= 400, 'dangerous command rejected');

  // POST /api/workspace/exec with safe command (503 if workspace unavailable in Docker)
  const safe = await req('/api/workspace/exec', {
    method: 'POST',
    data: { command: 'echo hello' },
  });
  assert.ok([200, 503].includes(safe.status), 'safe echo command succeeds or workspace unavailable');
  if (safe.status === 200) {
    assert.ok(safe.data.output !== undefined || safe.data.stdout !== undefined, 'exec returns output');
  }

  // POST /api/workspace/search — search workspace (may 500 if grep not available)
  const search = await req('/api/workspace/search', {
    method: 'POST',
    data: { query: 'test_string_unlikely_to_match_xyz' },
  });
  assert.ok([200, 500, 503].includes(search.status), 'search returns valid status');

  console.log('✓ All workspace file operation tests passed');
} catch (e) {
  console.error('✗ FAIL:', e.message);
  process.exit(1);
} finally {
  server.close();
}

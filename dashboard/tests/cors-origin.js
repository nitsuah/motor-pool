/**
 * CORS defaults: with CORS_ALLOWED_ORIGINS unset only the local dev origins are
 * allowed, credentials are never advertised, and an explicit override replaces
 * the defaults (no wildcard, malformed entries are dropped rather than widened).
 */
import assert from 'node:assert/strict';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
const { app } = await import('../server.js');
// Delete after import: dotenv in server.js would otherwise restore it from dashboard/.env.
delete process.env.CORS_ALLOWED_ORIGINS;

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function head(origin) {
  const res = await fetch(`${base}/api/demo-mode`, { headers: { Origin: origin } });
  return {
    allow: res.headers.get('access-control-allow-origin'),
    creds: res.headers.get('access-control-allow-credentials'),
  };
}

try {
  for (const o of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173']) {
    const r = await head(o);
    assert.equal(r.allow, o, `default origin allowed: ${o}`);
    assert.equal(r.creds, null, 'credentials not advertised');
  }
  assert.equal((await head('https://evil.example')).allow, null, 'unlisted origin denied');

  process.env.CORS_ALLOWED_ORIGINS = '';
  assert.equal((await head('http://localhost:5173')).allow, null, 'explicit empty allowlist allows none');

  process.env.CORS_ALLOWED_ORIGINS = 'http://allowed.example, not a url, *';
  assert.equal((await head('http://allowed.example')).allow, 'http://allowed.example', 'override origin allowed');
  assert.equal((await head('http://localhost:5173')).allow, null, 'override replaces defaults');
  assert.equal((await head('https://evil.example')).allow, null, 'malformed/wildcard entries do not widen');
  console.log('CORS origin default tests passed.');
} catch (err) {
  console.error('CORS origin default tests failed:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

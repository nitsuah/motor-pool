/**
 * Non-GET requests carrying a foreign Origin are refused (403); same-host and
 * allowlisted origins, requests without Origin, and safe methods pass.
 */
import assert from 'node:assert/strict';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
process.env.CORS_ALLOWED_ORIGINS = 'http://allowed.example';
const { app } = await import('../server.js');

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function send(method, origin) {
  const res = await fetch(`${base}/api/sessions`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify({ userId: 'origin-test', endpoint: 'primary', model: 'llama3.2', experience: 'developer' }),
  });
  return res.status;
}

try {
  assert.equal(await send('POST', 'https://evil.example'), 403, 'foreign origin refused');
  assert.equal(await send('POST', 'null'), 403, 'opaque origin refused');
  assert.equal(await send('DELETE', 'https://evil.example'), 403, 'foreign DELETE refused');
  assert.equal(await send('GET', 'https://evil.example'), 200, 'GET is not affected');
  assert.equal(await send('POST', undefined), 200, 'no Origin passes');
  assert.equal(await send('POST', `http://127.0.0.1:${port}`), 200, 'same-host origin passes');
  assert.equal(await send('POST', 'http://allowed.example'), 200, 'allowlisted origin passes');
  console.log('Origin guard tests passed.');
} catch (err) {
  console.error('Origin guard tests failed:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

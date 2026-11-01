/**
 * Tests for GET /api/discover/endpoints
 * Verifies the route exists, accepts optional query params,
 * and returns the expected shape even when nothing is found.
 */
import assert from 'assert';
import { getKnownEndpointUrls } from '../routes/discover.js';

const { BASE, closeTestServer } = await import('./helpers/test-server.js');

const knownUrls = getKnownEndpointUrls({
  keylessLocal: { url: 'http://localhost:11434', requiresKey: false, apiKey: '' },
  unconfiguredCloud: { url: 'https://cloud.example/v1', requiresKey: true, apiKey: '' },
  configuredCloud: { url: 'https://configured.example/v1', requiresKey: true, apiKey: 'test-only-key' },
});
assert.ok(knownUrls.has('http://localhost:11434'), 'keyless local endpoint remains registered');
assert.equal(knownUrls.has('https://cloud.example/v1'), false, 'unconfigured required-key endpoint is not registered');
assert.ok(knownUrls.has('https://configured.example/v1'), 'configured required-key endpoint remains registered');

// 1. Route exists and returns success shape
const res = await fetch(`${BASE}/api/discover/endpoints`);
assert.strictEqual(res.status, 200, 'discover returns 200');
const data = await res.json();
assert.ok(data.success === true, 'success flag is true');
assert.ok(Array.isArray(data.discovered), 'discovered is an array');
assert.ok(typeof data.scanned === 'number' && data.scanned > 0, 'scanned count > 0');
assert.ok(Array.isArray(data.knownProviders), 'knownProviders is an array');
assert.ok(data.knownProviders.length > 0, 'well-known providers are surfaced');
for (const provider of data.knownProviders) {
  assert.ok(typeof provider.key === 'string', 'well-known provider has a key');
  assert.ok(typeof provider.alreadyRegistered === 'boolean', 'well-known provider has registration status');
}

// 2. Custom port override narrows the scan
const resPort = await fetch(`${BASE}/api/discover/endpoints?ports=9`);
assert.strictEqual(resPort.status, 200, 'custom ports returns 200');
const dataPort = await resPort.json();
assert.ok(dataPort.success === true, 'custom ports success');
// Port 9 (discard) should not return any discovered service
assert.ok(Array.isArray(dataPort.discovered), 'discovered is array with custom port');

// 3. Custom host param is accepted
const resHost = await fetch(`${BASE}/api/discover/endpoints?host=localhost&ports=9`);
assert.strictEqual(resHost.status, 200, 'custom host param returns 200');
const dataHost = await resHost.json();
assert.ok(dataHost.success === true, 'custom host+port success');

// 4. Each discovered entry has expected shape
for (const entry of data.discovered) {
  assert.ok(typeof entry.key === 'string', 'entry has key');
  assert.ok(typeof entry.url === 'string', 'entry has url');
  assert.ok(['openai', 'ollama', 'unknown'].includes(entry.apiStyle), `apiStyle is valid: ${entry.apiStyle}`);
  assert.ok(Array.isArray(entry.models), 'models is array');
  assert.ok(typeof entry.alreadyRegistered === 'boolean', 'alreadyRegistered is bool');
}


closeTestServer();
console.log('Endpoint discovery tests passed.');

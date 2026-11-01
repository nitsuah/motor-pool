/**
 * Regression test for SSRF in GET /api/discover/endpoints
 *
 * Vulnerabilities:
 * 1. Arbitrary port scanning on localhost/host.docker.internal via `ports` parameter
 * 2. host.docker.internal allows scanning host machine services
 * 3. No rate limiting
 * 4. fetch() follows redirects by default
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { BASE, closeTestServer } from './helpers/test-server.js';

const testServers = [];

async function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      testServers.push(server);
      resolve({ server, port });
    });
  });
}

describe('SSRF protection in /api/discover/endpoints', () => {
  beforeAll(async () => {
    // wait for test server to be ready
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterAll(() => {
    for (const s of testServers) s.close();
    closeTestServer();
  });

  it('should reject arbitrary port scanning (port not in allowlist)', async () => {
    const { port: arbitraryPort } = await startTestServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'arbitrary-model' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const res = await fetch(`${BASE}/api/discover/endpoints?host=localhost&ports=${arbitraryPort}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    const arbitraryEntry = data.discovered.find(e => e.url && e.url.includes(`:${arbitraryPort}`));
    expect(arbitraryEntry).toBeUndefined(); // Should NOT be discovered - port not in allowlist
  });

  it('should reject host.docker.internal host parameter', async () => {
    const res = await fetch(`${BASE}/api/discover/endpoints?host=host.docker.internal&ports=11434`);
    // After fix, host.docker.internal should be rejected with 400
    expect(res.status).toBe(400);
  });

  it('should reject invalid host (private IP)', async () => {
    const res = await fetch(`${BASE}/api/discover/endpoints?host=10.0.0.1&ports=8080`);
    // Should return 400 for invalid host
    expect(res.status).toBe(400);
  });

  it('should allow valid allowlisted port (5000)', async () => {
    // Use a fixed allowlisted port
    const validPort = 5000;
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(validPort, '127.0.0.1', resolve));
    testServers.push(server);

    const res = await fetch(`${BASE}/api/discover/endpoints?host=localhost&ports=${validPort}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    const validEntry = data.discovered.find(e => e.url && e.url.includes(`:${validPort}`));
    expect(validEntry).toBeDefined(); // Should be discovered - port in allowlist
    expect(validEntry.models).toContain('test-model');
  });

  it('should reject multiple arbitrary ports', async () => {
    const res = await fetch(`${BASE}/api/discover/endpoints?host=localhost&ports=9999,8888,7777`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const arbitraryEntries = data.discovered.filter(e =>
      e.url && (e.url.includes(':9999') || e.url.includes(':8888') || e.url.includes(':7777'))
    );
    expect(arbitraryEntries.length).toBe(0); // Should NOT discover arbitrary ports
  });
});

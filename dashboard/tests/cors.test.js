/**
 * CORS security tests.
 *
 * Verifies that the CORS middleware rejects requests from unauthorized origins.
 * This test should FAIL on current code (which allows any origin) and PASS after fix.
 */
import axios from 'axios';
import assert from 'node:assert/strict';
import { BASE as TEST_BASE, closeTestServer } from './helpers/test-server.js';

const BASE = process.env.DASHBOARD_URL || TEST_BASE;
const TIMEOUT = 5000;

async function testCorsRejectsUnauthorizedOrigin() {
  console.log('  Testing CORS rejects unauthorized origin...');

  const unauthorizedOrigin = 'https://evil.com';
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

  try {
    const res = await axios.get(`${BASE}/api/health`, {
      timeout: TIMEOUT,
      headers: { Origin: unauthorizedOrigin },
      validateStatus: () => true,
    });
    const allowOrigin = res.headers['access-control-allow-origin'];
    assert.equal(
      res.status,
      403,
      `CORS should return 403 for unauthorized origin; got ${res.status}`,
    );
    assert.ok(
      !allowOrigin || allowOrigin === 'null',
      `Unauthorized origin must not receive CORS headers: ${allowOrigin}`,
    );
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.log('  ⚠️  Server not reachable, skipping CORS test');
      return;
    }
    throw err;
  }
}

async function testCorsAllowsAuthorizedOrigin() {
  console.log('  Testing CORS allows authorized origin...');

  // Use localhost:3000 as the authorized origin
  const allowedOrigin = 'http://localhost:3000';

  // Ensure the server allows this origin
  process.env.CORS_ALLOWED_ORIGINS = allowedOrigin;

  try {
    const res = await axios.get(`${BASE}/api/health`, {
      timeout: TIMEOUT,
      headers: {
        'Origin': allowedOrigin,
      },
      validateStatus: (status) => true,
    });

    const allowOrigin = res.headers['access-control-allow-origin'];

    // Should allow the authorized origin
    assert.ok(
      allowOrigin === allowedOrigin,
      `CORS should allow authorized origin. Got Access-Control-Allow-Origin: ${allowOrigin}`
    );

    console.log(`  ✅ CORS correctly allows authorized origin (${allowedOrigin})`);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.log('  ⚠️  Server not reachable, skipping CORS test');
      return;
    }
    throw err;
  }
}

async function testCorsPreflightRejectsUnauthorized() {
  console.log('  Testing CORS preflight rejects unauthorized origin...');

  const unauthorizedOrigin = 'https://evil.com';
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

  try {
    const res = await axios.options(
      `${BASE}/api/health`,
      {
      timeout: TIMEOUT,
      headers: {
        Origin: unauthorizedOrigin,
        'Access-Control-Request-Method': 'GET',
      },
        validateStatus: () => true,
      },
    );
    const allowOrigin = res.headers['access-control-allow-origin'];
    assert.equal(
      res.status,
      403,
      `CORS preflight should return 403; got ${res.status}`,
    );
    assert.ok(
      !allowOrigin || allowOrigin === 'null',
      `Unauthorized preflight must not receive CORS headers: ${allowOrigin}`,
    );
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.log('  ⚠️  Server not reachable, skipping CORS preflight test');
      return;
    }
    throw err;
  }
}

async function run() {
  console.log('CORS Security Tests');
  console.log('---');

  await testCorsRejectsUnauthorizedOrigin();
  await testCorsAllowsAuthorizedOrigin();
  await testCorsPreflightRejectsUnauthorized();

  console.log('---');
  console.log('CORS security tests completed.');
  closeTestServer();
}

run().catch((err) => {
  console.error('CORS security tests failed:', err.message);
  process.exit(1);
});

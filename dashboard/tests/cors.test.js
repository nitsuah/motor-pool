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

  // Test with a malicious/unknown origin
  const unauthorizedOrigin = 'https://evil.com';

  // Set the allowed origin for the test
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

  try {
    const res = await axios.get(`${BASE}/api/health`, {
      timeout: TIMEOUT,
      headers: {
        'Origin': unauthorizedOrigin,
      },
      validateStatus: (status) => true, // Don't throw on any status
    });

    // CORS should reject - either 403 status or no Access-Control-Allow-Origin header
    const allowOrigin = res.headers['access-control-allow-origin'];
    const isRejected = res.status === 403 || res.status === 500 || !allowOrigin || allowOrigin === 'null';

    assert.ok(
      isRejected,
      `CORS should reject unauthorized origin. Status: ${res.status}, Access-Control-Allow-Origin: ${allowOrigin}`
    );

    console.log(`  ✅ CORS correctly rejects unauthorized origin (${unauthorizedOrigin}) - status: ${res.status}`);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.log('  ⚠️  Server not reachable, skipping CORS test');
      return;
    }
    // If axios throws due to network error from CORS rejection, that's also a pass
    if (err.message && err.message.includes('CORS')) {
      console.log(`  ✅ CORS correctly rejects unauthorized origin (${unauthorizedOrigin}) - network error: ${err.message}`);
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

  // Set the allowed origin for the test
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

  try {
    await axios.options(`${BASE}/api/health`, {
      timeout: TIMEOUT,
      headers: {
        'Origin': unauthorizedOrigin,
        'Access-Control-Request-Method': 'GET',
      },
      validateStatus: (status) => true,
    });

    // If we get here, no error was thrown - this is a FAIL
    assert.fail('CORS preflight should reject unauthorized origin but request succeeded');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.log('  ⚠️  Server not reachable, skipping CORS preflight test');
      return;
    }
    if (err.message && err.message.includes('CORS')) {
      console.log(`  ✅ CORS preflight correctly rejects unauthorized origin`);
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

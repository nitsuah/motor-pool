/**
 * Unit tests for modules/logger.js
 */
import assert from 'node:assert/strict';
import { logStructured } from '../modules/logger.js';

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

const logs = [];
const warns = [];
const errors = [];

function captureLog(msg) { logs.push(msg); }
function captureWarn(msg) { warns.push(msg); }
function captureError(msg) { errors.push(msg); }

try {
  // Replace console methods
  console.log = captureLog;
  console.warn = captureWarn;
  console.error = captureError;

  // ── routing by level ──────────────────────────────────────────────────────────
  logs.length = 0; warns.length = 0; errors.length = 0;
  logStructured('info', 'test-event');
  assert.strictEqual(logs.length, 1, 'info goes to console.log');
  assert.strictEqual(warns.length, 0, 'info does not go to console.warn');
  assert.strictEqual(errors.length, 0, 'info does not go to console.error');

  logs.length = 0; warns.length = 0; errors.length = 0;
  logStructured('warn', 'test-event');
  assert.strictEqual(warns.length, 1, 'warn goes to console.warn');
  assert.strictEqual(logs.length, 0, 'warn does not go to console.log');
  assert.strictEqual(errors.length, 0, 'warn does not go to console.error');

  logs.length = 0; warns.length = 0; errors.length = 0;
  logStructured('error', 'test-event');
  assert.strictEqual(errors.length, 1, 'error goes to console.error');
  assert.strictEqual(logs.length, 0, 'error does not go to console.log');
  assert.strictEqual(warns.length, 0, 'error does not go to console.warn');

  logs.length = 0; warns.length = 0; errors.length = 0;
  logStructured('debug', 'test-event');
  assert.strictEqual(logs.length, 1, 'unknown level goes to console.log');
  assert.strictEqual(warns.length, 0, 'unknown level does not go to console.warn');
  assert.strictEqual(errors.length, 0, 'unknown level does not go to console.error');

  // ── payload is valid JSON with expected fields ────────────────────────────────
  logs.length = 0;
  logStructured('info', 'evt', { foo: 'bar' });
  const payload = JSON.parse(logs[0]);
  assert.ok(payload.timestamp, 'payload has timestamp');
  assert.strictEqual(payload.level, 'info', 'payload has level');
  assert.strictEqual(payload.eventType, 'evt', 'payload has eventType');
  assert.strictEqual(payload.foo, 'bar', 'payload includes data fields');
  assert.strictEqual(typeof Date.parse(payload.timestamp), 'number', 'timestamp is parseable');
  assert.ok(!Number.isNaN(Date.parse(payload.timestamp)), 'timestamp parses to a valid number');

  // ── data keys can override nothing important (spread comes last) ──────────────
  logs.length = 0;
  logStructured('info', 'evt', { level: 'warn', eventType: 'override', timestamp: 'fake' });
  const payload2 = JSON.parse(logs[0]);
  assert.strictEqual(payload2.level, 'warn', 'data.level overrides the level field in payload');
  assert.strictEqual(payload2.eventType, 'override', 'data.eventType overrides the eventType field in payload');
  assert.strictEqual(payload2.timestamp, 'fake', 'data.timestamp overrides the timestamp field in payload');
  // routing still uses the first argument
  assert.strictEqual(logs.length, 1, 'routing still uses first argument (info → log)');
  assert.strictEqual(warns.length, 0, 'does not route to warn');
  assert.strictEqual(errors.length, 0, 'does not route to error');

  console.log('Logger tests passed.');
} finally {
  // Restore console methods
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
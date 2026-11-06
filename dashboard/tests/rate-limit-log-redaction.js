import assert from 'node:assert/strict';
import axios from 'axios';
import { BASE, closeTestServer } from './helpers/test-server.js';

const sentinel = '198.51.100.99, 203.0.113.45';
const captured = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => captured.push(args.map(String).join(' '));
console.warn = (...args) => captured.push(args.map(String).join(' '));
console.error = (...args) => captured.push(args.map(String).join(' '));

try {
  const response = await axios.get(BASE + '/api/health', {
    timeout: 5000,
    headers: { 'X-Forwarded-For': sentinel },
    validateStatus: () => true,
  });

  assert.equal(response.status, 200);
  assert.equal(captured.some((line) => line.includes('rate_limit_check')), false);
  assert.equal(captured.some((line) => line.includes(sentinel)), false);
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  closeTestServer();
}

console.log('  ✓ rate-limit skip does not log X-Forwarded-For or derived client data');

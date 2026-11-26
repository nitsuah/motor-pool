/**
 * Unit tests for the pure helpers exported by modules/dashboard-auth.js
 * (bearerToken, hasProxyHeader, isLoopbackAddress, isLoopbackHost, constants).
 */
import assert from 'node:assert/strict';
import {
  bearerToken,
  hasProxyHeader,
  isLoopbackAddress,
  isLoopbackHost,
  SESSION_COOKIE,
  MIN_TOKEN_LENGTH,
} from '../modules/dashboard-auth.js';

// ── bearerToken ───────────────────────────────────────────────────────────────
assert.equal(bearerToken('Bearer abc'), 'abc', 'plain bearer token');
assert.equal(bearerToken('bearer abc'), 'abc', 'scheme is case-insensitive (lower)');
assert.equal(bearerToken('BEARER abc'), 'abc', 'scheme is case-insensitive (upper)');
assert.equal(bearerToken('Bearer   abc  '), 'abc', 'surrounding spaces trimmed');
for (const bad of ['Bearer', 'Bearer ', 'Bearer    ', '', undefined, null, 'Basic abc']) {
  assert.equal(bearerToken(bad), null, `bearerToken(${JSON.stringify(bad)}) is null`);
}
assert.equal(bearerToken('Bearer a b'), 'a b', 'inner space kept');
{
  const start = performance.now();
  const result = bearerToken(`Bearer${' '.repeat(100000)}`);
  const elapsed = performance.now() - start;
  assert.equal(result, null, 'a long run of spaces yields no token');
  assert.ok(elapsed < 2000, `long space run parsed in linear time (${elapsed.toFixed(1)} ms)`);
}

// ── hasProxyHeader ────────────────────────────────────────────────────────────
assert.equal(hasProxyHeader({}), false, 'no headers');
for (const name of ['forwarded', 'Forwarded', 'x-real-ip', 'X-Real-IP', 'x-forwarded-for', 'X-Forwarded-Proto', 'x-forwarded-host']) {
  assert.equal(hasProxyHeader({ [name]: 'x' }), true, `${name} is a proxy header`);
}
for (const name of ['x-forward', 'host']) {
  assert.equal(hasProxyHeader({ [name]: 'x' }), false, `${name} is not a proxy header`);
}

// ── isLoopbackAddress ─────────────────────────────────────────────────────────
for (const addr of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) {
  assert.equal(isLoopbackAddress(addr), true, `${addr} is loopback`);
}
for (const addr of ['10.0.0.1', '128.0.0.1', '::2', '', undefined]) {
  assert.equal(isLoopbackAddress(addr), false, `${JSON.stringify(addr)} is not loopback`);
}

// ── isLoopbackHost ────────────────────────────────────────────────────────────
for (const host of ['localhost', 'localhost:3000', '127.0.0.1:8080', '[::1]', '[::1]:3000', 'LOCALHOST']) {
  assert.equal(isLoopbackHost(host), true, `${host} is a loopback host`);
}
for (const host of ['example.com', 'localhost.evil.com', '127.0.0.1.evil.com:80', '', undefined]) {
  assert.equal(isLoopbackHost(host), false, `${JSON.stringify(host)} is not a loopback host`);
}

// ── constants ─────────────────────────────────────────────────────────────────
assert.equal(SESSION_COOKIE, 'mp_dashboard_session', 'session cookie name');
assert.equal(MIN_TOKEN_LENGTH, 24, 'minimum token length');

console.log('dashboard-auth-helpers-unit: all assertions passed');

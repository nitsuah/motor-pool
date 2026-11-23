import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createMcpAuth as contentGenAuth } from '../tools/content-gen/mcp-auth.js';
import { createMcpAuth as websiteAuth } from '../tools/website/mcp-auth.js';

function run(mw, authorization) {
  const out = { status: null, nexted: false };
  const res = { set() {}, status(c) { out.status = c; return this; }, json() { return this; } };
  mw({ headers: authorization ? { authorization } : {} }, res, () => { out.nexted = true; });
  return out;
}

for (const [name, factory] of [['content-gen', contentGenAuth], ['website', websiteAuth]]) {
  describe(`${name} mcp auth`, () => {
    it('refuses missing and wrong tokens when a token is configured', () => {
      const mw = factory({ MCP_AUTH_TOKEN: 'tok-123' });
      assert.deepEqual(run(mw), { status: 401, nexted: false });
      assert.deepEqual(run(mw, 'Bearer nope'), { status: 401, nexted: false });
      assert.deepEqual(run(mw, 'Basic tok-123'), { status: 401, nexted: false });
    });
    it('accepts the configured token', () => {
      assert.equal(run(factory({ MCP_AUTH_TOKEN: 'tok-123' }), 'Bearer tok-123').nexted, true);
    });
    it('accepts any scheme case and extra spaces; refuses an empty credential', () => {
      const mw = factory({ MCP_AUTH_TOKEN: 'tok-123' });
      assert.equal(run(mw, 'bearer   tok-123 ').nexted, true);
      assert.deepEqual(run(mw, 'Bearer '), { status: 401, nexted: false });
      assert.deepEqual(run(mw, 'Bearer'), { status: 401, nexted: false });
    });
    it('handles a long run of spaces in linear time', () => {
      const mw = factory({ MCP_AUTH_TOKEN: 'tok-123' });
      const t0 = Date.now();
      assert.deepEqual(run(mw, 'bearer ' + ' '.repeat(200_000) + 'x'), { status: 401, nexted: false });
      assert.ok(Date.now() - t0 < 500);
    });
    it('passes through when no token is configured', () => {
      assert.equal(run(factory({}), undefined).nexted, true);
    });
  });
}

import { assertAuthConfigured as contentGenAssert } from '../tools/content-gen/mcp-auth.js';
import { assertAuthConfigured as websiteAssert } from '../tools/website/mcp-auth.js';
import { readFileSync } from 'node:fs';

for (const [name, assertFn] of [['content-gen', contentGenAssert], ['website', websiteAssert]]) {
  describe(`${name} fail-closed bind`, () => {
    it('refuses a non-loopback bind without a token', () => {
      assert.throws(() => assertFn('0.0.0.0', {}), /MCP_AUTH_TOKEN/);
      assert.throws(() => assertFn('192.168.1.5', { MCP_AUTH_TOKEN: '' }), /MCP_AUTH_TOKEN/);
    });
    it('allows a non-loopback bind with a token and a loopback bind without one', () => {
      assert.doesNotThrow(() => assertFn('0.0.0.0', { MCP_AUTH_TOKEN: 'tok' }));
      assert.doesNotThrow(() => assertFn('127.0.0.1', {}));
      assert.doesNotThrow(() => assertFn('::1', {}));
    });
  });
}

describe('tool server compose wiring', () => {
  const raw = readFileSync(new URL('../config/docker-compose.yml', import.meta.url), 'utf8');
  it('publishes content-gen on loopback only and passes the token to both servers', () => {
    assert.match(raw, /"127\.0\.0\.1:3200:3200"/);
    assert.doesNotMatch(raw, /^\s*-\s*"3200:3200"/m);
    assert.equal((raw.match(/- MCP_AUTH_TOKEN=\$\{MCP_AUTH_TOKEN:-\}/g) || []).length, 2);
  });
  it('keeps unless-stopped so both tool servers come back after a daemon restart', () => {
    for (const name of ['tool-content-gen', 'tool-website']) {
      assert.match(raw, new RegExp('container_name: ' + name + '\n(?:    #[^\n]*\n)*    restart: unless-stopped'));
    }
  });
  it('idles instead of exiting when the token is missing, so the restart policy cannot crash-loop', () => {
    for (const tool of ['content-gen', 'website']) {
      const src = readFileSync(new URL(`../tools/${tool}/server.js`, import.meta.url), 'utf8');
      const guard = src.slice(src.indexOf('assertAuthConfigured(HOST)'), src.indexOf('app.listen(PORT, HOST'));
      assert.doesNotMatch(guard, /process\.exit/);
      assert.match(src, /if \(authReady\) app\.listen\(PORT, HOST/);
    }
  });
});

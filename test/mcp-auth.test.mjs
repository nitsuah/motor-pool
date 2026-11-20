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
    it('passes through when no token is configured', () => {
      assert.equal(run(factory({}), undefined).nexted, true);
    });
  });
}

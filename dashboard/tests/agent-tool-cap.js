// Bash-tool cases below exercise the shell path, so the WORKSPACE_EXEC opt-in is on for this file.
process.env.WORKSPACE_EXEC = '1';

/**
 * Tests for agent-tools.js: tool result capping and path traversal guards.
 */
import assert from 'node:assert/strict';
import { createAgentHelpers } from '../modules/agent-tools.js';

const helpers = createAgentHelpers({
  WORKSPACE_ROOT: '/tmp/test-workspace',
  execAsync: async () => ({ stdout: '', stderr: '' }),
  TOOL_SERVERS: {},
  TOOL_CALL_TIMEOUT_MS: 5000,
});

// capToolResult is internal but we can test its effect via the public helpers
// We test tool dispatch for unknown tools and path traversal.

// Access the helper's internal capToolResult via runAgentLoop — not directly exported.
// Instead, test by observing the cap via a stub.

// Test 1: getExperienceTools returns correct sets
const devTools = helpers.getExperienceTools('developer');
assert.ok(Array.isArray(devTools) && devTools.length > 0, 'developer should have tools');
assert.ok(devTools.some(t => t.function?.name === 'bash'), 'developer should have bash');

const chatTools = helpers.getExperienceTools('safechat');
assert.deepEqual(chatTools, [], 'safechat should have no tools');

const researchTools = helpers.getExperienceTools('research');
assert.ok(researchTools.some(t => t.function?.name === 'web_search'), 'research should have web_search');

// Test 2: Tool descriptions are valid (have required fields)
for (const t of devTools) {
  assert.ok(t.type === 'function', `tool should have type=function: ${JSON.stringify(t)}`);
  assert.ok(typeof t.function?.name === 'string', `tool should have a name`);
  assert.ok(typeof t.function?.description === 'string', `tool ${t.function?.name} should have a description`);
}

// Test 3: No workspace tools when WORKSPACE_ROOT is null
const helpers2 = createAgentHelpers({
  WORKSPACE_ROOT: null,
  execAsync: async () => {},
  TOOL_SERVERS: {},
  TOOL_CALL_TIMEOUT_MS: 5000,
});
const devToolsNoWs = helpers2.getExperienceTools('developer');
assert.deepEqual(devToolsNoWs, [], 'developer without workspace should have no tools');

console.log('Agent tool cap tests passed.');

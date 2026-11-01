/**
 * Test that prepareSessionForLlmCall does NOT expose apiKey in its return value
 * This test should FAIL on current code (apiKey is returned)
 * and PASS after the fix (apiKey is removed from return value)
 */
import assert from 'node:assert/strict';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
process.env.PRIMARY_LLM_URL = 'http://localhost:11434';

const { prepareSessionForLlmCall } = await import('../server.js');
const { LLM_CONFIG } = await import('../modules/llm-config.js');

// Mock a session with an endpoint that has an apiKey
const mockSession = {
  id: 'test-session',
  endpoint: 'primary',
  model: 'llama3',
  llmUrl: 'http://localhost:11434',
  experience: 'developer',
  userId: 'test-user',
};

// Ensure the primary endpoint has an apiKey for testing
LLM_CONFIG.primary.apiKey = 'test-secret-key-12345';

const prepared = await prepareSessionForLlmCall(mockSession);

// This test should FAIL on current code because apiKey is in the response
assert.ok(!('apiKey' in prepared), 'apiKey should NOT be in prepareSessionForLlmCall return value');
assert.ok(!Object.prototype.hasOwnProperty.call(prepared, 'apiKey'), 'apiKey should NOT be a property of returned object');

// The apiKey should only be used internally, not returned
console.log('Test passed: prepareSessionForLlmCall does not expose apiKey');

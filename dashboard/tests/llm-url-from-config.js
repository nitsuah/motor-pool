/**
 * The LLM URL used for a call (and therefore the destination of the endpoint's
 * API key) is derived from the current endpoint config, not from the URL cached
 * on the session.
 */
import assert from 'node:assert/strict';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
const { prepareSessionForLlmCall } = await import('../server.js');
const { LLM_CONFIG } = await import('../modules/llm-config.js');

LLM_CONFIG.keyed_test = {
  url: 'http://keyed.internal:9000', name: 'keyed', backendType: 'custom', type: 'general',
  apiStyle: 'openai', defaultModel: 'm', apiKey: 'test-key',
};

const session = {
  id: 'sess_url_cfg', endpoint: 'keyed_test', model: 'm',
  llmUrl: 'https://cached.example/v1', messages: [],
};
const prepared = await prepareSessionForLlmCall(session);
assert.equal(prepared.llmUrl, 'http://keyed.internal:9000/v1', 'URL comes from current config');
assert.equal(session.llmUrl, 'http://keyed.internal:9000/v1', 'session cache is refreshed');

// Config changes are picked up on the next call.
LLM_CONFIG.keyed_test.url = 'http://moved.internal:9100';
const again = await prepareSessionForLlmCall(session);
assert.equal(again.llmUrl, 'http://moved.internal:9100/v1');
console.log('LLM URL from config test passed.');

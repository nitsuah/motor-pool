/**
 * Background tasks use the shared demo policy, and the availability fallback
 * only switches to endpoints the session is permitted to use.
 */
import assert from 'node:assert/strict';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
process.env.PUBLIC_DEMO_MODE = '1';
const demo = await import('../server.js');
const { LLM_CONFIG } = await import('../modules/llm-config.js');

// Task experience goes through the demo policy and gets no tools.
assert.equal(demo.resolveTaskExperience({ title: 't' }), 'safechat', 'default task experience is safechat in demo mode');
assert.equal(demo.resolveTaskExperience({ title: 't', experience: 'developer' }), 'safechat', 'explicit developer is overridden');
assert.equal(demo.resolveTaskExperience({ title: 't', experience: 'website' }), 'safechat');

// Availability fallback: an unreachable primary must not move a restricted session.
LLM_CONFIG.custom_open = {
  url: 'http://custom.internal:9000', name: 'custom', backendType: 'custom', type: 'general',
  apiStyle: 'openai', defaultModel: 'm', apiKey: '',
};
const mk = (id, experience) => ({
  id, endpoint: 'primary', model: 'x', llmUrl: 'http://127.0.0.1:1', messages: [], experience,
});

const safe = mk('sess_safe', 'safechat');
await demo.prepareSessionForLlmCall(safe);
assert.equal(safe.endpoint, 'primary', 'safechat session keeps its endpoint');

const asDeveloperInDemo = mk('sess_dev_demo', 'developer');
await demo.prepareSessionForLlmCall(asDeveloperInDemo);
assert.equal(asDeveloperInDemo.endpoint, 'primary', 'demo policy applies even if the session says developer');

// Without demo mode, a developer session may fall back, but never to an endpoint
// outside its experience's allowed list (such as a custom one).
const { spawnSync } = await import('node:child_process');
const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
process.env.AGENT_DASHBOARD_DISABLE_LISTEN='1';
delete process.env.PUBLIC_DEMO_MODE;
const m = await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)});
const { LLM_CONFIG } = await import(${JSON.stringify(new URL('../modules/llm-config.js', import.meta.url).href)});
const { getAllowedEndpoints } = m;
const entries = Object.entries(LLM_CONFIG);
for (const k of Object.keys(LLM_CONFIG)) if (LLM_CONFIG[k].apiStyle === 'openai' && !getAllowedEndpoints('developer').includes(k)) LLM_CONFIG[k].apiStyle = 'ollama';
LLM_CONFIG.custom_open = { url: 'http://custom.internal:9000', name: 'c', backendType: 'custom', type: 'general', apiStyle: 'openai', defaultModel: 'm', apiKey: '' };
const s = { id: 'd', endpoint: 'primary', model: 'x', llmUrl: 'http://127.0.0.1:1', messages: [], experience: 'developer' };
await m.prepareSessionForLlmCall(s);
console.log(JSON.stringify({ endpoint: s.endpoint, allowed: getAllowedEndpoints('developer') }));
const t = { id: 't', endpoint: 'primary', model: 'x', llmUrl: 'http://127.0.0.1:1', messages: [], experience: 'safechat' };
await m.prepareSessionForLlmCall(t);
console.log(JSON.stringify({ safechat: t.endpoint }));
`], { encoding: 'utf8' });
const lines = child.stdout.trim().split('\n').filter((l) => l.startsWith('{"'));
const dev = JSON.parse(lines.find((l) => l.includes('"allowed"')));
assert.notEqual(dev.endpoint, 'custom_open', 'fallback never picks an endpoint outside the experience policy');
assert.ok(dev.endpoint === 'primary' || dev.allowed.includes(dev.endpoint));
assert.equal(JSON.parse(lines.find((l) => l.includes('"safechat"'))).safechat, 'primary');
console.log('Task demo policy tests passed.');
process.exit(0);

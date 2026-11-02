import assert from 'node:assert/strict';
import axios from 'axios';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';

const { app } = await import('../server.js');

const server = app.listen(0);
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

async function request(path, { method = 'GET', data } = {}) {
  const response = await axios({
    method,
    url: `${BASE}${path}`,
    data,
    timeout: 20000,
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data };
}

async function run() {
  try {
    console.log('Tools API tests');

    // /api/tools always answers, reporting reachability per tool server.
    // The tool servers themselves (profile `tools`) may or may not be running.
    const tools = await request('/api/tools');
    assert.equal(tools.status, 200, 'tools endpoint should return 200');
    assert.equal(tools.data.success, true, 'tools payload should be successful');
    assert.equal(typeof tools.data.dockerControlEnabled, 'boolean', 'dockerControlEnabled should be boolean');
    const keys = tools.data.tools.map(t => t.key).sort();
    assert.deepEqual(keys, ['content_gen', 'tokeneconomizer', 'website'], 'all tool servers should be listed');
    for (const tool of tools.data.tools) {
      assert.equal(typeof tool.running, 'boolean', `${tool.key} running flag should be boolean`);
      assert.ok(tool.serviceKey, `${tool.key} should expose its service registry key`);
      assert.ok(tool.url.startsWith('http'), `${tool.key} should expose its base url`);
    }

    // Unknown tool servers are rejected, not silently proxied
    const unknownList = await request('/api/tools/nope/tools');
    assert.equal(unknownList.status, 404, 'unknown tool server should 404 on list');

    const unknownCall = await request('/api/tools/nope/call', { method: 'POST', data: { name: 'x' } });
    assert.equal(unknownCall.status, 404, 'unknown tool server should 404 on call');

    // Calls without a tool name are rejected before touching the tool server
    const missingName = await request('/api/tools/content_gen/call', { method: 'POST', data: {} });
    assert.equal(missingName.status, 400, 'call without a tool name should 400');

    // Listing tools either succeeds (server up) or surfaces a clear 502 (server down) —
    // never a silent empty success.
    const contentGenList = await request('/api/tools/content_gen/tools');
    if (contentGenList.status === 200) {
      assert.equal(contentGenList.data.success, true);
      assert.ok(Array.isArray(contentGenList.data.tools), 'tool list should be an array');
      const names = contentGenList.data.tools.map(t => t.name);
      assert.ok(names.includes('generate_video'), 'content-gen should expose generate_video');
    } else {
      assert.equal(contentGenList.status, 502, 'unreachable tool server should surface 502');
      assert.equal(contentGenList.data.success, false);
      assert.match(contentGenList.data.error, /unreachable/i, '502 should explain the server is unreachable');
    }

    // System service registry exposes the tool containers for start/stop control
    const services = await request('/api/system/services');
    assert.equal(services.status, 200);
    assert.ok(services.data.services.tool_content_gen, 'registry should include tool_content_gen');
    assert.ok(services.data.services.tool_website, 'registry should include tool_website');

    // Experiences include the tool-backed ones with their tool bindings
    const experiences = await request('/api/experiences');
    assert.equal(experiences.status, 200);
    const exps = experiences.data.experiences;
    if (!experiences.data.demoMode?.enabled) {
      assert.equal(exps.content_gen?.tool, 'content_gen', 'content_gen experience should bind its tool');
      assert.equal(exps.website?.tool, 'website', 'website experience should bind its tool');
    }

    console.log('Tools API tests passed.');
  } finally {
    server.close();
  }
}

run().catch((error) => {
  console.error('Tools API tests failed:', error.message);
  process.exit(1);
});

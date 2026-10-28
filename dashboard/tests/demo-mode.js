import assert from 'node:assert/strict';
import axios from 'axios';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
process.env.PUBLIC_DEMO_MODE = '1';
// This test only exercises demo-mode routing. Keep model discovery isolated so
// host Docker/network availability cannot consume its 10s request timeout.
process.env.PRIMARY_LLM_URL = 'http://127.0.0.1:1';
process.env.PRIMARY_LLM_URL_CANDIDATES = 'http://127.0.0.1:1';

const { app } = await import('../server.js');

const server = app.listen(0);
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

async function request(path, { method = 'GET', data } = {}) {
  const response = await axios({
    method,
    url: `${BASE}${path}`,
    data,
    timeout: 10000,
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data };
}

async function run() {
  try {
    console.log('Demo mode API tests');

    const demoStatus = await request('/api/demo-mode');
    assert.equal(demoStatus.status, 200);
    assert.equal(demoStatus.data.success, true);
    assert.equal(demoStatus.data.enabled, true);
    assert.equal(demoStatus.data.enforcedExperience, 'safechat');

    const experiences = await request('/api/experiences');
    assert.equal(experiences.status, 200);
    assert.equal(experiences.data.success, true);
    assert.deepEqual(Object.keys(experiences.data.experiences), ['safechat']);

    const sessionCreate = await request('/api/sessions', {
      method: 'POST',
      data: {
        name: 'demo-mode-test',
        experience: 'developer',
        endpoint: 'docker_runner',
        model: 'ai/qwen3-coder:latest'
      }
    });

    assert.equal(sessionCreate.status, 200);
    assert.equal(sessionCreate.data.success, true);
    assert.equal(sessionCreate.data.session.experience, 'safechat');
    assert.equal(sessionCreate.data.session.endpoint, 'primary');

    const sessionId = sessionCreate.data.session.id;

    const switchDenied = await request(`/api/sessions/${sessionId}/model`, {
      method: 'PUT',
      data: { endpoint: 'docker_runner', model: 'ai/qwen3-coder:latest' }
    });

    assert.equal(switchDenied.status, 403);
    assert.equal(switchDenied.data.success, false);

    const models = await request('/api/models');
    assert.equal(models.status, 200);
    assert.equal(models.data.success, true);
    assert.ok(models.data.models.every((m) => m.id === 'primary'));

    console.log('Demo mode API tests passed.');
  } finally {
    server.close();
  }
}

run().catch((error) => {
  console.error('Demo mode API tests failed:', error.message);
  process.exit(1);
});

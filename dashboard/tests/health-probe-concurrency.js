import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
// This fixture verifies an optional cloud provider does not degrade health
// until configured. Keep it unconfigured even if the CI environment has a key.
process.env.NINEROUTER_API_KEY = '';
// The live vault may have persisted BYOK endpoints. Keep the concurrency
// assertion limited to the three mock upstreams plus the shared runner aliases.
process.env.CUSTOM_LLM_ENDPOINTS = '[]';
const endpointStoreDir = mkdtempSync(join(tmpdir(), 'motor-pool-health-probe-'));
process.env.ENDPOINT_STORE_PATH = join(endpointStoreDir, 'endpoints.json');

let activeProbes = 0;
let maxConcurrentProbes = 0;

function createProbeServer(getPayload) {
  return http.createServer((req, res) => {
    activeProbes++;
    maxConcurrentProbes = Math.max(maxConcurrentProbes, activeProbes);
    setTimeout(() => {
      activeProbes--;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getPayload(req.url)));
    }, 150);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const models = [
  { id: 'ai/qwen3-coder:latest' },
  { id: 'ai/glm-4.7-flash:latest' },
  { id: 'local-test' },
];
const primaryProbe = createProbeServer(() => ({ models: [] }));
const runnerProbe = createProbeServer(() => ({ data: models }));
const openllmPaths = [];
const openllmProbe = createProbeServer(path => {
  openllmPaths.push(path);
  return path === '/v1/models' ? { data: models } : { error: 'expected /v1/models' };
});
const probes = [primaryProbe, runnerProbe, openllmProbe];
let dashboard;

try {
  const [primaryUrl, runnerUrl, openllmUrl] = await Promise.all(probes.map(listen));
  process.env.PRIMARY_LLM_URL = primaryUrl;
  process.env.DOCKER_RUNNER_URL = runnerUrl;
  process.env.OPENLLM_URL = openllmUrl;
  process.env.OPENLLM_MODEL = 'local-test';
  process.env.DOCKER_RUNNER_MODEL = 'ai/qwen3-coder:latest';
  process.env.GLM_FLASH_MODEL = 'ai/glm-4.7-flash:latest';

  const { app } = await import('../server.js');
  dashboard = app.listen(0, '127.0.0.1');
  await new Promise(resolve => dashboard.once('listening', resolve));

  const startedAt = Date.now();
  const response = await axios.get(`http://127.0.0.1:${dashboard.address().port}/api/health`, { timeout: 5000 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.data.status, 'ok');
  assert.equal(response.data.endpoints.primary, 'healthy');
  assert.equal(response.data.endpoints.docker_runner, 'healthy');
  assert.equal(response.data.endpoints.glm_flash, 'healthy');
  assert.equal(response.data.endpoints.openllm, 'healthy');
  assert.equal(response.data.endpoints.ninerouter, 'unconfigured');
  assert.ok(openllmPaths.includes('/v1/models'), 'OpenLLM must use its OpenAI-compatible model-list route');
  assert.equal(maxConcurrentProbes, 3, 'primary, shared runner, and OpenLLM probes should overlap');
  assert.ok(elapsedMs < 450, `three 150ms probes should not stack sequentially (took ${elapsedMs}ms)`);

  console.log(`Health endpoint probed providers concurrently (${elapsedMs}ms)`);

  maxConcurrentProbes = 0;
  const modelsStartedAt = Date.now();
  const modelsResponse = await axios.get(`http://127.0.0.1:${dashboard.address().port}/api/models`, { timeout: 5000 });
  const modelsElapsedMs = Date.now() - modelsStartedAt;
  assert.equal(modelsResponse.data.success, true);
  assert.ok(modelsResponse.data.models.length > 0);
  assert.equal(maxConcurrentProbes, 3, 'primary, shared runner, and OpenLLM model lists should overlap');
  assert.ok(modelsElapsedMs < 550, `model discovery should not serialize provider requests (took ${modelsElapsedMs}ms)`);

  console.log(`Model discovery probed providers concurrently (${modelsElapsedMs}ms)`);
} finally {
  if (dashboard) await new Promise(resolve => dashboard.close(resolve));
  await Promise.all(probes.map(server => new Promise(resolve => server.close(resolve))));
  rmSync(endpointStoreDir, { recursive: true, force: true });
}

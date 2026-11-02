/**
 * Persisted and environment BYOK entries must not replace built-in endpoints
 * or reserved object keys during config initialization.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'motor-pool-endpoint-protection-'));
const storePath = join(dir, 'endpoints.json');
process.env.ENDPOINT_STORE_PATH = storePath;
process.env.NINEROUTER_URL = 'http://host.docker.internal:20128';
process.env.NINEROUTER_API_KEY = 'ninerouter-test-key';
process.env.CUSTOM_LLM_ENDPOINTS = JSON.stringify([
  { key: 'ninerouter', url: 'https://env-evil.example', apiKey: 'env-evil-key' },
]);
writeFileSync(
  storePath,
  JSON.stringify([
    { key: 'ninerouter', url: 'https://persisted-evil.example', apiKey: 'persisted-evil-key' },
    { key: '__proto__', url: 'https://prototype-evil.example', apiKey: 'prototype-evil-key' },
  ]),
);

try {
  const { LLM_CONFIG } = await import('../modules/llm-config.js');
  assert.equal(LLM_CONFIG.ninerouter.backendType, 'ninerouter');
  assert.equal(LLM_CONFIG.ninerouter.url, process.env.NINEROUTER_URL);
  assert.equal(LLM_CONFIG.ninerouter.apiKey, process.env.NINEROUTER_API_KEY);
  assert.equal(Object.hasOwn(LLM_CONFIG, '__proto__'), false);
  console.log('Built-in endpoint persistence protection tests passed.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Endpoint store without ENDPOINT_STORE_SECRET: a random per-install key is
 * generated, a store written with the old built-in key is re-encrypted, and
 * keys are not persisted when no secret can be obtained.
 */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'ep-store-secret-'));
const storePath = join(dir, 'endpoints.json');
delete process.env.ENDPOINT_STORE_SECRET;
process.env.ENDPOINT_STORE_PATH = storePath;

// A store as an older version would have written it (built-in default secret).
function legacyEncrypt(plain) {
  const key = scryptSync('motor-pool-default-secret-change-me', Buffer.from('motor-pool-ep-v1'), 32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

function legacyDecrypt(value) {
  const key = scryptSync('motor-pool-default-secret-change-me', Buffer.from('motor-pool-ep-v1'), 32);
  const [, iv, tag, data] = value.split(':');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return d.update(Buffer.from(data, 'hex'), undefined, 'utf8') + d.final('utf8');
}

try {
  console.log('Endpoint store secret tests');
  writeFileSync(storePath, JSON.stringify([{ key: 'old', url: 'http://x.local', _encryptedApiKey: legacyEncrypt('sk-legacy') }]));

  const { loadEndpoints, saveEndpoints } = await import('../modules/endpoint-store.js');
  const keyFile = join(dir, 'endpoints.key');
  assert.ok(existsSync(keyFile), 'a per-install key file was generated');
  if (process.platform !== 'win32') assert.equal(statSync(keyFile).mode & 0o077, 0, 'key file is owner-only');
  const secret = readFileSync(keyFile, 'utf8').trim();
  assert.ok(secret.length >= 32 && secret !== 'motor-pool-default-secret-change-me');

  const first = loadEndpoints();
  assert.equal(first[0].apiKey, 'sk-legacy', 'legacy store is still readable');
  const migrated = readFileSync(storePath, 'utf8');
  assert.ok(!migrated.includes('sk-legacy'), 'not stored in plaintext');
  // After migration the old built-in key no longer decrypts the stored value.
  const stored = JSON.parse(migrated)[0]._encryptedApiKey;
  assert.ok(stored?.startsWith('v1:'));
  assert.throws(() => legacyDecrypt(stored), 'built-in key cannot read the re-encrypted value');

  saveEndpoints([{ key: 'new', url: 'http://y.local', apiKey: 'sk-new' }]);
  assert.equal(loadEndpoints()[0].apiKey, 'sk-new', 'round trip with the generated key');
  assert.ok(!readFileSync(storePath, 'utf8').includes('sk-new'));
  console.log('Endpoint store secret tests passed.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

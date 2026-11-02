import assert from 'node:assert/strict';
import { getOrCreateUserId } from '../src/constants/app-config.js';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalNow = Date.now;
const values = new Map();
const fixedNow = 123456789;
const fixedNowBase36 = fixedNow.toString(36);
const setCrypto = (value) => Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
try {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  Date.now = () => fixedNow;

  // No Web Crypto: fallback remains a local UI identifier, not an auth/session token.
  setCrypto(undefined);
  const fallbackId = getOrCreateUserId();
  assert.strictEqual(fallbackId, `anon_${fixedNowBase36}_${fixedNowBase36}_1`);
  assert.strictEqual(values.get('agent_board_user_id'), fallbackId);
  assert.strictEqual(getOrCreateUserId(), fallbackId, 'fallback ID is stable in local storage');

  values.clear();
  setCrypto({ randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' });
  const uuidId = getOrCreateUserId();
  assert.strictEqual(uuidId, 'anon_123e4567-e89b-12d3-a456-426614174000');
  assert.strictEqual(values.get('agent_board_user_id'), uuidId);

  values.clear();
  let randomCalls = 0;
  setCrypto({
    getRandomValues: (buffer) => {
      randomCalls++;
      buffer[0] = 123;
      buffer[1] = 456;
      return buffer;
    },
  });
  const randomId = getOrCreateUserId();
  const expectedSuffix = new Uint32Array([123, 456]).join('_').slice(2, 11);
  assert.strictEqual(randomId, `anon_${fixedNowBase36}_${expectedSuffix}`);
  assert.strictEqual(randomCalls, 1);
  assert.strictEqual(values.get('agent_board_user_id'), randomId);
  console.log('app-config user ID crypto and fallback tests passed.');
} finally {
  Date.now = originalNow;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete globalThis.crypto;
}

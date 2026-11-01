import assert from 'node:assert/strict';
import { getOrCreateUserId } from '../src/constants/app-config.js';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const values = new Map();
try {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  const id = getOrCreateUserId();
  assert.match(id, /^anon_[a-z0-9]+_[a-z0-9]+$/);
  assert.strictEqual(values.get('agent_board_user_id'), id);
  assert.strictEqual(getOrCreateUserId(), id, 'the fallback ID is stable in local storage');
  console.log('app-config user ID fallback test passed.');
} finally {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete globalThis.crypto;
}

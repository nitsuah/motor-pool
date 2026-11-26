import assert from 'node:assert/strict';
import { createTokenEconomizer } from '../modules/token-economizer.js';

let invokeCount = 0;

async function runTests() {
  // Test 1: disabled
  invokeCount = 0;
  const disabled = createTokenEconomizer({
    invoke: async () => { invokeCount++; return { ok: true }; },
    isEnabled: false,
  });
  assert.deepEqual(await disabled.getStatus(), { ok: false, reason: 'disabled' });
  assert.equal(await disabled.getMicroskillsForInjection(), '');
  assert.equal(invokeCount, 0);

  // Test 2: enabled with invoke returning { sessions: 2 }
  invokeCount = 0;
  const enabled = createTokenEconomizer({
    invoke: async () => { invokeCount++; return { sessions: 2 }; },
    isEnabled: true,
  });
  assert.deepEqual(await enabled.getStatus(), { ok: true, status: { sessions: 2 } });

  // Test 3: invoke throwing Error('boom')
  invokeCount = 0;
  const throwing = createTokenEconomizer({
    invoke: async () => { invokeCount++; throw new Error('boom'); },
    isEnabled: true,
  });
  assert.deepEqual(await throwing.getStatus(), { ok: false, reason: 'boom' });
  assert.equal(await throwing.getMicroskillsForInjection(), '');

  // Test 4: invoke returning { ok: false, reason: 'down' }
  invokeCount = 0;
  const down = createTokenEconomizer({
    invoke: async () => { invokeCount++; return { ok: false, reason: 'down' }; },
    isEnabled: true,
  });
  assert.deepEqual(await down.getStatus(), { ok: false, reason: 'down' });

  // Test 5: invoke returning { microskills: ['use rg', { text: ' run tests ' }, 5] }
  invokeCount = 0;
  const micro = createTokenEconomizer({
    invoke: async () => { invokeCount++; return { microskills: ['use rg', { text: ' run tests ' }, 5] }; },
    isEnabled: true,
  });
  assert.equal(await micro.getMicroskillsForInjection(), '- use rg\n- run tests');

  console.log('token-economizer-unit: ok');
}

runTests();

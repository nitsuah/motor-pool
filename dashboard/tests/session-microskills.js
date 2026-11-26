import assert from 'node:assert/strict';
import { injectTokenEconomizerMicroskills } from '../modules/token-economizer-microskills.js';

const base = [{ role: 'system', content: 'Base policy' }, { role: 'user', content: 'hello' }];

{
  let calls = 0;
  const result = await injectTokenEconomizerMicroskills(base, {
    getMicroskillsForInjection: async () => { calls++; return '- use rg'; },
  });
  assert.equal(calls, 1);
  assert.equal(result[0].content, 'Base policy\n\nRepository micro-skills (TokenEconomizer):\n- use rg');
  assert.equal(result[1], base[1]);
  assert.equal(base[0].content, 'Base policy', 'input messages remain immutable');
}
{
  let calls = 0;
  const result = await injectTokenEconomizerMicroskills(base, {
    getMicroskillsForInjection: async () => { calls++; return ''; },
  });
  assert.equal(calls, 1);
  assert.equal(result, base);
}
{
  const result = await injectTokenEconomizerMicroskills(base, null);
  assert.equal(result, base);
}
{
  const result = await injectTokenEconomizerMicroskills(base, {
    getMicroskillsForInjection: async () => { throw new Error('offline'); },
  });
  assert.equal(result, base);
}
{
  const result = await injectTokenEconomizerMicroskills(base, {
    getMicroskillsForInjection: async () => '   ',
  });
  assert.equal(result, base);
}
console.log('session-microskills: ok');

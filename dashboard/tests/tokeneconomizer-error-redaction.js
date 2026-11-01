import assert from 'node:assert/strict';
import { safeTeError } from '../../tools/tokeneconomizer/safe-error.mjs';

const response = safeTeError({
  status: 500,
  error: 'te config set API_TOKEN=sentinel-secret failed',
  output: 'stdout sentinel-secret / stderr sentinel-secret',
  details: 'spawn details sentinel-secret',
});
assert.deepStrictEqual(response, {
  code: 'TE_COMMAND_FAILED',
  error: 'TokenEconomizer command failed',
});
assert.doesNotMatch(JSON.stringify(response), /sentinel-secret|stdout|stderr|spawn details/);

assert.deepStrictEqual(safeTeError({ status: 504, error: 'timeout sentinel-secret' }), {
  code: 'TE_TIMEOUT',
  error: 'TokenEconomizer command timed out',
});
console.log('TokenEconomizer error redaction tests passed.');

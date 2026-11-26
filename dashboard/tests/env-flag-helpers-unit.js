/**
 * Unit tests for the small env-flag helpers: isOn / EXEC_ROLES (modules/exec-flag.js)
 * and isTruthyEnv / isBuiltinEndpointKey (modules/llm-config.js).
 */
import assert from 'node:assert/strict';
import { isOn, EXEC_ROLES } from '../modules/exec-flag.js';
import { isTruthyEnv, isBuiltinEndpointKey, LLM_CONFIG } from '../modules/llm-config.js';

// ── isOn ──────────────────────────────────────────────────────────────────────
for (const v of ['1', 'true', 'yes', 'on', ' TRUE ', 'On']) {
  assert.equal(isOn(v), true, `isOn(${JSON.stringify(v)}) is true`);
}
for (const v of ['0', 'false', 'off', '', undefined, null, '2', 'y']) {
  assert.equal(isOn(v), false, `isOn(${JSON.stringify(v)}) is false`);
}

// ── isTruthyEnv ───────────────────────────────────────────────────────────────
for (const v of ['1', 'true', 'yes', 'on', 'On']) {
  assert.equal(isTruthyEnv(v), true, `isTruthyEnv(${JSON.stringify(v)}) agrees with isOn`);
}
for (const v of ['0', 'false', 'off', '', undefined, null, '2', 'y']) {
  assert.equal(isTruthyEnv(v), false, `isTruthyEnv(${JSON.stringify(v)}) agrees with isOn`);
}
// Unlike isOn, isTruthyEnv does not trim surrounding whitespace.
assert.equal(isTruthyEnv(' true '), false, 'isTruthyEnv does not trim');
assert.equal(isOn(' true '), true, 'isOn trims');

// ── EXEC_ROLES ────────────────────────────────────────────────────────────────
assert.equal(Object.isFrozen(EXEC_ROLES), true, 'EXEC_ROLES is frozen');
assert.deepEqual([...EXEC_ROLES], ['superadmin', 'operator'], 'EXEC_ROLES contents');
assert.throws(() => EXEC_ROLES.push('guest'), TypeError, 'pushing to EXEC_ROLES throws');

// ── isBuiltinEndpointKey ──────────────────────────────────────────────────────
assert.equal(isBuiltinEndpointKey('primary'), true, 'primary is built in');
for (const key of ['nope', '', '__proto__', 'constructor', undefined]) {
  assert.equal(isBuiltinEndpointKey(key), false, `${JSON.stringify(key)} is not built in`);
}
for (const key of ['primary', 'docker_runner', 'glm_flash', 'openllm', 'ninerouter']) {
  assert.equal(isBuiltinEndpointKey(key), true, `${key} is built in`);
  assert.ok(key in LLM_CONFIG, `${key} is present in LLM_CONFIG`);
}

console.log('env-flag-helpers-unit: all assertions passed');

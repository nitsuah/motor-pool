import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
const { assertUrlSafeDbPassword } = await import('../persistence.js');

assert.doesNotThrow(() => assertUrlSafeDbPassword({}), 'unset is skipped');
assert.doesNotThrow(() => assertUrlSafeDbPassword({ POSTGRES_PASSWORD: 'Abc123._~-xyz' }));
for (const bad of ['p@ss', 'a/b', 'a:b', 'a b', 'a#b', 'a%b', 'a?b']) {
  assert.throws(() => assertUrlSafeDbPassword({ POSTGRES_PASSWORD: bad }), /POSTGRES_PASSWORD/, bad);
}
console.log('DB password validation tests passed.');

/**
 * Tests for worktrees.js: slugifyWorktreeName ReDoS protection and valid input behavior.
 */
import assert from 'node:assert/strict';
import { slugifyWorktreeName } from '../routes/worktrees.js';

function timeIt(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const end = process.hrtime.bigint();
  return { result, ms: Number(end - start) / 1_000_000 };
}

// Test 1: Pathological input (50k repeated non-alphanumeric chars) must finish fast.
// This exposes super-linear backtracking in the /[^a-z0-9]+/g replace.
const hostile = '!'.repeat(50000);
const { result: hostileResult, ms: hostileMs } = timeIt(() => slugifyWorktreeName(hostile));
assert.ok(hostileMs < 100, `hostile input took ${hostileMs.toFixed(1)}ms, expected < 100ms`);
// The function should return null (doesn't match SLUG_RE after processing)
assert.strictEqual(hostileResult, null, 'hostile input should produce null slug');

// Test 2: Valid ordinary inputs still produce correct slugs.
const cases = [
  ['My Worktree', 'my-worktree'],
  ['  leading/trailing  ', 'leading-trailing'],
  ['UPPERCASE', 'uppercase'],
  ['special!@#chars', 'special-chars'],
  ['multiple---dashes', 'multiple-dashes'],
  ['a'.repeat(50), 'a'.repeat(40)], // caps at 40
  ['valid-slug-123', 'valid-slug-123'],
];

for (const [input, expected] of cases) {
  const out = slugifyWorktreeName(input);
  assert.strictEqual(out, expected, `slugifyWorktreeName(${JSON.stringify(input)}) = ${JSON.stringify(out)}, expected ${JSON.stringify(expected)}`);
}

console.log('Worktree slugify tests passed.');

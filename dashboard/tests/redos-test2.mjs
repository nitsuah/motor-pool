import { slugifyWorktreeName } from '../routes/worktrees.js';

// More pathological inputs for ReDoS testing
const testCases = [
  // Classic ReDoS pattern: many matches + one non-match at end
  ['many a then !', 'a'.repeat(50000) + '!'],
  ['many a then !!', 'a'.repeat(50000) + '!!'],
  ['many a then !!!', 'a'.repeat(50000) + '!!!'],
  ['many a then ----', 'a'.repeat(50000) + '----'],
  // Alternating patterns that can trigger backtracking
  ['a!a!a! pattern', ('a!').repeat(25000)],
  ['a! pattern', ('a!').repeat(25000)],
  // Very long strings
  ['100k a then !', 'a'.repeat(100000) + '!'],
  ['100k a then !!', 'a'.repeat(100000) + '!!'],
];

for (const [name, input] of testCases) {
  const start = process.hrtime.bigint();
  const result = slugifyWorktreeName(input);
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1_000_000;
  console.log(`${name}: length=${input.length}, time=${ms.toFixed(2)}ms, result=${JSON.stringify(result)}`);
}
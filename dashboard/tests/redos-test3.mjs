import { slugifyWorktreeName } from '../routes/worktrees.js';

// Even more pathological inputs - larger scale
const testCases = [
  ['1M a! pattern', ('a!').repeat(500000)],
  ['500k a then !', 'a'.repeat(500000) + '!'],
  ['1M !', '!'.repeat(1000000)],
  ['500k a then !!!', 'a'.repeat(500000) + '!!!'],
];

for (const [name, input] of testCases) {
  const start = process.hrtime.bigint();
  const result = slugifyWorktreeName(input);
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1_000_000;
  console.log(`${name}: length=${input.length}, time=${ms.toFixed(2)}ms, result=${JSON.stringify(result)}`);
}

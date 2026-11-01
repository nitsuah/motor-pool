import { slugifyWorktreeName } from '../routes/worktrees.js';

// Final ReDoS verification
const cases = [
  ['1M a! pattern', ('a!').repeat(500000)],
  ['500k a then !', 'a'.repeat(500000) + '!'],
  ['1M !', '!'.repeat(1000000)],
];

for (const [name, input] of cases) {
  const start = process.hrtime.bigint();
  const result = slugifyWorktreeName(input);
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1_000_000;
  console.log(`${name}: ${ms.toFixed(2)}ms (was ~226ms before fix)`);
}
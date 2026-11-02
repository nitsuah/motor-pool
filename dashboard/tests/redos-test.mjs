import { slugifyWorktreeName } from '../routes/worktrees.js';

// Test with various potentially problematic inputs
const testCases = [
  ['exclamation repeat', '!'.repeat(50000)],
  ['dash repeat', '-'.repeat(50000)],
  ['alphanum + exclamation', 'a'.repeat(10000) + '!'.repeat(40000)],
  ['exclamation + alphanum + exclamation', '!'.repeat(25000) + 'a'.repeat(25000) + '!'.repeat(25000)],
  ['triple dash repeat', '---'.repeat(16666)],
  ['triple dash + alphanum', '---a'.repeat(12500)],
  ['alphanum + triple dash', 'a---'.repeat(12500)],
];

for (const [name, input] of testCases) {
  const start = process.hrtime.bigint();
  const result = slugifyWorktreeName(input);
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1_000_000;
  console.log(`${name}: length=${input.length}, time=${ms.toFixed(2)}ms, result=${JSON.stringify(result)}`);
}

import { defineConfig } from 'vitest/config';

// Root-level unit tests (test/). The dashboard keeps its own node runner +
// c8 coverage (dashboard/scripts/run-unit-tests.mjs, `npm run test:coverage`),
// and tests/journeys runs under Playwright, so both are out of scope here.
export default defineConfig({
  test: {
    // test/ suites use describe/it without importing them.
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js', 'test/**/*.test.mjs'],
  },
});

#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, '..', 'tests');

// Only suites that genuinely need something outside this process are excluded:
// e2e-chat / e2e-chat-matrix / e2e-agents need a live LLM to answer prompts, and
// e2e-services needs a running Docker stack. Everything else starts the app
// in-process (directly, or via tests/helpers/test-server.js), so it belongs in
// the unit run and in the coverage numbers.
const INTEGRATION_TESTS = new Set([
  'e2e-chat.js', 'e2e-chat-matrix.js', 'e2e-agents.js', 'e2e-services.js',
  'discover-ssrf-regression.test.js',
]);

const SPECIAL = new Set(['safety-layer.js']);

const files = readdirSync(testsDir)
  .filter(f => f.endsWith('.js') && !INTEGRATION_TESTS.has(f) && !SPECIAL.has(f))
  .sort();

let passed = 0;
let failed = 0;
const testDataDir = mkdtempSync(join(tmpdir(), 'motor-pool-unit-tests-'));
const baseTestEnv = {
  ...process.env,
  // Unit tests must not write through Compose's persistent application volumes
  // or mutate the configured Postgres database when run inside a live container.
  DATABASE_URL: '',
};

try {
  // safety-layer.js runs without --experimental-vm-modules
  for (const f of ['safety-layer.js', ...files]) {
    const path = join(testsDir, f);
    const args = f === 'safety-layer.js' ? [path] : ['--experimental-vm-modules', path];
    const env = {
      ...baseTestEnv,
      // A separate file per test prevents cross-test state and protects the
      // dashboard's live session snapshot and BYOK endpoint store.
      SESSION_SNAPSHOT_PATH: join(testDataDir, `${f}.sessions.json`),
      ENDPOINT_STORE_PATH: join(testDataDir, `${f}.endpoints.json`),
    };
    try {
      execFileSync(process.execPath, args, { stdio: 'inherit', env });
      passed++;
    } catch {
      failed++;
      console.error(`\n✗ FAILED: ${f}\n`);
    }
  }
} finally {
  rmSync(testDataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} unit tests`);
if (failed > 0) process.exit(1);

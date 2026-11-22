import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSslOption } from '../persistence.js';

assert.equal(buildSslOption({}), false, 'TLS off unless requested');
assert.deepEqual(buildSslOption({ DATABASE_SSL: '1' }), { rejectUnauthorized: true }, 'verifies by default');
const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
assert.deepEqual(buildSslOption({ DATABASE_SSL: 'true', DATABASE_SSL_CA: pem }), { rejectUnauthorized: true, ca: pem });
assert.deepEqual(buildSslOption({ DATABASE_SSL: '1', DATABASE_SSL_INSECURE: '1' }), { rejectUnauthorized: false }, 'explicit dev opt-out');
assert.deepEqual(
  buildSslOption({ DATABASE_SSL: '1', DATABASE_SSL_INSECURE: '1', NODE_ENV: 'production' }),
  { rejectUnauthorized: true },
  'opt-out ignored in production',
);

const dir = mkdtempSync(join(tmpdir(), 'pg-ca-'));
try {
  const caFile = join(dir, 'ca.pem');
  writeFileSync(caFile, pem);
  assert.deepEqual(buildSslOption({ DATABASE_SSL: '1', DATABASE_SSL_CA: caFile }), { rejectUnauthorized: true, ca: pem }, 'reads a CA file');
  assert.throws(() => buildSslOption({ DATABASE_SSL: '1', DATABASE_SSL_CA: join(dir, 'missing.pem') }), /readable file/, 'missing CA file is an error');
  const junk = join(dir, 'junk.txt');
  writeFileSync(junk, 'not a cert');
  assert.throws(() => buildSslOption({ DATABASE_SSL: '1', DATABASE_SSL_CA: junk }), /PEM/, 'non-PEM CA file is an error');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('Persistence TLS option tests passed.');

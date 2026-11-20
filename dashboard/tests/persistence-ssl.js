import assert from 'node:assert/strict';
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
console.log('Persistence TLS option tests passed.');

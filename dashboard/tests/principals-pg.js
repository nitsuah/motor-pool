/**
 * The Postgres principal store against a real database: the additive
 * migration (run twice), bootstrap, mint/verify/revoke/expiry, and disabling a
 * principal revoking its tokens in one transaction.
 *
 * Skips unless TEST_DATABASE_URL points at a disposable database, e.g.
 *   docker run -d --name mp-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres node tests/principals-pg.js
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrateAuthTables } from '../persistence.js';
import { createPgStore, createPrincipalService, hashToken } from '../modules/principals.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('principals-pg: skipped (TEST_DATABASE_URL not set)');
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: url, max: 3 });
try {
  console.log('Principals Postgres store tests');
  await pool.query('DROP TRIGGER IF EXISTS mp_fail ON api_tokens').catch(() => {});
  await pool.query('DROP TABLE IF EXISTS api_tokens; DROP TABLE IF EXISTS principals;');
  await migrateAuthTables(pool);
  await migrateAuthTables(pool); // idempotent
  const { rows: [ver] } = await pool.query(`SELECT version FROM schema_version WHERE component = 'auth'`);
  assert.equal(ver.version, 1);

  let clock = new Date('2026-11-23T12:00:00Z');
  const svc = createPrincipalService({ store: createPgStore(pool), now: () => new Date(clock) });
  const BOOT = 'p'.repeat(48);
  assert.deepEqual(await svc.bootstrap({ MP_BOOTSTRAP_TOKEN: BOOT }), { bootstrapped: true });
  assert.equal((await svc.bootstrap({ MP_BOOTSTRAP_TOKEN: BOOT })).reason, 'principals_exist');
  assert.equal((await svc.verifyToken(BOOT)).principal.role, 'superadmin');

  await svc.createPrincipal({ id: 'carol', role: 'dispatcher', tenant: 't1' });
  await assert.rejects(svc.createPrincipal({ id: 'carol', role: 'dispatcher' }), /exists/);
  const t = await svc.mintToken({ principalId: 'carol', label: 'pg', expiresInDays: 2, scopes: ['imps:write'] });
  const { rows: [row] } = await pool.query('SELECT token_hash, scopes FROM api_tokens WHERE id = $1', [t.id]);
  assert.equal(row.token_hash, hashToken(t.token), 'stored hash, not plaintext');
  assert.deepEqual(row.scopes, ['imps:write']);
  const { rows: plain } = await pool.query('SELECT 1 FROM api_tokens WHERE token_hash = $1 OR label = $1', [t.token]);
  assert.equal(plain.length, 0);

  assert.equal((await svc.verifyToken(t.token)).principal.tenant, 't1');
  clock = new Date(clock.getTime() + 3 * 86_400_000);
  assert.equal(await svc.verifyToken(t.token), null, 'expired');

  const t2 = await svc.mintToken({ principalId: 'carol' });
  assert.ok(await svc.verifyToken(t2.token));
  await svc.revokeToken(t2.id);
  assert.equal(await svc.verifyToken(t2.token), null, 'revoked');

  const t3 = await svc.mintToken({ principalId: 'carol' });
  await svc.disablePrincipal('carol');
  assert.equal(await svc.verifyToken(t3.token), null, 'disabled principal');
  const { rows: live } = await pool.query(`SELECT id FROM api_tokens WHERE principal_id = 'carol' AND revoked_at IS NULL`);
  assert.equal(live.length, 0, 'disable revoked every token');
  await assert.rejects(svc.disablePrincipal('superadmin'), /last active superadmin/);
  assert.equal((await svc.listPrincipals()).length, 2);

  // Concurrent disables of the only two superadmins: exactly one wins.
  await svc.createPrincipal({ id: 'root2', role: 'superadmin' });
  const outcomes = await Promise.allSettled([svc.disablePrincipal('superadmin'), svc.disablePrincipal('root2')]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1, 'one superadmin always remains');
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM principals WHERE role = 'superadmin' AND disabled_at IS NULL`);
  assert.equal(n, 1);

  // Bootstrap is all-or-nothing: a failing token insert leaves no principal behind.
  await pool.query('TRUNCATE api_tokens, principals');
  const svc2 = createPrincipalService({ store: createPgStore(pool) });
  await pool.query(`CREATE OR REPLACE FUNCTION mp_fail_tokens() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`);
  await pool.query('CREATE TRIGGER mp_fail BEFORE INSERT ON api_tokens FOR EACH ROW EXECUTE FUNCTION mp_fail_tokens()');
  await assert.rejects(svc2.bootstrap({ MP_BOOTSTRAP_TOKEN: BOOT }), /boom/);
  await pool.query('DROP TRIGGER mp_fail ON api_tokens; DROP FUNCTION mp_fail_tokens()');
  const { rows: [{ c }] } = await pool.query('SELECT count(*)::int AS c FROM principals');
  assert.equal(c, 0, 'principal rolled back with the token');
  assert.deepEqual(await svc2.bootstrap({ MP_BOOTSTRAP_TOKEN: BOOT }), { bootstrapped: true }, 'bootstrap retries cleanly');
  const [b1, b2] = await Promise.all([
    createPrincipalService({ store: createPgStore(pool) }).bootstrap({ MP_BOOTSTRAP_TOKEN: 'q'.repeat(40) }),
    createPrincipalService({ store: createPgStore(pool) }).bootstrap({ MP_BOOTSTRAP_TOKEN: 'r'.repeat(40) }),
  ]);
  assert.equal(b1.bootstrapped || b2.bootstrapped, false, 'no second bootstrap once principals exist');
  console.log('  ok migration, bootstrap, mint/verify/expiry/revoke/disable on Postgres');
  console.log('principals-pg: all passed');
} finally {
  await pool.end();
}

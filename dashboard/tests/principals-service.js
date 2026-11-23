/**
 * Principals & API tokens: the service and in-memory store (no server).
 * Token format and hashing, expiry, revocation, disabled principals,
 * bootstrap rules, and the last-superadmin guard.
 */
import assert from 'node:assert/strict';
import {
  AuthError, BOOTSTRAP_PRINCIPAL_ID, createMemoryStore, createPrincipalService, hashToken, tokenLookupId,
} from '../modules/principals.js';
import { canSee, eventVisibleTo, isReservedEventType } from '../modules/visibility.js';

let clock = new Date('2026-11-23T12:00:00Z');
const now = () => new Date(clock);
const BOOT = 'b'.repeat(40);

async function rejectsWith(promise, status) {
  await assert.rejects(promise, (err) => err instanceof AuthError && err.status === status);
}

console.log('Principals service tests');

// ── Bootstrap ───────────────────────────────────────────────────────────
{
  const store = createMemoryStore();
  const svc = createPrincipalService({ store, now });
  assert.deepEqual(await svc.bootstrap({}), { bootstrapped: false, reason: 'unset' }, 'no env, no bootstrap');
  await assert.rejects(svc.bootstrap({ MP_BOOTSTRAP_TOKEN: 'short' }), /at least|characters/, 'short bootstrap token refused');
  assert.equal(await store.countPrincipals(), 0, 'nothing created from a refused token');
  assert.deepEqual(await svc.bootstrap({ MP_BOOTSTRAP_TOKEN: BOOT }), { bootstrapped: true });
  assert.deepEqual(await svc.bootstrap({ MP_BOOTSTRAP_TOKEN: 'c'.repeat(40) }), { bootstrapped: false, reason: 'principals_exist' },
    'bootstrap only runs while there are no principals');
  const v = await svc.verifyToken(BOOT);
  assert.equal(v.principal.id, BOOTSTRAP_PRINCIPAL_ID);
  assert.equal(v.principal.role, 'superadmin');
  assert.equal(await svc.verifyToken('c'.repeat(40)), null, 'a later bootstrap value is not accepted');
  const [row] = await store.listTokens();
  assert.equal(row.tokenHash, hashToken(BOOT), 'only the hash is stored');
  assert.ok(!JSON.stringify(await store.listTokens()).includes(BOOT), 'plaintext never stored');
  console.log('  ok bootstrap: env only, min length, first start only, hashed');
}

// ── Mint / verify / expiry / revoke ─────────────────────────────────────
{
  const store = createMemoryStore();
  const svc = createPrincipalService({ store, now });
  await svc.bootstrap({ MP_BOOTSTRAP_TOKEN: BOOT });
  const alice = await svc.createPrincipal({ id: 'alice', role: 'dispatcher', name: 'Alice' });
  assert.equal(alice.tenant, 'default');
  await rejectsWith(svc.createPrincipal({ id: 'alice', role: 'dispatcher' }), 409);
  await rejectsWith(svc.createPrincipal({ id: 'Bad Id', role: 'dispatcher' }), 400);
  await rejectsWith(svc.createPrincipal({ id: 'dev', role: 'superadmin' }), 400);
  await rejectsWith(svc.createPrincipal({ id: 'x', role: 'root' }), 400);

  const minted = await svc.mintToken({ principalId: 'alice', label: 'laptop', expiresInDays: 1 });
  assert.match(minted.token, /^mp_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/, 'token format');
  assert.equal(tokenLookupId(minted.token), minted.id, 'id is the lookup prefix');
  assert.equal(minted.display, `mp_${minted.id}_…`);
  const listed = await svc.listTokens('alice');
  assert.equal(listed.length, 1);
  assert.ok(!('token' in listed[0]) && !('tokenHash' in listed[0]), 'listing has neither plaintext nor hash');

  assert.equal((await svc.verifyToken(minted.token)).principal.id, 'alice');
  const tampered = minted.token.slice(0, -1) + (minted.token.endsWith('A') ? 'B' : 'A');
  assert.equal(await svc.verifyToken(tampered), null, 'wrong secret refused');
  assert.equal(await svc.verifyToken(`mp_${'0'.repeat(12)}_${'A'.repeat(43)}`), null, 'unknown id refused');
  for (const junk of ['', null, undefined, 42, 'x'.repeat(10_000)]) {
    assert.equal(await svc.verifyToken(junk), null, `junk input ${String(junk).slice(0, 10)} refused`);
  }

  await rejectsWith(svc.mintToken({ principalId: 'alice', expiresInDays: 0 }), 400);
  await rejectsWith(svc.mintToken({ principalId: 'alice', expiresInDays: 99999 }), 400);
  await rejectsWith(svc.mintToken({ principalId: 'alice', scopes: ['Bad Scope'] }), 400);
  await rejectsWith(svc.mintToken({ principalId: 'nobody' }), 404);

  const defaultTtl = await svc.mintToken({ principalId: 'alice' });
  assert.equal(new Date(defaultTtl.expiresAt).getTime() - now().getTime(), 90 * 86_400_000, 'default expiry is 90 days');

  clock = new Date(clock.getTime() + 86_400_000 + 1);
  assert.equal(await svc.verifyToken(minted.token), null, 'expired token refused');
  assert.ok(await svc.verifyToken(defaultTtl.token), 'unexpired token still works');

  await svc.revokeToken(defaultTtl.id);
  assert.equal(await svc.verifyToken(defaultTtl.token), null, 'revoked token refused');
  assert.equal(await svc.verifyTokenId(defaultTtl.id, 'alice'), null, 'revoked token ends its sessions');
  await rejectsWith(svc.revokeToken('nope'), 404);

  const t3 = await svc.mintToken({ principalId: 'alice' });
  assert.ok(await svc.verifyTokenId(t3.id, 'alice'));
  assert.equal(await svc.verifyTokenId(t3.id, 'superadmin'), null, 'session binding must match the token owner');
  await svc.disablePrincipal('alice');
  assert.equal(await svc.verifyToken(t3.token), null, 'disabled principal refused');
  assert.ok((await svc.listTokens('alice')).every(t => t.revokedAt), 'disabling revokes every token');
  await rejectsWith(svc.mintToken({ principalId: 'alice' }), 404);
  console.log('  ok mint, verify, expiry, revocation, disable');

  await rejectsWith(svc.disablePrincipal(BOOTSTRAP_PRINCIPAL_ID), 409);
  await svc.createPrincipal({ id: 'root2', role: 'superadmin' });
  await svc.disablePrincipal(BOOTSTRAP_PRINCIPAL_ID);
  await rejectsWith(svc.disablePrincipal('root2'), 409);
  await rejectsWith(svc.disablePrincipal('ghost'), 404);
  console.log('  ok the last active superadmin cannot be disabled');
}

// ── Bootstrap value in mp_ form is looked up by its own id ──────────────
{
  const svc = createPrincipalService({ store: createMemoryStore(), now });
  const boot = `mp_${'a1'.repeat(6)}_${'Z'.repeat(43)}`;
  await svc.bootstrap({ MP_BOOTSTRAP_TOKEN: boot });
  assert.equal((await svc.verifyToken(boot)).tokenId, 'a1a1a1a1a1a1');
  console.log('  ok bootstrap accepts a generated mp_ token');
}

// ── Visibility rules ────────────────────────────────────────────────────
{
  const alice = { id: 'alice', role: 'dispatcher', tenant: 't1' };
  const bob = { id: 'bob', role: 'dispatcher', tenant: 't1' };
  const root = { id: 'root', role: 'superadmin', tenant: 'other' };
  const job = { id: 'imp_1', owner_id: 'alice', tenant: 't1', visibility: 'private' };
  assert.equal(canSee(alice, job), true);
  assert.equal(canSee(bob, job), false, 'private job hidden from same tenant');
  assert.equal(canSee(bob, { ...job, visibility: 'tenant' }), true, 'tenant job visible to tenant');
  assert.equal(canSee({ ...bob, tenant: 't2' }, { ...job, visibility: 'tenant' }), false);
  assert.equal(canSee(root, job), true, 'superadmin sees all');
  assert.equal(canSee(null, job), false);
  assert.equal(canSee(alice, { owner_id: null }), false, 'ownerless job hidden');
  const ev = { event_type: 'job_status', metadata: { job } };
  assert.equal(eventVisibleTo(ev, bob), false);
  assert.equal(eventVisibleTo(ev, null), false, 'no principal, no job events');
  assert.equal(eventVisibleTo({ event_type: 'job_status', metadata: {} }, alice), false, 'job event without a job ref is hidden');
  assert.equal(eventVisibleTo({ event_type: 'message_sent' }, null), true, 'non-job events unchanged');
  assert.equal(isReservedEventType('JOB_status'), true);
  assert.equal(isReservedEventType('jobs'), false);
  console.log('  ok canSee and job-event filtering');
}

console.log('principals-service: all passed');

#!/usr/bin/env node
/**
 * mp-auth: manage motor-pool principals and API tokens from a shell.
 *
 * It talks to the running dashboard's admin API, so it works the same with
 * Postgres or the in-memory store. The caller's token comes from MP_TOKEN
 * (never a flag, so it stays out of shell history and process lists); the
 * dashboard URL from MP_URL (default http://127.0.0.1:3000).
 *
 *   node scripts/mp-auth.mjs gen-bootstrap                 print a value for MP_BOOTSTRAP_TOKEN (local only)
 *   node scripts/mp-auth.mjs whoami
 *   node scripts/mp-auth.mjs principals
 *   node scripts/mp-auth.mjs add-principal <id> --role <role> [--name <name>] [--tenant <tenant>]
 *   node scripts/mp-auth.mjs disable-principal <id>        also revokes all of its tokens
 *   node scripts/mp-auth.mjs tokens [--principal <id>]
 *   node scripts/mp-auth.mjs mint <principalId> [--label <label>] [--days <1-3650>]
 *   node scripts/mp-auth.mjs revoke <tokenId>
 *
 * Inside the compose stack: docker exec -e MP_TOKEN agent-dashboard node scripts/mp-auth.mjs <command>
 */
import { randomBytes } from 'node:crypto';

const USAGE = `usage: mp-auth <command> [args]
  gen-bootstrap | whoami | principals | tokens [--principal <id>]
  add-principal <id> --role <superadmin|operator|dispatcher|runner> [--name <n>] [--tenant <t>]
  disable-principal <id> | mint <principalId> [--label <l>] [--days <n>] | revoke <tokenId>
env: MP_TOKEN (superadmin token, required except for gen-bootstrap), MP_URL (default http://127.0.0.1:3000)`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = v;
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function api(method, path, body) {
  const base = (process.env.MP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(process.env.MP_TOKEN || '').trim();
  if (!token) throw new Error('MP_TOKEN is not set');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(`${res.status} ${data.error || res.statusText}`);
  return data;
}

const print = (v) => console.log(JSON.stringify(v, null, 2));

export async function main(argv = process.argv.slice(2)) {
  const { positional: [cmd, arg], flags } = parseArgs(argv);
  switch (cmd) {
    case 'gen-bootstrap': {
      const id = randomBytes(6).toString('hex');
      console.log(`mp_${id}_${randomBytes(32).toString('base64url')}`);
      return;
    }
    case 'whoami': return print((await api('GET', '/api/me')).principal);
    case 'principals': return print((await api('GET', '/api/admin/principals')).principals);
    case 'add-principal': {
      if (!arg || !flags.role) throw new Error('add-principal needs <id> and --role');
      return print((await api('POST', '/api/admin/principals', { id: arg, role: flags.role, name: flags.name, tenant: flags.tenant })).principal);
    }
    case 'disable-principal': {
      if (!arg) throw new Error('disable-principal needs <id>');
      return print((await api('DELETE', `/api/admin/principals/${encodeURIComponent(arg)}`)).principal);
    }
    case 'tokens': {
      const q = flags.principal ? `?principal=${encodeURIComponent(flags.principal)}` : '';
      return print((await api('GET', `/api/admin/tokens${q}`)).tokens);
    }
    case 'mint': {
      if (!arg) throw new Error('mint needs <principalId>');
      const body = { principalId: arg, label: flags.label };
      if (flags.days !== undefined) body.expiresInDays = Number(flags.days);
      const { token } = await api('POST', '/api/admin/tokens', body);
      console.error(`Token ${token.id} for ${token.principalId}, expires ${token.expiresAt}. Shown once; store it now.`);
      console.log(token.token);
      return;
    }
    case 'revoke': {
      if (!arg) throw new Error('revoke needs <tokenId>');
      return print((await api('DELETE', `/api/admin/tokens/${encodeURIComponent(arg)}`)).token);
    }
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

if (process.argv[1]?.endsWith('mp-auth.mjs')) {
  main().catch((err) => {
    console.error(`mp-auth: ${err.message}`);
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(__dirname, '..', 'config', 'docker-compose.yml'), 'utf8');
const lines = raw.split(/\r?\n/);
const code = (l) => !l.trim().startsWith('#');

function block(name) {
  const start = lines.findIndex((l) => l.trim() === `${name}:` && l.startsWith('  ') && !l.startsWith('   '));
  assert.ok(start >= 0, `${name} service exists`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && !lines[i].startsWith('   ') && !lines[i].trim().startsWith('#')) break;
    out.push(lines[i]);
  }
  return out.filter(code).join('\n');
}

describe('postgres compose hardening', () => {
  const db = block('agent-db');
  it('publishes the port on loopback only', () => {
    assert.match(db, /"127\.0\.0\.1:5432:5432"/);
    assert.doesNotMatch(db, /^\s*-\s*"?5432:5432/m);
  });
  it('requires POSTGRES_PASSWORD with no default', () => {
    assert.match(db, /POSTGRES_PASSWORD=\$\{POSTGRES_PASSWORD:\?[^}]+\}/);
    assert.doesNotMatch(db, /POSTGRES_PASSWORD=agent\b/);
  });
  it('builds the dashboard DATABASE_URL from the same variable', () => {
    const dash = block('agent-dashboard');
    assert.match(dash, /DATABASE_URL=postgresql:\/\/agent:\$\{POSTGRES_PASSWORD:\?[^}]+\}@agent-db:5432\//);
    assert.doesNotMatch(raw, /agent:agent@/);
  });
});

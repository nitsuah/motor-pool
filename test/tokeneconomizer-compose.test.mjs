import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { DEFAULT_HOST } from '../tools/tokeneconomizer/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const composePath = join(__dirname, '..', 'config', 'docker-compose.yml');
const raw = readFileSync(composePath, 'utf8');
const lines = raw.split('\n');

function findServiceBlock(serviceName) {
  const startIdx = lines.findIndex((l) => l.trim() === `${serviceName}:`);
  if (startIdx === -1) return null;
  const block = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('  ') && !line.startsWith('    ')) break;
    block.push(line);
  }
  return { start: startIdx, lines: block };
}

function getKeyValue(block, key) {
  const prefix = `${key}:`;
  const idx = block.findIndex((l) => l.trim().startsWith(prefix));
  if (idx === -1) return null;
  return block[idx].trim().slice(prefix.length).trim();
}

const indentOf = (l) => l.length - l.trimStart().length;
const isNoise = (l) => l.trim() === '' || l.trim().startsWith('#');

// Lines nested under `key:` (deeper indent than the key), skipping blanks and comments.
function childLines(block, key) {
  const startIdx = block.findIndex((l) => l.trim() === `${key}:`);
  if (startIdx === -1) return null;
  const base = indentOf(block[startIdx]);
  const out = [];
  for (let i = startIdx + 1; i < block.length; i++) {
    const line = block[i];
    if (isNoise(line)) continue;
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out;
}

function getList(block, key) {
  const kids = childLines(block, key) || [];
  return kids.filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2).trim());
}

function getNestedObject(block, parentKey) {
  const kids = childLines(block, parentKey);
  if (!kids) return null;
  const obj = {};
  for (const line of kids) {
    const [k, ...v] = line.trim().split(':');
    if (v.length) obj[k.trim()] = v.join(':').trim();
  }
  return obj;
}

// The top-level `networks:` key has no indent; service-level ones do.
function findTopLevelNetworks() {
  const idx = lines.findIndex((l) => l.trimEnd() === 'networks:');
  if (idx === -1) return null;
  const block = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!isNoise(line) && indentOf(line) === 0) break;
    block.push(line);
  }
  return block;
}

describe('tokeneconomizer Compose isolation contract', () => {
  const te = findServiceBlock('tool-tokeneconomizer');
  assert.ok(te, 'tool-tokeneconomizer service block not found');

  const dashboard = findServiceBlock('agent-dashboard');
  assert.ok(dashboard, 'agent-dashboard service block not found');

  const networksBlock = findTopLevelNetworks();
  assert.ok(networksBlock, 'top-level networks block not found');

  it('tool-tokeneconomizer has no ports entry', () => {
    const ports = getKeyValue(te.lines, 'ports');
    assert.equal(ports, null, 'tool-tokeneconomizer must not have a ports: entry');
  });

  it('tool-tokeneconomizer networks lists only tokeneconomizer-network', () => {
    const nets = getList(te.lines, 'networks');
    assert.deepEqual(nets, ['tokeneconomizer-network'], 'tool-tokeneconomizer must have exactly one network: tokeneconomizer-network');
  });

  it('top-level networks.tokeneconomizer-network has driver: bridge and not external: true', () => {
    const net = getNestedObject(networksBlock, 'tokeneconomizer-network');
    assert.ok(net, 'tokeneconomizer-network must exist in top-level networks');
    assert.equal(net.driver, 'bridge', 'tokeneconomizer-network must have driver: bridge');
    assert.notEqual(net.external, 'true', 'tokeneconomizer-network must not be external: true');
  });

  it('agent-dashboard lists tokeneconomizer-network among its networks', () => {
    const nets = getList(dashboard.lines, 'networks');
    assert.ok(nets.includes('tokeneconomizer-network'), 'agent-dashboard must include tokeneconomizer-network in its networks');
  });

  it('TOKEN_ECONOMIZER_HOST=0.0.0.0 is set only in compose while server default stays loopback', () => {
    // `environment:` is a block key with no inline value, so look for the line itself.
    const envVars = getList(te.lines, 'environment');
    assert.ok(envVars.length > 0, 'tool-tokeneconomizer must have an environment list');
    const hostVar = envVars.find((v) => v.startsWith('TOKEN_ECONOMIZER_HOST='));
    assert.equal(hostVar, 'TOKEN_ECONOMIZER_HOST=0.0.0.0', 'TOKEN_ECONOMIZER_HOST must be 0.0.0.0 in compose');
    assert.equal(DEFAULT_HOST, '127.0.0.1', 'server DEFAULT_HOST must remain 127.0.0.1');
  });

  it('tool-tokeneconomizer is under profiles containing tools', () => {
    const profiles = getList(te.lines, 'profiles');
    assert.ok(profiles.includes('tools'), 'tool-tokeneconomizer profiles must include tools');
  });
});

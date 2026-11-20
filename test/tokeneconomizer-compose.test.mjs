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

function getList(block, key) {
  const startIdx = block.findIndex((l) => l.trim() === `${key}:`);
  if (startIdx === -1) return [];
  const items = [];
  for (let i = startIdx + 1; i < block.length; i++) {
    const line = block[i];
    if (!line.startsWith('      -')) break;
    items.push(line.trim().slice(2).trim());
  }
  return items;
}

function getNestedObject(block, parentKey) {
  const startIdx = block.findIndex((l) => l.trim() === `${parentKey}:`);
  if (startIdx === -1) return null;
  const obj = {};
  for (let i = startIdx + 1; i < block.length; i++) {
    const line = block[i];
    if (!line.startsWith('      ')) break;
    if (line.trim().includes(':')) {
      const [k, ...v] = line.trim().split(':');
      obj[k.trim()] = v.join(':').trim();
    }
  }
  return obj;
}

function findTopLevelNetworks() {
  const idx = lines.findIndex((l) => l.trim() === 'networks:');
  if (idx === -1) return null;
  const block = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('  ') && !line.startsWith('    ')) break;
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
    const env = getKeyValue(te.lines, 'environment');
    assert.ok(env, 'tool-tokeneconomizer must have environment');
    const envBlockIdx = te.lines.findIndex((l) => l.trim() === 'environment:');
    const envVars = [];
    for (let i = envBlockIdx + 1; i < te.lines.length; i++) {
      const line = te.lines[i];
      if (!line.startsWith('        -')) break;
      envVars.push(line.trim().slice(2).trim());
    }
    const hostVar = envVars.find((v) => v.startsWith('TOKEN_ECONOMIZER_HOST='));
    assert.equal(hostVar, 'TOKEN_ECONOMIZER_HOST=0.0.0.0', 'TOKEN_ECONOMIZER_HOST must be 0.0.0.0 in compose');
    assert.equal(DEFAULT_HOST, '127.0.0.1', 'server DEFAULT_HOST must remain 127.0.0.1');
  });

  it('tool-tokeneconomizer is under profiles containing tools', () => {
    const profiles = getList(te.lines, 'profiles');
    assert.ok(profiles.includes('tools'), 'tool-tokeneconomizer profiles must include tools');
  });
});
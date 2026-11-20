import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { DEFAULT_HOST } from '../tools/tokeneconomizer/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const composePath = join(__dirname, '..', 'config', 'docker-compose.yml');
const raw = readFileSync(composePath, 'utf8');
const lines = raw.split(/\r?\n/);

const indentOf = (l) => l.length - l.trimStart().length;
const isNoise = (l) => l.trim() === '' || l.trim().startsWith('#');
// YAML allows quoted keys ("ports": / 'ports':); compare them unquoted.
const unquote = (k) => k.trim().replace(/^(['"])(.*)\1$/, '$2');

// Find service block: from service header (2-space indent) to next line at same indent or column 0.
// Skip blank/comment lines when checking boundaries.
function findServiceBlock(serviceName) {
  const headerPattern = `  ${serviceName}:`;
  const startIdx = lines.findIndex((l) => l.trim() === `${serviceName}:`);
  if (startIdx === -1) return null;
  const headerIndent = indentOf(lines[startIdx]);
  const block = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isNoise(line)) {
      block.push(line);
      continue;
    }
    const ind = indentOf(line);
    if (ind <= headerIndent) break;
    block.push(line);
  }
  return { start: startIdx, lines: block };
}

// Parse service block into a simple object mapping keys to values (string, array, or nested object).
// Handles: inline values, lists under keys, and nested mappings one level deep.
function parseServiceBlock(block) {
  const obj = {};
  let i = 0;
  while (i < block.length) {
    const line = block[i];
    if (isNoise(line)) { i++; continue; }
    const ind = indentOf(line);
    const trimmed = line.trim();
    // Key with inline value: "key: value"
    const kv = trimmed.match(/^([^:]+):\s*(.+)$/);
    if (kv) {
      const [, k, v] = kv;
      obj[unquote(k)] = v.trim();
      i++;
      continue;
    }
    // Key with no inline value: "key:" — could be a list or nested mapping
    const keyOnly = trimmed.match(/^([^:]+):$/);
    if (keyOnly) {
      const k = unquote(keyOnly[1]);
      const baseIndent = ind;
      i++;
      const children = [];
      while (i < block.length) {
        const cl = block[i];
        if (isNoise(cl)) { i++; continue; }
        const cind = indentOf(cl);
        if (cind <= baseIndent) break;
        children.push(cl);
        i++;
      }
      // List items: lines starting with "- "
      const listItems = children
        .filter((l) => l.trim().startsWith('- '))
        .map((l) => l.trim().slice(2).trim());
      if (listItems.length > 0) {
        obj[k] = listItems;
      } else {
        // Nested mapping: parse one level of key: value
        const nested = {};
        for (const cl of children) {
          if (isNoise(cl)) continue;
          const nkv = cl.trim().match(/^([^:]+):\s*(.*)$/);
          if (nkv) nested[nkv[1].trim()] = nkv[2].trim();
        }
        if (Object.keys(nested).length > 0) obj[k] = nested;
      }
      continue;
    }
    i++;
  }
  return obj;
}

// Lines nested under `key:` (deeper indent than the key), skipping blanks and comments.
// Stops at first line that is neither an item nor a comment.
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

// Parse only direct children of a network definition (one level deeper than network key).
function parseNetworkBlock(block, networkName) {
  const startIdx = block.findIndex((l) => l.trim() === `${networkName}:`);
  if (startIdx === -1) return null;
  const base = indentOf(block[startIdx]);
  const obj = {};
  for (let i = startIdx + 1; i < block.length; i++) {
    const line = block[i];
    if (isNoise(line)) continue;
    const ind = indentOf(line);
    if (ind <= base) break;
    // Only direct children (one indent level deeper)
    if (ind === base + 2) {
      const [k, ...v] = line.trim().split(':');
      if (v.length) obj[k.trim()] = v.join(':').trim();
    }
  }
  return obj;
}

// The top-level `networks:` key has no indent; service-level ones do.
function findTopLevelNetworks() {
  const idx = lines.findIndex((l) => l.trimEnd() === 'networks:' && indentOf(l) === 0);
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

  it('parser sees a quoted ports key (regression)', () => {
    const fake = ['    image: x', '    "ports":', '      - "3202:3202"', "    'restart': always"];
    const parsed = parseServiceBlock(fake);
    assert.deepEqual(parsed.ports, ['"3202:3202"'], 'quoted "ports": must parse as ports');
    assert.equal(parsed.restart, 'always', "quoted 'restart': must parse as restart");
  });

  it('tool-tokeneconomizer has no ports entry', () => {
    const parsed = parseServiceBlock(te.lines);
    assert.equal(parsed.ports, undefined, 'tool-tokeneconomizer must not have a ports: entry');
  });

  it('tool-tokeneconomizer networks lists only tokeneconomizer-network', () => {
    const nets = getList(te.lines, 'networks');
    assert.deepEqual(nets, ['tokeneconomizer-network'], 'tool-tokeneconomizer must have exactly one network: tokeneconomizer-network');
  });

  it('top-level networks.tokeneconomizer-network has driver: bridge and not external: true', () => {
    const net = parseNetworkBlock(networksBlock, 'tokeneconomizer-network');
    assert.ok(net, 'tokeneconomizer-network must exist in top-level networks');
    assert.equal(net.driver, 'bridge', 'tokeneconomizer-network must have driver: bridge');
    assert.notEqual(net.external, 'true', 'tokeneconomizer-network must not be external: true');
  });

  it('agent-dashboard lists tokeneconomizer-network among its networks', () => {
    const nets = getList(dashboard.lines, 'networks');
    assert.ok(nets.includes('tokeneconomizer-network'), 'agent-dashboard must include tokeneconomizer-network in its networks');
  });

  it('TOKEN_ECONOMIZER_HOST=0.0.0.0 is set only in compose while server default stays loopback', () => {
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

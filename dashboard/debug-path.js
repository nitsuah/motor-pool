import { mkdtempSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const WORKSPACE = realpathSync(mkdtempSync(join(tmpdir(), 'ab-agent-')));
writeFileSync(join(WORKSPACE, 'hello.txt'), 'file contents\n');

function isInsideWorkspaceReal(abs) {
  try {
    const rootReal = realpathSync(WORKSPACE);
    let probe = abs;
    for (;;) {
      try {
        lstatSync(probe);
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') return false;
        const parent = dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
    }
    const real = realpathSync(probe);
    console.log('rootReal:', rootReal);
    console.log('real:', real);
    console.log('real === rootReal:', real === rootReal);
    console.log('real.startsWith(rootReal + "/"):', real.startsWith(rootReal + '/'));
    return real === rootReal || real.startsWith(rootReal + '/');
  } catch (e) {
    console.log('Error:', e);
    return false;
  }
}

function resolveWorkspacePath(reqPath) {
  if (!WORKSPACE) return null;
  const safe = reqPath ? reqPath.replace(/\\/g, '/').replace(/^\/+/, '') : '';
  console.log('reqPath:', reqPath);
  console.log('safe:', safe);
  const abs = resolve(WORKSPACE, safe);
  console.log('abs:', abs);
  console.log('WORKSPACE:', WORKSPACE);
  console.log('abs !== WORKSPACE:', abs !== WORKSPACE);
  console.log('abs.startsWith(WORKSPACE + "/"):', abs.startsWith(WORKSPACE + '/'));
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + '/')) return null;
  return isInsideWorkspaceReal(abs) ? abs : null;
}

const result = resolveWorkspacePath('hello.txt');
console.log('result:', result);
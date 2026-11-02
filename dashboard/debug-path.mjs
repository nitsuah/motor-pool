import { mkdtempSync, writeFileSync, realpathSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const WORKSPACE = realpathSync(mkdtempSync(join(tmpdir(), 'ab-agent-')));
writeFileSync(join(WORKSPACE, 'hello.txt'), 'file contents\n');

console.log('WORKSPACE:', WORKSPACE);

// Simulate resolveWorkspacePath
function resolveWorkspacePath(reqPath, WORKSPACE_ROOT) {
  if (!WORKSPACE_ROOT) return null;
  const safe = reqPath ? reqPath.replace(/\\/g, '/').replace(/^\/+/, '') : '';
  const abs = resolve(WORKSPACE_ROOT, safe);
  console.log('abs:', abs);
  console.log('WORKSPACE_ROOT:', WORKSPACE_ROOT);
  console.log('abs === WORKSPACE_ROOT:', abs === WORKSPACE_ROOT);
  console.log('abs.startsWith(WORKSPACE_ROOT + "/"):', abs.startsWith(WORKSPACE_ROOT + '/'));
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + '/')) return null;

  function isInsideWorkspaceReal(abs) {
    try {
      const rootReal = realpathSync(WORKSPACE_ROOT);
      console.log('rootReal:', rootReal);
      let probe = abs;
      for (;;) {
        try {
          lstatSync(probe);
          console.log('lstatSync succeeded for:', probe);
          break;
        } catch (err) {
          console.log('lstatSync error:', err.code, 'for', probe);
          if (err.code !== 'ENOENT') return false;
          const parent = dirname(probe);
          if (parent === probe) return false;
          probe = parent;
        }
      }
      const real = realpathSync(probe);
      console.log('real:', real);
      return real === rootReal || real.startsWith(rootReal + '/');
    } catch (e) {
      console.log('isInsideWorkspaceReal error:', e);
      return false;
    }
  }

  const result = isInsideWorkspaceReal(abs) ? abs : null;
  console.log('result:', result);
  return result;
}

console.log('---');
const result = resolveWorkspacePath('hello.txt', WORKSPACE);
console.log('Final result:', result);
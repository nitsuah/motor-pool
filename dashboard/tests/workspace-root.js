/**
 * Tests for routes/workspace.js against a real WORKSPACE_ROOT.
 *
 * The existing workspace suites run with WORKSPACE_ROOT unset, so they only
 * ever exercise the "not configured" 503 branches. This one points the server
 * at a real temporary git repository, so the file I/O, git plumbing, and — most
 * importantly — the path-containment checks are actually executed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// realpath: on macOS/Windows runners tmpdir is often a symlink, and the route
// compares resolved absolute paths.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ab-ws-')));

writeFileSync(join(ROOT, 'readme.md'), '# hello\n');
mkdirSync(join(ROOT, 'sub'));
writeFileSync(join(ROOT, 'sub', 'nested.txt'), 'nested content\n');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
git('add', '-A');
git('commit', '-q', '-m', 'initial commit');

process.env.WORKSPACE_ROOT = ROOT;
process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';
const { app } = await import('../server.js');

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const get = (p) => fetch(`${BASE}${p}`);
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

try {
  // ── status ────────────────────────────────────────────────────────────────
  const status = await (await get('/api/workspace/status')).json();
  assert.strictEqual(status.configured, true, 'workspace reports configured');
  assert.strictEqual(status.root, ROOT, 'reports the configured root');
  assert.ok(status.git, 'git info present for a real repo');
  console.log('  ✅ /api/workspace/status reports a configured git workspace');

  // ── ls ────────────────────────────────────────────────────────────────────
  const ls = await (await get('/api/workspace/ls')).json();
  const names = ls.entries.map(e => e.name).sort();
  assert.ok(names.includes('readme.md'), 'lists a file at the root');
  assert.ok(names.includes('sub'), 'lists a subdirectory');
  const subEntry = ls.entries.find(e => e.name === 'sub');
  assert.strictEqual(subEntry.type, 'dir', 'directory entries are typed');

  const lsSub = await (await get('/api/workspace/ls?path=sub')).json();
  assert.deepStrictEqual(lsSub.entries.map(e => e.name), ['nested.txt'], 'lists a subdirectory');
  console.log('  ✅ /api/workspace/ls lists root and subdirectories with types');

  // ── read ──────────────────────────────────────────────────────────────────
  const read = await (await get('/api/workspace/read?path=readme.md')).json();
  assert.strictEqual(read.content, '# hello\n', 'reads file content');

  const readMissing = await get('/api/workspace/read?path=nope.txt');
  assert.ok(readMissing.status >= 400, 'reading a missing file is an error');
  console.log('  ✅ /api/workspace/read returns content and errors on missing files');

  // ── path containment (the security-relevant branch) ───────────────────────
  // resolveWorkspacePath() must refuse anything that escapes WORKSPACE_ROOT.
  for (const attempt of ['../etc/passwd', '../../etc/passwd', 'sub/../../outside.txt', '/etc/passwd']) {
    const res = await get(`/api/workspace/read?path=${encodeURIComponent(attempt)}`);
    assert.ok(res.status >= 400, `traversal "${attempt}" must not be served (got ${res.status})`);
    const body = await res.json();
    assert.ok(!body.content?.includes('root:'), `traversal "${attempt}" must not leak /etc/passwd`);
  }
  const escapeWrite = await post('/api/workspace/write', { path: '../escaped.txt', content: 'nope' });
  assert.ok(escapeWrite.status >= 400, 'traversal write is refused');
  assert.ok(!existsSync(join(ROOT, '..', 'escaped.txt')), 'no file was written outside the root');
  console.log('  ✅ path traversal is refused for read and write, nothing escapes the root');

  // Non-string query/body paths (arrays and objects) are rejected before path normalization.
  const arrayPathRead = await get('/api/workspace/read?path=readme.md&path=../etc/passwd');
  assert.ok(arrayPathRead.status >= 400, 'array path query is refused');
  const objectPathWrite = await post('/api/workspace/write', { path: { name: 'readme.md' }, content: 'overwrite' });
  assert.ok(objectPathWrite.status >= 400, 'object path body is refused');
  const unchanged = await (await get('/api/workspace/read?path=readme.md')).json();
  assert.strictEqual(unchanged.content, '# hello\\n', 'non-string path cannot overwrite a workspace file');
  console.log('  ✅ array/object path inputs are rejected without filesystem changes');

  // ── write ─────────────────────────────────────────────────────────────────
  const write = await (await post('/api/workspace/write', { path: 'new.txt', content: 'written\n' })).json();
  assert.strictEqual(write.bytes, 8, 'reports bytes written');
  assert.strictEqual(
    (await (await get('/api/workspace/read?path=new.txt')).json()).content, 'written\n',
    'written content reads back'
  );
  console.log('  ✅ /api/workspace/write persists content that reads back');

  // ── mkdir ─────────────────────────────────────────────────────────────────
  const mk = await post('/api/workspace/mkdir', { path: 'made' });
  assert.strictEqual(mk.status, 200, 'mkdir succeeds');
  assert.ok(existsSync(join(ROOT, 'made')), 'directory actually created');
  console.log('  ✅ /api/workspace/mkdir creates a directory');

  // ── git status / log / branches ───────────────────────────────────────────
  const gitStatus = await (await get('/api/workspace/git/status')).json();
  assert.ok(gitStatus, 'git status responds');
  const gitLog = await get('/api/workspace/git/log');
  if (gitLog.status === 200) {
    const log = await gitLog.json();
    const commits = log.commits || log.log || [];
    assert.ok(Array.isArray(commits) && commits.length >= 1, 'log lists the initial commit');
  }
  const branches = await get('/api/workspace/git/branches');
  assert.ok([200, 404].includes(branches.status), 'branches endpoint responds');
  console.log('  ✅ git status/log/branches operate on a real repository');

  // ── git commit ────────────────────────────────────────────────────────────
  const commit = await post('/api/workspace/git/commit', { message: 'add new.txt' });
  assert.strictEqual(commit.status, 200, `commit should succeed: ${JSON.stringify(await commit.clone().json())}`);
  const logAfter = execFileSync('git', ['log', '--oneline'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(logAfter, /add new\.txt/, 'the commit really landed in the repo');
  console.log('  ✅ /api/workspace/git/commit creates a real commit');

  // ── git push fails cleanly with no remote ─────────────────────────────────
  const push = await post('/api/workspace/git/push');
  assert.ok(push.status >= 400, 'push with no remote reports an error rather than claiming success');
  console.log('  ✅ /api/workspace/git/push fails cleanly with no remote configured');

  // ── delete ────────────────────────────────────────────────────────────────
  const del = await fetch(`${BASE}/api/workspace/file?path=new.txt`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200, 'delete succeeds');
  assert.ok(!existsSync(join(ROOT, 'new.txt')), 'file actually removed');

  const delEscape = await fetch(`${BASE}/api/workspace/file?path=${encodeURIComponent('../readme.md')}`, { method: 'DELETE' });
  assert.ok(delEscape.status >= 400, 'traversal delete is refused');
  console.log('  ✅ /api/workspace/file deletes within the root and refuses traversal');

  console.log('Workspace root tests passed.');
} finally {
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
}

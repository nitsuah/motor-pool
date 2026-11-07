/**
 * Behavioural tests for the workspace router. Git and search commands are
 * launched with argument arrays, so request text must reach git and grep as
 * literal data. Path checks must refuse values that resolve outside the root.
 */
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceRouter } from '../routes/workspace.js';

const base = mkdtempSync(join(tmpdir(), 'ws-argv-'));
const root = join(base, 'ws');
const sibling = join(base, 'ws-sib');
const outside = join(base, 'outside.txt');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function request(port, { method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {};
    // Raw path string: the client must not normalise ".." segments.
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const INJECTED_MESSAGE = '"; touch PWNED; `touch PWNED` "';

mkdirSync(root, { recursive: true });
mkdirSync(sibling, { recursive: true });
writeFileSync(join(sibling, 'secret.txt'), 'SIBLING');
writeFileSync(outside, 'OUTSIDE');
mkdirSync(join(root, 'sub', 'dir'), { recursive: true });
writeFileSync(join(root, 'sub', 'dir', 'file.txt'), 'NESTED');

git('init', '-q');
git('config', 'user.name', 'Test User');
git('config', 'user.email', 'test@example.com');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(root, 'README.md'), 'seed\n');
git('add', '-A');
git('commit', '-q', '-m', 'seed');

const app = express();
app.use('/api', createWorkspaceRouter(root));
const server = app.listen(0);
const { port } = server.address();

try {
  console.log('Workspace argv and containment tests');

  // Commit: a message with quotes, semicolons and backticks is stored literally.
  writeFileSync(join(root, 'spaced "quoted" name.txt'), 'one');
  let res = await request(port, {
    method: 'POST',
    path: '/api/workspace/git/commit',
    body: { message: 'add spaced file', files: ['spaced "quoted" name.txt'] },
  });
  assert.equal(res.status, 200, `commit with file path: ${res.text}`);
  assert.equal(git('log', '-1', '--format=%s'), 'add spaced file');
  const committed = git('show', '-z', '--name-only', '--format=', 'HEAD').split('\0').filter(Boolean);
  assert.ok(committed.includes('spaced "quoted" name.txt'), `file path committed literally: ${committed}`);

  writeFileSync(join(root, 'second.txt'), 'two');
  res = await request(port, {
    method: 'POST',
    path: '/api/workspace/git/commit',
    body: { message: INJECTED_MESSAGE },
  });
  assert.equal(res.status, 200, `commit with hostile message: ${res.text}`);
  assert.equal(git('log', '-1', '--format=%s'), INJECTED_MESSAGE, 'subject stored literally');
  assert.equal(existsSync(join(root, 'PWNED')), false, 'no PWNED file created by commit');

  // Checkout: branch names that git would read as options or ranges are refused.
  for (const branch of ['-b', '--orphan', 'a..b']) {
    res = await request(port, {
      method: 'POST',
      path: '/api/workspace/git/checkout',
      body: { branch, create: false },
    });
    assert.equal(res.status, 400, `checkout ${branch} must be refused: ${res.text}`);
  }
  res = await request(port, {
    method: 'POST',
    path: '/api/workspace/git/checkout',
    body: { branch: '-b', create: true },
  });
  assert.equal(res.status, 400, 'create with leading dash refused');
  res = await request(port, {
    method: 'POST',
    path: '/api/workspace/git/checkout',
    body: { branch: '!!!', create: false },
  });
  assert.equal(res.status, 400, 'branch empty after filtering refused');

  res = await request(port, {
    method: 'POST',
    path: '/api/workspace/git/checkout',
    body: { branch: 'feature/ok-1', create: true },
  });
  assert.equal(res.status, 200, `valid branch created: ${res.text}`);
  assert.equal(res.body.branch, 'feature/ok-1');

  // Search: a query with shell metacharacters is a literal pattern.
  const hostileQuery = '"; touch X; `touch X` "';
  res = await request(port, {
    method: 'POST',
    path: '/api/workspace/search',
    body: { query: hostileQuery },
  });
  assert.equal(res.status, 200, `search with hostile query: ${res.text}`);
  assert.deepEqual(res.body.files, [], 'no match for literal pattern');
  assert.equal(existsSync(join(root, 'X')), false, 'search creates no X file');

  // Search still finds ordinary matches.
  res = await request(port, {
    method: 'POST',
    path: '/api/workspace/search',
    body: { query: 'NESTED' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.files, ['sub/dir/file.txt']);

  // Read: traversal, sibling-prefix directories and NUL bytes are refused.
  res = await request(port, { path: '/api/workspace/read?path=../outside.txt' });
  assert.equal(res.status, 400, `parent traversal refused: ${res.text}`);
  assert.ok(!res.text.includes('OUTSIDE'));

  res = await request(port, { path: '/api/workspace/read?path=../ws-sib/secret.txt' });
  assert.equal(res.status, 400, `sibling-prefix directory refused: ${res.text}`);
  assert.ok(!res.text.includes('SIBLING'));

  res = await request(port, { path: '/api/workspace/read?path=second.txt%00../outside.txt' });
  assert.equal(res.status, 400, `NUL byte refused: ${res.text}`);

  res = await request(port, { path: '/api/workspace/read?path=sub/dir/file.txt' });
  assert.equal(res.status, 200, `nested file reads: ${res.text}`);
  assert.equal(res.body.content, 'NESTED');

  // Discard: a single file is restored through an argument array.
  writeFileSync(join(root, 'README.md'), 'changed\n');
  res = await request(port, {
    method: 'POST',
    path: '/api/workspace/git/discard',
    body: { file: 'README.md' },
  });
  assert.equal(res.status, 200, `discard: ${res.text}`);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'seed\n');

  // A search query that looks like an option is still a pattern.
  res = await request(port, { method: 'POST', path: '/api/workspace/search', body: { query: '-e' } });
  assert.equal(res.status, 200, `option-like query is a pattern: ${res.text}`);
  assert.ok(Array.isArray(res.body.files));

  // Checkout of "." is a revision lookup (fails), never a discard of working-tree changes.
  writeFileSync(join(root, 'README.md'), 'keep me\n');
  res = await request(port, { method: 'POST', path: '/api/workspace/git/checkout', body: { branch: '.' } });
  assert.notEqual(res.status, 200, `checkout "." is not a pathspec: ${res.text}`);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'keep me\n');

  // Mkdir, rename and delete: a value that resolves above the root is refused before any fs call.
  res = await request(port, { method: 'POST', path: '/api/workspace/mkdir', body: { path: '../made-by-mkdir' } });
  assert.equal(res.status, 400, `mkdir above root refused: ${res.text}`);
  assert.equal(existsSync(join(base, 'made-by-mkdir')), false, 'mkdir created nothing outside the root');

  res = await request(port, { method: 'POST', path: '/api/workspace/rename', body: { from: 'README.md', to: '../renamed-out.txt' } });
  assert.equal(res.status, 400, `rename to a path above root refused: ${res.text}`);
  assert.equal(existsSync(join(base, 'renamed-out.txt')), false, 'rename created nothing outside the root');
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'keep me\n', 'rename source untouched');

  res = await request(port, { method: 'DELETE', path: '/api/workspace/file?path=../outside.txt' });
  assert.equal(res.status, 400, `delete above root refused: ${res.text}`);
  assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE', 'file above root not deleted');

  console.log('✓ All workspace argv and containment tests passed');
} catch (err) {
  console.error('✗ FAIL:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
  rmSync(base, { recursive: true, force: true });
}

/**
 * Behavioural tests for the WORKSPACE_EXEC opt-in. Shell execution is off by
 * default: the /workspace/exec route refuses with 403 and the agent bash tool
 * neither runs nor is offered to the model. The marker file each command would
 * create shows whether anything ran.
 */
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorkspaceRouter } from '../routes/workspace.js';
import { createAgentHelpers, DEVELOPER_TOOLS } from '../modules/agent-tools.js';
import { shellExecEnabled } from '../modules/exec-flag.js';

const execAsync = promisify(exec);
const base = mkdtempSync(join(tmpdir(), 'ws-exec-flag-'));
const root = join(base, 'ws');
const marker = join(root, 'EXEC_MARKER.txt');
const touchCommand = 'touch EXEC_MARKER.txt && echo WS_EXEC_OK';

function setFlag(value) {
  if (value === undefined) delete process.env.WORKSPACE_EXEC;
  else process.env.WORKSPACE_EXEC = value;
}

function request(port, { method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {};
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

// Minimal scripted LLM: each reply is taken from `script` in order. Every request
// is recorded so the tool list offered to the model can be inspected.
const requests = [];
let script = [];
const llmApp = express();
llmApp.use(express.json());
llmApp.post('/api/chat', (req, res) => {
  requests.push(req.body);
  res.json({ message: script.shift() ?? { content: 'done' } });
});
const llm = llmApp.listen(0);
const LLM_URL = `http://127.0.0.1:${llm.address().port}`;
const bashCall = { content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: touchCommand } } }] };
const agent = createAgentHelpers({ WORKSPACE_ROOT: root, execAsync, TOOL_SERVERS: {}, TOOL_CALL_TIMEOUT_MS: 5000 });
const runAgent = (tools) => agent.runAgentLoop(
  [{ role: 'user', content: 'go' }], 'ollama', LLM_URL, {}, tools, { model: 'test-model', id: 'sess_exec' },
);

mkdirSync(root, { recursive: true });
const app = express();
app.use('/api', createWorkspaceRouter(root));
const server = app.listen(0);
const { port } = server.address();

try {
  console.log('Workspace exec flag tests');

  // ── helper parsing ─────────────────────────────────────────────────────────
  for (const value of ['1', 'true', 'TRUE', ' True ', ' 1 ']) {
    assert.ok(shellExecEnabled({ WORKSPACE_EXEC: value }), `"${value}" enables exec`);
  }
  for (const value of ['false', '0', '', 'yes', 'on', undefined]) {
    assert.ok(!shellExecEnabled({ WORKSPACE_EXEC: value }), `"${value}" leaves exec disabled`);
  }
  assert.ok(!shellExecEnabled({}), 'unset leaves exec disabled');
  console.log('  ok shellExecEnabled accepts only 1 and true');

  // ── /workspace/exec ────────────────────────────────────────────────────────
  setFlag(undefined);
  let res = await request(port, { method: 'POST', path: '/api/workspace/exec', body: { command: touchCommand } });
  assert.equal(res.status, 403, `unset flag refuses: ${res.text}`);
  assert.equal(res.body?.error, 'Shell execution is disabled. Set WORKSPACE_EXEC=1 to enable it.');
  assert.equal(existsSync(marker), false, 'refused command did not create the marker');

  // The flag check comes before body validation.
  res = await request(port, { method: 'POST', path: '/api/workspace/exec', body: {} });
  assert.equal(res.status, 403, 'disabled exec refuses before checking the body');

  for (const value of ['false', '0', '']) {
    setFlag(value);
    res = await request(port, { method: 'POST', path: '/api/workspace/exec', body: { command: touchCommand } });
    assert.equal(res.status, 403, `WORKSPACE_EXEC="${value}" refuses: ${res.text}`);
    assert.equal(existsSync(marker), false, `WORKSPACE_EXEC="${value}" did not run the command`);
  }

  setFlag('1');
  res = await request(port, { method: 'POST', path: '/api/workspace/exec', body: { command: touchCommand } });
  assert.equal(res.status, 200, `flag on runs: ${res.text}`);
  assert.match(res.body.stdout, /WS_EXEC_OK/, 'stdout carries the echoed text');
  assert.equal(res.body.exitCode, 0);
  assert.equal(existsSync(marker), true, 'enabled command created the marker');
  rmSync(marker, { force: true });

  // The flag is read per request, so a change takes effect without a restart.
  setFlag('true');
  res = await request(port, { method: 'POST', path: '/api/workspace/exec', body: { command: touchCommand } });
  assert.equal(res.status, 200, 'WORKSPACE_EXEC=true runs');
  assert.match(res.body.stdout, /WS_EXEC_OK/);
  rmSync(marker, { force: true });
  console.log('  ok /workspace/exec refuses with 403 unless WORKSPACE_EXEC is 1 or true');

  // ── agent bash tool ────────────────────────────────────────────────────────
  // Disabled: the list the route hands the model has no bash, but other tools stay.
  setFlag(undefined);
  script = [bashCall, { content: 'done' }];
  requests.length = 0;
  let out = await runAgent(agent.getExperienceTools('developer'));
  const offered = requests[0].tools.map(t => t.function.name);
  assert.ok(!offered.includes('bash'), `bash is not offered to the model when disabled: ${offered}`);
  assert.ok(offered.includes('read_file') && offered.includes('write_file'), 'other developer tools are still offered');
  assert.match(out.toolLog[0].result.error, /not in the active tool list/,
    'a bash call the model makes anyway is refused by the loop allowlist');
  assert.equal(existsSync(marker), false, 'refused bash call did not run');

  // Second layer: even if a bash call arrives with bash in the list, the executor refuses it.
  script = [bashCall, { content: 'done' }];
  out = await runAgent(DEVELOPER_TOOLS);
  assert.equal(out.toolLog[0].result.error, 'Shell execution is disabled (WORKSPACE_EXEC is not set)',
    'the executor refuses bash even when it is in the offered list');
  assert.equal(existsSync(marker), false, 'executor-level refusal did not run');

  setFlag('1');
  script = [bashCall, { content: 'done' }];
  requests.length = 0;
  out = await runAgent(agent.getExperienceTools('developer'));
  assert.ok(requests[0].tools.some(t => t.function.name === 'bash'), 'bash is offered when enabled');
  assert.match(out.toolLog[0].result.stdout, /WS_EXEC_OK/, 'enabled bash runs');
  assert.equal(existsSync(marker), true, 'enabled bash created the marker');
  rmSync(marker, { force: true });

  setFlag(undefined);
  const devTools = agent.getExperienceTools('developer');
  assert.ok(!devTools.some(t => t.function.name === 'bash'), 'getExperienceTools omits bash when disabled');
  assert.equal(devTools.length, DEVELOPER_TOOLS.length - 1, 'only bash is removed');
  setFlag('1');
  assert.strictEqual(agent.getExperienceTools('developer'), DEVELOPER_TOOLS, 'full developer set when enabled');
  console.log('  ok agent bash is refused and omitted from the tool list unless WORKSPACE_EXEC is set');

  console.log('Workspace exec flag tests passed.');
} finally {
  setFlag(undefined);
  server.close();
  llm.close();
  rmSync(base, { recursive: true, force: true });
}

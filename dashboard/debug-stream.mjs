import { createAgentHelpers, DEVELOPER_TOOLS } from './modules/agent-tools.js';
import express from 'express';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

const execAsync = promisify(exec);
const WORKSPACE = realpathSync(mkdtempSync(join(tmpdir(), 'ab-agent-')));
writeFileSync(join(WORKSPACE, 'hello.txt'), 'file contents\n');

console.log('WORKSPACE:', WORKSPACE);

const session = { model: 'test-model', id: 'sess_1', experience: 'developer', workspaceRoot: WORKSPACE };
const helpers = createAgentHelpers({
  WORKSPACE_ROOT: WORKSPACE, execAsync, TOOL_SERVERS: {}, TOOL_CALL_TIMEOUT_MS: 5000,
});

// Streaming test - first response has tool call, second has final answer
let streamScript = [
  { events: [
    { message: { content: 'Checking ' } },
    { message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }] } },
  ] },
  { events: [{ message: { content: 'Ollama streamed answer' } }] },
];

let streamIndex = 0;
const llmApp = express();
llmApp.use(express.json({ limit: '5mb' }));
llmApp.post('/api/chat', (req, res) => {
  if (req.body.stream) {
    const events = streamScript[streamIndex++]?.events || [];
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const event of events) res.write(`${JSON.stringify(event)}\n`);
    return res.end();
  }
  res.json({ message: { content: 'fallback' } });
});
const llm = llmApp.listen(0);
const LLM_URL = `http://127.0.0.1:${llm.address().port}`;

const ollamaToolEvents = [];
const out = await helpers.runAgentLoop([{ role: 'user', content: 'go' }], 'ollama', LLM_URL, {}, DEVELOPER_TOOLS, session, {
  stream: true,
  onToken: token => console.log('onToken:', token),
  onReset: () => console.log('onReset'),
  onToolCall: call => {
    console.log('onToolCall:', JSON.stringify(call, null, 2));
    ollamaToolEvents.push(call);
  }
});

console.log('---');
console.log('out.content:', out.content);
console.log('ollamaToolEvents:', JSON.stringify(ollamaToolEvents, null, 2));
console.log('toolLog:', JSON.stringify(out.toolLog, null, 2));
llm.close();
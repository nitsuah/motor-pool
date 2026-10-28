/**
 * Integration tests for streamed tool-enabled session turns. The model server
 * is scripted over HTTP; the real Express route, tool authorization, SSE client
 * lifecycle and session persistence run in-process.
 */
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workspace = mkdtempSync(join(tmpdir(), 'motor-pool-stream-tools-'));
writeFileSync(join(workspace, 'hello.txt'), 'hello from tool\n');
process.env.WORKSPACE_ROOT = workspace;
process.env.AGENT_DASHBOARD_DISABLE_LISTEN = '1';

let mode = 'success';
let selectedTool = { name: 'read_file', args: { path: 'hello.txt' } };
let finalStreamStartedResolve;
let finalStreamClosedResolve;
let finalStreamStarted;
let finalStreamClosed;
let finalStreamEndedAt = 0;
const llmApp = express();
llmApp.use(express.json({ limit: '5mb' }));
llmApp.get('/api/tags', (req, res) => res.json({ models: [{ name: 'test-model' }] }));
llmApp.post('/api/chat', (req, res) => {
  if (req.body.stream !== true) return res.status(400).json({ error: 'stream=true required' });
  if (mode === 'error') return res.status(500).json({ error: 'stub model failure' });

  const hasToolResult = req.body.messages.some(message => message.role === 'tool');
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  if (!hasToolResult) {
    // This provisional text must be reset when a structured tool call follows.
    res.write(`${JSON.stringify({ message: { content: 'Checking ' } })}\n`);
    return setTimeout(() => {
      res.write(`${JSON.stringify({ message: {
        content: '', tool_calls: [{ function: { name: selectedTool.name, arguments: selectedTool.args } }],
      } })}\n`);
      res.end();
    }, 25);
  }

  finalStreamStartedResolve();
  res.on('close', () => finalStreamClosedResolve?.());
  res.write(`${JSON.stringify({ message: { content: 'The file says ' } })}\n`);
  if (mode === 'hang-final') return;
  setTimeout(() => {
    res.write(`${JSON.stringify({ message: { content: 'hello.' } })}\n`);
    setTimeout(() => {
      finalStreamEndedAt = Date.now();
      res.end();
    }, 180);
  }, 25);
});

const llm = llmApp.listen(0, '127.0.0.1');
await new Promise(resolve => llm.once('listening', resolve));
const llmUrl = `http://127.0.0.1:${llm.address().port}`;
const websiteApp = express();
websiteApp.use(express.json());
websiteApp.get('/health', (req, res) => res.json({ status: 'ok' }));
websiteApp.post('/mcp', (req, res) => res.json({
  jsonrpc: '2.0', id: req.body.id,
  result: { content: [{ type: 'text', text: 'website file saved' }] },
}));
const website = websiteApp.listen(0, '127.0.0.1');
await new Promise(resolve => website.once('listening', resolve));
process.env.TOOL_WEBSITE_URL = `http://127.0.0.1:${website.address().port}`;
process.env.PRIMARY_LLM_URL = llmUrl;
process.env.PRIMARY_LLM_URL_CANDIDATES = llmUrl;
const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (route, body, signal) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
});

async function createSession(experience = 'developer', safetyMode) {
  const response = await post('/api/sessions', { experience, ...(safetyMode ? { safetyMode } : {}) });
  const data = await response.json();
  assert.equal(data.success, true);
  return data.session.id;
}

async function collectFrames(response, onFrame = () => {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop();
    for (const chunk of chunks) {
      const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
      if (!dataLine) continue;
      const frame = JSON.parse(dataLine.slice(6));
      frames.push(frame);
      onFrame(frame);
    }
  }
  return frames;
}

try {
  // The route must stream the tool loop itself, and answer text must arrive
  // before the upstream model closes its final response stream.
  mode = 'success';
  finalStreamStarted = new Promise(resolve => { finalStreamStartedResolve = resolve; });
  const sid = await createSession();
  const arrivedAt = new Map();
  const response = await post(`/api/sessions/${sid}/stream`, { message: 'Read hello.txt and summarize it.' });
  const frames = await collectFrames(response, frame => {
    if (frame.type === 'token' && frame.content === 'The file says ') arrivedAt.set('firstAnswerToken', Date.now());
  });
  const types = frames.map(frame => frame.type);
  assert.ok(types.indexOf('token') < types.indexOf('reset'), 'provisional model text streams immediately');
  assert.ok(types.indexOf('reset') < types.indexOf('tool_call'), 'provisional text clears before the tool result is shown');
  assert.ok(types.indexOf('tool_call') < types.lastIndexOf('token'), 'tool result is delivered before the final answer');
  assert.ok(types.includes('done'), 'tool-enabled stream completes');
  assert.ok(arrivedAt.get('firstAnswerToken') < finalStreamEndedAt, 'final answer token arrives before the model finishes its stream');
  const detail = await (await fetch(`${base}/api/sessions/${sid}`)).json();
  const assistant = [...detail.session.messages].reverse().find(message => message.role === 'assistant');
  assert.equal(assistant.content, 'The file says hello.', 'the full final answer is persisted');
  assert.equal(assistant.toolLog[0].result.content, 'hello from tool\n', 'the offered read_file tool ran');

  // The same streaming loop reaches the experience-specific research and
  // website tools, without widening any experience's allowed tool set.
  mode = 'success';
  selectedTool = { name: 'write_artifact', args: { filename: 'research.md', content: 'research result' } };
  const researchSid = await createSession('research');
  const researchFrames = await collectFrames(await post(`/api/sessions/${researchSid}/stream`, { message: 'Save a research note.' }));
  assert.ok(researchFrames.some(frame => frame.type === 'tool_call' && frame.tool === 'write_artifact'));
  assert.equal(readFileSync(join(workspace, 'artifacts', 'research.md'), 'utf8'), 'research result');

  selectedTool = { name: 'save_website_file', args: { slug: 'demo', filename: 'index.html', content: '<h1>Demo</h1>' } };
  const websiteSid = await createSession('website');
  const websiteFrames = await collectFrames(await post(`/api/sessions/${websiteSid}/stream`, { message: 'Save a demo web page.' }));
  assert.ok(websiteFrames.some(frame => frame.type === 'tool_call' && frame.tool === 'save_website_file'));
  assert.equal(websiteFrames.find(frame => frame.type === 'tool_call').result.success, true);

  // Strict mode never streams raw output, including content emitted before a
  // later tool-call delta; only the sanitized final reply is sent.
  mode = 'success';
  finalStreamEndedAt = 0;
  selectedTool = { name: 'read_file', args: { path: 'hello.txt' } };
  const strictSid = await createSession('developer', 'strict');
  const strictFrames = await collectFrames(await post(`/api/sessions/${strictSid}/stream`, { message: 'Read hello.txt.' }));
  const strictTokens = strictFrames.filter(frame => frame.type === 'token').map(frame => frame.content);
  assert.deepEqual(strictTokens, ['The file says hello.'], 'strict output is sent once after filtering');
  assert.ok(!strictFrames.some(frame => frame.type === 'reset'), 'strict output never exposes provisional text');

  // Upstream errors terminate the session as an error rather than leaving it
  // in running state.
  mode = 'error';
  const errorSid = await createSession();
  const errorFrames = await collectFrames(await post(`/api/sessions/${errorSid}/stream`, { message: 'fail' }));
  assert.ok(errorFrames.some(frame => frame.type === 'error'), 'upstream failure reaches the stream');
  const errorDetail = await (await fetch(`${base}/api/sessions/${errorSid}`)).json();
  assert.equal(errorDetail.session.status, 'error');

  // A downstream disconnect aborts the active Ollama stream and finalizes the
  // session instead of leaving a model request running in the background.
  mode = 'hang-final';
  finalStreamStarted = new Promise(resolve => { finalStreamStartedResolve = resolve; });
  finalStreamClosed = new Promise(resolve => { finalStreamClosedResolve = resolve; });
  const cancelSid = await createSession();
  const controller = new AbortController();
  const pending = post(`/api/sessions/${cancelSid}/stream`, { message: 'Read hello.txt.' }, controller.signal);
  const cancelResponse = await pending;
  const cancelReader = cancelResponse.body.getReader();
  await finalStreamStarted;
  controller.abort();
  await cancelReader.read().catch(() => {});
  await Promise.race([
    finalStreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream stream was not cancelled')), 1500)),
  ]);
  const cancelDetail = await (await fetch(`${base}/api/sessions/${cancelSid}`)).json();
  assert.notEqual(cancelDetail.session.status, 'running', 'disconnect finalizes the session state');

  console.log('Session tool streaming tests passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => llm.close(resolve));
  await new Promise(resolve => website.close(resolve));
  rmSync(workspace, { recursive: true, force: true });
}

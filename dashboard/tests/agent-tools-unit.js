/**
 * Tests for modules/agent-tools.js
 *
 * runAgentLoop() is driven by a scripted stub LLM served over real HTTP, so the
 * loop, the tool executor, and the safety checks all run for real — only the
 * model's replies are canned. Both the Ollama (`/api/chat`) and OpenAI
 * (`/chat/completions`) response shapes are exercised.
 */
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import {
  createAgentHelpers, DEVELOPER_TOOLS, RESEARCH_TOOLS, WEBSITE_AGENT_TOOLS,
} from '../modules/agent-tools.js';

const execAsync = promisify(exec);
const WORKSPACE = realpathSync(mkdtempSync(join(tmpdir(), 'ab-agent-')));
writeFileSync(join(WORKSPACE, 'hello.txt'), 'file contents\n');

// ── Scripted stub LLM ────────────────────────────────────────────────────────
// `script` is a queue of message objects to hand back, one per request.
let script = [];
let streamScript = [];
const requests = [];
const llmApp = express();
llmApp.use(express.json({ limit: '5mb' }));
llmApp.post('/api/chat', (req, res) => {
  requests.push(req.body);
  if (req.body.stream) {
    const events = streamScript.shift()?.events || [];
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const event of events) res.write(`${JSON.stringify(event)}\n`);
    return res.end();
  }
  res.json({ message: script.shift() ?? { content: 'fallback' } });
});
llmApp.post('/chat/completions', (req, res) => {
  requests.push(req.body);
  if (req.body.stream) {
    const events = streamScript.shift()?.events || [];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.json({ choices: [{ message: script.shift() ?? { content: 'fallback' } }] });
});
const llm = llmApp.listen(0);
const LLM_URL = `http://127.0.0.1:${llm.address().port}`;

const toolCall = (name, args) => ({
  content: '',
  tool_calls: [{ id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }],
});

const session = { model: 'test-model', id: 'sess_1' };
const helpers = createAgentHelpers({
  WORKSPACE_ROOT: WORKSPACE, execAsync, TOOL_SERVERS: {}, TOOL_CALL_TIMEOUT_MS: 5000,
});
const noWorkspace = createAgentHelpers({
  WORKSPACE_ROOT: null, execAsync, TOOL_SERVERS: {}, TOOL_CALL_TIMEOUT_MS: 5000,
});

// ── Stub plugin backend + registry ──────────────────────────────────────────
// A minimal HTTP backend standing in for a plugin's declared tool endpoint, plus
// a stub registry shaped like modules/plugin-loader.js's createPluginRegistry().
const pluginApp = express();
pluginApp.use(express.json());
pluginApp.post('/echo', (req, res) => res.json({ echoed: req.body.message }));
const pluginBackend = pluginApp.listen(0);
const PLUGIN_URL = `http://127.0.0.1:${pluginBackend.address().port}`;

const echoTool = {
  name: 'echo', plugin: 'stub-plugin', method: 'POST', endpoint: `${PLUGIN_URL}/echo`,
  timeoutMs: 5000, description: 'Echo a message', parameters: { type: 'object', properties: { message: { type: 'string' } } },
};
const stubPluginRegistry = {
  listTools: () => [echoTool],
  get: (name) => (name === 'stub-plugin' ? { name, enabled: true } : null),
  getTool: (pluginName, toolName) => (pluginName === 'stub-plugin' && toolName === 'echo' ? echoTool : null),
};
const helpersWithPlugin = createAgentHelpers({
  WORKSPACE_ROOT: WORKSPACE, execAsync, TOOL_SERVERS: {}, TOOL_CALL_TIMEOUT_MS: 5000,
  pluginRegistry: stubPluginRegistry,
});

const run = (h, tools = DEVELOPER_TOOLS, style = 'ollama') =>
  h.runAgentLoop([{ role: 'user', content: 'go' }], style, LLM_URL, {}, tools, session);

const runStreaming = (h, tools, style, callbacks) =>
  h.runAgentLoop([{ role: 'user', content: 'go' }], style, LLM_URL, {}, tools, session, {
    stream: true, ...callbacks,
  });

try {
  // ── getExperienceTools ─────────────────────────────────────────────────────
  assert.strictEqual(helpers.getExperienceTools('developer'), DEVELOPER_TOOLS, 'developer tools with a workspace');
  assert.deepStrictEqual(noWorkspace.getExperienceTools('developer'), [], 'no developer tools without a workspace');
  assert.strictEqual(helpers.getExperienceTools('research'), RESEARCH_TOOLS, 'research tools');
  assert.strictEqual(helpers.getExperienceTools('website'), WEBSITE_AGENT_TOOLS, 'website tools');
  assert.deepStrictEqual(helpers.getExperienceTools('safechat'), [], 'unknown experience gets no tools');
  assert.deepStrictEqual(helpers.getExperienceTools(undefined), [], 'undefined experience gets no tools');
  console.log('  ✅ getExperienceTools maps experiences, and gates developer tools on WORKSPACE_ROOT');

  // ── plain answer, no tools ─────────────────────────────────────────────────
  script = [{ content: 'just an answer' }];
  let out = await run(helpers);
  assert.strictEqual(out.content, 'just an answer', 'returns the model content');
  assert.deepStrictEqual(out.toolLog, [], 'no tools logged when none were called');

  script = [{ content: null }];
  out = await run(helpers);
  assert.strictEqual(out.content, 'No response received', 'null content falls back to a placeholder');
  console.log('  ✅ a reply with no tool calls is returned directly');

  // ── Ollama streaming tool loop ────────────────────────────────────────────
  streamScript = [
    { events: [
      { message: { content: 'Checking ' } },
      { message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }] } },
    ] },
    { events: [{ message: { content: 'Ollama streamed answer' } }] },
  ];
  const ollamaTokens = [];
  const ollamaResets = [];
  const ollamaToolEvents = [];
  out = await runStreaming(helpers, DEVELOPER_TOOLS, 'ollama', {
    onToken: token => ollamaTokens.push(token),
    onReset: () => ollamaResets.push(true),
    onToolCall: call => ollamaToolEvents.push(call),
  });
  assert.equal(out.content, 'Ollama streamed answer');
  assert.equal(ollamaTokens.join(''), 'Checking Ollama streamed answer');
  assert.equal(ollamaResets.length, 1, 'provisional text is cleared when a tool call arrives');
  assert.equal(ollamaToolEvents[0].result.content, 'file contents\n', 'tool result is reported as soon as it completes');
  assert.equal(requests.at(-2).stream, true);
  assert.equal(requests.at(-1).stream, true);
  console.log('  ✅ Ollama tool calls and final text stream through the agent loop');

  // ── OpenAI-compatible SSE with fragmented tool arguments ──────────────────
  streamScript = [
    { events: [
      { choices: [{ delta: { content: 'Inspecting ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_streamed', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hello.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ] },
    { events: [
      { choices: [{ delta: { content: 'OpenAI streamed ' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ] },
  ];
  const openAiTokens = [];
  const openAiToolEvents = [];
  out = await runStreaming(helpers, DEVELOPER_TOOLS, 'openai', {
    onToken: token => openAiTokens.push(token),
    onToolCall: call => openAiToolEvents.push(call),
  });
  assert.equal(out.content, 'OpenAI streamed answer');
  assert.equal(openAiTokens.join(''), 'Inspecting OpenAI streamed answer');
  assert.equal(openAiToolEvents[0].callId, 'call_streamed');
  assert.equal(openAiToolEvents[0].result.content, 'file contents\n');
  const streamedHistory = requests.at(-1).messages.find(message => message.role === 'assistant' && message.tool_calls);
  assert.deepEqual(JSON.parse(streamedHistory.tool_calls[0].function.arguments), { path: 'hello.txt' });
  console.log('  ✅ OpenAI-compatible SSE parses split tool-call arguments and streams the final reply');

  // ── A normal streamed text reply has no tools and emits its chunks live ────
  streamScript = [{ events: [
    { message: { content: 'Fast ' } }, { message: { content: 'answer' } },
  ] }];
  const plainTokens = [];
  out = await runStreaming(helpers, DEVELOPER_TOOLS, 'ollama', { onToken: token => plainTokens.push(token) });
  assert.equal(out.content, 'Fast answer');
  assert.equal(plainTokens.join(''), 'Fast answer');
  console.log('  ✅ streamed text chunks are emitted while the response is arriving');

  // ── read_file executes for real ────────────────────────────────────────────
  script = [toolCall('read_file', { path: 'hello.txt' }), { content: 'done reading' }];
  out = await run(helpers);
  assert.strictEqual(out.content, 'done reading', 'final answer returned after the tool round-trip');
  assert.strictEqual(out.toolLog.length, 1, 'one tool call logged');
  assert.strictEqual(out.toolLog[0].name, 'read_file');
  assert.strictEqual(out.toolLog[0].result.content, 'file contents\n', 'tool actually read the file');
  console.log('  ✅ runAgentLoop executes read_file and feeds the result back');

  // ── write_file / list_files ────────────────────────────────────────────────
  script = [toolCall('write_file', { path: 'out.txt', content: 'written by agent' }), { content: 'wrote it' }];
  out = await run(helpers);
  assert.ok(existsSync(join(WORKSPACE, 'out.txt')), 'write_file created the file');
  assert.strictEqual(readFileSync(join(WORKSPACE, 'out.txt'), 'utf8'), 'written by agent');

  script = [toolCall('list_files', { path: '.' }), { content: 'listed' }];
  out = await run(helpers);
  assert.ok(!out.toolLog[0].result.error, `list_files should succeed: ${out.toolLog[0].result.error}`);
  console.log('  ✅ write_file and list_files operate on the real workspace');

  // ── safety: bash blocklist ─────────────────────────────────────────────────
  script = [toolCall('bash', { command: 'rm -rf / --no-preserve-root' }), { content: 'blocked' }];
  out = await run(helpers);
  assert.match(out.toolLog[0].result.error, /blocked by safety policy/i, 'dangerous bash is refused');

  // A benign command still runs.
  script = [toolCall('bash', { command: 'echo hi' }), { content: 'ran' }];
  out = await run(helpers);
  assert.strictEqual(out.toolLog[0].result.stdout, 'hi', 'benign bash runs and returns stdout');
  assert.strictEqual(out.toolLog[0].result.exitCode, 0);

  // A failing command reports a non-zero exit rather than throwing.
  script = [toolCall('bash', { command: 'exit 3' }), { content: 'failed' }];
  out = await run(helpers);
  assert.notStrictEqual(out.toolLog[0].result.exitCode, 0, 'failing bash reports a non-zero exit code');
  console.log('  ✅ bash blocklist refuses destructive commands; normal and failing commands behave');

  // ── safety: path traversal ─────────────────────────────────────────────────
  for (const bad of ['../../etc/passwd', '/etc/passwd']) {
    script = [toolCall('read_file', { path: bad }), { content: 'nope' }];
    out = await run(helpers);
    const r = out.toolLog[0].result;
    assert.ok(r.error, `read_file must refuse "${bad}"`);
    assert.ok(!String(r.content || '').includes('root:'), `read_file must not leak "${bad}"`);
  }
  script = [toolCall('write_file', { path: '../escaped.txt', content: 'x' }), { content: 'nope' }];
  out = await run(helpers);
  assert.ok(out.toolLog[0].result.error, 'write_file refuses traversal');
  assert.ok(!existsSync(join(WORKSPACE, '..', 'escaped.txt')), 'nothing written outside the workspace');
  console.log('  ✅ read_file/write_file refuse path traversal and leak nothing');

  // ── tools without a workspace ──────────────────────────────────────────────
  script = [toolCall('read_file', { path: 'hello.txt' }), { content: 'no ws' }];
  out = await run(noWorkspace);
  assert.match(out.toolLog[0].result.error, /not mounted/i, 'tools report the missing workspace');
  script = [toolCall('bash', { command: 'echo hi' }), { content: 'no ws' }];
  out = await run(noWorkspace);
  assert.match(out.toolLog[0].result.error, /not mounted|WORKSPACE_ROOT/i, 'bash reports the missing workspace');
  console.log('  ✅ tools fail cleanly when WORKSPACE_ROOT is not set');

  // ── unknown tool ───────────────────────────────────────────────────────────
  script = [toolCall('no_such_tool', {}), { content: 'unknown' }];
  out = await run(helpers);
  assert.ok(out.toolLog[0].result.error, 'an unknown tool yields an error result rather than throwing');
  console.log('  ✅ an unknown tool name produces an error result');

  // ── consecutive-error abort ────────────────────────────────────────────────
  // Three failing tool calls in a row must abort the loop.
  script = [
    toolCall('read_file', { path: '../a' }),
    toolCall('read_file', { path: '../b' }),
    toolCall('read_file', { path: '../c' }),
    { content: 'should not be reached' },
  ];
  out = await run(helpers);
  assert.match(out.content, /aborted after 3 consecutive errors/i, 'loop aborts after repeated tool errors');
  assert.ok(out.toolLog.at(-1).aborted, 'the aborting entry is marked in the tool log');
  console.log('  ✅ three consecutive tool errors abort the loop');

  // ── iteration cap ──────────────────────────────────────────────────────────
  // Always return a *successful* tool call so the error-abort never triggers;
  // the loop must still stop and make one final call for a summary.
  script = Array.from({ length: 12 }, () => toolCall('read_file', { path: 'hello.txt' }));
  script.push({ content: 'final summary' });
  requests.length = 0;
  out = await run(helpers);
  assert.strictEqual(out.toolLog.length, 5, 'stops after MAX_ITERATIONS tool rounds');
  assert.strictEqual(requests.length, 6, 'five loop calls plus one final summarizing call');
  console.log('  ✅ the loop caps at 5 iterations then makes a final summarizing call');

  // ── openai message shape ───────────────────────────────────────────────────
  script = [toolCall('read_file', { path: 'hello.txt' }), { content: 'openai done' }];
  requests.length = 0;
  out = await run(helpers, DEVELOPER_TOOLS, 'openai');
  assert.strictEqual(out.content, 'openai done', 'openai response shape is unwrapped from choices[]');
  const toolMsg = requests[1].messages.find(m => m.role === 'tool');
  assert.strictEqual(toolMsg.tool_call_id, 'call_read_file', 'openai style attaches tool_call_id');

  script = [toolCall('read_file', { path: 'hello.txt' }), { content: 'ollama done' }];
  requests.length = 0;
  await run(helpers, DEVELOPER_TOOLS, 'ollama');
  const ollamaToolMsg = requests[1].messages.find(m => m.role === 'tool');
  assert.strictEqual(ollamaToolMsg.tool_call_id, undefined, 'ollama style omits tool_call_id');
  console.log('  ✅ openai and ollama tool-result message shapes differ correctly');

  // ── tool call written as plain JSON text, replayed to an OpenAI endpoint ───
  script = [{ content: '{"name":"read_file","parameters":{"path":"hello.txt"}}' }, { content: 'text call done' }];
  requests.length = 0;
  out = await run(helpers, DEVELOPER_TOOLS, 'openai');
  assert.strictEqual(out.content, 'text call done');
  assert.strictEqual(out.toolLog[0].name, 'read_file', 'text-encoded call was executed');
  const histCall = requests[1].messages.find(m => m.role === 'assistant' && m.tool_calls)?.tool_calls?.[0];
  assert.ok(histCall?.id, 'history tool call has an id');
  assert.strictEqual(histCall.type, 'function', 'history tool call has type=function');
  assert.strictEqual(typeof histCall.function.arguments, 'string', 'openai history arguments are a JSON string');
  assert.deepStrictEqual(JSON.parse(histCall.function.arguments), { path: 'hello.txt' });
  const textToolMsg = requests[1].messages.find(m => m.role === 'tool');
  assert.strictEqual(textToolMsg.tool_call_id, histCall.id, 'tool_call_id matches the assistant call id');
  console.log('  ✅ a text-encoded tool call is replayed in valid OpenAI shape with matching ids');

  // Ollama calls without ids still get one id shared by call and result log.
  script = [{ content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }] }, { content: 'ok' }];
  requests.length = 0;
  out = await run(helpers, DEVELOPER_TOOLS, 'ollama');
  const ollamaHist = requests[1].messages.find(m => m.role === 'assistant' && m.tool_calls).tool_calls[0];
  assert.ok(ollamaHist.id && ollamaHist.id === out.toolLog[0].callId, 'id assigned once and reused');
  assert.strictEqual(typeof ollamaHist.function.arguments, 'object', 'ollama history keeps object arguments');
  console.log('  ✅ id-less calls get one id reused for history and the tool log');

  // ── bash runs without the dashboard's secrets in its environment ──────────
  process.env.MP_TEST_SECRET = 'leak-me';
  script = [toolCall('bash', { command: 'echo "secret=[$MP_TEST_SECRET] path=[${PATH:+set}]"' }), { content: 'env checked' }];
  out = await run(helpers);
  delete process.env.MP_TEST_SECRET;
  assert.match(out.toolLog[0].result.stdout, /secret=\[\] path=\[set\]/, 'secrets are not inherited; PATH is');
  console.log('  ✅ bash tool gets a scrubbed environment (no dashboard secrets)');

  // ── object-form arguments ──────────────────────────────────────────────────
  // Some models return `arguments` already parsed rather than as a JSON string.
  script = [
    { content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: { path: 'hello.txt' } } }] },
    { content: 'object args ok' },
  ];
  out = await run(helpers);
  assert.strictEqual(out.toolLog[0].result.content, 'file contents\n', 'object-form arguments are accepted');
  console.log('  ✅ tool arguments are accepted as both JSON strings and objects');

  // ── plugin tools merge into the tool list ──────────────────────────────────
  const devToolsWithPlugin = helpersWithPlugin.getExperienceTools('developer');
  assert.strictEqual(devToolsWithPlugin.length, DEVELOPER_TOOLS.length + 1, 'plugin tool is appended');
  const pluginFn = devToolsWithPlugin.at(-1).function;
  assert.strictEqual(pluginFn.name, 'stub-plugin__echo', 'plugin tool uses <plugin>__<tool> naming');
  assert.match(pluginFn.description, /\[Plugin: stub-plugin\]/, 'description is prefixed with the plugin name');
  assert.deepStrictEqual(
    helpers.getExperienceTools('developer'), DEVELOPER_TOOLS,
    'a registry with no plugins leaves the tool list untouched',
  );

  // Plugin tools layer onto every tool-using experience, not just developer.
  const researchToolsWithPlugin = helpersWithPlugin.getExperienceTools('research');
  assert.strictEqual(researchToolsWithPlugin.length, RESEARCH_TOOLS.length + 1, 'plugin tool is appended to research');
  assert.deepStrictEqual(
    researchToolsWithPlugin.slice(0, RESEARCH_TOOLS.length), RESEARCH_TOOLS,
    'research base tools are preserved ahead of the plugin tool',
  );
  assert.strictEqual(researchToolsWithPlugin.at(-1).function.name, 'stub-plugin__echo');
  assert.deepStrictEqual(
    helpers.getExperienceTools('research'), RESEARCH_TOOLS,
    'a registry with no plugins leaves the research tool list untouched',
  );

  const websiteToolsWithPlugin = helpersWithPlugin.getExperienceTools('website');
  assert.strictEqual(websiteToolsWithPlugin.length, WEBSITE_AGENT_TOOLS.length + 1, 'plugin tool is appended to website');
  assert.deepStrictEqual(
    websiteToolsWithPlugin.slice(0, WEBSITE_AGENT_TOOLS.length), WEBSITE_AGENT_TOOLS,
    'website base tools are preserved ahead of the plugin tool',
  );
  assert.strictEqual(websiteToolsWithPlugin.at(-1).function.name, 'stub-plugin__echo');
  assert.deepStrictEqual(
    helpers.getExperienceTools('website'), WEBSITE_AGENT_TOOLS,
    'a registry with no plugins leaves the website tool list untouched',
  );
  console.log('  ✅ plugin tools merge into developer, research, and website tool lists');
  assert.deepStrictEqual(
    helpersWithPlugin.getExperienceTools('safechat'), [],
    'plugin tools never leak into a non-tool-using experience',
  );
  assert.deepStrictEqual(
    helpersWithPlugin.getExperienceTools(undefined), [],
    'plugin tools never leak into the undefined/default experience',
  );
  console.log('  ✅ enabled plugin tools merge into developer/research/website tool lists only');

  // ── plugin tool actually executes ──────────────────────────────────────────
  script = [toolCall('stub-plugin__echo', { message: 'hi from agent' }), { content: 'echoed back' }];
  out = await run(helpersWithPlugin, devToolsWithPlugin);
  assert.strictEqual(out.content, 'echoed back');
  assert.strictEqual(out.toolLog[0].name, 'stub-plugin__echo');
  assert.strictEqual(out.toolLog[0].result.success, true, 'plugin call reports success');
  assert.strictEqual(out.toolLog[0].result.result.echoed, 'hi from agent', 'the real HTTP backend ran and echoed the argument');
  console.log('  ✅ a <plugin>__<tool> function call routes through to the plugin backend');

  // ── unknown plugin tool name still errors cleanly ──────────────────────────
  script = [toolCall('stub-plugin__no_such_tool', {}), { content: 'unknown plugin tool' }];
  out = await run(helpersWithPlugin, devToolsWithPlugin);
  assert.ok(out.toolLog[0].result.error, 'an unregistered <plugin>__<tool> name yields an error, not a throw');
  console.log('  ✅ an unknown plugin/tool pair produces an error result rather than throwing');

  console.log('Agent tools tests passed.');
} finally {
  llm.close();
  pluginBackend.close();
  rmSync(WORKSPACE, { recursive: true, force: true });
}

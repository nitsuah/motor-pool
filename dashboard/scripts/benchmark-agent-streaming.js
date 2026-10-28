#!/usr/bin/env node
/**
 * Compare buffered and streamed agent-loop latency against a local Ollama
 * endpoint. Tool data is temporary; the website MCP server is an in-process
 * stub so the model and tool-loop costs can be compared without external APIs.
 * Run in the isolated Compose test image, never in the live dashboard container.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createAgentHelpers } from '../modules/agent-tools.js';

const llmUrl = (process.argv[2] || process.env.BENCHMARK_OLLAMA_URL || 'http://host.docker.internal:8081').replace(/\/$/, '');
const model = process.argv[3] || process.env.BENCHMARK_MODEL || 'llama3.2:3b';
const repetitions = Math.max(1, Math.min(10, Number(process.argv[4] || 3)));
const workspace = mkdtempSync(join(tmpdir(), 'motor-pool-stream-bench-'));
mkdirSync(join(workspace, 'artifacts'));
writeFileSync(join(workspace, 'facts.txt'), 'The local profile is CPU-backed. Streaming should show output before the tool loop finishes.\n');

const websiteApp = express();
websiteApp.use(express.json());
websiteApp.post('/mcp', (req, res) => res.json({
  jsonrpc: '2.0', id: req.body.id,
  result: { content: [{ type: 'text', text: 'Saved temporary benchmark page.' }] },
}));
const websiteServer = websiteApp.listen(0, '127.0.0.1');
await new Promise(resolve => websiteServer.once('listening', resolve));
const helpers = createAgentHelpers({
  WORKSPACE_ROOT: workspace,
  execAsync: async () => ({ stdout: '', stderr: '' }),
  TOOL_SERVERS: { website: { url: `http://127.0.0.1:${websiteServer.address().port}` } },
  TOOL_CALL_TIMEOUT_MS: 5000,
});

const cases = [
  {
    experience: 'developer',
    prompt: 'Read facts.txt with the read_file tool, then summarize its two facts in one short sentence.',
    requiredTool: 'read_file',
  },
  {
    experience: 'research',
    prompt: 'Use write_artifact to save a file named result.md containing exactly: Local benchmark artifact. Then confirm it was saved.',
    requiredTool: 'write_artifact',
  },
  {
    experience: 'website',
    prompt: 'Use save_website_file to save index.html for slug latency-benchmark with a tiny HTML page that says Local benchmark. Then confirm it was saved.',
    requiredTool: 'save_website_file',
  },
];
const samples = [];

async function runOne(testCase, stream) {
  const tools = helpers.getExperienceTools(testCase.experience).filter(
    tool => tool.function?.name === testCase.requiredTool,
  );
  const session = { id: `bench-${testCase.experience}`, model, experience: testCase.experience };
  const messages = [
    { role: 'system', content: `You are benchmarking the ${testCase.experience} agent experience. Use the named tool required by the user before you answer. Do not claim a tool succeeded unless its result confirms success.` },
    { role: 'user', content: testCase.prompt },
  ];
  let firstTokenMs = null;
  const started = performance.now();
  const result = await helpers.runAgentLoop(messages, 'ollama', llmUrl, {}, tools, session, {
    stream,
    onToken: () => { if (firstTokenMs === null) firstTokenMs = performance.now() - started; },
  });
  const totalMs = performance.now() - started;
  const expectedToolCalled = result.toolLog.some(entry => entry.name === testCase.requiredTool);
  samples.push({
    experience: testCase.experience,
    mode: stream ? 'streamed' : 'buffered',
    firstTokenMs: stream ? Math.round(firstTokenMs ?? totalMs) : Math.round(totalMs),
    totalMs: Math.round(totalMs),
    toolCalls: result.toolLog.length,
    expectedToolCalled,
    model,
  });
}

const median = values => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

try {
  // Warm the selected model before taking paired measurements.
  const warm = await fetch(`${llmUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with ready.' }], stream: false, options: { num_predict: 2 } }),
    signal: AbortSignal.timeout(120000),
  });
  if (!warm.ok) throw new Error(`Ollama warmup failed (${warm.status}) at ${llmUrl}`);
  await warm.arrayBuffer();

  for (const testCase of cases) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      // Use a fresh prompt per mode. The buffered path represents the previous
      // route behavior; streamed mode uses the same model, tools and user input.
      await runOne(testCase, false);
      await runOne(testCase, true);
    }
  }
  const summary = cases.map(({ experience }) => {
    const current = samples.filter(sample => sample.experience === experience && sample.expectedToolCalled);
    const buffered = current.filter(sample => sample.mode === 'buffered');
    const streamed = current.filter(sample => sample.mode === 'streamed');
    return {
      experience,
      validPairs: Math.min(buffered.length, streamed.length),
      bufferedMedianMs: {
        firstToken: median(buffered.map(sample => sample.firstTokenMs)),
        total: median(buffered.map(sample => sample.totalMs)),
      },
      streamedMedianMs: {
        firstToken: median(streamed.map(sample => sample.firstTokenMs)),
        total: median(streamed.map(sample => sample.totalMs)),
      },
    };
  });
  console.log(JSON.stringify({
    benchmark: 'motor-pool-agent-streaming',
    date: new Date().toISOString(),
    endpoint: llmUrl,
    model,
    note: 'Buffered first-token time is when the route can first emit its final reply. Total excludes HTTP session preflight/finalization; all tools run against temporary local data or an in-process MCP stub.',
    repetitions,
    summary,
    samples,
  }, null, 2));
} finally {
  await new Promise(resolve => websiteServer.close(resolve));
  rmSync(workspace, { recursive: true, force: true });
}

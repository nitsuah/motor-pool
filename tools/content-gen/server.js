/**
 * content-gen MCP server
 *
 * Wraps MoneyPrinterTurbo's REST API as MCP tools so motor-pool and Claude
 * can generate AI short videos without touching the Docker stack directly.
 *
 * Ports:
 *   This server:           3200 (CONTENT_GEN_PORT)
 *   MoneyPrinterTurbo API: 8080 (MPT_API_URL)
 *   MoneyPrinterTurbo UI:  8501 (MPT_UI_URL)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

const execAsync = promisify(exec);

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, 'scripts');

const PORT    = parseInt(process.env.CONTENT_GEN_PORT || '3200', 10);
const MPT_API = process.env.MPT_API_URL || 'http://localhost:8080';
const MPT_UI  = process.env.MPT_UI_URL  || 'http://localhost:8501';

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS  = 600_000;  // 10 min

// ── Helpers ────────────────────────────────────────────────────────────────────

async function isMptRunning() {
  try {
    await axios.get(`${MPT_API}/health`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function mptNotRunningError() {
  return new Error(
    'MoneyPrinterTurbo is not running.\n' +
    `Start it on the host:\n  docker compose --profile mpt up -d\n` +
    `Then retry — this server connects to it at ${MPT_API}`
  );
}

async function pollTaskUntilDone(taskId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const { data } = await axios.get(`${MPT_API}/api/v1/tasks/${taskId}`);
    const taskData = data.data || data;
    const { state } = taskData;
    const files = taskData.combined_videos?.length ? taskData.combined_videos : (taskData.videos || []);
    if (state === 'completed' || state === 'complete' || state === 1) return { state, taskData, files };
    if (state === 'failed' || state === 'error' || state === -1)      throw new Error(`Task ${taskId} failed: ${data.message || 'unknown error'}`);
  }
  throw new Error(`Task ${taskId} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

// ── MCP server factory ─────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({ name: 'content-gen', version: '1.0.0' }, { maxToolInputElements: 10_000 });

  // ── Tool: generate_video ─────────────────────────────────────────────────────
  server.tool(
    'generate_video',
    'Generate an AI short video from a topic. Starts MoneyPrinterTurbo if needed, ' +
    'submits the job, polls until done, and returns download URLs.',
    {
      topic:     z.string().describe('Video topic or script prompt'),
      aspect:    z.enum(['portrait', 'landscape']).default('portrait').describe('9:16 portrait or 16:9 landscape'),
      count:     z.number().int().min(1).max(5).default(1).describe('Number of videos to generate'),
      language:  z.string().default('en').describe('BCP-47 language code'),
      subtitles: z.boolean().default(true).describe('Include burnt-in subtitles'),
    },
    async ({ topic, aspect, count, language, subtitles }) => {
      if (!await isMptRunning()) throw mptNotRunningError();

      const videoAspect = aspect === 'portrait' ? '9:16' : '16:9';
      const payload = {
        video_subject: topic,
        video_aspect: videoAspect,
        video_count: count,
        video_language: language,
        subtitle_enabled: subtitles,
      };

      const { data: submitData } = await axios.post(`${MPT_API}/api/v1/videos`, payload);
      const taskId = submitData.data?.task_id || submitData.task_id;
      if (!taskId) throw new Error('No task_id returned from MoneyPrinterTurbo');

      const result = await pollTaskUntilDone(taskId);
      const urls = result.files.map(f =>
        typeof f === 'string' ? `http://localhost:8080${f}` : (f.url || f.path || JSON.stringify(f))
      );

      return {
        content: [{
          type: 'text',
          text: [
            `✓ Generated ${urls.length} video(s) for: "${topic}"`,
            ...urls.map(u => `✓ ${u}`),
            ``,
            `View in UI: ${MPT_UI}`,
            `task_id: ${taskId}`,
          ].join('\n'),
        }],
      };
    }
  );

  // ── Tool: get_video_status ───────────────────────────────────────────────────
  server.tool(
    'get_video_status',
    'Check the status of a MoneyPrinterTurbo video generation task.',
    { task_id: z.string().describe('Task ID returned by generate_video') },
    async ({ task_id }) => {
      if (!await isMptRunning()) {
        return { content: [{ type: 'text', text: '✗ MoneyPrinterTurbo is not running.' }] };
      }
      const { data } = await axios.get(`${MPT_API}/api/v1/tasks/${task_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Tool: container_status ──────────────────────────────────────────────────
  server.tool(
    'container_status',
    'Check whether the MoneyPrinterTurbo service is reachable.',
    {},
    async () => {
      const running = await isMptRunning();
      return {
        content: [{
          type: 'text',
          text: running
            ? `✓ MoneyPrinterTurbo is running at ${MPT_API}\n  UI: ${MPT_UI}`
            : `✗ MoneyPrinterTurbo is not reachable at ${MPT_API}\n  Start it on the host: docker compose --profile mpt up -d`,
        }],
      };
    }
  );

  // ── Tool: run_setup ─────────────────────────────────────────────────────────
  server.tool(
    'run_setup',
    'Run the content-gen one-time setup script (clone MoneyPrinterTurbo, configure API keys).',
    {
      pexels_key:   z.string().optional().describe('Pexels API key'),
      gemini_key:   z.string().optional().describe('Gemini API key'),
      anthropic_key: z.string().optional().describe('Anthropic API key'),
    },
    async ({ pexels_key, gemini_key, anthropic_key }) => {
      const args = [
        pexels_key    ? `-PexelsKey "${pexels_key}"`    : '',
        gemini_key    ? `-GeminiKey "${gemini_key}"`    : '',
        anthropic_key ? `-AnthropicKey "${anthropic_key}"` : '',
      ].filter(Boolean).join(' ');
      const { stdout, stderr } = await execAsync(
        `pwsh -File "${SCRIPTS_DIR}/setup.ps1" ${args}`,
        { timeout: 120_000 }
      );
      return { content: [{ type: 'text', text: stdout + (stderr ? `\nSTDERR: ${stderr}` : '') }] };
    }
  );

  return server;
}

// ── Express app ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'content-gen',
  mpt_api: MPT_API,
  mpt_ui:  MPT_UI,
}));

// MCP endpoint — stateless per-request pattern
app.post('/mcp', async (req, res) => {
  const server    = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// SSE upgrade for streaming
app.get('/mcp', async (req, res) => {
  const server    = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`content-gen MCP server running on port ${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`  MCP:     http://localhost:${PORT}/mcp`);
  console.log(`  MPT API: ${MPT_API}`);
});

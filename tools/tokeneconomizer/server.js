#!/usr/bin/env node
/**
 * TokenEconomizer HTTP wrapper service
 *
 * Exposes a fixed, read-only set of TokenEconomizer CLI (te) commands over HTTP.
 * Request bodies only choose from enums; they never reach the CLI argv.
 * Binds to loopback unless TOKEN_ECONOMIZER_HOST says otherwise (compose sets
 * 0.0.0.0 inside the container, on a dedicated private network).
 */

import { spawn } from 'child_process';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { safeTeError } from './safe-error.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.TOKEN_ECONOMIZER_PORT || '3202', 10);
export const DEFAULT_HOST = '127.0.0.1';

// te CLI installed via pip3 at /usr/local/bin/te
const TE_CMD = '/usr/local/bin/te';

export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const KILL_GRACE_MS = 5000;

// Execute the te CLI with a fixed argv (never built from request data).
// `cmd` is injectable for tests only; the server always uses the default.
export async function runTeCommand(teArgs, { cmd = TE_CMD, maxBytes = MAX_OUTPUT_BYTES, killGraceMs = KILL_GRACE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, teArgs, { stdio: 'pipe', cwd: __dirname });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    let killTimer = null;

    const timeoutMs = parseInt(process.env.TOKEN_ECONOMIZER_TIMEOUT_MS || '60000', 10);
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => proc.kill('SIGKILL'), killGraceMs);
    }, timeoutMs);

    const collect = (which) => (data) => {
      if (overflowed) return;
      const next = (which === 'out' ? stdout : stderr) + data.toString();
      if (Buffer.byteLength(next) > maxBytes) {
        overflowed = true;
        proc.kill('SIGKILL');
        return;
      }
      if (which === 'out') stdout = next;
      else stderr = next;
    };
    proc.stdout.on('data', collect('out'));
    proc.stderr.on('data', collect('err'));

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) return reject({ status: 504, error: 'te command timed out' });
      if (overflowed) return reject({ status: 500, error: 'te output too large' });
      if (code !== 0) return reject({ status: 500, error: 'te command failed' });
      resolve({ output: stdout || stderr });
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject({ status: 500, error: 'Failed to spawn te process' });
    });
  });
}

const MUTATING = new Set([
  'apply', 'restore', 'refresh-catalog', 'apply-pending',
  'set', 'unset', 'migrate', 'merge', 'refresh',
]);

const ALLOWED = {
  status: ['json'], microskills: [], toolprune: ['action'], config: ['operation'],
  repomap: [], repos: ['operation'], doctor: [],
};

const bad = (error) => ({ status: 400, body: { success: false, error } });
const disabled = (what) => ({ status: 403, body: { success: false, error: `${what} is disabled over HTTP` } });

// Fixed command table: validated body -> constant argv, or a rejection.
const COMMANDS = {
  status: (b) => {
    if (b.json !== undefined && typeof b.json !== 'boolean') return bad('json must be a boolean');
    return { argv: b.json ? ['status', '--json'] : ['status'] };
  },
  microskills: () => ({ argv: ['microskills'] }),
  toolprune: (b) => {
    const action = b.action === undefined ? 'show' : b.action;
    if (typeof action === 'string' && MUTATING.has(action)) return disabled(`toolprune ${action}`);
    if (action === 'show') return { argv: ['toolprune', 'show'] };
    if (action === 'measure') return { argv: ['toolprune', 'measure'] };
    return bad('action must be show or measure');
  },
  config: (b) => {
    const op = b.operation === undefined ? 'show' : b.operation;
    if (typeof op === 'string' && MUTATING.has(op)) return disabled(`config ${op}`);
    if (op === 'show') return { argv: ['config', 'show'] };
    return bad('operation must be show');
  },
  repomap: () => ({ argv: ['repomap'] }),
  repos: (b) => {
    const op = b.operation === undefined ? 'list' : b.operation;
    if (typeof op === 'string' && MUTATING.has(op)) return disabled(`repos ${op}`);
    if (op === 'list') return { argv: ['repos', 'list'] };
    return bad('operation must be list');
  },
  doctor: () => ({ argv: ['doctor'] }),
};

export function createApp({ run = runTeCommand } = {}) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (req, res) => {
    res.json({ service: 'tokeneconomizer', ok: true });
  });

  app.post('/:command', async (req, res) => {
    const build = Object.hasOwn(COMMANDS, req.params.command) ? COMMANDS[req.params.command] : null;
    if (!build) return res.status(404).json({ success: false, error: 'Not found' });
    const body = req.body === undefined ? {} : req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
    }
    const unknown = Object.keys(body).filter((k) => !ALLOWED[req.params.command].includes(k));
    if (unknown.length) {
      return res.status(400).json({ success: false, error: 'Unknown request properties' });
    }
    const plan = build(body);
    if (!plan.argv) return res.status(plan.status).json(plan.body);
    try {
      const result = await run(plan.argv);
      res.json({ success: true, command: req.params.command, output: result.output });
    } catch (err) {
      // Keep command arguments and CLI output server-side; errors may contain secrets.
      res.status(err?.status || 500).json({ success: false, ...safeTeError(err) });
    }
  });

  // Malformed JSON, oversized bodies, etc.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err?.status === 413 ? 413 : 400).json({ success: false, error: 'Invalid request' });
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.TOKEN_ECONOMIZER_HOST || DEFAULT_HOST;
  createApp().listen(PORT, host, () => {
    console.log(`TokenEconomizer HTTP wrapper listening on ${host}:${PORT}`);
  });
}

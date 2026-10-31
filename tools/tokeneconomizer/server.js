#!/usr/bin/env node
/**
 * TokenEconomizer HTTP wrapper service
 *
 * Exposes TokenEconomizer CLI commands (te) as HTTP endpoints.
 * Runs on http://localhost:MakeAbsolute(plugin-port)
 * Mounts TE_PYTHON env var + ~/.tokeneconomizer volume.
 */

import { spawn } from 'child_process';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.TOKEN_ECONOMIZER_PORT || '3202', 10);
const TE_PYTHON = process.env.TE_PYTHON || process.env.TOKEN_ECONOMIZER_PYTHON || '';

const app = express();
app.use(express.json({ limit: '1MB' }));

// Root health endpoint
app.get('/health', (req, res) => {
  res.json({
    service: 'tokeneconomizer',
    python: TE_PYTHON || 'auto',
    volume: process.env.TOKEN_ECONOMIZER_DATA_DIR || '~/.tokeneconomizer',
  });
});

// Proxy to te CLI
app.post('/exec', async (req, res) => {
  const { command, args = [] } = req.body;

  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command required' });
  }

  // Build te command: te <command> [args...]
  const teArgs = [command, ...args];

  // Find Python
  let python;
  if (TE_PYTHON) {
    python = TE_PYTHON;
  } else {
    // Try common names in order
    const candidates = ['python3', 'python', 'py'];
    for (const p of candidates) {
      try {
        await spawn(p, ['--version'], { detached: true });
        python = p;
        break;
      } catch {
        continue;
      }
    }
    if (!python) {
      return res.status(500).json({ error: 'No Python found; set TE_PYTHON' });
    }
  }

  // Run te command
  const proc = spawn(python, ['te'].concat(teArgs), {
    stdio: 'pipe',
    cwd: __dirname,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const timeoutMs = parseInt(process.env.TOKEN_ECONOMIZER_TIMEOUT_MS || '60000', 10);

  const timeout = setTimeout(() => {
    proc.kill('SIGTERM');
    timedOut = true;
  }, timeoutMs);

  proc.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  proc.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  proc.on('close', (code) => {
    clearTimeout(timeout);
    if (timedOut) {
      return res.status(504).json({
        error: `te command timed out after ${timeoutMs}ms`,
      });
    }

    if (code !== 0) {
      return res.status(500).json({
        error: `te ${command} failed:`,
        output: stdout || stderr,
      });
    }

    res.json({
      success: true,
      command,
      args,
      output: stdout || stderr,
    });
  });

  proc.on('error', (err) => {
    clearTimeout(timeout);
    res.status(500).json({
      error: 'Failed to spawn te process',
      details: err.message,
    });
  });
});

// TokenEconomizer commands
const TE_COMMANDS = [
  'status',
  'microskills',
  'toolprune',
  'toolprune measure',
  'toolprune restore',
  'toolprune refresh-catalog',
  'config',
  'config set',
  'config unset',
  'repomap',
  'repos',
  'repos migrate',
  'repos merge',
  'doctor',
];

// Map high-level commands to /exec endpoints
TE_COMMANDS.forEach((cmd) => {
  const parts = cmd.split(' ');
  const subCmd = parts[0];
  const arg = parts[1];

  app.post(`/${subCmd}`, async (req, res) => {
    const execArgs = arg ? [arg] : [];
    if (req.body?.arguments) {
      execArgs.push(...Object.values(req.body.arguments));
    }

    // Execute with custom prompt if provided
    if (req.body?.prompt) {
      execArgs.unshift(req.body.prompt);
    }

    try {
      const response = await fetch(`${req.protocol}://${req.get('host')}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'te', args: execArgs }),
      });
      res.status(response.status).json(await response.json());
    } catch (err) {
      res.status(500).json({
        error: 'Request to /exec failed',
        details: err.message,
      });
    }
  });
});

// Enable CORS for other services
app.get('/*', (req, res) => {
  res.json({
    error: 'Not found. Use /health or POST to /exec with { command, args }',
    commands: TE_COMMANDS,
    docs: 'POST /{status|microskills|toolprune|...} — execute TokenEconomizer CLI',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TokenEconomizer HTTP wrapper listening on port ${PORT}`);
  console.log(`Serving ${TE_COMMANDS.length} commands: ${TE_COMMANDS.join(', ')}`);
});
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
import { safeTeError } from './safe-error.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.TOKEN_ECONOMIZER_PORT || '3202', 10);
const TE_PYTHON = process.env.TE_PYTHON || process.env.TOKEN_ECONOMIZER_PYTHON || '';

// te CLI installed via pip3 at /usr/local/bin/te
const TE_CMD = '/usr/local/bin/te';

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

// Internal function to execute te CLI
async function runTeCommand(teArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(TE_CMD, teArgs, {
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
        return reject({
          status: 504,
          error: `te command timed out after ${timeoutMs}ms`,
        });
      }

      if (code !== 0) {
        return reject({
          status: 500,
          error: `te ${teArgs.join(' ')} failed:`,
          output: stdout || stderr,
        });
      }

      resolve({
        success: true,
        command: teArgs.join(' '),
        output: stdout || stderr,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject({
        status: 500,
        error: 'Failed to spawn te process',
        details: err.message,
      });
    });
  });
}

// Proxy to te CLI
app.post('/exec', async (req, res) => {
  try {
    const { args = [] } = req.body;
    const teArgs = Array.isArray(args) ? args : [args];
    const result = await runTeCommand(teArgs);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    // Keep command arguments and CLI output server-side; errors may contain secrets.
    res.status(status).json({ success: false, ...safeTeError(err) });
  }
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

// Map high-level commands to runTeCommand directly
TE_COMMANDS.forEach((cmd) => {
  const parts = cmd.split(' ');
  const subCmd = parts[0];
  const arg = parts[1];

  app.post(`/${subCmd}`, async (req, res) => {
    try {
      const execArgs = [subCmd, ...(arg ? [arg] : [])];
      if (req.body?.arguments) {
        execArgs.push(...Object.values(req.body.arguments));
      }

      // Execute with custom prompt if provided
      if (req.body?.prompt) {
        execArgs.unshift(req.body.prompt);
      }

      const result = await runTeCommand(execArgs);
      res.json(result);
    } catch (err) {
      const status = err.status || 500;
      // Keep command arguments and CLI output server-side; errors may contain secrets.
      res.status(status).json({ success: false, ...safeTeError(err) });
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

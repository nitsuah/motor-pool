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
import { dirname } from 'path';

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
    volume: process.env.TOKENECONOMIZER_HOME || (process.env.HOME || '/home/node') + '/.tokeneconomizer',
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

// Fixed command surface. Do not accept arbitrary CLI input over HTTP.
function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function validKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}

const COMMANDS = {
  status: {
    args: (body) => {
      if (body.json !== undefined && typeof body.json !== 'boolean') {
        throw badRequest('status json must be a boolean');
      }
      return body.json === true ? ['--json'] : [];
    },
  },
  microskills: { args: () => [] },
  toolprune: {
    args: (body) => {
      const action = body.action || 'show';
      if (!['show', 'measure', 'apply', 'restore', 'refresh-catalog', 'apply-pending'].includes(action)) {
        throw badRequest('Invalid toolprune action');
      }
      return action === 'show' ? [] : [action];
    },
  },
  config: {
    args: (body) => {
      const operation = body.operation || 'show';
      if (operation === 'show') return [];
      if (operation === 'set') {
        if (!validKey(body.key) || typeof body.value !== 'string' ||
            body.value.length > 256 || body.value.includes(String.fromCharCode(0))) {
          throw badRequest('config set requires a valid key and a string value of at most 256 characters');
        }
        return ['set', body.key + '=' + body.value];
      }
      if (operation === 'unset') {
        if (!validKey(body.key)) throw badRequest('config unset requires a valid key');
        return ['unset', body.key];
      }
      throw badRequest('Invalid config operation');
    },
  },
  repomap: {
    args: (body) => {
      const action = body.action || 'show';
      if (!['show', 'refresh'].includes(action)) throw badRequest('Invalid repomap action');
      return action === 'show' ? [] : ['refresh'];
    },
  },
  // Migration and merge move persistent repository state; keep this HTTP route read-only.
  repos: {
    args: (body) => {
      const operation = body.operation || 'list';
      if (operation !== 'list') throw badRequest('Only read-only repos list is exposed');
      return [];
    },
  },
  doctor: { args: () => [] },
};

for (const [route, definition] of Object.entries(COMMANDS)) {
  app.post('/' + route, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
      const args = definition.args(body);
      const result = await runTeCommand([route, ...args]);
      res.json(result);
    } catch (err) {
      if (err?.status === 400) {
        return res.status(400).json({ error: err.message });
      }
      console.error('TokenEconomizer command failed', route, err?.error || err?.message || 'unknown error');
      res.status(err?.status || 500).json({ error: 'TokenEconomizer command failed' });
    }
  });
}

// Unknown routes never forward caller-controlled command arguments.
app.get('/*', (req, res) => {
  res.status(404).json({ error: 'Not found', commands: Object.keys(COMMANDS) });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TokenEconomizer HTTP wrapper listening on port ${PORT}`);
  console.log(`Serving ${Object.keys(COMMANDS).length} fixed commands: ${Object.keys(COMMANDS).join(', ')}`);
});

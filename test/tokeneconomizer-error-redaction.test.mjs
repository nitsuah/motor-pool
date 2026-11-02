import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TOKEN_ECONOMIZER_DISABLE_LISTEN = '1';
const { createApp } = await import('../tools/tokeneconomizer/server.js');

describe('TokenEconomizer HTTP mutation boundary', () => {
  let server;
  let baseUrl;
  let commandRunner;
  let logError;

  beforeEach(async () => {
    commandRunner = vi.fn(async (args) => ({
      success: true,
      command: args[0],
      output: 'ok',
    }));
    logError = vi.fn();
    server = createApp({ commandRunner, logError }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (!server) return;
    const active = server;
    server = null;
    await new Promise((resolve, reject) => {
      active.close((error) => (error ? reject(error) : resolve()));
      active.closeAllConnections?.();
    });
  });

  async function post(path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('rejects mutating toolprune actions before invoking the CLI runner', async () => {
    for (const action of ['apply', 'apply-pending', 'restore', 'refresh-catalog']) {
      const response = await post('/toolprune', { action });
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: 'Mutating toolprune actions are disabled over HTTP',
      });
    }
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('returns a fixed config-set success response without echoing output or value', async () => {
    const sentinel = 'redaction-sentinel';
    commandRunner.mockResolvedValue({
      success: true,
      command: 'config',
      output: `set completed: ${sentinel}`,
    });

    const response = await post('/config', {
      operation: 'set',
      key: 'api_token',
      value: sentinel,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      command: 'config',
      message: 'Configuration updated',
    });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(commandRunner).toHaveBeenCalledWith(['config', 'set', `api_token=${sentinel}`]);
  });

  it('returns a fixed config-unset success response without echoing CLI output', async () => {
    const sentinel = 'redaction-sentinel';
    commandRunner.mockResolvedValue({
      success: true,
      command: 'config',
      output: `unset completed: ${sentinel}`,
    });

    const response = await post('/config', {
      operation: 'unset',
      key: 'api_token',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      command: 'config',
      message: 'Configuration updated',
    });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
  });

  it('redacts config-set failure output and never logs submitted values', async () => {
    const sentinel = 'redaction-sentinel';
    commandRunner.mockRejectedValue({
      status: 500,
      error: `CLI failed while handling ${sentinel}`,
      output: sentinel,
      details: sentinel,
    });

    const response = await post('/config', {
      operation: 'set',
      key: 'api_token',
      value: sentinel,
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'TokenEconomizer command failed' });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(sentinel);
  });
});

import { createAgentHelpers, DEVELOPER_TOOLS } from './modules/agent-tools.js';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync, lstatSync, stat } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

const execAsync = promisify(exec);
const WORKSPACE = realpathSync(mkdtempSync(join(tmpdir(), 'ab-agent-')));
writeFileSync(join(WORKSPACE, 'hello.txt'), 'file contents\n');

console.log('WORKSPACE:', WORKSPACE);
console.log('File exists:', readFileSync(join(WORKSPACE, 'hello.txt'), 'utf8'));

// Test resolveWorkspacePath directly
const helpers = createAgentHelpers({
  WORKSPACE_ROOT: WORKSPACE, execAsync, TOOL_SERVERS: {}, TOOL_CALL_TIMEOUT_MS: 5000,
});

// Access the internal function via callAgentTool
const session = { model: 'test-model', id: 'sess_1', experience: 'developer', workspaceRoot: WORKSPACE };

// Let's trace what happens in read_file
const result = await helpers.runAgentLoop([{ role: 'user', content: 'read hello.txt' }], 'ollama', 'http://localhost:11434', {}, DEVELOPER_TOOLS, session);
console.log('result:', result);
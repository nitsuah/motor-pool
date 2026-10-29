import axios from 'axios';
import { randomUUID } from 'crypto';
import { stat, readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { lstatSync, realpathSync } from 'fs';
import { resolve as resolvePath, dirname } from 'path';
import { mcpRequest } from './mcp-helpers.js';

export const DEVELOPER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command inside WORKSPACE_ROOT. Returns stdout and stderr. Use for file ops, git, npm, node, etc.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to run.' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file in the workspace and return its text content.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path inside workspace.' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the workspace. For documents, reports, summaries, research notes, and other output artifacts, use the artifacts/ subdirectory (e.g. artifacts/report.md). Source code and configuration go in their natural project locations.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path inside workspace. Use artifacts/ prefix for output documents and reports.' },
          content: { type: 'string', description: 'Content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories at a path inside the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path (default: workspace root).', default: '' } } },
    },
  },
];

export const RESEARCH_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web via DuckDuckGo Instant Answers. Returns abstract, related topics, and direct answer if available.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query.' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_artifact',
      description: 'Save a research artifact (notes, outline, summary) to workspace/artifacts/.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Artifact filename (e.g. "report.md").' },
          content: { type: 'string', description: 'Artifact text content.' },
        },
        required: ['filename', 'content'],
      },
    },
  },
];

export const WEBSITE_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'discover_leads',
      description: 'Find local businesses in a location that may need a website.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City/area to search (e.g. "Austin TX").' },
          business_type: { type: 'string', description: 'Category of business (e.g. "restaurant").' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_website_file',
      description: 'Save a generated HTML/CSS/JS file for a client site under their slug.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Client slug (e.g. "joes-pizza-90210").' },
          filename: { type: 'string', description: 'File to save (e.g. "index.html").' },
          content: { type: 'string', description: 'File content.' },
        },
        required: ['slug', 'filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_website_files',
      description: 'List saved files for a client site slug.',
      parameters: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'Client slug.' } },
        required: ['slug'],
      },
    },
  },
];

const BASH_BLOCKLIST = ['rm -rf /', 'dd if=', ':(){ :|:& };:', '> /dev/sd', 'mkfs'];

// Model-supplied shell commands must not inherit the dashboard's environment,
// which carries every secret from .env (API keys, POSTGRES_PASSWORD, DB URL…) —
// `env` or `echo $X` would otherwise read them (CWE-200). Pass only what a
// shell, git and node need.
const AGENT_SHELL_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
export function agentShellEnv(source = process.env) {
  const env = {};
  for (const key of AGENT_SHELL_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

// Plugin tools are exposed to the model as `<plugin>__<tool>` (double underscore)
// since OpenAI/Ollama function-call names reject the `.` used in the qualifiedName
// shown over the /api/plugins HTTP API. [a-zA-Z0-9_-] alone would let a name legally
// contain "__", making the join non-injective (plugin "a__b" + tool "c" and plugin
// "a" + tool "b__c" both encode to "a__b__c"); plugin-loader.js's manifest
// validation additionally rejects "__" inside either half specifically to keep this
// encoding collision-free, so resolvePluginTool's equality lookup below is safe.
const PLUGIN_TOOL_SEPARATOR = '__';
const PLUGIN_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
// Mirrors dashboard/routes/plugins.js's MAX_INVOKE_BODY_BYTES — the HTTP
// /plugins/:name/tools/:tool/invoke route rejects arguments over 256 KB, but
// this agent-loop dispatch path forwards a model-supplied `args` object
// straight to axios (8 MB body limit) with no such check, so a model could
// send an oversized payload this path was never meant to allow (CWE-400).
const PLUGIN_ARGS_MAX_BYTES = 256 * 1024;

export function createAgentHelpers({ WORKSPACE_ROOT, execAsync, TOOL_SERVERS, TOOL_CALL_TIMEOUT_MS, pluginRegistry = null }) {
  function resolveWorkspacePath(reqPath) {
    if (!WORKSPACE_ROOT) return null;
    const safe = reqPath ? reqPath.replace(/\\/g, '/').replace(/^\/+/, '') : '';
    const abs = resolvePath(WORKSPACE_ROOT, safe);
    if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + '/')) return null;
    return isInsideWorkspaceReal(abs) ? abs : null;
  }

  /**
   * The string check above cannot see symbolic links. Resolve the real location of the deepest existing
   * path component (a dangling link counts as escaping) and require it to stay under the real workspace root.
   */
  function isInsideWorkspaceReal(abs) {
    try {
      const rootReal = realpathSync(WORKSPACE_ROOT);
      let probe = abs;
      for (;;) {
        try {
          lstatSync(probe);
          break;
        } catch (err) {
          if (err.code !== 'ENOENT') return false;
          const parent = dirname(probe);
          if (parent === probe) return false;
          probe = parent;
        }
      }
      const real = realpathSync(probe); // throws for a dangling symlink
      return real === rootReal || real.startsWith(rootReal + '/');
    } catch {
      return false;
    }
  }

  /** Enabled plugin tools, shaped as OpenAI/Ollama function-call definitions. */
  function pluginToolDefinitions() {
    if (!pluginRegistry) return [];
    return pluginRegistry.listTools().map(t => ({
      type: 'function',
      function: {
        name: `${t.plugin}${PLUGIN_TOOL_SEPARATOR}${t.name}`,
        description: `[Plugin: ${t.plugin}] ${t.description || ''}`.slice(0, 1024),
        parameters: (t.parameters && typeof t.parameters === 'object' && Object.keys(t.parameters).length)
          ? t.parameters
          : { type: 'object', properties: {} },
      },
    }));
  }

  /** Resolve a `<plugin>__<tool>` function-call name back to its registry entry. */
  function resolvePluginTool(toolName) {
    if (!pluginRegistry || !toolName.includes(PLUGIN_TOOL_SEPARATOR)) return null;
    return pluginRegistry.listTools().find(t => `${t.plugin}${PLUGIN_TOOL_SEPARATOR}${t.name}` === toolName) || null;
  }

  async function callPluginTool(pluginName, toolName, args) {
    const plugin = pluginRegistry?.get(pluginName);
    if (!plugin || !plugin.enabled) return JSON.stringify({ error: `Plugin unavailable: ${pluginName}` });
    const tool = pluginRegistry.getTool(pluginName, toolName);
    if (!tool) return JSON.stringify({ error: `Unknown tool "${toolName}" on plugin "${pluginName}"` });
    const serializedArgs = JSON.stringify(args ?? {});
    if (Buffer.byteLength(serializedArgs, 'utf8') > PLUGIN_ARGS_MAX_BYTES) {
      return JSON.stringify({ error: 'Tool arguments exceed 256 KB' });
    }
    try {
      const isBodyless = tool.method === 'GET' || tool.method === 'DELETE';
      const response = await axios({
        method: tool.method,
        url: tool.endpoint,
        timeout: tool.timeoutMs,
        maxRedirects: 0,
        maxContentLength: PLUGIN_RESPONSE_MAX_BYTES,
        maxBodyLength: PLUGIN_RESPONSE_MAX_BYTES,
        validateStatus: () => true,
        ...(isBodyless ? { params: args } : { data: args }),
      });
      const ok = response.status >= 200 && response.status < 300;
      return JSON.stringify({
        success: ok,
        status: response.status,
        result: response.data,
        error: ok ? undefined : `Plugin backend returned ${response.status}`,
      });
    } catch (err) {
      return JSON.stringify({ error: `Plugin backend unreachable: ${err.message}` });
    }
  }

  // Plugin tools layer onto every tool-using experience (developer/research/website).
  // 'default' (plain chat / Safe Chat) intentionally gets no tools at all, plugin or
  // otherwise, so enabling a plugin never changes chat/safety behavior there.
  function getExperienceTools(experience) {
    const TOOL_USING_EXPERIENCES = new Set(['developer', 'research', 'website']);
    const base = (() => {
      switch (experience) {
        case 'developer': return WORKSPACE_ROOT ? DEVELOPER_TOOLS : [];
        case 'research': return RESEARCH_TOOLS;
        case 'website': return WEBSITE_AGENT_TOOLS;
        default: return [];
      }
    })();
    if (!TOOL_USING_EXPERIENCES.has(experience)) return base;
    const plugins = pluginToolDefinitions();
    return plugins.length ? [...base, ...plugins] : base;
  }

  async function callAgentTool(toolName, toolArgs, session) {
    try {
      if (toolName === 'bash') {
        if (!WORKSPACE_ROOT) return JSON.stringify({ error: 'Workspace not mounted (WORKSPACE_ROOT not set)' });
        const { command } = toolArgs;
        if (BASH_BLOCKLIST.some(p => String(command).includes(p))) {
          return JSON.stringify({ error: 'Command blocked by safety policy' });
        }
        try {
          const { stdout, stderr } = await execAsync(String(command), { cwd: WORKSPACE_ROOT, timeout: 30000, shell: true, env: agentShellEnv() });
          return JSON.stringify({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
        } catch (err) {
          return JSON.stringify({ stdout: (err.stdout || '').trim(), stderr: (err.stderr || err.message).trim(), exitCode: err.code || 1 });
        }
      }

      if (toolName === 'read_file') {
        if (!WORKSPACE_ROOT) return JSON.stringify({ error: 'Workspace not mounted' });
        const abs = resolveWorkspacePath(toolArgs.path);
        if (!abs) return JSON.stringify({ error: 'Invalid path (path traversal detected)' });
        try {
          const s = await stat(abs);
          if (s.size > 512 * 1024) return JSON.stringify({ error: 'File too large (> 512 KB)' });
          const content = await readFile(abs, 'utf8');
          return JSON.stringify({ content, path: toolArgs.path });
        } catch (err) {
          return JSON.stringify({ error: err.message });
        }
      }

      if (toolName === 'write_file') {
        if (!WORKSPACE_ROOT) return JSON.stringify({ error: 'Workspace not mounted' });
        const abs = resolveWorkspacePath(toolArgs.path);
        if (!abs) return JSON.stringify({ error: 'Invalid path' });
        try {
          await mkdir(resolvePath(abs, '..'), { recursive: true });
          await writeFile(abs, String(toolArgs.content), 'utf8');
          return JSON.stringify({ success: true, path: toolArgs.path, bytes: Buffer.byteLength(String(toolArgs.content), 'utf8') });
        } catch (err) {
          return JSON.stringify({ error: err.message });
        }
      }

      if (toolName === 'list_files') {
        if (!WORKSPACE_ROOT) return JSON.stringify({ error: 'Workspace not mounted' });
        const abs = resolveWorkspacePath(toolArgs.path || '');
        if (!abs) return JSON.stringify({ error: 'Invalid path' });
        try {
          const entries = await readdir(abs, { withFileTypes: true });
          return JSON.stringify({ entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) });
        } catch (err) {
          return JSON.stringify({ error: err.message });
        }
      }

      if (toolName === 'web_search') {
        const query = String(toolArgs.query || '').slice(0, 200);
        const resp = await axios.get(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
          { timeout: 8000 }
        );
        const d = resp.data;
        return JSON.stringify({
          answer: d.Answer || '',
          abstract: d.AbstractText || '',
          abstractSource: d.AbstractSource || '',
          abstractUrl: d.AbstractURL || '',
          relatedTopics: (d.RelatedTopics || []).slice(0, 6).map(t => ({ text: t.Text, url: t.FirstURL })).filter(t => t.text),
        });
      }

      if (toolName === 'write_artifact') {
        if (!WORKSPACE_ROOT) return JSON.stringify({ error: 'Workspace not mounted' });
        const filename = String(toolArgs.filename || 'artifact.md').replace(/[/\\]/g, '-');
        const abs = resolvePath(WORKSPACE_ROOT, 'artifacts', filename);
        if (!abs.startsWith(WORKSPACE_ROOT)) return JSON.stringify({ error: 'Invalid filename' });
        try {
          await mkdir(resolvePath(abs, '..'), { recursive: true });
          await writeFile(abs, String(toolArgs.content), 'utf8');
          return JSON.stringify({ success: true, path: `artifacts/${filename}` });
        } catch (err) {
          return JSON.stringify({ error: err.message });
        }
      }

      if (toolName === 'save_website_file') {
        const result = await mcpRequest(TOOL_SERVERS.website.url, 'tools/call', {
          name: 'save_file',
          arguments: { slug: toolArgs.slug, filename: toolArgs.filename, content: toolArgs.content },
        }, TOOL_CALL_TIMEOUT_MS);
        const text = (result?.content || []).filter(i => i?.type === 'text').map(i => i.text).join('\n');
        return JSON.stringify({ success: true, content: text || 'File saved.' });
      }

      if (toolName === 'list_website_files') {
        const result = await mcpRequest(TOOL_SERVERS.website.url, 'tools/call', {
          name: 'list_client_files',
          arguments: { slug: toolArgs.slug },
        }, TOOL_CALL_TIMEOUT_MS);
        const text = (result?.content || []).filter(i => i?.type === 'text').map(i => i.text).join('\n');
        return JSON.stringify({ files: text });
      }

      if (toolName === 'discover_leads') {
        const result = await mcpRequest(TOOL_SERVERS.website.url, 'tools/call', {
          name: 'discover_leads',
          arguments: { location: toolArgs.location, business_type: toolArgs.business_type },
        }, TOOL_CALL_TIMEOUT_MS);
        const text = (result?.content || []).filter(i => i?.type === 'text').map(i => i.text).join('\n');
        return JSON.stringify({ leads: text });
      }

      const pluginTool = resolvePluginTool(toolName);
      if (pluginTool) {
        return await callPluginTool(pluginTool.plugin, pluginTool.name, toolArgs);
      }

      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  const TOOL_RESULT_MAX_CHARS = 8000;
  const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

  function capToolResult(result) {
    if (result.length <= TOOL_RESULT_MAX_CHARS) return result;
    const truncated = result.slice(0, TOOL_RESULT_MAX_CHARS);
    try {
      const parsed = JSON.parse(result);
      const capped = { ...parsed, _truncated: true, _originalLength: result.length };
      if (parsed.stdout) capped.stdout = parsed.stdout.slice(0, TOOL_RESULT_MAX_CHARS - 200) + '\n[truncated]';
      if (parsed.content) capped.content = parsed.content.slice(0, TOOL_RESULT_MAX_CHARS - 200) + '\n[truncated]';
      const out = JSON.stringify(capped);
      return out.length <= TOOL_RESULT_MAX_CHARS ? out : out.slice(0, TOOL_RESULT_MAX_CHARS) + '\n[truncated]';
    } catch {
      return truncated + '\n[truncated]';
    }
  }

  // Small local models (e.g. llama3.2:3b via Ollama) sometimes write a tool
  // call as plain JSON text instead of a structured tool_calls entry. Treat
  // the reply as a call only when the whole reply is one JSON object naming a
  // tool that was actually offered; anything else stays ordinary text.
  function parseTextToolCall(content, allowedToolNames) {
    const text = String(content || '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) return null;
    let obj;
    try { obj = JSON.parse(text); } catch { return null; }
    const name = obj?.name;
    const args = obj?.parameters ?? obj?.arguments ?? {};
    if (typeof name !== 'string' || !allowedToolNames.has(name)) return null;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    return { id: `call_${randomUUID()}`, type: 'function', function: { name, arguments: args } };
  }

  // Assistant tool_calls as they must appear in the conversation history:
  // OpenAI Chat Completions requires id, type and JSON-string arguments (and the
  // tool result's tool_call_id must match that id); Ollama takes object arguments.
  function toHistoryToolCall(tc, apiStyle) {
    const name = tc.function?.name || tc.name;
    const args = tc.function?.arguments ?? tc.arguments ?? {};
    if (apiStyle === 'openai') {
      return { id: tc.id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
    }
    return { ...tc, function: { ...(tc.function || {}), name, arguments: args } };
  }

  async function streamAgentReply(msgs, apiStyle, llmUrl, llmHeaders, session, tools, options) {
    const { signal, onToken, onReset } = options;
    const reqBody = { model: session.model, messages: msgs, stream: true };
    if (tools.length > 0) reqBody.tools = tools;
    const endpoint = apiStyle === 'openai' ? `${llmUrl}/chat/completions` : `${llmUrl}/api/chat`;
    const response = await axios.post(endpoint, reqBody, {
      headers: llmHeaders, responseType: 'stream', timeout: 120000, signal,
    });

    return new Promise((resolve, reject) => {
      const stream = response.data;
      let settled = false;
      let lineBuffer = '';
      let content = '';
      let pendingPrefix = '';
      let shouldStreamContent = false;
      let sawToolCall = false;
      let openAiToolCalls = new Map();
      const ollamaToolCalls = [];

      let stallTimer = null;
      const resetStallTimer = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stream.destroy(new Error('LLM stream stalled — no data for 30s')), 30_000);
      };
      const cleanUp = () => {
        clearTimeout(stallTimer);
        signal?.removeEventListener('abort', abortStream);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanUp();
        error ? reject(error) : resolve({
          message: { content, tool_calls: [...ollamaToolCalls, ...openAiToolCalls.values()] },
        });
      };
      const abortStream = () => stream.destroy(signal.reason || new Error('Agent stream aborted'));
      if (signal?.aborted) abortStream();
      else signal?.addEventListener('abort', abortStream, { once: true });

      const emitContent = (token) => {
        if (!token) return;
        content += token;
        if (sawToolCall || !onToken) return;
        if (shouldStreamContent) {
          onToken(token);
          return;
        }
        // A text-encoded tool call is valid only when the entire response is a
        // JSON object. Hold a leading `{` until we can distinguish it from a
        // normal prose answer, so tool arguments are never shown as chat text.
        pendingPrefix += token;
        const first = pendingPrefix.trimStart()[0];
        if (!first) return;
        if (first === '{') return;
        shouldStreamContent = true;
        onToken(pendingPrefix);
        pendingPrefix = '';
      };

      const markToolCalls = () => {
        if (sawToolCall) return;
        sawToolCall = true;
        pendingPrefix = '';
        if (content && onReset) onReset();
      };

      const consumeLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const payloadText = trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : trimmed;
        if (payloadText === '[DONE]') return;
        let payload;
        try { payload = JSON.parse(payloadText); } catch { return; }

        if (apiStyle === 'openai') {
          const choice = payload.choices?.[0];
          const delta = choice?.delta || {};
          emitContent(delta.content || '');
          for (const call of delta.tool_calls || []) {
            markToolCalls();
            const current = openAiToolCalls.get(call.index) || {
              id: call.id || '', type: 'function', function: { name: '', arguments: '' },
            };
            if (call.id) current.id = call.id;
            if (call.function?.name) current.function.name += call.function.name;
            if (typeof call.function?.arguments === 'string') current.function.arguments += call.function.arguments;
            openAiToolCalls.set(call.index, current);
          }
          return;
        }

        const message = payload.message || {};
        emitContent(message.content || '');
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
          markToolCalls();
          ollamaToolCalls.push(...message.tool_calls);
        }
      };

      stream.on('data', chunk => {
        resetStallTimer();
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        lines.forEach(consumeLine);
      });
      stream.on('end', () => {
        if (lineBuffer) consumeLine(lineBuffer);
        if (!sawToolCall && pendingPrefix) onToken?.(pendingPrefix);
        finish();
      });
      stream.on('error', finish);
      stream.on('close', () => {
        if (!stream.readableEnded) finish(new Error('LLM stream closed before completion'));
      });
      resetStallTimer();
    });
  }

  async function runAgentLoop(msgs, apiStyle, llmUrl, llmHeaders, tools, session, options = {}) {
    const MAX_ITERATIONS = 5;
    const toolLog = [];
    const localMsgs = [...msgs];
    let consecutiveErrors = 0;
    // The model is only ever offered this experience's active tool set (empty
    // for Safe Chat / plain-chat experiences, which never set reqBody.tools
    // below), but a tool_calls entry it returns anyway must not be dispatched
    // — an upstream/prompt-injected model claiming a tool name outside what
    // was actually offered would otherwise still reach callAgentTool, which
    // has no notion of "active experience" and will happily execute anything
    // it recognizes by name (CWE-862).
    const allowedToolNames = new Set(
      tools.map(t => t.function?.name || t.name).filter(Boolean),
    );

    const requestReply = async (requestMessages, requestTools = tools) => {
      if (options.stream) {
        return streamAgentReply(requestMessages, apiStyle, llmUrl, llmHeaders, session, requestTools, options);
      }
      const reqBody = { model: session.model, messages: requestMessages, stream: false };
      if (requestTools.length > 0) reqBody.tools = requestTools;
      const endpoint = apiStyle === 'openai' ? `${llmUrl}/chat/completions` : `${llmUrl}/api/chat`;
      const response = await axios.post(endpoint, reqBody, { headers: llmHeaders, timeout: 120000 });
      return response.data;
    };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (options.signal?.aborted) throw options.signal.reason || new Error('Agent stream aborted');
      const response = await requestReply(localMsgs);
      const msg = response.message || response.choices?.[0]?.message;
      let toolCalls = msg?.tool_calls || [];
      if (toolCalls.length === 0) {
        const textCall = parseTextToolCall(msg?.content, allowedToolNames);
        if (textCall) {
          toolCalls = [textCall];
          options.onReset?.();
        }
      }

      if (toolCalls.length === 0) {
        return { content: msg?.content || 'No response received', toolLog };
      }

      // Every call gets a stable id up front so the assistant entry and its tool
      // result reference the same one (Ollama calls often arrive without ids).
      toolCalls = toolCalls.map(tc => (tc.id ? tc : { ...tc, id: `call_${randomUUID()}` }));
      localMsgs.push({
        role: 'assistant',
        // A text-encoded call's JSON is the call itself, not prose to echo back.
        content: msg?.tool_calls?.length ? (msg.content || '') : '',
        tool_calls: toolCalls.map(tc => toHistoryToolCall(tc, apiStyle)),
      });

      for (const tc of toolCalls) {
        if (options.signal?.aborted) throw options.signal.reason || new Error('Agent stream aborted');
        const name = tc.function?.name || tc.name;
        const rawArgs = tc.function?.arguments || tc.arguments || '{}';
        const callId = tc.id;
        // A model can emit unparseable arguments; report it back as a tool
        // error (so the model can retry) instead of failing the whole turn.
        let args = rawArgs;
        let argsError = null;
        if (typeof rawArgs === 'string') {
          try { args = JSON.parse(rawArgs); } catch { args = {}; argsError = `Tool "${name}" arguments were not valid JSON`; }
        }

        const rawResult = argsError
          ? JSON.stringify({ error: argsError })
          : allowedToolNames.has(name)
            ? await callAgentTool(name, args, session)
            : JSON.stringify({ error: `Tool "${name}" is not in the active tool list for this experience` });
        const result = capToolResult(rawResult);

        let parsed;
        try { parsed = JSON.parse(result); } catch { parsed = { raw: result }; }

        if (parsed?.error) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
            toolLog.push({ name, args, result: parsed, callId, aborted: true });
            return { content: `Tool loop aborted after ${consecutiveErrors} consecutive errors. Last error: ${parsed.error}`, toolLog };
          }
        } else {
          consecutiveErrors = 0;
        }

        toolLog.push({ name, args, result: parsed, callId });
        options.onToolCall?.({ name, args, result: parsed, callId });

        if (apiStyle === 'openai') {
          localMsgs.push({ role: 'tool', tool_call_id: callId, content: result });
        } else {
          localMsgs.push({ role: 'tool', content: result });
        }
      }
    }

    if (options.signal?.aborted) throw options.signal.reason || new Error('Agent stream aborted');
    const response = await requestReply(localMsgs, []);
    const msg = response.message || response.choices?.[0]?.message;
    return { content: msg?.content || 'No response received', toolLog };
  }

  return { getExperienceTools, runAgentLoop };
}

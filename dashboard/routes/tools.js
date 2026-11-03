import express from 'express';
import axios from 'axios';
import { mcpRequest } from '../modules/mcp-helpers.js';
import { ensureToolReady } from '../modules/tool-lifecycle.js';

export function createToolsRouter({ TOOL_SERVERS, DOCKER_CONTROL_ENABLED, serviceRegistry, runComposeAction, eventBus, logStructured, TOOL_CALL_TIMEOUT_MS, IN_DOCKER, repoRoot }) {
  const router = express.Router();

  function getHealthUrl(tool) {
    if (!IN_DOCKER) {
      // From host: use localhost with mapped ports
      const portMatch = tool.ports.match(/^(\d+):/);
      if (portMatch) {
        return `http://localhost:${portMatch[1]}/health`;
      }
    }
    // From inside container: use internal Docker URL
    return `${tool.url}/health`;
  }

  router.get('/tools', async (req, res) => {
    const tools = await Promise.all(
      Object.values(TOOL_SERVERS).map(async (tool) => {
        let running;
        let health = null;
        const healthUrl = getHealthUrl(tool);
        try {
          const probe = await axios.get(healthUrl, { timeout: 3000 });
          running = true;
          health = probe.data || null;
        } catch {
          running = false;
        }
        // Determine the URL the frontend should use for tool calls
        // From inside container, use internal Docker URL; from host, use localhost with mapped ports
        let hostUrl = tool.url;
        if (IN_DOCKER) {
          const portMatch = tool.ports.match(/^(\d+):/);
          if (portMatch) {
            hostUrl = `http://localhost:${portMatch[1]}`;
          }
        }
        return {
          key: tool.key,
          name: tool.name,
          description: tool.description,
          url: hostUrl,  // Use host-accessible URL for frontend
          serviceKey: tool.serviceKey,
          composeService: tool.composeService,
          ports: tool.ports,
          running,
          status: running ? 'healthy' : 'unavailable',
          health,
        };
      })
    );
    res.json({ success: true, dockerControlEnabled: DOCKER_CONTROL_ENABLED, tools });
  });

  // POST /api/tools/:toolKey/ensure — JIT spin-up: check health and auto-start if needed
  router.post('/tools/:toolKey/ensure', async (req, res) => {
    const tool = TOOL_SERVERS[req.params.toolKey];
    if (!tool) {
      return res.status(404).json({ success: false, error: `Unknown tool server: ${req.params.toolKey}` });
    }
    const result = await ensureToolReady(req.params.toolKey, TOOL_SERVERS, serviceRegistry, DOCKER_CONTROL_ENABLED, runComposeAction, logStructured);
    if (result.ready) {
      return res.json({ success: true, ready: true, alreadyRunning: result.alreadyRunning, started: result.started });
    }
    return res.status(503).json({ success: false, ready: false, error: result.error });
  });

  router.get('/tools/:toolKey/tools', async (req, res) => {
    const tool = TOOL_SERVERS[req.params.toolKey];
    if (!tool) {
      return res.status(404).json({ success: false, error: `Unknown tool server: ${req.params.toolKey}` });
    }
    try {
      const result = await mcpRequest(tool.url, 'tools/list');
      res.json({ success: true, tools: result?.tools || [] });
    } catch (error) {
      logStructured('error', 'tool_list_failed', { tool: tool.key, error: error.message });
      res.status(502).json({ success: false, error: `Tool server unreachable: ${error.message}` });
    }
  });

  router.post('/tools/:toolKey/call', async (req, res) => {
    const tool = TOOL_SERVERS[req.params.toolKey];
    if (!tool) {
      return res.status(404).json({ success: false, error: `Unknown tool server: ${req.params.toolKey}` });
    }

    const { name, arguments: toolArgs } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'Tool name is required' });
    }

    eventBus.emit('tool_call', { toolServer: tool.key, tool: name, experience: null, endpoint: null });

    try {
      const result = await mcpRequest(tool.url, 'tools/call', {
        name,
        arguments: toolArgs && typeof toolArgs === 'object' ? toolArgs : {},
      }, TOOL_CALL_TIMEOUT_MS);

      const textContent = (result?.content || [])
        .filter((item) => item?.type === 'text')
        .map((item) => item.text)
        .join('\n');

      eventBus.emit('tool_call_completed', { toolServer: tool.key, tool: name, experience: null, endpoint: null });
      res.json({ success: true, tool: name, isError: !!result?.isError, content: textContent, raw: result });
    } catch (error) {
      logStructured('error', 'tool_call_failed', { tool: tool.key, name, error: error.message });
      eventBus.emit('tool_call_failed', {
        toolServer: tool.key,
        tool: name,
        experience: null,
        endpoint: null,
        metadata: { error: error.message },
      });
      res.status(502).json({ success: false, error: `Tool call failed: ${error.message}` });
    }
  });

  return router;
}

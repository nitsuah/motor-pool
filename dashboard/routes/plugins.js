/**
 * Plugin API
 *
 * GET  /api/plugins                             — list loaded manifests (+ load errors)
 * GET  /api/plugins/tools                       — flat, namespaced tool list for agents
 * GET  /api/plugins/:name                       — single manifest
 * POST /api/plugins/reload                      — re-scan the plugins directory
 * POST /api/plugins/:name/tools/:tool/invoke    — call a declared tool over HTTP
 * POST /api/plugins/:name/events                — emit a declared event onto the event bus
 *
 * Plugins are declared in dashboard/config/plugins/*.plugin.json. See
 * modules/plugin-loader.js for the manifest shape and docs/API.md#plugins for the guide.
 */
import express from 'express';
import axios from 'axios';

const MAX_INVOKE_BODY_BYTES = 256 * 1024;
// Plugin backends are operator-declared but not necessarily trusted. Axios
// defaults both limits to unlimited, which lets a hostile or broken backend
// exhaust the dashboard's heap with an oversized (or decompression-bomb)
// response. Cap both explicitly.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Registry emit() failure codes → HTTP status. Disabled matches the invoke route's 409. */
const EMIT_ERROR_STATUS = {
  unknown_plugin: 404,
  plugin_disabled: 409,
  invalid_event_type: 400,
  event_not_declared: 400,
  event_bus_unavailable: 503,
};

export function createPluginsRouter({ pluginRegistry, logStructured = () => {} }) {
  const router = express.Router();

  function publicPlugin(p) {
    return {
      name: p.name,
      version: p.version,
      description: p.description,
      enabled: p.enabled,
      baseUrl: p.baseUrl,
      manifestVersion: p.manifestVersion,
      source: p.source,
      tools: p.tools.map(t => ({
        name: t.name, description: t.description, transport: t.transport,
        method: t.method, path: t.path, endpoint: t.endpoint,
        timeoutMs: t.timeoutMs, parameters: t.parameters,
      })),
      events: p.events,
      // headers are intentionally omitted: they contain credentials that must never be exposed
    };
  }

  router.get('/plugins', (req, res) => {
    const plugins = pluginRegistry.list().map(publicPlugin);
    res.json({
      success: true,
      plugins,
      count: plugins.length,
      enabledCount: plugins.filter(p => p.enabled).length,
      errors: pluginRegistry.errors(),
      pluginsDir: pluginRegistry.dir,
      loadedAt: pluginRegistry.loadedAt,
    });
  });

  // Declared before /plugins/:name so "tools" is not read as a plugin name.
  router.get('/plugins/tools', (req, res) => {
    const tools = pluginRegistry.listTools().map(t => ({
      plugin: t.plugin, qualifiedName: t.qualifiedName, name: t.name,
      description: t.description, method: t.method, endpoint: t.endpoint,
      parameters: t.parameters,
    }));
    res.json({ success: true, tools, count: tools.length });
  });

  router.post('/plugins/reload', (req, res) => {
    const state = pluginRegistry.reload();
    res.json({
      success: true,
      loaded: state.plugins.length,
      failed: state.errors.length,
      errors: state.errors,
      pluginsDir: state.dir,
      loadedAt: state.loadedAt,
    });
  });

  router.get('/plugins/:name', (req, res) => {
    const plugin = pluginRegistry.get(req.params.name);
    if (!plugin) {
      return res.status(404).json({ success: false, error: `Unknown plugin: ${req.params.name}` });
    }
    res.json({ success: true, plugin: publicPlugin(plugin) });
  });

  router.post('/plugins/:name/tools/:tool/invoke', async (req, res) => {
    const { name, tool: toolName } = req.params;
    const plugin = pluginRegistry.get(name);
    if (!plugin) {
      return res.status(404).json({ success: false, error: `Unknown plugin: ${name}` });
    }
    if (!plugin.enabled) {
      return res.status(409).json({ success: false, error: `Plugin is disabled: ${name}` });
    }
    const tool = pluginRegistry.getTool(name, toolName);
    if (!tool) {
      return res.status(404).json({ success: false, error: `Unknown tool "${toolName}" on plugin "${name}"` });
    }

    const args = req.body?.arguments ?? req.body ?? {};
    const serialized = JSON.stringify(args ?? {});
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INVOKE_BODY_BYTES) {
      return res.status(413).json({ success: false, error: 'Tool arguments exceed 256 KB' });
    }

    const started = Date.now();
    try {
      const isBodyless = tool.method === 'GET' || tool.method === 'DELETE';
      const response = await axios({
        method: tool.method,
        url: tool.endpoint,
        timeout: tool.timeoutMs,
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        validateStatus: () => true,
        headers: plugin.headers,
        ...(isBodyless ? { params: args } : { data: args }),
      });
      const durationMs = Date.now() - started;
      logStructured('info', 'plugin_tool_invoked', {
        plugin: name, tool: toolName, status: response.status, durationMs,
      });
      const ok = response.status >= 200 && response.status < 300;
      return res.status(ok ? 200 : 502).json({
        success: ok,
        plugin: name,
        tool: toolName,
        status: response.status,
        durationMs,
        result: response.data,
        error: ok ? undefined : `Plugin backend returned ${response.status}`,
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      logStructured('warn', 'plugin_tool_failed', {
        plugin: name, tool: toolName, error: err.message, durationMs,
      });
      return res.status(503).json({
        success: false,
        plugin: name,
        tool: toolName,
        durationMs,
        error: `Plugin backend unreachable: ${err.message}`,
      });
    }
  });

  router.post('/plugins/:name/events', (req, res) => {
    const { name } = req.params;
    const { event_type: eventType, metadata = {} } = req.body || {};
    if (!eventType || typeof eventType !== 'string') {
      return res.status(400).json({ success: false, error: 'event_type is required' });
    }
    const result = pluginRegistry.emit(name, eventType, metadata);
    if (!result.ok) {
      const status = EMIT_ERROR_STATUS[result.code] ?? 400;
      return res.status(status).json({ success: false, error: result.error, code: result.code });
    }
    logStructured('info', 'plugin_event_emitted', {
      plugin: name, event_type: eventType, channel: result.channel,
    });
    res.json({ success: true, plugin: name, channel: result.channel, event: result.event });
  });

  return router;
}

/**
 * BYOK runtime endpoint registry
 * POST   /api/config/endpoints        — add/update a named external endpoint
 * GET    /api/config/endpoints        — list all endpoints (keys masked)
 * DELETE /api/config/endpoints/:key   — remove a runtime-added endpoint
 *
 * Endpoints added here merge into LLM_CONFIG at runtime.
 * They are lost on server restart (user re-enters via UI).
 */
import express from 'express';
import { saveEndpoints } from '../modules/endpoint-store.js';
import { isBuiltinEndpointKey } from '../modules/llm-config.js';

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_API_STYLES = new Set(['openai', 'ollama', 'anthropic', 'gemini']);

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return 'Invalid URL'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'URL must use http or https';
  if (parsed.username || parsed.password) return 'URL must not contain embedded credentials';
  return null;
}

function persistCustomEndpoints(LLM_CONFIG) {
  const custom = Object.entries(LLM_CONFIG)
    .filter(([, cfg]) => cfg.backendType === 'custom')
    .map(([key, cfg]) => ({ key, url: cfg.url, name: cfg.name, apiStyle: cfg.apiStyle, defaultModel: cfg.defaultModel, apiKey: cfg.apiKey || '' }));
  saveEndpoints(custom);
}

export function createEndpointsRouter({ LLM_CONFIG, logStructured }) {
  const router = express.Router();

  router.get('/config/endpoints', (req, res) => {
    const list = Object.entries(LLM_CONFIG).map(([key, cfg]) => ({
      key,
      name: cfg.name || key,
      url: cfg.url,
      apiStyle: cfg.apiStyle || 'openai',
      defaultModel: cfg.defaultModel || '',
      hasApiKey: !!(cfg.apiKey),
      builtin: isBuiltinEndpointKey(key),
    }));
    res.json({ success: true, endpoints: list });
  });

  router.post('/config/endpoints', express.json(), (req, res) => {
    const { key, name, url, apiStyle, defaultModel, apiKey } = req.body || {};
    if (!key || !url) {
      return res.status(400).json({ success: false, error: 'key and url are required' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      return res.status(400).json({ success: false, error: 'key must be alphanumeric/underscore/dash only' });
    }
    if (RESERVED_KEYS.has(key) || isBuiltinEndpointKey(key)) {
      return res.status(400).json({ success: false, error: `"${key}" is a reserved or built-in key` });
    }
    const urlError = validateUrl(url);
    if (urlError) return res.status(400).json({ success: false, error: urlError });
    if (apiStyle && !VALID_API_STYLES.has(apiStyle)) {
      return res.status(400).json({ success: false, error: `apiStyle must be one of: ${[...VALID_API_STYLES].join(', ')}` });
    }
    LLM_CONFIG[key] = {
      url,
      name: name || key,
      backendType: 'custom',
      type: 'custom',
      apiStyle: apiStyle || 'openai',
      defaultModel: defaultModel || '',
      apiKey: apiKey || '',
    };
    logStructured('info', 'byok_endpoint_added', { key, apiStyle });
    persistCustomEndpoints(LLM_CONFIG);
    res.json({ success: true, endpoint: { key, name: LLM_CONFIG[key].name, url, apiStyle, defaultModel, hasApiKey: !!(apiKey) } });
  });

  // Proxy /v1/models (or /api/tags) for a registered endpoint — used by the UI
  // to fetch available combos/models from external providers like 9router.
  router.get('/proxy-models', async (req, res) => {
    const { endpoint } = req.query;
    const cfg = endpoint && LLM_CONFIG[endpoint];
    if (!cfg) return res.status(404).json({ success: false, error: 'Endpoint not found' });
    const baseUrl = cfg.url.replace(/\/$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    try {
      const target = cfg.apiStyle === 'ollama'
        ? `${baseUrl}/api/tags`
        : `${baseUrl}${baseUrl.includes('/v1') ? '' : '/v1'}/models`;
      const r = await fetch(target, { headers, signal: AbortSignal.timeout(4000) });
      if (!r.ok) return res.status(502).json({ success: false, error: `Upstream returned ${r.status}` });
      const data = await r.json();
      const models = cfg.apiStyle === 'ollama'
        ? (data?.models?.map(m => m.name) || [])
        : (data?.data?.map(m => m.id) || []);
      res.json({ success: true, models });
    } catch (e) {
      res.status(502).json({ success: false, error: e.message });
    }
  });

  router.delete('/config/endpoints/:key', (req, res) => {
    const { key } = req.params;
    if (isBuiltinEndpointKey(key)) {
      return res.status(400).json({ success: false, error: `"${key}" is a built-in endpoint and cannot be removed` });
    }
    if (!Object.hasOwn(LLM_CONFIG, key)) {
      return res.status(404).json({ success: false, error: `Endpoint "${key}" not found` });
    }
    delete LLM_CONFIG[key];
    logStructured('info', 'byok_endpoint_removed', { key });
    persistCustomEndpoints(LLM_CONFIG);
    res.json({ success: true, removed: key });
  });

  return router;
}

/**
 * Local endpoint discovery
 * GET /api/discover/endpoints
 *
 * Probes common LLM ports on localhost and host.docker.internal in parallel,
 * identifies OpenAI-compatible (/v1/models) and Ollama (/api/tags) endpoints,
 * and returns discovered services with detected API style and available models.
 *
 * Also returns WELL_KNOWN_PROVIDERS — cloud APIs (Anthropic, OpenAI, etc.) that
 * are always surfaced for BYOK configuration regardless of scan results.
 */
import express from 'express';

// Ports likely to host a local LLM, OpenAI-compatible proxy, or external tool
const DEFAULT_PORTS = [
  1234,   // LM Studio
  1337,   // Jan AI
  3100,   // bb-mcp
  3200,   // tool-content-gen
  3201,   // tool-website
  4891,   // LM Studio alternate
  5000,
  5001,
  7860,   // Gradio / text-gen-webui
  8000,
  8080,   // Ollama (Docker), generic
  8081,
  8082,
  8083,
  8084,
  8888,
  9000,
  11434,  // Ollama (native host)
  11435,
  11436,
  20128,  // 9router
  20200,
  20201,
];

const PROBE_TIMEOUT_MS = 1500;
const HOSTS = ['localhost', 'host.docker.internal'];

// Known port→name hints so discovered endpoints get a useful display name
const PORT_HINTS = {
  1234:  'LM Studio',
  1337:  'Jan AI',
  3100:  'bb-mcp',
  3200:  'tool-content-gen',
  3201:  'tool-website',
  4891:  'LM Studio',
  7860:  'text-gen-webui',
  11434: 'Ollama (host)',
  11435: 'Ollama (host alt)',
  20128: '9router',
};

/**
 * Cloud and well-known API providers. These are always returned so the user can
 * quickly add them via BYOK. requiresKey=true means they need an API key to work.
 */
const WELL_KNOWN_PROVIDERS = [
  {
    key:          'wk_anthropic',
    name:         'Anthropic (Claude)',
    url:          'https://api.anthropic.com',
    apiStyle:     'anthropic',
    requiresKey:  true,
    keyHint:      'ANTHROPIC_API_KEY',
    docsUrl:      'https://docs.anthropic.com/en/api',
    defaultModel: 'claude-sonnet-4-6',
  },
  {
    key:          'wk_openai',
    name:         'OpenAI',
    url:          'https://api.openai.com',
    apiStyle:     'openai',
    requiresKey:  true,
    keyHint:      'OPENAI_API_KEY',
    docsUrl:      'https://platform.openai.com/docs',
    defaultModel: 'gpt-4o',
  },
  {
    key:          'wk_gemini',
    name:         'Google Gemini',
    url:          'https://generativelanguage.googleapis.com',
    apiStyle:     'gemini',
    requiresKey:  true,
    keyHint:      'GEMINI_API_KEY',
    docsUrl:      'https://ai.google.dev/docs',
    defaultModel: 'gemini-2.5-flash',
  },
  {
    key:          'wk_groq',
    name:         'Groq',
    url:          'https://api.groq.com/openai',
    apiStyle:     'openai',
    requiresKey:  true,
    keyHint:      'GROQ_API_KEY',
    docsUrl:      'https://console.groq.com/docs',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    key:          'wk_mistral',
    name:         'Mistral AI',
    url:          'https://api.mistral.ai',
    apiStyle:     'openai',
    requiresKey:  true,
    keyHint:      'MISTRAL_API_KEY',
    docsUrl:      'https://docs.mistral.ai',
    defaultModel: 'mistral-large-latest',
  },
  {
    key:          'wk_together',
    name:         'Together AI',
    url:          'https://api.together.xyz',
    apiStyle:     'openai',
    requiresKey:  true,
    keyHint:      'TOGETHER_API_KEY',
    docsUrl:      'https://docs.together.ai',
    defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
  },
  {
    key:          'wk_perplexity',
    name:         'Perplexity',
    url:          'https://api.perplexity.ai',
    apiStyle:     'openai',
    requiresKey:  true,
    keyHint:      'PERPLEXITY_API_KEY',
    docsUrl:      'https://docs.perplexity.ai',
    defaultModel: 'llama-3.1-sonar-large-128k-online',
  },
];

async function probeEndpoint(host, port) {
  const baseUrl = `http://${host}:${port}`;

  // Try OpenAI-compatible first
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const models = data?.data?.map(m => m.id) || [];
      return { url: baseUrl, apiStyle: 'openai', models, requiresAuth: false };
    }
    // 401/403 means the port is alive but needs an API key
    if (res.status === 401 || res.status === 403) {
      return { url: baseUrl, apiStyle: 'openai', models: [], requiresAuth: true };
    }
  } catch { /* not openai */ }

  // Try Ollama
  try {
    const res2 = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res2.ok) {
      const data = await res2.json().catch(() => null);
      const models = data?.models?.map(m => m.name) || [];
      return { url: baseUrl, apiStyle: 'ollama', models, requiresAuth: false };
    }
    if (res2.status === 401 || res2.status === 403) {
      return { url: baseUrl, apiStyle: 'ollama', models: [], requiresAuth: true };
    }
  } catch { /* not ollama */ }

  // Generic health/root probe — detect any live service (may be a tool or proxy)
  for (const path of ['/health', '/']) {
    try {
      const res3 = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (res3.ok || res3.status === 401 || res3.status === 403) {
        return {
          url: baseUrl,
          apiStyle: 'unknown',
          models: [],
          requiresAuth: res3.status === 401 || res3.status === 403,
        };
      }
    } catch { /* not alive on this path */ }
  }

  return null;
}

export function createDiscoverRouter({ LLM_CONFIG, logStructured }) {
  const router = express.Router();

  router.get('/discover/endpoints', async (req, res) => {
    const customPorts = req.query.ports
      ? String(req.query.ports).split(',').map(Number).filter(p => p > 0 && p < 65536)
      : [];
    const ports = customPorts.length > 0 ? customPorts : DEFAULT_PORTS;
    const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
    const requestedHost = req.query.host ? String(req.query.host) : null;
    if (requestedHost && !ALLOWED_HOSTS.has(requestedHost)) {
      return res.status(400).json({ success: false, error: 'host must be a local address' });
    }
    const hosts = requestedHost ? [requestedHost] : HOSTS;

    // Build the set of URLs already registered so we can flag them
    const knownUrls = new Set(Object.values(LLM_CONFIG).map(c => c.url?.replace(/\/$/, '')));

    // Ports that are our own webserver (3000) or already registered as default builtins —
    // discovering ourselves serves no purpose
    const selfPorts = new Set([3000]);
    for (const cfg of Object.values(LLM_CONFIG)) {
      if (cfg.builtin) {
        try { selfPorts.add(new URL(cfg.url).port * 1 || 80); } catch { /* skip */ }
      }
    }

    const probes = [];
    for (const host of hosts) {
      for (const port of ports) {
        probes.push({ host, port });
      }
    }

    const results = await Promise.allSettled(
      probes.map(({ host, port }) =>
        probeEndpoint(host, port).then(result => result ? { host, port, ...result } : null)
      )
    );

    const discovered = [];
    const seen = new Set();

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { host, port, url, apiStyle, models, requiresAuth } = r.value;

      // Skip our own webserver port and built-in default ports
      if (selfPorts.has(port)) continue;

      // De-duplicate: same port on both hosts often resolves to same service
      const dedupeKey = `${port}:${apiStyle}`;
      if (seen.has(dedupeKey) && host !== 'localhost') continue;
      seen.add(dedupeKey);

      const hint = PORT_HINTS[port];
      const name = hint || (apiStyle === 'ollama' ? `Ollama on :${port}` : apiStyle === 'openai' ? `OpenAI-compatible on :${port}` : `Service on :${port}`);
      const key = `local_${port}`;

      // 9router uses model "MAX" as its default combo identifier
      const defaultModel = port === 20128 ? 'MAX' : (models[0] || '');
      discovered.push({
        key,
        name,
        url,
        apiStyle,
        models,
        defaultModel,
        requiresAuth,
        alreadyRegistered: knownUrls.has(url.replace(/\/$/, '')),
      });
    }

    // Annotate well-known providers with registration status
    const knownProviders = WELL_KNOWN_PROVIDERS.map(p => ({
      ...p,
      alreadyRegistered: knownUrls.has(p.url.replace(/\/$/, '')),
    }));

    logStructured('info', 'endpoint_discovery', {
      portsScanned: ports.length * hosts.length,
      found: discovered.length,
    });

    res.json({ success: true, discovered, knownProviders, scanned: ports.length * hosts.length });
  });

  return router;
}

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
 *
 * SSRF Protections:
 * - Only scans ports from ALLOWED_PORTS (no user-controlled port list)
 * - Only scans hosts from ALLOWED_HOSTS (no host.docker.internal by default)
 * - fetch() uses redirect: 'manual' to prevent redirect-following SSRF
 * - Response URLs validated against private IP ranges
 */
import express from 'express';

// Ports likely to host a local LLM, OpenAI-compatible proxy, or external tool
// This is an ALLOWLIST - user cannot override via query parameter
const ALLOWED_PORTS = new Set([
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
]);

const PROBE_TIMEOUT_MS = 1500;

// Only localhost is allowed by default. host.docker.internal is NOT in allowlist
// because it exposes host machine services to the container.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

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
 * Check if a URL's hostname resolves to a private/internal IP address.
 * Prevents redirect-following SSRF to metadata services, private networks, etc.
 */
function isPrivateHost(url) {
  try {
    const { hostname } = new URL(url);
    // Block private IPv4 ranges
    if (/^10\./.test(hostname) ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^169\.254\./.test(hostname) ||  // link-local / metadata
        /^127\./.test(hostname) ||       // loopback (redundant but safe)
        hostname === 'localhost' ||
        hostname === 'host.docker.internal') {
      return true;
    }
    // Block IPv6 loopback and link-local
    if (hostname === '::1' || hostname.startsWith('fe80:')) {
      return true;
    }
    // Block decimal IP notation (e.g., 16777343 = 127.0.0.1)
    if (/^\d+$/.test(hostname)) {
      const ip = parseInt(hostname, 10);
      if (ip >= 0 && ip <= 0xffffffff) {
        // Check if it maps to private range
        const a = (ip >>> 24) & 0xff;
        const b = (ip >>> 16) & 0xff;
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return true; // If we can't parse, treat as unsafe
  }
}

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
  {
    key:          'wk_9router',
    name:         '9router (host)',
    url:          process.env.NINEROUTER_URL || 'http://host.docker.internal:20128',
    apiStyle:     'openai',
    requiresKey:  true,
    keyHint:      'NINEROUTER_API_KEY',
    docsUrl:      'https://9router.com/docs',
    defaultModel: process.env.NINEROUTER_MODEL || 'MAX',
  },
];

async function probeEndpoint(host, port) {
  const authority = host.includes(':') ? `[${host}]` : host;
  const baseUrl = `http://${authority}:${port}`;

  // fetch with redirect: 'manual' to prevent redirect-following SSRF
  const fetchOpts = {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    redirect: 'manual'
  };

  // Try OpenAI-compatible first
  try {
    const res = await fetch(`${baseUrl}/v1/models`, fetchOpts);
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const models = data?.data?.map(m => m.id) || [];
      return { url: baseUrl, apiStyle: 'openai', models, requiresAuth: false };
    }
    // 401/403 means the port is alive but needs an API key
    if (res.status === 401 || res.status === 403) {
      return { url: baseUrl, apiStyle: 'openai', models: [], requiresAuth: true };
    }
    // Check for redirect to private address
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location && isPrivateHost(location)) {
        return null; // Blocked redirect to private address
      }
    }
  } catch { /* not openai */ }

  // Try Ollama
  try {
    const res2 = await fetch(`${baseUrl}/api/tags`, fetchOpts);
    if (res2.ok) {
      const data = await res2.json().catch(() => null);
      const models = data?.models?.map(m => m.name) || [];
      return { url: baseUrl, apiStyle: 'ollama', models, requiresAuth: false };
    }
    if (res2.status === 401 || res2.status === 403) {
      return { url: baseUrl, apiStyle: 'ollama', models: [], requiresAuth: true };
    }
    if (res2.status >= 300 && res2.status < 400) {
      const location = res2.headers.get('location');
      if (location && isPrivateHost(location)) {
        return null;
      }
    }
  } catch { /* not ollama */ }

  // Generic health/root probe — detect any live service (may be a tool or proxy)
  for (const path of ['/health', '/']) {
    try {
      const res3 = await fetch(`${baseUrl}${path}`, fetchOpts);
      if (res3.ok || res3.status === 401 || res3.status === 403) {
        return {
          url: baseUrl,
          apiStyle: 'unknown',
          models: [],
          requiresAuth: res3.status === 401 || res3.status === 403,
        };
      }
      if (res3.status >= 300 && res3.status < 400) {
        const location = res3.headers.get('location');
        if (location && isPrivateHost(location)) {
          return null;
        }
      }
    } catch { /* not alive on this path */ }
  }

  return null;
}

export function getKnownEndpointUrls(configs) {
  return new Set(
    Object.values(configs)
      .filter(config => !config.requiresKey || Boolean(config.apiKey))
      .map(config => config.url?.replace(/\/$/, ''))
      .filter(Boolean)
  );
}

// Bounded in-memory rate limiter (per IP, sliding window).
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per minute per IP
const RATE_LIMIT_MAX_CLIENTS = 4096;

export function createRateLimiter({
  windowMs = RATE_LIMIT_WINDOW_MS,
  maxRequests = RATE_LIMIT_MAX_REQUESTS,
  maxClients = RATE_LIMIT_MAX_CLIENTS,
} = {}) {
  const clients = new Map();
  let lastCleanup = 0;

  const pruneExpired = (windowStart) => {
    for (const [key, timestamps] of clients) {
      const recent = timestamps.filter(ts => ts > windowStart);
      if (recent.length) clients.set(key, recent);
      else clients.delete(key);
    }
  };

  return function checkRateLimit(ip, now = Date.now()) {
    const windowStart = now - windowMs;
    if (now - lastCleanup >= windowMs) {
      pruneExpired(windowStart);
      lastCleanup = now;
    }

    if (!clients.has(ip)) {
      if (clients.size >= maxClients) return false;
      clients.set(ip, []);
    }

    const requests = clients.get(ip).filter(ts => ts > windowStart);
    if (requests.length >= maxRequests) return false;
    requests.push(now);
    clients.set(ip, requests);
    return true;
  };
}

const checkRateLimit = createRateLimiter();

export function createDiscoverRouter({ LLM_CONFIG, logStructured }) {
  const router = express.Router();

  router.get('/discover/endpoints', async (req, res) => {
    // Rate limiting
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Try again in a minute.'
      });
    }

    // Validate host parameter if provided - must be in ALLOWED_HOSTS
    if (req.query.host) {
      const requestedHost = String(req.query.host);
      if (!ALLOWED_HOSTS.has(requestedHost)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid host. Only localhost addresses are allowed.'
        });
      }
    }

    // No user-controlled ports - only ALLOWED_PORTS
    const ports = Array.from(ALLOWED_PORTS);

    // No user-controlled host - only ALLOWED_HOSTS (localhost only by default)
    const hosts = Array.from(ALLOWED_HOSTS);

    // Build the set of URLs already registered so we can flag them
    const knownUrls = getKnownEndpointUrls(LLM_CONFIG);

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

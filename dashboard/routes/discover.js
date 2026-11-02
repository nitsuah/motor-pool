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
import rateLimit from 'express-rate-limit';

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
/**
 * Parse a canonical dotted IPv4 address into octets.
 */
function parseIPv4Address(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.some(octet => octet < 0 || octet > 255) ? null : octets;
}

function isPrivateIPv4Address(octets) {
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function expandIPv6Address(hostname) {
  let value = hostname.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = parseIPv4Address(value.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = value.slice(0, lastColon + 1) + high + ':' + low;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const segments = [...left, ...Array(missing).fill('0'), ...right];
  if (segments.length !== 8) return null;
  const words = segments.map(segment => parseInt(segment, 16));
  return words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff) ? null : words;
}

function isPrivateIPv6Address(words) {
  if (!words) return true;
  if (words.every(word => word === 0)) return true; // unspecified
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true; // loopback
  const first = words[0];
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7

  // IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::/96) forms.
  const mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  const compatible = words.slice(0, 6).every(word => word === 0);
  if (mapped || compatible) {
    const ipv4 = [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff];
    return isPrivateIPv4Address(ipv4);
  }
  return false;
}

/**
 * Classify a redirect Location without following it. Relative and same-origin
 * redirects are safe to continue probing; cross-origin private targets are
 * rejected. baseUrl is the endpoint we just probed.
 */
export function isPrivateHost(location, baseUrl) {
  let target;
  let base;
  try {
    target = new URL(location, baseUrl);
    base = new URL(baseUrl);
  } catch {
    return true;
  }
  if (target.origin === base.origin) return false;

  const hostname = target.hostname.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'host.docker.internal' || hostname === 'metadata.google.internal') {
    return true;
  }
  const ipv4 = parseIPv4Address(hostname);
  if (ipv4) return isPrivateIPv4Address(ipv4);
  if (/^\d+$/.test(hostname)) {
    const value = Number(hostname);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
      return isPrivateIPv4Address([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
    }
  }
  if (hostname.includes(':')) return isPrivateIPv6Address(expandIPv6Address(hostname));
  return false;
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
      if (location && isPrivateHost(location, baseUrl)) {
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
      if (location && isPrivateHost(location, baseUrl)) {
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
        if (location && isPrivateHost(location, baseUrl)) {
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

// Rate-limit the expensive endpoint-discovery scan only; routine dashboard API
// polling remains available for the local single-user UI.
const discoverLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Rate limit exceeded. Try again in a minute.' },
});

export function createDiscoverRouter({ LLM_CONFIG, logStructured }) {
  const router = express.Router();

  router.get('/discover/endpoints', discoverLimiter, async (req, res) => {
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

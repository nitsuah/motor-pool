/**
 * Plugin loader — declarative extension points for the motor-pool dashboard.
 *
 * Plugins are JSON manifests dropped into `dashboard/config/plugins/*.plugin.json`
 * (override the directory with AGENT_BOARD_PLUGINS_DIR). Each manifest declares
 * the tools the plugin provides and the events it emits. Nothing is executed at
 * load time — a manifest is pure data, so a malformed or hostile file can only
 * ever be rejected, never run.
 *
 * This mirrors the config/mcp-registry.json pattern: operators extend the
 * dashboard by adding a file, not by editing core server code.
 *
 * Manifest shape (v1):
 * {
 *   "manifestVersion": 1,
 *   "name": "example-echo",           // ^[a-z0-9][a-z0-9_-]{0,63}$ — unique
 *   "version": "1.0.0",               // semver
 *   "description": "…",
 *   "enabled": true,                  // default true
 *   "baseUrl": "http://host:3300",    // default host for tools (env-expandable)
 *   "tools": [
 *     {
 *       "name": "echo",               // ^[a-zA-Z0-9_-]{1,64}$ — unique per plugin
 *       "description": "…",
 *       "transport": "http",          // only "http" is supported today
 *       "method": "POST",             // GET|POST|PUT|PATCH|DELETE
 *       "path": "/echo",              // appended to url ?? baseUrl
 *       "url": "http://other:1234",   // optional per-tool host override
 *       "timeoutMs": 15000,           // optional, clamped to 1s..120s
 *       "parameters": { … }           // free-form JSON schema, passed to agents
 *     }
 *   ],
 *   "events": {
 *     "channel": "plugins",           // event-bus channel for emitted events
 *     "emits": ["example.echo.done"]  // allow-list of event types
 *   }
 * }
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_MANIFEST_VERSION = 1;

/**
 * Resolve the plugins directory at call time, not module-load time, so that
 * AGENT_BOARD_PLUGINS_DIR is honored regardless of import order (ESM hoists
 * static imports above any env setup in the importing module).
 */
export function resolvePluginsDir(env = process.env) {
  return env.AGENT_BOARD_PLUGINS_DIR || join(__dirname, '..', 'config', 'plugins');
}

/** Snapshot of the directory as of module load. Prefer resolvePluginsDir(). */
export const DEFAULT_PLUGINS_DIR = resolvePluginsDir();

const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const EVENT_TYPE_RE = /^[a-zA-Z0-9_\-.]{1,128}$/;
const CHANNEL_RE = /^[a-zA-Z0-9_\-.]{1,128}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SUPPORTED_TRANSPORTS = new Set(['http']);

const HEADER_KEY_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_HEADER_VALUE_LEN = 512;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CHANNEL = 'plugins';

/**
 * Expand ${VAR} / ${VAR:-default} in a single string.
 * Uses a presence check rather than truthiness, so a variable that is defined
 * but empty stays empty instead of silently falling back to the default.
 */
export function expandEnv(raw, env = process.env) {
  return raw.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, name, fallback = '') =>
    Object.prototype.hasOwnProperty.call(env, name) ? env[name] : fallback);
}

/**
 * Expand env vars across an already-parsed structure, string leaves only.
 *
 * Substitution deliberately happens *after* JSON.parse, never on the raw file
 * text: a variable whose value contains a quote, backslash, or newline would
 * otherwise corrupt the document or inject new manifest fields (e.g. a baseUrl
 * of `http://x", "enabled": false, "_x":"` silently flipping `enabled`).
 * Expanding leaves post-parse means a hostile value can only ever be a string.
 */
export function expandDeep(value, env = process.env) {
  if (typeof value === 'string') return expandEnv(value, env);
  if (Array.isArray(value)) return value.map(v => expandDeep(v, env));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v, env)]));
  }
  return value;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(Math.floor(n), MAX_TIMEOUT_MS));
}

/**
 * Validate + normalize a parsed manifest.
 * Returns { valid: true, plugin } or { valid: false, errors: string[] }.
 * Pure: no I/O, no side effects — directly unit-testable.
 */
export function validateManifest(manifest, { source = 'unknown' } = {}) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ['manifest must be a JSON object'] };
  }

  const manifestVersion = manifest.manifestVersion ?? PLUGIN_MANIFEST_VERSION;
  if (manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    errors.push(`unsupported manifestVersion ${manifestVersion} (expected ${PLUGIN_MANIFEST_VERSION})`);
  }

  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!PLUGIN_NAME_RE.test(name)) {
    errors.push(`invalid plugin name "${manifest.name}" (expected ${PLUGIN_NAME_RE})`);
  } else if (name.includes('__')) {
    // agent-tools.js encodes a model-facing tool call as `<plugin>__<tool>`
    // and decodes it by splitting on the first "__" — a name containing "__"
    // itself makes that encoding non-injective (e.g. plugin "a__b" + tool "c"
    // and plugin "a" + tool "b__c" both encode to "a__b__c"), so resolving a
    // call could silently dispatch to the wrong plugin's tool.
    errors.push(`plugin name "${name}" must not contain "__" (reserved as the tool-name separator)`);
  }

  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!SEMVER_RE.test(version)) {
    errors.push(`invalid version "${manifest.version}" (expected semver, e.g. 1.0.0)`);
  }

  const baseUrl = typeof manifest.baseUrl === 'string' ? manifest.baseUrl.trim().replace(/\/+$/, '') : '';
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    errors.push(`baseUrl must be http(s): "${baseUrl}"`);
  }

  const rawTools = manifest.tools;
  const tools = [];
  if (rawTools !== undefined && !Array.isArray(rawTools)) {
    errors.push('tools must be an array');
  } else {
    const seenToolNames = new Set();
    for (const [i, rawTool] of (rawTools || []).entries()) {
      if (!isPlainObject(rawTool)) { errors.push(`tools[${i}] must be an object`); continue; }

      const toolName = typeof rawTool.name === 'string' ? rawTool.name.trim() : '';
      if (!TOOL_NAME_RE.test(toolName)) { errors.push(`tools[${i}].name invalid: "${rawTool.name}"`); continue; }
      if (toolName.includes('__')) {
        // See the matching plugin-name check above — "__" is reserved as the
        // <plugin>__<tool> separator and must not appear inside either half.
        errors.push(`tools[${i}].name "${toolName}" must not contain "__" (reserved as the tool-name separator)`);
        continue;
      }
      if (seenToolNames.has(toolName)) { errors.push(`tools[${i}] duplicate tool name "${toolName}"`); continue; }
      seenToolNames.add(toolName);

      const transport = String(rawTool.transport || 'http').toLowerCase();
      if (!SUPPORTED_TRANSPORTS.has(transport)) {
        errors.push(`tools[${i}] "${toolName}" unsupported transport "${transport}"`);
        continue;
      }

      const method = String(rawTool.method || 'POST').toUpperCase();
      if (!HTTP_METHODS.has(method)) {
        errors.push(`tools[${i}] "${toolName}" unsupported method "${method}"`);
        continue;
      }

      const toolUrl = typeof rawTool.url === 'string' ? rawTool.url.trim().replace(/\/+$/, '') : '';
      if (toolUrl && !/^https?:\/\//i.test(toolUrl)) {
        errors.push(`tools[${i}] "${toolName}" url must be http(s)`);
        continue;
      }
      const host = toolUrl || baseUrl;
      if (!host) {
        errors.push(`tools[${i}] "${toolName}" needs a url or a plugin-level baseUrl`);
        continue;
      }

      const path = typeof rawTool.path === 'string' ? rawTool.path.trim() : '';
      if (path && !path.startsWith('/')) {
        errors.push(`tools[${i}] "${toolName}" path must start with "/"`);
        continue;
      }

      tools.push({
        name: toolName,
        description: String(rawTool.description || '').slice(0, 512),
        transport,
        method,
        path,
        url: host,
        endpoint: `${host}${path}`,
        timeoutMs: clampTimeout(rawTool.timeoutMs),
        parameters: isPlainObject(rawTool.parameters) ? rawTool.parameters : {},
      });
    }
  }

  const rawEvents = manifest.events;
  let events = { channel: DEFAULT_CHANNEL, emits: [] };
  if (rawEvents !== undefined) {
    if (!isPlainObject(rawEvents)) {
      errors.push('events must be an object');
    } else {
      const channel = String(rawEvents.channel || DEFAULT_CHANNEL);
      if (!CHANNEL_RE.test(channel)) errors.push(`events.channel invalid: "${channel}"`);
      const emits = Array.isArray(rawEvents.emits) ? rawEvents.emits : [];
      if (rawEvents.emits !== undefined && !Array.isArray(rawEvents.emits)) {
        errors.push('events.emits must be an array');
      }
      const validEmits = [];
      for (const e of emits) {
        if (typeof e === 'string' && EVENT_TYPE_RE.test(e)) validEmits.push(e);
        else errors.push(`events.emits entry invalid: ${JSON.stringify(e)}`);
      }
      events = { channel, emits: validEmits };
    }
  }

  // Validate optional plugin-level headers (sent verbatim to the backend on invoke).
  // Each key must match /^[A-Za-z0-9-]{1,64}$/ and each value must be a string of at most
  // 512 characters with no \r or \n; otherwise push headers.<key> invalid to errors.
  // Skip entries whose value is the empty string after env expansion (an unset token sends no header).
  const rawHeaders = manifest.headers;
  const headers = {};
  if (rawHeaders !== undefined) {
    if (!isPlainObject(rawHeaders)) {
      errors.push('headers must be an object');
    } else {
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (!HEADER_KEY_RE.test(key) || typeof value !== 'string' || value.length > MAX_HEADER_VALUE_LEN || value.includes('\r') || value.includes('\n')) {
          errors.push(`headers.${key} invalid`);
          continue;
        }
        if (value === '') continue; // skip unset (empty) values
        headers[key] = value;
      }
    }
  }

  if (errors.length) return { valid: false, errors };

  return {
    valid: true,
    plugin: {
      manifestVersion,
      name,
      version,
      description: String(manifest.description || '').slice(0, 512),
      enabled: manifest.enabled !== false,
      baseUrl: baseUrl || null,
      tools,
      events,
      headers,
      source,
    },
  };
}

/**
 * Read + validate every *.plugin.json in `dir`.
 * Never throws: unreadable/invalid manifests land in `errors`.
 */
export function loadPluginsFromDir(dir = resolvePluginsDir(), { env = process.env } = {}) {
  const plugins = [];
  const errors = [];

  if (!existsSync(dir)) return { plugins, errors, dir };

  let files;
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.plugin.json')).sort();
  } catch (err) {
    return { plugins, errors: [{ source: dir, errors: [`cannot read plugins dir: ${err.message}`] }], dir };
  }

  const seen = new Map();
  for (const file of files) {
    const fullPath = join(dir, file);
    let parsed;
    try {
      parsed = expandDeep(JSON.parse(readFileSync(fullPath, 'utf8')), env);
    } catch (err) {
      errors.push({ source: file, errors: [`invalid JSON: ${err.message}`] });
      continue;
    }
    const result = validateManifest(parsed, { source: file });
    if (!result.valid) {
      errors.push({ source: file, errors: result.errors });
      continue;
    }
    if (seen.has(result.plugin.name)) {
      errors.push({ source: file, errors: [`duplicate plugin name "${result.plugin.name}" (already declared by ${seen.get(result.plugin.name)})`] });
      continue;
    }
    seen.set(result.plugin.name, file);
    plugins.push(result.plugin);
  }

  return { plugins, errors, dir };
}

/**
 * Build the runtime plugin registry.
 *
 * The API surface handed to the rest of the dashboard is deliberately small:
 *   list() / get() / getTool()   — discovery
 *   emit()                       — publish a declared event onto the event bus
 *   reload()                     — re-scan the plugins directory
 */
export function createPluginRegistry({ pluginsDir = null, eventBus = null, logStructured = () => {} } = {}) {
  let state = { plugins: [], errors: [], dir: pluginsDir || resolvePluginsDir(), loadedAt: null };

  function reload() {
    const { plugins, errors, dir } = loadPluginsFromDir(pluginsDir || resolvePluginsDir());
    state = { plugins, errors, dir, loadedAt: new Date().toISOString() };
    logStructured('info', 'plugins_loaded', {
      dir,
      loaded: plugins.length,
      enabled: plugins.filter(p => p.enabled).length,
      failed: errors.length,
      names: plugins.map(p => p.name),
    });
    for (const failure of errors) {
      logStructured('warn', 'plugin_manifest_rejected', { source: failure.source, errors: failure.errors });
    }
    return state;
  }

  return {
    reload,
    get dir() { return state.dir; },
    get loadedAt() { return state.loadedAt; },
    /** All manifests, including disabled ones (callers filter as needed). */
    list({ includeDisabled = true } = {}) {
      return includeDisabled ? [...state.plugins] : state.plugins.filter(p => p.enabled);
    },
    errors() { return [...state.errors]; },
    get(name) { return state.plugins.find(p => p.name === name) || null; },
    getTool(pluginName, toolName) {
      const plugin = state.plugins.find(p => p.name === pluginName);
      if (!plugin) return null;
      return plugin.tools.find(t => t.name === toolName) || null;
    },
    /** Every enabled plugin's tools, namespaced `plugin.tool` for agent exposure. */
    listTools() {
      return state.plugins
        .filter(p => p.enabled)
        .flatMap(p => p.tools.map(t => ({ ...t, plugin: p.name, qualifiedName: `${p.name}.${t.name}` })));
    },
    /**
     * Emit a plugin event onto the shared event bus.
     * Refuses event types the manifest did not declare in events.emits —
     * a plugin cannot spoof arbitrary dashboard events.
     */
    emit(pluginName, eventType, metadata = {}) {
      const plugin = state.plugins.find(p => p.name === pluginName);
      if (!plugin) return { ok: false, code: 'unknown_plugin', error: `Unknown plugin: ${pluginName}` };
      if (!plugin.enabled) return { ok: false, code: 'plugin_disabled', error: `Plugin is disabled: ${pluginName}` };
      if (!EVENT_TYPE_RE.test(String(eventType || ''))) {
        return { ok: false, code: 'invalid_event_type', error: 'Invalid event type' };
      }
      if (!plugin.events.emits.includes(eventType)) {
        return { ok: false, code: 'event_not_declared', error: `Plugin "${pluginName}" does not declare event "${eventType}" in events.emits` };
      }
      if (!eventBus) return { ok: false, code: 'event_bus_unavailable', error: 'Event bus unavailable' };
      const event = eventBus.publish(plugin.events.channel, eventType, {
        metadata: { ...(isPlainObject(metadata) ? metadata : {}), plugin: plugin.name },
      });
      return { ok: true, event, channel: plugin.events.channel };
    },
  };
}

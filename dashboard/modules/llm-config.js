import dotenv from 'dotenv';
import { loadEndpoints } from './endpoint-store.js';
dotenv.config();

export function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

export const DOCKER_RUNNER_URL = process.env.DOCKER_RUNNER_URL || 'http://model-runner.docker.internal/engines/llama.cpp/v1';

// Track which Docker Runner model was most recently used so the UI can show it
export const activeDockerRunnerModelRef = { current: null };

// ── Device profile system ─────────────────────────────────────────────────────
export const DEVICE_PROFILES = {
  minimal: { gpu: false, models: { general: 'llama3.2:1b',  coding: 'llama3.2:1b',         fast: 'llama3.2:1b' } },
  laptop:  { gpu: true,  models: { general: 'llama3.2:3b',  coding: 'qwen2.5-coder:7b',    fast: 'llama3.2:1b' } },
  desktop: { gpu: true,  models: { general: 'llama3.1:8b',  coding: 'qwen2.5-coder:14b',   fast: 'llama3.2:3b' } },
};
export const DEVICE_PROFILE = (process.env.DEVICE_PROFILE || 'minimal').toLowerCase();
export const activeProfile = DEVICE_PROFILES[DEVICE_PROFILE] || DEVICE_PROFILES.minimal;

export const LLM_CONFIG = {
  primary: {
    url: process.env.PRIMARY_LLM_URL || 'http://ollama:8080',
    name: 'Ollama (local)',
    backendType: 'ollama-container',
    type: 'general',
    apiStyle: 'ollama',
    defaultModel: process.env.PRIMARY_LLM_MODEL || activeProfile.models.general,
  },
  docker_runner: {
    url: DOCKER_RUNNER_URL,
    name: 'Qwen3-Coder (Docker Runner)',
    backendType: 'docker-runner',
    type: 'coding',
    apiStyle: 'openai',
    defaultModel: process.env.DOCKER_RUNNER_MODEL || 'ai/qwen3-coder:latest',
  },
  glm_flash: {
    url: DOCKER_RUNNER_URL,
    name: 'GLM-4.7-Flash (Docker Runner)',
    backendType: 'docker-runner',
    type: 'fast',
    apiStyle: 'openai',
    defaultModel: process.env.GLM_FLASH_MODEL || 'ai/glm-4.7-flash:latest',
  },
  openllm: {
    url: process.env.OPENLLM_URL || 'http://llm_openllm:3000',
    name: 'OpenLLM (custom models)',
    backendType: 'openllm-container',
    type: 'custom',
    apiStyle: 'openai',
    defaultModel: process.env.OPENLLM_MODEL || '',
  },
  // 9router - OpenAI-compatible router for Anthropic/Claude models
  // Connects to 9router running on host (port 20128) via host.docker.internal
  ninerouter: {
    url: process.env.NINEROUTER_URL || 'http://host.docker.internal:20128',
    name: '9router (host)',
    backendType: 'ninerouter',
    type: 'cloud',
    apiStyle: 'openai',
    defaultModel: process.env.NINEROUTER_MODEL || 'MAX',
    apiKey: process.env.NINEROUTER_API_KEY || '',
  },
};

// ── Custom endpoint registry ──────────────────────────────────────────────────
function applyCustomEndpoint(ep) {
  if (!ep.key || !ep.url) {
    console.warn('[config] Skipping custom endpoint missing key or url:', ep);
    return;
  }
  LLM_CONFIG[ep.key] = {
    url: ep.url,
    name: ep.name || ep.key,
    backendType: 'custom',
    type: ep.type || 'custom',
    apiStyle: ep.apiStyle || 'openai',
    defaultModel: ep.defaultModel || '',
    apiKey: ep.apiKey || '',
  };
}

(function loadCustomEndpoints() {
  // 1. Load from persisted store (survives restarts, API keys encrypted on disk)
  try {
    for (const ep of loadEndpoints()) applyCustomEndpoint(ep);
  } catch (e) { console.warn('[config] Could not load persisted endpoints:', e.message); }

  // 2. Load from CUSTOM_LLM_ENDPOINTS env (static config, lower precedence)
  const raw = process.env.CUSTOM_LLM_ENDPOINTS;
  if (!raw) return;
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (e) {
    console.error('[config] CUSTOM_LLM_ENDPOINTS is not valid JSON:', e.message);
    return;
  }
  if (!Array.isArray(entries)) {
    console.error('[config] CUSTOM_LLM_ENDPOINTS must be a JSON array');
    return;
  }
  for (const ep of entries) applyCustomEndpoint(ep);
})();

export const NEMOCLAW_URL = process.env.NEMOCLAW_URL || 'http://localhost:9000';
export const BB_MCP_URL = process.env.BB_MCP_URL || 'http://localhost:3100';
export const BB_MCP_ENABLED = isTruthyEnv(process.env.BB_MCP_ENABLED);
export const OPENLLM_ENABLED = isTruthyEnv(process.env.OPENLLM_ENABLED);

export const TOOL_CONTENT_GEN_URL = process.env.TOOL_CONTENT_GEN_URL || 'http://tool-content-gen:3200';
export const TOOL_WEBSITE_URL = process.env.TOOL_WEBSITE_URL || 'http://tool-website:3201';

export const TOOL_SERVERS = {
  content_gen: {
    key: 'content_gen',
    name: 'Content Gen (AI video)',
    description: 'Wraps MoneyPrinterTurbo — generate AI short videos from a topic.',
    url: TOOL_CONTENT_GEN_URL,
    serviceKey: 'tool_content_gen',
    composeService: 'tool-content-gen',
    ports: '3200:3200',
  },
  website: {
    key: 'website',
    name: 'Website Agent (B2B sites)',
    description: 'Lead discovery, client site generation, Netlify deploys, invoicing.',
    url: TOOL_WEBSITE_URL,
    serviceKey: 'tool_website',
    composeService: 'tool-website',
    ports: '3201:3201',
  },
};

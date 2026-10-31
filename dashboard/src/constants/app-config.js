export function getOrCreateUserId() {
  const key = 'agent_board_user_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? 'anon_' + crypto.randomUUID()
      : 'anon_' + Date.now().toString(36) + '_' + crypto.getRandomValues(new Uint32Array(2)).join('_').slice(2, 11);
    localStorage.setItem(key, id);
  }
  return id;
}

export function getUserRole() {
  return localStorage.getItem('agent_board_user_role') || null;
}

export function shouldShowOnboarding() {
  return localStorage.getItem('agent_board_onboarding_dismissed') !== '1';
}

export const BACKEND_TYPES = {
  OLLAMA: 'ollama-container',
  OPENLLM: 'openllm',
  DOCKER_RUNNER: 'docker-runner',
  MCP: 'mcp',
  SANDBOX: 'sandbox',
};

export const ENDPOINT_META = {
  primary:       { model: 'llama3.1:8b-instruct-q4_K_M', label: 'Llama 3.1 8B', desc: 'Ollama container · 4.9 GB', backendBadge: 'Ollama' },
  docker_runner: { model: 'ai/qwen3-coder:latest',  label: 'Qwen3-Coder',   desc: 'Docker Model Runner · 16.45 GB', backendBadge: 'Docker Runner' },
  glm_flash:     { model: 'ai/glm-4.7-flash:latest',label: 'GLM-4.7-Flash', desc: 'Docker Model Runner · 16.31 GB', backendBadge: 'Docker Runner' },
  openllm:       { model: 'custom (OPENLLM_MODEL)', label: 'OpenLLM',       desc: 'Custom/HF model · OpenAI-compatible · port 8082', backendBadge: 'OpenLLM' },
};

export const EXPERIENCE_META = {
  developer:   { icon: '💻', name: 'Developer', description: 'Full model access, standard safety.' },
  research:    { icon: '🔬', name: 'Researcher', description: 'Long-form reasoning. Slightly looser rails.' },
  safechat:    { icon: '🛡️', name: 'Safe Chat',  description: 'Strict safety. Simple UI for any user.' },
  content_gen: { icon: '🎬', name: 'Content Studio', description: 'Generate AI short videos (content-gen tool).' },
  website:     { icon: '🌐', name: 'Website Agent',  description: 'Lead discovery + B2B site generation (website tool).' },
};

export const EXPERIENCE_ENDPOINTS = {
  developer: ['primary', 'docker_runner', 'glm_flash', 'openllm'],
  research: ['primary', 'docker_runner', 'glm_flash', 'openllm'],
  safechat: ['primary'],
  content_gen: ['primary', 'docker_runner', 'glm_flash', 'openllm'],
  website: ['primary', 'docker_runner', 'glm_flash', 'openllm'],
};

export const EXPERIENCE_TOOLS = {
  content_gen: { toolKey: 'content_gen', serviceKey: 'tool_content_gen' },
  website: { toolKey: 'website', serviceKey: 'tool_website' },
};

export const SAFETY_COLORS = { strict: 'var(--red)', standard: 'var(--yellow)', research: 'var(--green)' };

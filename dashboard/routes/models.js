import express from 'express';
import axios from 'axios';
import { existsSync } from 'fs';

export function createModelsRouter({
  LLM_CONFIG, resolvePrimaryLlmUrl, PRIMARY_LLM_URL_CANDIDATES,
  PUBLIC_DEMO_MODE, PORT, DOCKER_CONTROL_ENABLED, NEMOCLAW_URL,
  getPersistenceStatus, getTracingStatus, logStructured,
}) {
  const router = express.Router();

  router.get('/system/info', async (req, res) => {
    try {
      const primaryResolution = await resolvePrimaryLlmUrl();
      const systemInfo = {
        platform: process.platform,
        nodeVersion: process.version,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        environment: {
          port: PORT,
          llmEndpoints: Object.keys(LLM_CONFIG),
          primaryLlmResolvedUrl: primaryResolution.url,
          primaryLlmCandidates: PRIMARY_LLM_URL_CANDIDATES,
          dockerControlEnabled: DOCKER_CONTROL_ENABLED,
          nemoClawUrl: NEMOCLAW_URL,
          persistence: getPersistenceStatus(),
          tracing: getTracingStatus(),
        },
      };
      systemInfo.inDocker = existsSync('/.dockerenv');
      res.json({ success: true, system: systemInfo });
    } catch (error) {
      logStructured('error', 'system_info_failed', { error: error.message });
      res.json({ success: false, error: 'Failed to get system info' });
    }
  });

  router.get('/models', async (req, res) => {
    try {
      const models = [];
      const primaryResolution = await resolvePrimaryLlmUrl();
      const modelRequests = new Map();
      const endpointModels = await Promise.all(Object.entries(LLM_CONFIG).map(async ([key, config]) => {
        const endpointUrl = key === 'primary' ? primaryResolution.url : config.url;
        const isOpenAi = config.apiStyle === 'openai';
        // Multiple logical Docker Runner models use one endpoint. Share the
        // catalog request while probing unrelated providers concurrently.
        const path = isOpenAi
          ? (config.backendType === 'docker-runner' ? '/models' : '/v1/models')
          : '/api/tags';
        const requestKey = `${endpointUrl}${path}`;
        if (!modelRequests.has(requestKey)) {
          modelRequests.set(requestKey, axios.get(requestKey, { timeout: 5000 }).then(response => response.data));
        }
        try {
          const data = await modelRequests.get(requestKey);
          if (isOpenAi) {
            return data.data?.map(m => ({
              id: key,
              endpoint: config.name,
              endpointUrl,
              backendType: config.backendType,
              type: config.type,
              name: m.id,
              model: m.id,
              size: 'unknown',
            })) || [];
          }
          return data.models?.map(m => ({
            id: key,
            endpoint: config.name,
            endpointUrl,
            backendType: config.backendType,
            type: config.type,
            name: m.name,
            model: m.name.split(':')[0],
            size: m.details?.parameter_size || 'unknown',
          })) || [];
        } catch (error) {
          logStructured('warn', 'model_endpoint_unreachable', { endpoint: key, endpointName: config.name, error: error.message });
          return [];
        }
      }));
      models.push(...endpointModels.flat());

      if (models.length === 0) {
        for (const [key, config] of Object.entries(LLM_CONFIG)) {
          models.push({ id: key, endpoint: config.name, endpointUrl: config.url, backendType: config.backendType, type: config.type, name: config.defaultModel, model: config.defaultModel, size: 'unknown' });
        }
      }

      const filteredModels = PUBLIC_DEMO_MODE ? models.filter((m) => m.id === 'primary') : models;
      const fallbackModels = filteredModels.length > 0 ? filteredModels : [{
        id: 'primary',
        endpoint: LLM_CONFIG.primary.name,
        endpointUrl: LLM_CONFIG.primary.url,
        backendType: LLM_CONFIG.primary.backendType,
        type: LLM_CONFIG.primary.type,
        name: LLM_CONFIG.primary.defaultModel,
        model: LLM_CONFIG.primary.defaultModel,
        size: 'unknown',
      }];

      res.json({ success: true, models: fallbackModels, endpoints: PUBLIC_DEMO_MODE ? ['primary'] : Object.keys(LLM_CONFIG), demoMode: PUBLIC_DEMO_MODE });
    } catch (error) {
      logStructured('error', 'models_fetch_failed', { error: error.message });
      const fallback = Object.entries(LLM_CONFIG).map(([key, c]) => ({ id: key, endpoint: c.name, endpointUrl: c.url, backendType: c.backendType, type: c.type, name: c.defaultModel, model: c.defaultModel, size: 'unknown' }));
      const filteredFallback = PUBLIC_DEMO_MODE ? fallback.filter((m) => m.id === 'primary') : fallback;
      res.json({ success: true, models: filteredFallback, endpoints: PUBLIC_DEMO_MODE ? ['primary'] : Object.keys(LLM_CONFIG), demoMode: PUBLIC_DEMO_MODE });
    }
  });

  return router;
}

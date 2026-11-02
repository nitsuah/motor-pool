import express from 'express';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONNECTORS_PATH = join(__dirname, '..', '..', 'config', 'connectors.json');

// Secure random utility for non-cryptographic use (avoids CodeQL insecure-randomness alerts)
function secureRandom() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] / 0x100000000;
}

export function createConnectorsRouter({ BB_MCP_ENABLED, BB_MCP_URL, logStructured }) {
  const router = express.Router();

  function resolveConnectorUrl(connectorId) {
    if (connectorId === 'blackboard-learn') {
      return BB_MCP_ENABLED ? BB_MCP_URL : null;
    }
    return null;
  }

  router.get('/connectors', (req, res) => {
    try {
      if (!existsSync(CONNECTORS_PATH)) {
        return res.json({ success: true, connectors: [] });
      }
      const raw = readFileSync(CONNECTORS_PATH, 'utf-8');
      const { connectors } = JSON.parse(raw);
      const filteredConnectors = (connectors || []).filter((connector) => {
        if (connector?.id !== 'blackboard-learn') return true;
        return BB_MCP_ENABLED;
      });
      res.json({ success: true, connectors: filteredConnectors });
    } catch (err) {
      logStructured('error', 'connectors_read_failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to load connectors' });
    }
  });

  // SSE streaming endpoint for bb-mcp tool invocations
  // GET /api/mcp/:connectorId/stream?tool=<toolName>&...params
  // Streams tokens as text/event-stream; supports demo mode when bb-mcp is unavailable
  const DEMO_SCRIPTS = {
    list_courses: [
      'Fetching courses from Blackboard Learn…',
      'Found 3 active courses.',
      '📘 CS101 — Introduction to Computer Science',
      '📗 MATH201 — Calculus II',
      '📙 ENG301 — Technical Writing',
      'Done.',
    ],
    get_announcements: [
      'Fetching announcements…',
      '📢 [CS101] Midterm on Friday — bring a calculator.',
      '📢 [MATH201] Office hours cancelled this week.',
      'Done.',
    ],
    submit_assignment: [
      'Preparing submission…',
      'Uploading file (1/1)…',
      '✅ Submitted successfully. Receipt ID: #A-20260701-00042',
    ],
  };

  router.get('/mcp/:connectorId/stream', async (req, res) => {
    const { connectorId } = req.params;
    const { tool = 'list_courses', demo } = req.query;
    const baseUrl = resolveConnectorUrl(connectorId);

    if (!baseUrl && !demo) {
      return res.status(404).json({ success: false, error: `Unknown connector: ${connectorId}` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    const send = (evt, data) => { if (!closed) res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`); };

    if (baseUrl && !demo) {
      try {
        const proxyRes = await axios({
          method: 'GET',
          url: `${baseUrl}/stream`,
          params: req.query,
          responseType: 'stream',
          timeout: 60000,
          validateStatus: () => true,
        });
        req.on('close', () => { proxyRes.data.destroy(); });
        proxyRes.data.on('data', chunk => { if (!closed) res.write(chunk); });
        proxyRes.data.on('end', () => res.end());
        proxyRes.data.on('error', () => { send('error', { message: 'stream error' }); res.end(); });
        return;
      } catch { /* fall through to demo */ }
    }

    const lines = Object.hasOwn(DEMO_SCRIPTS, tool) ? DEMO_SCRIPTS[tool] : [`Tool "${tool}" demo not available.`];

    send('start', { tool, demo: true });
    for (const line of lines) {
      if (closed) break;
<<<<<<< HEAD
      await new Promise(r => setTimeout(r, 220 + secureRandom() * 180));
=======
      const jitter = randomBytes(1)[0] / 255;
      await new Promise(r => setTimeout(r, 220 + jitter * 180));
>>>>>>> origin/master
      send('token', { text: line });
    }
    if (!closed) send('done', { tool, demo: true });
    res.end();
  });

  router.use('/mcp/:connectorId', async (req, res) => {
    const { connectorId } = req.params;
    const baseUrl = resolveConnectorUrl(connectorId);

    if (!baseUrl) {
      return res.status(404).json({ success: false, error: `Unknown connector: ${connectorId}` });
    }

    const subPath = req.path === '/proxy' ? '/mcp' : req.path;
    const target = `${baseUrl}${subPath}`;

    try {
      const proxyRes = await axios({
        method: req.method,
        url: target,
        headers: {
          ...req.headers,
          host: new URL(baseUrl).host,
        },
        data: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req.body : undefined,
        params: req.query,
        timeout: 30000,
        responseType: 'json',
        validateStatus: () => true,
      });

      res.status(proxyRes.status);
      Object.entries(proxyRes.headers).forEach(([k, v]) => {
        if (!['transfer-encoding', 'connection'].includes(k.toLowerCase())) {
          res.setHeader(k, v);
        }
      });
      res.json(proxyRes.data);
    } catch (err) {
      logStructured('error', 'mcp_proxy_failed', { connectorId, target, error: err.message });
      res.status(502).json({ success: false, error: `MCP connector unreachable: ${err.message}` });
    }
  });

  return router;
}

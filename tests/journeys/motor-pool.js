// motor-pool journey fixture: backend-free, fictional demo data only.
//
// The dashboard bundle (dashboard/dist, served by `vite preview`) is the only
// real thing under test. Every /api call is answered here from a small
// in-memory store, /ws/events is a silent accepted WebSocket, and the clock is
// pinned to the demo's "today". Same-shape data as the real routes in
// dashboard/routes/*.js.
const { test: base, expect } = require('@playwright/test');
const { step, slug } = require('./journey');

const NOW = '2027-01-15T15:00:00.000Z';

const MODELS = [
    { id: 'primary', endpoint: 'Ollama (local)', endpointUrl: 'http://ollama:8080', backendType: 'ollama-container', type: 'general', name: 'llama3.2:3b', model: 'llama3.2:3b', size: '2.0GB' },
    { id: 'docker_runner', endpoint: 'Qwen3-Coder (Docker Runner)', endpointUrl: 'http://model-runner.docker.internal/engines/llama.cpp/v1', backendType: 'docker-runner', type: 'coding', name: 'ai/qwen3-coder:latest', model: 'ai/qwen3-coder:latest', size: 'unknown' },
    { id: 'glm_flash', endpoint: 'GLM-4.7-Flash (Docker Runner)', endpointUrl: 'http://model-runner.docker.internal/engines/llama.cpp/v1', backendType: 'docker-runner', type: 'fast', name: 'ai/glm-4.7-flash:latest', model: 'ai/glm-4.7-flash:latest', size: 'unknown' },
    { id: 'openllm', endpoint: 'OpenLLM (custom models)', endpointUrl: 'http://llm_openllm:3000', backendType: 'openllm-container', type: 'custom', name: '', model: '', size: 'unknown' },
];

const svc = (key, label, status, extra = {}) => ({ key, label, backendType: 'mcp', controllable: false, checkType: 'http', running: status === 'up', status, resolvedUrl: null, ...extra });
const SERVICES = {
    ollama: svc('ollama', 'Ollama', 'up', { backendType: 'ollama-container', ports: '8081:8080', controllable: true, resolvedUrl: 'http://ollama:8080' }),
    nemoclaw: svc('nemoclaw', 'NemoClaw', 'unavailable', { backendType: 'sandbox', ports: '9000:8080' }),
    bb_mcp: svc('bb_mcp', 'Blackboard MCP', 'disabled', { ports: '3100:3100', disabledReason: 'BB_MCP_ENABLED=false' }),
    llm_openllm: svc('llm_openllm', 'OpenLLM', 'disabled', { backendType: 'openllm-container', ports: '8082:3000', disabledReason: 'OPENLLM_ENABLED=false' }),
    tool_content_gen: svc('tool_content_gen', 'Content Gen', 'unavailable', { ports: '3200:3200', controllable: true }),
    tool_website: svc('tool_website', 'Website', 'unavailable', { ports: '3300:3300', controllable: true }),
};

const FILES = {
    'README.md': '# harbor-api\n\nSmall demo service the agents work on.\n',
    'src/server.js': "const express = require('express');\nconst app = express();\n\napp.get('/health', (req, res) => res.json({ ok: true }));\n\napp.listen(8080);\n",
    'src/login.js': "export function login(user, pass) {\n  // TODO: rate limit\n  return user === 'demo' && pass === 'demo';\n}\n",
    'package.json': '{\n  "name": "harbor-api",\n  "version": "0.3.0"\n}\n',
};
const COMMITS = [
    { hash: 'a1b2c3d4e5f6a7b8c9d0', short: 'a1b2c3d', subject: 'Add health endpoint', author: 'Dana Whitfield', relative: '2 days ago', date: '2027-01-13T10:00:00Z' },
    { hash: 'b2c3d4e5f6a7b8c9d0e1', short: 'b2c3d4e', subject: 'Initial commit', author: 'Dana Whitfield', relative: '5 days ago', date: '2027-01-10T10:00:00Z' },
];

function seed() {
    return {
        sessions: [
            { id: 'sess_demo_1', name: 'Fix login bug', model: 'llama3.2:3b', endpoint: 'primary', experience: 'developer', safetyMode: 'standard', userId: 'anonymous', status: 'idle', createdAt: NOW, updatedAt: NOW, lastActivity: NOW, errorCount: 0, messages: [] },
            { id: 'sess_demo_2', name: 'Harbor reading list', model: 'llama3.2:3b', endpoint: 'primary', experience: 'research', safetyMode: 'research', userId: 'anonymous', status: 'idle', createdAt: NOW, updatedAt: NOW, lastActivity: NOW, errorCount: 0, messages: [] },
        ],
        tasks: [
            { id: 'task_demo_1', title: 'Write login tests', description: 'Cover the happy path and the lockout.', status: 'pending', priority: 'high', sessionId: null, assignedSessionName: null, assignedUserId: null, createdAt: NOW, updatedAt: NOW, completedAt: null },
            { id: 'task_demo_2', title: 'Document the health endpoint', description: '', status: 'in_progress', priority: 'medium', sessionId: 'sess_demo_1', assignedSessionName: 'Fix login bug', assignedUserId: 'anonymous', createdAt: NOW, updatedAt: NOW, completedAt: null },
            { id: 'task_demo_3', title: 'Pin the base image', description: '', status: 'completed', priority: 'low', sessionId: null, assignedSessionName: null, assignedUserId: null, createdAt: NOW, updatedAt: NOW, completedAt: NOW },
        ],
        files: { ...FILES },
        counter: 10,
    };
}

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const lsOf = (files, dir) => {
    const prefix = dir === '.' || dir === '' ? '' : dir.replace(/\/$/, '') + '/';
    const seen = new Map();
    for (const [p, c] of Object.entries(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [head, ...tail] = rest.split('/');
        if (tail.length) seen.set(head, { name: head, type: 'dir' });
        else seen.set(head, { name: head, type: 'file', size: c.length, modified: NOW });
    }
    return [...seen.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
};

/** Answer every dashboard API call from `db`; returns the db for assertions. */
async function mockDashboard(page, { workspace = true, replies = [] } = {}) {
    const db = seed();
    const summary = () => {
        const byStatus = { pending: 0, in_progress: 0, blocked: 0, completed: 0 };
        db.tasks.forEach((t) => { byStatus[t.status] += 1; });
        return { total: db.tasks.length, byStatus };
    };
    const sessionRow = (s) => ({ id: s.id, name: s.name, model: s.model, endpoint: s.endpoint, messageCount: s.messages.length, createdAt: s.createdAt, updatedAt: s.updatedAt, userId: s.userId, experience: s.experience, safetyMode: s.safetyMode, status: s.status, lastActivity: s.lastActivity, errorCount: 0 });

    await page.routeWebSocket(/\/ws\/events/, () => {}); // accepted, silent

    await page.route('**/api/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace(/^\/api/, '');
        const m = req.method();
        const body = () => { try { return req.postDataJSON() || {}; } catch { return {}; } };

        if (p === '/demo-mode') return route.fulfill(json({ success: true, enabled: false, enforcedExperience: null, allowedEndpoints: ['primary', 'docker_runner', 'glm_flash', 'openllm'], websocketPath: '/ws/events' }));
        if (p === '/models') return route.fulfill(json({ success: true, models: MODELS, endpoints: MODELS.map((x) => x.id), demoMode: false }));
        if (p === '/models/pull-status') return route.fulfill(json({ success: true, pulls: {} }));
        if (p === '/docker/status') return route.fulfill(json({
            dockerRunning: true,
            containers: { ollama: { running: true, status: 'healthy', ports: '8081:8080', backendType: 'ollama-container', label: 'Ollama' } },
            endpoints: { primary: { name: 'Ollama (local)', model: 'llama3.2:3b', backendType: 'ollama-container', live: true, containerRunning: true, modelInstalled: true, resolvedUrl: 'http://ollama:8080' } },
            networks: { agentNetwork: true }, volumes: {}, errors: [], deviceProfile: { name: 'minimal', models: { general: 'llama3.2:3b', coding: 'llama3.2:3b', fast: 'llama3.2:3b' }, gpu: false },
            workspace: { configured: workspace, root: workspace ? '/workspace' : null }, activeDockerRunnerModel: null,
        }));
        if (p === '/system/services') return route.fulfill(json({ success: true, dockerControlEnabled: false, inDocker: true, services: SERVICES }));
        if (p === '/system/info') return route.fulfill(json({ success: true, system: { platform: 'linux', nodeVersion: 'v24.0.0', uptime: 3600, memory: { rss: 110000000, heapTotal: 60000000, heapUsed: 37000000 }, environment: { port: 3000, llmEndpoints: ['primary'], dockerControlEnabled: false, persistence: { enabled: false }, tracing: { enabled: false } }, inDocker: true } }));
        if (p === '/worktrees') return route.fulfill(json({ success: true, enabled: false, worktrees: [], tmuxAvailable: false, commandExecutionEnabled: false, allowedCommands: [], naming: {} }));
        if (p === '/system/config-check') return route.fulfill(json({ success: true, checks: [] }));
        if (p === '/config/endpoints') return route.fulfill(json({ success: true, endpoints: [] }));
        if (p === '/tools') return route.fulfill(json({ success: true, tools: [] }));
        if (p.startsWith('/metrics/')) return route.fulfill(json({ success: true }));
        if (p === '/experiences') return route.fulfill(json({ success: true, experiences: {} }));

        if (p === '/sessions' && m === 'GET') return route.fulfill(json({ success: true, sessions: db.sessions.map(sessionRow) }));
        if (p === '/sessions' && m === 'POST') {
            const b = body();
            const id = `sess_demo_${++db.counter}`;
            const s = { id, name: b.name || `session-${db.counter}`, model: 'llama3.2:3b', endpoint: 'primary', experience: b.experience || 'developer', safetyMode: 'standard', userId: 'anonymous', status: 'idle', createdAt: NOW, updatedAt: NOW, lastActivity: NOW, errorCount: 0, messages: [] };
            db.sessions.push(s);
            return route.fulfill(json({ success: true, session: { id, name: s.name, model: s.model, endpoint: s.endpoint, experience: s.experience, safetyMode: s.safetyMode, createdAt: NOW } }));
        }
        let mm = p.match(/^\/sessions\/([^/]+)(?:\/(\w+))?$/);
        if (mm) {
            const s = db.sessions.find((x) => x.id === mm[1]);
            if (!s) return route.fulfill(json({ success: false, error: 'Session not found' }, 404));
            if (!mm[2] && m === 'GET') return route.fulfill(json({ success: true, session: { ...s, llmUrl: 'http://ollama:8080', useSafeModeEnabled: false } }));
            if (!mm[2] && m === 'DELETE') { db.sessions = db.sessions.filter((x) => x !== s); return route.fulfill(json({ success: true })); }
            if (mm[2] === 'tasks') return route.fulfill(json({ success: true, tasks: db.tasks.filter((t) => t.sessionId === s.id) }));
            if (mm[2] === 'health') return route.fulfill(json({ success: true, health: { sessionId: s.id, status: 'idle', messageCount: s.messages.length, errorCount: 0, endpoint: s.endpoint, endpointReachable: true, uptime: 60 } }));
            if (mm[2] === 'outputs') return route.fulfill(json({ success: true, files: [] }));
            if (mm[2] === 'stream' && m === 'POST') {
                const text = body().message;
                const reply = replies.shift() || 'Done.';
                s.messages.push({ role: 'user', content: text, timestamp: NOW }, { role: 'assistant', content: reply, timestamp: NOW });
                const sse = [{ type: 'token', content: reply }, { type: 'done', messageCount: s.messages.length }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
                return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
            }
            return route.fulfill(json({ success: true }));
        }

        if (p === '/tasks' && m === 'GET') {
            let items = db.tasks;
            const st = url.searchParams.get('status');
            if (st) items = items.filter((t) => t.status === st);
            return route.fulfill(json({ success: true, tasks: items, total: items.length, summary: summary() }));
        }
        if (p === '/tasks' && m === 'POST') {
            const b = body();
            const t = { id: `task_demo_${++db.counter}`, title: b.title, description: b.description || '', status: 'pending', priority: b.priority || 'medium', sessionId: b.sessionId || null, assignedSessionName: db.sessions.find((x) => x.id === b.sessionId)?.name || null, assignedUserId: null, createdAt: NOW, updatedAt: NOW, completedAt: null };
            db.tasks.unshift(t);
            return route.fulfill(json({ success: true, task: t }));
        }
        mm = p.match(/^\/tasks\/([^/]+)$/);
        if (mm) {
            const t = db.tasks.find((x) => x.id === mm[1]);
            if (!t) return route.fulfill(json({ success: false, error: 'Task not found' }, 404));
            if (m === 'PUT') { Object.assign(t, body(), { updatedAt: NOW }); return route.fulfill(json({ success: true, task: t })); }
            if (m === 'DELETE') { db.tasks = db.tasks.filter((x) => x !== t); return route.fulfill(json({ success: true })); }
            return route.fulfill(json({ success: true, task: t }));
        }

        if (p === '/workspace/status') return route.fulfill(json(workspace ? { configured: true, root: '/workspace', git: { repo: true, branch: 'main', dirty: false, ahead: 0 } } : { configured: false }));
        if (p === '/workspace/ls') return route.fulfill(json({ path: url.searchParams.get('path') || '.', entries: lsOf(db.files, url.searchParams.get('path') || '.') }));
        if (p === '/workspace/read') {
            const fp = url.searchParams.get('path');
            return db.files[fp] === undefined ? route.fulfill(json({ error: 'Not found' }, 404)) : route.fulfill(json({ path: fp, content: db.files[fp] }));
        }
        if (p === '/workspace/write') { const b = body(); db.files[b.path] = b.content; return route.fulfill(json({ path: b.path, bytes: b.content.length })); }
        if (p === '/workspace/git/status') {
            const changed = Object.keys(db.files).filter((f) => db.files[f] !== FILES[f]);
            return route.fulfill(json({ branch: 'main', files: changed.map((f) => ({ status: FILES[f] === undefined ? '??' : 'M', file: f })) }));
        }
        if (p === '/workspace/git/branches') return route.fulfill(json({ branches: ['main'], remotes: [], current: 'main' }));
        if (p === '/workspace/git/log') return route.fulfill(json({ commits: COMMITS }));
        if (p === '/workspace/exec') return route.fulfill(json({ stdout: 'ok', stderr: '', exitCode: 0 }));
        if (p === '/workspace/search') return route.fulfill(json({ results: [] }));

        return route.fulfill(json({ success: true }));
    });
    return db;
}

/** Fonts in and the network quiet. */
async function settle(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle');
}

const test = base.extend({
    page: async ({ page }, use) => {
        await page.clock.setFixedTime(new Date(NOW));
        // The 3D hub canvas animates (and spans the whole viewport, so masking it would hide the
        // hero text too): hide just the canvas and keep the DOM around it.
        await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
                const style = document.createElement('style');
                style.textContent = 'canvas { visibility: hidden !important; }';
                document.head.appendChild(style);
            });
        });
        await use(page);
    },
});

module.exports = { test, expect, step, slug, mockDashboard, settle, NOW };

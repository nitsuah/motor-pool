# motor-pool — Local AI Ops Cockpit


<!-- Deployment Status -->
[![Deploy Status](https://github.com/nitsuah/motor-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/nitsuah/motor-pool/actions)

> 🧭 **motor-pool** · [Features](./docs/FEATURES.md) · [Roadmap](./docs/ROADMAP.md) · [Tasks](./docs/TASKS.md) · [Changelog](./docs/CHANGELOG.md) · [Metrics](./docs/METRICS.md) <!-- nav -->

motor-pool is a local-first control room for multi-model AI workflows. It gives you a chat surface, safety rails, and live observability in one place, so you can run and evaluate model behavior without sending data to external APIs.

## Why motor-pool

- **Ship safer prompts faster**: built-in input classification, prompt-injection checks, blocked-input handling, and output sanitization.
- **Run multiple experiences**: switch between Developer Assistant, Research Mode, and Safe Chat with server-enforced routing and safety policies.
- **Observe everything live**: metrics dashboards, WebSocket event streaming, and OpenTelemetry traces to Jaeger.
- **Stay local-first**: designed to run on your own machine with Docker.

## Product Highlights

- **Experience-aware sessions**: persistent sessions with user context, role metadata, and full message history.
- **Safety layer**: PII detection/redaction, harmful content filtering, and strict-mode handling for sensitive workflows.
- **Model routing**: primary Ollama endpoint, Docker Model Runner endpoints, and server-side endpoint restrictions.
- **Operations UI**: dark and light themes, system panel controls, live container status, and endpoint health visibility.
- **Observability stack**: metrics APIs, event bus, persistence status, tracing status, and Jaeger integration.
- **Workspace IDE**: VSCode-style split layout with file tabs, integrated terminal pane, compact git panel, and task dispatch — all in-browser.
- **Topbar command bar**: unified top-bar replaces the sidebar; model/endpoint controls, session picker, and system actions accessible from one surface.

## Screenshots

Captured from the local Docker stack at `http://localhost:3000`.

### Dashboard Overview

![agent-board dashboard overview](https://github.com/nitsuah/motor-pool/blob/master/docs/screenshots/dashboard-overview.png)

### Metrics View

![agent-board metrics panel](https://github.com/nitsuah/motor-pool/blob/master/docs/screenshots/metrics-panel.png)

### System Management

![agent-board system management panel](https://github.com/nitsuah/motor-pool/blob/master/docs/screenshots/system-panel.png)

## Quick Start

Minimal stack (dashboard + Ollama + DB — fits a 16 GB host):

```powershell
cd motor-pool\config   # from the folder that holds your clone (see docs/DEPLOYMENT.md)
docker compose -f docker-compose.yml up -d
```

or for GPU:

```powershell
cd motor-pool\config   # from the folder that holds your clone (see docs/DEPLOYMENT.md)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

Open [http://localhost:3000](http://localhost:3000) — that's it.

Add opt-in profiles as needed:

```powershell
# Distributed tracing (Jaeger UI at :16686)
$env:OTEL_ENABLED='true'
docker compose -f docker-compose.yml --profile observability up -d jaeger

# Blackboard MCP
docker compose -f docker-compose.yml --profile bb-mcp up -d bb-mcp

# MCP tool servers (Content Studio / Website Agent)
docker compose -f docker-compose.yml --profile tools up -d tool-content-gen tool-website

# NemoClaw safety sandbox
docker compose -f docker-compose.yml --profile sandbox up -d nemoclaw
```

Default endpoints (minimal stack):

- [Dashboard](http://localhost:3000)
- [Ollama API](http://localhost:8081)

Optional endpoints (require profile flags above):

- [Jaeger UI](http://localhost:16686) — `--profile observability`
- [OpenLLM API](http://localhost:8082) — `--profile openllm` (deferred — GPU-only catalog)

## What You Can Do In 2 Minutes

1. Open the dashboard and create a new session.
2. Pick an experience (Developer, Research, or Safe Chat).
3. Send a normal prompt, then a deliberately unsafe one to see safety interception.
4. Open the Metrics tab to inspect safety and feedback telemetry.
5. Check Jaeger to view request traces on the critical path.

## Features

- **Multi-model support**: Llama2, Qwen3-Coder (Ollama), Docker Model Runner, GLM-Flash, OpenLLM (opt-in)
- **Agent sessions**: persistent session management with full message history
- **Safety sandbox**: NemoClaw integration for policy-enforced safe mode
- **Experience modes**: server-enforced endpoint and safety rules per experience
- **Metrics dashboard**: summary, safety, feedback, and error telemetry
- **Web dashboard**: React UI with live Docker status monitoring
- **OpenTelemetry tracing**: OTLP/HTTP export to Jaeger with graceful fallback
- **Instant model switching**: switch endpoints mid-conversation per session

## Directory Structure

```bash
dashboard/                    # Web UI & API server (React + Express)
  server.js                   # Express entry point — thin; logic in routes/ and modules/
  routes/                     # Route modules (docker.js, sessions.js, …)
  src/
    App.jsx                   # React root — session lifecycle, endpoint routing
    components/               # Extracted UI components (StatusBar, ChatColumn, SystemPanel, …)
    hooks/                    # Stateful logic hooks (useWebSocket, useSessionStreaming, useServiceActions, …)
    constants/                # App-wide config constants (app-config.js)
    utils/                    # Shared utilities (serviceErrors.js, …)
  tests/                      # Integration tests
  Dockerfile
config/                       # Stack config and model manifests
  docker-compose.yml          # Stack definition
  model-manifest.json         # Model loading config
  connectors.json             # Connector config
llm/                          # Model configs / Modelfiles (future)
services/                     # Additional microservices (future)
scripts/                      # Setup & management scripts
```

## Models & Selective Loading

Models are loaded at startup based on the `config/model-manifest.json` file. Only models listed in the `enabled` array will be loaded. The application default is `llama3.2:3b` — `ollama-init` automatically pulls `PRIMARY_LLM_MODEL` (default: `llama3.2:3b`) on `docker compose up`, so no manual pull is needed for the default model.

To enable additional models:

1. Pull the model in your Ollama container (e.g. `docker exec ollama ollama pull qwen3-coder:latest`).
2. Add the model name to the `enabled` array in `config/model-manifest.json`.
3. Restart the stack.

**Example `config/model-manifest.json`:**

```json
{
  "default": "llama3.2:3b",
  "enabled": [
    "llama3.2:3b",
    "qwen3-coder:latest"
  ]
}
```

| Model | Size | Use |
| --- | --- | --- |
| `llama3.2:3b` | 2 GB | **Default** — modern, fast on CPU, fits in RAM |
| `llama2:latest` | 3.8 GB | Legacy baseline; superseded by llama3.2:3b |
| `qwen3-coder:latest` | 18 GB | Code generation (requires ~18 GB free RAM) |
| `qwen3:latest` | 5.2 GB | General (MoE, loads as 17.7 GB at runtime) |

Pull additional models:

```powershell
docker exec ollama ollama pull llama3.2:latest   # 2 GB, good general model
docker exec ollama ollama pull qwen3:1.7b        # 1.4 GB, small but capable
```

### Docker Model Runner (optional)

Docker Desktop's built-in model runner is also wired up as an endpoint (`docker_runner`). To enable it:

1. Docker Desktop → Settings → Features in development → **Enable Docker Model Runner** + **Host-side TCP support**
2. Select "Docker Runner" in the dashboard sidebar

### OpenLLM (optional)

[OpenLLM](https://github.com/bentoml/OpenLLM) is a second OpenAI-compatible endpoint (`openllm`) for running custom or fine-tuned HuggingFace models that don't fit Ollama's Modelfile pattern — it runs alongside Ollama, not instead of it. It's opt-in and gated behind the `openllm` compose profile so it never starts by default. To enable it:

1. Set `OPENLLM_MODEL` to a HuggingFace model repo id (e.g. `HuggingFaceTB/SmolLM2-1.7B-Instruct`) and `OPENLLM_ENABLED=true` in `.env`.
2. Start the service:

   ```powershell
   docker compose -f config/docker-compose.yml --profile openllm up -d llm_openllm
   ```

3. Select "OpenLLM" in the dashboard sidebar (Developer or Research experience).

The container serves on port `3000` internally (`http://localhost:8082` on the host) and caches model weights in the `openllm_data` volume.

### Tool experiences: Content Studio & Website Agent (optional)

Two MCP tool servers under `tools/` are wired in as selectable **experiences**: pick
🎬 **Content Studio** or 🌐 **Website Agent** in the sidebar and the chat session is
paired with a tool workbench panel that lists the server's MCP tools and executes them
(forms are generated from each tool's input schema).

- **Content Studio** (`tools/content-gen`, port 3200) wraps MoneyPrinterTurbo for AI
  short-video generation (`generate_video`, `get_video_status`, container controls).
- **Website Agent** (`tools/website`, port 3201) drives the B2B website workflow:
  `discover_leads`, `save_file`/`read_file`, `deploy_site` (Netlify), `create_invoice`.

Both are gated behind the `tools` compose profile:

```powershell
docker compose -f config/docker-compose.yml --profile tools up -d --build tool-content-gen tool-website
```

If a tool server is offline, the workbench shows the exact start command (and a Start
button when `AGENT_BOARD_ENABLE_DOCKER_CONTROL=true`). The dashboard talks to the
servers via `POST /api/tools/:toolKey/call`, which proxies MCP `tools/call` over
Streamable HTTP — no MCP client is needed in the browser.

### Docker control & model pulls (opt-in)

By default the dashboard container has no Docker CLI and no socket access, so the
Services panel can show status but the Start/Stop/Restart buttons and the Models
panel's Pull buttons return a 501 explaining how to run the equivalent command on the
host. To let the dashboard actually drive the stack, apply the
`docker-compose.docker-control.yml` overlay:

```powershell
docker compose -f config/docker-compose.yml -f config/docker-compose.docker-control.yml `
  up -d --build agent-dashboard
```

This builds the dashboard with the Docker CLI installed, mounts the host Docker socket
read-write, and sets `AGENT_BOARD_ENABLE_DOCKER_CONTROL=true`. Mounting the Docker
socket gives the dashboard container root-equivalent control over the host Docker
daemon — only use this overlay in trusted local/dev environments.

With the overlay applied:

- The **Services** panel's Start/Stop/Restart buttons run real
  `docker compose up -d|stop|restart <service>` commands.
- The **Models** panel's Pull buttons download the configured model for each LLM
  endpoint — `ollama pull` (streamed, with live progress) for the `primary` endpoint,
  and `docker model pull` for Docker Model Runner endpoints (`docker_runner`,
  `glm_flash`).

## API

### Sessions

- `POST /api/sessions` — Create session (`{ endpoint, model, name, userId, userRole, experience, safetyMode }`)
- `GET /api/sessions` — List all sessions
- `GET /api/sessions/:id` — Get session with messages
- `DELETE /api/sessions/:id` — Delete session
- `PUT /api/sessions/:id/model` — Switch model/endpoint (`{ endpoint, model }`)
- `POST /api/sessions/:id/feedback` — Record thumbs up/down on an assistant message (`{ messageIndex, positive }`)

### Messages

- `POST /api/sessions/:id/message` — Send message (`{ message, useSafeMode }`)
- `POST /api/sessions/:id/stream` — Stream message via SSE (`text/event-stream`; final event is `data: {"type":"done","messageCount":<count>}`)

### Task Queue

- `GET /api/tasks` — List all tasks (filter by `status`, `sessionId`, `priority`)
- `POST /api/tasks` — Create task (`{ title, description, priority, sessionId, experience }`)
- `PUT /api/tasks/:id` — Update task status/priority/session
- `DELETE /api/tasks/:id` — Delete task
- `GET /api/sessions/:id/tasks` — Tasks assigned to a session

### Webhooks

- `POST /api/webhooks/trigger` — Ingest an external event and optionally create a task (`{ event, source, payload, createTask }`); requests must include an `x-hub-signature-256` header — HMAC-SHA256 of the raw request body signed with `WEBHOOK_SECRET`

### External Endpoints (BYOK)

- `GET /api/config/endpoints` — List configured LLM endpoints (built-in + runtime-added)
- `POST /api/config/endpoints` — Register a runtime endpoint (`{ key, url, name, apiStyle, defaultModel, apiKey }`)
- `DELETE /api/config/endpoints/:key` — Remove a runtime endpoint (built-ins cannot be removed)

### Product Surface

- `GET /api/experiences` — List available experience configs
- `GET /api/tools` — Tool server reachability (content_gen, website)
- `GET /api/tools/:toolKey/tools` — List a tool server's MCP tools
- `POST /api/tools/:toolKey/call` — Execute an MCP tool (`{ name, arguments }`)
- `GET /api/metrics/summary` — Session/message totals, model distribution, experience distribution
- `GET /api/metrics/safety` — Input classifications, blocked prompts, filtered outputs
- `GET /api/metrics/feedback` — Positive/negative feedback by model and experience
- `GET /api/metrics/errors` — Error rate and recent failures

### Workspace File I/O

By default agents work in a **sandbox checkout**, not your files. A one-shot
`workspace-seed` service seeds a dedicated volume (`agent_workspace`) from a
read-only mount of the repo on first start: a `git clone` onto branch
`agent/sandbox` plus your current uncommitted working tree (or a filtered copy
when the repo is itself a git worktree), never `.env*` secrets or
`node_modules`. The dashboard container that runs agent tools does not mount
the repo at all, and agent shell commands get a scrubbed environment (no `.env`
secrets), so agents can edit, run and commit in the sandbox without reaching
host files. The dashboard refuses to start if seeding did not complete.
Reset the sandbox with `docker volume rm <project>_agent_workspace`.

To let agents edit a real project instead, set `WORKSPACE_PATH` in `.env` and
apply the `docker-compose.workspace.yml` overlay (it sets `WORKSPACE_SANDBOX=false`).
Paths are always confined to the workspace root to prevent traversal.

- `GET /api/workspace/status` — Workspace mount status and git repo info
- `GET /api/workspace/ls` — List a workspace directory
- `GET /api/workspace/read` — Read a workspace file (max 1 MB)
- `POST /api/workspace/write` — Write a workspace file (`{ path, content }`)
- `GET /api/workspace/git/status` — Changed files in the workspace repo
- `POST /api/workspace/git/commit` — Stage and commit workspace changes (`{ message, files? }`)
- `POST /api/workspace/git/push` — Push the workspace branch

### System

- `GET /api/health` — Health check (LLM endpoints + Docker status)
- `GET /api/system/info` — Node/platform/environment info (uptime, memory, endpoint list)
- `GET /api/models` — Available models from all endpoints
- `GET /api/docker/status` — Container status (includes `endpoints[*].modelInstalled`/`modelLoaded`)
- `GET /api/system/services` — Service discovery catalog (resolved URLs, candidates, controllability)
- `POST /api/system/services/:serviceKey/:action` — Service action API (`start|stop|restart`, gated)
- `POST /api/models/pull` — Pull a model for an LLM endpoint (`{ endpoint, model? }`, defaults to the
  endpoint's configured model). Ollama pulls stream progress via `/ws/events`
  (`model_pull_progress`); Docker Model Runner pulls (`docker_runner`/`glm_flash`) require
  `AGENT_BOARD_ENABLE_DOCKER_CONTROL=true` and the [docker-control overlay](#docker-control-and-model-pulls-opt-in).
- `POST /api/models/pull-all` — Kick off pulls for all configured endpoints where the default model has not yet been pulled (uses Docker Model Runner exact-ID matching; `docker.io/` prefix variants or omitted `:latest` tags may not match an already-pulled image)
- `POST /api/models/unload` — Remove a Docker Model Runner model from disk (`{ model }`, requires Docker control)
- `GET /api/models/pull-status` — In-progress/last-known pull status per `endpoint:model`
- `GET /api/persistence/status` — Postgres persistence status (configured/enabled)
- `GET /api/tracing/status` — OpenTelemetry tracing status (enabled/initialized/endpoint)

### Runtime Config

- `PRIMARY_LLM_URL` — Default primary Ollama URL fallback.
- `PRIMARY_LLM_URL_CANDIDATES` — Comma-separated discovery candidates for primary Ollama URL resolution.
- `AGENT_BOARD_ENABLE_DOCKER_CONTROL` — Set `true` to enable service action API endpoints.
- `DOCKER_COMPOSE_FILE` — Optional compose-file override for service actions.
- `DOCKER_PROJECT_DIR` — Optional compose project-directory override for service actions.
- `OPENLLM_ENABLED` — Set `true` to mark the OpenLLM endpoint as controllable from the system panel.
- `OPENLLM_MODEL` — HuggingFace model repo id served by the `llm_openllm` container.
- `OPENLLM_URL` — Override the OpenLLM endpoint URL (default `http://llm_openllm:3000`).
- `TOOL_CONTENT_GEN_URL` — Override the content-gen tool server URL (default `http://tool-content-gen:3200`).
- `TOOL_WEBSITE_URL` — Override the website tool server URL (default `http://tool-website:3201`).
- `TOOL_CALL_TIMEOUT_MS` — Budget for MCP tool calls (default 660000; video generation is slow).

## Architecture

```bash
dashboard/
├── server.js              # Express entry point — thin; logic in routes/ and modules/
├── routes/                # Route modules (docker.js, sessions.js, …)
├── src/
│   ├── App.jsx            # React root — session lifecycle, endpoint state
│   ├── App.css            # Styles
│   ├── main.jsx           # Entry point
│   ├── components/        # Extracted UI components
│   │   ├── ChatColumn.jsx
│   │   ├── SystemPanel.jsx, ServiceRow.jsx, ByokEndpointForm.jsx, ServiceDiscovery.jsx
│   │   ├── SessionHeader.jsx, MessageComposer.jsx, ReplayPanel.jsx
│   │   ├── StatusBar.jsx, OnboardingStrip.jsx
│   │   └── … (LiminalDashboard, WorkspaceView, TopBar, …)
│   ├── hooks/             # Stateful logic hooks
│   │   ├── useWebSocket.js         # WS connection + auto-reconnect
│   │   ├── useSessionStreaming.js  # Streaming, message queue, pause/resume
│   │   ├── useServiceActions.js   # Service control, model pulls, content clients
│   │   ├── useWorkspaceOps.js
│   │   └── useTaskManagement.js
│   ├── constants/         # App-wide config (app-config.js)
│   └── utils/             # Shared utilities (serviceErrors.js, …)
├── tests/                 # 64 test files (48 unit + 16 integration/e2e)
│   ├── safety-layer.js    # Unit — PII/injection/harmful content checks
│   ├── session-*.js       # Unit — session lifecycle, fork, export, filter, replay
│   ├── task-*.js          # Unit — task queue CRUD, priority, search
│   ├── e2e-chat.js        # Integration — end-to-end chat session
│   └── …
└── Dockerfile
```

## Development Workflow

All lint, test, and quality checks run via Docker — no local Node.js required.

**Run unit tests:**

```powershell
docker compose -f config/docker-compose.yml --profile test run --rm test
```

**Start the full stack:**

```powershell
docker compose -f config/docker-compose.yml up -d
```

**Stack management:**

```powershell
.\scripts\stack-manager.ps1 -Action start
.\scripts\stack-manager.ps1 -Action stop
.\scripts\stack-manager.ps1 -Action status
.\scripts\stack-manager.ps1 -Action logs
```

**Pre-commit hooks** (installs git hooks for whitespace/yaml checks; unit tests run on push):

```powershell
pip install pre-commit
pre-commit install
pre-commit install --hook-type pre-push
```

**Integration tests** require a running stack (`docker compose up -d`) then:

```powershell
cd dashboard && npm run test:integration
```

## Troubleshooting

> If **Chat returns error / LLM not responding**

- Check Ollama has models: `docker exec ollama ollama list`
- Check memory — large models (qwen3-coder 18 GB) need enough free RAM
- Default model is `llama3.2:3b` which is safe for ~8 GB+ systems

> **Container unhealthy**

- `docker logs agent-dashboard` — server errors
- `docker logs ollama` — Ollama errors (OOM will show here)

> **Port conflicts**

- Ollama: `8081` (host) → `8080` (container)
- NemoClaw: `9000` → `8080`
- Dashboard: `3000` → `3000`

## GPU Acceleration (CUDA/RTX 4080)

To enable GPU acceleration for Ollama (recommended for RTX 4080 or similar):

1. **Install NVIDIA drivers** for your GPU (latest version recommended).
2. **Install NVIDIA Container Toolkit** on your host:
   - https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
3. **Update Docker Compose** to use the NVIDIA runtime for the Ollama service:
   - Add to `ollama` service:

     ```yaml
     deploy:
       resources:
         reservations:
           devices:
             - driver: nvidia
               count: 1
               capabilities: [gpu]
     runtime: nvidia
     environment:
       - NVIDIA_VISIBLE_DEVICES=all
     ```

   - Or run with: `docker compose --gpus all up`
4. **Verify GPU is detected**:
   - `docker exec ollama nvidia-smi`
   - Ollama logs should show CUDA device available.
5. **Documented models**: After enabling GPU, add larger models to `config/model-manifest.json` as needed.

**Note:** If you have an RTX 4080, you should see ~24 GB VRAM available. Only enable large models if you have sufficient VRAM.

## Production Deployment

For production use:

- Use a dedicated secrets management solution (do not commit secrets to git).
- Set strong passwords for Postgres and any external services.
- Use Docker Compose overrides for production (e.g., `docker-compose.prod.yml`).
- Restrict exposed ports to trusted networks only.
- Enable HTTPS/SSL termination at the proxy or load balancer.
- Monitor resource usage and logs (Jaeger, dashboard, Ollama, bb-mcp).
- Regularly update images and dependencies.

**Example production override:**

```yaml
services:
  agent-dashboard:
    environment:
      - NODE_ENV=production
      - OTEL_ENABLED=true
      - OTEL_ENDPOINT=https://jaeger.prod.example.com:4318
    ports:
      - "127.0.0.1:3000:3000"  # Bind to localhost or internal network
```

## Safety & Security

- All traffic is local — no external API calls
- NemoClaw sandboxes agent execution with `--cap-drop=all`
- Capability allowlist: `NET_BIND_SERVICE` only
- `no-new-privileges` enforced on sandbox container
- Safe Chat sessions are server-restricted to the primary endpoint and strict safety mode
- Output filtering redacts detected PII and replaces blocked harmful responses before they reach the UI

<!-- docs-index:start -->

## Docs Index

Every committed Markdown doc in this repo (other than this README, `.github/` and `templates/`), the same set mirrored into the Obsidian vault, so none of them is orphaned.

- [API Documentation](./docs/API.md) — `docs/API.md`
- [Changelog](./docs/CHANGELOG.md) — `docs/CHANGELOG.md`
- [Production Deployment Guide](./docs/DEPLOYMENT.md) — `docs/DEPLOYMENT.md`
- [Features](./docs/FEATURES.md) — `docs/FEATURES.md`
- [Project Metrics: motor-pool](./docs/METRICS.md) — `docs/METRICS.md`
- [ROADMAP](./docs/ROADMAP.md) — `docs/ROADMAP.md`
- [TASKS](./docs/TASKS.md) — `docs/TASKS.md`

**`docs/archive/`**

- [motor-pool 2-Minute Demo Script (Ready to Record)](./docs/archive/AGENT-BOARD-DEMO_VIDEO_SCRIPT.md) — `docs/archive/AGENT-BOARD-DEMO_VIDEO_SCRIPT.md`
- [AI Stack Strategy](./docs/archive/AI_STACK_STRATEGY.md) — `docs/archive/AI_STACK_STRATEGY.md`
- [Architecture Overview](./docs/archive/ARCHITECTURE.md) — `docs/archive/ARCHITECTURE.md`
- [motor-pool Short Demo Script (60-75s)](./docs/archive/DEMO_VIDEO_SCRIPT_SHORT.md) — `docs/archive/DEMO_VIDEO_SCRIPT_SHORT.md`
- [Delivery Pipeline Handoff](./docs/archive/HANDOFF-bb-mcp-opt-in-20260403.md) — `docs/archive/HANDOFF-bb-mcp-opt-in-20260403.md`
- [Delivery Pipeline Handoff](./docs/archive/HANDOFF-service-discovery-system-panel-20260403.md) — `docs/archive/HANDOFF-service-discovery-system-panel-20260403.md`
- [Model Context Protocol (MCP) Setup Guide](./docs/archive/MCP_SETUP.md) — `docs/archive/MCP_SETUP.md`
- [Migration Notes](./docs/archive/MIGRATION.md) — `docs/archive/MIGRATION.md`
- [Ollama Model Loading Performance Audit](./docs/archive/MODEL_LOADING_AUDIT.md) — `docs/archive/MODEL_LOADING_AUDIT.md`
- [Quick Reference Guide](./docs/archive/QUICK_REFERENCE.md) — `docs/archive/QUICK_REFERENCE.md`
- [Agent Ecosystem - Local Development Stack](./docs/archive/README-orchestration.md) — `docs/archive/README-orchestration.md`
- [Reorganization Summary](./docs/archive/REORGANIZATION_SUMMARY.md) — `docs/archive/REORGANIZATION_SUMMARY.md`
- [Setup Instructions](./docs/archive/SETUP_INSTRUCTIONS.md) — `docs/archive/SETUP_INSTRUCTIONS.md`
- [motor-pool — Product Improvement Roadmap](./docs/archive/agent-board-roadmap.md) — `docs/archive/agent-board-roadmap.md`
- [3D Memory Palace — Design Notes (raw)](./docs/archive/neo4js-memory-palace-notes.md) — `docs/archive/neo4js-memory-palace-notes.md`

**`artifacts/`**

- [connection_status](./artifacts/connection_status.md) — `artifacts/connection_status.md`

**`tools/`**

- [installed tools](./tools/README.md) — `tools/README.md`

**`tools/website/templates/`**

- [Pitch Deck Structure (Claude generates fresh HTML for each client)](./tools/website/templates/pitch-structure.md) — `tools/website/templates/pitch-structure.md`
- [Service Packages Reference](./tools/website/templates/service-packages.md) — `tools/website/templates/service-packages.md`
- [Website Section Guide by Industry](./tools/website/templates/site-sections.md) — `tools/website/templates/site-sections.md`

<!-- docs-index:end -->

## License

MIT

## Community Standards

Shared community policies are centralized in [https://github.com/nitsuah/.github](https://github.com/nitsuah/.github):
- Contributing: [https://github.com/nitsuah/.github/blob/main/CONTRIBUTING.md](https://github.com/nitsuah/.github/blob/main/CONTRIBUTING.md)
- Code of Conduct: [https://github.com/nitsuah/.github/blob/main/CODE_OF_CONDUCT.md](https://github.com/nitsuah/.github/blob/main/CODE_OF_CONDUCT.md)
- Security: [https://github.com/nitsuah/.github/blob/main/SECURITY.md](https://github.com/nitsuah/.github/blob/main/SECURITY.md)

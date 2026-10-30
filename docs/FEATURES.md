# Features

> 🧭 [motor-pool](../README.md) · **Features** · [Roadmap](./ROADMAP.md) · [Tasks](./TASKS.md) · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

## Core Functionality

- **Agent Lifecycle Management** - Start, stop, and restart individual agents, tool servers, and services directly from the dashboard via live Docker Compose CLI control.
- **Real-time Status Monitoring** - Live tracking of agent availability, current task, and heartbeats.
- **Task Queue Visualization** - View pending, active, blocked, and completed tasks from the dashboard sidebar.
- **Multi-Agent Coordination** - Manage and broadcast commands to multiple agents simultaneously.
- **Persistent Agent History** - Persistence is implemented and validated by integration tests.
- **Dynamic Task Assignment** - Manually or programmatically route specific tasks to available agents.
- **Workspace File Engine** - File I/O browsing, editing, and staging/committing/pushing via Git controls. Agents default to an isolated **sandbox checkout** (`agent_workspace` volume on branch `agent/sandbox`, seeded from the read-only repo without `.env`/`node_modules`) so tool calls never write the host repo; a real host project is an explicit opt-in via `docker-compose.workspace.yml`.
- **Workspace IDE** - VSCode-style split layout with file tabs (multi-file editing), integrated terminal pane, compact git panel, and in-browser task dispatch; replaces the earlier single-pane file viewer.
- **Topbar Command Bar** - Unified top-bar surface replaces the sidebar; session controls, model/endpoint picker, experience selector, and system actions consolidated into a persistent top-bar.
- **Agent Lifecycle API Documentation** - All lifecycle, metrics, experiences, tools, workspace, and status endpoints documented in `docs/API.md` with request/response examples and a quick-reference table.
- **Conversation Replay Mode** - Step-through, message-by-message replay of persisted agent sessions (`ReplayPanel`) for debugging decision paths, auditing tool calls, and recording demos without a live model.
- **3D LiminalDashboard Home** - Three.js mind map laid out as the real hierarchy — hub → provider (service/endpoint) → model → session, each tier on its own ring — with OrbitControls, live system state, a ServiceDetail node panel (start/stop/restart/model-pull), and BYOK endpoints shown in the hub and model selector.

## Integrations & AI Runtimes

- **Content Studio & Website Agent** - Native proxying and schema-generated UI workbench panels for local HTTP MCP tool servers.
- **Multi-Tier Model Provisioning** - Automated hardware profile matching (`minimal`, `laptop`, `desktop`) with JIT model orchestration and custom model-runner registries.
- **Webhook Triggers** - Initiate agent actions via incoming external HTTP requests.
- **RESTful API** - Core API endpoints are implemented and validated by integration tests.
- `[planned]` **Custom Agent Scripts** - Support for loading and executing user-defined JavaScript logic within the agent runtime.
- **Event Bus Integration** - Internal event emitter system for handling cross-agent communication.
- **BYOK External LLMs & Custom Endpoint Registry** - `CUSTOM_LLM_ENDPOINTS` adds any OpenAI-compatible endpoint (OpenRouter, vLLM, LM Studio, Claude/Gemini gateways); API keys are injected server-side and never sent to the frontend.
- **Plugin Tools in the Agent Loop** - Enabled plugin tools are merged into the model's tool list for the developer/research/website experiences as `<plugin>__<tool>` function calls, so agents can invoke them on their own.
- **Streaming Tool-Enabled Agent Turns** - Developer, research, and website experiences stream model text and completed tool results during `/api/sessions/:id/stream`; provisional text clears when the model chooses a tool, and strict output-filter modes remain buffered until sanitization.
- **Declarative MCP Registry** - `config/mcp-registry.json` declares MCP containers once; `GET /api/mcp-registry` lists them with live health and `POST /api/mcp-registry/:key/ensure|stop` JIT-starts or stops one on demand.
- **bb-mcp Streaming UI** - `GET /api/mcp/:id/stream` SSE endpoint plus a `ToolStream` component (fade-in tokens, typing indicator) and a Stream button in ToolWorkbench.
- **Multi-Persona Blackboard Selector** - Student/Instructor/Admin/Parent persona picker in the SystemPanel BLACKBOARD MCP section filters the loaded bb-mcp tool list.
- **Topic-Based Event Channels** - Event bus supports named pub/sub channels (e.g. `file-saved`, `build-passed`); end-to-end cross-agent demo still pending (see ROADMAP 2027 Q1).

## UI/UX

- **Live Model Pull Status** - Frontend Models panel to pull, install, and stream the down-the-wire progress of Ollama and runner images over WebSockets.
- `[planned]` **Real-time Log Streaming** - WebSocket-based terminal view for watching agent console output in real time.
- `[planned]` **Visual Connection Graph** - Graphical representation of agent relationships and data flow.
- `[planned]` **Interactive Command Terminal** - Direct CLI-style interface to send manual overrides to active agents.
- **Responsive Dashboard** - Mobile-friendly interface optimized for monitoring agents on various screen sizes.
- **Dark/Light Mode Support** - Toggleable UI themes for different working environments.

## DevOps & Infrastructure

- **Dockerized Deployment** - Pre-configured Dockerfile and Compose setups for containerized environments, utilizing optimized threadpool scaling (`UV_THREADPOOL_SIZE=16`).
- **GPU Acceleration via CUDA** - Opt-in Docker Compose hardware passthrough for NVIDIA systems; AMD and runtime-aware accelerator selection are tracked in [issue #117](https://github.com/nitsuah/motor-pool/issues/117).
- **Ollama Startup Warmup** - Dedicated compose-level warmup orchestration layer shifting model cold-load latency overhead to stack initialization time.
- **Environment Variable Configuration** - Flexible setup using `.env` files for secrets and system paths.
- `[planned]` **Resource Usage Monitoring** - Visual tracking of CPU and memory consumption per agent process.
- **Health Check Endpoints** - Built-in diagnostic routes for integration with uptime monitors and orchestrators.
- **Service Discovery and Panel Control** - Backend resolves primary LLM URL from a candidate list; exposes controllability metadata and gated start/stop/restart service actions; system panel surfaces discovery data and live controls.
- **Live Service Lifecycle Control** - Start/Stop/Restart on the Services panel invoke live `docker compose` CLI commands (gated by `AGENT_BOARD_ENABLE_DOCKER_CONTROL` via `config/docker-compose.docker-control.yml`); inline error feedback shown per service; all tool containers (`tool-content-gen`, `tool-website`, `bb-mcp`) and core services share uniform controls.
- **Model Management** - Dashboard Models panel shows pull status and streams live progress for each configured LLM endpoint (`ollama pull` streamed over `/ws/events`, `docker model pull` for Docker Model Runner); primary Ollama model is env-configurable via `PRIMARY_LLM_MODEL` (default: `llama3.1:8b-instruct-q4_K_M`); opt-in `ollama-warmup` service (profile `warmup`) pre-loads the model at `docker compose up` time to eliminate cold-start latency.
- **Device Profile System** - `scripts/detect-profile.ps1` recommends a tier from NVIDIA VRAM reported by `nvidia-smi` plus system RAM; `DEVICE_PROFILE` selects the runtime's model defaults. It does not yet detect AMD accelerators or verify that Docker can access a detected GPU ([#117](https://github.com/nitsuah/motor-pool/issues/117)).
- **bb-mcp Opt-In Integration** - `BB_MCP_ENABLED` compose profile flag gates the bb-mcp service; dashboard API hides Blackboard connectors and proxy routes when disabled, keeping the default footprint minimal.
- **OpenLLM Opt-In Endpoint** - `openllm` compose profile adds a second OpenAI-compatible endpoint (port 8082) for custom/fine-tuned HuggingFace models via BentoML, registered alongside Ollama and Docker Model Runner; gated by `OPENLLM_ENABLED`.
- **Validated Production Deployment Path** - Documented in `docs/DEPLOYMENT.md`.
- **Content-gen Without the Docker Socket** - `tool-content-gen` is a `tools`-profile sidecar that calls the host MoneyPrinterTurbo API via `MPT_API_URL` instead of mounting `/var/run/docker.sock`.
- **CI Unit-Test Gate + Coverage Artifact** - `npm run test:unit` runs in `.github/workflows/ci.yml` before the image build; the lcov report is uploaded as a workflow artifact. Coverage ≥80% statements (see `docs/METRICS.md`).
- **Nightly Journeys** - `tests/journeys/` drives the dashboard like a user (mocked `/api`, frozen clock, 7 journeys, a visual baseline per step); `.github/workflows/journeys.yml` files and auto-closes `bot:journey` issues with no AI. Failures are listed in `BUGS.md` on the `bot/journeys` branch.

## Security & Verification

- **Sanitized Gateway Proxy** - Pre-flight interceptor normalization layer (`normalizeForMatching`) stripping zero-width evasions and formatting manipulation to sanitize multi-type PII and prompt injections.
- `[planned]` **Secure API Key Management** - Encrypted storage and masking of sensitive credentials used by agents.
- `[planned]` **JWT Authentication** - Secure dashboard access using JSON Web Tokens for session management.
- `[planned]` **Role-Based Access Control (RBAC)** - Define permissions for viewing logs versus controlling agent states.

## Developer Experience

- **Modular Plugin Architecture** - Manifests register by file placement under `dashboard/config/plugins/`; no core codebase edits required to add a plugin (PR #60).
- **tmux Multi-Agent Worktrees** - Spawn parallel agent instances, each isolated in its own tmux window with its own git worktree, so several agents can work on the same repo without colliding. Disabled by default (`AGENT_BOARD_ENABLE_TMUX`). The launch/teardown route has no per-request authentication, so command execution is gated behind a second, independent switch: an empty-by-default exact-match `AGENT_BOARD_TMUX_ALLOWED_COMMANDS` allowlist — enabling the feature grants worktree creation and empty windows only, never remote command execution, until an operator explicitly names each permitted command (PR #60).
- `[planned]` **Hot Reloading for Scripts** - Automatically refresh agent logic when source files are modified during development.
- **Comprehensive Event Logging** - Structured JSON logging for easier debugging and integration with ELK stacks.
- **Server/Frontend Refactor** - `server.js` route logic extracted into focused route modules (`routes/`); `App.jsx` stateful logic extracted into `src/hooks/` (`useWebSocket`, `useSessionStreaming`, `useServiceActions`) and discrete UI components extracted into `src/components/` (11 extracted: `ServiceRow`, `ByokEndpointForm`, `ServiceDiscovery`, `SessionHeader`, `MessageComposer`, `ReplayPanel`, `GitLogTab`, `TasksPanel`, `ServiceDetail`, `StatusBar`, `OnboardingStrip`); improves maintainability and test isolation.
- **Safe Chat Hardening** - Strengthened input validation and error boundary behavior in Safe Chat sessions; prevents partial renders on blocked/filtered responses.
- **Tool Result Visibility & Artifacts Tab** - MCP tool call results and generated artifacts surface in a dedicated Artifacts tab; tool output no longer hidden behind raw message history.

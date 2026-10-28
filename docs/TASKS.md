# TASKS

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · **Tasks** · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

Last Updated: 2026-10-28

## Todo

### New-machine follow-up (2026-10-27)

- [x] **Connect Obsidian to Codex** — verified vault search/read/create operations through the native Obsidian MCP connection; a non-secret motor-pool handoff prompt is saved in the vault.
- [x] **Set memory-sharing boundary** — keep raw/private notes local; only add sanitized project summaries to the public stash vault. Never store credentials or private transcripts in mirrored notes.
- [x] **Refresh the Obsidian motor-pool hub** — updated the overview with the Ollama-first setup and open latency/hardware follow-ups; avoided bulk sync over the user's modified stash working tree.
- [x] **Isolate unit tests from persistent app data** — the runner uses per-test temp files and disables Postgres; the Compose test profile mounts only the coverage output directory.
- [ ] **Wire `model-manifest.json` into model loading or retire it** — runtime currently pulls only `PRIMARY_LLM_MODEL`; the manifest's `enabled` list is not consumed.
- [ ] **Integrate 9router after owner setup** — validate the endpoint and update motor-pool configuration once the owner finishes configuring 9router.

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

- [ ] **Measure dashboard startup and assess UI bundle splitting** — the three-sample local Ollama comparison for Developer, Research, and Website is recorded in `docs/METRICS.md`; it reduced visible first-token latency by 45.6–62.6%. The production build reports one 934.07 KB minified JS chunk (249.11 KB gzipped) and warns above its 500 KB chunk threshold. Collect a browser startup baseline before splitting heavy panels ([#116](https://github.com/nitsuah/motor-pool/issues/116)).
- [ ] **Dashboard decomposition follow-up** — scope a staged refactor of `dashboard/src/App.jsx`, `dashboard/src/LiminalDashboard.jsx`, and `dashboard/server.js`; keep behavior-preserving extractions separate from feature work and define tests before implementation.
  - Context: the 2026-10-08 TIRE LOC report flagged these high-LOC files for deeper review. This TIRE-kick records the finding; it does not attempt a broad architectural rewrite.

- [ ] Add a GPU-oriented model portfolio after a supported accelerator path is verified.
  - Priority: P2
  - Context: coordinate with cross-vendor, runtime-aware hardware profiles in [#117](https://github.com/nitsuah/motor-pool/issues/117), and choose tiers that do not displace the existing CPU workflows.
  - Acceptance Criteria: selected GPU models are documented, pulled successfully, surfaced in the dashboard, and kept within device memory limits.

- [ ] **[2027-Q2] Blackboard agent demo mode** — add a demo-mode preset that walks through a full Blackboard workflow (course discovery → assignment submission → grade check) using bb-mcp without a live Blackboard connection.
  - Priority: P2
  - Context: portfolio showcase requires a runnable demo; demo mode lets this work without institutional credentials.
  - Acceptance Criteria: `BB_MCP_ENABLED=true BB_MCP_DEMO=true docker compose up` runs the full demo flow; documented in README.

- [ ] **[2027-Q2] bb-mcp tool registry panel** — display available bb-mcp tools alongside other MCP providers in the dashboard; show last invocation time and per-role availability status.
  - Priority: P2
  - Context: as the MCP container ecosystem grows, the dashboard needs a registry view so users know what tools are available and active.
  - Acceptance Criteria: a tools panel lists bb-mcp tools with status badges; clicking a tool shows its schema and last-run result.

- [ ] **Cross-vendor, runtime-aware hardware profiles** — detect the GPU vendor and the accelerator Ollama can actually access before selecting a GPU-oriented model tier ([#117](https://github.com/nitsuah/motor-pool/issues/117)).
  - Current limitation: `detect-profile.ps1` only queries `nvidia-smi`; the Compose GPU overlay is NVIDIA/CUDA-only. Ollama is CPU-bound in Windows Docker Desktop when AMD GPU passthrough is unavailable.

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
    sustained multi-session chat load, compared across the installed Ollama tags,
    would show whether the real lever is fewer concurrently-loaded models,
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

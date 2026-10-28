# ROADMAP

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · **Roadmap** · [Tasks](./TASKS.md) · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

Last Updated: 2026-10-28

> 2027 planning reset (2026-09-24, `pmo-ff`): every completed 2026 item was removed from this file and
> condensed into [FEATURES](./FEATURES.md) / [CHANGELOG](./CHANGELOG.md). Open 2026 items were carried
> into 2027 Q1 below, except the multi-tenancy/RBAC, audit logging, analytics, host profiling Phase 1, decoupled
> runtimes, and guardrails items, which had already been re-scoped to 2027 Q3. Nothing from the original 2026 plan remains in a 2026 quarter; the 2026 Q4 Imps section below was added afterwards (2026-10-14).

## 2026 Q4 - Imps: safe async agent tasks (In Progress)

> Plan: [IMPS-PLAN.md](./IMPS-PLAN.md). Direction: [RUST-REWRITE-ASSESSMENT.md §10](./RUST-REWRITE-ASSESSMENT.md#10-target-architecture-safe-async-agents-with-role-based-control).

- [ ] **Principals & API tokens with per-owner visibility** (pulls the 2027 Q1 exec-route token item forward).
- [ ] **Durable Postgres job queue** with leases, the first consumer being imps; the in-memory `/api/tasks` migrates onto it afterward.
- [ ] **Imp runner**: headless Claude Code workers through 9router in sandboxed worktrees, opening PRs that a human or reviewer agent approves.
- [ ] **Dispatchers**: `/imp` skill, phone (Tailscale + token), vigil/routines tokens, `bot:journey` webhook rule.

## 2027 Q1 - Developer Experience & Quality (Planned)

Critical path: service lifecycle UI → auth gate (+ interim exec-route token) → persistent BYOK.

- [ ] **Service lifecycle dashboard (UI completion)**: mount `/var/run/docker.sock` for in-container `docker stats` or add a host-side stats sidecar; surface per-service resource charts in the dashboard.
- [ ] **Authentication gate (P2)**: add an optional JWT/session auth layer so the dashboard can be safely exposed on a LAN without open-access risk.
- [ ] **Scoped API token for exec-capable routes (interim, before full auth gate)**: the worktree launch/exec route and `/api/workspace/exec` stay unauthenticated until the JWT/session gate lands; a shared-secret header check on just those routes closes the LAN-exposure gap sooner.
- [ ] **Persistent BYOK endpoints**: wire `CUSTOM_LLM_ENDPOINTS` env → encrypted volume store so runtime-added endpoints survive restart without editing `.env`.
- [ ] **Host architecture profiling Phase 2**: Windows host lean-baseline profile accounting for WSL2/Docker Desktop overhead.
- [ ] **Cross-vendor, runtime-aware GPU profile** ([#117](https://github.com/nitsuah/motor-pool/issues/117)): detect NVIDIA/AMD host devices, then separately verify the accelerator Ollama can access through its active runtime before choosing a GPU model tier; retain CPU fallback when access is not confirmed.
- [ ] **Named pub/sub event channels — validation** *(carried from 2026 Q3)*: the topic-based mechanism is implemented; close once two agents exchange events in a documented demo path (`TASKS.md` → "Validate cross-agent event bus behavior").
- [ ] `[deferred/P3]` **Unblock NemoClaw sandbox container** *(carried from 2026 Q2)* — Ollama is the active local runtime; revisit only if NemoClaw becomes relevant.
- [ ] `[deferred/P3]` **Replace OpenLLM endpoint** *(carried from 2026 Q2)* — CPU-incompatible with the current workflow; `OPENLLM_ENABLED=false` stays.

## 2027 Q2 - Blackboard Showcase & MCP Ecosystem (Planned)

> motor-pool is the UI/dashboard layer that connects to bb-mcp. Frontend and showcase concerns that are out of scope for the MCP server live here.

- [ ] **Blackboard agent demo mode**: offline preset workflow (course discovery → assignment submission → grade check) using bb-mcp.
- [ ] **Portfolio-grade Blackboard showcase**: single-command `BB_MCP_ENABLED=true docker compose up` with the documented offline demo flow (merges the two duplicate "showcase path" items from the old Q2 sections).
- [ ] **bb-mcp tool registry panel (finish)**: status badges per tool, per-tool schema display, last-run result panel (the tool list + persona filter already shipped).
- [ ] **MCP container manager UI**: extend the declarative `config/mcp-registry.json` registry with a dashboard panel to spin tool containers up/down on demand.
- [ ] **Odysseus router integration**: expose a standardized local endpoint for switching between OpenRouter tiers and local model pools.
- [ ] **3D Memory Palace / Neo4j context**: map cross-session agent memories using Neo4j + Graphiti + 3D Force Graph (WebGL). Design notes: `docs/archive/neo4js-memory-palace-notes.md`.

## 2027 Q3 - Platform Hardening & Scale (Exploratory)

> New section (2026-09-02). These are 2026 Q3 "Extensibility Foundations" items that
> never had a real target — each is a genuine architectural undertaking on its own
> (new subsystem, new infra dependency, or a cross-cutting security surface), not
> something to half-ship alongside a docs pass. Writeups below instead of bare
> checkboxes so the next pass can actually scope them.

- [ ] **Multi-tenancy & RBAC (planning)**
  - *What*: user accounts (login/SSO) and role-based access control — today
    motor-pool is single-user/single-host with no auth at all (see the 2027 Q1
    "Authentication gate" item, which is a prerequisite, not the same thing: auth
    proves who you are, RBAC decides what you're allowed to do once you are).
  - *Why*: every current deployment story is "one trusted operator on localhost or a
    private LAN." Multi-tenancy is what would let a team share one instance safely.
  - *Approach*: land the JWT/session auth gate first (2027 Q1). Only after that
    exists does an RBAC layer have an identity to hang permissions off; design it as
    a table of (role → allowed routes/actions) checked in middleware, not scattered
    per-route checks. Needs a decision on where user records live (new Postgres
    table vs. an external IdP) before implementation starts.

- [ ] **Audit logging & compliance support**
  - *What*: a durable, queryable record of who did what (service start/stop, model
    pulls, workspace file writes/commits, plugin tool invocations) beyond the
    existing structured JSON stdout logs.
  - *Why*: current logging is ops-facing (debugging, `docker logs`) not
    compliance-facing (a timeline for "what changed and who triggered it").
  - *Approach*: the cleanest fit is a dedicated `audit_log` Postgres table (reuse the
    existing `agent-db` — no new infra) written by a small middleware wrapper around
    the state-changing routes (workspace git ops, service actions, model pulls,
    plugin invokes) rather than instrumenting every route by hand. Depends on the
    persistence layer already being reliable (it is — `persistence.js`, 2026 Q2).

- [ ] **Analytics & operational observability**
  - *What*: aggregate usage/health trends over time (session volume, model
    distribution, error rates, safety-block rates) beyond the current point-in-time
    `/api/metrics/*` snapshots.
  - *Why*: `/api/metrics/summary|safety|feedback|errors` answer "what does it look
    like right now"; there's no history, so trends and regressions aren't visible.
  - *Approach*: OpenTelemetry is already wired for tracing (`tracing.js`, opt-in via
    `OTEL_ENABLED`) — the pragmatic path is periodic snapshots of the existing
    metrics endpoints into a time-series table (or an OTEL metrics exporter, reusing
    the same collector as tracing) rather than a new observability stack.

- [ ] **Host architecture profiling (Phase 1) & Windows host mitigation (Phase 2)**
  - *What*: profile real host specs (RAM, VRAM, CPU threads, OS overhead) beyond the
    current `minimal`/`laptop`/`desktop` device-profile tiers, and establish a lean
    baseline specifically accounting for WSL2/Docker Desktop's resource tax on
    Windows hosts.
  - *Why*: `config/device-profiles.json` and `scripts/detect-profile.ps1` already
    pick a model tier from GPU VRAM + RAM, but don't account for virtualization
    overhead, so a Windows host's *effective* budget is smaller than its raw specs
    suggest.
  - *Approach*: extend `detect-profile.ps1` to subtract a measured WSL2/Docker
    Desktop overhead constant (needs real measurement first, not a guess) before
    tier selection; Phase 2 (Windows-specific baseline) depends on Phase 1's
    measurement existing.

- [ ] **Decoupled runtimes & routing (Phase 3) + model configuration matrix (Phase 3)**
  - *What*: split local runner images into headless worker nodes with cross-node
    routing for pooled resource scheduling, plus a documented matrix pairing custom
    "homebrew" model configs with out-of-the-box vendor images.
  - *Why*: today every model runtime (Ollama, Docker Model Runner, OpenLLM) is
    single-host and single-node; this is only worth doing once there's an actual
    multi-host use case, which doesn't exist yet.
  - *Approach*: explicitly Phase 3 — depends on the device profiling work above
    landing first (you need to know a node's real capacity before you can route
    across nodes). No implementation should start before that.

- [ ] **File & payload guardrails (Phase 2) + schema validation (Phase 2)**
  - *What*: confirmation prompts and pre-operation snapshots before destructive
    workspace/tool operations, gateway-level payload scrubbing (PII, credentials,
    regex injections) beyond the existing input-side safety layer, and structured
    schema enforcement on model responses (JSON/Markdown formatting filters).
  - *Why*: `safety.js` already classifies/redacts on the way *in*; there's no
    equivalent guard on tool-call arguments or model output shape on the way *out*
    for the agentic (developer/research/website/plugin-tool) experiences.
  - *Approach*: two independent, separately-shippable pieces — (a) a
    confirmation/snapshot step in `runAgentLoop` before `bash`/`write_file`/plugin
    tool calls with side effects, (b) an optional per-experience JSON-schema
    validator on the final model response. Neither needs new infrastructure, just
    scoping and tests; smaller than the other items in this section but grouped here
    because both are security-surface work that deserves its own pass rather than
    riding along with a docs cycle.

- [ ] **RAG / vector-store foundation**
  - *What*: an actual retrieval-augmented-generation layer — embeddings, a vector
    index, and a query path that injects retrieved context into a chat/agent
    session.
  - *Why*: `TASKS.md` rejected a "turbovec for memory" item because there is
    currently zero embeddings/vector-store/RAG code anywhere in `dashboard/` for
    turbovec (or anything else) to attach to. If retrieval over the workspace,
    session history, or docs ever becomes a real product goal, this is the
    prerequisite.
  - *Approach*: not started, and shouldn't be until there's a concrete use case
    (e.g. "search past sessions," "answer from repo docs"). If it happens, turbovec
    is a legitimate candidate for the index layer given its stated compression
    ratio — evaluate it then, against whatever the actual retrieval requirements
    turn out to be.

## Notes

- The stack remains local-first and Docker-native.
- 2027 Q2 focuses on the Blackboard showcase and broadening the MCP/plugin ecosystem once the Q1 security and quality foundation is solid.
- 2027 Q3 is deliberately last: multi-tenancy/RBAC and audit logging both depend on the 2027 Q1 auth gate; decoupled runtimes depend on host profiling. Nothing in Q3 should start early.
- MCP container manager is the gateway to broader tool ecosystem integrations without bloating the base image.

<!--
AGENT INSTRUCTIONS:
1. Keep the roadmap quarter-first.
2. Use short checkpoint bullets, not narrative paragraphs.
3. Keep task-level detail in TASKS.md.
4. When an item ships, remove it here and condense it into FEATURES.md / CHANGELOG.md.
-->

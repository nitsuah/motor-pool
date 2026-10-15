# Rust Rewrite Assessment

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · [Tasks](./TASKS.md) · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

Written 2026-10-15 against `master` @ `c0864c1`. It answers three questions:

1. Should motor-pool be rewritten in Rust?
2. Is it worth running at all as an always-on agent reachable over Tailscale?
3. How good is what has been built so far?

## TL;DR

**Don't rewrite it in Rust. Cut it down instead.** On a box that runs local models, nearly all of the RAM, CPU and latency goes to the model runtime. Ollama/llama.cpp is already native C++, and the Node dashboard is a rounding error beside it: roughly 100 MB of a 3–8 GB working set, and milliseconds of overhead on turns that take seconds. A rewrite would cost months of evenings and a 70-file test suite to win back maybe 1–3% of memory. It would do nothing for the actual ceiling, which is that 1–7B local models are unreliable at tool calls. To get "efficient and impressive", make the product smaller: one container, SQLite, no default telemetry, a 3D view that loads only when opened, streaming and schema-constrained tool calls, and an auth gate before anything goes on a tailnet. If you still want Rust for its own sake, build a small new binary (`motor-pool-lite`, section 6), not a port.

**Grade: B− as an engineering artifact, C+ as a product.**

**Update (same day, section 9):** the intended target is a large shared host serving government and schools, with 9router's progressive tool disclosure ([decolua/9router#3575](https://github.com/decolua/9router/pull/3575)) and a BM25 agent/tool registry. That strengthens the "no Rust" verdict, because the disclosure code is MIT-licensed JavaScript you can lift directly. It also gives the project the focus it was missing: an on-prem AI gateway for gov/edu. But it moves auth, RBAC, audit logging and multi-user serving from "2027 someday" to prerequisites.

---

## 1. What exists today

| Area | Size / state |
| --- | --- |
| Source (JS/JSX + scripts) | ~23k lines tracked. Largest files: `LiminalDashboard.jsx` 883, `server.js` 742, `App.jsx` 698, `routes/docker.js` 636 |
| Backend | Express 5, 19 route modules, 11 support modules, `ws`, `pg`, axios, the OpenTelemetry SDK plus auto-instrumentations |
| Frontend | React 19 + Vite. Production bundle **923 KB JS + 72 KB CSS**, mostly three.js. METRICS target is <500 KB |
| Stack (compose) | Default: dashboard, Postgres 16, Ollama, ollama-init, workspace-seed. Profiles add warmup, Jaeger, bb-mcp, two tool servers, NemoClaw (crash-loops), OpenLLM (deferred) |
| Tests | 70 files, 66 unit tests pass, **81% statements / 71% branches** (METRICS, 2026-09-11), nightly Playwright journeys |
| Process | 247+ commits, every change through a PR, CI gate, docs kept current (FEATURES/ROADMAP/TASKS/CHANGELOG) |
| Default models | `llama3.2:1b` (minimal), `llama3.2:3b` / `qwen2.5-coder:7b` (laptop), `llama3.1:8b` / `qwen2.5-coder:14b` (desktop) |

The core loop (`modules/agent-tools.js` → `runAgentLoop`):

- Non-streaming `POST /api/chat` or `/chat/completions` per iteration, with a 120 s timeout and at most 5 iterations.
- Tools: `bash`, `read_file`, `write_file`, `list_files`, `web_search`, `write_artifact`, website-agent tools, and `<plugin>__<tool>` plugin tools.
- Falls back to parsing tool calls out of plain text when the model doesn't emit native ones. That fallback exists because small models are flaky at tool calling.

## 2. Where the resources actually go

This is the part that decides the Rust question. Figures are typical for these components on Linux/Docker. The existing P3 task ("Measure Ollama memory usage under load") should replace them with real numbers.

| Component | Typical RSS | Rust would change it? |
| --- | --- | --- |
| Model weights, `llama3.2:3b` Q4 | ~2.0–2.5 GB (+ KV cache, grows with context) | **No.** It's llama.cpp (C++) already |
| Model weights, `qwen2.5-coder:7b` Q4 | ~4.5–5.5 GB | No |
| Ollama server process | ~50–150 MB on top of weights | No |
| Postgres 16 (idle, small DB) | ~30–60 MB + its own container | Indirectly: replace with SQLite |
| Node dashboard (Express + ws + pg + OTEL SDK loaded) | ~80–150 MB | Yes. A Rust equivalent is ~8–25 MB |
| Docker Desktop / WSL2 VM tax (Windows) | The VM is capped at **7.47 GiB** on this machine today | No. Only "don't run under Docker Desktop" changes it |

Per chat turn:

- **Model time:** prompt eval plus generation, roughly 0.5–30 s on CPU/laptop GPU depending on model and context.
- **Harness time:** JSON parse/serialize, one HTTP hop, a regex safety pass. Low single-digit milliseconds in Node; Rust would make those ~0.5 ms.

You'd save 1–3 ms out of 2,000–30,000 ms.

**Bottom line:** in the best case a Rust dashboard saves ~100 MB of RAM. A 3B model with a few thousand tokens of context uses 20–50× that. The big wins come from what you load (Postgres, OTEL, three.js, extra containers, model size, context length), not from the language the HTTP glue is written in.

### Where Rust (or any compiled language) does genuinely win

- **Idle footprint on a tiny always-on host** (Raspberry Pi, a $5 VPS used as a remote front-end to a GPU box): 10 MB vs 100 MB matters there.
- **One static binary.** No `node_modules` (154 MB here), no npm supply-chain surface, trivial `systemd` + Tailscale deployment, no Docker Desktop needed.
- **Cold start:** ~5 ms vs ~300–800 ms with the OTEL auto-instrumentation import graph.
- **Portfolio signal:** "agent harness in Rust" reads as more systems-y than "Express app".

None of these are performance problems you have today. Two of them (single binary, no Docker Desktop) can be had by trimming the Node app (section 5).

## 3. The real ceiling: small models, not the harness

Given the hardware (a 16 GB Windows host with an RTX-3070-class 8 GB GPU, per the `laptop` profile), the practical ceiling is a 7–8B model at Q4. At that size:

- Tool-call reliability is mediocre: wrong argument shapes, hallucinated tool names, prose instead of calls. The codebase already patches around this with `parseTextToolCall` and the CWE-862 allowlist.
- Context is effectively 4–8k tokens before speed and quality fall off. Every tool schema, system prompt and safety preamble you send eats into it.
- Every iteration of the 5-step loop costs a full prompt re-eval unless the KV cache is reused.

So "efficient and impressive" with small models depends on things that work the same in Node and in Rust:

1. **Constrained decoding (to be tested).** Ollama's `format` (JSON mode or a JSON Schema) constrains `message.content`; it is documented separately from `tools`/`message.tool_calls` and isn't known to constrain native tool calls. The approach to try for small models: on tool turns, skip native `tools`, set `format` to a schema of `{tool: enum[offered names], arguments: object}`, and parse the content ourselves. `parseTextToolCall` already handles content-encoded calls. Keep the existing tool allowlist and text-call fallback either way. Measure malformed-call rates per model and Ollama version before treating it as the biggest quality lever; it's currently unused.
2. **Offer fewer tools per turn.** Route first (a cheap 1B classification: "is this a file task, a search task, or chat?"), then expose only 1–3 tools. Today the developer experience offers 4 base tools plus every enabled plugin tool.
3. **Prompt budget.** Measure tokens per turn (system + tools + history) and cap them. Trim history by summarizing older turns.
4. **Streaming.** The agent loop uses `stream: false`. On a slow local model, seeing tokens arrive is the difference between "feels broken" and "feels alive". `session-stream.js` streams plain chat but not the tool loop.
5. **Keep the model warm and prefix-stable.** You already set `OLLAMA_KEEP_ALIVE=30m`. Also keep the system prompt plus tool block byte-identical across turns so llama.cpp can reuse the KV prefix.
6. **Hybrid routing as a first-class path.** BYOK already exists (`CUSTOM_LLM_ENDPOINTS`). The honest "impressive" setup is a local small model for routing, safety and cheap turns, escalating to a hosted model (OpenRouter/Claude) for hard turns, with a cost/latency readout in the UI. That's a better demo than "my 3B model tried to write code".

## 4. Should you run it at all (Tailscale, always-on)?

What you'd be getting: a private web UI on your tailnet where you can chat with local or BYOK models and let them run tools in a sandboxed checkout from your phone.

**Blocker before it touches a network:** there is no auth. `/api/workspace/exec` and the worktree launch route run shell commands unauthenticated (ROADMAP 2027 Q1 already says so), and `ENDPOINT_STORE_SECRET` falls back to a hard-coded default. Tailscale ACLs reduce exposure to your own devices, which is a reasonable interim boundary for a single user. But any compromised device or shared node on the tailnet then gets shell access. Before exposing it:

- Ship the "scoped API token for exec-capable routes" ROADMAP item (a shared-secret header). It's about a day of work.
- Fail closed when `ENDPOINT_STORE_SECRET` is unset instead of using the default.
- Bind to the Tailscale interface only, or use `tailscale serve`, which adds HTTPS and identity headers you can check.

**Is it worth it versus off-the-shelf?** Be honest with yourself here:

| Option | Gets you | Effort |
| --- | --- | --- |
| Open WebUI + Ollama + Tailscale | Chat, RAG, model switching and auth on your phone, today | ~1 hour |
| Claude Code via Remote Control / cloud sessions | A far more capable agent from anywhere, already part of your workflow | 0 |
| motor-pool, trimmed + auth + Tailscale | Your own harness: safety layer, experiences, sandboxed tools, observability, your design choices | ~1–2 weeks of trimming |

motor-pool is worth running if the point is **owning and understanding the harness**: learning, portfolio, and a testbed for safety and agent-loop ideas. It isn't worth running as a daily-driver assistant. Open WebUI and Claude Code beat it there, and will keep beating it.

## 5. Recommended path: "skin it to the bone" in Node (no rewrite)

Goal: a **lean profile** that idles under ~300 MB total excluding model weights, starts in under 2 s, and is one `docker compose up`, or one `node` process with no Docker at all.

### Phase A: lean default (≈1 week)

- [ ] **SQLite instead of Postgres** for sessions/tasks/endpoints (`better-sqlite3` or Node 22+'s built-in `node:sqlite`). Drops a container and ~50 MB. Keep `pg` behind `DATABASE_URL` for anyone who wants it.
- [ ] **Load OTEL lazily.** Only `import()` the SDK and auto-instrumentations when `OTEL_ENABLED=true`. Today they sit in `dependencies` and dominate the import graph, cold start and RSS.
- [ ] **Code-split three.js.** `React.lazy` the LiminalDashboard so the default bundle drops from 923 KB toward ~250 KB, under the METRICS <500 KB target. Make the plain session list the landing view on phones.
- [ ] **Feature flags read once at boot** (`MP_FEATURES=chat,tools,workspace`). Routers for docker control, worktrees/tmux, bb-mcp, content/website tools, discover and webhooks aren't mounted unless enabled. Less code loaded is less attack surface.
- [ ] **Delete dead weight:** NemoClaw (crash-looping, P3-deferred), OpenLLM (deferred), the Blackboard showcase (a separate product). Move content-gen/website tools out to their own repo or profile so the core is just a harness.
- [ ] **A "no Docker" run mode:** `node server.js` against a host Ollama. Docker Desktop's VM tax is the largest non-model overhead on Windows.

### Phase B: make small models look good (≈1 week)

- [ ] Try schema-constrained tool selection via Ollama `format` (content-encoded calls, not native `tool_calls`; see section 3) and measure malformed-call rates.
- [ ] Route, then expose a minimal tool set per turn.
- [ ] Stream the agent loop, sending tokens and tool events over the existing `/ws/events`.
- [ ] Token budget meter per turn in the UI (prompt / tools / history / output).
- [ ] Hybrid escalation: local first, BYOK on failure or `/escalate`, with cost shown.

### Phase C: always-on (≈2–3 days)

- [ ] Exec-route token, fail-closed secret, `tailscale serve` recipe in `DEPLOYMENT.md`.
- [ ] Phone-first UI pass (journeys already found #96/#97 on phone layout).
- [ ] Measure and publish real numbers in METRICS: idle RSS per container, cold start, tokens/s, p50 turn latency. That closes the existing Ollama-memory P3 task.

If Phase A's measurements show the dashboard process is still a meaningful share of the lean footprint (unlikely), revisit section 6 with data.

## 6. If you want Rust anyway: build `motor-pool-lite`, don't port

There are good non-performance reasons to want Rust: learning it, portfolio signal, a single-binary deploy. If those are the goal, scope it as a **new, deliberately small binary** that does the core loop only, and leave the Node app as the "full" edition.

**Scope (≈2–3k lines of Rust, 3–5 weekends):**

- `axum` + `tokio` HTTP/WebSocket server, `reqwest` to Ollama/OpenAI-compatible endpoints with streaming.
- `rusqlite` for sessions.
- An agent loop with 4 tools (`read_file`, `write_file`, `list_files`, sandboxed `bash`), schema-constrained calls, max-iteration and token budgets.
- A port of `safety.js`'s normalize/classify/redact (it's regex and string work, which Rust's `regex` crate does well). Port its test cases as golden tests; at 99% coverage they make a ready-made spec.
- A tiny static UI (plain HTML/JS or the existing chat column, built once and embedded with `include_bytes!`/`rust-embed`).
- Auth from day one: a bearer token, plus Tailscale identity headers when behind `tailscale serve`.
- Out of scope: Docker control, tmux worktrees, 3D view, plugins, MCP registry, OTEL, webhooks, Blackboard, content/website tools.

**Expected result:** a ~10–15 MB static binary that idles at ~10–20 MB RSS, cold-starts in under 50 ms, needs no Docker, and runs as a `systemd`/Windows service next to Ollama. A genuinely neat portfolio piece. But note what it buys: ~100 MB of RAM and a nicer deploy story, not faster or smarter agents.

**Full port (not recommended):** ~23k lines, 19 route modules, a React frontend you'd keep anyway, and Docker/tmux/git process orchestration that is clumsier in Rust than in Node. Realistically 3–6 months of solo evenings, with the test suite rewritten from scratch, for the same 1–3% resource win. The opportunity cost is everything in section 5.

**Go is the middle option** if what you mostly want is a single binary with low RSS: about half the Rust effort for ~80% of the footprint win, though less portfolio novelty.

## 7. Honest assessment of what's been built

### Strengths

- **Security instincts are real, not decorative.** Agent shell commands get a scrubbed env (CWE-200 comment and allowlist). Tool calls are checked against the set actually offered (CWE-862). The `__` plugin-name injectivity is reasoned through. Agents work in a sandbox checkout by default with no `.env`. The tmux exec allowlist is empty by default. This is better than most hobby agent harnesses.
- **Engineering hygiene:** 81% coverage with an honest explanation of each gap, a CI gate, nightly visual journeys, a PR-per-change history, and docs that actually track reality.
- **Refactored, not rotting:** monolith files were split into routes/modules/hooks with clear seams. The largest file is under 900 lines.
- **Works with your constraints:** device profiles, keep-alive tuning and warmup show it was built against real hardware pain, not in theory.

### Weaknesses

- **Scope sprawl is the biggest problem.** One repo is trying to be a chat UI, a safety gateway, an IDE with a terminal, a Docker control panel, a 3D mind map, an MCP registry, a Blackboard showcase, a video generator front-end and a B2B website lead-gen agent. Each piece is OK; together nothing is excellent, and the default stack carries all of it.
- **No auth, with shell-exec routes.** It can't be exposed anywhere, which defeats the always-on use case.
- **The core agent loop is the least developed part:** non-streaming, no constrained decoding, no token budgeting, no history management, a fixed 5-iteration cap. The headline feature is thinner than the periphery.
- **Dead and deferred services still in the tree** (NemoClaw, OpenLLM). The bundle is 2× its own target. Several METRICS rows are still "TBD".
- **It mostly re-implements what Open WebUI and Claude Code already do well.** Its differentiation (safety layer, experiences, sandboxed tools) isn't yet front and centre.

### Grade

| Dimension | Grade | Note |
| --- | --- | --- |
| Code quality & structure | B+ | Modular, readable, defensive |
| Testing & CI | A− | Coverage, journeys, gate; gaps explained |
| Security posture | C+ | Excellent inside the box; no lock on the box |
| Core agent capability | C | Works, but nothing beyond a basic loop |
| Product focus | D+ | Too many products in one repo |
| Docs & process | A | Better than most production teams |
| Fitness for "always-on via Tailscale" | C− | Blocked on auth and footprint, both fixable |
| **Overall (engineering artifact)** | **B−** | A solid, well-tested learning harness |
| **Overall (as a product you'd use daily)** | **C+** | Off-the-shelf tools beat it today |

It's a good harness for learning and showing your work. Its problem is breadth, not language. Cut it to chat + safety + sandboxed tools + auth, make small models behave with constrained decoding and routing, and measure. That's a B+/A− project you'd actually leave running. A Rust rewrite would get you a C+ project that idles 100 MB lighter.

## 8. Decision checklist

- [ ] Decide what motor-pool *is*: a harness testbed (keep it, trim it) or a daily assistant (adopt Open WebUI / Claude Code, archive this).
- [ ] If keeping it: Phase A → B → C above, then re-measure.
- [ ] Only then, and only for learning or portfolio reasons: `motor-pool-lite` in Rust, scoped as in section 6.

## 9. Addendum: big host, gov/edu, 9router and a BM25 registry

The original sections assumed a single user on a 16 GB laptop. The stated target is different: **motor-pool on one large shared machine, serving many users and uses, for government and schools that can't or won't send data to a hosted vendor.** This section re-runs the analysis for that target.

### 9.1 What 9router#3575 does, and why it matters more for local models

The PR (`toolFilter.js` 76 lines, `toolDisclosure.js` 270, `toolBudget.js` 100, all JS, MIT-licensed upstream) adds three passes before the request goes upstream:

1. **Static filter:** include or exclude by server prefix, exact name or description pattern.
2. **BM25 disclosure:** index the tool schemas once per connection, score them against the latest user message, and send only the top `maxTools`. It always pins `ToolSearch`, `tool_choice`-forced tools and tools already referenced in history.
3. **Context budget:** estimate tokens (JSON bytes / 4) and cull tool schemas, never history, until the request fits the target model's input budget, with a hard ceiling.

On a 200k-context frontier model this saves 10–15% per turn. **On a local model it decides whether the turn works at all.** At ~200 tokens per schema, 20 tools is ~4k tokens, which is half of an 8k context, and CPU or small-GPU prompt eval is the slow part of every turn. Disclosure is the most valuable item in section 3, and a better form of its "route, then offer 1–3 tools" idea: BM25 costs no model call, while a 1B router model costs a full model call per turn.

### 9.2 Connect to 9router, or bring the code in? Both, for different reasons

| | **A. Use 9router as an upstream endpoint** | **B. Native disclosure in motor-pool** |
| --- | --- | --- |
| How | Register 9router (`http://9router:20128/v1`, OpenAI-compatible) in `CUSTOM_LLM_ENDPOINTS`; sessions pick it like any BYOK endpoint | Port `toolFilter`/`toolDisclosure`/`toolBudget` into `dashboard/modules/` (keep the MIT notice), and call it inside `runAgentLoop` before each model call |
| Gets you | Its routing, fallback, RTK/headroom compression and disclosure for hosted models, today, for zero code | Disclosure on **every** endpoint, including direct Ollama/vLLM, plus plugin tools and the future registry |
| Limits | Applies only to traffic that passes through 9router. Its disclosure is still an open PR, not merged upstream. It's a third-party dependency in the trust boundary | You own maintenance; it starts as a fork of upstream logic |
| Gov/edu fit | OK for dev and for routing to approved hosted providers; needs vetting (no telemetry, pinned image digest) before a deployment | Required: the registry is the product and has to live in-process |

**Recommendation:** do A this week (it's configuration only), and B as the first real feature of the registry work. Shared language is a concrete reason not to rewrite in Rust: every improvement made in 9router can move into motor-pool as a copy instead of a re-implementation.

**Compression ("bells and whistles"):** take the **deterministic** parts: tool-output truncation, dedupe, RTK-style command-output trimming, stable-prefix ordering for KV-cache reuse. Be wary of **model-based** compression (LLM summarization of history) on local hardware. It spends a model call to save model tokens, which only pays off on long sessions, so make it opt-in with a threshold.

### 9.3 The collective BM25 agent/tool registry

The idea: one registry of tools **and** agents (an agent is just a tool with a description), retrieved per turn with BM25. Ranking improves with "collective" usage: which tools actually got called, and succeeded, for which kinds of request.

A design that fits the codebase:

- **Two text fields per entry:** (1) the authored doc: name, description, parameter names; (2) a learned doc: redacted snippets of past requests that led to a *successful* call of that entry, a lightweight form of doc2query. Score = BM25(doc) + w · BM25(usage), with the usage field capped so popular tools can't drown out new ones.
- **Cold start:** with no usage data it behaves exactly like 9router#3575, so it is never worse than the baseline.
- **Sources:** `config/mcp-registry.json`, the plugin loader, BYOK endpoints and agent definitions all feed one index. Rebuild on registry change, as 9router does per `connectionId`.
- **Evaluate before trusting it:** log (query, offered tools, called tool, outcome) and report recall@k, i.e. "was the tool the model needed among the k offered?", on held-out turns. Ship the learned field only if it beats descriptions alone.

**For gov/edu, "collective" is where the legal risk is.** Usage snippets are user prompts: student data under FERPA (COPPA for under-13s), and for agencies possibly CJIS or other controlled data. Rules that make it defensible:

- Run every snippet through `safety.js` redaction **before** indexing, and store the redacted form only.
- Keep the learned field **per tenant** (district or agency) by default. Share across tenants only as aggregate counts (tool X selected N times for term set Y), never raw text.
- Set a retention limit, provide an admin-visible "what the registry learned" view, and a per-tenant off switch.

### 9.4 What changes about the earlier assessment

- **Rust verdict: unchanged, and stronger.** A big shared host makes **concurrency** the real bottleneck. Ollama serves one request per model at a time by default (`OLLAMA_NUM_PARALLEL` raises that) and batches less efficiently than dedicated servers; benchmark the intended workload before switching. For many concurrent users, put **vLLM** (continuous batching, paged KV cache) or **llama.cpp server** with parallel slots behind the gateway. Neither choice depends on the language the gateway is written in.
- **Hardware assumption flips.** On a big GPU host, 30B-class or MoE models are practical, so tool-calling quality improves a lot. Constrained decoding and disclosure still matter, now for throughput and cost per user rather than for viability.
- **Product focus: problem solved, if you commit to it.** "Private AI gateway with a tool/agent registry for gov/edu" is a clear product. Keep chat, safety/PII, sandboxed tools, endpoints/BYOK, MCP registry, observability and replay/audit. Move out the website lead-gen agent, content-gen, the Blackboard *showcase* framing (bb-mcp becomes one integration in the registry, which is actually a great edu demo), Docker control and tmux worktrees. Keep the 3D view as an optional admin visual.
- **Security moves from C+ to a hard gate.** No institution can pilot this without these, so they become the new Phase 0:
  - SSO: SAML/OIDC, because districts use Google Workspace or Entra and agencies use Login.gov or Entra.
  - Tenants and roles: tenant → role → route/tool permissions, i.e. the ROADMAP 2027 Q3 RBAC item, pulled forward.
  - Audit log: the 2027 Q3 item, pulled forward. Who ran which tool on what data.
  - Hardening: fail-closed secrets, encryption at rest, a documented data flow, an air-gapped install path, and an accessibility pass targeting WCAG 2.1 AA (Revised Section 508 itself references WCAG 2.0 A/AA; some buyers require 2.1 AA).
- **"Can't trust Anthropic"** is better framed as "**model-agnostic and data-resident**". Many agencies will want frontier models through their own contracts (Bedrock GovCloud, Azure Government) next to local ones. A gateway that routes to *their* approved endpoints, local or hosted, with policy per tenant, sells better than "local only" and avoids looking like it competes with the vendors they already use.
- **Be clear-eyed about the competition.** Open WebUI + LiteLLM is what many universities and some agencies already self-host. The pitch has to be what they lack: per-turn tool/agent retrieval that makes small or local models usable with large tool catalogs, PII safety and audit built in, sandboxed agent execution, and gov/edu compliance as a first-class design goal rather than an afterthought.

### 9.5 Revised order of work

1. **Now (config only):** add 9router as a BYOK endpoint and try motor-pool sessions through it.
2. **Phase 0, gate:** exec-route token → SSO/OIDC → tenants + RBAC → audit log.
3. **Phase 1, registry:** port the disclosure modules natively, unify tools/MCP/plugins/agents into one index, log offered vs. called tools, and report recall@k.
4. **Phase 2, serving:** a vLLM or llama.cpp-server profile for multi-user batching, plus constrained decoding and streaming in the agent loop.
5. **Phase 3, learned registry:** a redacted, per-tenant usage field, but only if the recall@k data says it helps.
6. **Phase 4, compliance packaging:** air-gapped install, data-flow and FERPA documentation, an accessibility audit, then one pilot district or agency.

**Revised product grade, conditional:** still C+ today. If Phase 0 and Phase 1 ship with measured recall@k and one pilot, this is a credible B+ niche product, which is more than a Rust rewrite could do for it.

## 10. Target architecture: safe async agents with role-based control

The intent, as stated: one place that **hosts one or more models, is the front end for them, combines them into agent setups, and runs those agents asynchronously in their own sandboxes**. What an agent may do depends on who asked (student, teacher, admin, employee, intern), and how it spends (local, 9router, frontier) is a policy choice.

### 10.1 Where it is today

- `task-runner.js` (91 lines) keeps tasks in an in-memory `Map`, polls every 5 s, runs **one task at a time**, and dispatches it as a chat turn.
- Tools (`bash`, `write_file`, …) execute **inside the dashboard process**, against one shared `agent_workspace` volume.
- Parallelism means tmux windows plus git worktrees (`routes/worktrees.js`), still inside the same container.
- "Experiences" (Developer / Research / Safe Chat) already bundle an endpoint, tools and a safety mode. That's the seed of the "setup" concept below.

The sandbox *inside* the box is thoughtful (scrubbed env, tool allowlist, no `.env`). But every agent shares one process, one filesystem and one network identity, and nothing survives a restart. That's fine for a demo, and not something you can offer a school.

### 10.2 Five concepts

| Concept | What it is | Grows out of |
| --- | --- | --- |
| **Model pool** | Every model you can reach (local vLLM/llama.cpp/Ollama, 9router, BYOK, agency-contracted frontier), each tagged with cost, context size, speed and the **highest data classification it may receive** (e.g. student PII → local only) | `llm-config.js`, `endpoint-store.js`, device profiles |
| **Blueprint** (a "setup") | A named agent recipe: roles → models (router, planner, worker, safety checker), a registry query or tool allowlist, sandbox profile, budget, approval rules, output contract | Experiences |
| **Policy** | Tenant × role → allowed blueprints, models, tools, data classes, spend caps, which side effects need approval | New; the RBAC item, pulled forward |
| **Job** | One async run of a blueprint for a user: durable, resumable, observable, with artifacts and an audit trail. Subagents are child jobs | `task-runner.js`, tasks routes |
| **Runner** | Executes one job in a fresh, disposable sandbox, then destroys it | Replaces tmux worktrees |

Example policy rows:

- **Student:** "Tutor" and "Research helper" blueprints; local models only; no shell; web search through a filtered proxy; 50k tokens a day.
- **Teacher:** adds "Grade assistant" (bb-mcp read-only) and "Lesson builder"; may escalate to the district's contracted frontier model; writes to the LMS need approval.
- **Employee / intern:** "Dev agent" with shell in a sandbox. The intern's PRs and outbound messages always go to an approver; the employee's run without approval inside their own repos.
- **Admin:** manages blueprints, the model pool and budgets, and reads audit logs, but doesn't see student content by default (separation of duties).

### 10.3 How a job runs

```
user ──▶ gateway (auth, policy, registry, model routing, audit)
             │  enqueue job (Postgres)
             ▼
        scheduler ──▶ runner supervisor ──▶ [ sandbox: agent loop + tools + workspace ]
                                                │  all egress goes back through the gateway
                                                ▼
                                    gateway: model calls, tool/MCP calls, web
```

Design rules that make it safe rather than just isolated:

1. **The sandbox holds no credentials and has no direct network access.** Its only route out is the gateway, so every model call, MCP call and web fetch passes through policy, PII redaction, budget accounting and the audit log. API keys, LMS tokens and repo credentials stay in the gateway (credential brokering). This is the single most important rule; it makes "a student can't exfiltrate data" and "an intern's agent can't push to main" properties you can enforce, not hopes.
2. **Capabilities only shrink.** A subagent's policy is the intersection of its parent's policy and its own blueprint. A child can never get a tool, model, data class or budget its parent didn't have.
3. **Side effects go through approval gates.** The agent works freely in its scratch workspace. Anything that leaves it (a commit pushed, an email sent, a grade written, a file shared) becomes a proposed action that policy can auto-approve or route to a human. Async work makes this natural: the user gets "your job finished; 2 actions await approval".
4. **Durable and resumable.** Job state, step log and artifacts live in Postgres plus object or volume storage. If a runner dies, the job can resume from its last checkpoint instead of starting over.
5. **Budgets are enforced, not just reported.** Tokens, money and GPU-seconds are counted per job, per user and per tenant at the gateway. Routing tries the cheapest model in the pool that satisfies the blueprint and data class, and escalates only if policy and the remaining budget allow.

### 10.4 Isolation tiers (pick by role and blueprint)

| Tier | Mechanism | Startup | Use for |
| --- | --- | --- | --- |
| 0 | In-process tools (today) | 0 | Read-only chat helpers only |
| 1 | Rootless container per job, seccomp, read-only rootfs, CPU/mem/pid/time limits, egress only to the gateway | ~0.5–1 s | Staff dev agents, research |
| 2 | gVisor (`runsc`) per job | ~1–2 s | Student-facing agents that execute code |
| 3 | Firecracker or Kata microVM per job | ~150 ms–2 s | Untrusted code, multi-tenant gov workloads |

Start with tier 1; tiers 2 and 3 are runtime flags on the same runner interface. **The dashboard must never hold the Docker socket.** A small, separate **runner supervisor** with a tiny API ("start this image with these limits, stream logs, kill it") is the only privileged component.

**This is the one place Rust genuinely earns its keep.** The supervisor is small, privileged, long-running and security-critical, exactly the profile Rust is good at (Firecracker and youki are both Rust). If you want a Rust component for real reasons rather than performance theatre, make it this: ~1–2k lines, built separately, with the gateway staying in Node.

### 10.5 Corrections to earlier sections

- **Keep Postgres.** Section 5's "SQLite instead of Postgres" applies only to a single-user lite edition. A multi-user job system wants Postgres: the job queue via `SELECT … FOR UPDATE SKIP LOCKED`, audit log, tenants and policy. No Redis or Kafka needed at this scale.
- **Retire tmux worktrees** once tier-1 runners exist. Git worktrees still make sense *inside* a job's workspace.
- **The event bus becomes job event streaming:** step started, tool called, approval needed, artifact produced, job done, fanned out to the UI over the existing `/ws/events`.
- **Policy engine:** begin with a plain Postgres table checked in one middleware. If rules get complex, use Cedar (it has a JS/WASM binding, is purpose-built for this "principal → action → resource" model, and its policies can be audited and shown to procurement).

### 10.6 Build order (supersedes 9.5 where they differ)

1. **Gate:** exec-route token → SSO/OIDC → tenants, roles and a policy table → audit log.
2. **Jobs:** a durable Postgres job queue, job/step/artifact tables, concurrent workers, and job events over WebSocket. Still in-process tools for now, behind the same interface the runner will implement.
3. **Runner, tier 1:** a separate supervisor, a per-job rootless container with no credentials and gateway-only egress, artifacts out, sandbox destroyed afterwards. Then retire tmux.
4. **Blueprints and model pool:** migrate experiences to blueprints, add data-class tags on models, cheapest-first routing with escalation, and enforced budgets. 9router becomes one pool member.
5. **Registry:** native BM25 disclosure (section 9) feeding blueprints' tool sets.
6. **Approvals and subagents:** proposed-action queue with approve/deny UI; child jobs with shrinking policy.
7. **Hardening for pilots:** gVisor tier for student blueprints, air-gapped install, FERPA data-flow doc, accessibility pass.

Each step is independently demoable. Steps 1–3 alone make the "safe async agent" claim true at a basic level.

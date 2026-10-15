# Rust Rewrite Assessment

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · [Tasks](./TASKS.md) · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

Written 2026-10-15 against `master` @ `c0864c1`. It answers three questions:

1. Should motor-pool be rewritten in Rust?
2. Is it worth running at all as an always-on agent reachable over Tailscale?
3. How good is what has been built so far?

## TL;DR

**Don't rewrite it in Rust. Cut it down instead.** On a box that runs local models, nearly all of the RAM, CPU and latency goes to the model runtime. Ollama/llama.cpp is already native C++, and the Node dashboard is a rounding error beside it: roughly 100 MB of a 3–8 GB working set, and milliseconds of overhead on turns that take seconds. A rewrite would cost months of evenings and a 70-file test suite to win back maybe 1–3% of memory. It would do nothing for the actual ceiling, which is that 1–7B local models are unreliable at tool calls. To get "efficient and impressive", make the product smaller: one container, SQLite, no default telemetry, a 3D view that loads only when opened, streaming and schema-constrained tool calls, and an auth gate before anything goes on a tailnet. If you still want Rust for its own sake, build a small new binary (`motor-pool-lite`, section 6), not a port.

**Grade: B− as an engineering artifact, C+ as a product.**

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

1. **Constrained decoding.** Pass a JSON schema via Ollama's `format` field for tool turns, so the model *can't* emit malformed calls. This is the single biggest quality lever, and it's currently unused.
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

- [ ] Schema-constrained tool calls via Ollama `format`.
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

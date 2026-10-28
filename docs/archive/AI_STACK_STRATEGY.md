# AI Stack Strategy

> 🧭 [agent-board](../../README.md) · [Features](../FEATURES.md) · [Roadmap](../ROADMAP.md) · [Tasks](../TASKS.md) · [Changelog](../CHANGELOG.md) · [Metrics](../METRICS.md) <!-- nav -->
>
> Local orchestration architecture for motor-pool, Kryptos, and personal automation

**Last updated:** June 2026
**Author:** nitsuah
**Status:** Historical strategy snapshot — check the current README, Deployment, Roadmap, and Metrics docs before acting on its hardware assumptions, model picks, or priorities.
Repos: `motor-pool`

---

## TL;DR

**motor-pool is the local orchestrator.** Everything else is either a service it wraps, a tool it registers, or a parallel consumer of the same local LLM endpoints. Claude Code, Kryptos, and personal tools can all reach local models directly — motor-pool is the UI and lifecycle manager, not a mandatory proxy.

```
┌─────────────────────────────────────────────────────────────┐
│                       YOU (human)                           │
├──────────────┬──────────────────┬───────────────────────────┤
│  motor-pool │     Odysseus     │     Claude Code           │
│  (local ops) │  (personal use)  │  (coding agent)           │
├──────────────┴──────────────────┴───────────────────────────┤
│              shared local LLM layer                         │
│         Ollama  │  OpenLLM  │  Docker Model Runner          │
├─────────────────────────────────────────────────────────────┤
│              vector / memory layer                          │
│    turbovec (embedded)  │  pgvector (Thoth only)            │
├─────────────────────────────────────────────────────────────┤
│              sandbox / safety layer                         │
│                     NemoClaw                                │
└─────────────────────────────────────────────────────────────┘
```

**Do first (no infra overhaul):** embed turbovec in Kryptos, add OpenLLM to compose, point Odysseus at Ollama.
**When cloud rate-limits hit:** Ollama + `qwen2.5-coder` via Claude Code or Odysseus — keep AirLLM off.

---

## Table of Contents

1. [Prioritization Queue & The Why](#prioritization-queue--the-why)
2. [Rate-Limit Fallback Strategy](#rate-limit-fallback-strategy)
3. [The Tools — Honest Breakdown](#the-tools--honest-breakdown)
4. [Architecture & Direction](#architecture--direction)
5. [What to Avoid](#what-to-avoid)
6. [Open Questions](#open-questions)

---

## Prioritization Queue & The Why

Items are ordered by impact-to-effort ratio. Each phase builds on the last — don't skip Q2 GPU work before trying AirLLM, and don't containerize turbovec.

### Now — Low-Hang, High-Value (No Infra Overhaul)

| # | Action | Why |
|---|--------|-----|
| 1 | **Embed turbovec in Kryptos FastAPI** | Instantly gives cipher/hypothesis RAG over `artifacts/` with zero architectural risk, massive vector compression (16×), and no heavy database baggage. Pure `pip install` — no ports, no migrations. |
| 2 | **Add OpenLLM to `docker-compose.yml`** | Establishes your second OpenAI-compatible endpoint type on port `8082` for custom/fine-tuned models, running alongside Ollama. Best home for HuggingFace models that don't fit Ollama's Modelfile pattern. |
| 3 | **Point Odysseus at Ollama (`localhost:8081`)** | Unblocks a fully functional, out-of-the-box personal chat and daily-driver assistant today while motor-pool matures in the background. Shares the same inference layer — no duplicate model loading if you coordinate ports. |

**Concrete steps:**

```bash
# 1. Kryptos
pip install turbovec
# Index artifacts/ in-process inside the existing FastAPI container

# 2. Compose — add llm_openllm service
# Host 8082 → container 3000; register as `openllm` in motor-pool endpoint config

# 3. Odysseus settings
# Backend URL: http://localhost:8081/v1
```

---

### Q2 — The Core Architectural Lift (GPU & Orchestration)

| # | Action | Why |
|---|--------|-----|
| 4 | **Enable GPU/CUDA in Compose** | Crucial for actual performance on your RTX 4080 target. Unlocks native speeds for both Ollama (`device: gpu`) and OpenLLM (CUDA flags). Without this, local fallback during rate limits feels sluggish. |
| 5 | **Build the motor-pool MCP server** | The architectural keystone. Lets powerful tools like Claude Code consume motor-pool's local capabilities (sandbox execution, task routing, container status) directly — motor-pool becomes a provider, not just a UI. |
| 6 | **Unify the Container Lifecycle API (models + MCP tools)** | Avoids building two separate on-demand spin-up systems. Use the same primitive to spin up Thoth (research), a custom model container, or Playwright — one registry, one lifecycle API, two container types. |
| 7 | **Build the AirLLM FastAPI wrapper** | Packages layer-streaming as an on-demand, opt-in endpoint so you can run 70B+ models on restricted VRAM when needed. ~50 lines; register as `airlite` in the model registry. Not for real-time coding — see [Rate-Limit Fallback](#rate-limit-fallback-strategy). |
| 8 | **MCP container manager → register Thoth first** | Thoth's 60 MCP tools surface through motor-pool's tool registry. Spin up on research tasks, tear down when idle. Keeps PostgreSQL/pgvector isolated from motor-pool's SQLite. |
| 9 | **turbovec in motor-pool tool registry** | In-process capability matching for MCP tool discovery. No new infra — same library, second namespace. |

**The Q2 design constraint:** Items 5, 6, and 8 must be designed together. The MCP server exposes what the lifecycle API manages. Don't ship the server without the unified registry.

---

### Q3+ — Polishing & Deep Workspace RAG

| # | Action | Why |
|---|--------|-----|
| 10 | **motor-pool File I/O + turbovec file search** | Lets agents safely search and author code across your entire workspace. Semantic search over agent-accessible files once mounts land. |
| 11 | **bb-mcp + Blackboard frontend** | UI layer for multi-agent coordination via motor-pool dashboard. |
| 12 | **Swap Thoth's RAG layer to turbovec** | Guts Thoth's heavy PostgreSQL/pgvector footprint, minimizing background resource drain. Thoth keeps Letta memory and Obsidian integration; only the vector store changes. |
| 13 | **Multi-tenancy + RBAC** | Required before exposing motor-pool beyond localhost. |

---

## Rate-Limit Fallback Strategy

When Anthropic or Google returns **"Rate limit exceeded"** or **"Quota exhausted"**, this is the default local combo to keep moving without architectural changes.

### The Backend: Ollama + Qwen 2.5 Coder

| Variant | When to use | VRAM (approx.) |
|---------|-------------|----------------|
| `qwen2.5-coder:7b` | Snappy completions, rapid-fire edits, tool use | ~5 GB |
| `qwen2.5-coder:14b` | Balanced reasoning + speed | ~9 GB |
| `qwen2.5-coder:32b` | Deep architectural reasoning, heavy debugging | ~20 GB |

**Why Qwen 2.5 Coder is the default:** Current state-of-the-art for local, open-weights code generation, reasoning, and tool use. Highly optimized under Ollama, fast on RTX 4080, and natively understands markdown, logic puzzles, and structural orchestration.

```bash
ollama pull qwen2.5-coder:7b   # default daily driver
ollama pull qwen2.5-coder:14b  # when 7b isn't enough
ollama pull qwen2.5-coder:32b  # deep work only
```

### The Frontend: Direct Routing (Bypass the Cloud)

| Use case | Client | Endpoint |
|----------|--------|----------|
| Terminal coding | **Claude Code** | Configure external OpenAI-compatible provider → `http://localhost:8081/v1` (Ollama) or `http://localhost:8082/v1` (OpenLLM) |
| Brainstorming, research, planning | **Odysseus** | Already pointed at Ollama — acts as your local ChatGPT/Gemini clone |
| Orchestrated tasks | **motor-pool** | REST API + eventual MCP tools — use when you need sandbox execution or task routing, not for raw speed |

**Key point:** Claude Code and Odysseus hit inference endpoints directly. motor-pool does not sit in the hot path for rate-limit fallback. It's a parallel consumer of the same endpoints.

### Critical Guardrail

> **Turn AirLLM off during rate-limit emergencies.**

Layer-streaming is too slow for fluid, real-time interactive coding. Stick to Ollama or OpenLLM with models that fit comfortably inside your RTX 4080's VRAM. Reserve AirLLM for offline batch work on 70B+ models when latency doesn't matter.

| Scenario | Use | Avoid |
|----------|-----|-------|
| Cloud rate-limited, need to keep coding | Ollama + qwen2.5-coder | AirLLM |
| Need custom fine-tuned model | OpenLLM on 8082 | Running OpenLLM + AirLLM simultaneously |
| Need 70B+ for one-off analysis | AirLLM wrapper (opt-in) | Expecting interactive latency |

---

## The Tools — Honest Breakdown

### motor-pool (yours)

**Role:** Local orchestrator, ops cockpit, MCP container manager
**Layer:** Control plane

**What it does today:**
- Persistent LLM session management across Ollama + Docker Model Runner endpoints
- Webhook ingestion → task routing → event bus → agent lifecycle (start/stop/restart)
- NemoClaw sandboxed execution with `--cap-drop=all`
- OpenTelemetry tracing, structured JSON logging, health endpoints
- React dashboard with live Docker container status

**What it becomes in Q2/Q3:**
- GPU/CUDA-aware model loading (RTX 4080 target)
- MCP container manager — spins tool containers up/down on demand
- Unified lifecycle API for models and MCP tool containers
- MCP server — exposes motor-pool to Claude Code, Kryptos, and other consumers
- File I/O + workspace mounts for code authoring
- turbovec for tool registry + file search
- Multi-tenancy + RBAC
- bb-mcp / Blackboard frontend layer

**The key architectural insight:** motor-pool's MCP container manager and its model lifecycle logic are the same primitive applied to two different container types. Design them together — one registry + lifecycle API — so you're not maintaining two separate on-demand spin-up systems.

| Pros | Cons |
|------|------|
| Your codebase — you control the roadmap | JavaScript/Express — friction for inline Python tooling |
| Local-first, no external API calls | No MCP server yet (Q2) — consumer, not provider |
| NemoClaw safety sandbox wired | Model lifecycle implicit — no keep-warm/evict logic |
| OpenTelemetry + structured logging in place | No vector search layer yet |
| Webhook + REST API ready for integration | |

**Verdict:** This is the hub. Everything else is a spoke.

---

### Ollama

**Role:** Commodity local model server
**Layer:** Inference endpoint (primary)

**What it does:**
- Serves Modelfile-based models as OpenAI-compatible `/v1/chat/completions`
- Fast startup, low overhead, excellent for daily-driver models
- `qwen2.5-coder` family is the default for coding and rate-limit fallback

**How it fits:**
- `llm_qwen_coder` service in compose — host port `8081`
- Default backend for Odysseus, Claude Code fallback, and motor-pool sessions
- Use for any model available as an Ollama pull — don't route these through OpenLLM

| Pros | Cons |
|------|------|
| Lowest overhead for standard models | Modelfile pattern doesn't fit all HuggingFace models |
| Hot model swap via `ollama pull` | Single-model-per-GPU without careful management |
| Already wired in compose | Needs Q2 GPU flags for RTX 4080 performance |
| OpenAI-compat — zero consumer changes | |

**Verdict:** Default inference layer. OpenLLM handles the exceptions.

---

### OpenLLM (BentoML)

**Role:** High-throughput OpenAI-compatible model server
**Layer:** Inference endpoint (custom models)

**What it does:**
- Serves any HuggingFace model as `/v1/chat/completions`
- Hot-swap models via CLI without restarting the container
- Multiple simultaneous model endpoints on different ports
- Native CUDA/GPU container support

**How it fits:**
- `llm_openllm` in compose — host `8082` → container `3000`
- Register in motor-pool endpoint config as `openllm`
- Claude Code and Kryptos hit it directly — no motor-pool proxy
- Right inference layer for custom/fine-tuned models that don't fit Ollama

| Pros | Cons |
|------|------|
| OpenAI-compat — zero code changes | Heavier than Ollama for commodity models |
| Multiple simultaneous endpoints | Full model weight in VRAM |
| CUDA-native, aligns with Q2 GPU work | Don't run simultaneously with AirLLM |
| Hot model swap | Another compose service to maintain |

**Integration path:** Add alongside `llm_qwen_coder`. Use Ollama for pulls, OpenLLM for builds.

---

### AirLLM

**Role:** Memory-efficient layer-streaming inference
**Layer:** Inference (Python library → FastAPI wrapper in Q2)

**What it does:**
- Streams model weights layer-by-layer — 70B+ on 4–8 GB VRAM
- No daemon — pure Python; needs a thin FastAPI wrapper to become an endpoint
- Trades throughput for memory headroom

**How it fits:**
- Q2: wrap in FastAPI container, register as opt-in `airlite` endpoint
- Activate only when a task explicitly needs 70B+ AND VRAM can't fit it via OpenLLM
- **Never** the rate-limit fallback — too slow for interactive work

| Pros | Cons |
|------|------|
| Only path to 70B+ on consumer hardware | Slow — real latency cost |
| No server overhead when wrapped on-demand | Single model at a time |
| MIT license, Python-native | VRAM fights with OpenLLM if both run |
| ~50-line FastAPI wrapper | |

**Verdict:** Post-GPU, opt-in only. Not a Q2 day-one priority — ship after lifecycle API is stable.

---

### Thoth

**Role:** AI/ML research pipeline with persistent memory
**Layer:** Specialized agent + knowledge store (on-demand)

**What it does:**
- Ingests papers from ArXiv, Semantic Scholar, NeurIPS, etc. via 7 source plugins
- Letta-based persistent memory — cross-session recall, not context stuffing
- 60 MCP tools across 16 categories
- Hybrid RAG: pgvector (semantic) + BM25 (keyword) — **candidate for turbovec swap in Q3+**
- Obsidian vault integration — writes to `_thoth/`

**How it fits:**
- Q2: register as first MCP container in the unified lifecycle API
- motor-pool spins up on research tasks, tears down when idle
- Isolated Docker network + PostgreSQL — never bleeds into motor-pool's SQLite

| Pros | Cons |
|------|------|
| Obsidian integration (existing vault) | Heavy stack — PostgreSQL, pgvector, Letta |
| Genuine persistent memory | Slow startup — not always-on |
| MCP-native, 60 tools | Specialist — overkill outside research |
| Best for AI/ML literature | Q3 turbovec swap needed to reduce footprint |

**Verdict:** High value for Kryptos research. On-demand only via MCP container manager.

---

### Odysseus

**Role:** Self-hosted personal AI workspace
**Layer:** General-purpose UI / daily driver

**What it does:**
- Chat, autonomous agents, deep research, email tools, memory in one app
- ChromaDB vector memory, SearXNG local search, MCP auto-registration
- Supports Ollama / llama.cpp / vLLM backends

**How it fits:**
- Parallel to motor-pool, not under it
- Point at `localhost:8081` (Ollama) now — immediate personal assistant
- Shares inference layer with motor-pool; separate control plane

**The distinction:** motor-pool is your *ops cockpit* (task routing, lifecycle, orchestration). Odysseus is your *personal assistant* (conversation, drafting, quick research). Different moments, same models.

| Pros | Cons |
|------|------|
| Full-featured today, no build required | Very new — unstable, hardware-sensitive |
| Good Ollama support | ChromaDB + SearXNG adds weight |
| Works while motor-pool matures | Wants to be an orchestrator — resist this |
| Rate-limit fallback frontend | Will overlap with motor-pool Q2/Q3 scope |

**Verdict:** Use now. Reassess when motor-pool MCP server ships. Don't build critical workflows on it.

---

### turbovec

**Role:** Compressed vector index for RAG
**Layer:** Embedded library (no server, no daemon)

**What it does:**
- 16× compression: 31 GB float32 → 4 GB at 2-bit quantization
- No codebook training, no k-means — instant indexing via `pip install turbovec`
- SIMD-accelerated, competitive with FAISS on x86
- Data-oblivious quantizer — any corpus, no training pass

**Where it plugs in:**

| Use case | Phase | How |
|----------|-------|-----|
| Kryptos cipher/hypothesis RAG | **Now** | Embedded in FastAPI — index over `artifacts/` |
| motor-pool tool registry | Q2 | In-process capability matching |
| motor-pool workspace file search | Q3+ | Semantic search over mounted files |
| Thoth RAG replacement | Q3+ | Swap pgvector layer, keep Letta + Obsidian |

| Pros | Cons |
|------|------|
| Zero infra — pip install | No built-in persistence — you manage serialization |
| No ports, migrations, or server | Doesn't replace pgvector for complex filtered queries |
| Drop-in for flat-file search | Best under ~1M vectors — benchmark beyond that |
| MIT license | Never containerize standalone |

**Verdict:** Easiest high-value addition in the stack. Do Kryptos first, motor-pool second, Thoth swap last.

**Suggested index paths:** `data/turbovec/` volume mount — one index file per namespace (`kryptos-artifacts`, `tool-registry`, `workspace-files`).

---

## Architecture & Direction

### Core principle

> **motor-pool is the local orchestrator. Everything else is either a registered service, a direct endpoint consumer, or out of scope.**

The Q2 MCP server is the architectural keystone. Once motor-pool exposes its own MCP surface, Claude Code and Kryptos consume it as a first-class provider — not just a dashboard on top of Docker.

### Stack topology

```
┌─────────────────────────────────────────────────────────────────┐
│  PERSONAL LAYER                                                 │
│  Odysseus ──────────────────────────────────────────────────┐  │
│  (chat, email, general research, daily driver)              │  │
└─────────────────────────────────────────────────────────────┼──┘
                                                              │
┌─────────────────────────────────────────────────────────────▼──┐
│  ORCHESTRATION LAYER                                            │
│  motor-pool                                                    │
│  ├── unified lifecycle API (models + MCP containers)           │
│  ├── model registry (Ollama, OpenLLM, AirLLM wrapper)          │
│  ├── MCP container manager (Thoth, Playwright, bb-mcp, etc.)   │
│  ├── task queue + webhook ingestion                             │
│  ├── NemoClaw sandbox                                           │
│  ├── turbovec (tool registry + file search)                     │
│  └── MCP server (exposes motor-pool to external consumers)     │
└────────────────────────────────────┬───────────────────────────┘
                                     │ MCP / REST / OpenAI-compat
┌────────────────────────────────────▼───────────────────────────┐
│  DIRECT CONSUMERS (bypass motor-pool UI, use endpoints raw)    │
│  Claude Code ──── hits Ollama/OpenLLM directly                  │
│  Kryptos ─────── hits Ollama/OpenLLM + turbovec embedded        │
│  Scripts/CLI ─── hit motor-pool REST API or model endpoints    │
└─────────────────────────────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────┐
│  INFERENCE LAYER                                                │
│  Ollama (llm_qwen_coder) ── commodity models, rate-limit default │
│  OpenLLM ────────────────── custom/built models, CUDA-native    │
│  AirLLM wrapper (opt-in) ── 70B+ on constrained VRAM           │
│  Docker Model Runner ────── already wired, optional             │
└─────────────────────────────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────┐
│  SPECIALIST SERVICES (on-demand, unified lifecycle API)         │
│  Thoth ──── research + persistent memory (via Obsidian vault)     │
└─────────────────────────────────────────────────────────────────┘
```

### Claude Code + local models

Wire Claude Code to hit local endpoints regardless of whether motor-pool is running:

```
# Ollama (default fallback)
http://localhost:8081/v1

# OpenLLM (custom models)
http://localhost:8082/v1
```

motor-pool is a parallel consumer, not a proxy. Once the MCP server ships, Claude Code gets both: **direct model access** for speed AND **motor-pool MCP tools** for orchestration when needed.

### Endpoint reference

| Service | Host port | Container port | Config key |
|---------|-----------|----------------|------------|
| Ollama (`llm_qwen_coder`) | 8081 | 11434 | `ollama` |
| OpenLLM (`llm_openllm`) | 8082 | 3000 | `openllm` |
| AirLLM wrapper | TBD | TBD | `airlite` |
| motor-pool API | 3000 | 3000 | — |

---

## What to Avoid

| Temptation | Why not |
|------------|---------|
| Making Odysseus the orchestrator | Overlaps motor-pool scope. Consumer, not hub. |
| Running AirLLM + OpenLLM simultaneously | VRAM fights. Pick one per task. |
| AirLLM during rate-limit fallback | Layer-streaming too slow for interactive coding. |
| Letting Thoth run always-on | Heavy stack. On-demand via lifecycle API only. |
| Proxying Claude Code through motor-pool | Direct endpoint access is faster. motor-pool adds value as MCP tool provider. |
| Containerizing turbovec standalone | It's a library. Embed in-process. |
| Two separate lifecycle APIs | Same primitive for models and MCP tools. One registry. |
| Skipping GPU enablement before AirLLM | AirLLM is slow enough without running on CPU. |

---

## Open Questions

| Question | Notes | Suggested direction |
|----------|-------|---------------------|
| **motor-pool MCP server spec** | What tools does it expose? | Task CRUD, model registry, container status, sandbox execution. Needs `SPEC.md`. |
| **Model eviction policy** | Models stay loaded until manually pulled | LRU or explicit TTL per model once GPU work lands |
| **turbovec serialization** | Where do indexes live on disk? | `data/turbovec/` volume — one file per namespace |
| **Thoth ↔ motor-pool auth** | How does lifecycle API authenticate to Thoth MCP? | Design before container manager ships |
| **Odysseus sunset criteria** | When to stop relying on it? | Reassess after MCP server + file I/O ship Q2/Q3 |

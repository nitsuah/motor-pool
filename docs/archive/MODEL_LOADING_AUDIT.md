# Ollama Model Loading Performance Audit

> 🧭 [agent-board](../../README.md) · [Features](../FEATURES.md) · [Roadmap](../ROADMAP.md) · [Tasks](../TASKS.md) · [Changelog](../CHANGELOG.md) · [Metrics](../METRICS.md) <!-- nav -->
>
> **Historical host audit (June 2026).** Its model-load samples and machine assumptions are not the current benchmark. Use [current metrics](../METRICS.md) and [deployment guidance](../DEPLOYMENT.md) for the present setup.
>
> **Status:** Audit complete. Profiling data below; partial optimization already
> shipped (model swap), additional opt-in mitigation added (warmup), GPU work
> tracked separately as the path to a larger win.

repo: `motor-pool`
## Background

[Q2-CEO] Model loading performance audit (TASKS.md, P1):

> profile Ollama startup and model load times; identify bottlenecks and optimize
> for faster readiness. Acceptance: Ollama startup time is reduced by at least 50%
> for the default model set; profiling data is documented in the repo.

The `ollama` container has no health endpoint instrumentation beyond its own logs,
and is a shared, always-running service used interactively during development.
Rather than force cold restarts (which would disrupt anyone using the live stack),
this audit is based on **passive analysis of `docker logs ollama`**, which already
contains `llama-server started in N seconds` timing for every model (re)load that
has happened on this host since `llama2:latest` → `llama3.2:3b` became the default
(PR swapping `PRIMARY_LLM_MODEL`, see "Swap primary Ollama model" in TASKS.md Done).

## Raw data

Every "llama-server started in" entry in `docker logs ollama`, in order. Each load
emits this line twice (once for the inference server itself, once after chat
template selection completes a fraction of a second later) — the table uses the
first of each pair. "Host free mem" is the `system memory` log line emitted
immediately before the load begins.

| Timestamp (UTC) | Model | Params | Size on disk | Host free mem | Load time |
|---|---|---|---|---|---|
| 2026-06-12 04:48:20 | llama2:latest | 6.74B | 3.8 GB | 7.1 GiB / 7.5 GiB | **31.10 s** |
| 2026-06-12 05:41:23 | llama2:latest | 6.74B | 3.8 GB | 5.8 GiB / 7.5 GiB | **21.11 s** |
| 2026-06-12 14:30:49 | llama2:latest | 6.74B | 3.8 GB | 7.4 GiB / 7.5 GiB | **17.91 s** |
| 2026-06-12 14:47:14 | llama2:latest | 6.74B | 3.8 GB | 7.1 GiB / 7.5 GiB | **19.29 s** |
| 2026-06-12 15:03:01 | llama3.2:3b | 3.21B | 2.0 GB | 7.3 GiB / 7.5 GiB | **15.11 s** |
| 2026-06-13 03:34:50 | llama3.2:3b | 3.21B | 2.0 GB | 7.4 GiB / 7.5 GiB | **22.64 s** |
| 2026-06-13 16:07:12 | llama3.2:3b | 3.21B | 2.0 GB | 7.4 GiB / 7.5 GiB | **16.67 s** |
| 2026-06-14 03:43:27 | llama3.2:3b | 3.21B | 2.0 GB | 7.4 GiB / 7.5 GiB | **14.88 s** |

## Analysis

| Model | n | min | max | mean |
|---|---|---|---|---|
| llama2:latest (7B, prior default) | 4 | 17.91 s | 31.10 s | **22.35 s** |
| llama3.2:3b (3B, current default) | 4 | 14.88 s | 22.64 s | **17.33 s** |

**Average reduction: ~22.5%** (22.35 s → 17.33 s). **Best-to-best reduction:
~16.9%** (17.91 s → 14.88 s).

A 31.10 s → 14.88 s (~52%) comparison *is* present in the data, but it pairs the
single worst llama2 sample against the single best llama3.2 sample — both at
"7+ GiB free" host memory, with no logged signal that explains the spread (host
disk I/O / page-cache state for the model blob isn't visible from inside the
container). Using that pair to claim "50%+ reduction" would be cherry-picking.
**The honest number is ~17-23%, not 50%.**

### Bottleneck

Every load shows the same shape:

```
common_fit_params: fitting params to free memory took 0.05-0.14 seconds   <- negligible
load_tensors: loading model tensors, this can take a while... (mmap = false, direct_io = false)
                                                                            <- ~15-30s, all of it
```

`mmap = false` means Ollama reads the entire model blob into RAM up front rather
than mapping pages on demand; `direct_io = false` means that read goes through the
page cache. On a CPU-only host with ~7.5 GiB total RAM, a 2-3.8 GB blob read
dominates load time regardless of which small/medium model is selected — the 3B
vs 7B difference accounts for the ~20% average gap above, but neither is close to
"instant," and the swap alone can't reach 50%.

## What's already in place

- `OLLAMA_KEEP_ALIVE=30m` (config/docker-compose.yml) — once a model is loaded, it
  stays resident for 30 minutes of inactivity, so the cost above is paid **once per
  cold start / idle timeout**, not per request.
- `PRIMARY_LLM_MODEL=llama3.2:3b` default (prior PR) — ~17-23% faster cold load than
  the old `llama2:latest` default, and the smaller (2.0 GB vs 3.8 GB) blob also
  reduces the container's resident memory footprint.

## New: opt-in startup warmup

This audit adds an opt-in `ollama-warmup` one-shot service (`warmup` compose
profile). It waits for `ollama` to accept API calls, then issues
`ollama run $PRIMARY_LLM_MODEL ""` against the running `ollama` service and exits.
This doesn't make the underlying load faster — it moves the ~15-23s cost from "the
first chat message a user sends" to "while `docker compose up` is finishing," which
is what most directly improves perceived dev iteration speed.

```bash
docker compose -f config/docker-compose.yml --project-directory . --profile warmup up ollama-warmup
```

## Recommendations (ranked by expected impact)

1. **GPU acceleration via CUDA** (tracked separately, P1 "GPU acceleration via
   CUDA" x2). This is the only change with the potential for an order-of-magnitude
   improvement: GPU-resident models skip the CPU `load_tensors`/page-cache path
   entirely, and the RTX 4080's 24 GB VRAM has headroom for `llama3.2:3b` (and much
   larger models) without the host-RAM pressure seen here.
2. **Selective model loading** (tracked separately, P1) — `config/model-manifest.json`
   is currently dead/invalid config (not referenced anywhere in code); fixing this
   so only one model is ever pulled/resident avoids accidental multi-model RAM
   pressure as the model set grows.
3. **Opt-in warmup** (this PR) — zero risk to the shared `ollama` container (additive
   service, no changes to its config), removes the cold-load delay from the
   interactive path for anyone who enables the `warmup` profile.

## Conclusion vs. acceptance criteria

- ✅ "Profiling data is documented in the repo" — this document, sourced from
  `docker logs ollama`.
- ⚠️ "Ollama startup time is reduced by at least 50% for the default model set" —
  **not met by raw cold-load time** (~17-23% average reduction from the prior
  `llama2` → `llama3.2:3b` swap). The opt-in warmup service addresses the
  *user-perceived* startup cost for anyone who enables it, but does not change the
  underlying ~15-23s CPU tensor-load time. Closing the remaining gap to "50%+"
  requires the GPU acceleration work above, which is correctly scoped as its own
  P1 item rather than bundled into this audit.

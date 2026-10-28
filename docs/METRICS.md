# Project Metrics: motor-pool

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · [Tasks](./TASKS.md) · [Changelog](./CHANGELOG.md) · **Metrics** <!-- nav -->

This document tracks the health, performance, and quality metrics of the `motor-pool` project.

## Core Metrics

| Metric | Current | Target | Status |
| :--- | :--- | :--- | :--- |
| **Unit Test Coverage** | 81.10% statements / 71.39% branches / 89.83% functions (historical coverage run 2026-09-11 across 66 suites; coverage not remeasured for the current 69-suite set). Current isolated run: 69/69 pass, 0 failures (2026-10-28). | >80% | ⚪ |
| **Test File Count** | 73 test files (69 unit + 4 integration requiring a live LLM/Docker stack); 69/69 unit suites pass in the isolated Docker test image (2026-10-28). | >50 | 🟢 |
| **Critical Vulnerabilities** | 0 | 0 | 🟢 |
| **ESLint Errors** | 0 errors / 75 warnings (mostly unused vars; `npm run lint` at the root, enforced in CI since 2026-10-22) | 0 | 🟢 |
| **Avg. Cyclomatic Complexity** | TBD | <10 | ⚪ |
| **Production Bundle Size** | 249.10 KB gzipped JS (934.02 KB raw, one chunk; dashboard Docker build 2026-10-28) | <500KB gzipped | 🟢 |
| **CI Build Time** | TBD | <3 mins | ⚪ |
| **CI Pipeline Success Rate** | TBD | 100% | ⚪ |
| **Outdated Dependencies** | TBD | 0 | ⚪ |
| **Lines of Code (LOC)** | TBD | N/A | ⚪ |

## Metric Definitions

*   **Unit Test Coverage:** Percentage of code branches and lines executed during test suites.
*   **Test File Count:** Number of test files run by the suite (not individual test cases/assertions within them).
*   **Critical Vulnerabilities:** High or Critical security issues reported by `npm audit`.
*   **ESLint Errors:** Number of breaking linting violations based on the local configuration.
*   **Avg. Cyclomatic Complexity:** The average number of linearly independent paths through the source code.
*   **Production Bundle Size:** The minified and gzipped size of the final JavaScript distribution.
*   **CI Build Time:** The wall-clock time from commit trigger to successful deployment/artifact.
*   **Outdated Dependencies:** Number of packages with available major updates.

## Ollama Startup and Inference Baseline (2026-10-28)

Measured against the running local Ollama container using `llama3.2:3b` on a
Windows Docker Desktop setup. `ollama ps` reported `100% CPU`, `llamacpp`, and
4096 context; no GPU acceleration was in use.

| Probe | Wall time | Model metrics |
| :--- | ---: | :--- |
| First request after model was unloaded (30-token prompt, 8-token cap) | 8.16 s | 30 prompt tokens; model reported 0.455 s prompt evaluation and 0.062 s generation before stopping at 2 tokens |
| Warm request (40-token prompt, 32-token cap) | 2.01 s | 0.283 s prompt evaluation; 1.684 s generation; 19.0 generated tokens/s |

The first request includes model loading, while Ollama's reported generation
duration excludes it. This is a single short baseline, not a comparative
benchmark. During the warm run, `docker stats` showed 2.55 GiB container memory;
the reading is specific to this setup and should be re-measured for other model
sizes or concurrent workloads. The result gives a baseline for comparing a
supported GPU/runtime path under issue [#117](https://github.com/nitsuah/motor-pool/issues/117).

## How to Update

Run the following commands to generate current values for this table:

### 1. Test Count
```bash
# Isolated unit tests: test image, no live data or database mounts
docker compose --env-file .env -f config/docker-compose.yml --profile test run --build --rm test
```

### 2. Coverage
```bash
# Coverage baseline from the dashboard image (Docker path)
docker compose --env-file .env -f config/docker-compose.yml --profile test run --build --rm test npm run test:coverage

# Native path (no host Docker required) — run from dashboard/
cd dashboard && npm install && npm run test:coverage
```

Current coverage baseline (native run 2026-09-11, `npm run test:coverage`
inside `dashboard/` with NODE_V8_COVERAGE + c8, in a cloud automation
environment without Docker access — no `docker compose` wrapper used).
c8 v8 report over a clean 66/66 unit run. Measured, not estimated.

**All files: 81.10% statements / 71.39% branches / 89.83% functions.**

Essentially flat versus the 2026-09-04 Docker baseline (81.53% / 72.68% /
90.39%) — the small (~0.4-1.3pt) differences are consistent with c8/v8's
usual run-to-run noise rather than a real coverage change; no production
code changed shape this cycle. This also confirms the native and Docker
paths produce equivalent results for this repo's dashboard test suite.

Strongest:
- `safety.js` 99%, `mcp-helpers.js` 100%, `logger.js` 100%
- `plugins.js` 99%, `sessions.js` 95%, `worktrees.js` 95%, `channels.js` 96%
- `plugin-loader.js` 96%, `endpoints.js` 95%, `metrics.js` 92%, `webhooks.js` 92%
- `agent-tools.js` 84%

Remaining gaps, and why:
- `persistence.js` 46% — the uncovered half is live Postgres I/O; the no-op
  path when `DATABASE_URL` is unset is covered. Needs a database to go higher.
- `tracing.js` 56% — uncovered code is OpenTelemetry SDK wiring that only runs
  with `OTEL_ENABLED=true` and a collector endpoint.
- `docker.js` 64% — uncovered branches shell out to the Docker CLI/daemon.
- `content.js` 37% — reads generated client/artifact output directories that do
  not exist in a test container.
- `session-message.js` 43% and `session-stream.js` 69% — the remainder is
  long-running streaming and stall-timeout behavior (30s timers).
- `workspace.js` 71% — the rest is `/workspace/exec` and git push/remote paths.

These are integration-shaped rather than untested logic; raising them further
means standing up Postgres, a collector, and a Docker daemon in CI rather than
writing more unit tests.

### 3. Security Audit
```bash
npm audit
```

### 4. Code Quality & Linting
```bash
# Linting
npm run lint

# Complexity (using plato or eslint-plugin-complexity)
npx eslint . --format json
```

### 5. Bundle Size
```bash
# After build
npm run build
du -sh ./dist # or ./build
```

### 6. Dependency Freshness
```bash
npm outdated
```

### 7. Lines of Code
```bash
# Requires cloc installed
cloc . --exclude-dir=node_modules,dist
```

----
*Last Updated: 2026-09-11*

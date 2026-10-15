# Imps: Implementation Plan

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · [Tasks](./TASKS.md) · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

Written 2026-10-15 for a full build day. It turns the imps build prompt into PR-sized steps, and it is the first concrete slice of the target architecture in [RUST-REWRITE-ASSESSMENT.md §10](./RUST-REWRITE-ASSESSMENT.md#10-target-architecture-safe-async-agents-with-role-based-control).

## What we're building

Anything (a Claude Code session, a phone, vigil, a routine, a GitHub webhook, the dashboard) can **hand motor-pool a task with one authenticated call**. motor-pool queues it durably and runs it as an **imp**: a headless `claude -p` worker routed through 9router, in a disposable worktree inside a sandbox. The imp's work comes back as a **PR plus a full run record**. You (or a reviewer agent) review the PR. Imps never merge.

Each task is visible only to the principal who dispatched it, plus superadmins. That holds for the API, the dashboard and the live event stream.

## Decisions (and where they deviate from the build prompt)

| # | Decision | Why |
| --- | --- | --- |
| D1 | **The runner is a separate `imp-runner` container.** The dashboard never spawns processes; it owns the queue, policy and record. The runner claims jobs over an internal API with its own token | This is the runner supervisor from §10.4, and keeps the dashboard free of process and credential surface |
| D2 | **Imps work on repo mirrors in a volume, not on `~/code`.** The runner keeps a mirror clone per allowlisted repo (`imp_repos` volume) and cuts worktrees into `imp_work`. `repo` in the API is still the `~/code` folder name, mapped to a GitHub remote by `config/imp-repos.json` | Shared checkouts get routine commits (one worktree per task, never the shared checkout); no Windows path or CRLF issues; fetching the mirror means the base *is* `origin/<base>` |
| D3 | **Tests run on a dedicated Docker-in-Docker sidecar (`imp-docker`)**, never the host socket. `imp_work` is mounted at the same path (`/work`) in both, so `docker run -v /work/...:/app` resolves | An imp with the host socket controls the host, including 9router, headroom and your other stacks |
| D4 | **The runner pushes, not the imp (deviation).** The imp commits locally and writes the PR title/body to `/work/<id>/PR.md` (outside the worktree). After the deny-path check, diff-size check and secret scan pass, the runner pushes and opens the PR. The `claude` process gets **no GitHub token**, and the worktree's push URL is set to `no_push` | Credential brokering: an imp can't push anything the runner didn't inspect, and can't touch other repos |
| D5 | **GitHub identity is a GitHub App (`motor-pool-imps[bot]`)**, with 1-hour installation tokens scoped to allowlisted repos. A fine-grained PAT is the day-one fallback | Bot-authored PRs are reviewable and approvable by you (you can't approve your own). A ruleset requiring 1 approval and no bot bypass enforces "imps never merge" on GitHub's side |
| D6 | **Identity before SSO: principals + API tokens.** Each dispatcher gets its own token (`austin-cc`, `austin-phone`, `vigil`, `routines`, `runner`). Roles: `superadmin`, `operator`, `dispatcher`, `runner`. SSO later maps users onto the same principals table | This makes "only my tasks unless I'm superadmin" true tomorrow, and gives the audit log a real `who` |
| D7 | **One generic `jobs` table, `kind` = `imp` first** (`chat` and `review` later). The existing in-memory `/api/tasks` stays untouched tomorrow and migrates in a later PR | Imps are the first consumer of the durable queue, not a parallel queue, without risking the 66 existing unit tests on build day |
| D8 | **`job_events` persists a summarized stream** (tool name + target, files touched, cost ticks, status changes). The full `stream-json` transcript is saved as an artifact file per run | Live view, replay and audit without bloating Postgres |
| D9 | **9router fallback gate:** before claiming a task not tagged `low-risk`, probe 9router (1-token request) and check the serving `model`. During a run, any assistant event whose `message.model` isn't `claude-*` emits `fallback_detected`. Non-low-risk tasks are then stopped and **held** (requeued with no attempt counted) | Matches the routine-degradation rule; uses data the stream already carries |
| D10 | **Imps require `DATABASE_URL`.** Without Postgres, `/api/imps` returns 503 and the runner stays idle | The durable lease semantics need real `SKIP LOCKED` |

## Data model (Postgres, created in `persistence.js` with the existing `CREATE TABLE IF NOT EXISTS` pattern plus a `schema_version` row)

```sql
principals (id text pk, name text, role text check (role in ('superadmin','operator','dispatcher','runner')),
            tenant text default 'default', created_at timestamptz, disabled_at timestamptz)
api_tokens (id text pk, principal_id text references principals, token_hash text unique,  -- sha256, never plaintext
            label text, scopes text[], created_at, last_used_at, revoked_at)

jobs (id text pk,                       -- 'imp_' + short ulid
      kind text,                        -- 'imp' | later 'chat' | 'review'
      owner_id text references principals, tenant text, visibility text default 'private',
      source text, priority int, labels text[],
      spec jsonb,                       -- imp: {repo, baseBranch, brief, model, limits:{maxMinutes,maxCostUsd}, closes}
      status text,                      -- queued|claimed|running|held|pr_opened|no_change|failed|timed_out|cancelled
      attempts int default 0, max_attempts int default 2,
      lease_owner text, lease_expires_at timestamptz, cancel_requested boolean default false,
      result jsonb,                     -- {summary, branch, worktree, sessionId, prUrl, costUsd, servedModels[], diffStat}
      created_at, claimed_at, started_at, finished_at, updated_at)
  index on (status, priority desc, created_at)

job_events (job_id text references jobs, seq int, ts timestamptz, type text, data jsonb, primary key (job_id, seq))
```

**Queue semantics (`modules/job-queue.js`):**

- `claim(runnerId, kinds)`: inside one transaction, `SELECT … WHERE status='queued' AND kind = ANY($1) ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1`, then set `status='claimed'`, `lease_owner`, `lease_expires_at = now()+60s`, `attempts = attempts+1`.
- `heartbeat(id, runnerId)` every 15 s extends the lease. It returns `cancel_requested`, which is how cancel reaches the runner.
- **Reaper** (dashboard, every 15 s): a `claimed`/`running` job with an expired lease goes back to `queued` if `attempts < max_attempts`, else to `failed` with `result.reason='lease_expired'` plus the last events.
- `hold(id)`: requeue without counting the attempt (`attempts-1`). Used by the fallback gate.
- `complete(id, runnerId, status, result)` only succeeds if the caller still holds the lease. That's the fencing that makes "runs once" hold.
- Every transition writes a `job_events` row and emits `job_status` on the event bus.

## Visibility and auth (`modules/auth.js`)

- `Authorization: Bearer mp_<token>` → look up the token's sha256 → `req.principal`. The GitHub webhook keeps its HMAC and maps to a fixed `github` principal.
- **Bootstrap:** on first start with no principals, create `superadmin` from `MP_BOOTSTRAP_TOKEN` (env, hashed on load). After that, tokens are minted by `POST /api/admin/tokens` (superadmin only), which shows the plaintext once.
- `requireAuth` goes on `/api/imps*`, `/api/admin*`, `/api/workspace/exec`, the worktree launch route and `/api/runner/*`. Other routes stay open on localhost for now, behind `MP_REQUIRE_AUTH=all` once the UI sends tokens.
- **Read filter:** `canSee(principal, job) = principal.role === 'superadmin' || job.owner_id === principal.id || (job.visibility === 'tenant' && same tenant)`.
- **WebSocket:** `/ws/events?token=…` (or the first message) authenticates the socket. `job_*` events are sent only to sockets whose principal `canSee` the job. Unauthenticated sockets get only the existing non-job system events. The broadcast loop in `modules/event-bus.js` gains a per-client filter.

## API

| Route | Who | Notes |
| --- | --- | --- |
| `POST /api/imps` | dispatcher+ | Body: `{repo, baseBranch?, brief, source, priority?, model?='MAX', limits?, labels?, closes?, visibility?}`. Runs the enqueue guardrails (below). Returns `201 {id, status}` |
| `GET /api/imps?status=&repo=&mine=` | any authed | Filtered by `canSee` |
| `GET /api/imps/:id` | owner/superadmin | Job, result and the last N events |
| `GET /api/imps/:id/events?after=seq` | owner/superadmin | Paged replay; live updates come over WS |
| `POST /api/imps/:id/cancel` | owner/superadmin | Queued → `cancelled` immediately; running → `cancel_requested`, and the runner kills the process on its next heartbeat |
| `POST /api/runner/claim` · `/heartbeat` · `/events` · `/complete` | runner role only | The internal runner protocol. `/events` takes batches |
| `POST /api/admin/tokens` · `GET` · `DELETE /:id` | superadmin | Token management |

## Runner (`imp-runner/`, its own Node service and image)

Image: `node:22-slim` + `git`, `docker-ce-cli`, `gitleaks`, and `@anthropic-ai/claude-code` pinned to a version. It runs as a non-root user. Volumes: `imp_repos`, `imp_work` (mounted at `/work`), `imp_runs` (transcripts). Env: `MP_URL`, `MP_RUNNER_TOKEN`, `NINEROUTER_URL=http://host.docker.internal:20128` (never `127.0.0.1`), the 9router key from a secret file, GitHub App credentials, `DOCKER_HOST=tcp://imp-docker:2375` (internal network only), and `IMP_CONCURRENCY=1`.

Per job:

1. **Claim** (with the 9router probe first if the task isn't `low-risk`).
2. **Prepare:** `git -C /repos/<repo>.git fetch --prune`, then check the base hash equals `refs/remotes/origin/<base>` (abort on mismatch). Then `git worktree add /work/<id>/wt -b imp/<slug>-<id> origin/<base>`, `git remote set-url --push origin no_push`, and set the imp's git author.
3. **Launch:**

   ```
   env -i PATH=… HOME=/home/imp DOCKER_HOST=… ANTHROPIC_BASE_URL=$NINEROUTER_URL/v1 ANTHROPIC_API_KEY=$KEY \
     claude -p "<filled brief>" --model <model> --session-id <uuid> \
       --permission-mode acceptEdits --bare --strict-mcp-config --setting-sources project \
       --allowedTools "Read Edit Write Glob Grep Bash(git status:*) Bash(git diff:*) Bash(git add:*) Bash(git commit:*) Bash(git log:*) Bash(docker run:*) Bash(docker compose:*)" \
       --max-budget-usd <limits.maxCostUsd> --output-format stream-json --verbose < /dev/null
   ```

   `cwd` is the worktree. The env starts empty, so no `CLAUDE*`/`ANTHROPIC*`/`GH_*` leaks in.
4. **Stream:** parse NDJSON line by line → tee the raw lines to `/runs/<id>.jsonl` → map them to summarized events (`tool_use` name + target, `files_touched`, assistant `model`, usage/cost ticks) → batch-POST to `/api/runner/events` every second. Watch for `fallback_detected`.
5. **Limits:** a wall-clock timer of `maxMinutes` sends SIGTERM, then SIGKILL after 10 s, and the job becomes `timed_out`. Cost is enforced by `--max-budget-usd`, with a runner-side backstop from usage events. Cancel works through the heartbeat.
6. **Finish:** read the final `result` event (summary, `total_cost_usd`, `session_id`). Then:
   - No commits on the branch → `no_change`.
   - Otherwise run the **pre-push gate**: changed paths vs. deny globs, diff size cap (default 1,500 lines), `gitleaks detect` on the range, no `.env*`.
   - Gate fails → `failed` with the reason. The branch is kept in the mirror for inspection and never pushed.
   - Gate passes → mint an App token, push, `gh pr create` with the imp's `PR.md` plus a footer (motor-pool run link, cost, served models, `Written by an imp (motor-pool task <id>)`) → `pr_opened`.
7. **Cleanup:** remove the worktree after the record is saved, on every terminal status. The transcript stays in `imp_runs`, keeping the last N runs.

**Commit trailer:** `Co-Authored-By: 9router imp <noreply@anthropic.com>`. The runner rejects pushes whose commits lack it.

## Guardrails

- **At enqueue:**
  - `repo` must be in `config/imp-repos.json`.
  - The brief and labels are scanned for the deny terms (`auth`, `billing`, `secret`, `credential`, `token`, `.env`, `.github/workflows`). A match returns 422 unless a superadmin passes `override: true`, which is logged.
  - Brief size is capped.
- **During the run:**
  - Tool allowlist: no `gh`, no `git push`, no host npm/node.
  - No credentials in the process; egress only to 9router and the DinD daemon.
  - Time and cost limits.
  - The fallback gate.
- **Before push:** the deny-path, diff-size and secret-scan gate (runner step 6).
- **On GitHub:** a ruleset on each allowlisted repo's default branch: PR required, 1 approval, `motor-pool-imps` not a bypass actor. Imps can't merge even if everything above fails.
- **Review:** after `pr_opened`, optionally enqueue a `review` job (Opus via direct API, or rely on CodeRabbit) whose output is a PR review comment. A human still merges.

## Dispatchers

- **Claude Code `/imp` skill** (`~/.claude/skills/imp/`): `curl -H "Authorization: Bearer $MP_TOKEN" -d @brief.json $MP_URL/api/imps` and print the run link. It also has a `status` subcommand.
- **Phone:** an iOS Shortcut ("Dispatch imp": choose repo, dictate brief) POSTing over Tailscale with the `austin-phone` token, plus a minimal mobile "New imp" form in the dashboard.
- **vigil and routines:** their own tokens; a routine enqueues its mechanical steps with `labels: ['low-risk']` where that's true.
- **GitHub webhook:** the existing HMAC trigger gains a rule. `issues.opened`/`labeled` with `bot:journey` on an allowlisted repo enqueues an imp from the journey-fix brief template, labels the issue `imp:working`, then `imp:pr`/`imp:failed` on the terminal status (the runner calls back with the App token). Needs a public ingress or a GitHub → Tailscale relay; until then, a polling routine can enqueue instead.

## Dashboard: Imps panel

- **List:** status chip, repo, source, owner (superadmin view), elapsed, cost, PR link.
- **Detail:** live event tail (tool calls, files touched, served model, cost/time against limits), the final report, gate results, diff stat, and the transcript download. **Cancel** and **Requeue** buttons. Copyable resume command `docker exec -it imp-runner claude --resume <sessionId>`.
- **New imp** form (repo picker from the allowlist, brief, labels, limits).
- The token goes in the UI's settings panel (stored in `localStorage`), until SSO replaces it.

## Build day: PR sequence

Each PR gets its own branch and worktree, tests in Docker, and TASKS/ROADMAP/CHANGELOG/FEATURES updates in the same PR.

| PR | Scope | Est. | Done when |
| --- | --- | --- | --- |
| **1. Principals & tokens** | `principals`/`api_tokens` tables, bootstrap, `modules/auth.js`, `requireAuth` on exec/worktree/admin routes, token admin API, per-client WS filter | 2–3 h | Unauthed exec gets 401; a dispatcher can't see another principal's job events over WS (test) |
| **2. Durable job queue** | `jobs`/`job_events`, `modules/job-queue.js` (claim/heartbeat/hold/complete/reaper/cancel), `/api/imps` CRUD (no runner yet), Postgres-backed tests (`docker compose -p motor-pool-test --profile test`) | 2–3 h | Tests for claim exclusivity under 2 concurrent claimers, lease-expiry requeue, attempts cap → failed, cancel, fencing on a stale `complete` |
| **3. Runner** | `imp-runner/` image and service, `imp-docker` DinD sidecar, mirrors and worktrees, launch, stream mapper, limits, pre-push gate, push/PR, cleanup; compose profile `imps` | 3–4 h | Unit tests for the stream mapper, limits, gate; a dry run with a stub `claude` script reaching each terminal status |
| **4. Imps panel + `/imp` skill** | List/detail/new-imp UI, live tail over WS, the skill | 2 h | Dispatch from a Claude session and watch it live in the dashboard |
| **E2E** | One real `bot:journey` fix in a small repo, through 9router, to an open PR | 1 h | PR open, record complete, worktree cleaned up |
| *Stretch* | Webhook rule + issue labels, fallback gate, `review` job kind, iOS Shortcut | | |

That's about a full day for PRs 1–4 plus the E2E run if nothing fights back. If time runs short, cut the stretch items first, then the panel's "New imp" form (the skill and curl cover dispatch).

## Prerequisites (only you can do these; ideally before the build day)

1. **GitHub App** `motor-pool-imps`: permissions Contents R/W, Pull requests R/W, Issues R/W, Metadata R. Install it on the target repos and save the App ID, installation ID and private key to `config/secrets/` (gitignored). Fallback: a fine-grained PAT with the same scopes.
2. **Ruleset** on each target repo's default branch: require a PR and 1 approval, and don't add the App as a bypass actor.
3. **9router API key** for imps, and confirm the `MAX` combo name.
4. **Pick the first E2E repo and issue:** a small repo with an open `bot:journey` issue.
5. Decide token labels (suggested: `austin-cc`, `austin-phone`, `vigil`, `routines`).

## Known risks and open questions

- **Cost numbers under 9router.** `total_cost_usd` is the CLI's estimate at Anthropic list prices, so it's misleading when a fallback model serves. Record served models next to the cost, and pull real usage from 9router if it exposes it.
- **DinD on Docker Desktop** needs `privileged: true` for the sidecar. It's isolated from host containers but is still a privileged container. Acceptable for a single-owner host; revisit with Sysbox or rootless DinD for gov/edu.
- **Image pulls inside DinD** start cold and are slow on the first run of each repo. Add a pull-through cache or pre-pull the common `node:*` images.
- **Webhook reachability:** GitHub can't reach a Tailscale-only host. Use a relay (smee / Cloudflare tunnel limited to `/api/webhooks/trigger`) or a polling routine.
- **`--bare` plus `--setting-sources project`** still loads the repo's `.claude/settings.json`. Decide whether an imp should honor repo-defined hooks; the default here is yes, project only, never user settings.

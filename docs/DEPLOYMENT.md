# Production Deployment Guide

> 🧭 [motor-pool](../README.md) · [Features](./FEATURES.md) · [Roadmap](./ROADMAP.md) · [Tasks](./TASKS.md) · [Changelog](./CHANGELOG.md) · [Metrics](./METRICS.md) <!-- nav -->

motor-pool is Docker-native and local-first. This guide covers running it on a
dedicated host (Linux server, a VPS, or a Windows machine with Docker Desktop).

---

## Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| Docker Engine / Docker Desktop | 24+ | Compose v2 required (`docker compose`, not `docker-compose`) |
| RAM | 8 GB | 16 GB recommended for the default stack and larger local models |
| Disk | 10 GB free | More if pulling large models |
| GPU (optional) | Depends on vendor and runtime | CPU inference works without GPU passthrough; verify the backend Ollama actually selected |

---

## 1. Clone and configure

```bash
git clone https://github.com/nitsuah/motor-pool.git
cd motor-pool
cp .env.example .env
```

Edit the repository-root `.env` — at minimum set:

```env
POSTGRES_DB=agent_board
POSTGRES_USER=agent
POSTGRES_PASSWORD=<strong-random-password>
PRIMARY_LLM_MODEL=llama3.1:8b-instruct-q4_K_M
DEVICE_PROFILE=minimal                    # minimal | laptop | desktop
```

---

## 2. Start the Ollama-first stack

The default Compose stack starts the dashboard, Postgres, and an Ollama container. `ollama-init` pulls and warms the model selected by `PRIMARY_LLM_MODEL` (default `llama3.1:8b-instruct-q4_K_M`).

```bash
docker compose --env-file .env -f config/docker-compose.yml up -d
```

Check that Ollama loaded the intended model and backend:

```bash
docker exec ollama ollama list
docker exec ollama ollama ps
```

Docker Model Runner is an additional endpoint. Enable it in Docker Desktop, then select it in motor-pool; there is no `ACTIVE_LLM_BACKEND` selector in the current runtime. The OpenLLM endpoint is an optional, deferred profile.

### GPU access and profile selection

The detector reports host GPU inventory separately from the GPU access available to Ollama's container. A host GPU name alone does not prove that the container can use it.

- `Container GPU access: verified` means the host `nvidia-smi` probe succeeded and `docker info --format '{{json .Runtimes}}'` lists the `nvidia` runtime. Only verified container access allows NVIDIA VRAM to count toward the `laptop` or `desktop` profile.
- `Container GPU access: unverified` means NVIDIA host hardware was detected but the NVIDIA probe or Docker runtime could not be verified. The detector selects the CPU-safe `minimal` profile and prints the fallback reason.
- `Container GPU access: none` means no NVIDIA host GPU was detected. AMD/Intel devices may still appear in the host inventory; the current Compose GPU overlay is NVIDIA-only.

The AMD Radeon RX 470 is CPU-only in the current Docker Desktop configuration unless a supported alternative is proven. Do not assume that setting `NVIDIA_VISIBLE_DEVICES=all` enables AMD/Vulkan passthrough. Use CPU-only inference until a supported AMD path is verified; this repository does not currently provide an AMD/Vulkan overlay.

---

## 3. Enable optional profiles

```bash
# MCP tool servers (content-gen, website agent)
docker compose --env-file .env -f config/docker-compose.yml --profile tools up -d

# Docker control UI (lets dashboard start/stop services)
# Requires: AGENT_BOARD_ENABLE_DOCKER_CONTROL=true in .env
docker compose --env-file .env -f config/docker-compose.yml -f config/docker-compose.docker-control.yml \
  up -d
```

---

## 4. Secrets handling

**Never commit `.env` to source control.** The repository's `.gitignore`
excludes it by default.

Secrets checklist:
- `POSTGRES_PASSWORD` — use a long random string; never use the default `agent`
- `ANTHROPIC_API_KEY` / external LLM keys — set only if using BYOK endpoints via the dashboard UI; not required for local-only setups
- `WEBHOOK_SECRET` — set if using the webhooks API to receive inbound events

For CI/CD or remote hosts, inject secrets via environment variables or a secrets
manager (e.g. Docker Swarm secrets, Vault, or GitHub Actions secrets) rather than
shipping a `.env` file.

---

## 5. Reverse proxy (HTTPS)

The dashboard runs on port `3000` and does not terminate TLS. For internet-facing
deployments, put it behind a reverse proxy:

**nginx example**

```nginx
server {
    listen 443 ssl;
    server_name board.example.com;

    ssl_certificate     /etc/letsencrypt/live/board.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/board.example.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 300s;   # needed for streaming LLM responses
    }
}
```

**Caddy example**

```
board.example.com {
    reverse_proxy localhost:3000
}
```

---

## 6. Health check

```bash
curl http://localhost:3000/api/health
# → JSON with status (ok/degraded/critical), server details, and per-endpoint health
```

Container-level health is already configured in `docker-compose.yml`
(`/api/health` with 30 s interval, 3 retries, 30 s start period).

---

## 7. Persistence

PostgreSQL stores session metadata, messages, and tasks in the Compose volume
`agent_db_data` (prefixed by the Compose project name). Active session snapshots,
including full message history for restoring active sessions after a dashboard
recreation, are also stored in `agent_session_data`. Both survive
`docker compose down`; `docker compose down -v` removes both. A database dump
alone does not back up the session snapshot volume; include both stores in a
complete backup.

To back up:

```bash
docker exec agent-db pg_dump -U agent agent_board > backup_$(date +%F).sql
```

To restore:

```bash
cat backup_YYYY-MM-DD.sql | docker exec -i agent-db psql -U agent agent_board
```

---

## 8. Updating

```bash
git pull origin master
docker compose --env-file .env -f config/docker-compose.yml up -d --build
```

The `--build` flag rebuilds the dashboard image. Database migrations run
automatically on server start via `db.js`.

---

## 9. Environment variables reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVICE_PROFILE` | `minimal` | `minimal`, `laptop`, `desktop` — profile-aware endpoint/model guidance; accelerated profiles require verified NVIDIA container access; host inventory may also report AMD/Intel |
| `PRIMARY_LLM_URL` | `http://ollama:8080` | Override Ollama endpoint |
| `PRIMARY_LLM_MODEL` | `llama3.1:8b-instruct-q4_K_M` | Ollama model pulled and warmed at stack startup |
| `OLLAMA_KEEP_ALIVE` | `30m` | Keep the startup model resident between requests |
| `OLLAMA_CONTEXT_LENGTH` | `16384` | Context window in tokens (Ollama's default depends on VRAM: 4096 tokens below 24 GiB, so on small or CPU-only hosts longer prompts are silently truncated and tool definitions dropped) |
| `POSTGRES_DB/USER/PASSWORD` | `agent_board / agent / agent` | Database credentials |
| `PORT` | `3000` | Dashboard HTTP port |
| `AGENT_BOARD_ENABLE_DOCKER_CONTROL` | `false` | Enable start/stop/restart buttons in UI |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry tracing (exports to Jaeger) |
| `WEBHOOK_SECRET` | — | HMAC secret for inbound webhook validation |
| `CUSTOM_LLM_ENDPOINTS` | — | JSON array of additional LLM endpoints (BYOK) |
| `PUBLIC_DEMO_MODE` | `false` | Restricts to primary endpoint, disables destructive ops |
| `BB_MCP_ENABLED` | `false` | Enable Blackboard MCP connector |

---

## 10. Resource limits (optional)

Add resource limits to `config/docker-compose.yml` service definitions to cap
memory on shared hosts:

```yaml
services:
  agent-dashboard:
    deploy:
      resources:
        limits:
          memory: 512M
  ollama:
    deploy:
      resources:
        limits:
          memory: 8G   # 4.9 GB model + ~1.5 GiB KV cache at 16k context + runtime overhead
```

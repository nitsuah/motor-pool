FROM node:26-slim AS base

# Raise libuv's threadpool size (default 4) so concurrent DNS lookups in
# /api/system/services don't starve each other: slow lookups for down hosts
# (e.g. nemoclaw, llm_openllm) were delaying lookups for healthy hosts past
# their own axios timeout, misreporting them as unavailable.
ENV UV_THREADPOOL_SIZE=16

# Docker CLI is opt-in. Build with --build-arg INSTALL_DOCKER_CLI=true only in
# trusted dev/CI environments where Docker socket access is explicitly required.
ARG INSTALL_DOCKER_CLI=false
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN if [ "$INSTALL_DOCKER_CLI" = "true" ]; then \
      apt-get update \
      && (apt-get install -y --no-install-recommends docker.io docker-compose-plugin ca-certificates \
          || apt-get install -y --no-install-recommends docker.io docker-compose ca-certificates) \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- test stage ----
FROM base AS test
COPY server.js persistence.js tracing.js safety.js task-runner.js ./
COPY modules ./modules
COPY routes ./routes
COPY config ./config
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN mkdir -p /tools/tokeneconomizer
COPY tools/tokeneconomizer/safe-error.mjs /tools/tokeneconomizer/safe-error.mjs
ENV AGENT_DASHBOARD_DISABLE_LISTEN=1
CMD ["npm", "run", "test:unit"]

# ---- production stage ----
FROM base AS prod
COPY server.js persistence.js tracing.js safety.js task-runner.js ./
COPY modules ./modules
COPY routes ./routes
COPY config ./config
COPY src ./src
COPY index.html vite.config.js ./
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => { r.resume(); r.on('end', () => process.exit(r.statusCode === 200 ? 0 : 1)); }).on('error', () => process.exit(1))"
CMD ["node", "server.js"]

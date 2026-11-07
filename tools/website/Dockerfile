FROM node:22-slim

WORKDIR /app

# PowerShell (pwsh) — runs discover.ps1, deploy.ps1, invoice.ps1 inside the container.
# Netlify CLI — used by deploy.ps1; auth via NETLIFY_AUTH_TOKEN env var (no browser needed).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg wget \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
       | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] \
       https://packages.microsoft.com/repos/microsoft-debian-bookworm-prod bookworm main" \
       > /etc/apt/sources.list.d/microsoft.list \
    && apt-get update && apt-get install -y --no-install-recommends powershell \
    && npm install -g netlify-cli \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js output-path.js ./
COPY scripts/ ./scripts/
COPY templates/ ./templates/

# Output volume mounted here — matches OUTPUT_DIR default in server.js and
# the $OutputDir default in every PS1 script (Join-Path $PSScriptRoot .. output)
RUN mkdir -p /app/output
VOLUME ["/app/output"]

EXPOSE 3201
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3201/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

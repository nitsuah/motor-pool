# TokenEconomizer HTTP wrapper Dockerfile
# Uses node:20-slim (Debian-based) for better Python availability
FROM node:20-slim

WORKDIR /app

# Install Python 3 + TokenEconomizer CLI
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip git && \
    pip3 install --break-system-packages --no-cache-dir git+https://github.com/microsoft/TokenEconomizer.git && \
    rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
RUN npm install --omit=dev

# Copy server
COPY server.js ./

# Create non-root user (use existing node user from node:slim)
USER node

# Default port
ENV TOKEN_ECONOMIZER_PORT=3202
EXPOSE 3202

CMD ["node", "server.js"]

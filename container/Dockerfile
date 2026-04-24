# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium + Python for freqtrade-mcp
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Build TA-Lib C library from source (not in Debian bookworm repos)
RUN cd /tmp && \
    curl -sSL https://sourceforge.net/projects/ta-lib/files/ta-lib/0.4.0/ta-lib-0.4.0-src.tar.gz/download | tar xz && \
    cd ta-lib/ && \
    ./configure --prefix=/usr && make && make install && \
    cd / && rm -rf /tmp/ta-lib

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @aisuite/chub

# Persist chub annotations per-group (symlink to mounted group workspace)
RUN ln -s /workspace/group/.chub /home/node/.chub

# Install freqtrade-mcp Python server and dependencies
COPY freqtrade-mcp/ /app/freqtrade-mcp/
RUN pip install --break-system-packages "freqtrade[hyperopt]" freqtrade-client "mcp[cli]" ta anthropic pandas hmmlearn

# Install kata-mcp server (strategy improvement: benchmarking, market inspection, knowledge)
COPY kata-mcp/ /app/kata-mcp/
RUN pip install --break-system-packages /app/kata-mcp

# Set default freqtrade binary path
ENV FREQTRADE_PATH=/usr/local/bin/freqtrade

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript and save source hash for cold-start skip
RUN npm run build && \
    find src -name '*.ts' -exec md5sum {} + | sort | md5sum | cut -d' ' -f1 > /app/dist/.source-hash

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
#
# Hash-based recompilation: skips tsc (~3-8s) when source is unchanged from
# the image build. Per-group customizations to /app/src trigger recompilation
# automatically because their hash will differ.
RUN printf '#!/bin/bash\nset -e\ncd /app\nCURRENT_HASH=$(find src -name "*.ts" -exec md5sum {} + | sort | md5sum | cut -d" " -f1)\nCACHED_HASH=$(cat /app/dist/.source-hash 2>/dev/null || echo "")\nif [ "$CURRENT_HASH" != "$CACHED_HASH" ]; then\n  echo "[entrypoint] Source changed, recompiling TypeScript..." >&2\n  npx tsc --outDir /tmp/dist 2>&1 >&2\n  echo "$CURRENT_HASH" > /tmp/dist/.source-hash\n  ln -s /app/node_modules /tmp/dist/node_modules\n  chmod -R a-w /tmp/dist\nelse\n  cp -r /app/dist /tmp/dist\n  ln -sf /app/node_modules /tmp/dist/node_modules\nfi\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]

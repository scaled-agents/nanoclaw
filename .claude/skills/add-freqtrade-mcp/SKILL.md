---
name: add-freqtrade-mcp
description: >
  Add Freqtrade MCP integration — the complete AI agent toolkit for cryptocurrency
  strategy development. 50 tools covering introspection, strategy management,
  backtesting, hyperopt, walk-forward analysis, data downloading, and live trading.
---

# Add Freqtrade MCP Integration

Installs the [freqtrade-mcp](https://github.com/adaptiveX-gh/freqtrade-mcp) Python
MCP server in the agent container. Provides 50 tools for the full
**Discover → Create → Test → Optimize → Trade** lifecycle.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -d container/freqtrade-mcp && echo "Already cloned" || echo "Not cloned"
grep -q "freqtrade-mcp" container/Dockerfile && echo "Dockerfile updated" || echo "Not in Dockerfile"
```

If both are true, skip to Phase 3 (Configure).

### Prerequisites

- **Git access** to `https://github.com/adaptiveX-gh/freqtrade-mcp` (private repo)
- **Freqtrade** installed on the host (for CLI tools: backtesting, hyperopt, etc.)
- **Freqtrade REST API** running (only needed for live trading tools)

## Phase 2: Apply Code Changes

### 2a. Clone the private MCP server

```bash
cd container
git clone https://github.com/adaptiveX-gh/freqtrade-mcp.git freqtrade-mcp
cd ..
```

Ensure `container/freqtrade-mcp/` is in `.gitignore` (private code).

### 2b. Update the Dockerfile

In `container/Dockerfile`, add `python3` and `python3-pip` to the apt-get install
list. Then add after the chub symlink line:

```dockerfile
# Install freqtrade-mcp Python server and dependencies
COPY freqtrade-mcp/ /app/freqtrade-mcp/
RUN pip install --break-system-packages freqtrade-client "mcp[cli]"
```

### 2c. Register in agent-runner index

In `container/agent-runner/src/index.ts`:

**Add to `allowedTools`** (after `'mcp__nanoclaw__*'`):
```typescript
'mcp__freqtrade__*',
```

**Add to `mcpServers`** (after the `nanoclaw` entry):
```typescript
freqtrade: {
  command: 'python3',
  args: ['/app/freqtrade-mcp/__main__.py'],
  env: {
    FREQTRADE_API_URL: process.env.FREQTRADE_API_URL || '',
    FREQTRADE_USERNAME: process.env.FREQTRADE_USERNAME || '',
    FREQTRADE_PASSWORD: process.env.FREQTRADE_PASSWORD || '',
    FREQTRADE_PATH: process.env.FREQTRADE_PATH || 'freqtrade',
    FREQTRADE_DOCS_PATH: process.env.FREQTRADE_DOCS_PATH || '',
    FREQTRADE_STRATEGIES_DIR: process.env.FREQTRADE_STRATEGIES_DIR || '',
  },
},
```

### 2d. Forward env vars in container-runner

In `src/container-runner.ts`, add `readEnvFile` import and forward all Freqtrade
env vars in `buildContainerArgs`:

```typescript
const ftKeys = [
  'FREQTRADE_API_URL', 'FREQTRADE_USERNAME', 'FREQTRADE_PASSWORD',
  'FREQTRADE_PATH', 'FREQTRADE_DOCS_PATH', 'FREQTRADE_STRATEGIES_DIR',
];
const ftEnv = readEnvFile(ftKeys);
for (const key of ftKeys) {
  const val = process.env[key] || ftEnv[key];
  if (val) args.push('-e', `${key}=${val}`);
}
```

Also add `[FREQTRADE]` log surfacing in the stderr handler.

### 2e. Create the agent-facing skill doc

Create `container/skills/freqtrade-mcp/SKILL.md` (auto-synced by container-runner).

### 2f. Copy to per-group agent-runner source

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### 2g. Build

```bash
npm run build
./container/build.sh
```

Both builds must complete without errors.

## Phase 3: Configure

### Set environment variables

Add to `.env`:

```
# Freqtrade REST API (optional — live trading tools only)
FREQTRADE_API_URL=http://127.0.0.1:8080
FREQTRADE_USERNAME=your_api_username
FREQTRADE_PASSWORD=your_api_password

# Freqtrade CLI (required for backtest/hyperopt/data tools)
FREQTRADE_PATH=/path/to/freqtrade
FREQTRADE_DOCS_PATH=/path/to/freqtrade/docs
FREQTRADE_STRATEGIES_DIR=/path/to/user_data/strategies
```

**Notes:**
- REST API is optional — if not set, live trading tools return an error but all
  CLI tools (backtesting, hyperopt, data download) work normally
- Docker containers reach the host via `host.docker.internal` on Docker Desktop
- `FREQTRADE_PATH` must point to the freqtrade binary accessible from the container

### Restart the service

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test via chat

Ask the agent:
> "List all the IStrategy methods I can override"

Should call `freqtrade_list_strategy_methods` and return available methods.

> "How is my Freqtrade bot doing?"

Should call `freqtrade_fetch_bot_status` and `freqtrade_fetch_profit`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i freqtrade
```

## Troubleshooting

### "Freqtrade executable not found"

Set `FREQTRADE_PATH` in `.env` to the full path of your freqtrade binary.

### "REST API not connected"

Set `FREQTRADE_API_URL` in `.env` and ensure the bot is running with API enabled.

### "Auth failed: 401"

Check `FREQTRADE_USERNAME` and `FREQTRADE_PASSWORD` match your Freqtrade config.

### MCP tools not available

Check `mcp__freqtrade__*` in `allowedTools` in the agent-runner index.ts.

### Updating freqtrade-mcp

```bash
cd container/freqtrade-mcp && git pull && cd ../..
./container/build.sh
```

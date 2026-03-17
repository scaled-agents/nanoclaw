---
name: add-freqtrade
description: >
  Install the Freqtrade CLI and Python library into the agent container.
  Enables all 50 freqtrade-mcp tools: backtesting, hyperopt, walk-forward
  analysis, data downloading, introspection, and strategy management.
  Includes TA-Lib for technical indicators.
---

# Add Freqtrade to Container

Installs the `freqtrade` package (CLI + Python library) and TA-Lib C library
into the container image. This completes the freqtrade-mcp stack — without it,
only REST API tools (live trading) work.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "pip install.*freqtrade[^-]" container/Dockerfile && echo "Installed" || echo "Not installed"
grep -q "ta-lib" container/Dockerfile && echo "TA-Lib present" || echo "TA-Lib missing"
```

If both are true, skip to Phase 3 (Configure).

### Prerequisites

- **Docker** running (for container build)
- **freqtrade-mcp** skill already applied (provides the 50 MCP tools)

## Phase 2: Apply Code Changes

### 2a. Update the Dockerfile

In `container/Dockerfile`, add to the apt-get install list (after `python3-pip`):

```dockerfile
    python3-dev \
    build-essential \
```

Add a separate RUN step to build TA-Lib C library from source (not in Debian
bookworm repos):

```dockerfile
# Build TA-Lib C library from source (not in Debian bookworm repos)
RUN cd /tmp && \
    curl -sSL https://sourceforge.net/projects/ta-lib/files/ta-lib/0.4.0/ta-lib-0.4.0-src.tar.gz/download | tar xz && \
    cd ta-lib/ && \
    ./configure --prefix=/usr && make && make install && \
    cd / && rm -rf /tmp/ta-lib
```

Change the pip install line to include `freqtrade`:

```dockerfile
RUN pip install --break-system-packages freqtrade freqtrade-client "mcp[cli]"
```

Add the default binary path:

```dockerfile
ENV FREQTRADE_PATH=/usr/local/bin/freqtrade
```

### 2b. Add per-group user_data mount

In `src/container-runner.ts`, add in `buildVolumeMounts()` (after the
agent-runner-src mount):

```typescript
const ftUserData = path.join(DATA_DIR, 'sessions', group.folder, 'freqtrade-user-data');
fs.mkdirSync(ftUserData, { recursive: true });
mounts.push({
  hostPath: ftUserData,
  containerPath: '/workspace/group/user_data',
  readonly: false,
});
```

### 2c. Build

```bash
npm run build
./container/build.sh
```

**Note:** First build takes 5-10 minutes (freqtrade has heavy dependencies:
numpy, pandas, scikit-learn, TA-Lib). Subsequent builds use cached layers.

## Phase 3: Configure

### Set environment variables

Add to `.env` (or update existing values):

```
FREQTRADE_PATH=/usr/local/bin/freqtrade
FREQTRADE_STRATEGIES_DIR=/workspace/group/user_data/strategies
```

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
> "What version of freqtrade is installed?"

Should call `freqtrade_get_freqtrade_version` and return the version.

> "List all IStrategy methods I can override"

Should call `freqtrade_list_strategy_methods` (introspection).

> "Download 30 days of BTC/USDT 1h data from binance"

Should call `freqtrade_download_data` (CLI).

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i freqtrade
```

## Troubleshooting

### "Freqtrade executable not found"

Verify `FREQTRADE_PATH=/usr/local/bin/freqtrade` is set in `.env`.

### TA-Lib compilation errors during build

Ensure `python3-dev` and `build-essential` are in the Dockerfile apt-get install
list, and the TA-Lib C library source build step is present (compiled from
SourceForge since `libta-lib0-dev` is not in Debian bookworm repos).

### Updating Freqtrade

To update to the latest version:

```bash
# Prune Docker builder cache to force fresh pip install
docker builder prune -f
./container/build.sh
```

To pin a specific version:

```dockerfile
RUN pip install --break-system-packages "freqtrade==2024.11" freqtrade-client "mcp[cli]"
```

### Image size

Adding freqtrade increases the container image by ~800MB (numpy, pandas,
scikit-learn, TA-Lib, etc.). Total image size is ~3.3GB.

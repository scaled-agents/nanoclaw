---
name: add-freqtrade-swarm
description: >
  Integrate freqtrade-swarm overnight strategy research with NanoClaw.
  Adds a read-only MCP server for viewing morning reports and leaderboards,
  a Docker Compose stack for running the swarm, and agent-facing skill docs.
---

# Add Freqtrade Swarm Integration

Connects the freqtrade-swarm overnight strategy research pipeline to NanoClaw.
The swarm runs as a separate Docker Compose stack (triggered by host cron/timer).
NanoClaw agents read reports via 6 MCP tools.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "mcp__swarm__" container/agent-runner/src/index.ts && echo "Registered" || echo "Not registered"
test -f container/agent-runner/src/swarm-mcp-stdio.ts && echo "MCP server exists" || echo "MCP server missing"
test -f container/skills/freqtrade-swarm/SKILL.md && echo "Skill docs exist" || echo "Skill docs missing"
```

If all three are true, skip to Phase 3 (Configure).

### Prerequisites

- **freqtrade-swarm** repo cloned as a sibling directory (for the compose stack)
- **Docker** running (for container build)

## Phase 2: Apply Code Changes

### 2a. Create MCP server

Create `container/agent-runner/src/swarm-mcp-stdio.ts` with 6 read-only tools:
- `swarm_latest_report` — read latest `leaderboard.md`
- `swarm_leaderboard` — read latest `leaderboard.json`
- `swarm_run_status` — read `status.json`
- `swarm_list_runs` — list archived runs
- `swarm_run_details` — read a specific run's data
- `swarm_health` — check report directory and data freshness

Env: `SWARM_REPORT_DIR` (default `/workspace/extra/swarm-reports`)

### 2b. Register in index.ts

Add `'mcp__swarm__*'` to the `allowedTools` array.

Add to `mcpServers`:
```typescript
swarm: {
  command: 'node',
  args: [path.join(path.dirname(mcpServerPath), 'swarm-mcp-stdio.js')],
  env: {
    SWARM_REPORT_DIR: process.env.SWARM_REPORT_DIR || '/workspace/extra/swarm-reports',
  },
},
```

### 2c. Edit container-runner.ts

1. **Mount** swarm reports (read-only) in `buildVolumeMounts()`:
```typescript
const swarmReportDir = process.env.SWARM_REPORT_DIR || path.join(DATA_DIR, 'swarm-reports');
if (fs.existsSync(swarmReportDir)) {
  mounts.push({
    hostPath: swarmReportDir,
    containerPath: '/workspace/extra/swarm-reports',
    readonly: true,
  });
}
```

2. **Forward env** in `buildContainerArgs()`:
```typescript
const swarmKeys = ['SWARM_REPORT_DIR'];
```

3. **Surface logs** — add `[SWARM]` to the log filter line.

### 2d. Create agent-facing skill

Create `container/skills/freqtrade-swarm/SKILL.md` with tool reference and usage patterns.

### 2e. Create compose stack

Create `integrations/freqtrade-swarm/docker-compose.yml` for running the swarm.

### 2f. Build

```bash
npm run build
./container/build.sh
```

## Phase 3: Configure

### Set environment variables

Add to `.env`:

```
SWARM_REPORT_DIR=data/swarm-reports
```

Create the report directory:

```bash
mkdir -p data/swarm-reports
```

### Run a smoke test (optional)

```bash
cd integrations/freqtrade-swarm
docker compose run --rm swarm python -m src run \
  --program /app/data/research_programs/smoke_test.yaml \
  --report-dir /app/reports --max-candidates 2
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
> "Check the swarm health"

Should call `swarm_health` and report directory status.

> "Show me the latest screening leaderboard"

Should call `swarm_latest_report` (after a swarm run has completed).

> "What was the best strategy from the last run?"

Should call `swarm_leaderboard` and report the top entry.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i swarm
```

## Troubleshooting

### "No leaderboard report found"

The swarm hasn't completed a run yet. Check:
1. `swarm_run_status` — is a run in progress?
2. `swarm_health` — is the report directory mounted?

### Report directory not mounted

Ensure `SWARM_REPORT_DIR` is set in `.env` and the directory exists.
The container-runner only mounts it if the directory exists on the host.

### Stale reports

If `swarm_health` shows `last_status_fresh: false`, the swarm hasn't
run in 48+ hours. Check the host cron/timer configuration.

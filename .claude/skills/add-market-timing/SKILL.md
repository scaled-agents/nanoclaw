---
name: add-market-timing
description: >
  Add the Market Timing Agent orchestration skill. Scores 560 cells (7 archetypes ×
  20 pairs × 4 timeframes), produces deployment rotation plans, and manages portfolio risk.
  Requires: orderflow, macro-sentiment, onchain-intel, ct-sentiment, archetype-taxonomy,
  freqtrade-mcp, aphexdata.
---

# Add Market Timing Agent

The capstone orchestration skill. Runs a scoring cycle across 560 cells, diffs against
current deployments, generates rotation plans, and logs everything to aphexDATA.

## Phase 1: Pre-flight

### Check if already applied
```bash
[ -f container/skills/market-timing/SKILL.md ] && echo "ALREADY APPLIED — skip to Phase 3"
```

### Prerequisites

All of these must be installed first:

| Dependency | Check |
|-----------|-------|
| orderflow | `grep -q 'orderflow' container/agent-runner/src/index.ts` |
| macro-sentiment | `[ -f container/skills/macro-sentiment/SKILL.md ]` |
| onchain-intel | `[ -f container/skills/onchain-intel/SKILL.md ]` |
| ct-sentiment | `[ -f container/skills/ct-sentiment/SKILL.md ]` |
| archetype-taxonomy | `[ -f container/skills/archetype-taxonomy/archetypes.yaml ]` |
| freqtrade-mcp | `grep -q 'freqtrade' container/agent-runner/src/index.ts` |
| aphexdata | `grep -q 'aphexdata' container/agent-runner/src/index.ts` |

If any dependency is missing, install it first using the corresponding `/add-*` skill.

## Phase 2: Apply Code Changes

### 2a. Create the agent-facing SKILL.md

Create `container/skills/market-timing/SKILL.md` with the full orchestration workflow:
- Phase 1: Gather data (regime, microstructure, context reports, previous grid)
- Phase 2: Score all 560 cells (regime_fit, execution_fit, net_edge, composite)
- Phase 3: Rank and apply portfolio constraints
- Phase 4: Deployment diff (target vs current → rotation plan)
- Phase 5: Execute (deploy/undeploy with aphexDATA logging)
- Phase 6: Store and log (cell grid snapshot, scoring cycle event, deployment action events)

### 2b. Create reports directory

```bash
mkdir -p data/sessions/*/group/reports
```

### 2c. Build

```bash
./container/build.sh
```

No TypeScript changes needed — this is a prompt-only orchestration skill.

## Phase 3: Configure

### Schedule the scoring cycle (optional)

Ask the agent to schedule a recurring task:
```
"Schedule a market timing scoring cycle to run every 4 hours"
```

The agent will use `schedule_task` to set up:
```
schedule_task(name: "market_timing_cycle", schedule: "0 */4 * * *", prompt: "Run a full Market Timing scoring cycle...")
```

### Restart the service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw

# Manual
npm run dev
```

## Phase 4: Verify

### Test scoring only (no deployment)
Ask the agent:
```
"Score all 560 cells and show me the top 10"
```

Expected: Agent reads archetype taxonomy, calls orderflow tools, scores cells, shows ranked table.

### Test full cycle (with deployment plan)
Ask the agent:
```
"Run a market timing scoring cycle — score cells, diff deployments, and show the rotation plan. Don't execute yet."
```

Expected: Agent scores cells, fetches current deployments, produces a rotation plan with DEPLOY/UNDEPLOY/HOLD actions.

### Test execution
Ask the agent:
```
"Execute the rotation plan from the last scoring cycle"
```

Expected: Agent deploys/undeploys strategies, logs each action to aphexDATA.

### Check aphexDATA
```
aphexdata_query_events(object_type="report", verb_id="scoring_cycle", limit=5)
```

### Check cell grid
```bash
cat /workspace/group/reports/cell-grid-latest.json | head -50
```

## Troubleshooting

### No regime data
If `orderflow_fetch_regime` fails, the scoring cycle cannot compute regime_fit. Check that `orderflow.tradev.app` is reachable from the container.

### No backtest data for net_edge
If no strategies match a cell, net_edge = 0. Run autoresearch to build the strategy library for under-covered cells.

### Portfolio circuit breaker triggered
If portfolio DD > 15%, all new deployments are paused. Check `freqtrade_fetch_bot_status` for position status and manually override if needed.

### Stale context reports
If macro/onchain/sentiment reports are older than 24 hours, the macro overlay may be inaccurate. Run the individual scans first:
```
"Run a macro sentiment scan, then an on-chain intel scan, then CT sentiment analysis"
```

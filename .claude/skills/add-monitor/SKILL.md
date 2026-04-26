---
name: add-monitor
description: >
  Add pipeline lifecycle monitoring. Runs a 15-minute health check cycle:
  refreshes regime data (timeframe-aligned), triggers scout gap scans,
  checks strategyzer runs, monitors kata races, deploys graduated strategies,
  manages paper bot health, and enforces portfolio constraints.
  Requires: market-timing, orderflow, freqtrade-mcp, aphexdata,
  archetype-taxonomy.
---

# Add Monitor

Continuous deployment lifecycle monitoring. Runs every 15 minutes to check
active deployment health, manage state transitions, enforce portfolio constraints,
scan for new opportunities, and recommend retirements. Reads market-timing's
cell grid for scores — does not re-score cells.

## Phase 1: Pre-flight

### Check if already applied
```bash
[ -f container/skills/auto-mode/SKILL.md ] && echo "ALREADY APPLIED — skip to Phase 3"
```

### Prerequisites

All of these must be installed first:

| Dependency | Check |
|-----------|-------|
| market-timing | `[ -f container/skills/market-timing/SKILL.md ]` |
| orderflow | `grep -q 'orderflow' container/agent-runner/src/index.ts` |
| freqtrade-mcp | `grep -q 'freqtrade' container/agent-runner/src/index.ts` |
| aphexdata | `grep -q 'aphexdata' container/agent-runner/src/index.ts` |
| archetype-taxonomy | `[ -f container/skills/archetype-taxonomy/archetypes.yaml ]` |

If any dependency is missing, install it first using the corresponding `/add-*` skill.

## Phase 2: Apply Code Changes

### 2a. Create the agent-facing SKILL.md

Create `container/skills/auto-mode/SKILL.md` with the full orchestration workflow:
- 15-minute check procedure (15 steps)
- Deployment lifecycle state machine (shadow/active/throttled/paused/retired)
- Opportunity scanning (undeployed high-scoring cells with matching strategies)
- Retirement scanning (underperforming deployments)
- Portfolio constraints and circuit breaker
- State file schemas (deployments.json, market-prior.json, portfolio.json, config.json)
- Strategy-to-archetype matching via header tags
- Crash-safety invariant (state written before freqtrade actions, reconciliation on each tick)
- Quick command table

### 2b. Build

```bash
./container/build.sh
```

No TypeScript changes needed — this is a prompt-only orchestration skill.

## Phase 3: Configure

### Schedule the monitoring tasks

The monitor pipeline runs as 4 independent scheduled tasks. Ask the
agent to schedule each one:

```
"Schedule the monitor health check, deploy, kata, and portfolio tasks"
```

The agent will use `schedule_task` for each:

```
# Health check — every 15 min (fast-path: bot status, signals, retirement, graduation)
schedule_task(name: "monitor_health_check", schedule: "*/15 * * * *", context_mode: "isolated", max_output_tokens: 8000,
  prompt: "Run a monitor health check. Use the monitor-health skill: tick init, read state, refresh regimes, update metrics, check retirements (Triggers A-J), check graduations, log and sync. Message user only on state changes.")

# Deployment — every 30 min (slot allocation with backtest verification)
schedule_task(name: "monitor_deploy", schedule: "7,37 * * * *", context_mode: "isolated", max_output_tokens: 4000,
  prompt: "Run monitor deployment check. Use the monitor-deploy skill: count slots, gather candidates, rank, verify with backtests (max 3), deploy as trials. Skip if slots full or cell-grid stale.")

# Kata — hourly (kata race completion handler)
schedule_task(name: "monitor_kata", schedule: "20 * * * *", context_mode: "isolated", max_output_tokens: 4000,
  prompt: "Run monitor kata check. Use the monitor-kata skill: check for completed kata races, run walk-forward validation, deploy if promising. Skip if no active races.")

# Portfolio — daily at 00:00 UTC (correlation, tail risk, daily rollup)
schedule_task(name: "monitor_portfolio", schedule: "0 0 * * *", context_mode: "isolated", max_output_tokens: 8000,
  prompt: "Run monitor portfolio analysis. Use the monitor-portfolio skill: compute portfolio correlation, regime transitions (Sunday), tail risk CVaR, portfolio diagnosis, competition benchmark, experiment ledger review, daily briefing.")
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

Tests build on each other — run in order.

### Test 1: Status (empty)
```
"Show auto-mode status"
```
Expected: Agent reads empty state files, reports "No active deployments. Auto-mode initialized."

### Test 2: Staging
Tag a strategy with header tags, then:
```
"Stage all graduated strategies"
```
Expected: roster.json created, config files generated in configs/ directory.

### Test 3: Show roster
```
"Show roster"
```
Expected: Lists all staged deployments with cells and status.

### Test 4: Shadow deployment
```
"Shadow track BTC TREND_MOMENTUM 1h using EMA_Crossover_v3"
```
Expected: Creates deployment entry in deployments.json with state "shadow".
Roster cell status updates from "staged" to "shadow".

### Test 5: Monitoring cycle
Wait 15 minutes or:
```
"Run an auto-mode check now"
```
Expected: Reads state, checks cell scores, reports deployment health.

### Test 6: Position sizing
```
"Simulate deploy AroonMacd_ADX ETH 1h"
```
Expected: Shows conviction × alignment × modifier breakdown without executing.

### Test 7: Regime-flip fast path
Edit `cell-grid-latest.json` to set a cell above deploy_threshold. Run check.
Expected: Threshold crossing detected, staged deployment matched, user notified.

### Test 8: Auto-shadow rules
```
"Pre-approve auto-shadow for TREND_MOMENTUM min 4.0"
```
Then trigger a threshold crossing. Expected: Bot auto-starts in dry-run mode.

### Test 9: Safety invariants
Verify:
- Auto-shadow NEVER starts with dry_run=false
- "Approve" is the ONLY path to live capital
- Circuit breaker (DD > 15%) pauses ALL deployments
- Stale cell-grid blocks new activations
- Portfolio concentration limits prevent over-deployment

### Check aphexDATA
```
aphexdata_query_events(verb_id="auto_mode_check", object_type="report", limit=5)
```

### Check state files
```bash
cat /workspace/group/auto-mode/deployments.json
cat /workspace/group/auto-mode/roster.json
cat /workspace/group/auto-mode/portfolio.json
ls /workspace/group/auto-mode/configs/
```

## Troubleshooting

### No cell grid data
Market-timing hasn't run yet. Run a scoring cycle first:
```
"Run a market timing scoring cycle"
```

### Stale scores warning
If `cell-grid-latest.json` is older than 8 hours, auto-mode enters defensive mode:
opportunity scanning paused, only downward transitions allowed. Run market-timing
to refresh scores.

### Portfolio circuit breaker triggered
If portfolio DD > 15%, all active deployments are paused. Check `freqtrade_fetch_profit()`
for DD status. Each deployment must be individually re-approved by the user after recovery.

### Bot state mismatch
If a bot is running but auto-mode doesn't know about it (or vice versa), the reconciliation
step (Step 4) on the next check cycle will detect and fix the mismatch automatically.

### Strategy not matched to archetype
Strategies need `# ARCHETYPE: <name>` header tags to be matched. Add the tag to the first
10 lines of the strategy `.py` file. Kata's graduation step should add these automatically.

---
name: freqtrade-swarm
description: >
  Use this skill for viewing overnight strategy research results from
  freqtrade-swarm, and for triggering matrix sweep jobs (grid tests across
  pairs × timeframes). Read morning reports, leaderboards, run status, and
  archived results. Trigger new sweep runs and poll their progress.
---

# Freqtrade Swarm — Strategy Research & Matrix Sweep

10 tools for viewing strategy screening results and triggering matrix sweep
jobs via the freqtrade-swarm engine.

## Read-Only Tools (6)

| Tool | What it does |
|------|-------------|
| `swarm_latest_report` | Read the latest morning leaderboard (Markdown) |
| `swarm_leaderboard` | Read the latest leaderboard as structured JSON |
| `swarm_run_status` | Check status of the latest run (running/completed/failed) |
| `swarm_list_runs` | List all archived runs with timestamps |
| `swarm_run_details` | Get leaderboard + status for a specific archived run |
| `swarm_health` | Check if report directory is configured and has recent data |

## Trigger Tools (4)

| Tool | What it does |
|------|-------------|
| `swarm_trigger_run` | Submit a matrix sweep job. Returns a `run_id` for polling |
| `swarm_poll_run` | Check status of a submitted run (queued/running/completed/failed) |
| `swarm_job_results` | Read full results of a completed job (heatmap, top-K, clusters) |
| `swarm_cancel_run` | Cancel a running or queued sweep job |

## Common Patterns

**Show the latest screening results:**
1. `swarm_run_status` → check if latest run completed
2. `swarm_latest_report` → get the markdown leaderboard

**Analyze top strategies:**
1. `swarm_leaderboard` → get structured JSON with metrics
2. Look at `composite_score`, `sharpe`, `sortino`, `max_drawdown`, `profit_factor`, `win_rate`

**Compare runs over time:**
1. `swarm_list_runs` → get available run IDs
2. `swarm_run_details` with each run_id → compare leaderboards

**Trigger a grid test (matrix sweep):**
1. Build a `MatrixSweepSpec` JSON with genome, pairs, timeframes, timerange
2. `swarm_trigger_run` with the spec JSON → get `run_id`
3. `swarm_poll_run` with `run_id` → check progress until completed
4. `swarm_job_results` with `run_id` → get heatmap, top-K, clusters, per-combo metrics

**MatrixSweepSpec JSON format:**
```json
{
  "genome": { ... },
  "pairs": ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT"],
  "timeframes": ["15m", "1h", "4h"],
  "timerange": "20250101-20260301",
  "n_walkforward_windows": 4,
  "fees": [0.001],
  "exchange": "binance"
}
```

**Cancel a running job:**
1. `swarm_cancel_run` with `run_id` → writes cancel marker
2. Host runner stops the process on next poll

## Leaderboard Metrics

| Metric | Description |
|--------|-------------|
| `sharpe` | Risk-adjusted return (Sharpe ratio) |
| `sortino` | Downside-risk-adjusted return |
| `max_drawdown` | Worst peak-to-trough decline |
| `profit_factor` | Gross profit / gross loss |
| `win_rate` | Percentage of winning trades |
| `composite_score` | Weighted combination of all metrics |

## Sweep Report Output

Matrix sweep jobs produce three analytical outputs:

| Output | Description |
|--------|-------------|
| **Heatmap** | Pair × timeframe grid with Sharpe, consistency, max drawdown |
| **Top-K ranking** | Weighted composite score across all combinations |
| **Cluster analysis** | Hierarchical clustering of performance profiles |

## Notes

- Report directory: `/workspace/extra/swarm-reports` (read-only mount)
- Request queue: `/workspace/extra/swarm-reports/requests` (writable mount)
- Nightly runs are triggered by the host scheduler (cron/systemd timer)
- Matrix sweeps can be triggered from agent sessions via `swarm_trigger_run`
- Large sweeps (100+ combinations) take hours — use `swarm_poll_run` to monitor

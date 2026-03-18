---
name: freqtrade-swarm
description: >
  Use this skill for viewing overnight strategy research results from
  freqtrade-swarm. Read morning reports, leaderboards, run status, and
  archived results. All tools are read-only — swarm runs are triggered
  by the host scheduler, not from agent sessions.
---

# Freqtrade Swarm — Overnight Strategy Research Reports

6 read-only tools for viewing strategy screening results produced by the
freqtrade-swarm overnight pipeline.

## Tools

| Tool | What it does |
|------|-------------|
| `swarm_latest_report` | Read the latest morning leaderboard (Markdown) |
| `swarm_leaderboard` | Read the latest leaderboard as structured JSON |
| `swarm_run_status` | Check status of the latest run (running/completed/failed) |
| `swarm_list_runs` | List all archived runs with timestamps |
| `swarm_run_details` | Get leaderboard + status for a specific archived run |
| `swarm_health` | Check if report directory is configured and has recent data |

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

**Troubleshoot missing reports:**
1. `swarm_health` → check directory exists, data freshness
2. If `last_status_fresh` is false, the swarm hasn't run recently

## Leaderboard Metrics

| Metric | Description |
|--------|-------------|
| `sharpe` | Risk-adjusted return (Sharpe ratio) |
| `sortino` | Downside-risk-adjusted return |
| `max_drawdown` | Worst peak-to-trough decline |
| `profit_factor` | Gross profit / gross loss |
| `win_rate` | Percentage of winning trades |
| `composite_score` | Weighted combination of all metrics |

## Notes

- Reports are produced by the freqtrade-swarm nightly pipeline running on the host
- Report directory: `/workspace/extra/swarm-reports` (read-only mount)
- Swarm runs take hours; they are NOT triggered from agent sessions
- The host scheduler (cron/systemd timer) triggers runs automatically

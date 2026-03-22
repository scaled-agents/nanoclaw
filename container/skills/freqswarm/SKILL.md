---
name: FreqSwarm
description: >
  Use this skill for viewing overnight strategy research results from
  FreqSwarm, triggering matrix sweep jobs (grid tests across
  pairs × timeframes), running batch backtest triage (many strategies,
  one backtest each), and running autoresearch batch mutation testing.
  Read morning reports, leaderboards, run status, and archived results.
  Trigger new sweep runs, batch backtests, autoresearch batches, and
  poll their progress.
---

# FreqSwarm — Strategy Research, Matrix Sweep, Batch Backtest & Autoresearch

12 tools for viewing strategy screening results, triggering matrix sweep
jobs, batch backtest triage, and running parallel autoresearch mutation
batches via the FreqSwarm engine.

## Read-Only Tools (6)

| Tool | What it does |
|------|-------------|
| `swarm_latest_report` | Read the latest morning leaderboard (Markdown) |
| `swarm_leaderboard` | Read the latest leaderboard as structured JSON |
| `swarm_run_status` | Check status of the latest run (running/completed/failed) |
| `swarm_list_runs` | List all archived runs with timestamps |
| `swarm_run_details` | Get leaderboard + status for a specific archived run |
| `swarm_health` | Check if report directory is configured and has recent data |

## Trigger Tools (6)

| Tool | What it does |
|------|-------------|
| `swarm_trigger_run` | Submit a matrix sweep job with parallel workers. Returns a `run_id` for polling |
| `swarm_trigger_batch_backtest` | Submit batch backtest triage: many strategies × one raw backtest each, in parallel |
| `swarm_trigger_autoresearch` | Submit a mutation batch: expand seeds → compile → walk-forward → classify keepers/rejects |
| `swarm_poll_run` | Check status of a submitted run (queued/running/completed/failed) |
| `swarm_job_results` | Read full results of a completed job (sweep, batch, or autoresearch results) |
| `swarm_cancel_run` | Cancel a running or queued job |

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
2. `swarm_trigger_run` with the spec JSON, `workers`, and `priority` → get `run_id`
3. `swarm_poll_run` with `run_id` → check progress (shows task counts, ETA) until completed
4. `swarm_job_results` with `run_id` → get heatmap, top-K, clusters, per-combo metrics

**swarm_trigger_run parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `spec_json` | string | required | MatrixSweepSpec JSON |
| `workers` | number | 4 | Parallel backtest workers (1-8). Use 4 for ≤50 combos, 6 for 50-100, 8 for 100+ |
| `priority` | string | "normal" | "high" for interactive requests (jumps queue), "normal" for scheduled |

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

**Batch backtest triage (many strategies, one backtest each):**
1. `swarm_trigger_batch_backtest` with strategies array, timerange, pairs, timeframes → get `run_id`
2. `swarm_poll_run` with `run_id` → check progress until completed
3. `swarm_job_results` with `run_id` → get ranked results sorted by composite score

**swarm_trigger_batch_backtest parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `strategies` | string[] | required | Array of strategy class names (must exist as .py files) |
| `timerange` | string | required | Date range "YYYYMMDD-YYYYMMDD" |
| `pairs` | string[] | ["BTC/USDT:USDT"] | Trading pairs to test |
| `timeframes` | string[] | ["1h"] | Timeframes to test |
| `fee` | number | 0.001 | Fee fraction |
| `workers` | number | 4 | Parallel workers (1-8). Use 6-8 for 100+ strategies |
| `priority` | string | "normal" | "high" or "normal" |

**BatchBacktestSpec JSON format:**
```json
{
  "strategies": ["StrategyA", "StrategyB", "StrategyC", "..."],
  "pairs": ["BTC/USDT:USDT"],
  "timeframes": ["1h"],
  "timerange": "20250101-20260301",
  "fee": 0.001,
  "exchange": "binance"
}
```

**Batch results format (from swarm_job_results):**
```json
{
  "status": "completed",
  "total_backtests": 255,
  "successful_backtests": 240,
  "failed_backtests": 15,
  "results": [
    {
      "strategy": "BestStrategy",
      "pair": "BTC/USDT:USDT",
      "timeframe": "1h",
      "sharpe": 1.85,
      "profit_factor": 2.1,
      "max_drawdown_pct": -0.12,
      "total_trades": 47,
      "win_rate": 0.62,
      "composite_score": 1.195
    }
  ]
}
```

**Run autoresearch mutation batch:**
1. Query aphexDATA for prior discards: `aphexdata_query` with verb="discarded", object_type="genome_variant" → get genome IDs to skip
2. Build `AutoresearchSpec` JSON with seed genomes (from registry/frontier), mutations_per_genome, timerange
3. `swarm_trigger_autoresearch` with spec, `workers`, `priority` → get `run_id`
4. `swarm_poll_run` with `run_id` → check progress until completed
5. `swarm_job_results` with `run_id` → get keepers/rejects with Sharpe comparison
6. For each keeper: attest with `sdna_attest` → register in strategy registry
7. For each reject: log to aphexDATA with `aphexdata_record` (verb="discarded")

**swarm_trigger_autoresearch parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `spec_json` | string | required | AutoresearchSpec JSON |
| `workers` | number | 4 | Parallel workers (1-8). Use 4 for ≤10 variants, 6 for 10-20, 8 for 20+ |
| `priority` | string | "normal" | "high" for interactive, "normal" for background |

**AutoresearchSpec JSON format:**
```json
{
  "seed_genomes": [
    {
      "genome": { "identity": { "name": "ADXMomentum", "genome_id": "abc123" }, ... },
      "pair": "BTC/USDT:USDT",
      "timeframe": "1h",
      "parent_sharpe": 1.2
    }
  ],
  "mutations_per_genome": 7,
  "mutation_seed": 42,
  "timerange": "20250101-20260301",
  "n_walkforward_windows": 4,
  "keeper_sharpe_threshold": 0.0,
  "parent_sharpe_gate": true,
  "screen_sharpe_threshold": -0.5,
  "discard_hashes": ["previously_tested_genome_id_1", "..."],
  "exchange": "binance"
}
```

**Autoresearch results format (from swarm_job_results):**
```json
{
  "status": "completed",
  "total_variants": 21,
  "keepers": [
    {
      "variant_genome_id": "...",
      "parent_genome_id": "...",
      "pair": "BTC/USDT:USDT",
      "timeframe": "1h",
      "mutations": [{"family": "adjust_params", "description": "..."}],
      "mean_sharpe": 1.5,
      "parent_sharpe": 1.2,
      "sharpe_delta": 0.3,
      "composite_score": 0.545,
      "screened_out": false,
      "is_keeper": true,
      "reason": "sharpe_improved"
    }
  ],
  "rejects": [...]
}
```

**Progressive filtering (screen_sharpe_threshold):**
When set (e.g. `-0.5`), each variant runs only window 1 first. If its Sharpe is below the threshold, remaining windows are skipped (~75% compute saved per rejected variant). Screened-out variants appear in rejects with `"screened_out": true`. Omit or set to `null` to disable screening.

**Keeper scoring:**
Variants are ranked by composite score: `0.5 × sharpe_delta + 0.3 × consistency + 0.2 × (1 + worst_drawdown)`. A variant must pass all gates (absolute threshold, parent gate, positive composite) to be a keeper.

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

## Progress Polling

During a running sweep, `swarm_poll_run` returns live progress:
```json
{
  "status": "running",
  "tasks": { "total": 100, "completed": 47, "failed": 2, "running": 4, "pending": 47 },
  "elapsed_seconds": 720,
  "estimated_remaining_seconds": 420,
  "workers_active": 4,
  "current_tasks": [{"pair": "BTC/USDT:USDT", "timeframe": "1h"}, ...]
}
```

## Notes

- Report directory: `/workspace/extra/swarm-reports` (read-only mount)
- Request queue: `/workspace/extra/swarm-reports/requests` (writable mount)
- The swarm runner is always on — jobs are picked up within 3 seconds of submission
- Matrix sweeps: `swarm_trigger_run` for pair × timeframe grid testing
- Batch backtest: `swarm_trigger_batch_backtest` for fast triage of many strategies
- Autoresearch: `swarm_trigger_autoresearch` for parallel mutation testing of seed genomes
- Use `swarm_poll_run` every 2 minutes to report progress to the user
- Both job types write progress to the same status file format — polling is identical
- After autoresearch completes: attest keepers with sdna tools, log rejects to aphexDATA

---
name: kata-bridge
description: >
  Bridge between strategyzer candidates and the wolfclaw-kata optimization
  loop. Validates candidates via 4-window walk-forward, manages race instances,
  launches kata runs, monitors race progress, imports winners for deployment.
  Trigger on: "kata", "kata bridge", "start race", "optimize strategy",
  "run kata", "kata status", "race status", "send to kata", "improve strategy",
  "show kata".
---

# Kata Bridge -- Strategy Optimization Race Manager

Validates strategyzer candidates, launches parallel kata optimization races,
monitors progress, and imports winners for deployment staging.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `freqtrade-mcp` | Walk-forward backtesting for validation and kata iterations |
| `strategyzer` | Provides `strategyzer-result.json` with race candidates |

---

## Configuration

### Environment

| Variable | Purpose | Default |
|----------|---------|---------|
| `WOLFCLAW_KATA_DIR` | Path to wolfclaw-kata checkout on host | (required) |

The kata directory must contain:
- `run_kata.sh` -- main iteration loop
- `lib/scoring.py` -- multi-component scoring
- `lib/metrics.py` -- walk-forward pattern classification
- `program.md` -- obstacle diagnosis guide
- `tasks/wf-4window/` -- 4-window walk-forward task config

### Race Directory Structure

```
/workspace/group/races/
  active-race.json          # manifest of all active races
  {race_id}/
    kata-state.json         # race instance state
    agent.py                # current strategy (mutated by kata)
    agent.py.initial        # starting strategy (immutable)
    agent.py.snapshot       # pre-edit snapshot (for rollback)
    results.tsv             # experiment history
    graduates/              # strategies that hit score >= 0.5
    logs/
      wf_results.json       # latest walk-forward output
```

---

## START RACE -- Validate and Initialize

When the user says "start race" or "send to kata", read race candidates
from `/workspace/group/reports/strategyzer-result.json`.

### Step 1: Pre-validation via 4-window walk-forward

For each race candidate, run a 4-window walk-forward validation to compute
`favorable_sharpe` before committing to a full kata race.

**Walk-forward windows:**

| Window | Period | Type |
|--------|--------|------|
| W0 | 20250101 - 20250424 | Out-of-sample |
| W1 | 20250424 - 20250815 | Out-of-sample |
| W2 | 20250815 - 20251206 | Out-of-sample |
| W3 | 20251206 - today | Out-of-sample |

Run `freqtrade_run_backtest` for each window on the target pair/timeframe.
Extract per-window Sharpe ratios.

### Step 2: Compute favorable_sharpe

```
positive_windows = [s for s in per_window_sharpe if s > 0]
favorable_sharpe = mean(positive_windows) if positive_windows else 0.0
unfavorable_sharpe = mean([s for s in per_window_sharpe if s <= 0]) if any(s <= 0) else 0.0
```

### Step 3: Gate candidates

| Condition | Action |
|-----------|--------|
| favorable_sharpe >= 0.5 | SKIP KATA -- strategy already qualifies. Create `pending_deploy` campaign directly. Log: `"SKIP_KATA: favorable_sharpe={value}"` |
| favorable_sharpe < -0.5 | DROP -- not worth optimizing. Log: `"DROPPED: favorable_sharpe={value}, below -0.5"` |
| -0.5 <= favorable_sharpe < 0.5 | PROCEED -- create kata race instance |

---

## CREATE RACE INSTANCES

For each candidate that passes the gate:

### kata-state.json schema

```json
{
  "race_id": "race_20260404_143000",
  "candidate_name": "BBands_RSI_v2",
  "source_path": "library",
  "target": {
    "archetype": "MEAN_REVERSION",
    "pair": "XRP/USDT:USDT",
    "timeframe": "15m"
  },
  "initial_favorable_sharpe": 0.31,
  "current_score": 0.31,
  "best_score": 0.31,
  "experiments": 0,
  "max_experiments": 15,
  "status": "pending",
  "wf_pattern": null,
  "per_window_sharpe": [0.45, -0.12, 0.38, 0.22],
  "sharpe_trajectory": [],
  "created_at": "2026-04-04T14:30:00Z",
  "updated_at": "2026-04-04T14:30:00Z",
  "graduated": false,
  "graduate_path": null
}
```

Status values: `pending`, `running`, `graduated`, `stuck`, `killed`.

### active-race.json manifest

```json
{
  "races": [
    {
      "race_id": "race_20260404_143000",
      "candidate_name": "BBands_RSI_v2",
      "status": "running",
      "current_score": 0.31,
      "experiments": 3
    },
    {
      "race_id": "race_20260404_143001",
      "candidate_name": "Candidate_LuxAlgo_1",
      "status": "running",
      "current_score": 0.12,
      "experiments": 5
    }
  ],
  "target": {
    "archetype": "MEAN_REVERSION",
    "pair": "XRP/USDT:USDT",
    "timeframe": "15m"
  },
  "created_at": "2026-04-04T14:30:00Z"
}
```

### Directory setup

For each race instance:
```bash
RACE_DIR="/workspace/group/races/${RACE_ID}"
mkdir -p "${RACE_DIR}/graduates" "${RACE_DIR}/logs"
cp "${STRATEGY_PATH}" "${RACE_DIR}/agent.py"
cp "${RACE_DIR}/agent.py" "${RACE_DIR}/agent.py.initial"
# Write kata-state.json
# Write results.tsv header
echo "experiment\tchange\tscore_before\tscore_after\tkept\ttimestamp" > "${RACE_DIR}/results.tsv"
```

---

## LAUNCH RACES -- Manual Host Launch (v1)

**Known gap:** Kata runs on the host, not in the container. The agent
writes race state and strategy files; the user launches kata on the host.

### Procedure

1. Agent writes all race instance directories and state files
2. Agent messages the user with launch instructions:

```
RACE READY -- {N} candidates prepared for kata optimization.

To launch on host:
  cd $WOLFCLAW_KATA_DIR

  # Race 1: BBands_RSI_v2
  TARGET_PAIR="XRP/USDT:USDT" TARGET_TF="15m" \
    cp /path/to/races/race_20260404_143000/agent.py agent.py && \
    bash run_kata.sh

  # Race 2: Candidate_LuxAlgo_1
  TARGET_PAIR="XRP/USDT:USDT" TARGET_TF="15m" \
    cp /path/to/races/race_20260404_143001/agent.py agent.py && \
    bash run_kata.sh
```

3. After kata completes on host, the user copies graduates back:
```bash
cp $WOLFCLAW_KATA_DIR/graduates/*.py /path/to/races/{race_id}/graduates/
```

### Future (v2): Container-native kata

When kata runs inside the container, launch directly:
```bash
cd /workspace/kata && bash run_kata.sh
```
This is not implemented yet. The bridge detects the gap and falls back
to manual launch instructions.

---

## CHECK RACE STATUS

When the user asks "kata status", "race status", or "show kata":

### Step 1: Read state files

```bash
cat /workspace/group/races/active-race.json
for race_dir in /workspace/group/races/race_*/; do
  cat "${race_dir}/kata-state.json"
done
```

### Step 2: Early winner detection

If any race instance reaches `score >= 0.5`:
1. Mark that instance as `graduated`
2. Mark all other instances as `killed`
3. Log: `"EARLY_WINNER: {candidate_name} score={score} after {experiments} experiments"`
4. Proceed to IMPORT WINNER

### Step 3: All complete

If all race instances have status `graduated` or `stuck` or `killed`:
1. Pick the winner: highest `best_score` among `graduated` instances
2. If no graduates: report failure, suggest next steps
3. If winner found: proceed to IMPORT WINNER

### Step 4: Still running

If races are still in progress, display current status (see Display Format below).

---

## IMPORT WINNER

When a race produces a graduate:

### Step 1: Copy graduate

```bash
WINNER_PATH="/workspace/group/races/${RACE_ID}/graduates/$(ls -t /workspace/group/races/${RACE_ID}/graduates/*.py | head -1)"
STRATEGY_NAME="${ARCHETYPE}_${PAIR_SLUG}_$(date +%Y%m%d)"
cp "${WINNER_PATH}" "/workspace/group/user_data/strategies/${STRATEGY_NAME}.py"
```

### Step 2: Write header tags

Add to the first 10 lines of the strategy file:
```python
# ARCHETYPE: MEAN_REVERSION
# GRADUATED: 2026-04-04
# VALIDATED_PAIRS: XRP/USDT:USDT
# WALK_FORWARD_DEGRADATION: 18
# KATA_SCORE: 0.65
# KATA_EXPERIMENTS: 8
# SOURCE_RACE: race_20260404_143000
```

### Step 3: Create pending_deploy campaign

Write a campaign entry for the monitor to pick up:
```json
{
  "campaign_id": "camp_20260404_150000",
  "strategy_name": "MEAN_REVERSION_XRP_20260404",
  "archetype": "MEAN_REVERSION",
  "pair": "XRP/USDT:USDT",
  "timeframe": "15m",
  "state": "pending_deploy",
  "kata_score": 0.65,
  "favorable_sharpe": 0.65,
  "graduated_at": "2026-04-04T15:00:00Z"
}
```

Write to `/workspace/group/auto-mode/campaigns.json` (append to existing array).

---

## SINGLE CANDIDATE MODE

When strategyzer produces only 1 race candidate (or user sends a single
strategy directly), skip the race format:

1. Validate via 4-window walk-forward
2. If favorable_sharpe >= 0.5: direct to deployment (skip kata)
3. If favorable_sharpe < -0.5: reject
4. Otherwise: create a single kata instance, no race needed
5. On graduation: import directly (no winner selection needed)

---

## Kata Iteration Loop (reference)

Each kata experiment follows this loop (from program.md):

1. Run the 4-window walk-forward benchmark
2. Read the score from the latest job output
3. If score >= 0.5: STOP. Strategy graduates.
4. Read the backtest output alongside agent.py
5. Diagnose the SINGLE BIGGEST obstacle
6. Make ONE targeted change to agent.py
7. Run the benchmark again
8. If score improved or stayed same: keep the change
9. If score decreased: revert (`cp agent.py.snapshot agent.py`)
10. Record in results.tsv
11. Repeat from step 2

### Obstacle Diagnosis Guide

| Symptom | Likely Obstacle | What to Try |
|---------|----------------|-------------|
| Win rate < 35% | Entry catches falling knives | Add trend filter (EMA200, ADX) |
| Max drawdown > 15% | Stoploss too wide | Tighten stoploss from -5% to -3% |
| < 5 trades per window | Signal too restrictive | Loosen entry thresholds |
| Winners avg +1%, losers avg -3% | Holds losers too long | Add trailing stop |
| Positive W0/W2, negative W1/W3 | Regime dependent | Add regime filter |
| Sharpe decays across windows | Overfit to early data | Simplify indicator logic |
| Total OOS trades < 10 | Insufficient signals | Widen entry conditions |

### Walk-Forward Pattern Classification

| Pattern | Meaning | What to Try |
|---------|---------|-------------|
| CONSISTENT | Generalizes across all windows | Boost magnitude: tighten entries, optimize ROI |
| DEGRADING | Performance decays over later windows | Overfit to early data. Simplify indicators, reduce params |
| ALTERNATING | Positive/negative windows alternate | Regime-dependent. Add ADX/volatility filter |
| SINGLE_SPIKE | One window carries all performance | Not robust. Rethink entry logic |

### Scoring

Primary score: `favorable_sharpe` normalized to 0.0-1.0:
```
favorable_sharpe = average of POSITIVE walk-forward windows only
score = min(favorable_sharpe / 1.0, 1.0)
```

Gates (score forced to 0.0 if ANY fail):
- Total OOS trades across positive windows < 10
- Unfavorable Sharpe (avg of negative windows) < -1.0

Multi-component scores (from lib/scoring.py):
- **Backtest Score** (0-100): Sharpe 30%, profit 30%, win rate 25%, drawdown 15%
- **Robustness Score** (0-100): consistency 60%, robustness index 40%
- **Composite Score** (0-100): backtest 40% + robustness 60%
- **Tier**: POOR (<30) / FAIR (30-50) / GOOD (50-75) / EXCELLENT (75+)

---

## Display Format

### Per-Race Progress

```
KATA RACE STATUS -- MEAN_REVERSION on XRP/USDT:USDT 15m
=========================================================

Race 1: BBands_RSI_v2 [library]
  Status:      RUNNING
  Experiments: 5 / 15
  Score:       0.42 (best: 0.42)
  WF Pattern:  CONSISTENT
  Per-Window:  W0: 0.55  W1: -0.08  W2: 0.48  W3: 0.31
  Last Change: Added trailing stop (kept, +0.05)

Race 2: Candidate_LuxAlgo_1 [luxalgo]
  Status:      RUNNING
  Experiments: 8 / 15
  Score:       0.28 (best: 0.35)
  WF Pattern:  DEGRADING
  Per-Window:  W0: 0.72  W1: 0.15  W2: -0.12  W3: -0.05
  Last Change: Simplified indicator logic (kept, +0.02)
```

### Experiment Counts

```
EXPERIMENT HISTORY
+--------+---------------------+---------+---------+---------+------+
| Race   | Candidate           | Total   | Kept    | Reverted| Best |
+--------+---------------------+---------+---------+---------+------+
|   1    | BBands_RSI_v2       |    5    |    3    |    2    | 0.42 |
|   2    | Candidate_LuxAlgo_1 |    8    |    4    |    4    | 0.35 |
+--------+---------------------+---------+---------+---------+------+
```

### Sharpe Trajectory

```
SHARPE TRAJECTORY -- BBands_RSI_v2
  Start: 0.31
  Exp 1: 0.31 (no change - baseline)
  Exp 2: 0.35 (+0.04, added EMA200 filter)
  Exp 3: 0.33 (-0.02, tightened stoploss -- REVERTED)
  Exp 4: 0.38 (+0.03, added trailing stop)
  Exp 5: 0.42 (+0.04, optimized RSI threshold)
```

### Race Complete

```
RACE COMPLETE -- WINNER FOUND
==============================

Winner:     BBands_RSI_v2 [library]
Score:      0.65 (GOOD tier)
Experiments: 8 / 15
WF Pattern: CONSISTENT
Per-Window: W0: 0.82  W1: 0.15  W2: 0.68  W3: 0.55

Imported as: MEAN_REVERSION_XRP_20260404
Campaign:   pending_deploy

Next: monitor will stage for paper trading when regime aligns
```

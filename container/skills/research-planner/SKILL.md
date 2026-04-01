---
name: research-planner
description: >
  The WolfClaw Kata — find portfolio gaps, find or build candidates,
  measure baselines, improve one obstacle at a time, paper trade,
  graduate from live results. Trigger on: "research status",
  "run research", "research <archetype>", "fill the gap",
  "show paper bots", "retire <strategy>", "show triage matrix",
  "run one triage cycle", "show portfolio correlation".
---

# The WolfClaw Kata

North star: 80% annual return (portfolio Sharpe 1.33 at 60% crypto vol).
Method: fill 4 correlation groups with profitable strategies.
One group at a time. One obstacle at a time. One experiment at a time.


## THE LOOP

  1. FIND THE GAP — which group needs coverage most?
  2. FIND A CANDIDATE — does something exist, or build new?
  3. MEASURE BASELINE — backtest it, walk-forward it
  4. IMPROVE (if needed) — diagnose obstacle, experiment, learn
  5. DEPLOY — paper trade it
  6. GRADUATE OR RETIRE — reality decides after validation period
  7. MULTIPLY — cross-pair sweep, publish signals if quality high

Back to 1.


## STEP 1: FIND THE GAP

Read missed-opportunities.json, roster.json, portfolio-correlation.json.

Each archetype belongs to a correlation group (from archetypes.yaml):
  trend:  TREND_MOMENTUM, BREAKOUT
  range:  MEAN_REVERSION, RANGE_BOUND
  vol:    VOLATILITY_HARVEST, SCALPING
  carry:  CARRY_FUNDING

Count graduates per group. The group with fewest graduates gets
highest priority — filling a new group drops portfolio correlation
more than adding to an existing group.

Priority score per gap cell:
  gap_score = (composite × 2) + (hit_count × 0.4)
            + (group_has_zero_graduates × 5)
            + (archetype_has_zero_graduates × 3)

Pick the highest-scoring gap. Post to feed:
  "Gap: {archetype} on {pair}/{tf} — group '{group}' has {n} graduates"
  tags: ["research", "gap"]


## STEP 2: FIND A CANDIDATE

Two paths. Try FIND first. BUILD only if FIND fails.

### FIND (does something already exist?)

Check these sources — the agent looks wherever makes sense:
  - triage-matrix.json: pre-tested strategies with known Sharpe
  - Signal marketplace: other operators may publish this archetype
  - Strategy library: 455 .py files, backtest one on the target pair
  - sdna registry: genome-based seeds

Found something with Sharpe > 0 on the target pair → Step 3.
Nothing → BUILD.

### BUILD (create something new)

Two sources of ideas, ClawTeam workers execute either one:

  LuxAlgo Quant: use the luxalgoquant skill to search TradingView
  for published scripts matching the target archetype. Find a
  promising script, convert Pine Script to FreqTrade .py, backtest.
  Best when: you need sophisticated indicators (order blocks, SMC,
  Lorentzian classification, liquidity sweeps).

  Adjacent adaptation: read a strategy from a nearby archetype in
  the library and modify it toward the target. Direct .py editing.
  Best when: something close already exists but needs different
  entry/exit logic.

Spawn a ClawTeam worker for either approach:
  team_spawn_worker(
    name: "build_{archetype}_{pair}",
    prompt: "Search LuxAlgo for {archetype} scripts and convert..."
    OR: "Take {adjacent_strategy} and adapt toward {archetype}..."
    timeout_minutes: 30
  )

Worker produces a .py file → Step 3.
Two attempts max. Both fail → skip this gap, try next.


## STEP 3: MEASURE BASELINE

Backtest the candidate AS-IS. Then walk-forward.

  1. Single-window backtest on target pair (30 seconds)
     Record: sharpe, trades, win_rate, max_dd

  2. If sharpe < 0 → drop this candidate, back to Step 2

  3. 4-window walk-forward (2 minutes):
     W0: 20250101-20250424
     W1: 20250424-20250815
     W2: 20250815-20251206
     W3: 20251206-{today}

  4. Compute:
     mean_sharpe = average all windows
     favorable_sharpe = average of POSITIVE windows only
     (This is what the portfolio sees — auto-mode turns off
     the strategy during negative windows via regime gating)

  5. Log the WF pattern for diagnostics (not as a gate):
     CONSISTENT / DEGRADING / ALTERNATING / SINGLE_SPIKE
     Post to feed with the full per-window breakdown.

Decision:
  favorable_sharpe >= 0.5 → skip Step 4, go to Step 5 (deploy)
  favorable_sharpe 0.0-0.5 → Step 4 (improve)
  favorable_sharpe < 0.0 → drop, back to Step 2


## STEP 4: IMPROVE (The Kata)

### 4a. Diagnose the obstacle

Read the baseline metrics AND the .py code. Ask:
"What is the SINGLE BIGGEST obstacle between current favorable
Sharpe ({n}) and the 0.5 target?"

Common obstacles:
  Low win rate → entry catches falling knives
  High drawdown → stoploss too wide
  Too few trades → signal too restrictive
  Short winners, long losers → exit cuts winners early
  Regime dependent → needs a filter for bad conditions

Write ONE statement:
  "Obstacle: {what's wrong} because {why}.
   Target metric: {metric} from {current} to {goal}."

### 4b. Run ONE experiment

Pick the tool that fits the obstacle:
  Parameters wrong → freqtrade_run_hyperopt (200 epochs)
  Need a filter/indicator → edit the .py directly
  Need different exit → edit the .py directly
  Stoploss/ROI wrong → hyperopt with stoploss+roi spaces
  Fundamentally broken → drop it, back to Step 2

Make ONE change. Backtest. Compare to baseline.
  Improved? → keep change, update baseline.
  Not improved? → revert, try different approach.

### 4c. Learn and repeat

After each experiment write:
  "Experiment: {what I changed}. Result: {metric} {before}→{after}.
   Learning: {what this tells me}. Next: {what to try}."

Post to feed:
  "Kata: {strategy} — {obstacle}. Tried: {change}. {metric} {before}→{after}."
  tags: ["research", "kata"]

Loop: max 5 experiments per obstacle, max 3 obstacles per candidate.
If favorable_sharpe hits 0.5 at any point → exit to Step 5.
If 15 experiments with no progress → drop, back to Step 2.


## STEP 5: DEPLOY

Deploy a paper trading bot:
  bot_start_paper(strategy, pair, timeframe, config)

Read validation period from archetypes.yaml paper_validation[timeframe]:
  5m=1-2 days, 15m=3 days, 1h=7 days, 4h=14 days, 1d=30 days

Create campaign in campaigns.json:
  {
    "id": "kata_{timestamp}_{archetype}_{pair}_{tf}",
    "strategy": "...",
    "pair": "...",
    "timeframe": "...",
    "archetype": "...",
    "correlation_group": "...",
    "state": "paper_trading",
    "triage": {
      "wf_favorable_sharpe": 0.85,
      "wf_per_window": [0.8, -0.3, 0.9, -0.2],
      "regime_gated": true,
      "wf_pattern": "ALTERNATING",
      "improvements_applied": 2
    },
    "paper_trading": {
      "bot_deployment_id": "...",
      "deployed_at": "...",
      "validation_days": 7,
      "validation_deadline": "...",
      "current_pnl_pct": 0,
      "current_trades": 0,
      "current_sharpe": 0,
      "current_max_dd": 0
    },
    "graduation": null
  }

sync_state_to_supabase(state_key="campaigns", ...)

Post to feed: "Deployed: {strategy} on {pair}/{tf} — favorable
  Sharpe {n}. Validating for {days} days."
  tags: ["deployment"]


## STEP 6: GRADUATE OR RETIRE

Handled by auto-mode every 15 minutes (see auto-mode skill).
Auto-mode reads paper bot metrics, checks deadlines, and
auto-graduates or auto-retires. The research planner reads
the results and goes back to Step 1.


## STEP 7: MULTIPLY

After graduation, test the winner on all 20 pairs:
  Single-window backtest per pair (30 sec each)
  Any pair with Sharpe > 0.3 → 4-window walk-forward
  favorable_sharpe >= 0.5 → deploy paper bot on that pair

Each cross-pair deployment validates independently.

If live Sharpe >= 0.8 → flag for signal publishing.

Post to feed: "Cross-pair: {strategy} deployed on {n} new pairs."
  tags: ["research", "cross-pair"]


## CONTINUOUS TRIAGE

Runs during idle time between auto-mode checks. One strategy
tested per idle cycle (~96/day). Fills triage-matrix.json so
Step 2 has pre-computed answers.

After auto-mode health check, if routine (no state changes)
and next task > 5 min away:

  1. Read triage-matrix.json. Init queue if empty (all .py files
     × top 5 missed-opp pairs).
  2. Pop next strategy+pair from queue.
  3. Backtest single window (30 sec).
  4. Classify:
     Result A (Sharpe >= archetype threshold): run 4-window WF,
       deploy paper bot if favorable_sharpe >= 0.5
     Result B (Sharpe 0.1-threshold): add to candidates list
     Result C (Sharpe < 0.1): mark tested, try next pair next cycle
  5. Update triage-matrix.json.

Full library (455 strategies × 5 pairs) covered in ~24 days.
Weekly queue reset refreshes pairs from latest missed-opportunities.

### triage-matrix.json
  /workspace/group/research-planner/triage-matrix.json
  {
    "queue_position": 0, "total_strategies": 455, "tested": 0,
    "result_a_count": 0, "result_b_count": 0, "result_c_count": 0,
    "last_cycle": null, "last_queue_reset": null,
    "top_missed_pairs": [], "queue": [],
    "candidates": [], "winners": [], "tested_results": []
  }


## GRADUATION TIERS

  Paper trading entry:  favorable Sharpe >= 0.5
  Portfolio graduation: live Sharpe >= 0.5 after validation period
  Signal publishing:    live Sharpe >= 0.8 after validation period

On graduation: sdna_attest + sdna_registry_add + aphexdata_record_event


## SCHEDULING

  Auto-mode:     every 15 min  (health + paper bot validation + triage)
  Market-timing: every 4 hours (regime scoring)
  Research:      daily 03:00   (run full Kata loop Steps 1-5, Step 7)


## COMMANDS

  "Show research status"     → paper bots, gaps by group, portfolio estimate
  "Run research"             → execute Kata loop now
  "Research {archetype}"     → run Steps 1-5 for that archetype
  "Fill the gap"             → run for ALL gap archetypes
  "Show paper bots"          → list paper_trading campaigns with metrics
  "Retire {strategy}"        → stop bot, free slot
  "Graduate {strategy}"      → manual override graduation
  "Show triage matrix"       → tested counts, top candidates
  "Run one triage cycle"     → test one strategy manually
  "Show portfolio correlation" → correlation matrix + Sharpe estimate


## EVENTS (aphexDATA)

  kata_gap_selected, kata_candidate_found, kata_baseline,
  kata_experiment, kata_deployed, kata_graduated, kata_retired,
  kata_retired_early, kata_cross_pair, triage_tested,
  triage_winner, portfolio_correlation_update


## CONFIG

  /workspace/group/research-planner/config.json
  {
    "paper_trading": {
      "max_paper_bots": 20,
      "favorable_sharpe_threshold": 0.5,
      "early_retire_dd_multiplier": 1.5,
      "auto_deploy_triage_winners": true,
      "auto_cross_pair_sweep": true
    },
    "kata": {
      "max_experiments_per_obstacle": 5,
      "max_obstacles_per_candidate": 3
    },
    "graduation": {
      "min_live_sharpe": 0.5,
      "signal_publishing_sharpe": 0.8
    },
    "portfolio": {
      "target_annual_return": 0.80,
      "target_portfolio_sharpe": 1.33
    }
  }


## THE SIMPLICITY TEST

At any moment Wolf should answer "what are you doing?" in one sentence:
  "Looking for a strategy to fill the range group."
  "Testing MeanReversionQuant on SOL."
  "Improving win rate — trying an ADX filter."
  "Paper trading 5 strategies."
  "Expanding a winner to more pairs."

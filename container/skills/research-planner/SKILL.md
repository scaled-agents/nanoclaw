---
name: research-planner
description: >
  The WolfClaw Kata — a build-measure-learn loop for filling portfolio
  gaps with profitable strategies. Trigger on: "research status",
  "run research", "research <archetype>", "fill the gap",
  "show paper bots", "retire <strategy>", "show triage matrix",
  "run one triage cycle", "show portfolio correlation".
---

# The WolfClaw Kata

North star: 80% annual return (portfolio Sharpe 1.33 at 60% vol).
Method: fill 4 correlation groups with profitable strategies.
One group at a time. One obstacle at a time. One experiment at a time.


## DEPENDENCIES

| Skill | What it provides |
|-------|-----------------|
| auto-mode | missed-opportunities.json, roster.json, deployments.json, portfolio-correlation.json |
| freqswarm | swarm_scan_strategy, swarm_trigger_autoresearch, swarm_poll_run, swarm_job_results |
| clawteam | team_spawn_worker, team_wait_all |
| archetype-taxonomy | archetypes.yaml (7 archetypes, graduation gates, paper_validation, correlation_groups) |
| aphexdna | sdna_attest, sdna_registry_add |
| aphexdata | aphexdata_record_event, aphexdata_query_events |
| agent-feed | agent_post_status, agent_read_feed |


## THE LOOP

  1. FIND THE GAP — which group needs coverage most?
  2. FIND A CANDIDATE — does something exist, or do we build new?
  3. MEASURE BASELINE — backtest it, walk-forward it
  4. IMPROVE (if needed) — diagnose obstacle, experiment, learn
  5. DEPLOY — paper trade it
  6. GRADUATE OR RETIRE — reality decides
  7. MULTIPLY — cross-pair sweep, publish signals

Back to 1.


## THE TOOLS (pick based on the obstacle, not a decision tree)

The Kata doesn't prescribe tools. The agent picks whichever tool
fits the obstacle. Here's when each tool is most useful:

### Default: code edits (the scalpel)
  Edit the .py file directly. One change, one backtest, learn.
  Best for: targeted improvements when you know the obstacle.
  Use 80% of the time. This is the Karpathy method.

### When parameters are the problem: hyperopt (the microscope)
  freqtrade_run_hyperopt(strategy, epochs=100-200, spaces=["buy","sell"])
  Bayesian search finds optimal values in 15 minutes.
  Best for: obstacle is clearly "parameters suboptimal" and the
  strategy has hyperopt-eligible params.

### When uncertain which direction to go: autoresearch (the wide-angle lens)
  swarm_trigger_autoresearch with 6-8 structural mutations
  (add_filter, swap_indicator, add_exit, adjust_params)
  Tests multiple dimensions in parallel, returns in 20 minutes.
  Best for: 3+ experiments with no progress, need to explore wider.
  Then switch to targeted code edits on the winning dimension.

### For parallel execution: ClawTeam (the hands)
  team_spawn_worker for Round 3 sub-agent, BUILD path, parallel
  Katas, cross-pair sweeps.
  Best for: anything that benefits from a fresh context or running
  while the parent session does something else.

### For attestation and lineage: aphexDNA (the logbook)
  sdna_attest on graduation, sdna_registry_add for the marketplace.
  Best for: graduated strategies that need verifiable credentials.
  Not needed during the improvement loop itself.

Do NOT follow a decision tree to pick tools. Ask: "what tool would
a researcher reach for to solve THIS specific problem?"


===============================================================================
STEP 1: FIND THE GAP
===============================================================================

Read: missed-opportunities.json, roster.json, portfolio-correlation.json

Correlation groups (from archetypes.yaml):
  trend: TREND_MOMENTUM, BREAKOUT
  range: MEAN_REVERSION, RANGE_BOUND
  vol:   VOLATILITY_HARVEST, SCALPING
  carry: CARRY_FUNDING

Count graduates per group. Least-covered group gets highest priority.

  gap_score = (composite x 2) + (hit_count x 0.4)
            + (group_has_zero_graduates x 5)
            + (archetype_has_zero_graduates x 3)

Pick highest gap. Post to feed.


===============================================================================
STEP 2: FIND A CANDIDATE
===============================================================================

Two paths. FIND first. BUILD only if FIND fails.

### FIND (does something already exist?)

Check any of these — agent looks wherever makes sense:
  - triage-matrix.json (pre-tested, instant lookup)
  - Signal marketplace (other operators publish this archetype)
  - Strategy library (455 .py files, backtest one on target pair)
  - sdna registry (genome-based seeds)

Found Sharpe > 0 -> Step 3.
Nothing -> BUILD.

### BUILD (create something new)

Two sources of ideas, ClawTeam workers execute either:

  LuxAlgo Quant: use luxalgoquant skill to search TradingView for
  published scripts matching the archetype. Find promising script,
  convert Pine Script to FreqTrade .py, backtest.

  Adjacent adaptation: read a nearby-archetype strategy from the
  library and modify toward the target. Direct .py editing.

  team_spawn_worker(
    name: "build_{archetype}_{pair}",
    prompt: "Search LuxAlgo for {archetype} scripts and convert to
      FreqTrade. OR: adapt {adjacent_strategy} toward {archetype}.
      Write .py to /workspace/group/user_data/strategies/.
      Backtest. Return strategy name and Sharpe.",
    timeout_minutes: 30
  )

Two attempts max. Both fail -> skip this gap.


===============================================================================
STEP 3: MEASURE BASELINE
===============================================================================

  1. Backtest candidate AS-IS on target pair (30 seconds)
  2. If Sharpe < 0 -> drop, back to Step 2
  3. 4-window walk-forward — run as a SINGLE compound command
     to save 3 tool calls (1 call instead of 4):

     bash: freqtrade backtesting --strategy {name} --pairs {pair} \
       --timeframe {tf} --timerange 20250101-20250424 \
       --export trades --export-filename {name}_w0 && \
     freqtrade backtesting --strategy {name} --pairs {pair} \
       --timeframe {tf} --timerange 20250424-20250815 \
       --export trades --export-filename {name}_w1 && \
     freqtrade backtesting --strategy {name} --pairs {pair} \
       --timeframe {tf} --timerange 20250815-20251206 \
       --export trades --export-filename {name}_w2 && \
     freqtrade backtesting --strategy {name} --pairs {pair} \
       --timeframe {tf} --timerange 20251206-{today} \
       --export trades --export-filename {name}_w3

     Parse all 4 results from the output. This is one tool call
     that produces 4 window results.

  4. Compute:
     favorable_sharpe = average of POSITIVE windows only
     (portfolio only sees these — auto-mode turns strategy off
     in negative windows via regime gating)
  5. Log WF pattern (CONSISTENT/DEGRADING/ALTERNATING/SINGLE_SPIKE)
     for diagnostics, NOT as a gate.

Decision:
  favorable_sharpe >= 0.5 -> skip Step 4, go to Step 5 (deploy)
  favorable_sharpe 0.0-0.5 -> Step 4 (improve)
  favorable_sharpe < 0.0 -> drop, back to Step 2


===============================================================================
STEP 4: IMPROVE (The Kata)
===============================================================================

### 4a. Diagnose the obstacle

Read baseline metrics + .py code together. Ask:
"What is the SINGLE BIGGEST obstacle?"

  | Symptom | Likely Obstacle |
  |---------|----------------|
  | Low win rate | Entry catches falling knives |
  | High drawdown | Stoploss too wide |
  | Few trades | Signal too restrictive |
  | Short winners, long losers | Exit cuts winners early |
  | Alternating +/- windows | Regime dependent, needs filter |
  | Decaying Sharpe | Overfit to older data |

Write: "Obstacle: {what} because {why}. Target: {metric} from {current} to {goal}."

### 4b. Pick a tool

  Obstacle is parameters -> hyperopt
  Obstacle is missing filter/indicator -> code edit
  Obstacle is exit logic -> code edit
  Obstacle is stoploss -> code edit or hyperopt
  Uncertain which direction -> autoresearch (parallel exploration)
  Obstacle is fundamental (wrong entry thesis) -> drop candidate

### 4c. Run ONE experiment

  Make one change. Backtest. Compare to baseline.
  Improved -> keep, update baseline.
  Not improved -> revert, try different approach.

### 4d. Learn

  "Experiment: {change}. {metric}: {before}->{after}. Learning: {insight}."
  Post to feed. Record in kata-state.json.

### 4e. Loop or exit

  favorable_sharpe >= 0.5 -> exit to Step 5
  Making progress -> next experiment (same or new obstacle)
  Not making progress after 3 experiments -> try different tool:
    Were you doing code edits? -> try hyperopt
    Were you doing hyperopt? -> try autoresearch (parallel exploration)
    Tried everything? -> drop candidate, back to Step 2

  Hard limits: 5 experiments per obstacle, 3 obstacles per candidate


===============================================================================
STEP 5: DEPLOY
===============================================================================

  bot_start_paper(strategy, pair, timeframe, config)
  Read validation period from archetypes.yaml paper_validation[timeframe]
  Create campaign in campaigns.json
  Write kata-state.json outcome
  sync_state_to_supabase(state_key="campaigns", ...)

  Post to feed: "Deployed: {strategy} on {pair}/{tf} — favorable
    Sharpe {s}. Validating {days} days."


===============================================================================
STEP 6: GRADUATE OR RETIRE
===============================================================================

Handled by auto-mode (see auto-mode additions below).

Graduation: live Sharpe >= 0.5 after validation period
  -> write header tags, add to roster, sdna_attest, sdna_registry_add
  -> if live Sharpe >= 0.8: flag for signal publishing

Retirement: not profitable after validation, or early triggers
  -> stop bot, free slot, log learnings


===============================================================================
STEP 7: MULTIPLY
===============================================================================

After graduation, test winner on all 20 pairs (30s each).
Any pair with favorable Sharpe >= 0.5 -> deploy paper bot.
Each cross-pair bot validates independently.

Use a ClawTeam worker for the sweep:
  team_spawn_worker(
    name: "cross_pair_{strategy}",
    prompt: "Backtest {strategy} on all 20 pairs at {tf}.
      Report Sharpe per pair. Deploy paper bots where favorable
      Sharpe >= 0.5.",
    timeout_minutes: 20
  )


===============================================================================
KATA PLANNING
===============================================================================

Before Round 1, write a plan (30 seconds, not a tool call):

  KATA PLAN
  Gap: {archetype} on {pair}/{tf} (group: {group}, {n} graduates)
  Best lead: {source — triage hit / library / need to BUILD}
  Approach: {measure -> improve {what} / measure -> deploy if passes}
  Obstacle hypothesis: {expected problem from archetype history}
  Exit condition: favorable Sharpe >= 0.5 OR all rounds complete
  Fallback: deploy at 0.3+ / pivot to different candidate

Check the plan at every round exit. Drifting? Update or refocus.

Read kata-history/ for this archetype before writing the plan.
Past Katas tell you which obstacles are common and which experiments
worked or failed. Don't repeat failed experiments.


===============================================================================
ITERATION BUDGET (tool-call based)
===============================================================================

Wolf can count tool calls. Wolf cannot count minutes.

### With ClawTeam (default — triples experiment budget)

  Round 1: ORIENT + SCOUT     3 calls    parent session
  Round 2: MEASURE             2 calls    parent session
    (compound WF: 4 windows in 1 bash call + 1 read .py file)
    -> write kata-state.json
    -> spawn Round 3 worker    1 call     parent session
  Round 3: IMPROVE            25 calls    WORKER session (fresh context)
  Round 4: VALIDATE + DEPLOY   2 calls    parent session
    (compound WF in 1 call + 1 deploy call)

  Parent: 8 calls (17 spare for second Kata or cross-pair sweep)
  Worker: 25 calls (10+ experiment cycles)

### Without ClawTeam (inline fallback)

  Round 1: ORIENT + SCOUT     3 calls
  Round 2: MEASURE             2 calls    (compound WF)
  Round 3: IMPROVE            18 calls    (~8 experiment cycles)
  Round 4: VALIDATE + DEPLOY   2 calls    (compound WF)
  Total: 25 calls

### Round 3 worker spawn

  team_spawn_worker(
    name: "kata_r3_{strategy}_{pair}",
    prompt: "You are running improvement experiments on a trading
      strategy. Read /workspace/group/research-planner/kata-state.json
      for full context: baseline, obstacle diagnosis, strategy path.

      Current favorable Sharpe: {n}. Target: 0.5.
      Primary obstacle: {description}.

      TOOLS AVAILABLE:
      - Edit the .py file directly (default, use 80% of the time)
      - freqtrade_run_hyperopt for parameter optimization
      - swarm_trigger_autoresearch for parallel exploration when
        uncertain which direction to go (use after 3+ failed experiments)

      SNAPSHOT RULE (critical — do this every experiment):
      BEFORE each experiment:
        cp {strategy}.py {strategy}.py.snapshot
      If reverting:
        cp {strategy}.py.snapshot {strategy}.py
      If keeping:
        cp {strategy}.py {strategy}.py.snapshot
      This ensures every revert is perfectly clean. No partial changes
      from a forgotten revert contaminating the next experiment.

      FOR EACH EXPERIMENT:
      1. Snapshot the current .py file (cp to .snapshot)
      2. Diagnose or refine the obstacle
      3. Pick the right tool for this obstacle
      4. Make ONE change (code edit / hyperopt / autoresearch)
      5. Backtest: freqtrade_backtest(strategy, pairs=[{pair}],
           timeframe={tf}, timerange='20250101-20250424')
      6. Compare target metric to baseline
         Improved: keep change, update .snapshot to new baseline.
         Not improved: revert from .snapshot, try different approach.
      7. Record in kata-state.json experiments[]
      8. If favorable Sharpe >= 0.5: STOP

      COMPOUND WALK-FORWARD (saves 3 tool calls when re-measuring):
      When you need a full 4-window WF to check cumulative progress,
      run all 4 windows in a single bash command:
        freqtrade backtesting --strategy {name} --pairs {pair} \
          --timeframe {tf} --timerange 20250101-20250424 \
          --export trades --export-filename {name}_w0 && \
        freqtrade backtesting ... --timerange 20250424-20250815 \
          --export-filename {name}_w1 && \
        freqtrade backtesting ... --timerange 20250815-20251206 \
          --export-filename {name}_w2 && \
        freqtrade backtesting ... --timerange 20251206-{today} \
          --export-filename {name}_w3
      This is 1 tool call instead of 4.

      ESCALATION: if 3 code edits on the same obstacle show no
      progress, try hyperopt. If hyperopt doesn't help, try
      autoresearch (parallel structural mutations). If nothing
      works after 10 experiments, stop and report.

      When done, update kata-state.json:
        status: 'improved' or 'stuck'
        round: 4
      Post summary to agent feed.",
    timeout_minutes: 30
  )

### After EVERY round, three questions:

  1. "Deployable?" (favorable Sharpe >= 0.5) -> deploy now
  2. "Making progress?" -> yes: next round. no: pivot.
  3. "What did I learn?" -> one sentence posted to feed

### Post structured status after each round:

  KATA ROUND {n}/4 {parent/worker}
  Gap: {archetype} on {pair}/{tf}
  Candidate: {strategy}
  Favorable Sharpe: {current} (target: 0.5)
  Calls used: {n}/{budget}
  This round: {summary}
  Learning: {one sentence}
  Decision: {deploy / continue / pivot / spawn_worker}


===============================================================================
KATA STATE (persistent across sessions)
===============================================================================

File: /workspace/group/research-planner/kata-state.json

Written by parent (Rounds 1-2), updated by worker (Round 3),
read by auto-mode (Round 4 trigger). Survives container rotation.

### Schema

  {
    "kata_id": "kata_20260330_MR_SOL_1h",
    "created_at": "2026-03-30T15:00:00Z",
    "updated_at": "2026-03-30T15:25:00Z",

    "plan": {
      "gap": "MEAN_REVERSION on SOL/1h — range group, 0 graduates",
      "approach": "measure baseline, improve win rate",
      "obstacle_hypothesis": "BB+RSI entries catch falling knives",
      "exit_condition": "favorable Sharpe >= 0.5",
      "fallback": "deploy at 0.3+"
    },

    "round": 3,
    "status": "improving",

    "gap": {
      "archetype": "MEAN_REVERSION",
      "pair": "SOL/USDT:USDT",
      "timeframe": "1h",
      "correlation_group": "range"
    },

    "candidate": {
      "strategy": "MeanReversionQuant",
      "source": "triage_matrix",
      "file_path": "/workspace/group/user_data/strategies/MeanReversionQuant.py"
    },

    "baseline": {
      "favorable_sharpe": 0.42,
      "mean_sharpe": 0.16,
      "per_window": [0.39, 1.08, -0.47, -0.36],
      "trades_per_window": [9, 14, 17, 10],
      "max_dd_pct": -4.9,
      "win_rate": 0.35,
      "pattern": "ALTERNATING"
    },

    "obstacles": [
      {
        "id": 1,
        "name": "win_rate_low",
        "description": "Win rate 35% — RSI entries fire during downtrends",
        "target_metric": "win_rate",
        "target_from": 0.35,
        "target_to": 0.45,
        "status": "partially_resolved",
        "experiments_tried": 3
      }
    ],

    "experiments": [
      {
        "sequence": 1,
        "obstacle_id": 1,
        "change": "Added ADX < 25 filter",
        "tool": "code_edit",
        "target_metric": "win_rate",
        "before": 0.35,
        "after": 0.42,
        "kept": true,
        "learning": "ADX filter removes worst entries"
      }
    ],

    "current_metrics": {
      "favorable_sharpe": 0.48,
      "win_rate": 0.42,
      "max_dd_pct": -3.1
    },

    "worker": {
      "id": "kata_r3_MeanReversionQuant_SOL",
      "status": "running"
    },

    "outcome": null
  }

### Session resume logic

  On any new session, read kata-state.json:
    round 1-2 + status "planning"/"measured" -> container rotated, resume
    round 3 + status "improving" -> worker running, check worker status
    round 4 + status "improved" -> worker done, run Round 4
    round 4 + status "stuck" -> worker gave up, deploy best or skip
    outcome != null -> Kata complete, start new one


===============================================================================
KATA HISTORY (institutional memory)
===============================================================================

Directory: /workspace/group/research-planner/kata-history/

After each Kata completes, move kata-state.json to:
  kata-history/{kata_id}.json

Before starting a new Kata, read history for the target archetype:
  ls kata-history/kata_*_{archetype}_*.json

The experiments[] in past Katas tell you:
  - Which obstacles are common for this archetype
  - Which tools worked (code edit vs hyperopt vs autoresearch)
  - Which changes helped vs didn't
  - Why previous candidates were stuck

Example: starting MEAN_REVERSION Kata, read past SOL Kata:
"ADX filter helped, volume filter didn't, tighter stoploss helped.
Don't repeat volume experiment. Start with ADX + stoploss."


===============================================================================
CONTINUOUS TRIAGE
===============================================================================

Runs during idle time between auto-mode checks.
One strategy tested per idle cycle (~96/day).
Fills triage-matrix.json so Step 2 has pre-computed answers.

After auto-mode health check, if routine and next task > 5 min away:
  1. Read triage-matrix.json. Init queue if empty.
  2. Pop next strategy+pair.
  3. Backtest single window (30 sec).
  4. Classify:
     Result A (Sharpe >= threshold): 4-window WF, deploy if >= 0.5
     Result B (Sharpe 0.1-threshold): add to candidates
     Result C (Sharpe < 0.1): mark tested, try next pair next cycle
  5. Update triage-matrix.json.

State file: /workspace/group/research-planner/triage-matrix.json


===============================================================================
GRADUATION TIERS
===============================================================================

  Paper trading entry:  favorable Sharpe >= 0.5
  Portfolio graduation: live Sharpe >= 0.5 after validation period
  Signal publishing:    live Sharpe >= 0.8 after validation period

On graduation: sdna_attest + sdna_registry_add + aphexdata log


===============================================================================
SCHEDULING
===============================================================================

  Auto-mode:     every 15 min  (health + paper bot validation + triage + kata worker check)
  Market-timing: every 4 hours (regime scoring)
  Research:      daily 03:00   (full Kata loop)


===============================================================================
COMMANDS
===============================================================================

  "Show research status"       -> paper bots, gaps by group, portfolio estimate
  "Run research"               -> execute Kata loop
  "Research {archetype}"       -> Kata for that archetype
  "Fill the gap"               -> Kata for ALL gap archetypes
  "Show paper bots"            -> paper_trading campaigns with metrics
  "Retire {strategy}"          -> stop bot, free slot
  "Graduate {strategy}"        -> manual graduation
  "Show triage matrix"         -> tested counts, candidates
  "Run one triage cycle"       -> test one strategy
  "Show portfolio correlation" -> correlation matrix + Sharpe estimate


===============================================================================
EVENTS (aphexDATA)
===============================================================================

  kata_plan_created, kata_gap_selected, kata_candidate_found,
  kata_baseline, kata_experiment, kata_worker_spawned,
  kata_worker_completed, kata_deployed, kata_graduated,
  kata_retired, kata_retired_early, kata_cross_pair,
  triage_tested, triage_winner, portfolio_correlation_update


===============================================================================
CONFIG
===============================================================================

File: /workspace/group/research-planner/config.json

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
      "max_obstacles_per_candidate": 3,
      "spawn_worker_for_round_3": true
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


===============================================================================
THE SIMPLICITY TEST
===============================================================================

Wolf answers "what are you doing?" in one sentence:
  "Looking for a strategy to fill the range group."
  "Testing MeanReversionQuant on SOL."
  "Improving win rate — trying an ADX filter."
  "Waiting for the improvement worker to finish."
  "Paper trading 5 strategies."
  "Expanding a winner to more pairs."

# ClawTeam — Multi-Agent Research Coordination

You have access to ClawTeam tools (`mcp__clawteam__*`) that let you spawn
worker agents in separate containers. Each worker runs independently with
full tool access (freqtrade, swarm, aphexdna) and returns results when done.

## When to Use ClawTeam

Use ClawTeam when you have **multiple independent tasks** that benefit from
parallel execution. The decision is simple:

  Can the work be split into 2-3 independent pieces? → Use ClawTeam
  Is it one sequential task? → Run it directly, no workers needed

## Tools

### `team_spawn_worker(name, prompt, timeout_minutes)`
Spawns a worker container. Returns `worker_id` immediately.
- Workers are isolated: own filesystem, no conversation history
- The prompt must contain ALL context — workers have no memory of this chat
- Max 3 concurrent workers (configurable)

### `team_wait_all(worker_ids, timeout_minutes)`
Blocks until all workers complete. Returns aggregated results.
- Each result contains the worker's full text output
- Partial results returned on timeout

### `team_list_workers()`
Shows status of all workers spawned in this session.

## Critical Rules for Worker Prompts

1. **Self-contained**: Include every piece of context the worker needs.
   No "use the strategy we discussed" — paste the strategy name/path.
2. **Structured output**: Always tell workers to output JSON. You need
   to parse and compare results across workers.
3. **One task per worker**: Don't ask a worker to do 5 things. Give it
   one clear mission with one clear output format.
4. **No sub-spawning**: Workers cannot spawn their own workers.
5. **Timeout budget**: Default 30 min. Backtests need 5-10 min each,
   so budget accordingly. A worker running 7 mutations needs ~45 min.


═══════════════════════════════════════════════════════════════════════
PATTERN 1: PARALLEL AUTORESEARCH (Seed Mutation Swarm)
═══════════════════════════════════════════════════════════════════════

Use when: You have multiple seed strategies and want to explore mutations
on all of them simultaneously.

```
1. Load seeds: swarm_list_seeds → get available genomes
2. Spawn one worker per seed (or per seed group):
   team_spawn_worker(
     name="btc-trend-mutations",
     prompt="<worker prompt with seed JSON embedded>",
     timeout_minutes=45
   )
3. Wait: team_wait_all(worker_ids=[...])
4. Compare keepers across all workers
5. Cross-pollinate: if worker A found a good mutation, test it on
   worker B's seed in the next round
```

Worker prompt template:
```
You are a research worker. Your task:

1. Call swarm_execute_autoresearch with this spec:
{
  "seed_genomes": [<PASTE FULL SEED JSON>],
  "mutations_per_genome": 7,
  "timerange": "20250101-20260301",
  "keeper_sharpe_threshold": 0.3,
  "parent_sharpe_gate": true
}

2. Output ONLY this JSON:
{
  "seed_name": "<name>",
  "keepers_count": <n>,
  "rejects_count": <n>,
  "keepers": [<full keeper objects>],
  "best_keeper": {<best keeper details or null>},
  "mutation_families_tried": [<list of mutation types attempted>]
}
```

Conductor analysis after wait_all:
- Which seeds produced keepers? Which were barren?
- Did different seeds respond to similar mutation families?
- Rank all keepers by Sharpe/SI across the full swarm


═══════════════════════════════════════════════════════════════════════
PATTERN 2: STRUCTURAL AUTORESEARCH (v2 Prompt per Worker)
═══════════════════════════════════════════════════════════════════════

Use when: You want each worker to run the full 8-step AutoResearch
iteration (trade-level diagnosis → structural mutation → pre-flight →
backtest → gate) on different strategies or pairs.

This is DIFFERENT from Pattern 1. Pattern 1 uses swarm_execute_autoresearch
which runs parameter-level mutations at scale. Pattern 2 uses the v2
AutoResearch prompt which forces STRUCTURAL mutations only — logic
changes that hyperopt cannot search.

Use Pattern 2 when you want deeper, higher-quality improvements on
fewer strategies. Use Pattern 1 when you want broad numerical
exploration across many seeds.

```
1. Pick 2-3 strategies that need structural improvement
2. Spawn one worker per strategy, each with the full v2 prompt:
   team_spawn_worker(
     name="ema8-structural",
     prompt="<full v2 AutoResearch prompt with strategy path, pair, timeframe, window filled in>",
     timeout_minutes=60
   )
3. Wait: team_wait_all(worker_ids=[...])
4. Compare iteration reports across workers
5. Look for cross-strategy insights (did different strategies
   benefit from the same structural pattern?)
```

Worker prompt: Use the full AutoResearch v2 prompt (8 steps, trade
diagnosis table, mutation decision tree, pre-flight counterfactual
table, mechanical gate). Append this output instruction:

```
After completing Step 8, output your full Summary Report as-is.
Then append a JSON block:
{
  "strategy": "<name>",
  "mutation_type": "<category from Step 8>",
  "gate_result": "keep" | "revert",
  "sortino_delta": <number>,
  "sharpe_delta": <number>,
  "diagnosis_summary": "<one sentence>",
  "next_hypothesis": "<one sentence>"
}
```

Conductor analysis after wait_all:
- Did any workers KEEP their mutation? What type was it?
- Do the diagnoses reveal a common structural weakness across strategies?
- Can a kept mutation from one worker be applied to another's strategy?
- Feed "next_hypothesis" from kept results into the next round


═══════════════════════════════════════════════════════════════════════
PATTERN 3: CROSS-PAIR ALIGNMENT SWEEP
═══════════════════════════════════════════════════════════════════════

Use when: You have a strategy that works on one pair and want to know
where else it works (AutoResearch Loop A).

```
1. Define pair groups:
   - majors: ["BTC/USDT:USDT", "ETH/USDT:USDT"]
   - large_alts: ["SOL/USDT:USDT", "AVAX/USDT:USDT", "LINK/USDT:USDT"]
   - mid_alts: ["DOGE/USDT:USDT", "MATIC/USDT:USDT", "ARB/USDT:USDT"]

2. Spawn one worker per group:
   team_spawn_worker(
     name="majors-sweep",
     prompt="<backtest strategy X on each pair in [list], same timeframe and window>",
     timeout_minutes=45
   )

3. Wait and build a PAIR HEATMAP from results
```

Worker prompt template:
```
You are a research worker. Backtest the strategy at [path] on each of
these pairs: [BTC/USDT:USDT, ETH/USDT:USDT]

For EACH pair, use:
  Timeframe: 1h
  Window: 2025-06-01 to 2026-01-01
  Record: Sharpe, Sortino, Max DD, Trades, Win Rate, Total Profit

Output ONLY this JSON:
{
  "strategy": "<name>",
  "results": [
    {
      "pair": "BTC/USDT:USDT",
      "sharpe": <n>, "sortino": <n>, "max_dd": <n>,
      "trades": <n>, "win_rate": <n>, "profit_pct": <n>
    },
    ...
  ]
}
```

Conductor analysis:
- Which pairs have Sharpe > 0.5? Those are alignment candidates.
- Which pairs have negative Sharpe? The strategy is anti-correlated there
  (interesting — could it work as a short signal?).
- Build a strategy × pair matrix for the coverage dashboard.


═══════════════════════════════════════════════════════════════════════
PATTERN 4: EXIT MECHANICS A/B TEST
═══════════════════════════════════════════════════════════════════════

Use when: The strategy's entries look sound but exits are leaving money
on the table or triggering too early.

```
1. Pick the strategy and pair with the best entry quality
2. Spawn 3 workers, each testing a different exit approach:
   - Worker A: "Replace ROI table with ATR trailing stop"
   - Worker B: "Replace ROI table with indicator-based exit (RSI cross 70)"
   - Worker C: "Add partial take-profit: 50% at 1× ATR, remainder trails"
3. Wait and compare which exit mechanics produced the best Sortino
```

Worker prompt template:
```
You are a research worker. You will modify ONLY the exit mechanics of
the strategy at [path] and backtest the result.

Current exit: [describe current ROI table / stoploss / trailing config]

YOUR MODIFICATION:
Replace the exit logic with: [specific exit mechanic — be precise about
the implementation, not just the concept]

Implementation rules:
- Add new indicators in populate_indicators if needed
- Modify populate_exit_trend for signal-based exits
- Modify custom_stoploss for dynamic stoploss exits
- Do NOT change any entry logic
- Do NOT change any parameters except exit-related ones

Backtest with:
  Pair: [pair]
  Timeframe: [timeframe]
  Window: [start] to [end]

Output ONLY this JSON:
{
  "exit_type": "<name of exit mechanic>",
  "baseline": { "sharpe": <n>, "sortino": <n>, "max_dd": <n>, "trades": <n>, "profit_pct": <n> },
  "modified": { "sharpe": <n>, "sortino": <n>, "max_dd": <n>, "trades": <n>, "profit_pct": <n> },
  "delta": { "sharpe": <n>, "sortino": <n>, "max_dd": <n>, "trades": <n>, "profit_pct": <n> },
  "trade_list_changes": "<brief: how many trades changed exit reason, average holding period change>"
}
```

Conductor analysis:
- Which exit mechanic improved Sortino the most?
- Did any mechanic reduce drawdown significantly?
- Did the trade count change? (Over-aggressive exits kill trade count)
- Could two mechanics be combined? (e.g., partial TP + trailing)


═══════════════════════════════════════════════════════════════════════
PATTERN 5: REGIME-CONDITIONAL BRANCHING
═══════════════════════════════════════════════════════════════════════

Use when: Strategy performs well in some market conditions and poorly
in others. You want to build regime-aware logic.

```
1. First, characterize the regimes in your backtest window.
   Use CRO regime detection or ADX/volatility classification:
   - Trending (ADX > 25, directional)
   - Ranging (ADX < 20, mean-reverting)
   - Volatile (ATR expanding, high uncertainty)

2. Spawn workers to test the strategy in each regime:
   - Worker A: "Backtest only on bars where ADX > 25"
   - Worker B: "Backtest only on bars where ADX < 20"
   - Worker C: "Backtest only on bars where ATR(14) > 2× ATR(50)"

3. Compare: which regime does the strategy work in?

4. If clear regime preference: spawn a second round of workers to
   build regime-conditional logic:
   - Worker D: "Add regime gate: skip all entries when ADX < 20"
   - Worker E: "Add regime branch: use current logic when ADX > 25,
     flip to mean-reversion entries when ADX < 20"
```

Worker prompt template (Phase 1 — regime characterization):
```
You are a research worker. Backtest the strategy at [path] on [pair]
[timeframe] for window [start] to [end].

THEN analyze the trade list by regime:
1. For each trade, calculate ADX(14) at the entry bar
2. Classify each trade: TRENDING (ADX > 25), RANGING (ADX < 20),
   TRANSITIONAL (20-25)
3. Calculate separate metrics for each group

Output ONLY this JSON:
{
  "strategy": "<name>",
  "pair": "<pair>",
  "overall": { "sharpe": <n>, "sortino": <n>, "trades": <n>, "profit_pct": <n> },
  "by_regime": {
    "trending":      { "sharpe": <n>, "sortino": <n>, "trades": <n>, "profit_pct": <n>, "win_rate": <n> },
    "ranging":       { "sharpe": <n>, "sortino": <n>, "trades": <n>, "profit_pct": <n>, "win_rate": <n> },
    "transitional":  { "sharpe": <n>, "sortino": <n>, "trades": <n>, "profit_pct": <n>, "win_rate": <n> }
  },
  "regime_recommendation": "trending_only | ranging_only | all_regimes | needs_branching"
}
```


═══════════════════════════════════════════════════════════════════════
PATTERN 6: INDICATOR ORTHOGONALITY TEST
═══════════════════════════════════════════════════════════════════════

Use when: You want to find which NEW indicator adds the most value to
an existing strategy. Prevents the collinear indicator anti-pattern.

```
1. Identify what signal families the strategy already uses:
   - Momentum (RSI, MACD, Stochastic)
   - Trend (EMA, SMA, Supertrend)
   - Volatility (Bollinger, ATR, Keltner)
   - Volume (OBV, VWAP, CMF)

2. Spawn workers to each test adding an indicator from a DIFFERENT
   family than what the strategy already has:
   - Worker A: "Add OBV divergence confirmation" (if no volume indicators)
   - Worker B: "Add ATR regime filter" (if no volatility indicators)
   - Worker C: "Add higher-timeframe EMA trend" (if no multi-TF)

3. Compare which addition improved SI/Sortino the most
```

Worker prompt template:
```
You are a research worker. You will add ONE new indicator to the
strategy at [path] as an additional entry filter and measure the impact.

CURRENT STRATEGY SIGNALS: [list what indicators it already uses]

YOUR ADDITION:
Add [indicator name] as follows:
- Calculate [indicator] in populate_indicators
- Add entry condition: [specific condition, e.g., "only enter long
  when OBV is above its 20-period SMA"]
- Do NOT remove or change any existing entry conditions

Backtest with:
  Pair: [pair] | Timeframe: [timeframe] | Window: [start] to [end]

Output ONLY this JSON:
{
  "added_indicator": "<name>",
  "signal_family": "momentum | trend | volatility | volume | multi_tf",
  "baseline": { "sharpe": <n>, "sortino": <n>, "trades": <n>, "win_rate": <n>, "profit_pct": <n> },
  "with_indicator": { "sharpe": <n>, "sortino": <n>, "trades": <n>, "win_rate": <n>, "profit_pct": <n> },
  "trades_filtered_out": <n>,
  "filtered_trades_were_losers": <n out of filtered>,
  "verdict": "helpful | neutral | harmful"
}
```

Conductor analysis:
- Which indicator addition improved win rate without killing trade count?
- Did the filtered-out trades tend to be losers? (high precision filter)
- Combine the best addition with the structural mutation from Pattern 2


═══════════════════════════════════════════════════════════════════════
PATTERN 7: WALK-FORWARD VALIDATION SWARM
═══════════════════════════════════════════════════════════════════════

Use when: You have a strategy that looks good in-sample and want to
validate it won't fall apart out-of-sample. This is the critical step
before any strategy goes near live capital.

```
1. Define walk-forward windows (e.g., train 3 months, test 1 month):
   - Window 1: train 2025-01 to 2025-03, test 2025-04
   - Window 2: train 2025-02 to 2025-04, test 2025-05
   - Window 3: train 2025-03 to 2025-05, test 2025-06
   (rolling forward by 1 month each time)

2. Spawn workers per window (or group 2-3 windows per worker):
   team_spawn_worker(
     name="wf-window-1-2",
     prompt="<run hyperopt on train window, then backtest on test window>"
   )

3. Compare out-of-sample performance across all windows
```

Worker prompt template:
```
You are a research worker running walk-forward validation.

Strategy: [path]
Pair: [pair] | Timeframe: [timeframe]

WINDOW SET:
  Window A: Train 2025-01-01 to 2025-03-31, Test 2025-04-01 to 2025-04-30
  Window B: Train 2025-02-01 to 2025-04-30, Test 2025-05-01 to 2025-05-31

For EACH window:
1. Run hyperopt on the TRAIN period (100 epochs, Sharpe objective)
2. Take the best hyperopt result
3. Backtest that result on the TEST period (out-of-sample)
4. Record both in-sample and out-of-sample metrics

Output ONLY this JSON:
{
  "windows": [
    {
      "train_period": "2025-01-01 to 2025-03-31",
      "test_period": "2025-04-01 to 2025-04-30",
      "in_sample":  { "sharpe": <n>, "sortino": <n>, "trades": <n>, "profit_pct": <n> },
      "out_sample": { "sharpe": <n>, "sortino": <n>, "trades": <n>, "profit_pct": <n> },
      "degradation_pct": <(in_sample_sharpe - out_sample_sharpe) / in_sample_sharpe * 100>
    },
    ...
  ]
}
```

Conductor analysis:
- Mean degradation across windows. < 30% = robust. > 50% = overfit.
- Did any window show IMPROVEMENT out-of-sample? (rare, very bullish)
- Is degradation consistent or does one window blow up? (regime sensitivity)


═══════════════════════════════════════════════════════════════════════
PATTERN 8: SENTIMENT-STRATEGY CORRELATION
═══════════════════════════════════════════════════════════════════════

Use when: You want to test whether CT sentiment or on-chain data
improves strategy timing.

```
1. Spawn workers in parallel:
   - Worker A: Run CT sentiment analysis on the backtest window
   - Worker B: Backtest the strategy and export the full trade list
   - Worker C: Pull on-chain data (if Dune skill available) for the window

2. Conductor correlates:
   - Were losing trades clustered during specific sentiment phases?
   - Did on-chain whale activity precede strategy drawdowns?
   - Can sentiment be used as a regime gate (skip entries during
     extreme fear/greed)?
```

Worker A prompt (sentiment):
```
You are a research worker. Analyze crypto Twitter sentiment for [pair]
from [start] to [end].

Use the ct-sentiment skill to process available timeline data.
Identify periods of:
- Extreme bullish consensus (potential contrarian sell signal)
- Extreme fear (potential contrarian buy signal)
- Narrative shifts (new theme emerging)
- Conviction divergence (influencers disagree)

Output ONLY this JSON:
{
  "pair": "<pair>",
  "window": "<start> to <end>",
  "sentiment_phases": [
    {
      "start_date": "<date>",
      "end_date": "<date>",
      "phase": "extreme_bull | extreme_bear | shifting | neutral",
      "confidence": <0-1>,
      "key_narratives": ["<narrative>"],
      "contrarian_signal": "buy | sell | none"
    },
    ...
  ]
}
```

Worker B prompt: Standard backtest with full trade list export.

Conductor correlates by overlaying sentiment phases on trade results:
- "4 of 6 losing trades entered during extreme_bull sentiment phases"
- This becomes a hypothesis for Pattern 2: "Add sentiment regime gate"


═══════════════════════════════════════════════════════════════════════
PATTERN SELECTION GUIDE
═══════════════════════════════════════════════════════════════════════

When deciding which pattern to use, follow this decision tree:

  "Do I have a strategy that works and want to improve it?"
  → Is the problem entries or exits?
    → Entries: Pattern 6 (orthogonal indicators) or Pattern 5 (regime)
    → Exits: Pattern 4 (exit A/B test)
    → Both/unclear: Pattern 2 (structural autoresearch)
  → Want to scale improvements across many strategies?
    → Pattern 1 (parallel seed mutation)

  "Do I have a strategy and want to know WHERE it works?"
  → Pattern 3 (cross-pair sweep)

  "Do I have a strategy and want to validate it's not overfit?"
  → Pattern 7 (walk-forward validation)

  "Do I want to explore whether external data helps?"
  → Pattern 8 (sentiment-strategy correlation)

  "I just want to improve one strategy deeply"
  → Run Pattern 2 first (structural diagnosis)
  → Then Pattern 5 (regime analysis) if diagnosis suggests regime issues
  → Then Pattern 4 (exit A/B) if diagnosis points to exit problems
  → Then Pattern 7 (walk-forward) to validate the improvements
  → This is the FULL RESEARCH PIPELINE — 4 rounds of ClawTeam runs


═══════════════════════════════════════════════════════════════════════
COMPOSING PATTERNS: THE RESEARCH PIPELINE
═══════════════════════════════════════════════════════════════════════

The patterns above are building blocks. A full research session
chains them:

```
ROUND 1 — UNDERSTAND (Patterns 2 + 5)
  Spawn 3 workers:
    Worker A: Structural autoresearch on strategy (Pattern 2)
    Worker B: Regime characterization (Pattern 5, phase 1)
    Worker C: Cross-pair sweep on 6 pairs (Pattern 3)
  
  Result: You know what's wrong, which regimes matter, which pairs work.

ROUND 2 — IMPROVE (Patterns 4 + 6)
  Based on Round 1 findings, spawn workers:
    Worker A: Exit A/B test with 3 mechanics (Pattern 4)
    Worker B: Add best orthogonal indicator (Pattern 6)
    Worker C: Apply structural mutation from Round 1 to other pairs
  
  Result: You have a concrete improved strategy.

ROUND 3 — VALIDATE (Pattern 7)
  Spawn 3 workers for walk-forward validation:
    Worker A: Windows 1-2
    Worker B: Windows 3-4
    Worker C: Windows 5-6
  
  Result: You know if the improvements hold out-of-sample.

ROUND 4 — ENRICH (Pattern 8, optional)
  Spawn workers to test external data:
    Worker A: CT sentiment correlation
    Worker B: On-chain data correlation
  
  Result: You know if external signals add further edge.
```

Total: ~4 rounds, ~12 worker spawns, ~3-4 hours.
Output: A validated, structurally improved, regime-aware strategy
with sentiment overlay assessment.


═══════════════════════════════════════════════════════════════════════
IMPORTANT NOTES
═══════════════════════════════════════════════════════════════════════

- Workers do NOT have ClawTeam tools — they cannot spawn sub-workers
- Workers have a default 30-minute timeout (configurable up to 120 min)
- Worker output is captured as text — always require JSON output
- If a worker fails, team_wait_all returns with the failure info
- Keep worker names short and descriptive (max 30 chars)
- Start with 2 workers for your first run to verify the pipeline works
  before scaling to 3
- The conductor (you) is responsible for cross-worker analysis — workers
  don't talk to each other, only to you
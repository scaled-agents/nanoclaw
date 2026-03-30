---
name: research-planner
description: >
  Autonomous strategy research pipeline. Connects missed-opportunity detection
  (auto-mode) to targeted autoresearch (FreqSwarm), manages multi-archetype
  coverage, handles cold-start bootstrapping, and graduates strategies into
  auto-mode's deployment roster. Trigger on: "research priorities",
  "research status", "research plan", "run research planner", "fill the gap", "fill strategy gaps",
  "bootstrap nova", "scan nova", "graduate strategy", "research <archetype>",
  "approve extra round", "abandon campaign".
---

# Research Planner — Closing the Missed Opportunity Loop

The research planner connects demand (missed opportunities logged by auto-mode)
to supply (graduated strategies ready for deployment). It reads what the market
needs, finds or creates strategies to fill the gaps, runs them through
autoresearch mutation testing, graduates keepers through walk-forward validation,
and writes header tags so auto-mode can stage them.

**Key principle: The planner never deploys. It researches, validates, and tags.
Auto-mode discovers tagged strategies and handles staging/deployment.**


═══════════════════════════════════════════════════════════════════════
PART 1: DEPENDENCIES
═══════════════════════════════════════════════════════════════════════

| Skill | What it provides |
|-------|-----------------|
| auto-mode | `missed-opportunities.json`, `missed_opportunity_daily_summary` events, roster |
| freqswarm | `swarm_scan_strategy`, `swarm_trigger_autoresearch`, `swarm_poll_run`, `swarm_job_results`, `swarm_check_graduation_gates`, `swarm_graduate_keeper`, `swarm_autoresearch_history`, `swarm_list_seeds`, `swarm_load_seed` |
| clawteam | `team_spawn_worker`, `team_wait_all` for Tier 3 structural creation |
| archetype-taxonomy | `archetypes.yaml` — 7 archetypes, strategy_tags, risk_profiles |
| aphexdna | `sdna_registry_search`, `sdna_fork`, `sdna_compile`, `sdna_attest`, `sdna_registry_add` |
| aphexdata | `aphexdata_record_event`, `aphexdata_query_events` |


═══════════════════════════════════════════════════════════════════════
CONSOLE SYNC — MANDATORY
═══════════════════════════════════════════════════════════════════════

After EVERY atomic write of campaigns.json, call:
  sync_state_to_supabase(state_key="campaigns",
    file_path="/workspace/group/research-planner/campaigns.json")

The console dashboard reads from Supabase, not local files.
This applies to: Step 5, Step 7, Step 8, graduation writes,
abandonment writes, and any other campaigns.json modification.
If you skip the sync call, the console will show stale data.


═══════════════════════════════════════════════════════════════════════
PART 2: PIPELINE STAGES
═══════════════════════════════════════════════════════════════════════

```
DETECTED → PLANNED → SEEDED → TRIAGED ──→ RESEARCHING ──→ GRADUATED → STAGED → COMPLETED
                                  │    ↘                        │
                                  │   HYPEROPT → RESEARCHING    │
                                  │        ↓                    │
                                  │   (re-triage result)   NEAR_MISS
                                  │                        (user decides)
                                  └─ VALIDATE_ONLY ──────→ GRADUATED
                                  └─ SKIP ──────────────→ ABANDONED
                                budget exhausted → ABANDONED
                      no seeds → DEFERRED            auto-mode takes over
```

| Stage | Entry | Action | Exit |
|-------|-------|--------|------|
| `detected` | Auto-mode logs `missed_opportunity` | Aggregate: frequency × avg_composite | Threshold met (freq ≥ 3 in 7d OR avg_composite ≥ 4.0) |
| `planned` | Threshold met, campaign created | Assign archetype, targets, budget, fitness criteria from archetypes.yaml | Seeds identified (≥1 seed) |
| `seeded` | ≥1 seed strategy found | Run pre-gate triage on each seed | Triage complete, mode selected |
| `triaged` | Pre-gate WF complete | Classify WF pattern + select research mode via decision tree | Mode selected → next state |
| `hyperopt` | Mode=HYPEROPT selected | Run `freqtrade_run_hyperopt`, re-triage best result | Passes gates → graduated; fails → researching (param_pin) |
| `researching` | Mode=PARAM_PIN or STRUCTURAL selected, or HYPEROPT escalated | Poll with `swarm_poll_run`, check for keepers | Keeper found OR budget exhausted |
| `near_miss` | Budget exhausted but best keeper within 10% of graduation threshold | Message user with metrics + options | User approves → `researching` (+1 round); declines → `abandoned` |
| `graduated` | Keeper passes walk-forward gate | Write header tags, register in sdna, log to aphexDATA | Strategy file tagged |
| `staged` | Header tags written | Auto-mode discovers on next scan | Campaign → `completed` |

**Terminal states:** `completed`, `abandoned`, `deferred`


═══════════════════════════════════════════════════════════════════════
PART 3: SEED DISCOVERY CASCADE
═══════════════════════════════════════════════════════════════════════

For each campaign in `planned` state, try these tiers in order. Stop at the
first tier that produces ≥1 viable seed.

### Tier 1: Nova Strategy Scan (cheapest)

Scan existing .py strategy files to classify by archetype.

```
Procedure:
1. List .py files in /workspace/group/user_data/strategies/
   (plus any nova/ directory if mounted)
2. Check nova-scan.json cache — skip already-classified strategies
3. For each unclassified strategy:
   a. swarm_scan_strategy(name) → get StrategyFacts + MutationEligibility
   b. Match StrategyFacts.indicators against archetypes.yaml strategy_tags:
      - RSI, Bollinger, Stochastic → MEAN_REVERSION
      - EMA crossover, ADX, MACD → TREND_MOMENTUM
      - Donchian, range_breakout → BREAKOUT
      - Support/resistance, grid → RANGE_BOUND
      - Supertrend, ATR expansion → VOLATILITY_HARVEST
      - Funding rate → CARRY_FUNDING
      - Micro_trend, tick → SCALPING
   c. Store classification in nova-scan.json. IMPORTANT: also store the full
      strategy_facts and strategy_ref from the scan result — you will need
      these when building the AutoresearchSpec (facts is REQUIRED for
      derived_subclass seeds, without it 0 variants are generated).
4. For the target archetype: pick strategies with matching classification
   AND that pass the Seed Quality Gate (below) as seeds
```

**Pre-Gate Triage — test before mutating:**

Before running full autoresearch on a seed, test it AS-IS through the full
walk-forward validation. A strategy that already works doesn't need mutation —
it needs validation. This saves autoresearch budget and catches strategies
that are already viable at their default parameters.

```
Pre-Gate Triage procedure (run BEFORE Seed Quality Gate):
1. For each candidate seed matched to the target archetype:
   a. Run a full N-window walk-forward backtest on the target pair(s)
      using the strategy's default parameters (no mutations).
      Use: swarm_trigger_autoresearch with mutations_per_genome=0
      OR run individual backtests per window via freqtrade_backtest.
   b. Collect per-window Sharpe, trade count, max drawdown.
   c. Check against archetype graduation_gates from archetypes.yaml:
      - Trades per window >= graduation_gates.min_trades_per_window
      - Mean WF Sharpe >= graduation_gates.min_wf_sharpe
      - Max drawdown < graduation_gates.max_drawdown_pct
      - WF degradation < graduation_gates.max_wf_degradation_pct
   d. Classify walk-forward pattern (see Part 5, Step 1c).
   e. If the strategy passes ALL graduation criteria at default params:
      → GRADUATE IMMEDIATELY. Skip autoresearch entirely.
        Write header tags, register, stage — same as Step 3 in Part 5.
        Log: aphexdata_record_event(verb_id="research_graduated",
          result_data={..., graduation_path: "pre_gate_triage"})
   f. If the strategy produces trades but doesn't pass graduation:
      → Proceed to Seed Quality Gate. It's a valid seed for mutation.
   g. If the strategy produces 0 trades on the target pair:
      → Reject as seed. Do NOT submit to autoresearch.

Key insight: A strategy with zero hyperopt params but Sharpe 0.7 is more
valuable than one with 10 params and Sharpe 0.1. Test the signal first,
then optimize parameters only if the base signal has potential.
```

**Research Mode Selection — choose the right tool for the diagnosis:**

After pre-gate triage completes, you have per-window Sharpe values, trade counts,
and WF pattern classification for each seed. Use this decision tree to select the
cheapest effective research mode. The principle: start cheap, escalate only when
the cheaper tool fails.

```
RESEARCH MODE DECISION TREE
════════════════════════════

Triage Sharpe >= graduation_gates.min_wf_sharpe?
├─ YES + CONSISTENT pattern → VALIDATE_ONLY
│   (Graduate immediately — no mutation needed)
├─ YES + DEGRADING pattern → HYPEROPT
│   (Good signal exists but overfits — reoptimize params)
├─ YES + ALTERNATING pattern → PARAM_PIN
│   (Regime-dependent — try param variations)
├─ YES + SINGLE_SPIKE → PARAM_PIN
│   (Lucky streak? Mutation tests if edge is real)
│
├─ NO (Sharpe 0.1 to threshold) + >=min_trades → HYPEROPT
│   (Some signal — let hyperopt find better params)
├─ NO (Sharpe 0.1 to threshold) + <min_trades → STRUCTURAL
│   (Signal too weak for param tuning — needs code changes)
├─ NO (Sharpe < 0.1) + any pattern → SKIP
│   (No detectable edge — don't waste budget)
└─ 0 trades → SKIP (pair/timeframe mismatch)

Threshold = archetype.graduation_gates.min_wf_sharpe
```

Research modes and their costs:

| Mode | Cost | Duration | What it does |
|------|------|----------|-------------|
| VALIDATE_ONLY | 0 budget | ~30s | Already passes — graduate directly |
| HYPEROPT | 1 autoresearch slot | ~15 min | `freqtrade_run_hyperopt` on full timerange, then re-triage best result |
| PARAM_PIN | 1 autoresearch slot | ~20 min | Standard autoresearch mutation batch (current behavior) |
| STRUCTURAL | 1 clawteam slot | ~45 min | ClawTeam creates entry/exit variants |
| HYBRID | 1 each | ~35 min | Hyperopt first, then param_pin on best result |
| SKIP | 0 | 0 | Reject seed, try next |

Mode selection updates campaign state:
```
VALIDATE_ONLY → state: "graduated" (skip researching entirely)
HYPEROPT → state: "hyperopt"
PARAM_PIN → state: "researching" (current flow, unchanged)
STRUCTURAL → state: "researching" (via clawteam)
HYBRID → state: "hyperopt" (then auto-transitions to "researching")
SKIP → remove from seed list; if no seeds remain → state: "abandoned"

Log mode selection:
  aphexdata_record_event(verb_id="research_mode_selected", result_data={
    campaign_id, seed_name, triage_sharpe, wf_pattern, selected_mode,
    decision_reason: "sharpe_above_threshold+consistent_pattern"
  })
```

Escalation ladder — each step only triggers if the previous one didn't solve the problem:
```
Triage (30s, free) → VALIDATE_ONLY if passes
                   → HYPEROPT (15min, 1 slot) if signal exists
                     → Graduate if hyperopt passes
                     → PARAM_PIN (20min, 1 slot) if improved but not passing
                       → Graduate if keeper found
                       → STRUCTURAL (45min, 1 clawteam slot) if no keepers
                         → Graduate if ClawTeam variant passes
                         → ABANDONED if all fail
```

**Seed Quality Gate — apply to ALL seeds before submission (Tier 1, 2, or 3):**
```
A seed is only viable if ALL of the following hold:
1. ARCHETYPE MATCH: The seed's core entry logic matches the target archetype.
   A momentum-biased seed (MACD crossover, EMA trend) will produce 0 trades
   when the market needs mean_reversion (RSI oversold, Bollinger bounce).
   Check the actual indicator logic, not just the name.
2. MUTATION SURFACE (backend-dependent):
   - sdna_compile seeds: must have ≥2 eligible behavioral families
     (adjust_params, swap_indicator, add_filter). param_pin and
     risk_override are not available for this backend.
   - derived_subclass seeds: param_pin with ≥3 eligible hyperopt params
     is sufficient mutation surface. risk_override + param_pin together
     explore stoploss/ROI variations AND parameter combinations — enough
     to find edge. If the strategy has <3 hyperopt params AND no static
     stoploss → reject (insufficient surface).
3. CONTINUOUS PARAMS (backend-dependent):
   - sdna_compile seeds: entry/exit parameters must include at least one
     continuous (int/float) parameter for adjust_params to work.
     All-categorical genomes produce 0 adjust_params variants.
   - derived_subclass seeds: categorical params are viable — param_pin
     samples from the choices list. No restriction on param types.
4. DATA CONFIRMED: OHLCV data must exist for ALL pairs the strategy needs,
   including informative pairs from @informative decorators. Verify with
   swarm_scan_strategy() before submitting.
5. PRODUCES TRADES: If a quick triage backtest (single window) shows 0 trades,
   the seed is non-viable. Do NOT submit a full autoresearch run — it will
   waste budget on 0-trade mutations of a 0-trade seed.

If no Tier 1/2 seeds pass this gate → skip directly to Tier 3 (sdna creation).
Do not waste autoresearch budget on marginal seeds.
```

**Parallelization:** For bulk scans (>5 strategies), use ClawTeam workers:
```
team_spawn_worker(
  name: "nova_scan_batch_1",
  prompt: "Scan these strategies with swarm_scan_strategy and classify
    by archetype. Strategies: [list]. Return JSON array of
    {name, archetype, eligible, indicators}.",
  timeout_minutes: 15
)
```
Up to 3 workers scanning in parallel.

### Tier 2: sdna Registry Search

Search the aphexDNA registry for genome-based seeds.

```
Procedure:
1. Get archetype strategy_tags from archetypes.yaml
2. sdna_registry_search(tags=strategy_tags) → list of matching genomes
3. If matches found:
   a. sdna_registry_show(genome_id) → inspect genome
   b. sdna_fork(genome_id, mutations=[]) → create a copy as starting point
4. These genomes use the sdna_compile backend in autoresearch
```

### Tier 3: ClawTeam Structural Creation (expensive, last resort)

When no existing strategies match the target archetype — **or when Tier 1/2
seeds fail the Seed Quality Gate** (e.g., only param_pin mutations available,
wrong archetype logic, categorical params) — use ClawTeam to create a
purpose-built sdna seed. Two modes, tried in order:

**Mode A: Fork from adjacent archetype (preferred)**

Borrow a strategy from a related archetype and mutate toward the target.

| Target Archetype | Borrow From | Mutation Direction |
|-----------------|-------------|---------------------|
| BREAKOUT | TREND_MOMENTUM | + Donchian channel, + volatility expansion filter, - trailing logic |
| RANGE_BOUND | MEAN_REVERSION | + S/R detection, + range filter, - trend filters |
| VOLATILITY_HARVEST | BREAKOUT | + ATR expansion, + Supertrend, widen stops |
| CARRY_FUNDING | MEAN_REVERSION | + funding rate indicator, extend to 4h/1d, reduce signal frequency |
| SCALPING | TREND_MOMENTUM | shorten to 5m/15m, tighten stops, increase trade frequency |

```
team_spawn_worker(
  name: "tier3_fork_adjacent",
  prompt: "You have a {source_archetype} strategy at {path}.
    Goal: mutate it toward {target_archetype}.
    Changes needed: {mutation_direction}.
    1. Read the strategy file
    2. Create a modified version with the changes
    3. Write to /workspace/group/user_data/strategies/{NewName}.py
    4. Run a quick backtest: freqtrade_backtest(strategy={NewName}, ...)
    5. Return JSON: {name, sharpe, trades, drawdown, success}",
  timeout_minutes: 30
)
```

**Mode B: Generate from archetype definition (fallback)**

```
team_spawn_worker(
  name: "tier3_generate",
  prompt: "Create a new FreqTrade IStrategy for the {archetype} archetype.
    Archetype definition from archetypes.yaml:
      description: {description}
      preferred_regimes: {regimes}
      strategy_tags: {tags}
      risk_profile: max_dd={max_dd}, win_rate={win_rate}, rr={rr_ratio}
    Target pair: {pair}, Timeframe: {timeframe}
    Requirements:
    - Must be a complete IStrategy subclass
    - Must use indicators from strategy_tags
    - Must implement populate_indicators, populate_entry_trend, populate_exit_trend
    - Add header tag: # ARCHETYPE: {archetype}
    Write to /workspace/group/user_data/strategies/{Name}.py
    Run a quick backtest. Return JSON: {name, sharpe, trades, drawdown}",
  timeout_minutes: 60
)
```

Both modes: max 2 attempts per archetype. If the generated strategy has
Sharpe >= 0.0, use it as a seed for autoresearch. If Sharpe < 0.0 on both
attempts → campaign `deferred`.


═══════════════════════════════════════════════════════════════════════
PART 3C: CONTINUOUS TRIAGE (IDLE-TIME RESEARCH)
═══════════════════════════════════════════════════════════════════════

Between scheduled tasks, triage untested strategies one at a time
during idle periods. No batch — just steady progress filling the
triage matrix. The matrix feeds into seed discovery (Part 4, Step 6)
so the planner already knows what works before creating campaigns.

### When to Run

Auto-mode triggers one triage cycle after completing a routine health
check (see auto-mode skill for the trigger). The research planner
executes the cycle using this procedure.

Do NOT run triage if:
- A triage cycle completed less than 3 minutes ago
- An autoresearch run is actively being polled
- The triage queue is empty (all strategies tested against all top pairs)
- The agent is in a user message container (triage runs in task containers only)

### State File: triage-matrix.json

Location: `/workspace/group/research-planner/triage-matrix.json`

Created on first triage cycle if it doesn't exist.

```json
{
  "version": 1,
  "queue_position": 0,
  "total_strategies": 0,
  "tested": 0,
  "result_a_count": 0,
  "result_b_count": 0,
  "result_c_count": 0,
  "last_cycle": null,
  "last_queue_reset": null,
  "top_missed_pairs": [],
  "queue": [],
  "candidates": [],
  "winners": [],
  "tested_results": []
}
```

Field definitions:
- `queue`: ordered list of strategy names not yet tested
- `queue_position`: current index in the queue (for resuming)
- `top_missed_pairs`: the 5 pairs with most missed opportunities (refreshed on queue reset)
- `candidates`: Result B strategies — have some edge, need research
- `winners`: Result A strategies — passed triage, pending or completed WF validation
- `tested_results`: rolling log of all triage results (strategy, pair, sharpe, trades, result, tested_at)

### One Triage Cycle Procedure (~2-3 minutes)

**Step 1: Initialize or load queue**

Read `/workspace/group/research-planner/triage-matrix.json`.

If the file doesn't exist OR queue is empty OR `last_queue_reset` is
more than 7 days ago:

  1. List all .py files in `/workspace/group/user_data/strategies/`
  2. Exclude strategies already in `tested_results` where ALL top 5
     pairs have been tested (fully exhausted strategies)
  3. Read `/workspace/group/auto-mode/missed-opportunities.json`
     Aggregate by pair, sort by hit_count descending, take top 5
     Store as `top_missed_pairs`
  4. Build queue: list of strategy names, sorted alphabetically
     (deterministic order, no cherry-picking)
  5. Set `queue_position` = 0, `last_queue_reset` = now
  6. Write triage-matrix.json

If queue exists and is not stale: continue from `queue_position`.

**Step 2: Pick next strategy and pair**

  strategy_name = queue[queue_position]

  For this strategy, check tested_results: which of the top 5 pairs
  has it NOT been tested against yet?

  pair = first untested pair from top_missed_pairs for this strategy

  If all 5 pairs tested for this strategy:
    Mark strategy as "exhausted" in tested_results
    Increment queue_position
    If queue_position >= len(queue): log "Triage queue complete"
    Write triage-matrix.json
    Return (cycle done, no backtest needed)

**Step 3: Run single-window backtest**

  freqtrade_backtest(
    strategy=strategy_name,
    pairs=[pair],
    timeframe="1h",
    timerange="20250101-20250424",
    config_path=<standard config>
  )

  Extract from results: sharpe, trade_count, max_drawdown_pct

  If backtest fails (strategy error, import error, etc.):
    Record in tested_results: { strategy, pair, sharpe: null,
      trades: 0, result: "ERROR", error: "<message>", tested_at }
    Move to next pair for this strategy on next cycle
    Return

**Step 4: Classify result**

  Read the archetype's graduation gates from archetypes.yaml.
  Use the strategy's classified archetype from nova-scan.json if
  available. If not classified, use the default gates (config.json
  fallback: min_wf_sharpe=0.5).

  Result A: sharpe >= graduation_gates.min_wf_sharpe
            AND trade_count >= graduation_gates.min_trades_per_window

    → IMMEDIATE ACTION within this same triage cycle:

    1. Run full 4-window walk-forward:
       Use scripts/triage_wf.py or run 4 sequential backtests:
         W0: 20250101-20250424
         W1: 20250424-20250815
         W2: 20250815-20251206
         W3: 20251206-20260329

    2. Classify the WF pattern (Part 5, Step 1c):
       CONSISTENT / DEGRADING / ALTERNATING / SINGLE_SPIKE

    3. If CONSISTENT or CONDITIONAL PASS:
       → GRADUATE on the spot
       → Write header tags to strategy .py file
       → Add to roster.json
       → Post to feed: "Idle triage graduation: {strategy} on
         {pair}/{tf} — WF Sharpe {mean}, pattern {pattern}"
         tags: ["graduation", "triage"]
       → Add to winners[] with graduated: true
       → aphexdata_record_event(verb_id="triage_graduation",
           result_data={ strategy, pair, mean_sharpe, pattern })

    4. If DEGRADING or SINGLE_SPIKE:
       → Add to winners[] with graduated: false, needs_research: true
       → The research planner will route to HYPEROPT or STRUCTURAL
         on its next planning cycle

    5. If ALTERNATING:
       → Check regime correlation (Part 5, Step 1c)
       → If correct regime: CONDITIONAL PASS → graduate with
         regime-gated deployment flag
       → If wrong regime: reclassify, add to candidates[] under
         correct archetype

  Result B: sharpe >= 0.1 AND sharpe < graduation threshold

    → Add to candidates[] in triage-matrix.json:
      { strategy, pair, timeframe: "1h", sharpe, trades, max_dd,
        archetype, triage_result: "B", tested_at }
    → Log only. The research planner uses candidates as seeds
      during its next planning cycle.
    → If sharpe > 0.3: post to feed:
      "Triage candidate: {strategy} on {pair} Sharpe {sharpe}"
      tags: ["triage", "finding"]

  Result C: sharpe < 0.1

    → Record in tested_results only:
      { strategy, pair, sharpe, trades, triage_result: "C", tested_at }
    → On the NEXT triage cycle for this strategy, try the next
      untested pair from top_missed_pairs
    → If Result C on all 5 pairs: mark as "exhausted"

**Step 5: Update state**

  Record result in tested_results[]
  Update counts: result_a_count, result_b_count, result_c_count
  Update tested count
  If the current strategy has been tested against the current pair,
  advance: either next pair (same strategy) or next strategy
  Update queue_position if moving to next strategy
  Update last_cycle = now
  Write triage-matrix.json (atomic: write .tmp then rename)

### Triage Matrix Integration with Seed Discovery

In Part 4 (Daily Planning Cycle), Step 6 (Seed Discovery), BEFORE
running the 3-tier seed cascade:

  1. Read triage-matrix.json

  2. Filter candidates[] by campaign archetype + target pair:
     matching = candidates.filter(c =>
       c.archetype == campaign.archetype &&
       campaign.target_pairs.includes(c.pair))

  3. If matching candidates exist (Result B):
     → Use the BEST candidate (highest sharpe) as the seed
     → Skip the Tier 1-2-3 cascade entirely
     → Proceed to Research Mode Selection (Part 3B)
     → Log: "Using triage candidate {strategy} (Sharpe {n}) as
       seed — skipping discovery cascade"

  4. Filter winners[] by archetype + pair (Result A, not yet graduated):
     → These need walk-forward validation, not research
     → If found, run WF immediately and graduate if passes

  5. If no matching candidates or winners:
     → Run the 3-tier seed cascade as normal

This means the triage matrix short-circuits the most expensive
part of campaign setup (seed discovery) with a pre-computed answer.

### Queue Reset (Weekly)

Every Monday 03:00 UTC (aligned with budget reset):
  - Rebuild queue from strategies directory (picks up new strategies)
  - Refresh top_missed_pairs from latest missed-opportunities.json
  - Clear "exhausted" flags (market conditions change week to week)
  - KEEP tested_results history (append, don't overwrite)
  - KEEP candidates and winners (these are valuable data)
  - Reset queue_position to 0

This means every strategy gets re-tested against the CURRENT top
missed-opportunity pairs weekly. A strategy that was Result C on
SOL last week might be Result B on DOGE this week if the missed
opportunities shifted.

### Throughput

  Auto-mode cycles: 96/day (every 15 min)
  Triage cycles: ~80/day (some cycles skipped due to state changes)
  Backtests per cycle: 1 (30 seconds each)
  Strategies in library: ~455
  Top pairs tested: 5
  Total combinations: 455 × 5 = 2,275
  Days to first pass: ~28 (2,275 / 80)
  After first pass: weekly re-triage against updated pairs

  Result A strategies (estimated 1-5% of library): 5-23 strategies
  that may already pass graduation without ANY research budget.
  These are free graduations — the triage found them, not mutation.


═══════════════════════════════════════════════════════════════════════
PART 4: DAILY PLANNING CYCLE
═══════════════════════════════════════════════════════════════════════

Scheduled: `0 3 * * *` (daily 03:00 UTC).
Can also be triggered manually: "Run research planner".
Budget caps remain weekly (reset Monday 03:00 UTC) — daily runs just
react faster to new gaps without increasing total spend.

### Step 1: Read missed opportunity data

```
Sources:
- /workspace/group/auto-mode/missed-opportunities.json (rolling 50-entry buffer)
- aphexdata_query_events(
    verb_id="missed_opportunity_daily_summary",
    object_type="report",
    limit=7
  )

Aggregate by unique (archetype, pair, timeframe):
  hit_count, avg_composite, max_composite, days_seen
```

### Step 2: Read current state

```
Read:
- /workspace/group/research-planner/campaigns.json
- /workspace/group/auto-mode/roster.json (staged strategies)
- /workspace/group/research-planner/nova-scan.json (cached classifications)
- /workspace/group/research-planner/config.json (user overrides)

Determine budget mode:
- Count archetypes with ≥1 graduated strategy in roster
- If < 7 → cold_start_mode = true (doubled budget caps)
- If = 7 → cold_start_mode = false (normal caps)

Reset weekly budget counters.
```

### Step 3: Identify gaps

```
For each archetype in archetypes.yaml:
  staged_count = count strategies in roster.json with matching archetype
  if staged_count == 0 → cold_start_archetype = true

For each aggregated cell from Step 1:
  if hit_count >= 3 OR avg_composite >= 4.0:
    if no existing campaign covers (archetype, pair, timeframe) in non-terminal state:
      → new_target
```

### Step 4: Prioritize

```
For each target (new or existing campaign):
  cold_start_bonus = 1.0 if archetype has zero staged strategies, else 0.0
  priority_score = (hit_count × 0.4) + (avg_composite × 2.0) + (cold_start_bonus × 3.0)

Sort descending.
Cap at max_active_campaigns (cold-start: 4, normal: 2) minus current active count.
```

### Step 5: Create/update campaigns

```
For new targets (within cap):
  Create campaign object in campaigns.json with state: "planned"
  Log: aphexdata_record_event(verb_id="research_campaign_created", ...)

For existing campaigns:
  Check if source cell still scoring above threshold
  If cell below threshold for 14+ consecutive days → state: "abandoned"
  Log: aphexdata_record_event(verb_id="research_abandoned", reason="cell_score_dropped")
```

### Step 6: Seed discovery

### Step 6 Pre-Check: Triage Matrix Lookup

Before running the 3-tier seed cascade, check the triage matrix
for pre-computed answers:

  Read /workspace/group/research-planner/triage-matrix.json

  For the campaign's target archetype + target pairs:

  1. Check winners[]:
     winners_match = winners.filter(w =>
       w.archetype == campaign.archetype &&
       campaign.target_pairs.includes(w.pair) &&
       w.graduated == false)

     If winners_match is not empty:
       → Best winner already passed single-window triage
       → Run 4-window walk-forward immediately
       → If passes → graduate (skip cascade + autoresearch entirely)
       → If fails → demote to candidates[], continue to cascade

  2. Check candidates[]:
     candidates_match = candidates.filter(c =>
       c.archetype == campaign.archetype &&
       campaign.target_pairs.includes(c.pair))
     .sort(c => c.sharpe, descending)

     If candidates_match is not empty:
       → Use best candidate as the seed
       → Skip Tier 1/2/3 cascade
       → Proceed directly to Research Mode Selection (Part 3B)
       → The triage already proved this seed has some edge
       → Log: "Triage matrix provided seed {strategy}
         (Sharpe {n}) — skipping discovery cascade"

  3. If no winners or candidates match:
     → Run the 3-tier cascade as normal
     → Log: "No triage candidates for {archetype} on
       {pairs} — running seed cascade"

This short-circuits seed discovery for archetypes where the
triage has already found promising strategies. The cascade
becomes a fallback for gaps the triage hasn't covered yet.

```
For each campaign in "planned" state:
  Run 3-tier cascade (Part 3 above)
  If ≥1 seed found:
    Update campaign.seeding with seed details
    state: "seeded"
    Log: aphexdata_record_event(verb_id="research_seeds_found", ...)
  If no seeds at any tier:
    state: "deferred"
    Message user: "{archetype}: no viable seeds found. Manual strategy development needed."
```

### Step 7: Trigger research

```
Pre-flight — verify swarm before spending budget:
  health = swarm_health()
  if health.swarm_likely_broken:
    Message user: "Swarm appears broken ({health.consecutive_failures} recent failures).
      Skipping campaign submission until swarm recovers."
    Skip all campaign submissions this cycle (leave in "seeded" state)
    return

  If no successful swarm job in the last 24 hours:
    selftest_run_id = swarm_selftest()
    Poll selftest_run_id with swarm_poll_run (max 5 min, poll every 30s)
    if selftest failed:
      Message user: "Selftest failed — swarm pipeline not operational.
        Investigate with swarm_health(). Skipping campaign submissions."
      Log: aphexdata_record_event(verb_id="research_selftest_failed", ...)
      Skip all campaign submissions this cycle
      return

For each campaign in "seeded" OR "triaged" state, within weekly budget:

  If campaign.state == "seeded":
    For each seed, check triage-matrix.json first:
      If this strategy×pair already has a cached triage result → use it (skip redundant backtest)
      If not → run pre-gate triage (Part 3 procedure) and cache the result in triage-matrix.json
    Classify WF pattern for each seed (Part 5, Step 1c)
    Select research mode using the decision tree (Part 3B)
    campaign.state = "triaged"
    campaign.research.research_mode = selected_mode
    campaign.research.triage_results = {
      seed_name, triage_sharpe, wf_pattern, trades_per_window, mode_selected
    }
    Log: aphexdata_record_event(verb_id="research_mode_selected", ...)

  Route based on campaign.research.research_mode:
    VALIDATE_ONLY:
      → Graduate immediately (Step 3 in Part 5)
      → No autoresearch budget consumed

    HYPEROPT:
      → Execute Step 7b (hyperopt procedure)
      → campaign.state = "hyperopt"
      → Costs 1 autoresearch slot

    PARAM_PIN:
      → Build AutoresearchSpec and submit (existing flow below)
      → campaign.state = "researching"

    STRUCTURAL:
      → Spawn ClawTeam worker for structural variant creation
      → campaign.state = "researching"

    HYBRID:
      → Execute Step 7b first
      → If graduation not achieved, auto-submit param_pin autoresearch
      → campaign.state = "hyperopt" → then "researching"

    SKIP:
      → campaign.state = "abandoned"
      → Log: reason="no_viable_edge_at_triage"
      → continue to next campaign

  For PARAM_PIN mode: Build AutoresearchSpec.  Each seed_genomes[] entry MUST match the
  SeedGenomeEntry schema exactly — wrong field names cause validation
  errors that silently kill the run.

  For sdna seeds (Tier 2):
  {
    "seed_genomes": [
      {
        "genome": <genome JSON from sdna_fork or sdna_compile>,
        "execution_backend": "sdna_compile",
        "pair": "ETH/USDT:USDT",
        "timeframe": "1h",
        "parent_sharpe": 0.0
      }
    ],
    "mutations_per_genome": 7,
    "timerange": "20250101-{current_date}",
    "n_walkforward_windows": 4,
    "min_trades": <archetype>.graduation_gates.min_trades_per_window,  // per-archetype from archetypes.yaml
    "keeper_sharpe_threshold": 0.3,  // 0.3 aligns with FreqSwarm default. Planner applies graduation gate on top.
    "parent_sharpe_gate": true,
    "screen_sharpe_threshold": 0.0,  // wide initial screen — let walkforward do the real filtering
    "discard_hashes": [<from swarm_autoresearch_history(seed_name)>],
    "exchange": "binance"
  }

  For nova/derived strategies (Tier 1 or Tier 3):
  {
    "seed_genomes": [
      {
        "execution_backend": "derived_subclass",
        "strategy_ref": {
          "class_name": "BbandsRsiAdx",
          "source_file": "strategies/BbandsRsiAdx.py"
        },
        "facts": {
          "class_name": "BbandsRsiAdx",
          "source_file": "BbandsRsiAdx.py",
          "class_stoploss": -0.2,
          "class_minimal_roi": {},
          "hyperopt_params": [<from scan result .strategy_facts.hyperopt_params>],
          "has_custom_stoploss": false,
          "has_custom_exit": true,
          "uses_informative_pairs": true,
          "uses_callbacks": false,
          "scanner_warnings": []
        },
        "patch_families": ["risk_override", "param_pin"],
        "pair": "ETH/USDT:USDT",
        "timeframe": "1h",
        "parent_sharpe": 0.0
      }
    ],
    "mutations_per_genome": 7,
    "timerange": "20250101-{current_date}",
    "n_walkforward_windows": 4,
    "min_trades": <archetype>.graduation_gates.min_trades_per_window,  // per-archetype from archetypes.yaml
    "keeper_sharpe_threshold": 0.3,  // 0.3 aligns with FreqSwarm default. Planner applies graduation gate on top.
    "parent_sharpe_gate": true,
    "screen_sharpe_threshold": 0.0,  // wide initial screen — let walkforward do the real filtering
    "discard_hashes": [<from swarm_autoresearch_history(seed_name)>],
    "exchange": "binance"
  }

  FIELD NAME REFERENCE (SeedGenomeEntry schema):
  - execution_backend: "sdna_compile" | "derived_subclass"  (NOT "backend")
  - strategy_ref.source_file: path relative to strategies dir  (NOT "file_path")
  - facts: REQUIRED for derived_subclass — copy the full strategy_facts object
    from swarm_scan_strategy() result. Contains hyperopt_params that the mutation
    engine needs to generate param_pin patches. Without facts, 0 variants are
    generated (the "No variant_metadata provided" error).
  - pair: REQUIRED — e.g. "ETH/USDT:USDT"
  - timeframe: REQUIRED — e.g. "1h"
  - patch_families: list of families, e.g. ["risk_override", "param_pin"]
  - genome: full StrategyGenome JSON (required for sdna_compile)
  - strategy_ref: {class_name, source_file} (required for derived_subclass)

  run_id = swarm_trigger_autoresearch(spec_json, workers=4, priority="normal")
  Store run_id in campaign.research.run_ids[]
  Increment campaign.research.rounds_used
  state: "researching"
  Decrement weekly budget counter
  Log: aphexdata_record_event(verb_id="research_triggered", ...)
```

### Step 7b: Execute HYPEROPT mode

When a seed's research mode is HYPEROPT (selected by the decision tree in Part 3B):

```
1. Run hyperopt on the FULL timerange (not per-window):
   freqtrade_run_hyperopt(
     strategy=seed.strategy_ref.class_name,
     timerange="20250101-{current_date}",
     epochs=200,
     spaces=["buy", "sell"],
     config_path=config_path,
     pairs=[campaign.target_pairs[0]],
     loss_function="SharpeHyperOptLossDaily"
   )

2. Extract best hyperopt result parameters.

3. Re-run pre-gate triage with the optimized parameters:
   - Apply best params as a param_pin patch to the seed
   - Run N-window walk-forward backtest with these params
   - Classify WF pattern again

4. If re-triage passes graduation gates:
   → Graduate immediately (same as VALIDATE_ONLY path)
   Log: graduation_path="hyperopt_direct"

5. If re-triage improves Sharpe but doesn't pass:
   → Transition to PARAM_PIN: submit autoresearch with the hyperopt-optimized
     seed as the new baseline (mutations_per_genome=7).
   Update: campaign.research.hyperopt_baseline_sharpe = re_triage_sharpe
   state: "researching"

6. If re-triage shows no improvement over original:
   → If budget allows: try STRUCTURAL (escalate to ClawTeam)
   → If no budget: state "near_miss" or "abandoned"

Budget: HYPEROPT costs 1 autoresearch slot (same compute as param_pin batch).
Duration: ~15 minutes for 200 epochs.
Log: aphexdata_record_event(verb_id="research_hyperopt_completed", result_data={
  campaign_id, seed_name, original_sharpe, hyperopt_sharpe, improved: bool,
  next_action: "graduate" | "param_pin" | "structural" | "abandon"
})
```

### Step 8: Atomic state write

```
Write campaigns.json to .tmp file first, then rename (atomic).
Write plan-latest.json with cycle summary.
```

### Step 9: Log + message user

```
aphexdata_record_event(
  verb_id="research_daily_plan",
  verb_category="analysis",
  object_type="report",
  result_data={
    active_campaigns: N,
    new_campaigns: N,
    graduated_this_week: N,
    budget_mode: "cold_start" | "normal",
    budget_remaining: {autoresearch: N, clawteam: N},
    cold_start_archetypes: [list]
  }
)

Message user (only if there's something to report):
"## Research Planner — Daily Update
**Active campaigns:** {N} ({list of archetypes})
**New campaigns:** {N}
**Graduated this week:** {N}
**Budget:** {used}/{max} autoresearch, {used}/{max} ClawTeam ({mode} mode)
**Cold-start archetypes:** {list or 'none — all covered'}
**Top priority:** {archetype} on {pair} {tf} (score {priority})"
```


═══════════════════════════════════════════════════════════════════════
PART 5: POLL PROCEDURE (4-HOURLY)
═══════════════════════════════════════════════════════════════════════

Scheduled: `0 */4 * * *` (every 4 hours, aligned with market-timing cycle).

### Step 0: Swarm health gate

```
health = swarm_health()
if health.swarm_likely_broken:
  Log: "Swarm broken — skipping poll cycle. Running auto-retry check only."
  → Only run Step 1b (auto-retry eligibility check) — skip Steps 1-7
  return after Step 1b
```

### Step 1: Check active research

```
For each campaign in "researching" state:
  For each run_id in campaign.research.run_ids:
    result = swarm_poll_run(run_id)
    if result.status == "completed":
      full_results = swarm_job_results(run_id)
      Process keepers (Step 2)
    if result.status == "failed":
      Log: aphexdata_record_event(verb_id="research_run_failed", ...)
      Run auto-retry check (Step 1b)
```

### Step 1b: Auto-retry failed runs on swarm recovery

When a campaign's run has failed, check if the swarm has recovered and retry
automatically. This prevents campaigns from stalling indefinitely after
transient infrastructure issues.

```
For each campaign in "researching" state with ALL run_ids in "failed" status:
  1. Check retry cap:
     if campaign.research.retry_count >= 3:
       Log: "Campaign {id} exceeded max retries (3)."
       if campaign.research.best_sharpe >= (fitness_targets.min_wf_sharpe × 0.9):
         → state: "near_miss" (Step 4)
       else:
         → state: "abandoned"
       Log: aphexdata_record_event(verb_id="research_abandoned", reason="max_retries")
       continue

  2. Check swarm health:
     health = swarm_health()  (may already have from Step 0)
     if health.swarm_likely_broken:
       Log: "Swarm still broken — skipping retry for {campaign_id}"
       continue

  3. Run selftest before retrying:
     selftest_run_id = swarm_selftest()
     Poll selftest_run_id with swarm_poll_run (max 5 min, poll every 30s)
     if selftest failed:
       Log: "Selftest failed — swarm not healthy, deferring retry"
       continue

  4. Re-submit autoresearch:
     Rebuild AutoresearchSpec from campaign.seeding (same as Step 7 in Part 4)
     Include updated discard_hashes from swarm_autoresearch_history
     run_id = swarm_trigger_autoresearch(spec, workers=4, priority="normal")
     Append run_id to campaign.research.run_ids[]
     Increment campaign.research.retry_count
     Update campaign.updated_at
     Log: aphexdata_record_event(verb_id="research_retried", result_data={
       campaign_id, retry_count, previous_run_id, new_run_id, reason: "swarm_recovery"
     })
     Message user: "🔄 Campaign {campaign_id} ({archetype}): retrying after swarm
       recovery (attempt {retry_count}/3). New run: {run_id}"
```

### Step 1c: Walk-forward interpretation

Before applying graduation gates, classify the walk-forward pattern. Raw
numbers without context lead to bad decisions — a strategy with mean Sharpe
0.5 that degrades across windows is worse than one with mean 0.4 that stays
consistent.

```
For each completed variant with per-window Sharpe values [W0, W1, W2, W3]:

1. Classify the WF pattern:
   - CONSISTENT: ≥75% of windows have positive Sharpe, no single window
     dominates (max window Sharpe < 2× mean). Best pattern — indicates
     robust edge across market conditions.
   - DEGRADING: First half windows significantly better than second half
     (mean(W0,W1) > 2× mean(W2,W3)). Warns of overfitting to earlier
     data or regime shift. Penalize: effective Sharpe = mean × 0.8.
   - ALTERNATING: Positive in some regime types, negative in others.
     Analyze regime alignment:
     * Trending windows (W0: Jan-Apr, W2: Aug-Dec typically trending)
     * Choppy windows (W1: Apr-Aug, W3: Dec-Mar typically ranging)
     * TREND_MOMENTUM should be positive in trending windows
     * MEAN_REVERSION should be positive in choppy windows
     If regime alignment matches archetype → acceptable (the strategy
     works when its regime is active). If misaligned → reject.
   - SINGLE_SPIKE: One window has Sharpe > 1.0 while others are near
     zero or negative. Likely a lucky streak, not a real edge.
     Reject unless the spike window has ≥20 trades.

2. Check for regime alignment (archetype-specific):
   For MEAN_REVERSION: positive Sharpe in choppy windows (W1/W3) is
     MORE important than overall mean. A strategy that's +0.6 in choppy
     and -0.2 in trending is better than one that's +0.3 everywhere
     (the former has a real MR edge, the latter might be noise).
   For TREND_MOMENTUM: positive Sharpe in trending windows (W0/W2) is
     the key signal. Negative in choppy windows is expected and acceptable.

3. Flag anomalies:
   - 0 trades in any window → data gap or pair mismatch, investigate
   - Single-digit trades in a window → low-sample, discount that window
   - Max drawdown > 2× archetype limit in any window → reject even if
     mean looks good (tail risk)
```

### Step 2: Check for keepers (automated via MCP tools)

Use `swarm_check_graduation_gates` to apply per-archetype gates automatically.
This tool reads archetypes.yaml, calculates WF degradation, classifies
walk-forward patterns, and returns structured pass/fail/near_miss verdicts.

```
For each completed autoresearch run:
  result = swarm_check_graduation_gates(run_id=run_id, archetype=campaign.archetype)

  Track: campaign.research.best_sharpe = max keeper mean_sharpe from result
  Log: aphexdata_record_event(verb_id="research_keeper_found", ...) for each keeper

  If result.summary.passed > 0 → pick best passed keeper, run graduation (Step 3)
  If result.summary.near_miss > 0 and no passed → near_miss (Step 4)
  If all failed → budget check (retry or abandon)
```

The tool checks all 4 graduation gates per archetype from archetypes.yaml:
- WF Sharpe >= archetype.graduation_gates.min_wf_sharpe
- WF degradation < archetype.graduation_gates.max_wf_degradation_pct
- Trades per window >= archetype.graduation_gates.min_trades_per_window
- Max drawdown < archetype.graduation_gates.max_drawdown_pct

### Step 3: Graduate keeper (automated via MCP tool)

Use `swarm_graduate_keeper` to atomically write header tags and stage to roster.
This tool prepends header tags to the strategy .py file and adds/updates the
entry in roster.json with cell_status="staged" for auto-mode discovery.

```
1. Pick the best passing keeper (highest mean_sharpe) from Step 2 results
2. swarm_graduate_keeper(
     strategy_path="/workspace/group/user_data/strategies/{strategy_name}.py",
     archetype=campaign.archetype,
     pair=keeper.pair,
     timeframe=keeper.timeframe,
     wf_sharpe=keeper.mean_sharpe,
     wf_degradation_pct=keeper.degradation_pct
   )
   This atomically:
   - Writes header tags: # ARCHETYPE, # GRADUATED, # WALK_FORWARD_DEGRADATION, # VALIDATED_PAIRS
   - Creates/updates roster.json with cell_status="staged"
3. If sdna genome: sdna_attest(genome_id) + sdna_registry_add(genome_id)
4. aphexdata_record_event(
     verb_id="research_graduated",
     verb_category="execution",
     object_type="strategy",
     object_id=strategy_name,
     result_data={
       archetype, pair, timeframe, wf_sharpe, wf_degradation,
       campaign_id, seed_source, rounds_used
     }
   )
5. campaign.state = "graduated" → "staged" → "completed"
6. Message user with the graduation details from the tool response
```

### Step 4: Near-miss handling

```
If budget exhausted AND best keeper's WF Sharpe >= (threshold × 0.9):
  campaign.state = "near_miss"
  campaign.research.near_miss_strategy = best_keeper_name
  campaign.research.near_miss_sharpe = best_keeper_wf_sharpe

  aphexdata_record_event(verb_id="research_near_miss", ...)

  Message user:
  "{strategy} for {archetype}: WF Sharpe {actual} vs threshold {required}.
   One more evolution round might graduate it.
   Reply 'approve extra round {campaign_id}' or 'abandon campaign {campaign_id}'."
```

### Step 5: Detect stale campaigns

```
For each campaign in "researching" state:
  if (now - campaign.updated_at) > 48 hours:
    Message user: "Campaign {id} ({archetype}) has been researching for {hours}h
      with no progress. Check swarm_poll_run for run status."
```

### Step 6: Check near_miss campaigns

```
For campaigns in "near_miss" state:
  These wait for user action (approve extra round / abandon).
  No automatic action needed — just ensure state is consistent.
```

### Step 7: Write state

Atomic write campaigns.json.


═══════════════════════════════════════════════════════════════════════
PART 6: BUDGET MANAGEMENT
═══════════════════════════════════════════════════════════════════════

### Budget Modes

| Mode | Autoresearch/wk | ClawTeam/wk | Nova scans/wk | Active campaigns |
|------|-----------------|-------------|----------------|-----------------|
| **Cold-start** | 6 | 2 | 20 | 4 |
| **Normal** | 3 | 1 | 10 | 2 |

**Cold-start mode** is active when ANY archetype has zero graduated strategies
in the roster. The planner checks roster.json on every daily cycle. Once all 7
archetypes have ≥1 graduated strategy, it drops to normal budget automatically.

### Per-Campaign Caps

- Max 4 autoresearch rounds per campaign
- Max 4 ClawTeam rounds per campaign (Tier 3 only)
- "Approve extra round" adds +1 to the per-campaign cap (does not affect weekly)

### Budget Tracking

Budget counters are stored in `campaigns.json` under a top-level `budget` key:

```json
{
  "budget": {
    "mode": "cold_start",
    "week_start": "2026-03-24T03:00:00Z",
    "autoresearch_used": 2,
    "autoresearch_max": 6,
    "hyperopt_used": 0,
    "hyperopt_max": 4,
    "clawteam_used": 0,
    "clawteam_max": 2,
    "nova_scans_used": 15,
    "nova_scans_max": 20
  },
  "campaigns": [...]
}
```

Note: HYPEROPT consumes from `autoresearch_used` (same compute), but `hyperopt_used`
tracks how many were hyperopt specifically for diagnostics and mode effectiveness analysis.

Budget resets every Monday at 03:00 UTC (planning runs daily but budget is weekly).

If budget is exhausted mid-week, campaigns queue in `seeded` state until the
next reset. The planner does NOT overspend.


═══════════════════════════════════════════════════════════════════════
PART 7: STATE FILES
═══════════════════════════════════════════════════════════════════════

All files at `/workspace/group/research-planner/`. Directory created on first run.

### campaigns.json

```json
{
  "version": 1,
  "budget": {
    "mode": "cold_start",
    "week_start": "2026-03-24T03:00:00Z",
    "autoresearch_used": 2,
    "autoresearch_max": 6,
    "hyperopt_used": 0,
    "hyperopt_max": 4,
    "clawteam_used": 0,
    "clawteam_max": 2,
    "nova_scans_used": 15,
    "nova_scans_max": 20
  },
  "campaigns": [
    {
      "id": "camp_MEAN_REVERSION_ETH_1h_20260326",
      "archetype": "MEAN_REVERSION",
      "target_pairs": ["ETH/USDT:USDT"],
      "target_timeframes": ["1h"],
      "state": "researching",
      "priority_score": 12.6,
      "created_at": "2026-03-26T03:00:00Z",
      "updated_at": "2026-03-26T09:00:00Z",
      "detection": {
        "first_seen": "2026-03-20T23:47:00Z",
        "hit_count": 8,
        "avg_composite": 4.2,
        "max_composite": 4.8,
        "source_cells": [
          {"pair": "ETH/USDT:USDT", "timeframe": "1h", "count": 5, "avg_composite": 4.3}
        ]
      },
      "seeding": {
        "tier_used": 1,
        "seed_strategies": [
          {
            "name": "BbandsRsiAdx",
            "source": "nova_scan",
            "execution_backend": "derived_subclass",
            "strategy_ref": {"class_name": "BbandsRsiAdx", "source_file": "strategies/BbandsRsiAdx.py"},
            "facts": "<full strategy_facts from swarm_scan_strategy() — REQUIRED>",
            "patch_families": ["risk_override", "param_pin"],
            "pair": "ETH/USDT:USDT",
            "timeframe": "1h"
          }
        ]
      },
      "research": {
        "run_ids": ["ar_20260326_abc"],
        "rounds_used": 1,
        "max_rounds": 4,
        "retry_count": 0,
        "research_mode": "PARAM_PIN",
        "triage_results": {
          "seed_sharpe": 0.35,
          "wf_pattern": "ALTERNATING",
          "trades_per_window": [12, 8, 15, 10],
          "per_window_sharpe": [0.5, -0.1, 0.6, 0.05],
          "mode_decision_reason": "sharpe_above_threshold+alternating_pattern"
        },
        "hyperopt_baseline_sharpe": null,
        "keepers": [],
        "rejects_count": 7,
        "best_sharpe": 0.35,
        "near_miss_strategy": null,
        "near_miss_sharpe": null,
        "clawteam_session_ids": []
      },
      "graduation": {
        "strategy_name": null,
        "wf_sharpe": null,
        "wf_degradation_pct": null,
        "validated_pairs": [],
        "graduated_at": null
      },
      "fitness_targets": {
        // Populated from archetype.graduation_gates in archetypes.yaml at campaign creation.
        // config.json overrides apply on top if present.
        "min_wf_sharpe": 0.4,           // MEAN_REVERSION example
        "max_wf_degradation_pct": 25,   // MEAN_REVERSION example
        "min_trades_per_window": 8,     // MEAN_REVERSION example
        "max_drawdown": 0.10            // MEAN_REVERSION example
      }
    }
  ]
}
```

### nova-scan.json

```json
{
  "last_scan": "2026-03-26T03:00:00Z",
  "strategies": [
    {
      "name": "BbandsRsiAdx",
      "file_path": "/workspace/group/user_data/strategies/BbandsRsiAdx.py",
      "classified_archetype": "MEAN_REVERSION",
      "indicators": ["bollinger", "rsi", "adx"],
      "mutation_eligible": true,
      "eligible_patch_families": ["risk_override", "param_pin"],
      "scanned_at": "2026-03-26T03:05:00Z"
    }
  ]
}
```

### config.json (user overrides — optional)

```json
{
  "version": 1,
  "planning": {
    "detection_hit_threshold": 3,
    "detection_composite_threshold": 4.0,
    "detection_lookback_days": 7,
    "abandon_if_no_score_days": 14,
    "stale_campaign_alert_hours": 48
  },
  "budget": {
    "cold_start_autoresearch_max": 6,
    "cold_start_clawteam_max": 2,
    "cold_start_nova_scans_max": 20,
    "cold_start_active_campaigns": 4,
    "normal_autoresearch_max": 3,
    "normal_clawteam_max": 1,
    "normal_nova_scans_max": 10,
    "normal_active_campaigns": 2,
    "autoresearch_rounds_per_campaign": 4,
    "clawteam_rounds_per_campaign": 4
  },
  "graduation": {
    // These are FALLBACK defaults. Per-archetype values from
    // archetypes.yaml graduation_gates take priority.
    "min_wf_sharpe": 0.5,
    "max_wf_degradation_pct": 30,
    "min_trades_per_window": 20,
    "near_miss_threshold_pct": 10
  }
}
```

Defaults above are used if config.json doesn't exist or omits a key.

### plan-latest.json

Written at end of each daily planning cycle. Used by "Show research status" command.

```json
{
  "cycle_date": "2026-03-31T03:00:00Z",
  "budget_mode": "cold_start",
  "missed_opportunities_analyzed": 42,
  "new_campaigns_created": 2,
  "campaigns_abandoned": 0,
  "campaigns_graduated": 1,
  "active_campaigns": 3,
  "cold_start_archetypes": ["BREAKOUT", "RANGE_BOUND", "SCALPING", "CARRY_FUNDING"],
  "top_priority": {
    "archetype": "MEAN_REVERSION",
    "pair": "ETH/USDT:USDT",
    "timeframe": "1h",
    "priority_score": 12.6
  }
}
```


═══════════════════════════════════════════════════════════════════════
PART 8: COMMAND TABLE
═══════════════════════════════════════════════════════════════════════

| User Says | What Happens |
|-----------|-------------|
| "Show research priorities" | Query last 7 days of `missed_opportunity_daily_summary` from aphexDATA + read `missed-opportunities.json`. Rank cells by `hit_count × avg_composite`. Display table: archetype, pair, timeframe, hit count, avg composite, campaign state (if exists). Highlight archetypes with zero staged strategies in roster. |
| "Show research status" | Read `campaigns.json`. Display each active campaign: state, archetype, pairs, rounds used/max, keepers found, best Sharpe, budget remaining. Include cold-start mode indicator. |
| "Research {archetype}" | **Adhoc (non-blocking).** Create campaign immediately for the specified archetype (skip detection threshold). Aggregate all missed-opportunity cells for that archetype as targets. Run seed discovery (Tier 3 uses ClawTeam fire-and-forget). If seeds found, submit `swarm_trigger_autoresearch` and set campaign to RESEARCHING. **Do NOT poll for results inline** — reply "Research submitted for {archetype}, tracking in next poll cycle" and exit. The 4-hourly poll handles result polling, graduation, and near-miss detection. |
| "Fill strategy gaps" / "Fill the gap" | **Adhoc (non-blocking).** Run the detection + planning phase of the daily cycle: read `missed-opportunities.json`, identify all archetypes meeting threshold (freq ≥ 3 OR avg_composite ≥ 4.0 OR zero coverage in cold-start), create campaigns, discover seeds, submit autoresearch for each. **Same non-blocking protocol as "Research {archetype}"** — submit all, reply with summary table (archetype, seeds found, submitted Y/N), exit. The 4-hourly poll tracks all submitted campaigns. |
| "Run research planner" | Execute the full daily planning cycle now (same as the scheduled daily task). Includes detection, planning, polling active campaigns, and graduation. When triggered via user message, follows non-blocking adhoc protocol: submits new campaigns without polling inline. |
| "Bootstrap nova" | Run Tier 1 nova scan on all untagged .py strategies. Classify by archetype. Store in `nova-scan.json`. Report coverage map: how many strategies matched each archetype. |
| "Graduate {strategy} for {archetype}" | Manual graduation: verify walk-forward results, write header tags to strategy file, register in sdna registry, log to aphexDATA. |
| "Approve extra round {campaign_id}" | Near-miss campaign gets +1 autoresearch round. Campaign moves from `near_miss` back to `researching`. Triggers next round immediately. |
| "Abandon campaign {campaign_id}" | Mark campaign as `abandoned`. Free any budget held. Log to aphexDATA. |


═══════════════════════════════════════════════════════════════════════
PART 9: APHEXDATA EVENT CONVENTIONS
═══════════════════════════════════════════════════════════════════════

| verb_id | verb_category | object_type | When |
|---------|--------------|-------------|------|
| `research_campaign_created` | analysis | campaign | New campaign enters `planned` state |
| `research_seeds_found` | analysis | campaign | Seeds identified via cascade |
| `research_triggered` | execution | campaign | Autoresearch or ClawTeam started |
| `research_keeper_found` | analysis | strategy | Autoresearch produced a keeper |
| `research_graduated` | execution | strategy | Strategy passed graduation gate, header tags written |
| `research_near_miss` | analysis | campaign | Best keeper within 10% of threshold, awaiting user |
| `research_stalled` | analysis | campaign | Budget exhausted, no keepers at all |
| `research_abandoned` | execution | campaign | Campaign abandoned (manual or auto) |
| `research_daily_plan` | analysis | report | Daily planning cycle summary |
| `research_run_failed` | analysis | campaign | Individual autoresearch run failed |
| `research_retried` | execution | campaign | Failed run auto-retried after swarm recovery |
| `research_selftest_failed` | analysis | report | Swarm selftest failed before campaign submission |
| `nova_scan_completed` | analysis | report | Nova strategy classification batch done |
| `research_mode_selected` | analysis | campaign | Research mode chosen after triage (result_data includes triage_sharpe, wf_pattern, selected_mode) |
| `research_hyperopt_completed` | execution | campaign | Hyperopt finished, re-triage pending (result_data includes original_sharpe, hyperopt_sharpe, next_action) |
| `research_escalated` | analysis | campaign | Mode escalated (e.g., HYPEROPT → PARAM_PIN → STRUCTURAL) |

All events include `result_data` with campaign_id, archetype, and relevant
metrics. Use `aphexdata_query_events` to query historical research activity.


═══════════════════════════════════════════════════════════════════════
PART 10: SAFETY RAILS
═══════════════════════════════════════════════════════════════════════

### Compute budget

- Weekly caps enforced (cold-start: 6/2/20, normal: 3/1/10)
- Per-campaign caps enforced (4 rounds each)
- Budget tracked in campaigns.json, reset Monday 03:00 UTC
- If exhausted → campaigns queue in `seeded` state, no overspend

### Duplicate prevention

Before creating a campaign:
```
Check campaigns.json for existing campaigns with same
(archetype, target_pairs, target_timeframes) in non-terminal state.
If found → skip creation, report existing campaign.
```

Before triggering autoresearch:
```
history = swarm_autoresearch_history(seed_strategy_name)
discard_hashes = [h.variant_genome_id for h in history.mutations]
Include discard_hashes in AutoresearchSpec to skip known-bad mutations.
```

### Stale campaign detection

- Campaign in `researching` with no `updated_at` change for 48+ hours → alert user
- Campaign in `near_miss` for 7+ days with no user response → auto-abandon

### Bad strategy prevention

- Walk-forward validation is MANDATORY for graduation. No exceptions.
- All graduation criteria are per-archetype from archetypes.yaml graduation_gates:
  - TREND_MOMENTUM: 15 trades, 0.5 Sharpe, 30% degradation, 15% max DD
  - MEAN_REVERSION: 8 trades, 0.4 Sharpe, 25% degradation, 10% max DD
  - BREAKOUT: 10 trades, 0.5 Sharpe, 35% degradation, 12% max DD
  - RANGE_BOUND: 15 trades, 0.3 Sharpe, 20% degradation, 8% max DD
  - SCALPING: 50 trades, 0.3 Sharpe, 20% degradation, 5% max DD
  - CARRY_FUNDING: 5 trades, 0.3 Sharpe, 15% degradation, 6% max DD
  - VOLATILITY_HARVEST: 8 trades, 0.6 Sharpe, 40% degradation, 20% max DD

### State file safety

- All writes: write to `.tmp` file first, then `mv` for atomic rename
- `version` counter in campaigns.json incremented on each write
- If campaigns.json fails to parse → enter read-only mode, alert user


═══════════════════════════════════════════════════════════════════════
PART 11: INTEGRATION NOTES
═══════════════════════════════════════════════════════════════════════

### Auto-Mode Handoff

The research planner writes header tags to strategy .py files:
```python
# ARCHETYPE: MEAN_REVERSION
# GRADUATED: 2026-03-28
# WALK_FORWARD_DEGRADATION: 18%
# VALIDATED_PAIRS: ETH/USDT:USDT, BTC/USDT:USDT
```

Auto-mode's opportunity scan (Step 1) reads these tags during its 15-minute
check. When a cell scores above deploy_threshold and a matching graduated
strategy exists, auto-mode recommends it to the user. The research planner
does NOT modify auto-mode state files directly.

### ClawTeam Escalation

Escalate to ClawTeam when:
1. Tier 3 seed creation needed (no nova or sdna seeds for an archetype)
2. Autoresearch produces near-misses that need structural improvement
   (the mutation engine can only tweak parameters, not add new indicators)

When spawning ClawTeam workers, always include:
- Full strategy file content in the prompt (workers have no memory)
- Fitness targets from the campaign
- Pair/timeframe targets
- archetype definition from archetypes.yaml

### FreqSwarm Tool Usage

For sdna-based seeds:
```
swarm_load_seed(name) → genome JSON
→ include genome in AutoresearchSpec.seed_genomes[] with execution_backend: "sdna_compile"
→ MUST include pair, timeframe in each seed entry
```

For nova/derived seeds:
```
swarm_scan_strategy(name) → {strategy_ref, strategy_facts, mutation_eligibility}
→ include strategy_ref AND facts (= strategy_facts) in seed entry
→ execution_backend: "derived_subclass"
→ strategy_ref uses "source_file" (NOT "file_path")
→ facts is REQUIRED — without it, 0 variants are generated ("No variant_metadata" error)
→ MUST include pair, timeframe, patch_families in each seed entry
```

Always check history first:
```
swarm_autoresearch_history(name) → previously tried mutations
→ extract genome IDs into discard_hashes[]
```

### Adhoc vs Scheduled Execution

**Adhoc (user message: "Research {archetype}")** — runs in the message container.
The message slot must stay responsive. Follow this protocol:
1. Create campaign + aggregate targets (~1 min)
2. Run seed discovery — Tier 1/2 inline, Tier 3 via `team_spawn_worker` fire-and-forget (~5 min max)
3. Submit `swarm_trigger_autoresearch` (non-blocking, returns run_id)
4. Update campaign state to RESEARCHING, save run_id
5. Reply to user: "Research submitted for {archetype}. Tracking in next poll cycle."
6. **Exit.** Do NOT call `swarm_poll_run` in a loop. The 4-hourly poll handles it.

**Scheduled (daily planner / 4h poll)** — runs in the task container.
Can poll inline because the task slot is independent of user messages.
Follow the full pipeline: submit → poll → graduate → notify.

### Anti-Patterns

1. **Never deploy.** The planner researches and tags. Auto-mode deploys.
2. **Never re-score cells.** Read market-timing's cell-grid-latest.json. Do not
   call orderflow or scoring tools directly.
3. **Never overspend budget.** If weekly budget is exhausted, queue campaigns.
4. **Never skip walk-forward.** Even if in-sample metrics look amazing.
5. **Never auto-abandon near-misses.** Always ask the user first.
6. **Never create campaigns for cells below threshold.** Unless the user
   explicitly says "Research {archetype}" (manual override).
7. **Never poll swarm inline from a message container.** Adhoc research
   submits and exits. Only scheduled tasks (task container) poll inline.

## Feed Integration

After weekly planning cycle:
  agent_post_status(
    status: "Weekly plan: {new_campaigns} new campaigns, {active} active, top priority: {archetype} {pair}",
    tags: ["research", "decision"],
    context: { new_campaigns, active_campaigns, cold_start_archetypes, top_priority }
  )

After campaign state change (seeded, researching, graduated, abandoned):
  agent_post_status(
    status: "Campaign {id}: {old_state} → {new_state} — {reason}",
    tags: ["research"],
    context: { campaign_id, archetype, state, reason }
  )

After finding seeds:
  agent_post_status(
    status: "Seeds found for {archetype}: {count} candidates via {tier}",
    tags: ["research", "finding"],
    context: { archetype, seed_count, tier, seed_names }
  )

## Signal Check Before Research

Before creating a new research campaign:

1. Call signal_catalog_query(archetype={target}, pair={target_pair})
2. If quality signals exist (wf_sharpe >= 0.5, subscribers >= 3):
   - Log: "Signal available for {archetype} on {pair} — deferring research"
   - Post to feed: "Skipping research for {archetype}/{pair} — {publisher}
     already publishes quality signals. Recommend subscribing."
     tags: ["research", "discovery"]
   - Do NOT create campaign
3. If no quality signals exist:
   - Create campaign as normal
   - Log: "No marketplace signals for {archetype}/{pair} — researching"

This prevents spending compute on research when a subscription
would fill the gap instantly.

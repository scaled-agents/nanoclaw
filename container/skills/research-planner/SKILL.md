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
| freqswarm | `swarm_scan_strategy`, `swarm_trigger_autoresearch`, `swarm_poll_run`, `swarm_job_results`, `swarm_autoresearch_history`, `swarm_list_seeds`, `swarm_load_seed` |
| clawteam | `team_spawn_worker`, `team_wait_all` for Tier 3 structural creation |
| archetype-taxonomy | `archetypes.yaml` — 7 archetypes, strategy_tags, risk_profiles |
| aphexdna | `sdna_registry_search`, `sdna_fork`, `sdna_compile`, `sdna_attest`, `sdna_registry_add` |
| aphexdata | `aphexdata_record_event`, `aphexdata_query_events` |


═══════════════════════════════════════════════════════════════════════
PART 2: PIPELINE STAGES
═══════════════════════════════════════════════════════════════════════

```
DETECTED → PLANNED → SEEDED → RESEARCHING ──→ GRADUATED → STAGED → COMPLETED
                                    │    ↘              │
                                    │   NEAR_MISS       │
                                    │   (user decides)  │
                                    └─ budget exhausted → ABANDONED
                        no seeds → DEFERRED            auto-mode takes over
```

| Stage | Entry | Action | Exit |
|-------|-------|--------|------|
| `detected` | Auto-mode logs `missed_opportunity` | Aggregate: frequency × avg_composite | Threshold met (freq ≥ 3 in 7d OR avg_composite ≥ 4.0) |
| `planned` | Threshold met, campaign created | Assign archetype, targets, budget, fitness criteria from archetypes.yaml | Seeds identified (≥1 seed) |
| `seeded` | ≥1 seed strategy found | Prepare AutoresearchSpec with seeds, pairs, timeframes | Autoresearch triggered |
| `researching` | `swarm_trigger_autoresearch` submitted | Poll with `swarm_poll_run`, check for keepers | Keeper found OR budget exhausted |
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
   c. Store classification in nova-scan.json
4. For the target archetype: pick strategies with matching classification
   AND that pass the Seed Quality Gate (below) as seeds
```

**Seed Quality Gate — apply to ALL seeds before submission (Tier 1, 2, or 3):**
```
A seed is only viable if ALL of the following hold:
1. ARCHETYPE MATCH: The seed's core entry logic matches the target archetype.
   A momentum-biased seed (MACD crossover, EMA trend) will produce 0 trades
   when the market needs mean_reversion (RSI oversold, Bollinger bounce).
   Check the actual indicator logic, not just the name.
2. MUTATION SURFACE: The seed must have ≥2 eligible mutation families that
   change trading behavior (adjust_params, swap_indicator, add_filter).
   param_pin and risk_override alone are NOT sufficient — they cannot fix
   a seed that produces zero trades.
3. CONTINUOUS PARAMS: For sdna/derived seeds, entry/exit parameters must be
   continuous floats (not categorical strings) for the mutation engine to
   explore. Categorical params produce 0 variants.
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

For each campaign in "seeded" state, within weekly budget:
  Build AutoresearchSpec:
  {
    "seed_genomes": [<from campaign.seeding.seed_strategies>],
    "mutations_per_genome": 7,
    "timerange": "20250101-{current_date}",
    "n_walkforward_windows": 4,
    "keeper_sharpe_threshold": 0.0,
    "parent_sharpe_gate": true,
    "screen_sharpe_threshold": -0.5,
    "discard_hashes": [<from swarm_autoresearch_history(seed_name)>],
    "exchange": "binance"
  }

  For nova/derived strategies (non-sdna):
    Include execution_backend: "derived_subclass" in seed entries
    Include strategy_ref from swarm_scan_strategy result

  run_id = swarm_trigger_autoresearch(spec_json, workers=4, priority="normal")
  Store run_id in campaign.research.run_ids[]
  Increment campaign.research.rounds_used
  state: "researching"
  Decrement weekly budget counter
  Log: aphexdata_record_event(verb_id="research_triggered", ...)
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

### Step 2: Check for keepers

```
For each completed autoresearch run:
  keepers = full_results.keepers (where is_keeper == true)

  For each keeper, check graduation criteria:
    - WF Sharpe >= config.graduation.min_wf_sharpe (default 0.5)
    - WF degradation < config.graduation.max_wf_degradation_pct (default 30%)
    - Trades per window >= config.graduation.min_trades_per_window (default 20)
    - Max drawdown < archetype risk_profile.max_drawdown from archetypes.yaml

  If keeper passes ALL criteria → run graduation (Step 3)
  If no keeper passes but best keeper within 10% of threshold → near_miss (Step 4)

  Track: campaign.research.best_sharpe = max(keepers.mean_sharpe)
  Log: aphexdata_record_event(verb_id="research_keeper_found", ...) for each keeper
```

### Step 3: Graduate keeper

```
1. Get strategy file path from autoresearch results
2. Write header tags to first lines of .py file:
   # ARCHETYPE: {archetype}
   # GRADUATED: {YYYY-MM-DD}
   # WALK_FORWARD_DEGRADATION: {pct}%
   # VALIDATED_PAIRS: {pair1}, {pair2}
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
5. campaign.state = "graduated"
6. **Auto-stage:** Immediately add the strategy to `roster.json` as STAGED
   for the validated pair/timeframe. Do NOT wait for user to say "stage all".
   This is safe because STAGED is dormant — no bot runs until auto-mode
   promotes to shadow. Write the roster entry with:
   - strategy_name, archetype, pair, timeframe
   - graduation_date, wf_sharpe, preferred_regimes (from header tags)
   - cell_status: "staged"
7. Message user:
   "{strategy_name} graduated for {archetype}!
    WF Sharpe: {sharpe} | Degradation: {pct}% | Max DD: {dd}%
    Validated on: {pairs}
    Auto-staged to roster. Auto-mode will shadow-deploy when regime aligns."
8. campaign.state = "staged" → "completed"
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
    "clawteam_used": 0,
    "clawteam_max": 2,
    "nova_scans_used": 15,
    "nova_scans_max": 20
  },
  "campaigns": [...]
}
```

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
            "backend": "derived_subclass",
            "strategy_ref": {"class_name": "BbandsRsiAdx", "file_path": "..."}
          }
        ]
      },
      "research": {
        "run_ids": ["ar_20260326_abc"],
        "rounds_used": 1,
        "max_rounds": 4,
        "retry_count": 0,
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
        "min_wf_sharpe": 0.5,
        "max_wf_degradation_pct": 30,
        "min_trades_per_window": 20,
        "max_drawdown": 0.10
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
- Degradation > 30% = rejection even if absolute Sharpe looks good (overfit signal)
- Trade count floor (20 per WF window) prevents low-sample flukes
- Max drawdown ceiling is archetype-specific from archetypes.yaml:
  - TREND_MOMENTUM: 15%, MEAN_REVERSION: 10%, BREAKOUT: 12%
  - RANGE_BOUND: 8%, SCALPING: 5%, CARRY_FUNDING: 6%, VOLATILITY_HARVEST: 20%

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
→ include genome in AutoresearchSpec.seed_genomes[] with backend: "sdna_compile"
```

For nova/derived seeds:
```
swarm_scan_strategy(name) → StrategyFacts + strategy_ref
→ include strategy_ref in AutoresearchSpec.seed_genomes[] with backend: "derived_subclass"
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

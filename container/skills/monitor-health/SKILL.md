---
name: monitor-health
description: >
  Pipeline health monitor. Runs every 15 minutes: reads state, refreshes
  regime data, updates bot metrics, checks retirement triggers (A-J),
  evaluates graduation gates, logs and syncs. Fast-path only — deployment
  allocation (Step 6), kata handling (Step 7), and portfolio analysis
  (Steps 8-8d) run as separate scheduled tasks. See also: monitor-deploy,
  monitor-kata, monitor-portfolio.
  Trigger on: "monitor", "monitor status", "show monitor",
  "pipeline status", "auto-mode", "auto mode", "deployment status",
  "auto check", "portfolio health", "deployment lifecycle", "paper bot status",
  "what should be running", "show bots", "show deployments", "health check".
---
# Monitor — Pipeline Lifecycle Orchestrator

Manages paper trading bot deployments. Reads market-timing scores,
monitors bot health, gates signals by regime, and graduates winners.

## Split Monitor Architecture

This skill handles the fast-path health loop (Steps 0-5, 9). Three
companion skills handle slower or less frequent work:

| Skill | Steps | Schedule | Purpose |
|-------|-------|----------|---------|
| `monitor-health` (this) | 0-5, 9 | `*/15 * * * *` | Bot health, signals, retirement, graduation |
| `monitor-deploy` | 6 | `7,37 * * * *` | Slot allocation, backtest verification |
| `monitor-kata` | 7 | `20 * * * *` | Kata race completion, walk-forward |
| `monitor-portfolio` | 8-8d | `0 0 * * *` | Portfolio correlation, tail risk, daily rollup |

All four skills share the same workspace files. GroupQueue serialization
ensures no concurrent access. Only this skill increments `tick_id`.

**Auto-Mode NEVER modifies strategy code.** If a strategy underperforms,
Auto-Mode retires it. The boundary is sacred: Auto-Mode operates
strategies, Research improves them.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `market-timing` | Cell grid scores (reads `cell-grid-latest.json`) |
| `exchange-config` | Exchange + pair list config (reads `instance-config.json`) |
| `orderflow` | Hourly regime refresh for active pairs |
| `archetype-taxonomy` | Archetype definitions, thresholds, constraints |
| `freqtrade-mcp` | Bot status, profit, balance (health monitoring) |
| `aphexdata` | Audit trail for all lifecycle events |
| `tv-signals` | TV source P&L tracking (reads `tv-signals.json`, optional) |

**Optional config:** `scoring-config.json` — if present, overrides thresholds in
Steps 2 (signal hysteresis, deploy threshold), 4 (retirement DD multiplier, consecutive
losses), and 5 (graduation Sharpe, max DD). Keys: `SIGNAL_HYSTERESIS_TICKS`,
`DEPLOY_THRESHOLD`, `RETIREMENT_GATES`, `GRADUATION_GATES`.
See `setup/scoring-config-defaults.json` for all keys and defaults.

---

## Console Sync — Mandatory

After writing any state file that the console dashboard displays,
call `sync_state_to_supabase` to push the update. The console reads
from Supabase, not from local files. Files to sync:

| File | state_key |
|------|-----------|
| `campaigns.json` | `campaigns` |
| `deployments.json` | `deployments` |
| `roster.json` | `roster` |
| `missed-opportunities.json` | `missed_opps` |
| `triage-matrix.json` | `triage_matrix` |
| `cell-grid-latest.json` | `cell_grid` |
| `portfolio-correlation.json` | `portfolio_correlation` |
| `tv-signals.json` | `tv_signals` |
| `regime-intel.json` | `regime_intel` |

---

## Pre-Staged Deployment Roster

**Core principle:** Don't assemble deployments at opportunity time. Pre-stage them
so deployment is just flipping a switch. When ETH flips to EFFICIENT_TREND at 3am,
there's no file copying or config editing — the config already exists.

### How Staging Works

Every graduated strategy gets a complete, ready-to-launch FreqTrade config
generated at graduation time, not at deployment time. Run staging after any
strategy graduates or when user says "Stage all graduated strategies".

**Staging procedure:**

```
For each .py file in /workspace/group/user_data/strategies/:
  Read header tags (first 12 lines):
    # ARCHETYPE: <type>
    # GRADUATED: true|false|<date>
    # VALIDATED_PAIRS: <pair1>, <pair2>, ...
    # WALK_FORWARD_DEGRADATION: <pct>
    # WF_SHARPE: <sharpe_value>

  If GRADUATED is truthy (true, or a date string):
    1. Verify strategy file is accessible to FreqTrade
       (copy to strategies dir if in triage/ subfolder)

    2. For each pair in VALIDATED_PAIRS:
       Create a roster entry in /workspace/group/auto-mode/roster.json

    3. Pre-generate a COMPLETE FreqTrade config fragment:
       Save to: /workspace/group/auto-mode/configs/{strategy}_{pair}_{tf}.json
       All values filled in. No manual editing needed at deploy time.
```

### Roster Entry Format

```json
{
  "strategy_name": "AroonMacd_ADX",
  "strategy_path": "/workspace/group/user_data/strategies/AroonMacd_ADX.py",
  "archetype": "TREND_MOMENTUM",
  "validated_pairs": ["ETH/USDT:USDT", "BTC/USDT:USDT"],
  "timeframe": "1h",
  "base_stake_pct": 5,
  "wf_degradation_pct": 18,
  "wf_sharpe": 0.87,
  "cells": [
    {
      "pair": "ETH/USDT:USDT",
      "timeframe": "1h",
      "config_path": "/workspace/group/auto-mode/configs/AroonMacd_ADX_ETH_1h.json",
      "status": "staged",
      "last_activated": null,
      "activation_count": 0
    }
  ]
}
```

Cell status values: `staged` (ready but dormant), `paper_trading` (paper bot running),
`graduated` (proven, bot still running), `retired` (bot stopped).

### Instant Activation

When auto-mode fills a slot from triage winners or deploys a graduated strategy:

```
activate_deployment(roster_entry, cell):
  1. Read pre-generated config from configs/ directory
  2. bot_start(deployment_id, strategy_name, pair, timeframe)
     → Bot starts in dry-run mode with signals OFF (initial_state=stopped)
  3. Update roster.json: cell status → "paper_trading"
  4. Create campaign entry in campaigns.json
  5. aphexdata_record_event(verb_id="deployment_activated", ...)
  6. Next health check will toggle signals ON/OFF based on composite score
```

**Total time from decision to paper-trading bot: < 30 seconds.**
No file copying, no config editing. Bot-runner handles config generation and Docker container.

### Instant Deactivation

```
deactivate_deployment(roster_entry, cell):
  1. bot_toggle_signals(deployment_id, false) — disable signals (bot stays alive)
     OR bot_stop(deployment_id, confirm=true) — remove container (for retirement)
  2. Update roster.json: cell status → "staged" (back to dormant)
  3. Update campaigns.json lifecycle state
  4. aphexdata_record_event(verb_id=<transition_verb>, ...)
```

---

## Deployment States

Paper bots have 3 states. Derived from campaigns.json, managed
by auto-mode, displayed by the console.

```
WARM-UP → PROVEN → PUBLISHED
   └──→ RETIRED
```

| State | Description | Signals |
|-------|-------------|---------|
| **WARM-UP** | Paper trading, proving itself. Clock ticking toward validation deadline. Regime gating: signals fire when composite >= 3.5, pause when composite < 3.5 for 2 consecutive ticks. | Toggled by regime (internal only) |
| **PROVEN** | Passed validation. `campaign.state = "graduated"`. Signals fire to YOUR execution endpoints (webhooks). Stays deployed, contributes to portfolio. | Fire to your webhooks |
| **PUBLISHED** | Proven + live Sharpe >= 0.8. `campaign.state = "graduated"`. Signals available to OTHER operators via marketplace. | Fire to marketplace + your webhooks |
| **RETIRED** | Failed validation or early retirement trigger. `campaign.state = "retired"`. Container stopped, slot freed. | N/A |

**There is no ACTIVE state** (no live capital).
**There is no THROTTLED state** (no position sizes to throttle).
**There is no PAUSED state** (signal on/off is a condition within warm-up, not a separate state).
**There is no approval gate** (no live capital transitions to approve).

Auto-mode writes `campaign.state`. The dashboard reads it.
One writer, one reader.

### Bot Runner Integration

Paper bots use the **bot-runner MCP tools** to manage FreqTrade containers:
- `bot_start(deployment_id, strategy, pair, timeframe)` — start a dry-run FreqTrade container
- `bot_stop(deployment_id, confirm=true)` — stop and remove container
- `bot_toggle_signals(deployment_id, enable)` — enable/disable trading signals
- `bot_status(deployment_id)` — check container status, signals, paper P&L
- `bot_list()` — list all managed bots
- `bot_profit(deployment_id)` — read paper trading P&L

---

## Security Hardening

### 1. Main-Group Gate

Auto-mode commands MUST only run in the main group.
Before executing any command, check:

```bash
[ "$NANOCLAW_IS_MAIN" = "1" ] || echo "DENIED: auto-mode operations require main group"
```

**Commands** (require main group):
- `retire` (stops bot permanently)
- `deploy paper bot` (creates deployment entry)
- `set threshold` (modifies config)
- `emergency stop`

**Read-only commands** (allowed from any group):
- `show auto-mode status`
- `show portfolio health`

### 2. Emergency Stop

The `EMERGENCY STOP` command immediately:
1. Calls `bot_stop(confirm=true)` for ALL running paper bots
2. Sets `portfolio.circuit_breaker_active = true`
3. Pauses ALL monitor tasks:
   pause_task(name="monitor_health_check")
   pause_task(name="monitor_deploy")
   pause_task(name="monitor_kata")
   pause_task(name="monitor_portfolio")
4. Updates all campaigns to `state: "retired"`
5. Writes state atomically
6. Logs `aphexdata_record_event(verb_id="emergency_stop", verb_category="risk", object_type="portfolio")`
7. Messages user: "EMERGENCY STOP executed. All bots stopped. Scheduler paused. Manual 'enable auto-mode' required to resume."

### 3. Dry-Run Mode

When `config.json` contains `"dry_run": true`:
- ALL transitions are computed and logged normally
- ALL state file updates happen normally (so hysteresis tracking works)
- NO freqtrade actions are executed
- Messages include `[DRY RUN]` prefix
- aphexDATA events include `"dry_run": true` in result_data

### 4. State File Integrity

Each state file includes a `_checksum` field — a SHA-256 hash of the file content
(excluding the `_checksum` field itself). On read, verify the checksum matches.

**On write:** Compute checksum of the JSON content without `_checksum`,
then add `_checksum` field before writing.

**On read:** Verify checksum. If mismatch:
- Log `aphexdata_record_event(verb_id="integrity_violation", verb_category="security", object_type="state_file")`
- Message user: "State file integrity check failed for {filename}. Entering safe mode — all transitions blocked."
- Skip all transitions for this tick (read-only mode)

---

## Unified Loop Mapping

The 9-step tick cycle implements the **sense-score-act-measure-learn** loop:

| Loop Phase | Steps | What Happens |
|------------|-------|-------------|
| **SENSE** | 1 (Read State), 2 (Refresh Regimes) | Read all state: campaigns, regimes, cell grid, portfolio |
| **SCORE** | 2 (Signal Gating) | Score each bot's cell composite, apply hysteresis thresholds |
| **ACT** | 4 (Early Retirement), 5 (Graduation), 6 (Fill Slots), 7 (Kata Worker) | Retire, graduate, deploy, or advance kata based on scores |
| **MEASURE** | 3 (Update Metrics), 8 (Portfolio Correlation) | Read live P&L, compute portfolio-level metrics |
| **LEARN** | 8b (Regime Transitions), 9 (Log + Sync) | Record outcomes, compute transition probabilities, feed back to future cycles |

This is the same loop that drives strategy improvement (kata) and gate improvement
(gate kata). Monitor applies it to the live portfolio; kata applies it to simulation.

---

## 15-Minute Health Check (9 Steps)

This is the core algorithm. Execute these steps in order on every scheduled tick.

### Crash-Safety Invariant

State is written BEFORE freqtrade actions execute.
If the agent crashes between writing state and executing a bot action, the next
check's reconciliation step detects the mismatch and retries. All transitions
are idempotent — stopping an already-stopped bot is a no-op.
### Step 0: TICK INIT (observability)

Before any other work, stamp the tick as started and set up failure capture.

```
# Read current deployments.json._meta (or create _meta if missing)
deployments = read auto-mode/deployments.json
tick_id = (deployments._meta.tick_count or 0) + 1
deployments._meta.tick_started_at = now ISO
deployments._meta.tick_id = tick_id
write auto-mode/deployments.json

# Append tick-start to step log
append to auto-mode/tick-log.jsonl:
  {"ts": now, "tick_id": tick_id, "step": 0, "phase": "enter", "note": "tick_started"}
```

**Failure capture:** If ANY step below throws an exception or the container
crashes, the `tick_started_at` field will be set but `last_tick` will NOT
advance. This makes failed ticks visible — `tick_started_at > last_tick`
means the last tick attempt failed.

When catching an exception at any step:
```
deployments._meta.last_tick_failure = {
  "ts": now,
  "tick_id": tick_id,
  "exception_type": type(e).__name__,
  "exception_message": str(e)[:500],
  "step_reached": <last step number that was entered>
}
write auto-mode/deployments.json
append to auto-mode/tick-log.jsonl:
  {"ts": now, "tick_id": tick_id, "step": <step>, "phase": "error",
   "error": str(e)[:200]}
# Re-raise / exit non-zero so the container reports failure
```

**Step-level logging:** At the ENTRY and EXIT of each step (Steps 1-9),
append one line to `auto-mode/tick-log.jsonl`:

```
# On step entry:
append: {"ts": now, "tick_id": tick_id, "step": N, "phase": "enter"}

# On step exit:
append: {"ts": now, "tick_id": tick_id, "step": N, "phase": "exit",
         "duration_sec": elapsed, "outcome": "<1-line summary>"}
```

Outcome examples: `"read_2_campaigns"`, `"regime_refreshed_20_pairs"`,
`"retired_1_bot"`, `"deployed_0_evaluated_3"`, `"no_candidates"`,
`"slots_2_of_10"`, `"correlation_0.18"`.

This file is append-only JSONL. No schema validation. Cap at 30 days
of entries — older entries can be rotated but that's secondary.

### Step 1: READ STATE

Read campaigns.json, market-prior.json, portfolio-correlation.json, config.json,
cell-grid-latest.json, and tv-signals.json.

```bash
cat /workspace/group/research-planner/campaigns.json 2>/dev/null || echo '{"campaigns":[]}'
cat /workspace/group/auto-mode/market-prior.json 2>/dev/null || echo '{"regimes":{},"last_refresh":null,"tick_count":0}'
cat /workspace/group/auto-mode/portfolio-correlation.json 2>/dev/null || echo '{}'
cat /workspace/group/auto-mode/config.json 2>/dev/null || echo '{}'
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo '[]'
cat /workspace/group/auto-mode/tv-signals.json 2>/dev/null || echo '[]'
```

Build a list of all warm-up bots (`campaign.state == "paper_trading"`)
and all proven bots (`campaign.state == "graduated"`).

**Reconcile:** For each campaign with a `paper_trading.bot_deployment_id`,
verify the container is actually running via `bot_status(deployment_id)`.

```
cfg = config.RETIREMENT_GATES
for campaign in campaigns where state in {"paper_trading", "graduated"}:
  status = bot_status(campaign.paper_trading.bot_deployment_id)
  if status is running:
    campaign.consecutive_container_down = 0       # reset on healthy check
  else:
    campaign.consecutive_container_down = (campaign.consecutive_container_down or 0) + 1
    Log: "Container down for {strategy} — check {campaign.consecutive_container_down}"
    if campaign.consecutive_container_down == 1:
      # First detection — attempt restart (might be transient)
      bot_start(campaign.paper_trading.bot_deployment_id,
                campaign.strategy, campaign.pair, campaign.timeframe)
      Log: "Restart attempted for {strategy}"
    # Trigger B in Step 4 handles retirement at consecutive_container_down
    # >= cfg.dead_container_consecutive_checks (default 2)
```

**Pending-start reconciliation:**

For each deployment in deployments.json where `bot_runner_status == "pending_start"`:
  Check actual container via `bot_status(dep.id)`.
  If bot_status returns `status: "running"`:
    - The container started successfully but the original `bot_start` poll timed out.
    - Update: `dep.bot_runner_status = "running"`, `dep.api_port = status.api_port`
    - Clear `dep.bot_runner_note`
    - Log: "Reconciled pending_start → running: {strategy} on port {api_port}"
  If bot_status returns error/not found:
    - Container never started. Leave as `pending_start` for retry.
    - On next tick, attempt `bot_start(dep.id, dep.strategy, dep.pairs[0], dep.timeframe)`.
    - If second attempt also fails, retire with reason `container_start_failed`.

**Orphan detection:**

For each running bot (from `bot_list()`):
  Match to campaign via `campaign.paper_trading.bot_deployment_id == bot.deployment_id`

  If no matching campaign found AND no `orphan_detected_at` set:
    Set `orphan_detected_at = now` in deployments.json
    Post to feed: "Orphan detected: {strategy} on {pair}/{tf} — no campaign. 48h to adopt."
    Message user: "{strategy} is an orphan bot (no Kata validation).
      'Adopt {strategy}' to keep, 'Retire {strategy}' to stop.
      Auto-retires in 48 hours if no action taken."
    `aphexdata_record_event(verb_id="orphan_detected", verb_category="monitoring", object_type="deployment", ...)`

  If `orphan_detected_at` set AND elapsed > 48 hours:
    Auto-retire: `bot_stop(deployment_id, confirm=true)`
    # Update authoritative slot state
    dep = find in deployments.deployments where bot_deployment_id == deployment_id
    if dep:
      dep.state = "retired"
      dep.retired_reason = "orphan_auto_retired"
      write auto-mode/deployments.json
      sync_state_to_supabase(state_key="deployments", ...)
    Post: "Orphan auto-retired: {strategy}. No campaign after 48h."
    `aphexdata_record_event(verb_id="orphan_auto_retired", verb_category="execution", object_type="deployment", ...)`

**State file reconciliation (campaigns ↔ deployments ↔ roster):**

After reading all state files, check for contradictions between
campaigns.json and deployments.json. Any mismatch is healed in-place
and logged. This catches propagation omissions — if a writer updates
campaigns.json but forgets deployments.json, this pass fixes it within
one tick (15 minutes). The pass is idempotent and non-blocking.

```
deployments_changed = false
roster_changed = false

# 1. Reconcile campaigns → deployments (slot_state, state, graduated)
for campaign in campaigns where state not in {"pending_deploy"}:
  dep = find in deployments.deployments
        where id == campaign.paper_trading.bot_deployment_id
  if not dep: continue

  # slot_state sync (Bug 5 class — graduation propagation)
  if campaign.slot_state and dep.slot_state != campaign.slot_state:
    Log: "RECONCILE: {campaign.strategy} slot_state
          dep={dep.slot_state} → campaign={campaign.slot_state}"
    dep.slot_state = campaign.slot_state
    if campaign.slot_state == "graduated" and campaign.graduated_at:
      dep.graduated = campaign.graduated_at
    deployments_changed = true

  # state sync (Bug 3 class — retirement propagation)
  if campaign.state == "retired" and dep.state != "retired":
    Log: "RECONCILE: {campaign.strategy} state
          dep={dep.state} → retired"
    dep.state = "retired"
    dep.retired_reason = campaign.paper_trading.retire_reason or "reconciled"
    deployments_changed = true

  # state sync (graduation propagation)
  if campaign.state in {"graduated_internal_only", "graduated_external"}
     and dep.state not in {"retired", campaign.state}:
    Log: "RECONCILE: {campaign.strategy} state
          dep={dep.state} → {campaign.state}"
    dep.state = campaign.state
    deployments_changed = true

if deployments_changed:
  write auto-mode/deployments.json
  sync_state_to_supabase(state_key="deployments", ...)
  Log: "Reconciliation healed deployments.json"

# 2. Reconcile roster → deployments (retired cell coverage)
roster = read auto-mode/roster.json (gracefully skip if missing)
if roster:
  for r in roster.roster:
    for cell in (r.cells or []):
      if cell.status == "paper_trading":
        # Find matching deployment — if retired, roster is stale
        dep = find in deployments.deployments
              where strategy == r.strategy_name
              and pairs contains cell.pair
              and state == "retired"
        if dep:
          cell.status = "retired"
          roster_changed = true
          Log: "RECONCILE: roster {r.strategy_name} {cell.pair} → retired"

  if roster_changed:
    write auto-mode/roster.json
    sync_state_to_supabase(state_key="roster", ...)
    Log: "Reconciliation healed roster.json"
```

### Step 2: REFRESH REGIMES

Read market-timing scores for each cell.
(Uses the existing market-timing composite from the 4-hour market-timing task —
auto-mode just reads it.)

Increment tick counter: `market_prior.tick_count += 1`

If `tick_count % 4 == 0` (hourly):
```
orderflow_fetch_regime(symbols=[<all_pairs>], horizon="H2_SHORT")
orderflow_fetch_regime(symbols=[<all_pairs>], horizon="H3_MEDIUM")
```
Update `market-prior.json` with fresh regime data.

**Probabilistic regime posteriors (shadow mode):**
After writing v1 regime data, compute HMM posteriors if models are trained.
Non-blocking — if `regime_refresh_market_prior` fails or the tool is
unavailable, the v1 flow continues unaffected.
```
# Shadow mode: compute posteriors and add to market-prior.json v2
# Skip gracefully if freqtrade-mcp lacks the regime tool or models aren't trained
try:
  regime_refresh_market_prior(
    symbols=[<all_pairs_base>],
    timeframe="1h",
    config=<config_path>,
    market_prior_path=<market_prior_path>
  )
  # Also refresh 4h horizon for medium-term cells
  regime_refresh_market_prior(
    symbols=[<all_pairs_base>],
    timeframe="4h",
    config=<config_path>,
    market_prior_path=<market_prior_path>
  )
catch:
  # Tool unavailable or models not trained yet — no action needed.
  # market-prior.json retains v1 fields only.
  pass
```
The posterior blocks (`regimes[symbol][horizon].posterior`) are additive —
downstream readers that don't check for `posterior` see no change. When
`scoring-config.REGIME_MODEL.shadow_mode` flips to `false` (Phase C),
market-timing will use posteriors for probabilistic regime_fit instead of
the lookup table.

**Regime intel snapshot (every regime refresh):**
After computing posteriors, build `regime-intel.json` from the shadow log
and current regime state. This powers the Research > Regime Intel dashboard
page that tracks shadow mode validation progress.

```
Read knowledge/regime-shadow-log.jsonl
Parse all entries, compute per-pair 7-day rolling agreement rates
Compute promotion readiness criteria:
  - agreement_above_threshold: 7d avg agreement > 0.70
  - hmm_converging_all_pairs: no pair with hmm_status == "convergence_failed"
  - no_sustained_disagreement: no pair below 50% agreement for 3+ consecutive days
  - min_shadow_entries: total entries >= 100
  - bocpd_validation: at least 1 observed transition where BOCPD detected
    the change before deterministic (changepoint_max > bocpd_threshold
    followed by regime label change within 4 ticks)

Write regime-intel.json:
  shadow_mode, shadow_days, shadow_entries, overall_agreement_7d,
  promotion_ready (all 5 criteria met), promotion_criteria (per-criterion status),
  pairs (per-pair: det_regime, hmm_regime, agreement_7d, changepoint_current,
         hmm_status, agreement_trend[7]),
  disagreements_recent (last 10 where det != hmm),
  regime_distribution (det vs hmm % per regime, 7d),
  last_updated

sync_state_to_supabase(state_key="regime_intel", file="regime-intel.json")
```

**For each warm-up or proven bot:**
```
cell_composite = composite score for this strategy's archetype + pair
                 from cell-grid-latest.json

If campaign.paper_trading.investigation_mode == true:
  Skip signal toggling for this bot entirely.
  Signals remain paused until kata resolves the investigation.
  Still increment ticks_signals_off (for Step 5 regime tracking).
  Continue to next bot.

Compute ticks_required for this bot (see adaptive hysteresis above):
  ticks_required = adaptive value (1–4) or SIGNAL_HYSTERESIS_TICKS (default 2)

TURNING SIGNALS ON (requires ticks_required consecutive ticks above):
  If signals_active == false:
    If cell_composite >= 3.5:
      consecutive_above += 1
      If consecutive_above >= ticks_required:
        signals_active = true
        consecutive_above = 0
        Post: "{strategy}: signals ON — regime favorable
          for {ticks_required} consecutive checks"
    Else:
      consecutive_above = 0  (reset counter)

TURNING SIGNALS OFF (requires ticks_required consecutive ticks below):
  If signals_active == true:
    If cell_composite < 3.5:
      consecutive_below += 1
      If consecutive_below >= ticks_required:
        signals_active = false
        consecutive_below = 0
        Post: "{strategy}: signals OFF — regime unfavorable
          for {ticks_required} consecutive checks"
    Else:
      consecutive_below = 0  (reset counter)

Store counters in campaign.paper_trading:
  consecutive_above: 0
  consecutive_below: 0
```

**TRADE.md `disable_when` gate (checked every tick, after regime hysteresis):**
```
TRADE_MD="/workspace/group/strategies/${strategy_name}.trade.md"
If TRADE_MD exists AND has disable_when block:
  Parse disable_when rules. For each rule:
    - max_drawdown_exceeds: {threshold}
        Compare with bot's rolling max drawdown over lookback_days.
        If current_max_dd > threshold → force signals OFF.
    - regime_shifts_to: [{regime_list}]
        Compare with current cell regime from cell-grid-latest.json.
        If current_regime in regime_list → force signals OFF.
  If ANY rule triggers:
    signals_active = false
    Log: "TRADE.md disable_when triggered: {rule_type} = {value}"
    Post: "{strategy}: signals OFF — TRADE.md disable_when: {rule_type}"
  disable_when is additive — it can only turn signals OFF, never ON.
  The regime hysteresis gate must ALSO be favorable for signals to be ON.
```

**Hysteresis (symmetric, both directions):** Require N consecutive
ticks in EITHER direction before toggling signals.

**Adaptive hysteresis (when `REGIME_MODEL.shadow_mode == false` + transition data available):**

Read the `transition` block from `market-prior.json` for this bot's
pair×horizon. The `change_prob` and `expected_run_length` fields from
BOCPD control how many ticks are required:

```
base_ticks = SIGNAL_HYSTERESIS_TICKS   # default: 2

# Read transition data from market-prior.json v2
transition = market_prior.regimes[pair_base][horizon].transition
change_prob = transition.change_prob          # 0.0–1.0
erl = transition.expected_run_length          # bars since last changepoint

# High transition probability → require more confirmation
if change_prob > 0.5:
  ticks_required = 4
elif change_prob > 0.3:
  ticks_required = 3
else:
  ticks_required = base_ticks                 # 2

# Very stable regime (long run length) → allow faster toggle
if erl > 100:
  ticks_required = max(1, ticks_required - 1)
```

When `shadow_mode == true` or transition data is unavailable, use the
fixed `SIGNAL_HYSTERESIS_TICKS` (default 2) — existing behavior unchanged.

This prevents:
  Tick 1: composite 3.6 → counter=1, still OFF
  Tick 2: composite 3.4 → counter reset
  Tick 3: composite 3.7 → counter=1, still OFF
  Tick 4: composite 3.8 → counter=2, NOW ON (stable regime confirmed)
Entries only fire after regime confirmed favorable for 30+ minutes
(2 × 15-minute ticks at base). During high transition probability periods,
the system requires up to 60 minutes (4 ticks) of confirmation to prevent
toggling during transient regime shifts.

**Regime-blocked tracking (for each warm-up bot):**
```
If signals_active == true this tick:
  campaign.paper_trading.ticks_signals_on += 1
Else:
  campaign.paper_trading.ticks_signals_off += 1
```
These counters let Step 5 (Graduation Check) determine whether a
zero-trade bot was regime-blocked or genuinely had opportunities.

**For proven/published bots:**
Same regime gating logic. Regime gating applies to all bots regardless
of graduation status — a proven bot in an unfavorable regime pauses
signals until conditions improve. (No tick tracking needed for proven bots.)

### Step 3: UPDATE METRICS

For each warm-up bot:
```
Call bot_profit(deployment_id) — returns paper_pnl with:
  profit_pct, trade_count, win_rate, sharpe, last_updated
(sharpe is annualized live Sharpe computed by the host on every health
 check from per-trade returns. It is 0 until the bot has >= 2 closed trades.)

For per-trade statistics, call bot_trades(deployment_id) and compute:
  avg_win_pct = average profit of winning trades
  avg_loss_pct = average loss of losing trades (as positive number)
  max_consecutive_losses = longest streak of consecutive losing trades
  max_drawdown = peak-to-trough drawdown across the trade equity curve

Update campaign.paper_trading:
  current_pnl_pct = paper_pnl.profit_pct
  current_trade_count = paper_pnl.trade_count
  current_sharpe = paper_pnl.sharpe
  current_max_dd = max_drawdown
  current_win_rate = paper_pnl.win_rate
  current_avg_win_pct = avg_win_pct
  current_avg_loss_pct = avg_loss_pct
  max_consecutive_losses = max_consecutive_losses
  last_checked = now

Compute live-vs-backtest divergence (only once we have enough trades):
  If current_trade_count >= 10 AND campaign.wfo_sharpe AND campaign.wfo_sharpe > 0:
    divergence_pct = 1 - (current_sharpe / campaign.wfo_sharpe)
    # Clamp to [0, 1] — a live Sharpe above backtest means no decay.
    divergence_pct = max(0, min(1, divergence_pct))
    campaign.paper_trading.divergence_pct = divergence_pct
    campaign.paper_trading.wfo_sharpe_baseline = campaign.wfo_sharpe
  Else:
    campaign.paper_trading.divergence_pct = null
```

**Divergence is a silent killer.** A strategy with backtest Sharpe 1.5 running
at live Sharpe 0.3 has decayed 80% but won't hit the graduation floor (0.5)
until it's too late. `divergence_pct` surfaces this before the cliff and is
consumed by Trigger F in Step 4. Floor of 10 trades prevents noisy early reads.

**Read execution metrics from paper_pnl.execution (Finding 12):**

```
If campaign.paper_pnl.execution exists:
  campaign.paper_trading.execution_quality =
    campaign.paper_pnl.execution.execution_quality
  campaign.paper_trading.slippage_as_pct_of_pnl =
    campaign.paper_pnl.execution.slippage_as_pct_of_pnl
Else:
  # Legacy data, no enrichment yet, or deployment lacks volume_weight.
  # Leave fields unset — Triggers J / Step 5 record gate as met:null.
  pass
```

These two top-level fields on `paper_trading` are what Trigger J and the
Step 5 graduation gate read. Storing them at the campaign level (rather
than re-reading `paper_pnl.execution` each time) keeps gate evaluation a
single field lookup, the same pattern Findings 1 and 16 use.

For proven/published bots:
Same metric update. Track ongoing performance after graduation.

`sync_state_to_supabase(state_key="campaigns", ...)`

**Inactive bot detection (warm-up bots only):**

After metrics are updated, check activity levels:

```
For each warm-up bot:
  hours_since_deploy = (now - campaign.paper_trading.deployed_at).total_hours()

  If hours_since_deploy > 48 AND current_trade_count == 0:
    If campaign.paper_trading.feasibility_warning == false:
      campaign.paper_trading.feasibility_warning = true
      Post to feed: "INACTIVE WARNING: {strategy} on {pair}/{tf}
        — 0 trades after 48h. Signals OFF {ticks_signals_off}/{total_ticks} ticks."
      Message user: "{strategy} has 0 trades after 48 hours.
        Regime-blocked {pct}% of time. Step 5 will decide at deadline."

  If hours_since_deploy > 72 AND current_trade_count <= 1:
    If campaign.paper_trading.feasibility_warning == false:
      campaign.paper_trading.feasibility_warning = true
      Post to feed: "NEAR-INACTIVE: {strategy} on {pair}/{tf}
        — {n} trade(s) after 72h. Very low signal frequency."
      Message user with same detail.
```

Note: This is informational only. It does NOT retire or pause bots.
Step 5 handles the zero-trade decision at the validation deadline
via regime-extension logic. The warning alerts the user early and
sets `feasibility_warning = true` so it only fires once per bot.

**Trade attribution (backward diagnostics):**

After metrics are updated, run the attribution loop to close the backward
diagnostic feedback. This writes enriched trade data to the knowledge store
for consumption by gate-audit (Level 2 Discover) and portfolio-audit
(Level 3 Discover). See `skills/attribution/SKILL.md` for full schema.

```
For each bot with slot_state in {"trial", "graduated"}:
  trades = bot_trades(deployment_id)
  last_ts = campaign.paper_trading.last_attribution_ts ?? campaign.deployed_at

  new_closed = [t for t in trades
                if t.close_date > last_ts and t.is_open == false]

  If len(new_closed) == 0: skip

  For each trade in new_closed:
    regime_at_entry = trade.custom_data.regime_at_entry ?? "UNKNOWN"
    regime_at_exit = trade.custom_data.regime_at_exit ?? "UNKNOWN"

    # Gate state snapshot at entry
    cell = lookup cell-grid for (campaign.archetype, campaign.pair, campaign.timeframe)
    gate_state = {
      composite: cell.composite ?? null,
      signals_active: true,  # was active since trade opened
      regime_fit: cell.regime_fit ?? null,
      change_prob: market_prior[pair_base][horizon].transition.change_prob ?? null
    }

    entry = {
      ts: now_utc, trade_id: trade.trade_id,
      strategy: campaign.strategy, archetype: campaign.archetype,
      correlation_group: campaign.correlation_group,
      pair: campaign.pair, timeframe: campaign.timeframe,
      direction: trade.direction,
      regime_at_entry, regime_at_exit,
      regime_changed_during_trade: regime_at_entry != regime_at_exit,
      exit_reason: trade.exit_reason,
      pnl_pct: trade.profit_pct,
      duration_minutes: trade.duration_minutes,
      slippage_pct: trade.custom_data.slippage_pct ?? null,
      slippage_source: trade.custom_data.slippage_source ?? null,
      execution_quality: campaign.paper_trading.execution_quality ?? null,
      gate_state_at_entry: gate_state,
      campaign_id: campaign.id,
      slot_state: campaign.slot_state,
      days_since_deploy: (now - campaign.deployed_at).days
    }

    Append JSON line to knowledge/live-attribution.jsonl

  campaign.paper_trading.last_attribution_ts = max(new_closed.close_date)
```

Non-blocking: if `bot_trades` fails or attribution write fails, log warning
and continue. Attribution enriches knowledge but must never block the
monitor tick.

After writing new entries, update the 30-day rolling aggregates:
```
Read last 30 days from knowledge/live-attribution.jsonl
Compute by_archetype, by_exit_reason, by_regime, gate_effectiveness, divergence_summary
Write knowledge/live-attribution-rollup.json
```

See `skills/attribution/SKILL.md` for full rollup schema.

**Eviction priority computation (Slot Management):**

After metrics are updated, walk every campaign with
`slot_state in {"trial", "graduated"}` and stamp an `eviction_priority`
score plus an `eviction_factors[]` audit list. This is a pure read pass
over fields already computed above — no extra I/O. The score drives
both Trigger I (early eviction) and Step 6 (replacement candidate
selection) so they all reach the same decision.

```
weights = config.SLOT_MANAGEMENT.eviction_weights

For each campaign with slot_state in {"trial","graduated"}:
  factors = []
  if campaign.slot_state == "trial":
    score = weights.trial_base                                    # 100
    factors.append("trial_base:100")

    age_h = (now - campaign.deployed_at).hours
    if current_trade_count == 0 and age_h >= 24:
      score += weights.dead_bot_bonus                             # +50
      factors.append("dead_bot:50")

    if current_trade_count >= 5 and current_win_rate < 0.25:
      score += weights.low_win_rate_bonus                         # +30
      factors.append("low_win_rate:30")

    if (divergence_pct or 0) > 0.50:
      score += weights.high_divergence_bonus                      # +20
      factors.append("high_divergence:20")

    if now > campaign.trial_deadline:
      days_over = max(1, ((now - campaign.trial_deadline).days))
      score += weights.expired_per_day * days_over                # +10/day
      factors.append(f"expired_{days_over}d:{weights.expired_per_day*days_over}")

    if current_win_rate > 0.45:
      score += weights.promising_protection                       # -20
      factors.append("promising:-20")

    gates_met = count_graduation_gates_met(campaign,
                  config.SLOT_MANAGEMENT.graduation_gates)
    if gates_met >= 4:
      score += weights.near_graduation_protection                 # -30
      factors.append(f"near_grad_{gates_met}_of_6:-30")

  else:  # slot_state == "graduated"
    score = weights.graduated_base                                # 0
    factors.append("graduated_base:0")

    if current_win_rate < 0.30:
      score += weights.degrading_win_rate                         # +30
      factors.append("degrading_wr:30")

    if (divergence_pct or 0) > 0.50:
      score += weights.degrading_divergence                       # +20
      factors.append("degrading_div:20")

    archetype = read_archetype(campaign.archetype)
    current_regime = read_regime(campaign.pair, campaign.timeframe)
    if current_regime in archetype.anti_regimes:
      score += weights.anti_regime                                # +40
      factors.append("anti_regime:40")

    if (campaign.paper_trading.investigation_mode and
        campaign.paper_trading.investigation_reason ==
            "regime_conditional_collapse"):
      score += weights.regime_fault_paused                        # +50
      factors.append("regime_fault_paused:50")

    only_in_group = is_only_bot_in_group(campaign.correlation_group,
                                         all_active_campaigns)
    if only_in_group:
      score += weights.diversity_protection                       # -30
      factors.append("diversity:-30")

    if (current_sharpe or 0) > 0.8:
      score += weights.strong_performer_protection                # -20
      factors.append("strong_performer:-20")

    if campaign.graduated_at:
      tenure_d = (now - campaign.graduated_at).days
      if tenure_d > 30:
        score += weights.tenure_protection                        # -10
        factors.append(f"tenure_{tenure_d}d:-10")

  campaign.eviction_priority = score
  campaign.eviction_factors  = factors
```

This stamps every active campaign with a sortable score before any
decision is made. Step 4 (Trigger H/I) and Step 6 (slot allocation /
graduated replacement) are then pure table lookups against
`campaign.eviction_priority`.

`sync_state_to_supabase(state_key="campaigns", ...)`

**TV Signal Source Tracking (if tv-signals.json exists and is non-empty):**

The TV manual trade bot runs separately from the autonomous pipeline.
Update P&L stats for each TV source by matching closed trades on the
manual bot back to signal log entries.

```
tv_sources = read tv-signals.json (loaded in Step 1)
If tv_sources is non-empty:
  tv_bot_status = freqtrade_fetch_bot_status(bot_id="tv-manual")

  If tv_bot_status responds:
    # Match closed trades to TV signal sources via order_tag prefix "tv_"
    tv_trades = freqtrade_fetch_trades(bot_id="tv-manual", limit=100)

    For each tv_source in tv_sources:
      source_trades = [t for t in tv_trades if t.order_tag starts with "tv_{source.source_id}_"]
      closed = [t for t in source_trades if t.is_closed]

      tv_source.stats.trade_count = len(closed)
      tv_source.stats.win_rate = count(t.profit > 0 for t in closed) / len(closed) if closed else 0
      tv_source.stats.pnl_pct = sum(t.profit_pct for t in closed)

      # Flag underperforming sources
      If tv_source.stats.trade_count >= 10 AND tv_source.stats.win_rate < 0.25:
        Post to feed: "TV SOURCE WARNING: {source.name} win rate {wr}% over {n} trades"

    # Check for timed-out trades (configurable, default 168h = 7 days)
    timeout_hours = config.TV_SIGNALS.tracking.auto_close_timeout_hours
    For each open trade on tv-manual:
      If (now - trade.open_date).hours > timeout_hours:
        Post warning: "TV TRADE TIMEOUT: {pair} open for {hours}h — consider manual close"

    # Update tv-signal-log.jsonl outcomes for newly closed trades
    For each newly closed trade (not yet in log outcome):
      Find matching log entry by signal_id from order_tag
      Update: outcome.closed=true, outcome.exit_price, outcome.profit_pct,
              outcome.exit_reason, outcome.closed_at

      # Emit trade close event for dashboard notifications
      aphexdata_record_event(
        verb_id: "tv_trade_closed",
        verb_category: "execution",
        object_type: "trade",
        object_id: trade.order_tag,
        result_data: {
          source_id, signal_id, pair: trade.pair,
          direction: trade.side, profit_pct: trade.profit_pct,
          exit_reason: trade.exit_reason,
          duration_hours: (trade.close_date - trade.open_date).hours
        }
      )

    Write updated tv-signals.json
    sync_state_to_supabase(state_key="tv_signals", file="tv-signals.json")
```

### Step 4: EARLY RETIREMENT CHECK

**Portfolio-level graduated drawdown response (every tick):**

Before checking individual bots, evaluate portfolio-level drawdown.
Read thresholds from `scoring-config.json` → `CIRCUIT_BREAKER`:

```
portfolio_dd = portfolio.max_drawdown_pct  # from portfolio.json

# Tier 1: Alert (dd_alert_pct, default 5%)
If portfolio_dd >= config.CIRCUIT_BREAKER.dd_alert_pct
   AND portfolio_dd < config.CIRCUIT_BREAKER.dd_pause_pct:
  Log warning: "Portfolio DD at {dd}% — alert threshold crossed"
  Message user: "Portfolio drawdown alert: {dd}%"

# Tier 2: Pause highest-variance trial (dd_pause_pct, default 10%)
If portfolio_dd >= config.CIRCUIT_BREAKER.dd_pause_pct
   AND portfolio_dd < config.CIRCUIT_BREAKER.dd_flat_pct:
  # Find trial bot with highest eviction_priority (already computed in Step 3)
  worst_trial = max(trials, key=lambda c: c.eviction_priority)
  freqtrade_pause_signals(worst_trial.bot_id)
  worst_trial.dd_paused = true
  worst_trial.dd_paused_at = now
  Log: "Paused {worst_trial.strategy} (eviction_priority: {score}) — portfolio DD at {dd}%"
  # Paused bots stay paused until the next daily rollup re-evaluates.
  # No auto-resume on DD recovery — bounces create whipsaw.
  # Log experiment: this is a material change requiring a ledger entry.

# Tier 3: Circuit breaker (dd_flat_pct, default 15%)
If portfolio_dd >= config.CIRCUIT_BREAKER.dd_flat_pct:
  # Existing circuit breaker logic — flat everything
  portfolio.circuit_breaker_active = true
  # ... (see Emergency Stop procedure above)

# Alpha flag: negative alpha for extended period
If competition mode active:
  hours_negative = consecutive hours where alpha_pct < 0
  If hours_negative >= config.CIRCUIT_BREAKER.negative_alpha_flag_hours:
    Flag in daily scorecard: "ALPHA NEGATIVE for {hours}h"
    # Does NOT trigger automatic action — surfaced for daily rollup review
```

For each warm-up bot only (proven bots earned their slot):

Read archetype from `archetypes.yaml`:
```
max_dd = archetype.graduation_gates.max_drawdown_pct
```

**TRIGGER A — Catastrophic drawdown (immediate)**

  Read archetype max_dd from archetypes.yaml.

  If campaign.triage.high_regime_dependency == true:
    dd_multiplier = 1.0  (tighter — less room for error)
  Else:
    dd_multiplier = 1.5  (standard)

  `abs(current_max_dd) > max_dd × dd_multiplier`
  Reason: `"drawdown_exceeded"`

  A strategy losing this much is dangerous even on paper.
  This is a safety circuit breaker, not a performance judgment.

  High-regime-dependency bots (unfavorable Sharpe between -0.5
  and -1.0) get retired at 1.0× the archetype max drawdown
  instead of 1.5×. They have less margin for error because if
  regime gating fails, the downside is steep.

  → Retire immediately. Stop bot. Free slot.

**TRIGGER B — Dead container (immediate)**
  `campaign.consecutive_container_down >= cfg.dead_container_consecutive_checks`
  (default: 2 — persisted across ticks by Step 1 reconcile)
  Reason: `"container_failed"`

  Step 1 attempted a restart on first detection. If the container
  is still down on the next health check, the restart failed and
  the container is genuinely dead. Auto-mode can't fix
  infrastructure — retire and free the slot.

  → Retire. Alert user: "Container down for {strategy}"

**TRIGGER C — Clear negative edge (needs trades)**
  `current_trade_count >= 5`
  AND last 5 trades are ALL losses
  AND cumulative loss from those 5 trades > 5%
  Reason: `"consecutive_losses"`

  This can only trigger after the strategy has produced enough
  trades to judge. 5 consecutive losses with >5% total loss is
  statistically meaningful — this isn't bad luck, it's bad edge.

  → Retire. Stop bot. Free slot.

**TRIGGER D — Win rate floor (needs trades)**
  `current_trade_count >= 5`
  AND `current_win_rate < win_rate_floor`
  Reason: `"win_rate_floor"`

  The win rate floor is archetype-aware:
    High-win-rate archetypes (MEAN_REVERSION, RANGE_BOUND,
    SCALPING, CARRY_FUNDING): floor = 0.25
    Low-win-rate archetypes (TREND_MOMENTUM, BREAKOUT,
    VOLATILITY_HARVEST): floor = 0.20

  Read archetype from `archetypes.yaml`. These archetypes can
  survive lower win rates because their winners are typically
  much larger than their losers.

  At 5+ trades this is meaningful signal — not bad luck.

  → Retire. Stop bot. Free slot.
  → Log to kata-bridge: obstacle = "win_rate",
    archetype = campaign.archetype

**TRIGGER E — R:R inversion alert (needs trades, NOT a retirement trigger)**
  `current_trade_count >= 5`
  AND `current_win_rate > 0.45`
  AND `current_pnl_pct < -1.0`
  Reason: `"risk_reward_inversion"`

  The strategy wins more than it loses but still bleeds money.
  This means losing trades are much larger than winning trades —
  a classic R:R inversion. The entries work; the exits are broken.

  Confirm by checking:
  `current_avg_loss_pct > current_avg_win_pct × 1.5`
  If not confirmed, skip (P&L may be negative for other reasons).

  → Do NOT retire. Pause signals: set signals_active = false
  → Set campaign.paper_trading.investigation_mode = true
  → Set campaign.paper_trading.investigation_reason = "risk_reward_inversion"
  → Post to feed: "R:R INVERSION: {strategy} on {pair}/{tf}
      — {win_rate}% win rate but {pnl}% P&L.
      Avg win: {avg_win}%, avg loss: {avg_loss}%.
      Signals paused, routing to kata."
  → Message user: "{strategy} wins {win_rate}% of trades but is
      losing money. Exits are too wide. Routing to kata with
      obstacle: risk_reward_ratio. Signals paused pending fix."
  → Record in kata-state: obstacle = "risk_reward_ratio"
  → aphexdata_record_event(verb_id="rr_inversion_flagged",
      verb_category="risk", ...)

**TRIGGER F — Degrading (needs trades, NOT a retirement trigger, signals stay on)**
  `current_trade_count >= 8`
  AND at least ONE of:
    (a) `current_win_rate` is in `[0.30, 0.40)` for high-win-rate archetypes
        OR in `[0.25, 0.30)` for low-win-rate archetypes
        (i.e. the "degrading" band above the retirement floor)
    (b) `divergence_pct >= 0.30` where
        `divergence_pct = 1 - (current_sharpe / campaign.wfo_sharpe)`
        (live Sharpe has lost 30-50% relative to the backtest baseline)
    (c) `current_regime` is drifting: in `archetype.anti_regimes` with
        `conviction >= 60` for 2 consecutive ticks, even though not
        yet at the portfolio-wide anti-regime gate

  The strategy is sliding but hasn't crossed any hard floor yet. Retirement
  at this point would throw away a strategy that still has salvageable
  entries. Instead, route to kata early — fix before it dies.

  Classify the failure mode to pick the obstacle:
    - High win_rate but losing money → obstacle = "risk_reward_ratio"
    - Divergence >= 0.30 but regime fit still preferred → obstacle = "overfit_decay"
    - Anti-regime drift → obstacle = "regime_dependent"
    - Else → obstacle = "entry_quality"

  **Severity escalation on divergence.** Divergence separates a soft "route to
  kata but keep trading" case from a hard "pause now" case:
    - `divergence_pct in [0.30, 0.70)` → route to kata, signals stay ON
    - `divergence_pct >= 0.70` → route to kata AND pause signals immediately
      (set signals_active = false; set investigation_mode = true;
       reason = "severe_divergence"). The backtest baseline is effectively
       dead — collecting more live data at this decay level just compounds losses.

  Default (non-divergence) path: Do NOT retire. Do NOT pause signals.
  → Set campaign.paper_trading.severity = "degrading"
  → Set campaign.paper_trading.degrading_since = now (if not already set)
  → Route to kata-bridge with the classified obstacle (non-blocking)
  → Post to feed: "DEGRADING: {strategy} on {pair}/{tf}
      — {reason summary}. Routed to kata with obstacle: {obstacle}.
      Signals {remain active | PAUSED — severe divergence} pending fix."
  → aphexdata_record_event(verb_id="degrading_flagged",
      verb_category="risk", result_data={obstacle, reason, metrics,
      divergence_pct, severity})

  If a strategy is already flagged "degrading" and a HARD trigger (A-D)
  subsequently fires, the retirement takes precedence — we tried.

**TRIGGER G — Regime-conditional collapse (needs enriched trades, pauses)**

  Finding 1 adds regime-conditional fast-path retirement on top of Trigger
  D's integrated win-rate floor. Where Trigger D waits for the *aggregate*
  win rate to crash, Trigger G catches strategies that are specifically
  broken in a regime the archetype should never trade. This runs ONLY when
  per-trade enrichment has produced a populated `paper_pnl.by_regime` map
  (warm-up bots with zero enriched trades are skipped).

  Read the live paper_pnl.by_regime rollup (produced by nanoclaw's
  computeByRegime from enriched_trades). For each regime key in the map:

    anti = archetype.anti_regimes (from archetypes.yaml)
    metrics = by_regime[regime]

    If regime is in anti AND metrics.n_trades >= 5 AND
       metrics.win_rate < 15.0:
      → hard hit. The strategy is actively bleeding in a regime the
        archetype was explicitly told to avoid. Pause signals, route to
        kata with obstacle `regime_dependent`, do NOT retire yet
        (entries outside the anti-regime may still be viable).

    If regime is in anti AND metrics.n_trades >= 8 AND
       metrics.pnl_pct < -2.0:
      → same pause. The sample is larger and the loss is deep enough
        that waiting for integrated win-rate to cross the floor would
        keep compounding damage.

    If ANY regime (preferred or anti) has metrics.n_trades >= 10 AND
       metrics.win_rate < 10.0:
      → regime-agnostic collapse. Pause signals, route to kata with
        obstacle `entry_quality`. At 10+ trades and <10% win rate the
        entry hypothesis is wrong regardless of regime.

  → Do NOT retire immediately — the strategy may still have preferred-
    regime edge worth recovering in kata. Set:
      signals_active = false
      campaign.paper_trading.investigation_mode = true
      campaign.paper_trading.investigation_reason = "regime_conditional_collapse"
      campaign.paper_trading.regime_fault = regime (the offending key)
      campaign.paper_trading.regime_metrics = metrics (for kata diagnosis)
  → Post to feed: "REGIME COLLAPSE: {strategy} on {pair}/{tf}
      — {win_rate}% win rate in {regime} over {n_trades} trades
      ({pnl_pct}% P&L). Signals paused, routing to kata with
      obstacle: {obstacle}."
  → aphexdata_record_event(verb_id="regime_collapse_flagged",
      verb_category="risk", result_data={regime, obstacle, metrics})

  **Why this is an earlier signal than Trigger D.** A strategy with 5%
  win rate in CHAOS but 60% win rate in COMPRESSION has an *integrated*
  win rate around 40% — nowhere near Trigger D's floor. Trigger D would
  happily run it for weeks before retiring, bleeding capital in CHAOS
  the whole time. Trigger G catches the CHAOS leg specifically within
  5-10 trades and routes the strategy to kata with the exact regime
  metric attached, so the diagnosis prompt can work from data instead
  of speculation.

**TRIGGER J — Execution quality collapse (Finding 12, pause not retire)**

  The DSR/PBO gate (Finding 16) answers "is the Sharpe statistically real?"
  Trigger J answers "does the Sharpe survive execution costs?" A strategy
  with great entries on a low-liquidity pair can be eaten by slippage —
  high win rate, negative P&L. Pause not retire because it may still be
  viable on a more liquid pair; routing to investigation preserves that
  option.

  ```
  cfg = config.EXECUTION_GATES

  Skip entirely if cfg.enabled == false (back-compat).
  Skip if execution_quality is unset (no enriched trades yet, legacy data,
       or deployment lacks volume_weight — gate handles missing data
       gracefully like the DSR/PBO gates do).
  Skip if current_trade_count < cfg.min_trades_for_gate (default 10 —
       one bad trade can crater execution_quality).
  Skip if campaign.paper_trading.execution_drag_paused == true
       (already paused on a previous tick — don't double-fire).

  if execution_quality < cfg.pause_threshold (default 0.50):
    PAUSE signals (do NOT retire — venue problem, not strategy problem):
      campaign.paper_trading.execution_drag_paused = true
      campaign.paper_trading.pause_reason = "execution_drag"
      record_deployment_warning(cell, "execution_drag")
    Post: "{strategy} paused — execution_quality {q:.2f} < 0.50.
           Slippage is eating {slip_pct:.0%} of gross P&L. Review:
           is the pair too small (volume_weight {vw:.2f}) or is
           entry timing hitting wide-spread windows?"

  elif slippage_as_pct_of_pnl > cfg.slippage_pnl_ratio_max (default 0.50):
    FLAG for review (do not pause yet — borderline case):
      campaign.paper_trading.execution_warning = true
    Post: "{strategy} execution warning — slippage is {slip_pct:.0%}
           of gross P&L. Strategy may only be viable on higher-
           liquidity pairs."
  ```

  **Why pause and not retire.** Trigger J fires on a venue mismatch
  (mid-cap pair with wide spreads) — the strategy logic is fine, the
  execution context is wrong. Retiring would kill a salvageable
  strategy and record a false `deployment_failure` that penalizes the
  cell in future scout scoring. Pausing preserves the option to
  redeploy on a better pair after kata investigation.

  **The Finding 13 preventive pair.** Scout gap scoring now applies a
  `volume_weight < 0.20 → 0.7×` penalty so the system stops *researching*
  strategies on pairs where execution will eat them alive. Trigger J
  catches execution failures reactively; the scout penalty prevents
  them proactively. Together they close the loop.

**TRIGGER H — Trial deadline expiry (slot lifecycle, trial bots only)**

  Slot Management spec adds a hard trial deadline per timeframe. When
  the deadline passes, the trial is evaluated against ALL graduation
  gates in one pass — no extensions, no "one more day". This runs
  AFTER Triggers A–G so any hard fault retires the bot before slot
  lifecycle even checks the deadline.

  ```
  cfg = config.SLOT_MANAGEMENT

  For each campaign with slot_state == "trial":
    if now < campaign.trial_deadline:
      continue                                  # still inside trial window

    gates = evaluate_graduation_gates(
              campaign, cfg.graduation_gates)
    # gates is { gate_name: {required, actual, met} } for all six gates
    # (min_trades, min_win_rate, min_favorable_sharpe,
    #  min_risk_reward_ratio, max_consecutive_losses, max_divergence)
    campaign.graduation_gates = gates
    all_met = all(g.met for g in gates.values())

    if all_met:
      transition trial → graduated:
        campaign.slot_state    = "graduated"
        campaign.graduated_at  = now
        campaign.eviction_priority = 0   # reset; recomputed next tick
        # Existing webhook bridge still applies — slot_state and
        # state are orthogonal: a "graduated" trial enters
        # state="graduated_internal_only" via the standard graduation
        # actions in Step 5 (Case 1 GRADUATE actions).
      Post: "GRADUATED (Trigger H): {strategy} passed all 6 gates at deadline"
      aphexdata_record_event(verb_id="slot_trial_graduated",
        verb_category="execution",
        result_data={gates, age_days, eviction_priority_history})

    else:
      failed = [name for name,g in gates.items() if not g.met]
      retire(campaign, reason="trial_deadline_expired",
             extras={failed_gates: failed, gates: gates})
      record_deployment_failure(campaign.archetype, campaign.pair,
                                campaign.timeframe)
      Post: "EVICTED (Trigger H): {strategy} failed {failed} at deadline"
      aphexdata_record_event(verb_id="slot_trial_evicted",
        verb_category="execution",
        result_data={reason: "trial_deadline_expired", failed_gates: failed})
  ```

  Trigger H is the closing of the trial window. Either the bot has
  earned its slot or it hasn't, and there are no second chances at
  the deadline.

**TRIGGER I — Trial early eviction (slot lifecycle, trial bots only)**

  Five fast-fail triggers that fire BEFORE the deadline. Any one is
  sufficient to evict — these are the "obviously broken" filters that
  free dead slots within hours rather than days.

  ```
  cfg = config.SLOT_MANAGEMENT.trial_early_eviction

  For each campaign with slot_state == "trial":
    age_h = (now - campaign.deployed_at).hours
    fired = None

    if current_trade_count == 0 and age_h >= cfg.zero_trades_hours:    # 48
      fired = "early_eviction:zero_trades"

    elif (current_trade_count <= cfg.near_dead_trades and              # ≤1
          age_h >= cfg.near_dead_hours):                               # 72h
      fired = "early_eviction:near_dead"

    elif (current_trade_count >= cfg.min_win_rate_n and                # 5
          current_win_rate < cfg.min_win_rate_floor):                  # 0.20
      fired = "early_eviction:broken_entries"

    elif (divergence_pct or 0) >= cfg.max_divergence:                  # 0.70
      fired = "early_eviction:severe_overfit"

    elif current_pnl_pct <= cfg.max_loss_pct:                          # -5%
      fired = "early_eviction:catastrophic_dd"

    if fired:
      retire(campaign, reason=fired)
      record_deployment_failure(campaign.archetype, campaign.pair,
                                campaign.timeframe)
      Post: "EARLY EVICT (Trigger I): {strategy} — {fired}"
      aphexdata_record_event(verb_id="slot_trial_evicted",
        verb_category="execution",
        result_data={reason: fired, age_h, trade_count: current_trade_count,
                     win_rate: current_win_rate, divergence_pct,
                     pnl_pct: current_pnl_pct})
  ```

  Trigger I overlaps with Trigger D (win rate floor) on purpose: a
  trial bot with 25% WR after 5 trades hits Trigger D first, then
  Trigger I, and either path retires it. The duplication is cheap and
  ensures eviction even if archetype-specific Trigger D thresholds
  later relax.

**THAT'S IT.** Nine triggers (A-I). Triggers A-D retire immediately.
Triggers E, F, G pause or flag without immediate retirement. Trigger F
routes to kata without pausing (preserving entry signals while exits are
repaired). Trigger G pauses ONLY when the regime evidence is clean.
Triggers H and I close the slot lifecycle: H at the trial deadline,
I before the deadline when the trial is obviously broken. Everything
else waits for the validation deadline in Step 5.

What's NOT a retirement trigger:
  - Zero trades after N hours → NOT a trigger.
    Step 3 posts warnings at 48h/72h. The validation deadline
    catches "not enough trades" at the end. Premature killing
    wastes validated strategies.

  - Low Sharpe before deadline → NOT a trigger.
    Sharpe is noisy with small sample sizes. A strategy at
    -0.2 Sharpe after 3 trades might be +0.5 after 15.
    Wait for the deadline and min_trades. Trigger D covers
    the specific case of very low win rate (distinct from Sharpe).

  - Regime-blocked signals → NOT a trigger.
    Signals being OFF because composite < 3.5 is the system
    working correctly. The strategy will trade when the regime
    rotates. Regime-blocked time doesn't count against it.

  - Moderate P&L loss → NOT a trigger (unless Trigger D fires).
    A strategy at -0.5% after 3 trades might recover.

**Portfolio emergency audit (after all individual bot checks):**

```
Compute portfolio_win_rate across all warm-up bots with trade_count >= 1:
  total_wins = sum(trade_count × win_rate for each bot)
  total_trades = sum(trade_count for each bot)
  portfolio_win_rate = total_wins / total_trades (if total_trades > 0)

If portfolio_win_rate < 0.30 AND total_trades >= 10:
  Post to feed: "PORTFOLIO EMERGENCY: {portfolio_win_rate}% win rate
    across {total_trades} trades."
  For each warm-up bot with current_win_rate < 0.25 AND trade_count >= 3:
    → Retire immediately (reason: "portfolio_emergency_audit")
  For each warm-up bot with current_trade_count == 0 AND hours_since_deploy > 48:
    → Pause signals (set signals_active = false)
  Message user: "Emergency audit triggered. Retired {n} bots below 25%
    win rate, paused {m} inactive bots."
```

**On early retire (any trigger):**
```
Stop container: bot_stop(bot_deployment_id)
campaign.state = "retired"
campaign.paper_trading.retire_reason = reason

# Update authoritative slot state (deployments.json is what the slot counter reads)
dep = find in deployments.deployments where id == campaign.id
dep.state = "retired"
dep.retired_reason = reason
write auto-mode/deployments.json
sync_state_to_supabase(state_key="deployments", ...)

aphexdata_record_event(verb_id="kata_retired_early", ...)
Post to feed: "Early retirement: {strategy} on {pair}/{tf} — {reason}"
Message user: "{strategy} retired early — {reason}"
```

### Step 5: GRADUATION CHECK

**Early graduation pass (Slot Management — runs BEFORE deadline check):**

A trial bot can graduate before its `trial_deadline` if ALL six
graduation gates from `SLOT_MANAGEMENT.graduation_gates` are met. This
rewards strong performers with earlier protection — once they graduate,
Trigger I no longer applies and they get the full eviction_priority
shielding (diversity, strong_performer, tenure).

```
For each campaign with slot_state == "trial":
  if now >= campaign.trial_deadline:
    continue                 # Trigger H in Step 4 already handled this

  gates = evaluate_graduation_gates(
            campaign, config.SLOT_MANAGEMENT.graduation_gates)
  campaign.graduation_gates = gates

  if all(g.met for g in gates.values()):
    transition trial → graduated:
      campaign.slot_state    = "graduated"
      campaign.graduated_at  = now
      campaign.eviction_priority = 0
    Run the standard GRADUATE actions below (writes header tags,
    enters graduated_internal_only bridge, etc.) — slot lifecycle
    and webhook bridge are orthogonal but both fire at this point.
    Post: "EARLY GRADUATED: {strategy} — all 6 gates met before deadline"
    aphexdata_record_event(verb_id="slot_trial_early_graduated",
      verb_category="execution",
      result_data={gates, days_remaining: (trial_deadline - now).days})
```

The `evaluate_graduation_gates` helper is the same one used by
Trigger H. Centralizing the gate evaluator means a single config
change to `SLOT_MANAGEMENT.graduation_gates` updates both early
graduation and deadline graduation in lockstep.

**Validation deadline check (existing flow):**

For each warm-up bot past its validation deadline:
```
deadline = campaign.paper_trading.validation_deadline
If now < deadline → skip (still validating)
```

Read graduation criteria from `archetypes.yaml`:
```
min_trades = paper_validation[timeframe].min_trades
min_sharpe = paper_validation[timeframe].min_live_sharpe
max_dd = graduation_gates.max_drawdown_pct
```

**CASE 1: Enough trades to judge**
  `current_trade_count >= min_trades`

  **Primary gates (same as before):**
    `current_sharpe >= min_sharpe`
    `abs(current_max_dd) <= max_dd`

  **Quality gates (all must pass alongside primary gates):**

    Win rate floor:
      Low-win-rate archetypes (TREND_MOMENTUM, BREAKOUT,
      VOLATILITY_HARVEST): `current_win_rate >= 0.28`
      All other archetypes: `current_win_rate >= 0.35`

    Risk/reward ratio:
      `current_avg_win_pct / current_avg_loss_pct >= 0.8`
      (losses are no more than 25% larger than wins on average)

    Consecutive loss streak:
      `max_consecutive_losses <= 4`

  **R:R inversion check (special routing, not retire):**
    If `current_win_rate > 0.50 AND current_avg_win_pct < current_avg_loss_pct`:
      → Do NOT graduate. Do NOT retire.
      → Set campaign.paper_trading.investigation_mode = true
      → Set campaign.paper_trading.rr_extension = true
      → Extend validation by full validation_days
      → Route to kata: obstacle = "risk_reward_ratio"
      → Post: "{strategy} passed trade count and Sharpe gates but
          R:R is inverted ({win_rate}% win rate, avg win {x}%,
          avg loss {y}%). Routing to kata for exit improvement."
      → Skip graduation this tick.

  **Overfitting gate (Bailey & Lopez de Prado, runs after primary + quality gates):**

  This gate fires only after primary + quality gates have passed. It asks
  the question those gates can't: "is the observed Sharpe statistically
  real, or is it a selection-bias artifact from the kata trying many
  variants and picking the best?" The math is computed by the kata at
  graduation time and travels with the campaign as `wfo_metrics`.

  ```
  cfg = config.OVERFITTING_GATES
  Skip entirely if cfg.enabled == false (back-compat for ops emergencies).

  If campaign.wfo_metrics is missing:
    → Note "no wfo_metrics — pre-overfit-gates graduate, skipping overfit check"
    → Continue to GRADUATE (do NOT block legacy campaigns)
    → Record gate as {required: cfg.dsr_threshold, actual: null, met: null,
                       reason: "no_wfo_metrics"} in campaign.graduation_gates

  Read: dsr  = wfo_metrics.dsr
        pbo  = wfo_metrics.pbo
        n_tried = wfo_metrics.n_strategies_tried

  Stamp into the per-tick gate snapshot:
    campaign.graduation_gates["dsr"] = {
      required: cfg.dsr_threshold,        # 1.96
      actual:   dsr,
      met:      dsr >= cfg.dsr_threshold,
    }
    campaign.graduation_gates["pbo"] = {
      required: cfg.pbo_max,              # 0.30
      actual:   pbo,
      met:      pbo <= cfg.pbo_max,
    }

  If pbo > cfg.pbo_evict (0.50):
    → **RETIRE** with reason `"overfit_pbo_above_evict"`
    → record_deployment_failure(cell)    # blacklist the cell pattern
    → Post: "{strategy} retired — PBO {pbo:.2f} > 0.50 indicates the
            backtest is more overfit than predictive"
    → aphexdata_record_event(verb_id="overfit_evict",
        result_data={dsr, pbo, n_tried, reason: "pbo_above_evict"})

  Elif current_trade_count < cfg.min_trades_for_dsr (10):
    → DSR has too much standard error to enforce. Continue to GRADUATE.
    → Note "trade_count {n} < min_trades_for_dsr {min}, gate informational only"

  Elif dsr < cfg.dsr_threshold (1.96):
    → Do NOT graduate. Do NOT retire.
    → If `campaign.paper_trading.dsr_extension != true`:
      → Set `campaign.paper_trading.dsr_extension = true`
      → Extend validation by `cfg.deadline_extension_on_low_dsr × 50%`
        of the original validation period
      → Post: "{strategy} passed Sharpe but DSR {dsr:.2f} < 1.96
              (n_tried={n_tried}). Extending validation by {ext_days}d
              to accumulate statistical power."
      → aphexdata_record_event(verb_id="overfit_extend",
          result_data={dsr, pbo, n_tried, reason: "low_dsr"})
    → Skip graduation this tick.
    → If already extended once: **RETIRE** with reason
      `"low_dsr_after_extension"` — strategy had 1.5× the validation
      window and still couldn't reach statistical significance.

  Elif pbo > cfg.pbo_max (0.30):
    → Do NOT graduate. Do NOT retire.
    → Same dsr_extension flag + extension as above (one extension only).
    → Post: "{strategy} passed Sharpe but PBO {pbo:.2f} > 0.30.
            Extending validation to gather more out-of-sample evidence."
    → aphexdata_record_event(verb_id="overfit_extend",
        result_data={dsr, pbo, n_tried, reason: "high_pbo"})
    → Skip graduation this tick.
    → If already extended: **RETIRE** with reason `"high_pbo_after_extension"`.

  Else (all overfit gates pass):
    → Continue to execution realism gate.
  ```

  **Execution realism gate (Finding 12, runs after overfit gate):**

  The DSR/PBO gate answers "is the Sharpe statistically real?" The
  execution gate answers "does the Sharpe survive trading costs?" A
  strategy can graduate with real DSR and lose money live because the
  backtest assumed perfect fills. Slippage on a mid-cap pair can eat
  the entire edge — high win rate, negative P&L.

  ```
  cfg = config.EXECUTION_GATES
  Skip entirely if cfg.enabled == false (back-compat).

  If campaign.paper_trading.execution_quality is None:
    → No execution data (legacy campaign or deployment lacks volume_weight).
    → Record gate as {required: cfg.min_execution_quality, actual: null,
                      met: null, reason: "no_execution_data"}
    → Continue to GRADUATE (informational only — never block legacy).

  If current_trade_count < cfg.min_trades_for_gate (10):
    → Too few trades for a stable execution_quality reading.
    → Record gate as {required: cfg.min_execution_quality,
                      actual: execution_quality, met: null,
                      reason: "insufficient_trades_for_execution_gate"}
    → Continue to GRADUATE.

  exq = campaign.paper_trading.execution_quality

  Stamp into the per-tick gate snapshot:
    campaign.graduation_gates["execution_quality"] = {
      required: cfg.min_execution_quality,    # 0.60
      actual:   exq,
      met:      exq >= cfg.min_execution_quality,
    }

  If exq < cfg.min_execution_quality (0.60):
    → Do NOT graduate. Do NOT retire.
    → Post: "{strategy} passed Sharpe + DSR but execution_quality
            {exq:.2f} < 0.60. Edge does not survive execution costs.
            Trigger J will pause signals next tick if it falls below 0.50."
    → aphexdata_record_event(verb_id="execution_block",
        result_data={execution_quality: exq,
                     slippage_as_pct_of_pnl: campaign.paper_trading.slippage_as_pct_of_pnl})
    → Skip graduation this tick.

  Else:
    → Continue to GRADUATE.
  ```

  Note: the early-graduation pass at the top of Step 5 already calls
  `evaluate_graduation_gates(campaign, ...)` and the new dsr/pbo +
  execution_quality entries in `campaign.graduation_gates` are picked
  up by `all(g.met for g in gates.values())` automatically — slot
  management's "all gates met → graduate early" logic absorbs the
  overfit and execution gates without extra wiring. Trial bots that
  meet primary + quality + overfit + execution gates before deadline
  flip directly to `slot_state: graduated`.

  If ALL primary + quality + overfit + execution gates pass:
    → **GRADUATE** (see graduation actions below)

  If primary gates pass but quality gates fail:
    → **RETIRE** with specific reason:
      win_rate below floor: `"low_win_rate_at_graduation"`
      avg_win/avg_loss < 0.8: `"poor_rr_ratio_at_graduation"`
      max_consecutive_losses > 4: `"consecutive_losses_at_graduation"`

  If primary gates fail:
    → **RETIRE** with specific reason:
      sharpe < min: `"low_sharpe"`
      dd > max: `"excessive_drawdown"`

**CASE 2: Some trades but not enough**
  `current_trade_count > 0 AND < min_trades`

  If `campaign.paper_trading.extended != true`:
    → **EXTEND** validation by 50% of original period
    → `campaign.paper_trading.validation_deadline += (validation_days × 0.5)`
    → `campaign.paper_trading.extended = true`
    → Post: "{strategy} has {n}/{min} trades at deadline.
      Extending validation by {days} days for more data."
    → Skip graduation/retirement this tick.

  If already extended (`campaign.paper_trading.extended == true`):
    → **RETIRE**. Reason: `"insufficient_trades_after_extension"`
    → The strategy had 1.5× the validation period and still
      didn't reach min_trades. It's too infrequent for this timeframe.

**CASE 3: Zero trades at deadline**
  `current_trade_count == 0`

  Check regime-blocked ratio:
  ```
  total_ticks = ticks_signals_on + ticks_signals_off
  signals_on_pct = ticks_signals_on / total_ticks (if total_ticks > 0)
  ```

  If `signals_on_pct < 0.25` (signals ON less than 25% of time):
    → The strategy never had a fair chance. Regime was against it.
    → If `campaign.paper_trading.regime_extension != true`:
      → **EXTEND** by the full original validation period
      → `campaign.paper_trading.validation_deadline += validation_days`
      → `campaign.paper_trading.regime_extension = true`
      → Post: "{strategy} was regime-blocked for {pct}% of warm-up.
        Resetting validation clock."
    → If already regime-extended:
      → **RETIRE**. Reason: `"no_signals_after_regime_extension"`

  If `signals_on_pct >= 0.25` (had opportunities but never triggered):
    → **RETIRE**. Reason: `"no_signals_despite_favorable_regime"`
    → The strategy's entry conditions don't match this pair's behavior.

---

**GRADUATE actions (Case 1 pass):**

Graduation is a **two-stage bridge** to protect customer webhooks from live-only
bugs that only surface after the strategy leaves the warm-up sandbox. First
stage fires signals internally only; second stage opens them up externally.

```
# STAGE 1 — internal bake-in
campaign.state = "graduated_internal_only"
campaign.graduation = {
  graduated_at: now,
  live_sharpe: current_sharpe,
  live_trades: current_trade_count,
  live_pnl_pct: current_pnl_pct,
  live_max_dd: current_max_dd,
  internal_bridge_until: now + 3 days,
}

# Update authoritative slot state (deployments.json is what the slot counter reads)
dep = find in deployments.deployments where id == campaign.paper_trading.bot_deployment_id
if dep:
  dep.slot_state = campaign.slot_state          # "graduated" (set by Trigger H or early grad)
  dep.state = "graduated_internal_only"
  dep.graduated = now
  write auto-mode/deployments.json
  sync_state_to_supabase(state_key="deployments", ...)

Write header tags to strategy .py:
  # ARCHETYPE: {archetype}
  # GRADUATED: {date}
  # LIVE_VALIDATED: {days} days
  # LIVE_SHARPE: {sharpe}
  # LIVE_TRADES: {trades}
  # CORRELATION_GROUP: {group}

Add to roster.json (pre-stage config for fast future deployment).
Stamp `wf_sharpe` into the roster entry (market-timing reads this for `net_edge`):
  - Primary: `campaign.wfo_metrics.favorable_sharpe` (raw Sharpe, NOT 0-1 normalized kata_score)
  - Fallback: strategy header tag `# WF_SHARPE`
  - Fallback: strategy header tag `# KATA_SCORE`
  If no source available, omit the field (market-timing will score net_edge = 0).
Update TRADE.md at live graduation (third lifecycle sync boundary):
  TRADE_MD="/workspace/group/strategies/${strategy_name}.trade.md"
  1. Read existing TRADE.md
  2. Update provenance:
     - sharpe: {live_sharpe}
     - win_rate: {live_win_rate}
     - trades: {live_trade_count}
     - max_dd: {live_max_dd}
     - last_validated: {today}
  3. Update lineage.graduation_status: "paper"
  4. Validate: trade-md lint $TRADE_MD
  5. Rebuild registry: freqhub build /workspace/group/strategies/ -o /workspace/group/dist/
  If TRADE.md doesn't exist, log warning — legacy strategy without TRADE.md.

Keep bot running — signals flow to aphexDATA + console-sync ONLY,
no external webhooks yet (shouldFireWebhook returns false for this state).

aphexdata_record_event(verb_id="kata_graduated_internal_only", ...)
Post to feed: "GRADUATED (internal bridge): {strategy} on {pair}/{tf}
  — {days} days live, Sharpe {sharpe}, {trades} trades, P&L {pnl}%
  — External webhooks unlock in 3 days if live_sharpe stays >= 0.5"
```

**BRIDGE → EXTERNAL promotion (checked every tick for bridged campaigns):**
```
for campaign in campaigns where state == "graduated_internal_only":
  if now >= campaign.graduation.internal_bridge_until:
    if current_sharpe >= 0.5 AND no new retirement triggers fired during bridge:
      campaign.state = "graduated_external"
      # Propagate external graduation to deployments.json
      dep = find in deployments.deployments where id == campaign.paper_trading.bot_deployment_id
      if dep:
        dep.state = "graduated_external"
        write auto-mode/deployments.json
        sync_state_to_supabase(state_key="deployments", ...)
      If live_sharpe >= 0.8:
        Enable marketplace signal publishing
        Post: "PUBLISHED: {strategy} — Sharpe {s} exceeds publishing threshold"
      aphexdata_record_event(verb_id="kata_graduated_external", ...)
      Post: "EXTERNAL: {strategy} — 3-day internal bridge passed, webhooks live"
      Message user.
    else:
      Extend bridge by 1 day (max 2 extensions) OR retire if sharpe collapsed.
      Post warning with specific cause.
```

Webhook gating lives in nanoclaw `shouldFireWebhook()` — external webhooks
only fire when `state === "graduated_external"`. Legacy `state === "graduated"`
is still accepted for backwards compatibility with pre-bridge campaigns.

**RETIRE actions (any case):**
```
campaign.state = "retired"
campaign.paper_trading.retire_reason = reason
Stop container: bot_stop(bot_deployment_id, confirm=true)

# Update authoritative slot state (deployments.json is what the slot counter reads)
dep = find in deployments.deployments where id == campaign.id
dep.state = "retired"
dep.retired_reason = reason
write auto-mode/deployments.json
sync_state_to_supabase(state_key="deployments", ...)

# Update roster.json cell status (roster tracks pre-staged deployment state)
roster = read auto-mode/roster.json (gracefully skip if missing)
if roster:
  changed = false
  for r in roster.roster:
    if r.strategy_name != campaign.strategy: continue
    for cell in (r.cells or []):
      if cell.pair == campaign.pair and (cell.timeframe or r.timeframe) == campaign.timeframe:
        if cell.status != "retired":
          cell.status = "retired"
          cell.last_deactivated = now
          changed = true
    # Handle flat roster entries (no cells array)
    if not r.cells and r.pair == campaign.pair and r.timeframe == campaign.timeframe:
      if r.status != "retired":
        r.status = "retired"
        changed = true
  if changed:
    write auto-mode/roster.json
    sync_state_to_supabase(state_key="roster", ...)

Update TRADE.md on retirement:
  TRADE_MD="/workspace/group/strategies/${strategy_name}.trade.md"
  If TRADE_MD exists:
    Update lineage.graduation_status: "retired"
    trade-md lint $TRADE_MD
    # NO registry rebuild — retired strategies don't publish

aphexdata_record_event(verb_id="kata_retired", ...)
Post to feed: "Retired: {strategy} — {reason}"
```

**Evolution event logging (Step 5 only):**

When graduating or retiring a strategy, append an evolution event to
`knowledge/evolution-events.jsonl`. Each event is one JSON line:

GRADUATE → append:
```json
{"event_id":"evo_YYYY-MM-DD_<8hex>","resource_type":"strategy","resource_id":"<campaign_id>","operation":"commit","proposer":"monitor","timestamp":"<ISO8601>","committed_to":"graduated_slot","net_delta":"sharpe: <live_sharpe>, trades: <trade_count>"}
```

RETIRE → append:
```json
{"event_id":"evo_YYYY-MM-DD_<8hex>","resource_type":"strategy","resource_id":"<campaign_id>","operation":"rollback","proposer":"monitor","timestamp":"<ISO8601>","rollback_reason":"<trigger_code>","rolled_back_to":"<source_event_id_if_known>"}
```

Generate `event_id` as `evo_` + today's date + `_` + first 8 hex chars
of SHA-256 of `campaign_id + timestamp`. Use the retirement trigger
code (e.g., `trigger_A_catastrophic_dd`, `trigger_I_fast_fail`,
`ppp_gate_failure`) as `rollback_reason`.

**Live outcome logging (Step 4 retirements + Step 5 graduations):**

When a strategy is graduated or retired, append a structured outcome
entry to `knowledge/live-outcomes.jsonl`. This closes the backward
diagnostic loop to Discover — scout and strategyzer read these entries
to learn which cells produce real edge in live trading.

GRADUATE → append:
```json
{
  "ts": "<ISO8601>",
  "strategy": "<strategy_name>",
  "archetype": "<archetype>",
  "correlation_group": "<group>",
  "pair": "<pair>",
  "timeframe": "<timeframe>",
  "outcome": "graduated",
  "regime_at_deploy": "<regime from market-prior at campaign.deployed_at>",
  "regime_at_outcome": "<current regime from market-prior>",
  "days_deployed": "<(now - deployed_at).days>",
  "trade_count": "<current_trade_count>",
  "pnl_pct": "<current_pnl_pct>",
  "live_sharpe": "<current_sharpe>",
  "win_rate": "<current_win_rate * 100>",
  "divergence_pct": "<1 - (current_sharpe / wfo_sharpe)>",
  "execution_quality": "<campaign.paper_trading.execution_quality ?? null>",
  "dsr": "<campaign.wfo_metrics.dsr ?? null>",
  "pbo": "<campaign.wfo_metrics.pbo ?? null>",
  "source": "<kata_graduated | skip_kata_direct>",
  "candidate_quality": "<campaign.wfo_metrics.favorable_sharpe ?? null>",
  "obstacle_at_routing": "<campaign.paper_trading.investigation_reason ?? null>",
  "gap_score_at_discover": "<campaign.gap_score ?? null>",
  "regime_breakdown": "<campaign.paper_trading.by_regime ?? null>"
}
```

RETIRE → append:
```json
{
  "ts": "<ISO8601>",
  "strategy": "<strategy_name>",
  "archetype": "<archetype>",
  "correlation_group": "<group>",
  "pair": "<pair>",
  "timeframe": "<timeframe>",
  "outcome": "retired_<trigger_code>",
  "regime_at_deploy": "<regime from market-prior at campaign.deployed_at>",
  "regime_at_outcome": "<current regime from market-prior>",
  "days_deployed": "<(now - deployed_at).days>",
  "trade_count": "<current_trade_count>",
  "pnl_pct": "<current_pnl_pct>",
  "live_sharpe": "<current_sharpe>",
  "win_rate": "<current_win_rate * 100>",
  "divergence_pct": "<1 - (current_sharpe / wfo_sharpe) if wfo_sharpe else null>",
  "execution_quality": "<campaign.paper_trading.execution_quality ?? null>",
  "dsr": "<campaign.wfo_metrics.dsr ?? null>",
  "pbo": "<campaign.wfo_metrics.pbo ?? null>",
  "source": "<kata_graduated | skip_kata_direct | trial>",
  "candidate_quality": "<campaign.wfo_metrics.favorable_sharpe ?? null>",
  "obstacle_at_routing": "<campaign.paper_trading.investigation_reason ?? null>",
  "gap_score_at_discover": "<campaign.gap_score ?? null>",
  "regime_breakdown": "<campaign.paper_trading.by_regime ?? null>"
}
```

`outcome` values: `graduated`, `retired_trigger_A` through
`retired_trigger_J`, `retired_deadline`, `retired_pbo`,
`retired_dsr`, `retired_low_sharpe`, `retired_excessive_dd`,
`retired_low_win_rate`, `retired_insufficient_trades`.

`gap_score_at_discover` carries the scout gap_score at the time
this cell was selected for research. Over time, the correlation
between `gap_score_at_discover` and `outcome == "graduated"` measures
whether scout's scoring algorithm is accurate.

**Graceful degradation:** If the knowledge directory doesn't exist,
create it. If the write fails, log a warning and continue — live
outcome logging is non-blocking.

### Step 9: LOG + SYNC

**Slot summary output (Slot Management):**

Render a per-tick slot manifest grouped by `correlation_group`. Group
bots with `slot_state="graduated"` first, then `slot_state="trial"` —
this matches operator intuition (stable bots on top, probationary on
bottom). Include `eviction_priority` for trials so the next eviction
is always visible at a glance.

```
SLOTS: {total}/{cfg.max_total_bots} ({n_graduated}G + {n_trial}T, {empty} empty)
  trend:  BTC/1h TrendEMA      [G, Sharpe 0.62, DSR 2.41, PBO 0.18, ExQ 0.94, prio  -50]
          ETH/4h BreakoutDonch  [T, day 3/7,  6 trades, DSR 1.74, PBO 0.28, ExQ 0.78, prio  80]
  range:  XRP/15m MeanRevBB    [G, Sharpe 0.54, DSR 2.18, PBO 0.22, ExQ 0.88, prio    0]
          SUI/1h DonchRan       [T, day 5/7, 12 trades, DSR 1.74, PBO 0.27, ExQ 0.61, prio  70]  ← borderline
          SOL/1h MeanRevADX     [T, day 1/7,  0 trades, DSR  n/a, PBO  n/a, ExQ  n/a, prio 150]
  vol:    BTC/5m ScalpRSI      [G, Sharpe 0.71, DSR 2.85, PBO 0.11, ExQ 0.96, prio  -20]
  carry:  (empty — next candidate: CarryFunding SOL/4h)

  Trials expiring soon  : ETH/4h BreakoutDonch (4 days left)
  Eviction candidates   : SOL/1h MeanRevADX (0 trades, evict in 24h if no trades)
  Overfit watch         : ETH/4h BreakoutDonch (DSR 1.74 — needs more trades for 1.96)
  Execution watch       : SUI/1h DonchRan (ExQ 0.61, slippage 38% of P&L — near 0.60 gate)
  Next deployment       : CarryFunding SOL/4h (gap_score 12.4, qualifier ready)
```

Computation:
- Walk `campaigns` partitioned by `correlation_group`.
- Sort each group: `graduated` first, then `trial` ordered by deadline.
- DSR/PBO read from `campaign.wfo_metrics`. When the field is absent
  (legacy / pre-overfit-gates graduates) print `n/a` rather than zero.
- ExQ read from `campaign.paper_trading.execution_quality` (mirrored
  from `paper_pnl.execution.execution_quality` in Step 3). When the
  field is absent (legacy / no enriched trades / deployment lacks
  `volume_weight`) print `n/a` rather than zero.
- "Trials expiring soon" = trials with `(trial_deadline - now) <= 1 day`.
- "Eviction candidates" = bots with `eviction_priority >= 100` (top 3).
- "Overfit watch" = trials passing primary gates but with `dsr < 1.96`
  or `pbo > 0.30`. These are sitting in `dsr_extension` purgatory and
  surface here so the operator can see why they aren't graduating yet.
- "Execution watch" = bots with `execution_quality` set and either
  `< 0.65` (near the 0.60 graduation gate) or `slippage_as_pct_of_pnl > 0.35`
  (near the 0.50 warning line). Surfacing them early gives the operator
  a chance to investigate before Trigger J pauses signals.
- "Next deployment" = top of `rank_candidates()` from Step 6 that
  wasn't deployed this tick (group cap or verification cap reached).

Also emit a structured snapshot event so the dashboard can render the
same view without recomputing:

```
aphexdata_record_event(
  verb_id="slot_snapshot",
  verb_category="monitoring",
  object_type="report",
  object_id="slot_snapshot_<YYYY-MM-DD_HH-MM>",
  result_data={
    total: N, max_total: 10, graduated: G, trial: T, empty: E,
    by_group: {
      trend: [{strategy, pair, tf, slot_state, sharpe,
               eviction_priority, age_days, trades,
               wfo_metrics: {dsr, pbo, n_strategies_tried} | null,
               execution: {execution_quality,
                           slippage_as_pct_of_pnl} | null}],
      range: [...], vol: [...], carry: [...]
    },
    expiring_soon: [...],
    eviction_candidates: [...],
    overfit_watch: [{strategy, pair, tf, dsr, pbo,
                     reason: "low_dsr" | "high_pbo"}],
    execution_watch: [{strategy, pair, tf, execution_quality,
                       slippage_as_pct_of_pnl,
                       reason: "near_graduation_gate" | "near_pause_threshold"}],
    next_deployment: {...}
  }
)
```

**EVOLUTION ACTIVITY (after SLOTS table):**

Read `knowledge/evolution-events.jsonl`. Filter events from the last
24 hours. Group by `resource_type`, count `propose`, `commit`, and
`rollback` operations per type. Display a summary block:

```
EVOLUTION ACTIVITY (last 24h):
  Strategy kata:   {N} cycles  ({N} commits, {N} rollbacks)  {N}% commit rate
  Gate kata:       {N} cycles  ({N} commits, {N} rollbacks)  {N}% commit rate
  Portfolio kata:  {N} cycles
  Monitor:         {N} cycles  ({N} graduations, {N} evictions)
  Total:           {N} evolution events logged
```

If `evolution-events.jsonl` does not exist or is empty, skip this
section silently — do not display it on the first run before any
kata races have completed.

**Validate lap event (empirical loop cadence tracking):**

At the end of each tick, append a lap event to
`knowledge/evolution-events.jsonl` that records the tick as one
complete A→F cycle of the Validate loop. This enables measuring
per-stage loop velocity across the pipeline.

```json
{
  "event_id": "evo_YYYY-MM-DD_<8hex>",
  "resource_type": "validate_lap",
  "resource_id": "tick_<tick_count>",
  "operation": "assess",
  "proposer": "monitor",
  "timestamp": "<ISO8601>",
  "metrics": {
    "bots_checked": "<N>",
    "retirements": "<N>",
    "graduations": "<N>",
    "deployments": "<N>",
    "triggers_fired": ["trigger_A", "trigger_D"],
    "attribution_trades": "<N new trades attributed>",
    "portfolio_diagnosis_run": true,
    "verdict": "healthy|retirement|graduation|mixed"
  }
}
```

`verdict` classifies the tick's dominant action:
- `healthy` — no state transitions
- `retirement` — at least one retirement, no graduations
- `graduation` — at least one graduation
- `mixed` — both retirements and graduations in the same tick

**Standard tick log (existing):**

Write all state changes to aphexDATA:
```
aphexdata_record_event(
  verb_id="auto_mode_check",
  verb_category="monitoring",
  object_type="report",
  object_id="auto_mode_<YYYY-MM-DD_HH-MM>",
  result_data={
    "tick_count": N,
    "warmup": N, "proven": N, "published": N, "retired_this_tick": N,
    "transitions": [{campaign_id, from_state, to_state, reason}],
    "regime_refresh": true/false,
    "slots_filled": N,
    "slots_total": N, "slots_max": 10,
    "trials_evicted_this_tick": N, "trials_graduated_this_tick": N,
    "graduates_replaced_this_tick": N
  }
)
```

Sync ALL critical state files to Supabase:
  sync_state_to_supabase(state_key="campaigns", ...)
  sync_state_to_supabase(state_key="deployments", ...)
  sync_state_to_supabase(state_key="triage_matrix", ...)
  sync_state_to_supabase(state_key="roster", ...)
  sync_state_to_supabase(state_key="portfolio_correlation", ...)
  sync_state_to_supabase(state_key="kata_state", ...)
  sync_state_to_supabase(state_key="tv_signals", ...)        # if tv-signals.json exists
  sync_state_to_supabase(state_key="market_prior", ...)
  sync_state_to_supabase(state_key="regime_transitions", ...)

This serves as a backup mechanism — all institutional memory is
recoverable from Supabase if local files are lost.

**Tick completion stamp (MANDATORY — last write of the tick):**

```
deployments = read auto-mode/deployments.json
deployments._meta.last_tick = now ISO
deployments._meta.tick_count = tick_id   # from Step 0
deployments._meta.last_updated = now ISO
# Clear any previous failure since this tick succeeded
if deployments._meta.last_tick_failure:
  deployments._meta.last_tick_failure = null
write auto-mode/deployments.json

append to auto-mode/tick-log.jsonl:
  {"ts": now, "tick_id": tick_id, "step": 9, "phase": "tick_complete",
   "duration_sec": total_tick_elapsed}
```

If `last_tick` does not advance after a tick attempt, `tick_started_at`
will be newer than `last_tick` — this is the signal that the tick crashed.
The `last_tick_failure` field (written by the exception handler in Step 0)
contains the crash details.

**Message user only on state transitions:**
- Graduation, retirement, slot fill, correlation alert
- NOT routine metric updates

**Message format:**
```markdown
## Auto-Mode — [TIMESTAMP]

### State Changes
- AroonMacd_ADX on ETH/USDT 1h: WARM-UP → PROVEN
  Reason: Sharpe 0.62, 12 trades, 7 days validated

### Paper Bots (N)
| Strategy | Pair | TF | State | Sharpe | P&L |
|----------|------|----|-------|--------|-----|
| AroonMacd_ADX | ETH/USDT | 1h | PROVEN | 0.62 | +2.1% |
| WolfClaw_BOS | ARB/USDT | 4h | WARM-UP | 0.31 | +0.4% |
```

**Daily Summary (last check of the day — 23:47 UTC tick):**

If `total_misses > 0` in missed-opportunities.json:
- Count missed opportunities today
- Top 5 cells by frequency and score
- Archetypes with zero staged strategies
- Log to aphexDATA and message user


**Competition Benchmark + Daily Rollup:**
Competition scorecard, experiment ledger review, and daily briefing are
handled by `monitor-portfolio` (runs daily at 00:00 UTC). See
`skills/monitor-portfolio/SKILL.md` for the full procedure.

For each state transition, also log individually:
```
aphexdata_record_event(
  verb_id="kata_graduated" | "kata_retired" | "kata_retired_early",
  verb_category="execution",
  object_type="campaign",
  object_id=<campaign_id>,
  result_data={
    "strategy": "...", "pair": "...", "timeframe": "...",
    "from_state": "paper_trading", "to_state": "graduated",
    "sharpe": 0.62, "reason": "validation_passed"
  }
)
```

---

## Strategy-to-Archetype Matching

Strategies are matched to archetypes via header comment tags in `.py` files:

```python
# ARCHETYPE: TREND_MOMENTUM
# GRADUATED: 2026-03-20
# WALK_FORWARD_DEGRADATION: 18%
# VALIDATED_PAIRS: BTC/USDT, ETH/USDT
class EMA_Crossover_v3(IStrategy):
    ...
```

Scan first 10 lines of each `.py` in `/workspace/group/user_data/strategies/`.

**Kata graduation convention:** When a strategy graduates from kata-bridge, the
graduation step should add these header tags. This links the Research → Operations
handoff.

**Fallback** if no tags: query `aphexdata_query_events(verb_id="attested", object_type="strategy")`
for strategy metadata including archetype classification.

---

## Stale Data Protection

Check the `last_scored` timestamp in `cell-grid-latest.json`, or the file modification
time via `stat`.

If cell-grid is **> 8 hours old**:
- **Block** upward transitions (no graduations based on stale composite)
- **Continue** downward transitions (safe direction: retire)
- **Skip** slot filling (stale scores cannot justify new deployments)
- **Alert** user: "Market-timing scores stale (last: Xh ago). Slot filling paused. Run a scoring cycle to refresh."

---

## State File Schemas

All files at `/workspace/group/auto-mode/`. Create the directory if it doesn't exist:
```bash
mkdir -p /workspace/group/auto-mode
```

### roster.json (Pre-Staged Deployments)

```json
{
  "version": 1,
  "staged_at": "2026-03-26T14:00:00Z",
  "roster": [
    {
      "strategy_name": "AroonMacd_ADX",
      "strategy_path": "/workspace/group/user_data/strategies/AroonMacd_ADX.py",
      "archetype": "TREND_MOMENTUM",
      "validated_pairs": ["ETH/USDT:USDT", "BTC/USDT:USDT"],
      "timeframe": "1h",
      "base_stake_pct": 5,
      "wf_degradation_pct": 18,
      "wf_sharpe": 0.87,
      "graduated_at": "2026-03-26",
      "cells": [
        {
          "pair": "ETH/USDT:USDT",
          "timeframe": "1h",
          "config_path": "/workspace/group/auto-mode/configs/AroonMacd_ADX_ETH_1h.json",
          "status": "staged",
          "last_activated": null,
          "last_deactivated": null,
          "activation_count": 0
        }
      ]
    }
  ],
  "last_updated": "2026-03-26T14:00:00Z"
}
```

### configs/ directory (Pre-Generated FreqTrade Configs)

Each file is a complete, launch-ready FreqTrade config fragment at
`/workspace/group/auto-mode/configs/{strategy}_{pair}_{tf}.json`:

```json
{
  "strategy": "AroonMacd_ADX",
  "trading_mode": "futures",
  "margin_mode": "isolated",
  "stake_currency": "USDT",
  "dry_run": true,
  "dry_run_wallet": 1000,
  "db_url": "sqlite:////freqtrade/user_data/data/tradesv3.dryrun.sqlite",
  "exchange": {
    "name": "binance",              // read from instance-config.json (default: "binance")
    "pair_whitelist": ["ETH/USDT:USDT"]  // format pair using pair_suffix from instance-config.json
  },
  "timeframe": "1h",
  "entry_pricing": {"price_side": "other"},
  "exit_pricing": {"price_side": "other"}
}
```

All paper bots use `dry_run: true` with flat `dry_run_wallet: 1000`.
`db_url` points to the bind-mounted data directory so trade history
survives container recreation.

### campaigns.json (in research-planner directory)

Campaigns are the source of truth for paper bot state. Located at
`/workspace/group/research-planner/campaigns.json`. Auto-mode reads
and writes `campaign.state` and `campaign.paper_trading` fields.

**campaign.paper_trading fields** (managed by monitor):
```json
{
  "bot_deployment_id": "dep_xrp_wolfclaw_1h",
  "deployed_at": "2026-04-02T10:00:00Z",
  "validation_period_days": 7,
  "validation_deadline": "2026-04-09T10:00:00Z",
  "current_pnl_pct": 0.0,
  "current_trade_count": 0,
  "current_sharpe": 0.0,
  "current_max_dd": 0.0,
  "retire_reason": null,
  "ticks_signals_on": 0,
  "ticks_signals_off": 0,
  "expected_trades_in_validation": 12,
  "trades_per_day_estimate": 1.7,
  "feasibility_warning": false,
  "extended": false,
  "regime_extension": false,
  "current_win_rate": 0.0,
  "current_avg_win_pct": 0.0,
  "current_avg_loss_pct": 0.0,
  "max_consecutive_losses": 0,
  "investigation_mode": false,
  "investigation_reason": null,
  "rr_extension": false
}
```

- `ticks_signals_on/off`: incremented by Step 2 each health check. Used by Step 5 Case 3.
- `expected_trades_in_validation`: estimated at deploy time from WF trade counts.
- `feasibility_warning`: true if expected_trades < min_trades at deploy time, OR if inactive detection fires (48h/72h warning).
- `extended`: true if validation was extended 50% (Case 2). Only once.
- `regime_extension`: true if zero-trade bot got full extension due to regime-blocking (Case 3). Only once.
- `current_win_rate`: updated each tick from FreqTrade. Used by Step 4 Triggers D/E and Step 5 quality gates.
- `current_avg_win_pct`: average profit per winning trade. Used for R:R checks.
- `current_avg_loss_pct`: average loss per losing trade (positive number). Used for R:R checks.
- `max_consecutive_losses`: longest streak of consecutive losing trades. Used by Step 5 quality gates.
- `investigation_mode`: true if Trigger E (R:R inversion) fired. Signals are paused. Step 2 skips signal toggling.
- `investigation_reason`: the specific reason for investigation (e.g. `"risk_reward_inversion"`).
- `rr_extension`: true if validation was extended because R:R inversion was detected at graduation (Step 5). Only once.

### market-prior.json

```json
{
  "version": 1,
  "tick_count": 47,
  "last_refresh": "2026-03-25T18:00:00Z",
  "regimes": {
    "BTC": {
      "H2_SHORT": {"regime": "EFFICIENT_TREND", "conviction": 72, "direction": "BULLISH", "fetched_at": "..."},
      "H3_MEDIUM": {"regime": "EFFICIENT_TREND", "conviction": 65, "direction": "BULLISH", "fetched_at": "..."}
    }
  },
  "previous_composites": {
    "BTC/USDT_TREND_MOMENTUM_1h": 3.2,
    "ETH/USDT_TREND_MOMENTUM_1h": 2.6
  },
  "signal_hysteresis": {
    "dep_eth_trend_1h": {"consecutive_below": 1, "signals_active": true}
  }
}
```

### config.json (optional user overrides)

```json
{
  "deploy_threshold": 3.5,
  "signal_off_consecutive_ticks": 2,
  "silent_when_no_changes": true,
  "dry_run": false,
  "paper_trading": {
    "max_paper_bots": 20,
    "auto_deploy_triage_winners": true
  },
  "graduation": {
    "signal_publishing_sharpe": 0.8
  }
}
```

If this file doesn't exist, use defaults.

---

## Quick Command Table

### Deployment Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Deploy paper bot {strategy} {pair} {tf}" | Start dry-run container, create campaign |
| "Retire {strategy} {pair}" | Stop container, campaign.state → retired |
| "Send to research {strategy_name}" | Retire + auto-route to kata-bridge with obstacle context (competition: immediate; normal: recommend) |

### Roster & Staging Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Stage all graduated strategies" | Scan strategy library, populate roster.json, generate configs/ |
| "Show roster" | List all staged deployments with status per cell |

### Monitoring Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Show auto-mode status" | Read all state files, display bot table with states, scores, P&L |
| "Run auto-mode check now" | Execute the full 9-step check immediately |
| "Show portfolio health" | Display portfolio correlation, strategy count, Sharpe estimate |
| "Show research priorities" | Query missed_opportunity_daily_summary from last 7 days. Rank cells by frequency × avg_composite. |

### System Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Set threshold deploy=4.0" | Update config.json with new threshold value |
| "Disable auto-mode" | `pause_task` for all: `monitor_health_check`, `monitor_deploy`, `monitor_kata`, `monitor_portfolio` |
| "Enable auto-mode" | `resume_task` for all: `monitor_health_check`, `monitor_deploy`, `monitor_kata`, `monitor_portfolio` |
| "EMERGENCY STOP" | Stop ALL bots, pause scheduler, retire all campaigns |
| "Set auto-mode to dry run" | All checks run but no freqtrade actions |

---

## Handoffs Between Modes

### Monitor → Research (Kata)

When a deployed strategy underperforms and is retired:
```
"{strategy_name} has been retired. Sharpe {s} below threshold after {days} days.
Recommend sending back to Research with hypothesis: {archetype} needs
improvement for current market conditions."

User can say: "Improve {strategy_name}" → kata-bridge takes over.
```

### Research → Monitor

When kata graduates a strategy:
1. Graduation step adds header tags (`ARCHETYPE`, `GRADUATED`, `VALIDATED_PAIRS`, etc.)
2. Run "Stage all graduated strategies" to pre-generate configs
3. Strategy is now in the roster, ready for instant activation

```
"{strategy_name} graduated with WF Sharpe {s}, degradation {d}%. Staged for
{pair} {tf}. Auto-mode will deploy when triage winners fill slots."
```

### Auto-Mode → Analysis Skills

When monitoring needs context (during hourly regime refresh):
- Read latest `macro-latest.json` if available (from macro-sentiment skill)
- Read latest `onchain-latest.json` if available (from onchain-intel skill)
- Read latest `sentiment-latest.json` if available (from ct-sentiment skill)
- Factor into regime assessment but do NOT run these scans — they have their own schedules

---

## AphexDATA Event Conventions

| verb_id | verb_category | object_type | When |
|---------|--------------|-------------|------|
| `auto_mode_check` | monitoring | report | Every 15-min check |
| `deployment_activated` | execution | campaign | Paper bot deployed |
| `kata_graduated` | execution | campaign | Warm-up → Proven |
| `kata_retired` | execution | campaign | Validation failed → Retired |
| `kata_retired_early` | execution | campaign | Early retirement triggered |
| `signal_published` | execution | campaign | Proven → Published (live Sharpe >= 0.8) |
| `emergency_stop` | risk | portfolio | EMERGENCY STOP executed |
| `integrity_violation` | security | state_file | State file checksum mismatch |
| `dry_run_toggled` | config | system | Dry-run mode toggled |
| `roster_staged` | execution | roster | Graduated strategies staged |
| `missed_opportunity` | analysis | cell | High-scoring cell with no staged strategy |
| `missed_opportunity_daily_summary` | analysis | report | End-of-day missed opportunities |
| `orphan_detected` | monitoring | deployment | Bot running without matching campaign |
| `orphan_auto_retired` | execution | deployment | Orphan bot auto-retired after 48h |
| `slot_filled` | execution | campaign | Triage winner auto-deployed |
| `correlation_alert` | analysis | portfolio | Avg correlation > 0.30 |

---

## Scheduled Execution

The monitor pipeline runs as 4 scheduled tasks:

```
# Health check (every 15 min — this skill)
schedule_task(
  name: "monitor_health_check",
  schedule: "*/15 * * * *",
  context_mode: "isolated",
  prompt: "Run a monitor health check. Use the monitor-health skill: tick init, read state, refresh regimes, update metrics, check retirements (Triggers A-J), check graduations, log and sync. Message user only on state changes."
)

# Deployment allocation (every 30 min — monitor-deploy)
schedule_task(
  name: "monitor_deploy",
  schedule: "7,37 * * * *",
  context_mode: "isolated",
  prompt: "Run monitor deployment check. Use the monitor-deploy skill: count slots, gather candidates, rank, verify with backtests (max 3), deploy as trials. Skip if slots full or cell-grid stale."
)

# Kata worker check (hourly — monitor-kata)
schedule_task(
  name: "monitor_kata",
  schedule: "20 * * * *",
  context_mode: "isolated",
  prompt: "Run monitor kata check. Use the monitor-kata skill: check for completed kata races, run walk-forward validation, deploy if promising. Skip if no active races."
)

# Portfolio analysis (daily at 00:00 — monitor-portfolio)
schedule_task(
  name: "monitor_portfolio",
  schedule: "0 0 * * *",
  context_mode: "isolated",
  prompt: "Run monitor portfolio analysis. Use the monitor-portfolio skill: compute portfolio correlation, regime transitions (Sunday), tail risk CVaR, portfolio diagnosis, competition benchmark, experiment ledger review, daily briefing."
)
```
---

## Anti-Patterns

1. **REGIME CHURN**: Don't toggle signals on single-check score changes.
   Use hysteresis (2 consecutive ticks below threshold before turning off).

2. **MODIFYING STRATEGIES**: Auto-Mode NEVER changes strategy code. Retire and
   recommend Research mode instead.

3. **OVER-REPORTING**: Don't message every 15 minutes. Report on state changes
   and significant events only. Silent when nothing changed.

4. **IGNORING CORRELATION**: Don't run 3 trend-following strategies on correlated
   assets. Portfolio correlation checks exist for a reason.

5. **ASSEMBLING AT DEPLOY TIME**: Don't generate configs, copy files, or edit
   settings when filling a slot. Pre-stage everything at graduation time.
   Deployment should be flipping a switch, not building a switch.

6. **FALSE CONFIDENCE**: A high composite doesn't mean profit. It means conditions
   are aligned. The score gates whether to send signals, not whether to guarantee returns.

---

## Feed Integration

After each health check that produces a STATE CHANGE (not silent ticks):
```
agent_post_status(
  status: "{strategy} {old_state} → {new_state} — {reason}",
  tags: ["auto_mode", "deployment"],
  context: { pair, archetype, composite, sharpe }
)
```

After logging missed opportunities with new high-priority gaps:
```
agent_post_status(
  status: "{count} missed opportunities — top gap: {archetype} {pair} {tf} (composite {score})",
  tags: ["auto_mode", "finding"],
  context: { top_gap_archetype, top_gap_pair, top_gap_composite }
)
```

Do NOT post on silent/clean ticks. Only post when something changed
or something noteworthy was detected.

---

## Idle-Time Triage Trigger

After completing all health check steps,
check whether to run a triage cycle:

**PREREQUISITES** (all must be true):
- This health check was ROUTINE (no deployment state changes,
  no paper bot graduations/retirements)
- No triage cycle has run in the last 3 minutes
  (check triage-matrix.json last_cycle timestamp)
- Next scheduled task is > 5 minutes away
- Agent is in a task container (NOT a message container)

If all prerequisites met:
  Run ONE triage cycle per strategyzer SKILL.md Part 3C.
  This takes 30 seconds for a normal Result B/C, or up to
  3 minutes if a Result A triggers immediate walk-forward.
  If the triage produces a winner with favorable_sharpe >= 0.5
  AND paper bot slots are available, the triage cycle itself
  deploys the paper bot.

If any prerequisite fails:
  Skip triage, go idle normally.

**IMPORTANT**: Do NOT run triage on health checks that produced
state changes (graduations, retirements, slot fills).
Those checks are already information-dense and the session
should close cleanly without adding a backtest.

---

## Phase 7: Continuous Triage (after routine health check)

Prerequisites: health check was routine (no state changes made),
next scheduled task > 5 min away.

1. Read /workspace/group/research-planner/triage-matrix.json
   - If missing, initialize with empty queue and results
   - If queue is empty, replenish from archetypes.yaml coverage gaps
     (prioritize correlation groups with zero graduated strategies)

2. Pop next untested strategy+pair from queue

3. Backtest single recent window (~30 sec via freqtrade-mcp):
   ```
   freqtrade_backtest({
     strategy: "<strategy>",
     pairs: ["<pair>"],
     timeframe: "<timeframe>",
     timerange: "<last-4-months>"
   })
   ```

4. Classify result:
   - A (Sharpe >= 0.5): worth full walk-forward — add to winners
   - B (0 < Sharpe < 0.5): marginal — log, skip
   - C (Sharpe <= 0): discard

5. Update triage-matrix.json with result entry:
   ```json
   {
     "strategy": "<name>",
     "pair": "<pair>",
     "timeframe": "<tf>",
     "archetype": "<archetype>",
     "correlation_group": "<group>",
     "tested_at": "<now>",
     "result": "A|B|C",
     "single_window_sharpe": 0.0,
     "favorable_sharpe": null,
     "deployed_as_paper": false
   }
   ```

6. Report: "Triage: {strategy} on {pair} → {result} (sharpe {n})"

For A-results with auto_deploy_triage_winners enabled:
  - Run full 4-window walk-forward
  - Compute favorable_sharpe
  - If >= 0.5: deploy paper bot, set deployed_as_paper = true
  - Update favorable_sharpe in triage-matrix.json

### Validation Period Reference Table

| Timeframe | Days | Min Trades | Rationale |
|-----------|------|------------|-----------|
| 5m        | 1-2  | 40-100     | High-frequency, enough data in hours |
| 15m       | 2-3  | 15-50      | Intraday, 3 days covers multiple cycles |
| 1h        | 5-14 | 5-15       | Standard swing, full week of market |
| 4h        | 14-21| 5-10       | Multi-day holds, need 2 weeks |
| 1d        | 30   | 3-5        | Position trading, full month minimum |

Exact values per archetype are in archetypes.yaml paper_validation section.

---

## Timeframe-Aligned Regime Refresh

Replace the monolithic 4h market-timing refresh with layered
refresh aligned to each timeframe's natural cadence.

### Refresh Schedule

  Every monitor tick (15 min):
    Refresh 5m + 15m cells → write reports/cell-grid-5m-15m.json
    These are the fast-validation timeframes. Fresh regime data
    means scout scores them with current conditions.

  Every 1 hour (on the hour):
    Refresh 1h cells → write reports/cell-grid-1h.json

  Every 4 hours (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC):
    Refresh 4h cells → write reports/cell-grid-4h.json

### Implementation

  The existing market-timing skill handles the actual orderflow
  API calls and regime classification. Monitor just controls
  WHEN it runs and for WHICH timeframes.

  On each monitor tick:
    current_minute = now.minute
    current_hour = now.hour

    ALWAYS: refresh 5m + 15m cells
    IF current_minute < 15: also refresh 1h cells
    IF current_hour % 4 == 0 AND current_minute < 15: also refresh 4h cells

  Also write reports/cell-grid-latest.json as a merged view of
  all timeframe files (backward compatibility for any code
  reading the old single-file format).

### Staleness Tracking

  Each cell-grid file includes "refreshed_at" timestamp.
  Scout checks staleness:
    5m/15m data > 30 min old → stale warning
    1h data > 2 hours old → stale warning
    4h data > 8 hours old → stale warning

---

## Pipeline Integration (Scout → Strategyzer → Kata)

During each monitor tick, after existing health checks:

### 1. Run Scout (every tick, < 5 seconds)

  If paper bot slots available (active < max_paper_bots):

    Trigger scout to refresh reports/gap-report.json.
    Read the top gap.

    a) Gap has a triage qualifier AND no active kata race:
       → Trigger kata-bridge (single candidate mode)
       "Qualifier exists — sending to kata."

    b) Gap has no qualifier AND gap_score > 8.0 AND persistent > 3:
       → Trigger strategyzer to explore options.
       "High-priority gap — starting strategyzer."

    c) Gap below threshold:
       → Log only.

    Only ONE pipeline action per tick. Don't flood.

### 2. Check Kata Race Status (every tick)

  If kata-state.json shows active races:
    Read each race's kata-state.json for progress.
    Early winner (favorable_sharpe >= 0.5)? Import and deploy.
    All complete? Pick winner, import, deploy.

### 3. Deploy Pending Campaigns (every tick)

  Read auto-mode/deployments.json for state == "pending_deploy":
    Deploy paper bot.
    Update: state → "paper_trading", set deadline.

### 4. Pipeline Summary (in health check output)

  PIPELINE:
    Scout: top gap = {archetype} {pair}/{tf} (score {s})
    Strategyzer: {idle | running | last: {result}}
    Kata: {idle | racing {n} candidates | winner: {name}}
    Pending deploys: {count}
    Regime refresh: 5m/15m {age}m ago, 1h {age}m ago, 4h {age}m ago

---

## Extended Dependencies

| Skill | Purpose |
|-------|---------|
| `scout` | Gap scanning (reads/triggers gap-report.json) |
| `strategyzer` | Strategy generation pipeline (triggered for top gaps) |
| `kata-bridge` | Race management (monitors kata optimization runs) |

Note: State files remain under `auto-mode/` for backward compatibility.
The skill directory was renamed from `auto-mode` to `monitor` but the
state directory path is unchanged.

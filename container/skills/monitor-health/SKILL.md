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
| `season.json` | `season` |

---

## Pre-Staged Deployment Roster

Pre-stage deployments at graduation time so activation is instant (< 30s). Scan strategy `.py` header tags (`ARCHETYPE`, `GRADUATED`, `VALIDATED_PAIRS`, `WF_SHARPE`) and generate complete FreqTrade config fragments to `auto-mode/configs/{strategy}_{pair}_{tf}.json`. Roster entry schema: see `docs/state-contract.md`. Cell status: `staged` -> `paper_trading` -> `graduated` -> `retired`.

**Activation**: Read pre-generated config, `bot_start()` with signals OFF, update roster + campaigns, emit `deployment_activated`. **Deactivation**: `bot_toggle_signals(false)` or `bot_stop()`, revert roster cell to `staged`.

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
After computing posteriors, build `regime-intel.json` from shadow log + current regime state. Read `knowledge/regime-shadow-log.jsonl`, compute per-pair 7-day rolling agreement rates, and 5 promotion criteria: `agreement_above_threshold` (>0.70), `hmm_converging_all_pairs`, `no_sustained_disagreement`, `min_shadow_entries` (>=100), `bocpd_validation`. Write regime-intel.json with per-pair details and `sync_state_to_supabase(state_key="regime_intel")`.

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

Effect: signals only fire after 30-60 min of confirmed favorable regime (2-4 ticks).

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

For each bot with `slot_state in {"trial", "graduated"}`, fetch `bot_trades`, find newly closed trades since `last_attribution_ts`, and append enriched entries to `knowledge/live-attribution.jsonl`. Each entry includes: regime_at_entry/exit, gate_state_at_entry (composite, signals_active, regime_fit, change_prob), pnl_pct, slippage, execution_quality. Non-blocking — never blocks the tick. After writing, update 30-day rolling aggregates in `live-attribution-rollup.json`. See `skills/attribution/SKILL.md` for full schema.

**Eviction priority computation (Slot Management):**

Stamp `eviction_priority` + `eviction_factors[]` on every campaign with `slot_state in {"trial","graduated"}`. Uses weights from `cfg.SLOT_MANAGEMENT.eviction_weights`:

- **Trial**: base=`trial_base`, bonuses for dead_bot (0 trades+24h), low_win_rate (<0.25@5), high_divergence (>0.50), expired (per day). Protections: promising (WR>0.45), near_graduation (4+ gates met).
- **Graduated**: base=`graduated_base`, penalties for degrading_win_rate (<0.30), degrading_divergence (>0.50), anti_regime, regime_fault_paused. Protections: diversity (only bot in group), strong_performer (Sharpe>0.8), tenure (>30d).

Drives Trigger H/I (Step 4) and Step 6 (slot allocation). `sync_state_to_supabase(state_key="campaigns", ...)`

**TV Signal Source Tracking (if tv-signals.json exists and is non-empty):**

Match closed trades on `tv-manual` bot to TV signal sources via `order_tag` prefix `tv_{source_id}_`. Update per-source stats (trade_count, win_rate, pnl_pct). Flag sources with 10+ trades and WR < 25%. Check for timed-out trades (> `auto_close_timeout_hours`). Update `tv-signal-log.jsonl` outcomes for newly closed trades. Emit `tv_trade_closed` events. Sync to Supabase.

### Step 4: EARLY RETIREMENT CHECK

**Portfolio-level drawdown response (every tick):**

Read `cfg.CIRCUIT_BREAKER`. Three tiers based on `portfolio.max_drawdown_pct`:
- **Tier 1** (>= `dd_alert_pct`): Alert user
- **Tier 2** (>= `dd_pause_pct`): Pause highest-eviction-priority trial. No auto-resume.
- **Tier 3** (>= `dd_flat_pct`): Circuit breaker (see Emergency Stop)
- **Alpha flag**: Competition mode + alpha negative for `negative_alpha_flag_hours` -> flag only.

For each **warm-up bot only** (proven bots earned their slot):

**Trigger Reference** (thresholds from `cfg.RETIREMENT_GATES`, `cfg.SLOT_MANAGEMENT`, `cfg.EXECUTION_GATES`):

| Trigger | Condition | Action | Reason |
|---------|-----------|--------|--------|
| **A** Catastrophic DD | `abs(max_dd) > archetype.max_dd * dd_multiplier` (1.5x standard, 1.0x high-regime-dep) | **Retire** | `drawdown_exceeded` |
| **B** Dead container | `consecutive_container_down >= cfg.dead_container_consecutive_checks` | **Retire** | `container_failed` |
| **C** Negative edge | trades >= 5, last 5 ALL losses, cumulative > 5% | **Retire** | `consecutive_losses` |
| **D** Win rate floor | trades >= 5, `win_rate < floor` (0.25 high-WR, 0.20 low-WR archetypes) | **Retire**, kata obstacle `win_rate` | `win_rate_floor` |
| **E** R:R inversion | trades >= 5, WR > 0.45, PnL < -1.0, `avg_loss > avg_win * 1.5` | **Pause** signals, investigation_mode | `risk_reward_inversion` |
| **F** Degrading | trades >= 8, (WR in degrading band OR divergence >= 0.30 OR anti-regime drift) | **Route to kata** (pause only if divergence >= 0.70) | obstacle varies |
| **G** Regime collapse | `by_regime[anti].n_trades >= 5 AND win_rate < 15%` OR any regime 10+ trades < 10% WR | **Pause**, route to kata | `regime_conditional_collapse` |
| **J** Execution collapse | `execution_quality < cfg.pause_threshold`, trades >= min | **Pause** (venue problem) | `execution_drag` |
| **H** Trial deadline | `now >= trial_deadline` -> evaluate 6 graduation gates | **Graduate** all met / **Retire** any fail | `trial_deadline_expired` |
| **I** Trial early evict | 0 trades@48h, <=1@72h, WR<0.20@5, divergence>=0.70, PnL<=-5% | **Retire** | `early_eviction:*` |

**E details**: Entries work, exits broken. Set `investigation_mode=true`, `investigation_reason="risk_reward_inversion"`, route to kata obstacle `risk_reward_ratio`.

**F details**: Classify obstacle: high WR + losing -> `risk_reward_ratio`, divergence -> `overfit_decay`, anti-regime -> `regime_dependent`, else -> `entry_quality`. Severity: divergence [0.30, 0.70) -> kata only; >= 0.70 -> pause + kata (`severe_divergence`). Hard triggers (A-D) supersede degrading.

**G details**: Read `paper_pnl.by_regime`. Catches anti-regime bleeding faster than Trigger D. Sets `regime_fault`, `regime_metrics` for kata. Three conditions: anti+5trades+15%WR, anti+8trades+-2%PnL, any+10trades+10%WR.

**H details**: Uses `evaluate_graduation_gates()` (6 gates: min_trades, min_win_rate, min_favorable_sharpe, min_risk_reward_ratio, max_consecutive_losses, max_divergence). Runs AFTER Triggers A-G.

**J details**: Skip if disabled, unset, low trades, or already paused. `slippage_as_pct_of_pnl > slippage_pnl_ratio_max` -> warning only. Pause-not-retire: strategy fine, venue wrong.

**NOT triggers**: Zero trades before deadline (Step 3 warns, Step 5 decides), low Sharpe before deadline (noisy at small N), regime-blocked signals (working correctly), moderate P&L loss.

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

  **Overfitting gate (runs after primary + quality gates):**

  Uses `cfg = config.OVERFITTING_GATES`. Skip if `cfg.enabled == false`.
  Reads `campaign.wfo_metrics` (dsr, pbo, n_strategies_tried) — computed by kata at graduation time.
  If wfo_metrics missing: record gate as `met: null`, continue to GRADUATE (legacy compat).
  Stamp `campaign.graduation_gates["dsr"]` and `["pbo"]` with `{required, actual, met}`.

  Decision tree:
  - `pbo > cfg.pbo_evict` → **RETIRE** reason `"overfit_pbo_above_evict"`, blacklist cell
  - `trade_count < cfg.min_trades_for_dsr` → skip enforcement, continue to GRADUATE
  - `dsr < cfg.dsr_threshold` → extend validation once (`dsr_extension` flag, +50% of validation period), skip graduation. If already extended: **RETIRE** `"low_dsr_after_extension"`
  - `pbo > cfg.pbo_max` → same extension logic. If already extended: **RETIRE** `"high_pbo_after_extension"`
  - All pass → continue to execution gate

  **Execution realism gate (runs after overfit gate):**

  Uses `cfg = config.EXECUTION_GATES`. Skip if `cfg.enabled == false`.
  Reads `campaign.paper_trading.execution_quality` — measures whether Sharpe survives trading costs.
  If execution_quality missing or `trade_count < cfg.min_trades_for_gate`: record `met: null`, continue to GRADUATE.
  Stamp `campaign.graduation_gates["execution_quality"]` with `{required, actual, met}`.
  If `exq < cfg.min_execution_quality` → skip graduation (Trigger J handles pause if exq drops further).
  Else → continue to GRADUATE.

  Early-graduation at Step 5 top calls `evaluate_graduation_gates()` — overfit + execution gates are absorbed by the `all(g.met for g in gates)` check automatically.

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

Append to `knowledge/evolution-events.jsonl`:
- GRADUATE: `{operation: "commit", committed_to: "graduated_slot", net_delta: "sharpe: X, trades: N"}`
- RETIRE: `{operation: "rollback", rollback_reason: "<trigger_code>"}`
- `event_id` = `evo_` + date + `_` + first 8 hex of SHA-256(campaign_id + timestamp).

**Live outcome logging (Step 4 retirements + Step 5 graduations):**

Append to `knowledge/live-outcomes.jsonl`. Fields: `ts`, `strategy`, `archetype`,
`correlation_group`, `pair`, `timeframe`, `outcome` (graduated | retired_trigger_X),
`regime_at_deploy/outcome`, `days_deployed`, `trade_count`, `pnl_pct`, `live_sharpe`,
`win_rate`, `divergence_pct`, `execution_quality`, `dsr`, `pbo`, `source`,
`candidate_quality`, `obstacle_at_routing`, `gap_score_at_discover`, `regime_breakdown`.

Non-blocking: create knowledge dir if missing, log warning on write failure.

### Step 9: LOG + SYNC

**Slot summary output (Slot Management):**

Render a per-tick slot manifest grouped by `correlation_group`:
- Graduated first, then trials (ordered by deadline).
- Each line: `[G/T, Sharpe, DSR, PBO, ExQ, eviction_priority]`. Print `n/a` for absent wfo_metrics/execution fields.
- Footer sections: "Trials expiring soon" (deadline ≤ 1 day), "Eviction candidates" (priority ≥ 100, top 3), "Overfit watch" (DSR < 1.96 or PBO > 0.30), "Execution watch" (ExQ < 0.65 or slippage > 35%), "Next deployment" (top undeployed candidate).

Emit `aphexdata_record_event(verb_id="slot_snapshot", ...)` with `by_group`, `expiring_soon`, `eviction_candidates`, `overfit_watch`, `execution_watch`.

**EVOLUTION ACTIVITY (after SLOTS table):**

Read last 24h from `knowledge/evolution-events.jsonl`, group by resource_type,
display commit/rollback counts. Skip silently if file missing/empty.

**Validate lap event:** Append to `evolution-events.jsonl` at tick end:
`{resource_type: "validate_lap", resource_id: "tick_N", operation: "assess",
metrics: {bots_checked, retirements, graduations, triggers_fired[], verdict}}`
Verdict: `healthy` | `retirement` | `graduation` | `mixed`.

**Standard tick log:** Emit `auto_mode_check` event with tick_count,
warmup/proven/published/retired counts, transitions[], slots_filled.

**Sync ALL state files:** campaigns, deployments, triage_matrix, roster,
portfolio_correlation, kata_state, tv_signals, market_prior, regime_transitions, season.

**Tick completion stamp (MANDATORY):** Write `deployments._meta.last_tick = now`,
clear `last_tick_failure`. Append tick_complete to `tick-log.jsonl`.
If `tick_started_at > last_tick` → tick crashed (failure details in `last_tick_failure`).

**Message user only on state transitions** (graduation, retirement, slot fill).
Include state changes table + paper bots summary. Competition rollup handled by `monitor-portfolio`.

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

All schemas are defined in `docs/state-contract.md`. Key files at `/workspace/group/auto-mode/`:

- **roster.json** — Pre-staged deployments. Each entry: strategy_name, archetype, validated_pairs, timeframe, wf_sharpe, cells[]. Cell status: `staged`→`paper_trading`→`graduated`→`retired`.
- **configs/{strategy}_{pair}_{tf}.json** — Launch-ready FreqTrade config fragments. All use `dry_run: true`, `dry_run_wallet: 1000`.
- **campaigns.json** (at `research-planner/`) — Source of truth for paper bot state. Monitor reads/writes `campaign.state` and `campaign.paper_trading.*` fields.
- **market-prior.json** — Regime data: `regimes[symbol][horizon]`, `previous_composites`, `signal_hysteresis`, `transition` (v2 BOCPD data).
- **config.json** — Optional user overrides (deploy_threshold, dry_run, etc.). Defaults from `scoring-config.json`.
- **deployments.json** — Authoritative slot state. `_meta.last_tick`, `_meta.tick_count` track tick health.

Key `campaign.paper_trading` fields: `bot_deployment_id`, `deployed_at`, `validation_deadline`, `current_pnl_pct`, `current_trade_count`, `current_sharpe`, `current_max_dd`, `current_win_rate`, `current_avg_win_pct`, `current_avg_loss_pct`, `max_consecutive_losses`, `ticks_signals_on/off`, `investigation_mode`, `investigation_reason`, `extended`, `regime_extension`, `rr_extension`, `feasibility_warning`, `execution_quality`, `slippage_as_pct_of_pnl`, `divergence_pct`, `eviction_priority`, `eviction_factors[]`.

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

- **Monitor → Kata**: On retirement, recommend "Improve {strategy}" for kata-bridge.
- **Kata → Monitor**: Graduation adds header tags → "Stage all graduated" → roster ready.
- **Monitor reads** (does NOT run): `macro-latest.json`, `onchain-latest.json`, `sentiment-latest.json`.

---

## AphexDATA Event Conventions

Key verb_ids: `auto_mode_check`, `deployment_activated`, `kata_graduated`,
`kata_retired`, `kata_retired_early`, `signal_published`, `emergency_stop`,
`slot_filled`, `orphan_detected`, `orphan_auto_retired`, `slot_snapshot`,
`overfit_evict`, `execution_block`, `regime_collapse_flagged`, `degrading_flagged`.
All events use `verb_category` (monitoring/execution/risk/analysis) and
`object_type` (report/campaign/deployment/portfolio).

---

## Scheduled Execution

See `installers/add-monitor/SKILL.md` for task setup. Summary:
- `monitor_health_check`: `*/15 * * * *` (this skill, Steps 0-5, 9)
- `monitor_deploy`: `7,37 * * * *` (Step 6)
- `monitor_kata`: `20 * * * *` (Step 7)
- `monitor_portfolio`: `0 0 * * *` (Steps 8-8d)
---

## Anti-Patterns

1. **REGIME CHURN** — Use hysteresis, never toggle on a single tick.
2. **MODIFYING STRATEGIES** — Auto-Mode NEVER changes strategy code. Retire instead.
3. **OVER-REPORTING** — Message on state changes only. Silent when nothing changed.
4. **IGNORING CORRELATION** — Never stack correlated archetypes on correlated pairs.
5. **ASSEMBLING AT DEPLOY TIME** — Pre-stage at graduation. Deployment = flip a switch.
6. **FALSE CONFIDENCE** — High composite ≠ profit. It gates signals, not returns.

---

## Feed Integration

Post `agent_post_status` ONLY on state changes (graduation, retirement,
slot fill, missed opportunities). Silent/clean ticks produce no feed posts.

---

## Idle-Time Triage Trigger

After a ROUTINE tick (no state changes), if no triage ran in 3 min and
next task > 5 min away, run ONE triage cycle per strategyzer Part 3C.
Do NOT run triage after ticks with state changes.

---

## Phase 7: Continuous Triage (after routine health check)

See "Idle-Time Triage Trigger" above and `strategyzer` SKILL.md Part 3C
for the full triage procedure. Classify results A/B/C by Sharpe threshold.
A-results with `auto_deploy_triage_winners` → full walk-forward → deploy if favorable_sharpe >= 0.5.

Exact validation periods per archetype are in `archetypes.yaml` `paper_validation`.

---

## Timeframe-Aligned Regime Refresh

Market-timing runs per-timeframe refresh on different cadences:
- Every tick (15 min): 5m + 15m cells
- Hourly: 1h cells
- Every 4h: 4h cells

`cell-grid-latest.json` is a merged view for backward compatibility.
Staleness thresholds: 5m/15m > 30min, 1h > 2h, 4h > 8h.

---

---

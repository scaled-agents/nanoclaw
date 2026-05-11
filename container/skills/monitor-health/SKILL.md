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

## Split Monitor Architecture

| Skill | Steps | Schedule | Purpose |
|-------|-------|----------|---------|
| `monitor-health` (this) | 0-5, 9 | `*/15 * * * *` | Bot health, signals, retirement, graduation |
| `monitor-deploy` | 6 | `7,37 * * * *` | Slot allocation, backtest verification |
| `monitor-kata` | 7 | `20 * * * *` | Kata race completion, walk-forward |
| `monitor-portfolio` | 8-8d | `0 0 * * *` | Portfolio correlation, tail risk, daily rollup |

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

## 15-Minute Health Check (9 Steps)

This is the core algorithm. Execute these steps in order on every scheduled tick.

### Crash-Safety Invariant

State is written BEFORE freqtrade actions execute.
If the agent crashes between writing state and executing a bot action, the next
check's reconciliation step detects the mismatch and retries. All transitions
are idempotent — stopping an already-stopped bot is a no-op.
### Step 0: TICK INIT (observability)

**0-pre. Setup defaults (one-time, cheap):**

If `scoring-config.json` does NOT exist in the workspace root:
```
copy setup/scoring-config-defaults.json → scoring-config.json
Log: "SETUP: Created scoring-config.json from defaults (first-run init)"
```
This eliminates a manual per-instance setup step. Safe to re-run — the file is
only copied when absent; never overwrites operator customizations.

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

**0a. Live-outcomes backfill (one-time reconciliation):**

If `knowledge/live-outcomes.jsonl` does not exist OR its entry count is less than
the number of retired/graduated campaigns in `auto-mode/campaigns.json`:

```
outcomes = read_jsonl("knowledge/live-outcomes.jsonl") ?? []
existing_keys = set((o.strategy, o.pair, o.timeframe) for o in outcomes)
campaigns = read("auto-mode/campaigns.json").campaigns
backfilled = 0

for c in campaigns where c.state in {"retired", "graduated", "graduated_internal_only", "graduated_external"}:
  key = (c.strategy, c.pair, c.timeframe)
  if key in existing_keys: continue

  append_jsonl("knowledge/live-outcomes.jsonl", {
    ts: c.paper_trading.retired_at ?? c.graduation?.graduated_at ?? c.deployed_at,
    strategy: c.strategy, archetype: c.archetype,
    correlation_group: c.correlation_group, pair: c.pair, timeframe: c.timeframe,
    outcome: "graduated" if c.state.startswith("graduated") else "retired_" + (c.paper_trading.retire_reason ?? "unknown"),
    regime_at_deploy: c.paper_trading.regime_at_deploy ?? null,
    regime_at_outcome: null,
    days_deployed: c.paper_trading.days_deployed ?? null,
    trade_count: c.paper_trading.current_trade_count ?? 0,
    pnl_pct: c.paper_trading.current_pnl_pct ?? 0,
    live_sharpe: c.graduation?.live_sharpe ?? c.paper_trading.current_sharpe ?? null,
    win_rate: c.paper_trading.current_win_rate ?? null,
    divergence_pct: c.paper_trading.divergence_pct ?? null,
    execution_quality: c.paper_trading.execution_quality ?? null,
    dsr: c.wfo_metrics?.dsr ?? null, pbo: c.wfo_metrics?.pbo ?? null,
    source: c.source ?? null, candidate_quality: c.candidate_quality ?? null,
    obstacle_at_routing: null, gap_score_at_discover: null,
    regime_breakdown: null
  })
  backfilled += 1

if backfilled > 0:
  Log: "BACKFILLED {backfilled} live-outcomes entries from campaigns.json"
```

Once all campaigns are reconciled, this check costs one line-count comparison
per tick and exits immediately. No repeated backfills.

### Step 1: READ STATE

**Health snapshot shortcut:** Before reading individual state files, check for
`/workspace/extra/bot-runner/health-snapshot.json`. If it exists and `computed_at`
is less than 2 minutes old, use it as a pre-joined view of bot metrics + campaign
state. This eliminates the need for per-bot `bot_status()`, `bot_profit()`, and
`bot_trades()` calls in Steps 1 and 3. The snapshot contains:
- `bots[]` — per-bot: deployment_id, strategy, pair, timeframe, bot_status,
  signals_active, metrics (pnl, trades, win_rate, sharpe, drawdown, avg_win/loss,
  consecutive_losses, execution_quality, by_regime), campaign state, archetype,
  slot_state, deadlines, hysteresis counters, flags, divergence, eviction_priority
- `active_slot_count`, `total_trade_count`, `portfolio_win_rate`
- `cell_grid_stale`, `cell_grid_age_hours`

If the snapshot is available and fresh, skip the per-bot MCP calls below and in
Step 3. Use the snapshot's `bots[].metrics` directly. Still read campaigns.json,
market-prior.json, and other state files normally for fields the snapshot doesn't
cover (e.g., full campaign arrays for reconciliation).

If the snapshot is missing or stale (> 2 min), fall back to the standard flow below.

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

    # Fatal-pattern log scan: check container logs for known terminal errors
    # BEFORE composing any alert. Lead with the specific cause, not the symptom.
    fatal_cause = null
    logs = bot_logs(campaign.paper_trading.bot_deployment_id, tail=100) or ""
    FATAL_PATTERNS = [
      {pattern: "StrategyException",       cause: "Strategy class not found or failed to load"},
      {pattern: "ModuleNotFoundError",     cause: "Missing Python module"},
      {pattern: "does not exist",          cause: "Strategy class does not exist"},
      {pattern: "ImportError",             cause: "Import failed in strategy file"},
      {pattern: "SyntaxError",             cause: "Syntax error in strategy file"},
      {pattern: "OperationalException",    cause: "FreqTrade operational error"},
      {pattern: "ExchangeError",           cause: "Exchange connection/auth error"},
    ]
    for fp in FATAL_PATTERNS:
      match = first line in logs containing fp.pattern
      if match:
        fatal_cause = fp.cause
        fatal_detail = match.strip()[:200]
        break

    if fatal_cause:
      Log: "FATAL: {strategy} — {fatal_cause}: {fatal_detail}"
      # Suppress restart — fatal errors won't self-heal
      campaign.fatal_error = {cause: fatal_cause, detail: fatal_detail, detected_at: now}
    else:
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
After computing posteriors, build `regime-intel.json` from shadow log + current regime state. Read `knowledge/regime-shadow-log.jsonl`, compute per-pair 7-day rolling agreement rates, and 5 promotion criteria: `agreement_above_threshold` (>0.70), `hmm_converging_all_pairs`, `no_sustained_disagreement`, `min_shadow_entries` (>=100), `bocpd_validation`. Write regime-intel.json with per-pair details.

**Regime shift fast-path (every regime refresh):**
After updating market-prior.json, compare fresh regime data against the last
cell-grid-latest.json composites. For each active deployment, check if the
regime classification changed since the last market-timing cycle:
```
for each active deployment:
  prev_regime = cell_grid[archetype][pair][tf].regime (from last market-timing)
  curr_regime = market_prior[pair][horizon].regime (just refreshed)
  prev_conviction = cell_grid[archetype][pair][tf].conviction
  curr_conviction = market_prior[pair][horizon].conviction

  # Detect significant regime shift
  regime_changed = (prev_regime != curr_regime)
  conviction_shift = abs(curr_conviction - prev_conviction) >= 20

  if regime_changed OR conviction_shift:
    # Re-score this cell's regime_fit using the fresh regime data
    new_regime_fit = score_regime_fit(archetype, curr_regime, curr_conviction)
    old_composite = cell_grid[archetype][pair][tf].composite
    new_composite = new_regime_fit * 0.4 + cell.execution_fit * 0.25 + cell.net_edge * 0.35
    cell_grid[archetype][pair][tf].regime = curr_regime
    cell_grid[archetype][pair][tf].conviction = curr_conviction
    cell_grid[archetype][pair][tf].composite = new_composite
    Log: "REGIME FAST-PATH: {pair}/{tf} {prev_regime}→{curr_regime}
          conviction {prev_conviction}→{curr_conviction}
          composite {old_composite:.2f}→{new_composite:.2f}"

if any cells were updated:
  write cell-grid-latest.json
  # Signal hysteresis below will pick up the new composites immediately
```
This closes the 4-hour latency gap: regime shifts are detected every 15 minutes
(or 10 in competition mode) and cell composites are updated in-place. Signal
hysteresis then toggles signals within 2 ticks (30 minutes → 20 in competition).

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

**If health snapshot was used in Step 1**, skip the `bot_profit()` and
`bot_trades()` calls below — all metrics are already in `bots[].metrics`.
Use the snapshot values directly and proceed to the divergence computation
and inactive bot detection.

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

Drives Trigger H/I (Step 4) and Step 6 (slot allocation). 
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

aphexdata_record_event(verb_id="kata_retired_early", ...)
# If fatal_error was captured in Step 1, lead with root cause
if campaign.fatal_error:
  Post to feed: "FATAL: {strategy} on {pair}/{tf} — {campaign.fatal_error.cause}: {campaign.fatal_error.detail}"
  Message user: "{strategy} retired — {campaign.fatal_error.cause}\n  Detail: {campaign.fatal_error.detail}\n  Reason: {reason}"
else:
  Post to feed: "Early retirement: {strategy} on {pair}/{tf} — {reason}"
  Message user: "{strategy} retired early — {reason}"

# Append live outcome (non-blocking — log warning on failure, create knowledge dir if missing)
append_jsonl("knowledge/live-outcomes.jsonl", {
  ts: now, strategy, archetype, correlation_group, pair, timeframe,
  outcome: "retired_trigger_" + trigger_code,
  regime_at_deploy: campaign.paper_trading.regime_at_deploy ?? null,
  regime_at_outcome: cell_grid.find(archetype, pair, timeframe)?.regime ?? null,
  days_deployed: (now - campaign.deployed_at).days,
  trade_count: campaign.paper_trading.current_trade_count ?? 0,
  pnl_pct: campaign.paper_trading.current_pnl_pct ?? 0,
  live_sharpe: campaign.paper_trading.current_sharpe ?? null,
  win_rate: campaign.paper_trading.current_win_rate ?? null,
  divergence_pct: campaign.paper_trading.divergence_pct ?? null,
  execution_quality: campaign.paper_trading.execution_quality ?? null,
  dsr: campaign.wfo_metrics?.dsr ?? null,
  pbo: campaign.wfo_metrics?.pbo ?? null,
  source: campaign.source ?? null,
  candidate_quality: campaign.candidate_quality ?? null,
  obstacle_at_routing: campaign.kata_routing?.obstacle ?? null,
  gap_score_at_discover: campaign.gap_score_at_discover ?? null,
  regime_breakdown: campaign.paper_trading.paper_pnl?.by_regime ?? null
})
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
      If `campaign.paper_trading.rr_extension == true`:
        → **RETIRE**. Reason: `"rr_inversion_persists_after_extension"`
        → R:R kata ran during extension window but problem persists; slot is wasted.
      Else:
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
  - `dsr < cfg.dsr_threshold` → extend validation once (`dsr_extension` flag, +50% of validation period), skip graduation. If already extended (`dsr_extension == true`): **RETIRE** `"low_dsr_after_extension"`. **Max 1 DSR extension** — no further extensions regardless of other flags.
  - `pbo > cfg.pbo_max` → same extension logic. If already extended: **RETIRE** `"high_pbo_after_extension"`. **Max 1 PBO extension.**
  - All pass → continue to execution gate

  **Execution realism gate (runs after overfit gate):**

  Uses `cfg = config.EXECUTION_GATES`. Skip if `cfg.enabled == false`.
  Reads `campaign.paper_trading.execution_quality` — measures whether Sharpe survives trading costs.
  If execution_quality missing or `trade_count < cfg.min_trades_for_gate`: record `met: null`, continue to GRADUATE.
  Stamp `campaign.graduation_gates["execution_quality"]` with `{required, actual, met}`.
  If `exq < cfg.min_execution_quality` → skip graduation (Trigger J handles pause if exq drops further).
  Else → continue to GRADUATE.

  **Regime-persistence gate (runs after execution gate):**

  Flags strategies that only traded in one regime type — they may not persist across regime shifts.
  Read `campaign.paper_trading.paper_pnl.by_regime` (regime breakdown from Step 3 metrics update).
  Skip if by_regime is missing or trade_count < 10 (insufficient data).

  ```
  archetype = read_archetype(campaign.archetype)
  total_trades = sum(r.n_trades for r in by_regime.values())
  preferred_trades = sum(r.n_trades for r in by_regime.values()
                         if r.regime in archetype.preferred_regimes)
  regime_hit_rate = preferred_trades / total_trades  # fraction in preferred regime

  min_hit_rate = config.GRADUATION_GATES.min_regime_hit_rate ?? 0.60

  if regime_hit_rate < min_hit_rate:
    # Don't block graduation — tag as regime-fragile for eviction priority
    campaign.graduation.regime_fragile = true
    campaign.graduation.regime_hit_rate = regime_hit_rate
    campaign.eviction_priority += 10   # fragile → higher eviction priority
    Log: "WARN: {strategy} graduated but only {pct:.0%} of trades in preferred regime
          ({archetype.preferred_regimes}). Tagged regime_fragile. eviction_priority += 10"
  ```

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

> Full detail in `skills/monitor-health/LIFECYCLE-ACTIONS.md`.

Two-stage bridge: Stage 1 = `graduated_internal_only` (signals to aphexDATA + console only);
Stage 2 = `graduated_external` after 3-day bake-in (webhooks live). Stake boosted by
`graduated_stake_multiplier × conviction_factor`. Header tags written to .py. Roster updated
with `wf_sharpe` for market-timing. TRADE.md updated and registry rebuilt. `live-outcomes.jsonl`
appended (non-blocking).

```
# Summary of GRADUATE state writes:
campaign.state = "graduated_internal_only"
campaign.graduation = { graduated_at, live_sharpe, live_trades, live_pnl_pct, live_max_dd, internal_bridge_until }
dep.state = "graduated_internal_only"; dep.slot_state = "graduated"; dep.effective_stake_pct = new_stake
write deployments.json, roster.json, header tags, TRADE.md, live-outcomes.jsonl
aphexdata_record_event(verb_id="kata_graduated_internal_only")
```

**BRIDGE → EXTERNAL promotion (checked every tick for bridged campaigns):**

```
for campaign in campaigns where state == "graduated_internal_only":
  if now >= campaign.graduation.internal_bridge_until:
    if current_sharpe >= 0.5 AND no new retirement triggers fired during bridge:
      campaign.state = "graduated_external"; dep.state = "graduated_external"
      write deployments.json
      If live_sharpe >= 0.8: enable marketplace publishing
      aphexdata_record_event(verb_id="kata_graduated_external")
    else:
      Extend bridge 1 day (max 2) OR retire if sharpe collapsed.
```

**RETIRE actions (any case):**

> Full detail in `skills/monitor-health/LIFECYCLE-ACTIONS.md`.

```
# Summary of RETIRE state writes:
campaign.state = "retired"; campaign.paper_trading.retire_reason = reason
bot_stop(bot_deployment_id, confirm=true)
dep.state = "retired"; write deployments.json
Return capital to season pool (if season active)
Update roster.json cell status to "retired"
Update TRADE.md lineage.graduation_status = "retired" (no registry rebuild)
aphexdata_record_event(verb_id="kata_retired")
append live-outcomes.jsonl (non-blocking)
```

**Evolution event logging (Step 5 only):**

```
# On GRADUATE: append to knowledge/evolution-events.jsonl
# On RETIRE:   append to knowledge/evolution-events.jsonl
# event_id = "evo_" + date + "_" + SHA256(campaign_id + ts)[:8]
```

**Live outcome logging** is inline in the Step 4 "On early retire" and Step 5
GRADUATE/RETIRE code blocks (see LIFECYCLE-ACTIONS.md). Non-blocking — create
knowledge dir if missing, log warning on write failure.

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

**Auto-memory write (MANDATORY):** Write a compact structured summary to
`~/.claude/memory/monitor-health.md` using the Write tool. Keep under 300 tokens.
Claude Code loads this file automatically at the start of the next session, giving the
next tick instant situational context without re-reading all state files.

Required format:
```
# Monitor-Health Tick Summary
Updated: {ISO timestamp} | Tick #{tick_count} | Verdict: {healthy|retirement|graduation|mixed}

## Decisions This Tick
{list retirements, graduations, triggers fired — or "none" if clean tick}

## Pending Attention
{list bots near deadlines, empty groups, anomalies flagged — or "none"}

## Portfolio State
Slots: {trial_count} trial / {graduated_count} graduated / {total} total
Groups: trend{✓/✗} range{✓/✗} vol{✓/✗} carry{✓/✗}
Next candidate: {top undeployed from roster, or "none"}

## Next Tick Notes
{deferred decisions, anomalies to recheck, anything worth flagging}
```

At tick start (Step 0), if `~/.claude/memory/monitor-health.md` exists, read it briefly
and note whether any "Pending Attention" items have resolved before proceeding.

**Tick completion stamp (MANDATORY):** Write `deployments._meta.last_tick = now`,
clear `last_tick_failure`. Append tick_complete to `tick-log.jsonl`.
If `tick_started_at > last_tick` → tick crashed (failure details in `last_tick_failure`).

**Message user only on state transitions** (graduation, retirement, slot fill).
Include state changes table + paper bots summary. Competition rollup handled by `monitor-portfolio`.

---

## Strategy-to-Archetype Matching

Scan Python header for `# ARCHETYPE: XXX`. If missing, call `aphexdata_query_events(verb_id="attested", object_type="strategy")` to infer from strategy name and historical performance. Valid archetypes: see archetype-taxonomy skill.

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

See `docs/state-contract.md`. Key files in `auto-mode/`: roster.json, deployments.json,
campaigns.json (in research-planner/), market-prior.json, configs/{name}_{pair}_{tf}.json.

---

## Handoffs Between Modes

On retirement, recommend kata-bridge. Monitor reads but does NOT run: macro, onchain, sentiment.

---

## AphexDATA Event Conventions

Key verb_ids: `deployment_activated`, `kata_graduated`, `kata_retired_early`,
`orphan_auto_retired`, `regime_collapse_flagged`. Use verb_category + object_type on all events.

---

---

## Anti-Patterns

- **REGIME CHURN**: Use hysteresis — never toggle on a single tick.
- **OVER-REPORTING**: Message on state changes only. Silent ticks produce no output.
- **ASSEMBLING AT DEPLOY TIME**: Pre-stage at graduation. Deployment = flip a switch.

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

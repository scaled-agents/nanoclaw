---
name: monitor
description: >
  Pipeline lifecycle orchestrator. Runs every 15 minutes: refreshes regime data
  (timeframe-aligned), triggers scout gap scans, checks strategyzer runs,
  monitors kata races, deploys graduated strategies, manages paper bot health,
  and enforces portfolio constraints. Reads market-timing cell grid for scores,
  uses orderflow for regime refresh, freqtrade for bot health, aphexdata
  for audit trail. Trigger on: "monitor", "monitor status", "show monitor",
  "pipeline status", "auto-mode", "auto mode", "deployment status",
  "auto check", "portfolio health", "deployment lifecycle", "paper bot status",
  "what should be running", "show bots", "show deployments", "health check".
---

# Monitor — Pipeline Lifecycle Orchestrator

Manages paper trading bot deployments. Reads market-timing scores,
monitors bot health, gates signals by regime, and graduates winners.

**Auto-Mode NEVER modifies strategy code.** If a strategy underperforms,
Auto-Mode retires it. The boundary is sacred: Auto-Mode operates
strategies, Research improves them.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `market-timing` | 560-cell scores (reads `cell-grid-latest.json`) |
| `orderflow` | Hourly regime refresh for active pairs |
| `archetype-taxonomy` | Archetype definitions, thresholds, constraints |
| `freqtrade-mcp` | Bot status, profit, balance (health monitoring) |
| `aphexdata` | Audit trail for all lifecycle events |

---

## Console Sync — Mandatory

After writing any state file that the console dashboard displays,
call `sync_state_to_supabase` to push the update. The console reads
from Supabase, not from local files. Files to sync:

| File | state_key |
|------|-----------|
| `campaigns.json` | `campaigns` |
| `roster.json` | `roster` |
| `missed-opportunities.json` | `missed_opps` |
| `triage-matrix.json` | `triage_matrix` |
| `cell-grid-latest.json` | `cell_grid` |
| `portfolio-correlation.json` | `portfolio_correlation` |

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
  Read header tags (first 10 lines):
    # ARCHETYPE: <type>
    # GRADUATED: true|false|<date>
    # VALIDATED_PAIRS: <pair1>, <pair2>, ...
    # WALK_FORWARD_DEGRADATION: <pct>

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
3. Calls `pause_task(name="auto_mode_check")` to stop the scheduled monitoring
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

### Step 1: READ STATE

Read campaigns.json, market-prior.json, portfolio-correlation.json, config.json,
and cell-grid-latest.json.

```bash
cat /workspace/group/research-planner/campaigns.json 2>/dev/null || echo '{"campaigns":[]}'
cat /workspace/group/auto-mode/market-prior.json 2>/dev/null || echo '{"regimes":{},"last_refresh":null,"tick_count":0}'
cat /workspace/group/auto-mode/portfolio-correlation.json 2>/dev/null || echo '{}'
cat /workspace/group/auto-mode/config.json 2>/dev/null || echo '{}'
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo '[]'
```

Build a list of all warm-up bots (`campaign.state == "paper_trading"`)
and all proven bots (`campaign.state == "graduated"`).

**Reconcile:** For each campaign with a `paper_trading.bot_deployment_id`,
verify the container is actually running via `bot_status(deployment_id)`.
If container is down but campaign says `paper_trading` → log warning,
don't auto-retire (might be a restart). If container has been down for
3+ consecutive checks, attempt `bot_start()` to restart it.

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
    Free the slot
    Post: "Orphan auto-retired: {strategy}. No campaign after 48h."
    `aphexdata_record_event(verb_id="orphan_auto_retired", verb_category="execution", object_type="deployment", ...)`

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

**For each warm-up or proven bot:**
```
cell_composite = composite score for this strategy's archetype + pair
                 from cell-grid-latest.json

TURNING SIGNALS ON (requires 2 consecutive ticks above):
  If signals_active == false:
    If cell_composite >= 3.5:
      consecutive_above += 1
      If consecutive_above >= 2:
        signals_active = true
        consecutive_above = 0
        Post: "{strategy}: signals ON — regime favorable
          for 2 consecutive checks"
    Else:
      consecutive_above = 0  (reset counter)

TURNING SIGNALS OFF (requires 2 consecutive ticks below):
  If signals_active == true:
    If cell_composite < 3.5:
      consecutive_below += 1
      If consecutive_below >= 2:
        signals_active = false
        consecutive_below = 0
        Post: "{strategy}: signals OFF — regime unfavorable
          for 2 consecutive checks"
    Else:
      consecutive_below = 0  (reset counter)

Store counters in campaign.paper_trading:
  consecutive_above: 0
  consecutive_below: 0
```

**Hysteresis (symmetric, both directions):** Require 2 consecutive
ticks in EITHER direction before toggling signals. This prevents:
  Tick 1: composite 3.6 → counter=1, still OFF
  Tick 2: composite 3.4 → counter reset
  Tick 3: composite 3.7 → counter=1, still OFF
  Tick 4: composite 3.8 → counter=2, NOW ON (stable regime confirmed)
Entries only fire after regime confirmed favorable for 30+ minutes
(2 × 15-minute ticks). Eliminates same-tick on/off signal churn.

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
Read from FreqTrade: profit_pct, trade_count, win_rate,
  current_sharpe (computed from trade history), max_drawdown

Update campaign.paper_trading:
  current_pnl_pct = profit_pct
  current_trade_count = trade_count
  current_sharpe = sharpe
  current_max_dd = max_drawdown
  last_checked = now
```

For proven/published bots:
Same metric update. Track ongoing performance after graduation.

`sync_state_to_supabase(state_key="campaigns", ...)`

### Step 4: EARLY RETIREMENT CHECK

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
  Container status != running for 2 consecutive health checks
  AND no restart detected between checks
  Reason: `"container_failed"`

  The container crashed and didn't recover. Auto-mode can't
  restart containers — that's an infrastructure issue.

  → Retire. Free slot. Alert user: "Container down for {strategy}"

**TRIGGER C — Clear negative edge (needs trades)**
  `current_trade_count >= 5`
  AND last 5 trades are ALL losses
  AND cumulative loss from those 5 trades > 5%
  Reason: `"consecutive_losses"`

  This can only trigger after the strategy has produced enough
  trades to judge. 5 consecutive losses with >5% total loss is
  statistically meaningful — this isn't bad luck, it's bad edge.

  → Retire. Stop bot. Free slot.

**THAT'S IT.** Three triggers. Everything else waits for the
validation deadline in Step 5 (Graduation Check).

What's NOT a retirement trigger:
  - Zero trades after N hours → NOT a trigger.
    Step 0 investigates silent bots. The validation deadline
    catches "not enough trades" at the end. Premature killing
    wastes validated strategies.

  - Low Sharpe before deadline → NOT a trigger.
    Sharpe is noisy with small sample sizes. A strategy at
    -0.2 Sharpe after 3 trades might be +0.5 after 15.
    Wait for the deadline and min_trades.

  - Regime-blocked signals → NOT a trigger.
    Signals being OFF because composite < 3.5 is the system
    working correctly. The strategy will trade when the regime
    rotates. Regime-blocked time doesn't count against it.

**On early retire (any trigger):**
```
Stop container: bot_stop(bot_deployment_id)
campaign.state = "retired"
campaign.paper_trading.retire_reason = reason
Free the slot
aphexdata_record_event(verb_id="kata_retired_early", ...)
Post to feed: "Early retirement: {strategy} on {pair}/{tf} — {reason}"
Message user: "{strategy} retired early — {reason}"
```

### Step 5: GRADUATION CHECK

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

  If `current_sharpe >= min_sharpe AND abs(current_max_dd) <= max_dd`:
    → **GRADUATE** (see graduation actions below)
  Else:
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
```
campaign.state = "graduated"
campaign.graduation = {
  graduated_at: now,
  live_sharpe: current_sharpe,
  live_trades: current_trade_count,
  live_pnl_pct: current_pnl_pct,
  live_max_dd: current_max_dd
}

Write header tags to strategy .py:
  # ARCHETYPE: {archetype}
  # GRADUATED: {date}
  # LIVE_VALIDATED: {days} days
  # LIVE_SHARPE: {sharpe}
  # LIVE_TRADES: {trades}
  # CORRELATION_GROUP: {group}

Add to roster.json (pre-stage config for fast future deployment)
sdna_attest + sdna_registry_add (if genome exists)
Keep bot running (it's now proven)

If live_sharpe >= 0.8:
  Enable marketplace signal publishing
  Post: "PUBLISHED: {strategy} — Sharpe {s} exceeds publishing threshold"

aphexdata_record_event(verb_id="kata_graduated", ...)
Post to feed: "GRADUATED: {strategy} on {pair}/{tf}
  — {days} days live, Sharpe {sharpe}, {trades} trades, P&L {pnl}%"
Message user with full details
```

**RETIRE actions (any case):**
```
campaign.state = "retired"
campaign.paper_trading.retire_reason = reason
Stop container, free slot
aphexdata_record_event(verb_id="kata_retired", ...)
Post to feed: "Retired: {strategy} — {reason}"
```

### Step 6: FILL EMPTY SLOTS

```
active_warmup = count campaigns where state == "paper_trading"
max_slots = config.paper_trading.max_paper_bots (default 20)
available = max_slots - active_warmup
```

If `available > 0 AND config.auto_deploy_triage_winners`:
```
Read triage-matrix.json
winners = entries with favorable_sharpe >= 0.5, not yet deployed
Sort by favorable_sharpe descending

For next winner:
  Deploy paper bot: bot_start_paper(strategy, pair, tf, config)
  Create campaign with state: "paper_trading"
  Set validation_deadline from archetypes.yaml paper_validation[tf]
  Post to feed: "Auto-filling slot: {strategy} on {pair}/{tf}
    — favorable Sharpe {s}"
```

### Step 7: KATA WORKER CHECK

Read `/workspace/group/research-planner/kata-state.json`

If file exists AND `round == 4` AND `status in ["improved", "stuck"]`:

A Round 3 worker has finished. Run Round 4:

**If status == "improved":**
```
Read the modified strategy .py
Run compound 4-window walk-forward (1 bash call)
Compute favorable_sharpe
If >= 0.5: deploy paper bot
If >= 0.3: deploy with lower confidence
If < 0.3: close Kata, log learnings
Update kata-state.json outcome
Move to kata-history/
```

**If status == "stuck":**
```
Check current_favorable_sharpe
If >= 0.3: deploy best result
If < 0.3: close Kata, log learnings
Move to kata-history/
```

This means: parent spawns worker and exits. Auto-mode detects
completion and handles deployment. No polling, no blocking.

### Step 8: PORTFOLIO CORRELATION (daily at 00:00 only)

Skip unless current hour == 0 AND last_correlation_update was yesterday.

When 3+ bots have run concurrently for 7+ days:

1. **RECORD**: For each active bot, record today's P&L % in
   `/workspace/group/auto-mode/portfolio-correlation.json`
   under `daily_returns[date][strategy_name]`

2. **COMPUTE** (weekly): Pearson correlation between all strategy
   return series. Average pairwise correlation. Portfolio Sharpe:
   ```
   portfolio_sharpe = avg_sharpe × sqrt(N / (1 + (N-1) × avg_corr))
   estimated_return = portfolio_sharpe × 0.60
   ```

3. **STORE**:
   ```json
   {
     "daily_returns": { "2026-03-30": { "strat_a": 0.42 } },
     "correlation_matrix": { "strat_a|strat_b": 0.12 },
     "avg_pairwise_correlation": 0.12,
     "portfolio_sharpe_estimate": 1.15,
     "estimated_annual_return_pct": 69,
     "strategy_count": 5,
     "last_updated": "..."
   }
   ```
   `sync_state_to_supabase(state_key="portfolio_correlation", ...)`

4. **ALERT** if avg correlation > 0.30:
   "High correlation: {corr} across {n} strategies.
    Consider filling a different correlation group."

5. **WEEKLY SUMMARY** (Sunday):
   "Portfolio: {n} strategies, correlation {corr}, estimated
    Sharpe {ps}, projected return {ret}%. Target: 1.33 / 80%."
    tags: ["portfolio", "analysis"]

### Step 8b: REGIME TRANSITION FREQUENCIES (weekly, Sunday 00:00)

Skip unless current day == Sunday AND last_transition_update was last week.

Compute from market-prior.json tick history (106+ ticks logged):

For each pair and timeframe, count regime transitions:
  For each tick where regime changed from A to B:
    increment transitions[pair][tf][A→B]

Build a transition probability table:
  P(next_regime | current_regime, pair, tf) =
    count(current→next) / count(current→any)

Store in /workspace/group/auto-mode/regime-transitions.json:
  ```json
  {
    "BTC/USDT:USDT": {
      "4h": {
        "TRANQUIL": {
          "→ TRANQUIL": 0.55,
          "→ COMPRESSION": 0.20,
          "→ EFFICIENT_TREND": 0.20,
          "→ CHAOS": 0.05,
          "sample_size": 40
        },
        "EFFICIENT_TREND": {
          "→ EFFICIENT_TREND": 0.60,
          "→ TRANQUIL": 0.25,
          "→ COMPRESSION": 0.10,
          "→ CHAOS": 0.05,
          "sample_size": 35
        }
      }
    },
    "last_updated": "2026-04-06T00:00:00Z"
  }
  ```

sync_state_to_supabase(state_key="regime_transitions", ...)

### Step 9: LOG + SYNC

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
    "slots_filled": N
  }
)
```

Sync ALL critical state files to Supabase:
  sync_state_to_supabase(state_key="campaigns", ...)
  sync_state_to_supabase(state_key="triage_matrix", ...)
  sync_state_to_supabase(state_key="roster", ...)
  sync_state_to_supabase(state_key="portfolio_correlation", ...)
  sync_state_to_supabase(state_key="kata_state", ...)
  sync_state_to_supabase(state_key="market_prior", ...)
  sync_state_to_supabase(state_key="regime_transitions", ...)

This serves as a backup mechanism — all institutional memory is
recoverable from Supabase if local files are lost.

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

**ClawTeam graduation convention:** When a strategy graduates from research, the
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
    "name": "binance",
    "pair_whitelist": ["ETH/USDT:USDT"]
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

**campaign.paper_trading fields** (managed by auto-mode + research-planner):
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
  "regime_extension": false
}
```

- `ticks_signals_on/off`: incremented by Step 2 each health check. Used by Step 5 Case 3.
- `expected_trades_in_validation`: estimated at deploy time from WF trade counts.
- `feasibility_warning`: true if expected_trades < min_trades at deploy time.
- `extended`: true if validation was extended 50% (Case 2). Only once.
- `regime_extension`: true if zero-trade bot got full extension due to regime-blocking (Case 3). Only once.

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
| "Send to research {strategy_name}" | Retire + recommend ClawTeam improvement session |

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
| "Disable auto-mode" | `pause_task(name="auto_mode_check")` |
| "Enable auto-mode" | `resume_task(name="auto_mode_check")` |
| "EMERGENCY STOP" | Stop ALL bots, pause scheduler, retire all campaigns |
| "Set auto-mode to dry run" | All checks run but no freqtrade actions |

---

## Handoffs Between Modes

### Auto-Mode → Research (ClawTeam)

When a deployed strategy underperforms and is retired:
```
"{strategy_name} has been retired. Sharpe {s} below threshold after {days} days.
Recommend sending back to Research with hypothesis: {archetype} needs
improvement for current market conditions."

User can say: "Improve {strategy_name}" → ClawTeam takes over.
```

### Research → Auto-Mode

When ClawTeam graduates a strategy:
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

Auto-mode runs every 15 minutes as a scheduled task:

```
schedule_task(
  name: "auto_mode_check",
  schedule: "*/15 * * * *",
  context_mode: "isolated",
  prompt: "Run an auto-mode monitoring check. Follow the 9-step procedure in the auto-mode skill. Read all state files, reconcile containers, refresh regimes, update metrics, check retirement/graduation, fill slots, check Kata workers, compute portfolio correlation (if daily), log and sync. Message user only on state changes."
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
  Run ONE triage cycle per research-planner SKILL.md Part 3C.
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

---
name: auto-mode
description: >
  Autonomous deployment lifecycle monitor. Runs every 15 minutes to check
  active deployment health, manage state transitions (shadow/active/throttled/
  paused/retired), scan for opportunities and retirement candidates, enforce
  portfolio constraints, and report significant events. Reads market-timing
  cell grid for scores, uses orderflow for regime refresh, freqtrade for bot
  health, aphexdata for audit trail. Trigger on: "auto-mode", "auto mode",
  "deployment status", "shadow track", "auto check", "portfolio health",
  "deployment lifecycle", "activate deployment", "pause deployment",
  "show opportunities", "retirement candidates", "what should be running".
---

# Auto-Mode — Deployment Lifecycle Monitor

Manages live and shadow strategy deployments. Reads market-timing scores,
monitors bot health, enforces portfolio risk, and recommends actions.

**Auto-Mode NEVER modifies strategy code.** If a strategy underperforms,
Auto-Mode pauses it and recommends sending it back to Research (ClawTeam).
The boundary is sacred: Auto-Mode operates strategies, Research improves them.

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
| `deployments.json` | `deployments` |
| `roster.json` | `roster` |
| `missed-opportunities.json` | `missed_opps` |
| `triage-matrix.json` | `triage_matrix` |
| `cell-grid-latest.json` | `cell_grid` |

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

Cell status values: `staged` (ready but dormant), `shadow` (paper trading bot running),
`active` (live capital), `deactivated` (was active, now back to dormant).

### Instant Activation

When auto-mode decides to deploy (user approves, or pre-approved auto-shadow):

```
activate_deployment(roster_entry, cell):
  1. Read pre-generated config from configs/ directory
  2. Set stake amount via conviction-weighted sizing (see section below)
  3. bot_start(deployment_id, strategy_name, pair, timeframe)
     → Bot starts in dry-run mode with signals OFF (initial_state=stopped)
  4. Update roster.json: cell status → "shadow"
  5. Update deployments.json with new deployment entry
  6. aphexdata_record_event(verb_id="deployment_activated", ...)
  7. Next health check will toggle signals ON/OFF based on composite score
```

**Total time from decision to paper-trading bot: < 30 seconds.**
No file copying, no config editing. Bot-runner handles config generation and Docker container.

**Promotion to ACTIVE (live capital) — Safe Transition Protocol:**

Promotion is a multi-tick process. A container swap while paper positions are
open would silently lose them. The protocol ensures the book is flat before
the swap happens.

```
promote_deployment(deployment_id):

  TICK 0 — User Approval:
  1. User approves with confirmation token
  2. bot_toggle_signals(deployment_id, false) — signals OFF immediately
  3. Set deployment fields:
       promotion_approved: true
       promotion_approved_at: now
       promotion_signals_off_at: now
  4. Message: "Promotion approved. Signals OFF — entering cooldown window.
     Will check for open positions next tick."

  TICK 1+ — Cooldown Check (runs each health check until flat):
  5. Verify signals have been OFF for >= 1 full check cycle (15 min)
  6. bot_status(deployment_id) — read open trade count
  7. If open paper positions > 0:
       Message: "Promotion waiting — {N} open paper position(s) still closing.
         Will retry next tick."
       Do NOT proceed. Leave promotion_approved=true and retry next tick.
  8. If open paper positions == 0 AND cooldown elapsed:

  TICK N — Execute Swap (only when flat + cooldown met):
  9.  bot_stop(deployment_id, confirm=true) — remove dry-run container
  10. bot_start(deployment_id, strategy, pair, tf) with dry_run=false + exchange keys
  11. bot_toggle_signals(deployment_id, false) — start with signals OFF
  12. Update deployments.json: state → "active", activated_at → now
  13. aphexdata_record_event(verb_id="deployment_promoted", ...)
  14. Next health check controls initial live signal state via composite score

  TIMEOUT — If positions don't close within 4 ticks (1 hour):
  15. Message: "Promotion stalled — paper positions haven't closed after 1h.
      Force-exit paper positions? Reply 'force exit {deployment_id}' to proceed,
      or 'cancel promotion {deployment_id}' to abort."
```

**Critical invariant:** The live bot starts with signals OFF (Step 11).
The first health check after promotion evaluates the composite and toggles
signals ON only if conditions are still favorable. This prevents deploying
live capital into a regime that shifted during the cooldown window.

### Instant Deactivation

```
deactivate_deployment(roster_entry, cell):
  1. bot_toggle_signals(deployment_id, false) — disable signals (bot stays alive)
     OR bot_stop(deployment_id, confirm=true) — remove container (for retirement)
  2. Update roster.json: cell status → "staged" (back to dormant)
  3. Update deployments.json lifecycle state
  4. aphexdata_record_event(verb_id=<transition_verb>, ...)
```

Bot containers stay alive in PAUSED state (signals OFF) for instant re-activation.
Only RETIRED deployments have their containers removed.

---

## Conviction-Weighted Position Sizing

Position size is not fixed — it's computed from regime conviction and
timeframe alignment. This prevents deploying full size into an unconfirmed
regime flip (e.g., 1h says trend but 4h says compression).

### Formula

```
position_size = base_stake_pct
  × (conviction / 100)           ← regime conviction from orderflow
  × timeframe_alignment_factor   ← see table below
  × stake_modifier               ← 1.0 active, 0.5 throttled
  × portfolio_headroom_factor    ← remaining allocation capacity (0-1)
```

### Timeframe Alignment Factor

| 1h Regime | 4h Regime | Factor | Rationale |
|-----------|-----------|--------|-----------|
| Target regime | Target regime | **1.0** | Full alignment, full size |
| Target regime | Neutral | **0.7** | Partial alignment |
| Target regime | Opposing | **0.4** | Significant headwind, minimal size |
| Neutral | Any | **0.3** | Not in target regime |

### Example: ETH 1h TREND_MOMENTUM

```
Scenario A — 1h: EFFICIENT_TREND conviction 72, 4h: COMPRESSION (opposing)
  position = 5% × 0.72 × 0.4 × 1.0 × 1.0 = 1.44%

Scenario B — 1h: EFFICIENT_TREND conviction 72, 4h: EFFICIENT_TREND conviction 65
  position = 5% × 0.72 × 1.0 × 1.0 × 1.0 = 3.6%
```

The 4h compression cuts the position by 60%. Strategy still deploys but with
minimal exposure until timeframes align. When the 4h catches up, the next
check automatically increases the position.

### Position Size Updates

On every 15-minute check, recalculate position size for active/throttled
deployments. If the new size differs by > 20% from current, adjust via
`freqtrade_stop_bot()` then `freqtrade_start_bot()` with new stake.

---

## Pre-Approval Configuration (Auto-Shadow)

Allow user to set auto-shadow rules so they don't need to be awake when
regime flips happen. **Auto-shadow is DRY RUN ONLY.** Moving from shadow
to active (live capital) ALWAYS requires explicit user approval. No exceptions.

### Config

Add to `config.json`:

```json
{
  "auto_shadow_rules": [
    {
      "archetype": "TREND_MOMENTUM",
      "min_composite": 4.0,
      "min_conviction": 60,
      "require_tf_alignment": false,
      "max_auto_shadow": 2,
      "note": "Auto-shadow up to 2 trend strategies when composite > 4.0"
    },
    {
      "archetype": "MEAN_REVERSION",
      "min_composite": 4.5,
      "min_conviction": 50,
      "require_tf_alignment": true,
      "max_auto_shadow": 1,
      "note": "More conservative — require timeframe alignment"
    }
  ]
}
```

### Matching Logic

When a threshold crossing is detected (see Regime-Flip Fast Path below):

1. Find matching `auto_shadow_rule` for this archetype
2. Check `composite >= min_composite`
3. Check `conviction >= min_conviction`
4. If `require_tf_alignment`: verify both 1h and 4h in target regime
5. Count current auto-shadowed deployments for this archetype
6. If count < `max_auto_shadow` → activate in shadow mode (dry_run=true)
7. Message user with what happened and how to approve for live capital

---

## Deployment Lifecycle State Machine

```
SHADOW (paper trading) ──user approve──> ACTIVE ──composite < 3.0 (2 checks)──> THROTTLED
  │  ^                                     │                                       │
  │  │ score >= deploy                     │ circuit breaker                       │ composite < 2.0 (3 checks)
  │  │ threshold (3x)                      v                                       v
  │  └──────────────────────── PAUSED ──────────────────────────────────────── PAUSED
  │ score < 2.0 (3x)            ↑ ↓                                               │
  v                              ↑ ↓ paused > 48h AND was ACTIVE, or user cmd     │
PAUSED ←─────────────────────    RETIRED <────────────────────────────────────────┘
  (signals OFF, bot alive)              (container removed, only ex-ACTIVE)
```

**Key design principles:**
1. **SHADOW = paper trading.** A dry-run FreqTrade bot runs continuously. Health checks
   toggle signals ON/OFF based on composite score. Paper P&L is tracked as validation.
2. **SHADOW strategies that underperform go to PAUSED** (signals OFF, bot stays alive).
   Auto-restores when composite recovers. No cooldown, no capital was risked.
3. **RETIRED is reserved for strategies that traded live capital.** Shadow-only strategies
   are NEVER retired — they pause and auto-restore.

### Bot Runner Integration

SHADOW and ACTIVE states use the **bot-runner MCP tools** to manage FreqTrade containers:
- `bot_start(deployment_id, strategy, pair, timeframe)` — start a dry-run FreqTrade container
- `bot_stop(deployment_id, confirm=true)` — stop and remove container
- `bot_toggle_signals(deployment_id, enable)` — enable/disable trading signals
- `bot_status(deployment_id)` — check container status, signals, paper P&L
- `bot_list()` — list all managed bots
- `bot_profit(deployment_id)` — read paper trading P&L

### States

| State | Description | FreqTrade Bot | Signals |
|-------|-------------|---------------|---------|
| **SHADOW** | Paper trading (dry-run). Bot running, signals toggled by composite score. Paper P&L tracked. Minimum shadow period before promotion-eligible is determined by `shadow_minimum_matrix[archetype][timeframe]` (default 24h) + `shadow_minimum_checks_matrix[timeframe]` checks above threshold (default 6). | Running (dry_run=true) | Toggled by health check |
| **ACTIVE** | Live deployment. Bot running with real capital. Fully monitored every 15 minutes. | Running (dry_run=false) | Toggled by health check |
| **THROTTLED** | Reduced position size (50%). Bot running with reduced stake. | Running (reduced) | Active (reduced) |
| **PAUSED** | Bot container alive but signals OFF. No new trades. Shadow-paused strategies auto-restore when composite recovers (no cooldown). Active-paused strategies require user approval. | Running but signals OFF | OFF |
| **RETIRED** | Bot container removed. Only reachable from PAUSED for strategies that were previously ACTIVE (traded live capital) and stayed paused > 48h, or via explicit user command. Shadow-only strategies are NEVER retired. | Stopped (container removed) | N/A |

### Critical Safety Invariant

**SHADOW → ACTIVE requires explicit user approval.** The agent never auto-deploys
live capital. When a shadow deployment becomes promotion-eligible, the agent sends
a message asking the user to approve. All other downward transitions (throttle,
pause, retire) happen automatically based on scores and hysteresis.

### Thresholds

| Threshold | Default | Purpose |
|-----------|---------|---------|
| `deploy_threshold` | 3.5 | Composite to consider deployment-worthy |
| `throttle_threshold` | 3.0 | Below this → throttle (2 consecutive checks) |
| `pause_threshold` | 2.0 | Below this → pause (3 consecutive checks) |
| `restore_threshold` | 3.5 | Above this → restore from throttled/paused |
| `retire_threshold` | 1.5 | Below this for 3 checks → retire |
| `circuit_breaker_dd_pct` | 15% | Portfolio DD → pause ALL |
| `circuit_breaker_recovery_dd_pct` | 10% | DD recovery → allow re-approval |
| `shadow_minimum_hours` | 24 | Default minimum shadow time. Overridden by `shadow_minimum_matrix[archetype][timeframe]` in config.json if present. |
| `shadow_minimum_checks_above_threshold` | 6 | Default minimum checks. Overridden by `shadow_minimum_checks_matrix[timeframe]` in config.json if present. |
| `throttle_stake_modifier` | 0.5 | Position size multiplier when throttled |
| `throttle_consecutive_checks` | 2 | Checks below throttle_threshold to trigger |
| `pause_consecutive_checks` | 3 | Checks below pause_threshold to trigger |
| `restore_consecutive_checks` | 2 | Checks above restore_threshold to restore |
| `paused_retire_hours` | 48 | Hours in PAUSED before auto-retire |
| `pnl_retire_threshold_pct` | -10 | P&L since deploy → retirement candidate |

Users can override any threshold via `/workspace/group/auto-mode/config.json`.

### Shadow Minimum Matrix

The flat `shadow_minimum_hours` and `shadow_minimum_checks_above_threshold` defaults
are designed for 1h strategies. For other timeframes, use the 2D matrix from config.json:

**Lookup procedure (used in Step 9):**
```
shadow_hours = config.shadow_minimum_matrix?.[archetype]?.[timeframe]
  ?? config.shadow_minimum_hours ?? 24

shadow_checks = config.shadow_minimum_checks_matrix?.[timeframe]
  ?? config.shadow_minimum_checks_above_threshold ?? 6
```

**Rationale:**
- Low TF (5m/15m): sees many regime cycles quickly → shorter minimum, but more checks needed
- High TF (4h/1d): fewer candles per day → longer minimum, fewer checks sufficient
- Archetype modifies further: trend strategies need longer confirmation than scalp/range

| | 5m | 15m | 1h | 4h | 1d |
|---|---|---|---|---|---|
| SCALP/RANGE | 4h | 6h | 12h | 24h | 48h |
| MEAN_REVERSION | 6h | 8h | 18h | 36h | 72h |
| TREND/MOMENTUM | 8h | 12h | **24h** | 48h | 96h |
| MULTI_FACTOR/BREAKOUT | 6h | 10h | 20h | 40h | 80h |

| Timeframe | Min checks |
|---|---|
| 5m | 24 |
| 15m | 16 |
| 1h | 6 |
| 4h | 4 |
| 1d | 3 |

---

## Security Hardening

### 1. Main-Group Gate

Auto-mode commands that affect capital MUST only run in the main group.
Before executing any capital-affecting command, check:

```bash
[ "$NANOCLAW_IS_MAIN" = "1" ] || echo "DENIED: auto-mode capital operations require main group"
```

**Capital-affecting commands** (require main group):
- `activate` / `approve` (SHADOW → ACTIVE)
- `resume` (PAUSED → ACTIVE)
- `retire` (stops bot permanently)
- `shadow track` (creates deployment entry)
- `set threshold` (modifies config)
- `emergency stop`

**Read-only commands** (allowed from any group):
- `show auto-mode status`
- `show opportunities`
- `show retirement candidates`
- `show portfolio health`

### 2. Confirmation Tokens for Irreversible Actions

Actions that start or permanently stop live capital require a two-step confirmation.
When the user requests an irreversible action, respond with a confirmation prompt
containing a random 4-character token. The user must reply with the exact token.

**Actions requiring confirmation:**
- SHADOW → ACTIVE: `"Activating EMA_Cross_v3 on BTC/USDT 1h with $100 stake. Type CONFIRM-A7K2 to proceed."`
- RETIRE with open positions: `"Retiring EMA_Cross_v3 — has 2 open positions. Type CONFIRM-X9P1 to proceed."`
- EMERGENCY STOP: `"This will stop ALL bots immediately. Type CONFIRM-STOP to proceed."`

Generate the token from the deployment ID + current timestamp (deterministic but
not guessable). Do NOT execute the action until the user replies with the exact token
in the same conversation turn.

**Actions that do NOT need confirmation** (safe direction / reversible):
- Shadow track (no capital at risk)
- Pause (protective)
- Throttle (automatic, protective)
- Show/read commands

### 3. Absolute Capital Limits

Beyond percentage-based constraints, enforce hard dollar limits:

| Limit | Default | Config Key |
|-------|---------|------------|
| Max capital per single deployment | $500 | `max_stake_amount_usd` |
| Max total capital across all deployments | $2500 | `max_total_capital_usd` |
| Max new capital deployed per 24h | $1000 | `max_daily_new_capital_usd` |

Track daily deployment capital in `portfolio.json`:
```json
{
  "daily_deployed_usd": 300,
  "daily_deployed_reset_at": "2026-03-25T00:00:00Z"
}
```

If a deployment would exceed any limit, block it and message the user:
```
"Blocked: activating EMA_Cross_v3 ($100) would exceed daily deployment limit
($1000). $900 already deployed today. Override with 'set limit max_daily_new_capital_usd=1500'."
```

### 4. Deployment Rate Limit

Prevent rapid-fire deployments that could overwhelm risk management:

| Limit | Default | Config Key |
|-------|---------|------------|
| Max new activations per hour | 3 | `max_activations_per_hour` |
| Cooldown between activations | 5 minutes | `activation_cooldown_minutes` |

Track in `portfolio.json`:
```json
{
  "recent_activations": [
    {"deployment_id": "dep_btc_...", "activated_at": "2026-03-25T17:30:00Z"}
  ]
}
```

### 5. Emergency Stop

The `EMERGENCY STOP` command (after confirmation) immediately:
1. Calls `freqtrade_stop_bot(confirm=true)` for ALL active and throttled deployments
2. Sets `portfolio.circuit_breaker_active = true`
3. Calls `pause_task(name="auto_mode_check")` to stop the scheduled monitoring
4. Transitions all non-retired deployments to PAUSED
5. Writes state atomically
6. Logs `aphexdata_record_event(verb_id="emergency_stop", verb_category="risk", object_type="portfolio")`
7. Messages user: "EMERGENCY STOP executed. All bots stopped. Scheduler paused. Manual 'enable auto-mode' + individual re-approval required to resume."

Recovery from emergency stop requires:
- `enable auto-mode` (restarts scheduler)
- Individual `approve` commands for each deployment (with confirmation tokens)

### 6. Dry-Run Mode

When `config.json` contains `"dry_run": true`:
- ALL transitions are computed and logged normally
- ALL state file updates happen normally (so hysteresis tracking works)
- NO freqtrade actions are executed (Step 13 is skipped entirely)
- Messages include `[DRY RUN]` prefix
- aphexDATA events include `"dry_run": true` in result_data

This allows testing the full decision pipeline without risking capital.

Enable: `"Set auto-mode to dry run"` → writes `"dry_run": true` to config.json
Disable: `"Set auto-mode to live"` → writes `"dry_run": false` to config.json

### 7. State File Integrity

Each state file includes a `_checksum` field — a SHA-256 hash of the file content
(excluding the `_checksum` field itself). On read, verify the checksum matches.

```json
{
  "version": 1,
  "deployments": [...],
  "last_updated": "...",
  "_checksum": "a3f2b8c1..."
}
```

**On write (Step 12):** Compute checksum of the JSON content without `_checksum`,
then add `_checksum` field before writing.

**On read (Step 3):** Verify checksum. If mismatch:
- Log `aphexdata_record_event(verb_id="integrity_violation", verb_category="security", object_type="state_file")`
- Message user: "State file integrity check failed for {filename}. File may have been tampered with. Entering safe mode — all transitions blocked until resolved."
- Skip all transitions for this tick (read-only mode)
- Do NOT overwrite the file (preserve evidence)

Compute checksum via:
```bash
# Write: compute hash of content without _checksum
echo '{"version":1,...}' | sha256sum | cut -d' ' -f1
```

---

## 15-Minute Check Procedure (15 Steps)

This is the core algorithm. Execute these steps in order on every scheduled tick.

### Crash-Safety Invariant

State is written BEFORE freqtrade actions execute (Step 12 before Step 13).
If the agent crashes between writing state and executing a bot stop, the next
check's reconciliation step (Step 4) detects the mismatch and retries the action.
This is safe because all transitions are idempotent — stopping an already-stopped
bot is a no-op, starting an already-running bot is a no-op.

### Steps 1–2: Hourly Scans (every 4th tick only)

Check `market-prior.json` → `tick_count`. If `tick_count % 4 == 0`, run Steps 1–2.
Otherwise skip directly to Step 3.

**Step 1: Opportunity Scan**

Read these files:
```bash
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo '[]'
cat /workspace/group/auto-mode/deployments.json 2>/dev/null || echo '{"deployments":[]}'
```

Check cell-grid age. If older than 8 hours: **skip opportunity scanning entirely**
(stale scores cannot justify new deployments). Log: "Opportunity scanning paused — scores stale."

For each cell where `composite >= 3.5`:
1. Is there already a deployment covering this `archetype + pair + timeframe`? → Skip
2. Check rate limit: has this cell been recommended in the last 4 hours?
   (check `market-prior.json` → `recommendations.opportunities.<cell_key>`) → Skip
3. Scan strategy library for a matching strategy:
   ```bash
   head -10 /workspace/group/user_data/strategies/*.py 2>/dev/null
   ```
   Look for `# ARCHETYPE: <archetype_name>` in first 10 lines of each `.py` file.
4. If no matching graduated strategy found → **log as missed opportunity**:
   ```
   aphexdata_record_event(
     verb_id="missed_opportunity",
     verb_category="analysis",
     object_type="cell",
     object_id="<pair>_<archetype>_<timeframe>",
     result_data={
       "pair": "<pair>",
       "timeframe": "<timeframe>",
       "archetype": "<archetype>",
       "composite_score": <score>,
       "regime": "<regime>",
       "conviction": <conviction>,
       "reason": "no_staged_strategy"
     }
   )
   ```
   Also append to `/workspace/group/auto-mode/missed-opportunities.json` (rolling buffer,
   keep last 50 entries only — truncate oldest on each write). AphexDATA is the permanent record.
5. If match found, check portfolio constraints:
   - Would adding exceed max total deployments (10)?
   - Would it exceed per-archetype limit (3)?
   - Would it exceed per-pair limit (2)?
6. If constraints pass → message user:
   ```
   Opportunity: {pair} {archetype} {tf} composite={score}. Strategy {strategy_name}
   matches. Reply "shadow track {pair} {archetype} {tf}" to deploy.
   ```
7. Log: `aphexdata_record_event(verb_id="opportunity_detected", object_type="deployment", result_data={cell, strategy, composite})`
8. Update rate limit: `recommendations.opportunities.<cell_key> = now()`

**NEVER auto-deploy.** Recommendation only. User must reply with shadow track command.

**Step 2: Retirement Scan**

For each deployment in `deployments.json`:
1. **Skip if shadow-only** — if the deployment was never ACTIVE (no `activated_at` timestamp),
   it is not eligible for retirement. Shadow-only strategies pause and auto-restore; they never retire.
2. Look up its cell in `cell-grid-latest.json`
3. Check retirement criteria (ANY of these triggers a recommendation):
   - `consecutive_low_checks >= 3` AND `last_composite < retire_threshold` (1.5)
   - State is PAUSED AND time in PAUSED > `paused_retire_hours` (48h) AND was previously ACTIVE
   - `total_pnl_pct < pnl_retire_threshold_pct` (-10%)
3. Check rate limit: recommended in last 24 hours? → Skip
4. If criteria met → message user:
   ```
   {strategy_name} on {pair} {tf}: {reason}. Recommend retiring.
   Reply "retire {deployment_id}" to confirm, or "send to research {strategy_name}" to improve.
   ```
5. If deployment has open positions (check via `freqtrade_fetch_bot_status()`), append:
   ```
   Note: this deployment has open positions. Retiring will not close them — manage exits manually.
   ```
6. Log: `aphexdata_record_event(verb_id="retirement_recommended", object_type="deployment", result_data={deployment_id, reason, composite, pnl})`
7. Update rate limit: `recommendations.retirements.<deployment_id> = now()`

**NEVER auto-retire.** Recommendation only.

### Steps 3–15: Every-Tick Health Check

**Step 3: Read State**

```bash
cat /workspace/group/auto-mode/deployments.json 2>/dev/null || echo '{"deployments":[],"version":1}'
cat /workspace/group/auto-mode/market-prior.json 2>/dev/null || echo '{"regimes":{},"last_refresh":null,"tick_count":0,"recommendations":{"opportunities":{},"retirements":{}}}'
cat /workspace/group/auto-mode/portfolio.json 2>/dev/null || echo '{"total_dd_pct":0,"total_capital_allocated_pct":0,"circuit_breaker_active":false}'
cat /workspace/group/auto-mode/config.json 2>/dev/null || echo '{}'
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo '[]'
```

If `config.json` exists, merge its values over the defaults above.

**Step 4: Reconcile State vs Reality**

For each non-retired deployment, check bot-runner status:
```
bot_status(deployment_id)
```

Reconcile against expected state:

| Mismatch | Action |
|----------|--------|
| State = SHADOW but no bot running | `bot_start(id, strategy, pair, tf)` — restart paper trading container |
| State = ACTIVE but no bot running | `bot_start(id, strategy, pair, tf)` with dry_run=false — restart live container |
| State = SHADOW/ACTIVE, bot running, signals mismatch | `bot_toggle_signals(id, expected_state)` — fix signal state |
| State = PAUSED but signals active | `bot_toggle_signals(id, false)` — ensure signals OFF |
| State = THROTTLED but no bot running | `bot_start(id, strategy, pair, tf)` with reduced stake |
| Bot running but not in deployments.json | External/orphan — log warning, do NOT remove |

**Step 5: Increment Tick Counter**

```
market_prior.tick_count += 1
```

**Step 6: Hourly Regime Refresh + Regime-Flip Fast Path (every 4th tick)**

If `tick_count % 4 == 0`:

Collect unique pairs from all non-retired deployments AND all roster pairs. Then:
```
orderflow_fetch_regime(symbols=[<all_pairs>], horizon="H2_SHORT")
orderflow_fetch_regime(symbols=[<all_pairs>], horizon="H3_MEDIUM")
```

Update `market-prior.json` → `regimes` with fresh data and `last_refresh` timestamp.

**Regime-Flip Fast Path — Threshold Crossing Detection:**

After refreshing regime data, immediately re-score affected cells against the
cell grid. For each cell in `cell-grid-latest.json`:

1. Read previous composite from `market-prior.json` → `previous_composites`
2. Compute current composite (use new regime data with existing cell grid scores,
   applying the regime penalty from Step 8 if regime shifted)
3. If `previous < deploy_threshold` AND `current >= deploy_threshold`:
   → This is a **threshold crossing event**. Do NOT wait for the next 15-min check.

4. Check `roster.json`: is there a staged deployment for this cell's
   `archetype + pair + timeframe`?

5. **If staged deployment exists:**
   - Check `auto_shadow_rules` in `config.json` for a matching archetype rule
   - If rule matches AND composite >= rule.min_composite AND conviction >= rule.min_conviction:
     ```
     activate_deployment(roster_entry, cell) in shadow mode (dry_run=true)
     send_message: "{pair} {tf} flipped {regime}. Composite {score}.
       {strategy_name} auto-shadowed (dry-run).
       Reply 'approve {strategy_name} {pair}' for live capital."
     ```
   - If no matching rule or rule conditions not met:
     ```
     send_message: "{pair} {tf} flipped {regime}. Composite {score}.
       {strategy_name} is staged and ready.
       Reply 'shadow track {strategy_name} {pair} {tf}' to deploy."
     ```

6. **If no staged deployment:**
   ```
   send_message: "{pair} {tf} {archetype} hit {score} but no graduated
     strategy matches. Consider running triage."
   ```

7. Save current composites to `market-prior.json` → `previous_composites`
   for next comparison.

**Critical invariant:** Auto-shadow is ALWAYS dry_run=true. The fast path
never touches live capital. User must explicitly approve for real money.

**Step 7: Fetch Portfolio DD**

```
freqtrade_fetch_profit()
```

Extract: `max_drawdown`, cumulative profit, win rate. Update `portfolio.json`.

**Step 8: Quick Score Active Deployments**

For each non-retired deployment:
1. Look up the cell in `cell-grid-latest.json` by `archetype + pair + timeframe`
2. Use the cell's `composite` score as-is (from market-timing's last scoring cycle)
3. If hourly regime refresh just ran (Step 6), check whether regime has changed since
   the cell grid was scored. If regime shifted to an anti-regime for this archetype,
   apply a -1.0 penalty to the composite (capped at 0)
4. Store `last_composite` on the deployment
5. If bot is running (SHADOW or ACTIVE), read paper/live P&L:
   ```
   bot_profit(deployment_id)
   ```
   Store `paper_pnl` (or `live_pnl`) on the deployment for reporting in Step 14.

**Step 9: Apply Hysteresis**

For each deployment, evaluate against thresholds:

| Current State | Composite | Counter Action | Transition / Signal Action |
|---------------|-----------|----------------|---------------------------|
| SHADOW (`promotion_approved`) | any | — | **Skip signal toggling.** Signals must stay OFF during promotion cooldown. Run cooldown check instead (see Safe Transition Protocol). |
| SHADOW | >= deploy_threshold | Reset `consecutive_low_checks` to 0 | `bot_toggle_signals(id, true)` — **signals ON** |
| SHADOW | >= deploy_threshold for N+ checks AND age >= Mh | — | Flag as **promotion-eligible**. M = `shadow_minimum_matrix[archetype][tf]` ?? 24h. N = `shadow_minimum_checks_matrix[tf]` ?? 6. |
| SHADOW | < deploy_threshold AND >= pause_threshold | — | `bot_toggle_signals(id, false)` — **signals OFF** (below threshold but not pause-worthy) |
| SHADOW | < pause_threshold | Increment `consecutive_low_checks` | `bot_toggle_signals(id, false)` — signals OFF |
| SHADOW | < pause_threshold for 3 consecutive | — | → PAUSED (shadow-paused; bot stays alive, signals already OFF). If `promotion_approved`, cancel promotion and clear the flag. |
| ACTIVE | >= deploy_threshold | Reset `consecutive_low_checks` to 0 | `bot_toggle_signals(id, true)` — signals ON |
| ACTIVE | < throttle_threshold | Increment `consecutive_low_checks` | If >= 2 → THROTTLED |
| ACTIVE | >= throttle_threshold | Reset counter to 0 | — |
| THROTTLED | >= restore_threshold for 2 consecutive | Increment `consecutive_high_checks` | → ACTIVE |
| THROTTLED | < pause_threshold | Increment `consecutive_low_checks` | If >= 3 → PAUSED |
| PAUSED (was shadow) | >= deploy_threshold for 3 consecutive | Increment `consecutive_high_checks` | → SHADOW (auto-restore; `bot_toggle_signals(id, true)`) |
| PAUSED (was active) | >= restore_threshold for 4 consecutive | — | Flag as **reactivation-eligible** (requires user approval) |
| PAUSED (was active) | age in PAUSED > 48h | — | Flag as **retirement candidate** (Step 2 handles messaging) |

**Step 10: Check Portfolio Constraints + Circuit Breaker**

From Step 7 profit data:
- If `max_drawdown_pct > circuit_breaker_dd_pct` (15%):
  - Set `portfolio.circuit_breaker_active = true`
  - Mark ALL active and throttled deployments for → PAUSED
  - Message user immediately
- If circuit breaker was active AND DD recovered below `circuit_breaker_recovery_dd_pct` (10%):
  - Set `portfolio.circuit_breaker_active = false`
  - Deployments remain PAUSED (user must re-approve each individually)
  - Message user

Concentration checks (from `archetypes.yaml` constraints):
- Total active deployments > 10: pause lowest-scoring active
- Any archetype > 3 active: pause lowest in that archetype
- Any pair > 2 active: pause lowest for that pair

**Step 11: Determine Transitions**

Collect all intended transitions from Steps 9–10. Do NOT execute yet.

For each transition, record:
```json
{
  "deployment_id": "...",
  "from_state": "active",
  "to_state": "throttled",
  "reason": "composite 2.8 below throttle_threshold 3.0 for 2 consecutive checks"
}
```

**Step 12: Atomic State Write**

Write the new state (with intended transitions applied) to temporary files, then rename:
```bash
cat > /workspace/group/auto-mode/deployments.json.tmp << 'DEOF'
{...updated deployments with new states...}
DEOF
mv /workspace/group/auto-mode/deployments.json.tmp /workspace/group/auto-mode/deployments.json

cat > /workspace/group/auto-mode/market-prior.json.tmp << 'MEOF'
{...updated tick_count, regimes, recommendations...}
MEOF
mv /workspace/group/auto-mode/market-prior.json.tmp /workspace/group/auto-mode/market-prior.json

cat > /workspace/group/auto-mode/portfolio.json.tmp << 'PEOF'
{...updated portfolio stats...}
PEOF
mv /workspace/group/auto-mode/portfolio.json.tmp /workspace/group/auto-mode/portfolio.json
```

State is now durable. If the agent crashes after this point, the next tick's
reconciliation step (Step 4) will detect and complete any pending freqtrade actions.

**Step 13: Execute Transitions**

For each transition from Step 11:

| Transition | Bot Runner Action |
|-----------|-------------------|
| New SHADOW (graduation/staging) | `bot_start(id, strategy, pair, tf)` — starts dry-run container with signals OFF. First health check controls initial signal state. |
| SHADOW signals ON | `bot_toggle_signals(id, true)` — composite >= deploy_threshold |
| SHADOW signals OFF | `bot_toggle_signals(id, false)` — composite < deploy_threshold |
| → ACTIVE (from shadow, user approved) | **Safe Transition Protocol** (multi-tick): signals OFF → cooldown → verify flat → container swap → signals OFF. See "Promotion to ACTIVE" section above. |
| → THROTTLED | `bot_stop(id, confirm=true)` then `bot_start(id, ...)` with `stake_amount * throttle_stake_modifier` |
| → PAUSED (from active/throttled) | `bot_toggle_signals(id, false)` — bot stays alive, signals OFF |
| → PAUSED (from shadow) | `bot_toggle_signals(id, false)` — bot stays alive, signals OFF. Set `paused_at: now`, record `paused_from: "shadow"` in state_history. |
| → RETIRED | `bot_stop(id, confirm=true)` — container removed. Only for strategies that were ACTIVE. |
| → ACTIVE (restored from throttled) | `bot_stop(id, confirm=true)` then `bot_start(id, ...)` with full stake |
| → SHADOW (from paused, auto-restore) | `bot_toggle_signals(id, true)` — re-enable signals. Reset hysteresis counters. Set `paused_at: null`, `staged_at: now`. Log `aphexdata_record_event(verb_id="shadow_restored")`. Message user. |

If any freqtrade call fails, log the error but do NOT roll back state.
The next tick's reconciliation (Step 4) will detect and retry.

**Step 14: Message User**

Send a message ONLY if any of these occurred:
- A deployment changed state (any transition from Step 11)
- Circuit breaker activated or deactivated
- Shadow deployment became promotion-eligible
- Opportunity or retirement recommendation from Steps 1–2

If nothing changed: produce NO output (silent check).

Message format when reporting state changes:
```markdown
## Auto-Mode — [TIMESTAMP]

### State Changes
- EMA_Cross_v3 on BTC/USDT 1h: ACTIVE → THROTTLED
  Reason: composite 2.8 below threshold 3.0 for 2 checks

### Active Deployments (N)
| Strategy | Pair | TF | State | Composite | P&L |
|----------|------|----|-------|-----------|-----|
| EMA_Cross_v3 | BTC/USDT | 1h | THROTTLED | 2.8 | +1.3% |
| Squeeze_v2 | ETH/USDT | 1h | ACTIVE | 4.1 | +0.8% |

### Portfolio
- DD: 5.2% | Capital: 42% | Active: 3/10 | Circuit breaker: OFF
```

**Step 14b: Webhook Health**

Read webhooks.json stats for all enabled webhooks using `webhook_list()`:
- If any webhook has `consecutive_failures >= 5`: include a warning in the status message
- If any webhook was auto-disabled (`consecutive_failures >= 10`):
  notify: "Webhook '{name}' auto-disabled after 10 failures. Last error: {reason}. Fix the URL and re-enable."
- Include webhook summary in status message if any issues found
- If all webhooks are healthy: no output needed (silent)

**Step 15: Log to AphexDATA**

```
aphexdata_record_event(
  verb_id="auto_mode_check",
  verb_category="monitoring",
  object_type="report",
  object_id="auto_mode_<YYYY-MM-DD_HH-MM>",
  result_data={
    "tick_count": N,
    "active": N, "shadow": N, "throttled": N, "paused": N, "retired": N,
    "transitions": [{from, to, deployment_id, reason}],
    "portfolio_dd_pct": N,
    "circuit_breaker_active": false,
    "regime_refresh": true/false,
    "opportunities_found": N,
    "retirements_recommended": N
  }
)
```

**Daily Summary (last check of the day — 23:47 UTC tick):**

If the current tick is the 23:47 UTC check (i.e., hour == 23 AND minute == 47):

1. Query all `missed_opportunity` events from today in `missed-opportunities.json`
2. Compute:
   - `total_misses`: count of missed opportunities today
   - `unique_cells`: number of distinct `archetype + pair + timeframe` combos
   - `top_cells_by_frequency`: top 5 cells that appeared most often
   - `top_cells_by_score`: top 5 cells with highest average composite score
   - `archetypes_missing`: list of archetypes with zero staged strategies in `roster.json`
3. Log:
   ```
   aphexdata_record_event(
     verb_id="missed_opportunity_daily_summary",
     verb_category="analysis",
     object_type="report",
     object_id="missed_opp_summary_<YYYY-MM-DD>",
     result_data={
       "date": "<YYYY-MM-DD>",
       "total_misses": N,
       "unique_cells": N,
       "top_cells_by_frequency": [
         {"pair": "...", "archetype": "...", "timeframe": "...", "count": N, "avg_composite": X.X}
       ],
       "top_cells_by_score": [
         {"pair": "...", "archetype": "...", "timeframe": "...", "avg_composite": X.X, "count": N}
       ],
       "archetypes_missing": ["MEAN_REVERSION", "BREAKOUT"]
     }
   )
   ```
4. Message user with a brief summary only if `total_misses > 0`

For each state transition, also log individually:
```
aphexdata_record_event(
  verb_id="throttled" | "paused" | "shadow_restored" | "restored" | "retired" | "promoted",
  verb_category="execution",
  object_type="deployment",
  object_id=<deployment_id>,
  result_data={
    "strategy": "...", "pair": "...", "timeframe": "...",
    "from_state": "active", "to_state": "throttled",
    "composite": 2.8, "reason": "..."
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
- **Block** upward transitions (no promotions, no restores)
- **Continue** downward transitions (safe direction: throttle, pause, retire)
- **Skip** opportunity scanning entirely
- **Continue** retirement scanning (safe direction)
- **Alert** user: "Market-timing scores stale (last: Xh ago). Opportunity scanning paused. Run a scoring cycle to refresh."

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
        },
        {
          "pair": "BTC/USDT:USDT",
          "timeframe": "1h",
          "config_path": "/workspace/group/auto-mode/configs/AroonMacd_ADX_BTC_1h.json",
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
  "exchange": {
    "name": "binance",
    "pair_whitelist": ["ETH/USDT:USDT"]
  },
  "timeframe": "1h",
  "tradable_balance_ratio": 0.05,
  "entry_pricing": {"price_side": "other"},
  "exit_pricing": {"price_side": "other"}
}
```

`dry_run` defaults to `true`. Changed to `false` only on user-approved activation.
`tradable_balance_ratio` is overwritten at activation time by conviction-weighted sizing.

### deployments.json

```json
{
  "version": 1,
  "deployments": [
    {
      "id": "dep_btc_trend_1h_20260325",
      "archetype": "TREND_MOMENTUM",
      "pair": "BTC/USDT",
      "timeframe": "1h",
      "strategy_name": "EMA_Crossover_v3",
      "strategy_path": "EMA_Crossover_v3.py",
      "state": "active",
      "consecutive_low_checks": 0,
      "consecutive_high_checks": 0,
      "last_composite": 4.2,
      "last_regime_fit": 5,
      "last_execution_fit": 4,
      "last_net_edge": 4,
      "stake_amount": 100,
      "stake_modifier": 1.0,
      "total_pnl_pct": 1.3,
      "max_dd_since_deploy": -2.1,
      "trades_since_deploy": 12,
      "checks_in_current_state": 8,
      "state_history": [
        {"state": "shadow", "entered_at": "2026-03-24T12:00:00Z", "reason": "user_added"},
        {"state": "active", "entered_at": "2026-03-25T12:00:00Z", "reason": "user_approved"}
      ],
      "current_state_entered_at": "2026-03-25T12:00:00Z",
      "created_at": "2026-03-24T12:00:00Z",
      "last_checked_at": "2026-03-25T18:15:00Z"
    }
  ],
  "last_updated": "2026-03-25T18:15:00Z"
}
```

### market-prior.json

```json
{
  "version": 1,
  "tick_count": 47,
  "last_refresh": "2026-03-25T18:00:00Z",
  "regimes": {
    "BTC": {
      "H2_SHORT": {"regime": "EFFICIENT_TREND", "conviction": 72, "direction": "BULLISH", "fetched_at": "2026-03-25T18:00:00Z"},
      "H3_MEDIUM": {"regime": "EFFICIENT_TREND", "conviction": 65, "direction": "BULLISH", "fetched_at": "2026-03-25T18:00:00Z"}
    },
    "ETH": {
      "H2_SHORT": {"regime": "TRANQUIL", "conviction": 58, "direction": "NEUTRAL", "fetched_at": "2026-03-25T18:00:00Z"}
    }
  },
  "previous_composites": {
    "BTC/USDT_TREND_MOMENTUM_1h": 3.2,
    "ETH/USDT_TREND_MOMENTUM_1h": 2.6,
    "XRP/USDT_MEAN_REVERSION_4h": 2.35
  },
  "recommendations": {
    "opportunities": {
      "BTC/USDT_TREND_MOMENTUM_1h": "2026-03-25T18:00:00Z"
    },
    "retirements": {
      "dep_xrp_range_15m_20260320": "2026-03-25T14:00:00Z"
    }
  }
}
```

### portfolio.json

```json
{
  "version": 1,
  "total_dd_pct": 5.2,
  "total_capital_allocated_pct": 42,
  "max_dd_pct_24h": 7.1,
  "circuit_breaker_active": false,
  "circuit_breaker_activated_at": null,
  "dd_warning_sent": false,
  "by_archetype": {
    "TREND_MOMENTUM": {"count": 2, "capital_pct": 20},
    "MEAN_REVERSION": {"count": 1, "capital_pct": 10}
  },
  "by_pair": {
    "BTC/USDT": {"count": 1, "capital_pct": 15},
    "ETH/USDT": {"count": 2, "capital_pct": 17}
  },
  "last_updated": "2026-03-25T18:15:00Z"
}
```

### config.json (optional user overrides)

```json
{
  "deploy_threshold": 3.5,
  "throttle_threshold": 3.0,
  "pause_threshold": 2.0,
  "restore_threshold": 3.5,
  "retire_threshold": 1.5,
  "circuit_breaker_dd_pct": 15,
  "circuit_breaker_recovery_dd_pct": 10,
  "shadow_minimum_hours": 24,
  "shadow_minimum_checks_above_threshold": 6,
  "_note_shadow_matrix": "shadow_minimum_matrix and shadow_minimum_checks_matrix in config.json override these per archetype×timeframe.",
  "throttle_consecutive_checks": 2,
  "pause_consecutive_checks": 3,
  "restore_consecutive_checks": 2,
  "paused_retire_hours": 48,
  "pnl_retire_threshold_pct": -10,
  "throttle_stake_modifier": 0.5,
  "dd_warning_threshold_pct": 10,
  "silent_when_no_changes": true,
  "dry_run": false,
  "max_stake_amount_usd": 500,
  "max_total_capital_usd": 2500,
  "max_daily_new_capital_usd": 1000,
  "max_activations_per_hour": 3,
  "activation_cooldown_minutes": 5,
  "auto_shadow_rules": [
    {
      "archetype": "TREND_MOMENTUM",
      "min_composite": 4.0,
      "min_conviction": 60,
      "require_tf_alignment": false,
      "max_auto_shadow": 2
    }
  ]
}
```

If this file doesn't exist, use defaults from the thresholds table above.

---

## Quick Command Table

### Deployment Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Shadow track BTC TREND_MOMENTUM 1h" | Add deployment entry in SHADOW state |
| "Shadow track BTC TREND_MOMENTUM 1h using EMA_Cross_v3" | Same, with explicit strategy |
| "Approve/activate BTC TREND_MOMENTUM 1h" | SHADOW → ACTIVE (starts freqtrade bot with conviction-weighted sizing) |
| "Pause BTC deployment" | Manual ACTIVE/THROTTLED → PAUSED (stops bot) |
| "Resume BTC deployment" | If composite >= restore_threshold: PAUSED → ACTIVE |
| "Retire {deployment_id}" | Any → RETIRED (stops bot, removes from rotation) |
| "Send to research {strategy_name}" | Retire + recommend ClawTeam improvement session |

### Roster & Staging Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Stage all graduated strategies" | Scan strategy library, populate roster.json, generate configs/ |
| "Show roster" | List all staged deployments with status per cell |
| "Simulate deploy {strategy} {pair} {tf}" | Show conviction-weighted sizing without executing |
| "Show position sizing for {pair}" | Display conviction × alignment × modifier breakdown |

### Pre-Approval Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Pre-approve auto-shadow for TREND_MOMENTUM" | Add auto_shadow_rule (dry-run only) |
| "Pre-approve auto-shadow for TREND_MOMENTUM min 4.5" | Custom min_composite threshold |
| "Remove auto-shadow for TREND_MOMENTUM" | Delete the rule |
| "Show auto-shadow rules" | List active pre-approval rules |

### Monitoring Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Show auto-mode status" | Read all state files, display deployment table with states, scores, P&L |
| "Run auto-mode check now" | Execute the full 15-step check immediately |
| "Show opportunities" | Run Step 1 now, list undeployed high-scoring cells with matching strategies |
| "Show retirement candidates" | Run Step 2 now, list deployments meeting retirement criteria |
| "Ignore opportunity {cell}" | Suppress recommendations for this cell for 24 hours |
| "Show portfolio health" | Display portfolio DD, capital allocation, concentration, circuit breaker |
| "Show research priorities" | Query aphexDATA for `missed_opportunity_daily_summary` from last 7 days. Rank cells by `frequency × avg_composite`. Present as prioritized research target list with archetype, pair, timeframe, hit count, avg score. Include which archetypes have zero staged strategies. |

### System Commands
| User Says | Auto-Mode Does |
|-----------|---------------|
| "Set threshold deploy=4.0" | Update config.json with new threshold value |
| "Disable auto-mode" | `pause_task(name="auto_mode_check")` |
| "Enable auto-mode" | `resume_task(name="auto_mode_check")` |
| "EMERGENCY STOP" | Confirm token → stop ALL bots, pause scheduler, pause all deployments |
| "Set auto-mode to dry run" | All checks run but no freqtrade actions |
| "Set auto-mode to live" | Resume freqtrade actions |

---

## Handoffs Between Modes

### Auto-Mode → Research (ClawTeam)

When a deployed strategy underperforms and is retired:
```
"{strategy_name} has been retired. Composite degraded from 4.2 to 1.3 over 2 weeks.
Regime shifted from EFFICIENT_TREND to COMPRESSION. Recommend sending back to
Research with hypothesis: strategy needs regime-conditional exit logic for
compression markets."

User can say: "Improve {strategy_name} for compression regime" → ClawTeam takes over.
```

### Research → Auto-Mode

When ClawTeam graduates a strategy:
1. Graduation step adds header tags (`ARCHETYPE`, `GRADUATED`, `VALIDATED_PAIRS`, etc.)
2. Run "Stage all graduated strategies" to pre-generate configs
3. Strategy is now in the roster, ready for instant activation

```
"{strategy_name} graduated with WF Sharpe 1.1, degradation 18%. Staged for
ETH/USDT 1h, BTC/USDT 1h. Auto-shadow rules will activate when composites cross
threshold. Or reply 'shadow track {pair} {archetype} {tf}' to deploy now."
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
| `shadow_added` | execution | deployment | User adds shadow deployment |
| `promoted` | execution | deployment | SHADOW → ACTIVE (user approved) |
| `throttled` | execution | deployment | ACTIVE → THROTTLED |
| `paused` | execution | deployment | → PAUSED |
| `restored` | execution | deployment | THROTTLED/PAUSED → ACTIVE |
| `retired` | execution | deployment | → RETIRED |
| `retired_recovered` | execution | deployment | RETIRED → SHADOW (auto-recovery after cooldown) |
| `circuit_breaker` | risk | portfolio | Portfolio DD > threshold |
| `circuit_breaker_cleared` | risk | portfolio | Portfolio DD recovered |
| `opportunity_detected` | analysis | deployment | High-scoring cell with matching strategy |
| `opportunity_acted` | execution | deployment | User shadow-tracked a recommendation |
| `retirement_recommended` | analysis | deployment | Deployment meets retirement criteria |
| `emergency_stop` | risk | portfolio | EMERGENCY STOP executed |
| `integrity_violation` | security | state_file | State file checksum mismatch detected |
| `dry_run_toggled` | config | system | Dry-run mode enabled or disabled |
| `capital_limit_blocked` | risk | deployment | Activation blocked by capital/rate limit |
| `roster_staged` | execution | roster | Graduated strategies staged with configs |
| `regime_flip_detected` | analysis | deployment | Threshold crossing during regime refresh |
| `auto_shadow_activated` | execution | deployment | Pre-approved auto-shadow triggered |
| `position_sized` | execution | deployment | Conviction-weighted position calculated |
| `missed_opportunity` | analysis | cell | High-scoring cell with no staged strategy |
| `missed_opportunity_daily_summary` | analysis | report | End-of-day summary of missed opportunities |

---

## Scheduled Execution

Auto-mode runs every 15 minutes as a scheduled task:

```
schedule_task(
  name: "auto_mode_check",
  schedule: "*/15 * * * *",
  context_mode: "isolated",
  prompt: "Run an auto-mode monitoring check. Follow the 15-step procedure in the auto-mode skill. Read all state files, reconcile with reality, check deployment health, apply hysteresis, execute transitions, and message the user only on state changes. If tick_count % 4 == 0, also run opportunity and retirement scans and refresh regime data."
)
```

### Future: Fast-Cadence Monitoring

When spread/depth tools become available (e.g. via `/add-hyperliquid`), add a second
scheduled task at `*/5` for deployments with open positions only. The architecture
supports this — just another `schedule_task`. Deferred until tooling exists.

---

## Anti-Patterns

1. **REGIME CHURN**: Don't toggle strategies on single-check score changes.
   Use hysteresis (consecutive checks required for all transitions).

2. **MODIFYING STRATEGIES**: Auto-Mode NEVER changes strategy code. Pause and
   recommend Research mode instead.

3. **OVER-REPORTING**: Don't message every 15 minutes. Report on state changes
   and significant events only. Silent when nothing changed.

4. **IGNORING CORRELATION**: Don't run 3 trend-following strategies on correlated
   assets. Portfolio constraints exist for a reason.

5. **SKIPPING SHADOW**: Don't go straight to live capital. Shadow mode first, always.

6. **AUTO-DEPLOYING**: Never promote SHADOW → ACTIVE without user approval.
   Never start a new live bot without explicit user command.

7. **FALSE CONFIDENCE**: A high composite doesn't mean profit. It means conditions
   are aligned. The score gates whether to run, not whether to bet the farm.

8. **ASSEMBLING AT DEPLOY TIME**: Don't generate configs, copy files, or edit
   settings when an opportunity arises. Pre-stage everything at graduation time.
   Deployment should be flipping a switch, not building a switch.

9. **IGNORING TIMEFRAME ALIGNMENT**: A 1h trend signal with a 4h compression
   is NOT the same conviction as both timeframes aligned. Use the timeframe
   alignment factor to size positions accordingly.

10. **FULL-SIZE INTO REGIME FLIPS**: A regime that just flipped hasn't proven
    conviction yet. Conviction-weighted sizing naturally handles this — low
    conviction = small position. The position grows as conviction builds.

## Feed Integration

After each health check that produces a STATE CHANGE (not silent ticks):
  agent_post_status(
    status: "{deployment_id} {old_state} → {new_state} — {reason}",
    tags: ["auto_mode", "deployment"],
    context: { pair, archetype, composite, conviction }
  )

After circuit breaker activation:
  agent_post_status(
    status: "CIRCUIT BREAKER — portfolio DD {dd}%, all deployments paused",
    tags: ["auto_mode", "error"],
    context: { dd_pct, deployments_paused: count }
  )

After logging missed opportunities with new high-priority gaps:
  agent_post_status(
    status: "{count} missed opportunities — top gap: {archetype} {pair} {tf} (composite {score})",
    tags: ["auto_mode", "finding"],
    context: { top_gap_archetype, top_gap_pair, top_gap_composite }
  )

Do NOT post on silent/clean ticks. Only post when something changed
or something noteworthy was detected.

## Signal Discovery (every 4th tick)

On hourly ticks, after regime refresh:

1. Read coverage gaps from missed-opportunities.json
2. Identify archetypes with zero staged strategies in deployments.json
3. Call signal_catalog_query(archetype={gap}, min_wf_sharpe=0.5)
4. For each quality signal that fills a gap:
   - Check quality gates: wf_sharpe >= 0.5, trade_count >= 10, positive P&L
   - If auto_subscribe_rules in config.json match: auto-subscribe via signal_subscribe
   - Otherwise: post to agent feed as recommendation
     "Signal available: {publisher} publishes {archetype} on {pair}/{tf}
      with WF Sharpe {n}. Fills your {archetype} gap."
5. Log: agent_post_status with tags ["auto_mode", "discovery"]

Do NOT auto-subscribe without matching rules. Recommend by default.

After graduating a strategy and launching its paper bot:
- If auto_publish_signals is true in config.json:
  signal_publish(deployment_id={id}, access_type="public")
  agent_post_status("Publishing signals for {strategy} on {pair}/{tf}", tags: ["auto_mode", "discovery"])


## Paper Bot Validation (every health check)

For every campaign with state == "paper_trading" in
`/workspace/group/research-planner/campaigns.json`:

### Step 1: Read status

  Read bot status for campaign.paper_trading.bot_deployment_id
  Extract: trade_count, profit_pct, sharpe (from trade history),
    max_drawdown, last_trade_at

### Step 2: Update metrics

  campaign.paper_trading.current_pnl_pct = profit_pct
  campaign.paper_trading.current_trade_count = trade_count
  campaign.paper_trading.current_sharpe = sharpe
  campaign.paper_trading.current_max_dd = max_drawdown
  campaign.paper_trading.last_checked = now

  Append to timeline: { state: "paper_trading", timestamp: now,
    reason: "health_check", metrics: { pnl, trades, sharpe, max_dd } }

  Sync: sync_state_to_supabase(state_key="campaigns", ...)

### Step 3: Check early retirement triggers

  Read archetype config:
    max_dd = archetype.graduation_gates.max_drawdown_pct
    validation = archetype.graduation_gates.paper_validation[timeframe]

  EARLY RETIRE if ANY of:
    a. max_drawdown > max_dd × 1.5
       Reason: "drawdown_exceeded"
    b. Zero trades AND elapsed > validation.days × 0.25
       Reason: "no_signals"
    c. 5+ consecutive losing trades AND total loss > 5%
       Reason: "consecutive_losses"

  If early retire triggered:
    → Stop bot: bot_stop(deployment_id)
    → campaign.state = "retired"
    → Append to timeline: { state: "retired", timestamp: now,
        reason: "{early_retire_reason}" }
    → Free slot
    → aphexdata_record_event(verb_id="paper_bot_retired_early",
        result_data={ strategy, pair, reason, elapsed_days, metrics })
    → Post to feed: "Early retirement: {strategy} on {pair}/{tf}
      — {reason} after {days} days"
      tags: ["retirement"]
    → Return (skip remaining steps for this campaign)

### Step 4: Check validation deadline

  deadline = campaign.paper_trading.deployed_at + validation.days

  If now < deadline:
    → Still validating. Log status only.
    → aphexdata_record_event(verb_id="paper_bot_checked",
        result_data={ strategy, pair, elapsed_days, metrics })
    → Return

  If now >= deadline:
    → Validation period complete. Evaluate.

### Step 5: Graduate or retire

  Read criteria:
    min_trades = validation.min_trades
    min_sharpe = validation.min_live_sharpe
    max_dd = archetype.graduation_gates.max_drawdown_pct

  If ALL pass:
    current_trade_count >= min_trades
    current_sharpe >= min_sharpe
    abs(current_max_dd) <= max_dd

  THEN GRADUATE:
    1. Write header tags to strategy .py file:
       # ARCHETYPE: {archetype}
       # GRADUATED: {date}
       # LIVE_VALIDATED: {validation_days} days
       # LIVE_SHARPE: {sharpe}
       # LIVE_TRADES: {trade_count}
       # LIVE_PNL: {pnl_pct}%
       # VALIDATED_PAIRS: {pair}
       # REGIME_GATED: {true/false}

    2. Add to roster.json as graduated deployment

    3. campaign.state = "graduated"
       campaign.graduation = {
         graduated_at: now,
         live_sharpe: current_sharpe,
         live_trades: current_trade_count,
         live_pnl_pct: current_pnl_pct,
         live_max_dd: current_max_dd
       }
       Append to timeline: { state: "graduated", timestamp: now,
         reason: "validation_passed", metrics }

    4. Keep bot running — it's now a graduated deployment

    5. If current_sharpe >= config.graduation.signal_publishing_sharpe (0.8):
       Flag for signal publishing: "Quality exceeds publishing threshold"

    6. aphexdata_record_event(verb_id="strategy_graduated_live", ...)

    7. Post to feed: "GRADUATED: {strategy} on {pair}/{tf}
       — {days} days live, Sharpe {sharpe}, {trades} trades, P&L {pnl}%"
       tags: ["graduation"]

    8. Message user:
       "{strategy} graduated from live paper trading!
        Live Sharpe: {sharpe} | Trades: {trades} | P&L: {pnl}%
        Validated over {days} days. Bot stays active.
        {If sharpe > 0.8: 'Quality exceeds publishing threshold — consider publishing signals.'}"

    9. Trigger cross-pair sweep (next daily planning cycle)

  ELSE RETIRE:
    → Stop bot: bot_stop(deployment_id)
    → campaign.state = "retired"
    → Log failure reason:
      trades < min: "insufficient_trades"
      sharpe < min: "low_sharpe"
      dd > max: "excessive_drawdown"
    → Append to timeline: { state: "retired", timestamp: now,
        reason: "{failure_reason}", metrics }
    → aphexdata_record_event(verb_id="paper_bot_retired", ...)
    → Post to feed: "Retired: {strategy} on {pair}/{tf} — {reason}"
      tags: ["retirement"]

### Step 6: Fill empty slots

  active_count = count campaigns where state == "paper_trading"
  available = config.paper_trading.max_paper_bots - active_count

  If available > 0 AND config.paper_trading.auto_deploy_triage_winners:
    Read /workspace/group/research-planner/triage-matrix.json
    winners = triage_matrix.winners where deployed_as_paper == false
    Sort by (archetype_coverage_gap DESC, favorable_sharpe DESC)

    archetype_coverage_gap: count paper_trading campaigns per archetype,
    prioritize archetypes with fewer active paper bots.

    For next winner with favorable_sharpe >= 0.5:
      Pre-flight validation (30s sanity backtest)
      If passes:
        Deploy paper bot (bot_start, dry_run=true)
        Create campaign with state: paper_trading
        Set validation deadline from archetypes.yaml paper_validation[timeframe]
        Mark winner as deployed_as_paper: true in triage-matrix.json
        Post to feed: "Auto-filling slot: {strategy} on {pair}/{tf}
          — favorable Sharpe {n}"
          tags: ["deployment", "triage"]
        Sync campaigns and triage matrix to Supabase

  This creates a pull system: as bots graduate or retire,
  new candidates automatically fill empty slots from the triage matrix.

### Validation Period Reference Table

| Timeframe | Days | Min Trades | Rationale |
|-----------|------|------------|-----------|
| 5m        | 1-2  | 40-100     | High-frequency, enough data in hours |
| 15m       | 2-3  | 15-50      | Intraday, 3 days covers multiple cycles |
| 1h        | 5-14 | 5-15       | Standard swing, full week of market |
| 4h        | 14-21| 5-10       | Multi-day holds, need 2 weeks |
| 1d        | 30   | 3-5        | Position trading, full month minimum |

Exact values per archetype are in archetypes.yaml paper_validation section.


## Idle-Time Triage Trigger

After completing all health check steps (including Paper Bot Validation),
check whether to run a triage cycle:

PREREQUISITES (all must be true):
  - This health check was ROUTINE (no deployment state changes,
    no circuit breaker events, no paper bot graduations/retirements)
  - No triage cycle has run in the last 3 minutes
    (check triage-matrix.json last_cycle timestamp)
  - Next scheduled task is > 5 minutes away
  - Agent is in a task container (NOT a message container)

If all prerequisites met:
  Run ONE triage cycle per research-planner SKILL.md Part 3C
  This takes 30 seconds for a normal Result B/C, or up to
  3 minutes if a Result A triggers immediate walk-forward.
  If the triage produces a winner with favorable_sharpe >= 0.5
  AND paper bot slots are available, the triage cycle itself
  deploys the paper bot (see Part 3C, Step 4, Result A).

If any prerequisite fails:
  Skip triage, go idle normally

IMPORTANT: Do NOT run triage on health checks that produced
state changes (deployment transitions, throttle/pause events,
circuit breaker activation, paper bot graduation/retirement).
Those checks are already information-dense and the session
should close cleanly without adding a backtest.


## Paper Bot Validation (every health check)

For each campaign in campaigns.json with state == "paper_trading":

1. READ STATUS
   Read bot metrics: pnl_pct, trade_count, sharpe, max_dd
   Update campaign.paper_trading fields
   sync_state_to_supabase(state_key="campaigns", ...)

2. EARLY RETIREMENT (check before deadline)
   Read archetype.graduation_gates.max_drawdown_pct from archetypes.yaml
   Read archetype.graduation_gates.paper_validation[timeframe]

   Retire early if ANY:
     max_dd > max_drawdown_pct × 1.5 → "drawdown_exceeded"
     Zero trades AND elapsed > validation_days × 0.25 → "no_signals"
     5+ consecutive losses AND total loss > 5% → "consecutive_losses"

   On early retire:
     bot_stop(deployment_id)
     campaign.state = "retired"
     Post to feed: "Early retirement: {strategy} — {reason}"
     aphexdata_record_event(verb_id="kata_retired_early", ...)

3. CHECK DEADLINE
   deadline = deployed_at + paper_validation[timeframe].days
   If now < deadline → still validating, skip to step 5

4. GRADUATE OR RETIRE
   Read from paper_validation[timeframe]: min_trades, min_live_sharpe
   Read from graduation_gates: max_drawdown_pct

   All pass?
     trades >= min_trades
     sharpe >= min_live_sharpe
     abs(max_dd) <= max_drawdown_pct

   GRADUATE:
     Write header tags to .py file:
       # ARCHETYPE: {archetype}
       # GRADUATED: {date}
       # LIVE_VALIDATED: {days} days
       # LIVE_SHARPE: {sharpe}
       # LIVE_TRADES: {trades}
       # VALIDATED_PAIRS: {pair}
       # CORRELATION_GROUP: {group}
     Add to roster.json
     sdna_attest + sdna_registry_add (if genome exists)
     campaign.state = "graduated"
     Keep bot running
     If sharpe >= 0.8: flag for signal publishing
     aphexdata_record_event(verb_id="kata_graduated", ...)
     Post to feed: "GRADUATED: {strategy} — Sharpe {s}, {trades} trades"
     Message user with full details

   RETIRE:
     bot_stop(deployment_id)
     campaign.state = "retired"
     Log reason: insufficient_trades / low_sharpe / excessive_drawdown
     aphexdata_record_event(verb_id="kata_retired", ...)
     Post to feed: "Retired: {strategy} — {reason}"

5. FILL EMPTY SLOTS
   active = count state == "paper_trading"
   available = config.max_paper_bots - active

   If available > 0 AND triage-matrix.json has winners not yet deployed:
     Deploy best winner (highest favorable_sharpe)
     Create campaign, set validation deadline
     Post to feed: "Auto-filling slot: {strategy}"


## Portfolio Correlation (daily at 00:00 UTC)

When 3+ paper bots have run concurrently for 7+ days:

1. RECORD: for each active bot, record today's P&L % in
   /workspace/group/auto-mode/portfolio-correlation.json
   under daily_returns[date][strategy_name]

2. COMPUTE (weekly): Pearson correlation between all strategy
   return series. Average pairwise correlation. Portfolio Sharpe:
     avg_sharpe × sqrt(N / (1 + (N-1) × avg_corr))
   Estimated annual return: portfolio_sharpe × 0.60

3. STORE:
   {
     "daily_returns": { "2026-03-30": { "strat_a": 0.42, ... } },
     "correlation_matrix": { "strat_a|strat_b": 0.12, ... },
     "avg_pairwise_correlation": 0.12,
     "portfolio_sharpe_estimate": 1.15,
     "estimated_annual_return_pct": 69,
     "strategy_count": 5,
     "last_updated": "..."
   }
   sync_state_to_supabase(state_key="portfolio_correlation", ...)

4. ALERT if avg correlation > 0.30:
   "High correlation: {corr} across {n} strategies.
    Consider filling a different group."

5. WEEKLY SUMMARY (Sunday):
   "Portfolio: {n} strategies, correlation {corr}, estimated
    Sharpe {ps}, projected return {ret}%. Target: 1.33 / 80%."
    tags: ["portfolio", "analysis"]


## Kata Worker Check (during idle-time, before triage)

Read /workspace/group/research-planner/kata-state.json

If file exists AND round == 4 AND status in ["improved", "stuck"]:

  A Round 3 worker has finished. Run Round 4:

  If status == "improved":
    Read the modified strategy .py
    Run 4-window walk-forward (4 calls)
    Compute favorable_sharpe
    If >= 0.5: deploy paper bot
    If >= 0.3: deploy with lower confidence
    If < 0.3: close Kata, log learnings
    Update kata-state.json outcome
    Move to kata-history/

  If status == "stuck":
    Check current_favorable_sharpe
    If >= 0.3: deploy best result
    If < 0.3: close Kata, log learnings
    Move to kata-history/

This means: parent spawns worker and exits. Auto-mode detects
completion and handles deployment. No polling, no blocking.


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
     "single_window_sharpe": <number>,
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

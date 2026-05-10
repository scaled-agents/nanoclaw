---
name: monitor-deploy
description: >
  Slot-aware deployment allocation. Runs every 30 minutes: counts available
  slots, gathers candidates from kata graduates, roster, triage qualifiers,
  and gap-report, ranks by composite score, verifies via backtest, deploys
  as trials. Part of the split monitor pipeline (see also: monitor-health,
  monitor-kata, monitor-portfolio).
  Trigger on: "deploy check", "fill slots", "slot allocation",
  "deployment allocation", "monitor deploy".
---

# Monitor — Deployment Allocation (Step 6)

Fills empty paper trading slots with the highest-priority candidates.
Runs independently from health checks to avoid blocking fast-path
health monitoring with slow backtest verification.

**This skill does NOT check bot health, toggle signals, or retire bots.**
Those responsibilities belong to monitor-health.

## Guard Clauses (check before any work)

Before doing any allocation work, check these conditions. If ANY fails,
log the reason, append a tick-log entry, and exit immediately.

1. **Circuit breaker**: Read `auto-mode/portfolio.json`.
   If `circuit_breaker_active == true` → skip. Log: "Circuit breaker active — no deployments."

2. **Risk-off**: Read `auto-mode/portfolio.json`.
   If `risk_scaling.shadow_mode == false` AND `risk_scaling.multiplier < 0.60` → skip.
   Log: "Risk-off: multiplier {m} < 0.60 — blocking trial deployments."

3. **Stale cell grid**: Read `reports/cell-grid-latest.json`.
   If `last_scored` or file mtime is > 8 hours old → skip.
   Log: "Cell grid stale ({age}h) — no deployments."

4. **Stale gap report**: Read `reports/gap-report.json`.
   If `generated_at` is missing or age > `config.DEPLOY_VERIFICATION.gap_report_max_age_hours`
   (default: 8) → suppress untested and competition sources (Sources C and D) for this tick.
   Kata graduates and roster graduates (Sources A and B) are unaffected — they have
   independent validation and do not depend on current regime scoring.
   Log: "Gap report stale ({age}h) — skipping untested gap cells."

## Dependencies

| Skill | Purpose |
|-------|---------|
| `archetype-taxonomy` | Archetype definitions, correlation groups |
| `freqtrade-mcp` | Backtest verification, bot_start_paper |
| `aphexdata` | Audit trail for deployment events |

Files read:
- `auto-mode/deployments.json` — authoritative slot state
- `auto-mode/campaigns.json` (via research-planner/) — campaign data
- `auto-mode/roster.json` — graduated strategies pending deploy
- `reports/triage-matrix.json` — triage qualifiers
- `reports/gap-report.json` — untested gap cells
- `auto-mode/competition-state.json` — competition queue (optional)
- `auto-mode/candidate-queue.jsonl` — competition candidates (optional)
- `auto-mode/portfolio.json` — circuit breaker, risk-off state
- `reports/cell-grid-latest.json` — staleness check, regime data
- `scoring-config.json` — slot management config

Files written:
- `auto-mode/deployments.json` — new deployment records
- `auto-mode/campaigns.json` — new campaign entries
- `auto-mode/roster.json` — status updates
- `auto-mode/tick-log.jsonl` — step trace (append)

## Console Sync — Automatic

State files are pushed to the dashboard automatically by the host-side
`console-sync` loop every 60 seconds. No manual sync calls needed —
just write the file and console-sync picks it up on the next cycle.

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

## Step 6: SLOT-AWARE ALLOCATION

The Slot Management spec replaces first-come-first-served fill with
priority-driven allocation against a hard 10-bot cap. The flow is:

1. Count slots and available trial room.
2. Gather candidates from kata graduates, qualifiers, and untested cells.
3. Rank candidates by `gap_score × quality × group_diversity`.
4. Verify each candidate with the existing pre-deploy backtest.
5. Deploy as `slot_state="trial"` with a per-timeframe `trial_deadline`.
6. Run the graduated replacement check for any degrading graduate.

```
cfg = config.SLOT_MANAGEMENT

# 1. Count slots (from deployments.json — authoritative slot state)
deployments_data = read auto-mode/deployments.json
all_deps = deployments_data.deployments
graduated = [d for d in all_deps
             if d.slot_state == "graduated" and d.state != "retired"]
trials    = [d for d in all_deps
             if d.slot_state == "trial"     and d.state != "retired"]
total     = len(graduated) + len(trials)
empty     = cfg.max_total_bots - total                      # 10 cap
trial_room= min(empty, cfg.max_trial_bots - len(trials))    # 5 trial cap

Log: "Slots: {len(graduated)}G + {len(trials)}T = {total}/{cfg.max_total_bots}
      ({empty} empty, trial_room {trial_room})"

if total >= cfg.max_total_bots:
  Log: "SLOTS FULL — no new deployments unless eviction frees a slot"
```

**2. Gather candidates** (only when trial_room > 0):

```
candidates = []

# Source A — kata graduates pending deployment (campaigns.json)
for c in campaigns:
  if c.state == "pending_deploy":
    candidates.append({
      strategy: c.strategy, pair: c.pair, timeframe: c.timeframe,
      archetype: c.archetype,
      correlation_group: archetype_taxonomy[c.archetype].correlation_group,
      source: "kata_graduated", quality: 1.5,
      favorable_sharpe: c.triage.favorable_sharpe,
      gap_score: lookup_gap_score(c.archetype, c.pair, c.timeframe),
      deployment_failures: count_failures(c.archetype, c.pair, c.timeframe),
    })

# Source A-bis — roster graduates pending deployment (roster.json)
# Strategies graduate into roster.json via kata/triage. This source
# catches pending_deploy entries that only exist in roster, not campaigns.
roster = read auto-mode/roster.json (gracefully skip if missing)
if roster:
  for r in roster.roster:
    # Handle entries with cells array
    for cell in (r.cells or []):
      if cell.status == "pending_deploy":
        # Skip if already covered by campaigns Source A
        already = any(c for c in candidates
                      if c.strategy == r.strategy_name and c.pair == cell.pair)
        if already: continue
        candidates.append({
          strategy: r.strategy_name, pair: cell.pair,
          timeframe: r.timeframe or cell.timeframe,
          archetype: r.archetype,
          correlation_group: archetype_taxonomy[r.archetype].correlation_group,
          source: "roster_graduated", quality: 1.5,
          favorable_sharpe: r.wf_sharpe or r.kata_score or r.favorable_sharpe,
          gap_score: lookup_gap_score(r.archetype, cell.pair, r.timeframe),
          deployment_failures: count_failures(r.archetype, cell.pair, r.timeframe),
          strategy_path: r.strategy_path,
        })
    # Handle flat structure (no cells array, top-level status)
    if not r.cells and r.status == "pending_deploy":
      already = any(c for c in candidates
                    if c.strategy == r.strategy_name and c.pair == r.pair)
      if already: continue
      candidates.append({
        strategy: r.strategy_name, pair: r.pair,
        timeframe: r.timeframe,
        archetype: r.archetype,
        correlation_group: archetype_taxonomy[r.archetype].correlation_group,
        source: "roster_graduated", quality: 1.5,
        favorable_sharpe: r.wf_sharpe or r.kata_score or r.favorable_sharpe,
        gap_score: lookup_gap_score(r.archetype, r.pair, r.timeframe),
        deployment_failures: count_failures(r.archetype, r.pair, r.timeframe),
      })

# Source B — triage qualifiers
read triage-matrix.json
for w in winners with favorable_sharpe >= 0.5 and not yet deployed:
  candidates.append({..., source: "qualifier", quality: 1.2, ...})

# Source C — untested gap-report top cells
read gap-report.json
for entry in top_gaps where no qualifier exists yet:
  candidates.append({..., source: "untested", quality: 1.0, ...})

# Source D — competition candidate queue (if competition mode active)
competition_state = read auto-mode/competition-state.json
  (gracefully skip if missing)
If competition_state exists and competition_state.active == true:
  queue = read auto-mode/candidate-queue.jsonl
    (gracefully skip if missing)
  for entry in queue:
    if entry.status == "active" and entry.expires_at > now:
      candidates.append({
        strategy: entry.strategy_name,
        strategy_path: entry.strategy_path,
        pair: entry.pair, timeframe: entry.timeframe,
        archetype: entry.archetype,
        correlation_group: entry.correlation_group,
        source: "competition_queue", quality: 1.3,
        favorable_sharpe: entry.favorable_sharpe,
        gap_score: entry.gap_score,
        deployment_failures: count_failures(entry.archetype, entry.pair, entry.timeframe),
      })
  # When a competition_queue candidate is deployed (Step 6.4 below),
  # mark entry status = "deployed" in candidate-queue.jsonl
```

**3. Rank candidates** by composite deployment value:

```
def rank_candidates(candidates, graduated, cfg):
  scored = []
  group_counts = count_by_group(graduated + trials)
  for c in candidates:
    score = c.gap_score                                  # base

    # Quality multiplier (kata/roster 1.5 / competition_queue 1.3 / qualifier 1.2 / untested 1.0)
    score *= cfg.candidate_quality_multipliers[c.source]

    # Group diversity bonus (re-uses scout Step 6b mechanism)
    g = c.correlation_group
    n_in_group = group_counts.get(g, 0)
    if n_in_group == 0:
      score *= 2.0                                       # empty group
    elif n_in_group == 1:
      score *= 1.3                                       # under-represented

    # Dead cell cooldown (Finding 14)
    if c.deployment_failures >= 3:
      score *= 0.3

    scored.append((score, c))
  scored.sort(key=lambda x: -x[0])
  return [c for _,c in scored]

ranked = rank_candidates(candidates, graduated, cfg)
```

**4. Deploy ranked candidates as trials** (respecting group cap):

```
verifications_this_tick = 0
deployed_this_tick      = 0

for cand in ranked:
  if trial_room <= 0:
    break

  # Group cap (hard structural constraint)
  group_count = count_in_group(cand.correlation_group, graduated + trials)
  if group_count >= cfg.max_per_group:                  # 4
    continue

  # Pre-deployment verification (max 3 per tick — existing gate)
  if verifications_this_tick >= config.DEPLOY_VERIFICATION.max_per_tick:
    Log: "Verification cap reached. Remaining candidates defer to next tick."
    break

  Run freqtrade_backtest({
    strategy: cand.strategy, pairs: [cand.pair],
    timeframe: cand.timeframe, timerange: "last 30 days"
  })
  verifications_this_tick += 1

  archetype = read_archetype(cand.archetype)
  # REGIME SOURCE: ALWAYS use orderflow MCP for live deployment decisions.
  # NEVER read current_regime from the cell-grid (that is historical market-timing data).
  current_regime = orderflow.get_current_regime(cand.pair, cand.timeframe)

  Verify ALL of:
    a) trade_count > 0
    b) win_rate > config.DEPLOY_VERIFICATION.min_win_rate   # 0.30
    c) current_regime NOT in archetype.anti_regimes

  if verification c) fails (anti-regime):
    # Don't cancel — retry when regime shifts. Strategy may still be valid.
    Mark cand state = "pending_regime" with {regime: current_regime, checked_at: now}
    Post: "Slot fill deferred: {cand.strategy} on {pair}/{tf} — current regime
           {current_regime} is anti-regime for {archetype}. Will retry next tick."
    continue

  # d) BOCPD transition caution — only when shadow_mode is false (promoted)
  if config.REGIME_MODEL.shadow_mode == false:
    market_prior = read reports/market-prior.json (gracefully skip if missing)
    change_prob = market_prior[cand.pair][cand.timeframe].bocpd_change_prob ?? 0
    if change_prob > config.REGIME_MODEL.change_prob_caution_threshold:   # default 0.30
      Mark cand state = "pending_regime" with {
        regime: current_regime,
        change_prob: change_prob,
        checked_at: now,
        reason: "regime_transition_caution"
      }
      Post: "Deploy deferred: {cand.strategy} on {pair}/{tf} — regime transition
             probability {change_prob:.0%} exceeds caution threshold. Will retry next tick."
      continue

  if verification a) or b) fails:
    Mark cand state = "needs_review" with reason
    Post: "Slot fill skipped: {cand.strategy} — {reason}"
    continue

  # Deploy as trial — slot lifecycle starts NOW
  bot = bot_start_paper(cand.strategy, cand.pair, cand.timeframe, config)

  # Volume-weighted effective stake (Finding 13) + conviction scaling + graduation boost
  vw = cell.volume_weight
  portfolio_avg_vw = mean(volume_weight of all active/staged cells, 0.65)
  base = roster_entry.base_stake_pct (default 5)
  raw = base * (vw / portfolio_avg_vw)
  floor   = base * config.VOLUME_WEIGHTED_STAKE.floor_multiplier   # 0.4
  ceiling = base * config.VOLUME_WEIGHTED_STAKE.ceiling_multiplier # 1.5
  volume_stake = clamp(raw, floor, ceiling)

  # Conviction scaling: boost stake when regime conviction is high for preferred regime
  cs = portfolio_rules.CONVICTION_SCALING (or defaults)
  if cs.enabled:
    conviction = cell.conviction (0–100, from market-timing grid)
    archetype_regime_rel = classify(current_regime, archetype.preferred_regimes, archetype.anti_regimes)
    if archetype_regime_rel == "preferred" AND conviction >= cs.conviction_floor:
      t = (conviction - cs.conviction_floor) / (100 - cs.conviction_floor)
      conviction_factor = 1.0 + t * (cs.max_boost - 1.0)   # lerp 1.0 → max_boost (1.5)
    elif archetype_regime_rel == "anti":
      conviction_factor = cs.anti_regime_penalty              # 0.6
    else:
      conviction_factor = cs.neutral_regime_factor             # 1.0
  else:
    conviction_factor = 1.0

  # Graduation multiplier (graduated bots earn more capital than trials)
  slot_multiplier = portfolio_rules.CAPITAL_ALLOCATION.trial_stake_multiplier   # 1.0

  # CVaR tail-risk multiplier (TAIL_RISK.shadow_mode=false → active)
  # Read portfolio.json risk_scaling.multiplier; guard clause already blocks m < 0.60
  tail_risk_multiplier = portfolio.risk_scaling.multiplier ?? 1.0
  if config.TAIL_RISK.shadow_mode == false:
    tail_risk_multiplier = clamp(tail_risk_multiplier, config.TAIL_RISK.multiplier_min, 1.0)
  else:
    tail_risk_multiplier = 1.0   # shadow mode: compute but don't apply

  effective_stake_pct = clamp(volume_stake * conviction_factor * slot_multiplier * tail_risk_multiplier,
                              floor, base * config.VOLUME_WEIGHTED_STAKE.ceiling_multiplier * cs.max_boost)

  # Create campaign with slot lifecycle stamps
  campaign = {
    state: "paper_trading",
    slot_state: "trial",
    deployed_at: now,
    trial_deadline: now + cfg.trial_deadlines_days[cand.timeframe] days,
    correlation_group: archetype.correlation_group,
    source: cand.source,
    candidate_quality: cand.quality,
    eviction_priority: 100,                  # trial_base, recomputed next tick
    eviction_factors: ["trial_base:100"],
    graduated_at: null, evicted_at: null, eviction_reason: null,
    paper_trading: {
      bot_deployment_id: bot.id,
      validation_deadline: now + paper_validation[tf].days,
      effective_stake_pct, volume_weight: vw, base_stake_pct: base,
      regime_at_deploy: current_regime,
      ...standard warm-up fields...
    }
  }
  campaigns.append(campaign)

  # Also write/update deployment record in deployments.json (authoritative slot state)
  dep_record = find or create entry in deployments_data.deployments where id == bot.id
  dep_record.slot_state = "trial"
  dep_record.state = "active"
  dep_record.strategy = cand.strategy
  dep_record.archetype = cand.archetype
  dep_record.pairs = [cand.pair]
  dep_record.timeframe = cand.timeframe
  dep_record.staged_at = now
  dep_record.activated_at = now
  dep_record.graduated = null
  dep_record.wfo_sharpe = cand.favorable_sharpe
  dep_record.preferred_regimes = archetype.preferred_regimes
  dep_record.anti_regimes = archetype.anti_regimes
  dep_record.total_pnl_pct = 0
  dep_record.trades_since_deploy = 0
  write auto-mode/deployments.json

  # Season capital tracking (if season active)
  season = read auto-mode/season.json (gracefully skip if missing)
  if season exists AND season.status == "active" AND season.capital_allocation is not null:
    remaining = season.capital_allocation.remaining_usdt
    total = season.capital_allocation.total_usdt
    # Allocate proportionally — leave room for future deployments
    open_trial_room = trial_room  # already decremented above
    allocated = min(remaining / max(open_trial_room + 1, 1), total * 0.20)
    allocated = max(allocated, total * 0.05)  # floor: at least 5% of total
    season.capital_allocation.allocated_usdt += allocated
    season.capital_allocation.remaining_usdt -= allocated
    season.capital_allocation.deployments.append({
      deployment_id: dep_record.id,
      strategy: cand.strategy,
      pair: cand.pair,
      timeframe: cand.timeframe,
      allocated_usdt: allocated,
      deployed_at: now,
      retired_at: null
    })
    write auto-mode/season.json
    Log: "Season capital: allocated {allocated:.0f} USDT to {cand.strategy}. Remaining: {remaining - allocated:.0f}/{total:.0f}"

  trial_room      -= 1
  deployed_this_tick += 1

  Post: "DEPLOYED TRIAL: {strategy} on {pair}/{tf}
    — source={source}, gap_score={gap}, deadline={trial_deadline},
    stake_pct={stake} (vw={vw})"
  aphexdata_record_event(verb_id="slot_trial_deployed",
    verb_category="execution",
    result_data={cand, slot_state: "trial", trial_deadline,
                 group: archetype.correlation_group})
```

**5. Graduated replacement check** (runs every tick, regardless of empty slots):

A graduated bot can be replaced ONLY when:
  - Its `eviction_priority > 50` (actively degrading; healthy graduates
    are never displaced).
  - A kata-graduated candidate exists for the same (archetype, pair,
    timeframe) cell.
  - That candidate's `favorable_sharpe` exceeds the incumbent's
    `live_sharpe` by at least `replacement_sharpe_threshold` (0.20).

```
replaced_this_tick = 0

for g in graduated:
  if g.eviction_priority <= 50:
    continue                                     # healthy — protected

  for c in kata_graduates_for_cell(g.archetype, g.pair, g.timeframe):
    sharpe_improvement = c.favorable_sharpe - (g.live_sharpe or 0)
    if sharpe_improvement <= cfg.replacement_sharpe_threshold:
      continue

    # Evict the incumbent
    retire(g, reason="replaced_by_better",
           extras={replacement: c.strategy_name,
                   sharpe_improvement: sharpe_improvement})
    Post: "REPLACED: {g.strategy} (Sharpe {g.live_sharpe}, prio {g.eviction_priority})
            with {c.strategy} (Sharpe {c.favorable_sharpe})"
    aphexdata_record_event(verb_id="slot_graduated_replaced",
      verb_category="execution",
      result_data={old: g, new: c, sharpe_improvement})

    # Deploy the replacement as a fresh trial — it must re-prove itself
    # even though it was kata-validated. Run the same deploy block as
    # above (verification, volume-weighted stake, slot stamps).
    deploy_as_trial(c)
    replaced_this_tick += 1
    break                                        # one replacement per graduate

Log: "Slot allocation: deployed {deployed_this_tick} trials, replaced
      {replaced_this_tick} graduates."
```

**6. Group balance summary**:

```
group_counts = count_by_group(graduated + trials)
Log: "Group balance: trend={group_counts.trend}/3, range={..}/3,
      vol={..}/2, carry={..}/1"

For any group below cfg.group_balance[group].min:
  Log: "WARN: group {group} below minimum
        ({count}/{cfg.group_balance[group].min}) — scout will boost"
```

The empty/under-represented group preference is enforced by
`rank_candidates` (the 2.0× / 1.3× multipliers). `should_deploy` only
hard-blocks when `len(group_bots) >= cfg.max_per_group` (4). Empty
groups never hard-block — they get promoted to the top of the ranking.

## Epilogue — Sync and Log

After completing allocation (even if 0 deployments):

1. Append completion entry to tick-log:
   ```
   append to auto-mode/tick-log.jsonl:
     {"ts": now, "tick_id": null, "skill": "monitor-deploy", "step": 6,
      "phase": "complete",
      "outcome": "deployed_{deployed_this_tick}_verified_{verifications_this_tick}_replaced_{replaced_this_tick}"}
   ```

3. Message user ONLY if deployments or replacements happened.
   Silent when no candidates available or slots full.

## Schema Reference

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

### campaigns.json — paper_trading fields

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

- `ticks_signals_on/off`: incremented by health check each tick. Used by graduation evaluation.
- `expected_trades_in_validation`: estimated at deploy time from WF trade counts.
- `feasibility_warning`: true if expected_trades < min_trades at deploy time, OR if inactive detection fires (48h/72h warning).
- `extended`: true if validation was extended 50%. Only once.
- `regime_extension`: true if zero-trade bot got full extension due to regime-blocking. Only once.
- `current_win_rate`: updated each tick from FreqTrade. Used by health triggers and graduation gates.
- `current_avg_win_pct`: average profit per winning trade. Used for R:R checks.
- `current_avg_loss_pct`: average loss per losing trade (positive number). Used for R:R checks.
- `max_consecutive_losses`: longest streak of consecutive losing trades. Used by graduation gates.
- `investigation_mode`: true if R:R inversion fired. Signals are paused. Health check skips signal toggling.
- `investigation_reason`: the specific reason for investigation (e.g. `"risk_reward_inversion"`).
- `rr_extension`: true if validation was extended because R:R inversion was detected at graduation. Only once.

# Monitor Health — Lifecycle Action Reference

Full implementation detail for graduation and retirement state transitions.
Referenced from `SKILL.md` Step 5 GRADUATE/RETIRE/BRIDGE actions.

---

## GRADUATE Actions (Case 1 pass)

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

  # Graduated stake boost — re-evaluate conviction with current regime, then apply multiplier.
  grad_mult = portfolio_rules.CAPITAL_ALLOCATION.graduated_stake_multiplier (default 1.3)
  old_stake = campaign.paper_trading.effective_stake_pct
  base = campaign.paper_trading.base_stake_pct
  vw = campaign.paper_trading.volume_weight ?? 1.0

  # Re-read current regime conviction for this cell (same formula as monitor-deploy)
  cell = cell_grid.find(archetype=campaign.archetype, pair=campaign.pair, timeframe=campaign.timeframe)
  cs = portfolio_rules.CONVICTION_SCALING (or defaults)
  if cs.enabled AND cell:
    archetype_regime_rel = classify(cell.regime, archetype.preferred_regimes, archetype.anti_regimes)
    if archetype_regime_rel == "preferred" AND cell.conviction >= cs.conviction_floor:
      t = (cell.conviction - cs.conviction_floor) / (100 - cs.conviction_floor)
      conviction_factor = 1.0 + t * (cs.max_boost - 1.0)
    elif archetype_regime_rel == "anti":
      conviction_factor = cs.anti_regime_penalty
    else:
      conviction_factor = cs.neutral_regime_factor
  else:
    conviction_factor = 1.0  # fallback: no scaling if cell missing or disabled

  # Recompute from base components with fresh conviction, then apply grad_mult
  refreshed_base = base * vw * conviction_factor
  new_stake = clamp(refreshed_base * grad_mult,
                    base * 0.4,
                    portfolio_rules.CAPITAL_ALLOCATION.max_per_deployment_pct)
  campaign.paper_trading.effective_stake_pct = new_stake
  dep.effective_stake_pct = new_stake
  Log: "GRADUATED STAKE: {strategy} {old_stake:.1f}% → {new_stake:.1f}% (base={base}% × vw={vw:.2f} × conv={conviction_factor:.2f} × grad={grad_mult})"

  write auto-mode/deployments.json

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

# Append live outcome (non-blocking — log warning on failure, create knowledge dir if missing)
append_jsonl("knowledge/live-outcomes.jsonl", {
  ts: now, strategy, archetype, correlation_group, pair, timeframe,
  outcome: "graduated",
  regime_at_deploy: campaign.paper_trading.regime_at_deploy ?? null,
  regime_at_outcome: cell_grid.find(archetype, pair, timeframe)?.regime ?? null,
  days_deployed: (now - campaign.deployed_at).days,
  trade_count: campaign.paper_trading.current_trade_count ?? 0,
  pnl_pct: campaign.paper_trading.current_pnl_pct ?? 0,
  live_sharpe: campaign.graduation.live_sharpe ?? campaign.paper_trading.current_sharpe ?? null,
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

---

## BRIDGE → EXTERNAL Promotion

Checked every tick for bridged campaigns:

```
for campaign in campaigns where state == "graduated_internal_only":
  if now >= campaign.graduation.internal_bridge_until:
    if current_sharpe >= 0.5 AND no new retirement triggers fired during bridge:
      campaign.state = "graduated_external"
      dep = find in deployments.deployments where id == campaign.paper_trading.bot_deployment_id
      if dep:
        dep.state = "graduated_external"
        write auto-mode/deployments.json
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

---

## RETIRE Actions

```
campaign.state = "retired"
campaign.paper_trading.retire_reason = reason
Stop container: bot_stop(bot_deployment_id, confirm=true)

# Update authoritative slot state (deployments.json is what the slot counter reads)
dep = find in deployments.deployments where id == campaign.id
dep.state = "retired"
dep.retired_reason = reason
write auto-mode/deployments.json

# Return capital to season pool (if season active)
season = read auto-mode/season.json (gracefully skip if missing)
if season exists AND season.status == "active" AND season.capital_allocation is not null:
  cap_dep = find in season.capital_allocation.deployments
            where deployment_id == campaign.paper_trading.bot_deployment_id
            AND retired_at is null
  if cap_dep:
    cap_dep.retired_at = now
    season.capital_allocation.remaining_usdt += cap_dep.allocated_usdt
    season.capital_allocation.allocated_usdt -= cap_dep.allocated_usdt
    write auto-mode/season.json
    Log: "Season capital: returned {cap_dep.allocated_usdt:.0f} USDT from {campaign.strategy}. Remaining: {season.capital_allocation.remaining_usdt:.0f}/{season.capital_allocation.total_usdt:.0f}"

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

Update TRADE.md on retirement:
  TRADE_MD="/workspace/group/strategies/${strategy_name}.trade.md"
  If TRADE_MD exists:
    Update lineage.graduation_status: "retired"
    trade-md lint $TRADE_MD
    # NO registry rebuild — retired strategies don't publish

aphexdata_record_event(verb_id="kata_retired", ...)
Post to feed: "Retired: {strategy} — {reason}"

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

---

## Evolution Event Logging (Step 5 only)

Append to `knowledge/evolution-events.jsonl`:
- GRADUATE: `{operation: "commit", committed_to: "graduated_slot", net_delta: "sharpe: X, trades: N"}`
- RETIRE: `{operation: "rollback", rollback_reason: "<trigger_code>"}`
- `event_id` = `evo_` + date + `_` + first 8 hex of SHA-256(campaign_id + timestamp).

**Live outcome logging** is inline in the Step 4 "On early retire" and Step 5
GRADUATE/RETIRE code blocks above. Each appends to `knowledge/live-outcomes.jsonl`
with null-safe fields. Non-blocking: create knowledge dir if missing, log warning
on write failure.

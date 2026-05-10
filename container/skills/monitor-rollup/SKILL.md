---
name: monitor-rollup
description: >
  Weekly / on-demand rollup. Competition benchmark (vs BTC buy-and-hold),
  Five Questions kata reflection, experiment-ledger resolution, season
  dashboard (Step 8e), regime effectiveness scoring (Step 8f), and
  daily briefing write. Runs when competition or season is active;
  otherwise trigger manually for a periodic portfolio review.
  Trigger on: "daily rollup", "competition scorecard", "season dashboard",
  "regime effectiveness", "five questions", "briefing", "experiment ledger",
  "weekly rollup", "monitor rollup".
---

# Monitor — Daily Rollup (Steps 8e-8f + Competition + Season)

Handles all **periodic reporting** that does NOT need to run every health tick.
Steps 8e and 8f plus competition tracking are separated here so the daily
00:00 UTC monitor-portfolio task (Steps 8-8d) stays lean.

**This skill does NOT check bot health, deploy bots, or manage signals.**
Those responsibilities belong to monitor-health and monitor-deploy.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `freqtrade-mcp` | Exchange API for BTC price |
| `aphexdata` | Audit trail + standings |
| `experiment-ledger` | Experiment resolution procedure |

Files read:
- `auto-mode/campaigns.json` — bot metrics, P&L data
- `auto-mode/competition-state.json` — competition mode state
- `auto-mode/season.json` — season lifecycle + dashboard (if exists)
- `auto-mode/deployments.json` — slot counts for season dashboard
- `auto-mode/portfolio-correlation.json` — correlation (written by monitor-portfolio Step 8)
- `auto-mode/experiment-ledger.jsonl` — open experiments
- `scoring-config.json` — SEASON config
- `knowledge/live-outcomes.jsonl` — live outcomes for regime effectiveness
- `knowledge/discoveries.jsonl` — knowledge growth (season)
- `knowledge/anti-patterns.jsonl` — knowledge growth (season)
- `/workspace/skills/archetype-taxonomy/archetypes.yaml` — archetype preferred/anti regimes

Files written:
- `auto-mode/competition-state.json` — daily snapshots
- `auto-mode/experiment-ledger.jsonl` — resolved experiments
- `reports/briefings/YYYY-MM-DD.md` — daily briefing
- `auto-mode/season.json` — season dashboard updates (if active)
- `reports/regime-effectiveness.json` — regime lift metrics
- `auto-mode/tick-log.jsonl` — step trace (append)

## Console Sync — Mandatory

After writing any state file, sync to Supabase:

| File | state_key |
|------|-----------|
| `season.json` | `season` |

## Daily Rollup — Competition Benchmark + Experiment Ledger

**Competition Benchmark (daily, only when competition mode active):**

```
competition_state = read auto-mode/competition-state.json
if competition_state exists AND competition_state.active == true:

  # 1. BTC benchmark (capital-denominated)
  btc_start_price = competition_state.benchmark.start_price
  start_capital = competition_state.benchmark.start_capital_usdt ?? 10000
  btc_units = competition_state.benchmark.btc_units ?? (start_capital / btc_start_price)
  btc_current_price = fetch current BTC/USDT price via exchange API

  btc_value_now = btc_units * btc_current_price
  btc_return_pct = ((btc_value_now - start_capital) / start_capital) * 100

  # 2. Portfolio return (season-scoped: only trades opened AND closed within season)
  season = read auto-mode/season.json (or null)
  season_start = season.started_at if season else competition_state.activated_at

  portfolio_total_pnl_usdt = 0
  for each campaign where state != "retired" OR (state == "retired" AND evicted_at >= season_start):
    trades = bot_trades(campaign.paper_trading.bot_deployment_id)
    season_trades = [t for t in trades
                     if t.open_date >= season_start
                     AND t.close_date is not null
                     AND t.close_date <= now]
    pnl_usdt = sum(t.profit_abs ?? (t.profit_pct / 100 * t.stake_amount) for t in season_trades)
    portfolio_total_pnl_usdt += pnl_usdt

    # Store per-campaign season stats for dashboard use in Step 8e
    campaign.paper_trading.season_trade_count = len(season_trades)
    campaign.paper_trading.season_pnl_usdt = pnl_usdt
    campaign.paper_trading.season_win_rate = (
      len([t for t in season_trades if (t.profit_abs ?? t.profit_pct) > 0]) / len(season_trades)
    ) if season_trades else null

  portfolio_return_pct = (portfolio_total_pnl_usdt / start_capital) * 100

  # 3. Alpha (both sides denominated against the same season capital)
  alpha_pct = portfolio_return_pct - btc_return_pct

  # 4. Reflect on Last Step (Toyota Kata)
  kata = competition_state.kata
  reflection = {
    last_step: kata.last_step,
    expected: kata.last_step_expected,
    actual: kata.last_step_actual,    # <-- update this with today's observation
    learned: kata.last_step_learned   # <-- update this with today's learning
  }

  # 5. Five Questions
  # Q1: Target Condition — read from kata.current_target_condition
  # Q2: Actual Condition — the alpha and slot data computed above
  # Q3: Obstacles — identify from portfolio diagnosis, group coverage,
  #     underperforming bots, regime mismatches
  # Q4: Next Step — the single action to take (rotate, deploy, retire, kata race)
  # Q5: How quickly learn — next daily rollup (24h) or next monitor tick

  # 6. Append daily snapshot
  snapshot = {
    date: today_iso,
    btc_price: btc_current_price,
    btc_return_pct: btc_return_pct,
    portfolio_return_pct: portfolio_return_pct,
    alpha_pct: alpha_pct,
    slot_utilization: "{filled}/{max}",
    target_condition: kata.current_target_condition,
    obstacle_addressed: "<identified obstacle>",
    next_step: "<planned next step>"
  }
  competition_state.benchmark.daily_snapshots.append(snapshot)

  # 7. Update kata state with today's decisions
  competition_state.kata.last_step = snapshot.next_step
  competition_state.kata.last_step_expected = "<expected outcome>"
  # (actual + learned are filled at NEXT daily rollup via reflection)

  write competition_state to auto-mode/competition-state.json

  # 8. Message output (add to daily summary)
  message:
  """
  ## Competition Scorecard — {date}

  | Metric | Value |
  |--------|-------|
  | Portfolio Return | {portfolio_return_pct:+.2f}% |
  | BTC Buy & Hold   | {btc_return_pct:+.2f}% |
  | **Alpha**        | **{alpha_pct:+.2f}%** |
  | Slots            | {filled}/{max} |
  | Day              | {days_since_start} of {total_days} |

  ### Reflect on Last Step
  - **Step:** {kata.last_step}
  - **Expected:** {kata.last_step_expected}
  - **Actual:** {observed outcome}
  - **Learned:** {key insight}

  ### Five Questions
  1. **Target:** {kata.current_target_condition}
  2. **Actual:** Alpha {alpha_pct:+.2f}%
  3. **Obstacle:** {identified obstacle}
  4. **Next Step:** {planned action} — expect: {expected outcome}
  5. **Learn by:** Next daily rollup (24h)
  """

  # 9. Review open experiments (experiment-ledger integration)
  ledger = read auto-mode/experiment-ledger.jsonl (create empty if missing)
  overdue = [e for e in ledger
             if e.outcome is null AND e.review_after <= now]
  for exp in overdue:
    # Compute outcome DETERMINISTICALLY from observed metrics
    # Parse falsifier thresholds, compare to current state
    # outcome = "CONFIRMED: ..." or "FALSIFIED: ..." with numeric proof
    # inference = agent prose about what to learn
    # Append resolution row to ledger
    # Update kata.last_step_actual and kata.last_step_learned
    # See experiment-ledger skill for full procedure

  # 10. Write briefing file (audit trail)
  briefing_path = reports/briefings/{YYYY-MM-DD}.md
  write briefing_path:
  """
  # Briefing — {date}

  Alpha: {alpha_pct:+.1f}% | Portfolio: {portfolio_return_pct:+.1f}% | BTC: {btc_return_pct:+.1f}%
  Slots: {filled}/{max} | Day {days_since_start} of {total_days}

  ## Target Condition
  {kata.current_target_condition}

  ## Strategy Health
  {for each bot: "- {name}: {trades} trades, {pnl:+.1f}%, {status}"}

  ## Flags
  {any alerts, DD warnings, regime shifts, or "None"}

  ## Open Experiments
  {for each open exp: "- {id}: \"{hypothesis}\" — review due {review_after}"}
  {if overdue resolved this tick: "- {id}: {outcome}"}

  ## Prediction Accuracy
  {confirmed}/{total} resolved ({pct}% accuracy)
  """
```

### Auto-Kata-Bridge: Portfolio Improvement Escalation

If alpha is negative for 3+ consecutive days, execute this escalation
autonomously. In competition mode the agent acts, it does not ask.

**Procedure:**

1. Read `portfolio-rules.json` from workspace root (CWD).
   If not found, read `/home/node/.claude/skills/setup/portfolio-rules-defaults.json`.
   This is the `config_snapshot` for the kata race.

2. Read `reports/portfolio-audit.json` if it exists.
   This is the `audit_context` (concentration issues, group imbalance, etc.).

3. Generate a race ID: `portfolio_{YYYYMMDD}_{HHMMSS}` (UTC).

4. Call the `kata_start` MCP tool:

```
kata_start(
  race_id="portfolio_{YYYYMMDD}_{HHMMSS}",
  candidate_name="portfolio_improvement",
  target_type="portfolio",
  config_snapshot=<portfolio-rules.json contents as string>,
  audit_context=<portfolio-audit.json contents as string, or "{}" if missing>,
  max_experiments=10,
  group_folder="{current group folder}"
)
```

5. Log the escalation in the daily rollup:

```
AUTO-KATA-BRIDGE TRIGGERED: {N} consecutive negative alpha days.
Race: {race_id}. Config source: {workspace|defaults}.
```

6. Do NOT block if portfolio-rules.json is missing — use defaults and proceed.
   Do NOT block if portfolio-audit.json is missing — pass empty context.
   The point is to START the improvement race, not to have perfect inputs.

**Competition autonomy rule:** The Five Questions and kata decisions
in the daily rollup are ANSWERED by the agent, not posed to the user.
The agent sets target conditions, identifies obstacles, chooses next
steps, and executes them. The user reviews the scorecard after the fact.

### Step 8e: SEASON DASHBOARD (daily, only when season active)

```
season = read auto-mode/season.json (or null)
if season is null OR season.status != "active": skip Step 8e entirely

# --- Auto-complete guard ---
if now > season.ends_at:
  season.status = "completed"
  season.completed_at = now ISO
  write auto-mode/season.json
    aphexdata_record_event({
    verb_id: "season_auto_completed",
    verb_category: "execution",
    object_type: "season",
    object_id: season.season_id
  })
  Log: "Season {season.season_id} auto-completed (deadline reached)."
  skip remaining Step 8e

day_number = (now - season.started_at).days + 1
season_config = scoring_config.SEASON ?? { concern_thresholds: {} }
thresholds = season_config.concern_thresholds ?? {}
```

**COMPETITION POSITION:**

```
# From competition-state.json (already read earlier in Daily Rollup)
competition_state = read auto-mode/competition-state.json (already in memory)

if competition_state exists AND competition_state.benchmark.daily_snapshots not empty:
  last_snap = competition_state.benchmark.daily_snapshots[-1]
  score_pct = last_snap.portfolio_return_pct
  btc_return_pct = last_snap.btc_return_pct
  alpha_pct = last_snap.alpha_pct
else:
  score_pct = null
  btc_return_pct = null
  alpha_pct = null

# Rank from aphexdata (graceful degradation if unavailable)
try:
  standings = aphexdata_get_standings(competition_id=season.season_id)
  rank = standings.rank
  total_agents = standings.total
except:
  rank = null
  total_agents = null

season.dashboard.competition_position = {
  score_pct: score_pct,
  btc_return_pct: btc_return_pct,
  alpha_pct: alpha_pct,
  rank: rank,
  total_agents: total_agents
}
```

**OPERATIONAL HEALTH:**

```
# Slots — from deployments.json (canonical formula, matches monitor-deploy)
deployments = read auto-mode/deployments.json
active_deps = [d for d in deployments
               if d.state != "retired"
               and d.slot_state in ("trial", "graduated")]
slots_filled = len(active_deps)

# Group breakdown — from campaigns.json (already in memory from Step 8)
campaigns = read auto-mode/campaigns.json (already in memory)
by_group = {"trend": 0, "range": 0, "vol": 0, "carry": 0}
for c in campaigns:
  if c.state != "retired" and c.slot_state in ("trial", "graduated"):
    group = c.correlation_group ?? "carry"
    by_group[group] += 1

groups_covered = len([g for g in by_group.values() if g > 0])
group_coverage = f"{groups_covered}/4"

# Avg correlation — from portfolio-correlation.json (written by monitor-portfolio Step 8)
portfolio_corr = read auto-mode/portfolio-correlation.json
avg_correlation = portfolio_corr.avg_pairwise_correlation ?? null

season.dashboard.operational_health = {
  slots_filled: slots_filled,
  slots_total: scoring_config.SLOT_MANAGEMENT.max_total_bots ?? 10,
  strategies_by_group: by_group,
  group_coverage: group_coverage,
  avg_correlation: avg_correlation
}
```

**QUALITY SIGNALS:**

```
# Backtest divergence — from campaigns with paper_trading data
active_campaigns = [c for c in campaigns
                    if c.state not in ("retired",)
                    and c.slot_state in ("trial", "graduated")]

divergence_vals = [
  c.paper_trading.divergence_pct
  for c in active_campaigns
  if c.paper_trading is not null
  and c.paper_trading.divergence_pct is not null
]
avg_divergence = mean(divergence_vals) if divergence_vals else null

# PPP margins — DSR margin = actual DSR - 1.96, PBO margin = 0.30 - actual PBO
dsr_margins = [
  c.wfo_metrics.dsr - 1.96
  for c in active_campaigns
  if c.wfo_metrics is not null and c.wfo_metrics.dsr is not null
]
pbo_margins = [
  0.30 - c.wfo_metrics.pbo
  for c in active_campaigns
  if c.wfo_metrics is not null and c.wfo_metrics.pbo is not null
]
dsr_margin_avg = mean(dsr_margins) if dsr_margins else null
pbo_margin_avg = mean(pbo_margins) if pbo_margins else null

# Win rate range
win_rates = [
  c.paper_trading.win_rate
  for c in active_campaigns
  if c.paper_trading is not null and c.paper_trading.win_rate is not null
]
win_rate_range = [min(win_rates), max(win_rates)] if win_rates else null

# Season-scoped win rates (from daily rollup trade filter)
season_win_rates = [
  c.paper_trading.season_win_rate
  for c in active_campaigns
  if c.paper_trading is not null and c.paper_trading.season_win_rate is not null
]
season_win_rate_range = [min(season_win_rates), max(season_win_rates)] if season_win_rates else null
season_trade_count = sum(
  c.paper_trading.season_trade_count or 0
  for c in active_campaigns
  if c.paper_trading is not null
)

season.dashboard.quality_signals = {
  avg_backtest_divergence_pct: avg_divergence,
  dsr_margin_avg: dsr_margin_avg,
  pbo_margin_avg: pbo_margin_avg,
  win_rate_range: win_rate_range,
  season_trade_count: season_trade_count,
  season_win_rate_range: season_win_rate_range
}
```

**ADAPTIVE CAPACITY:**

```
# Knowledge growth since season start
discoveries_now = count lines in knowledge/discoveries.jsonl (0 if missing)
antipatterns_now = count lines in knowledge/anti-patterns.jsonl (0 if missing)

baseline = season.knowledge_baseline ?? {discoveries: 0, anti_patterns: 0}
discoveries_growth = discoveries_now - baseline.discoveries
antipatterns_growth = antipatterns_now - baseline.anti_patterns

# Recovery events — count retirement+replacement cycles in campaigns
# A recovery = a trial that was deployed after a retirement in the same group
retired_during_season = [
  c for c in campaigns
  if c.state == "retired"
  and c.evicted_at is not null
  and c.evicted_at >= season.started_at
]
recovery_events = len(retired_during_season)

# Success = a replacement in the same group that graduated
replacements = [
  c for c in active_campaigns
  if c.deployed_at is not null
  and c.deployed_at >= season.started_at
  and c.slot_state == "graduated"
]
recovery_success_count = len(replacements)

season.dashboard.adaptive_capacity = {
  recovery_events: recovery_events,
  recovery_success_count: recovery_success_count,
  knowledge_discoveries_since_start: discoveries_growth,
  knowledge_antipatterns_since_start: antipatterns_growth
}
```

**CONCERNS (auto-generated):**

```
concerns = []

# 1. Group coverage gap
empty_groups = [g for g, count in by_group.items() if count == 0]
min_coverage = thresholds.group_coverage_min ?? 3
if groups_covered < min_coverage:
  concerns.append({
    severity: "high",
    message: f"Only {groups_covered}/4 groups covered (target: >={min_coverage}). Empty: {', '.join(empty_groups)}"
  })

# 2. High average divergence
div_warn = thresholds.divergence_warn_pct ?? 0.25
if avg_divergence is not null and avg_divergence > div_warn:
  concerns.append({
    severity: "medium",
    message: f"Avg backtest divergence {avg_divergence:.0%} exceeds {div_warn:.0%} threshold"
  })

# 3. High correlation
corr_warn = thresholds.correlation_warn ?? 0.30
if avg_correlation is not null and avg_correlation > corr_warn:
  concerns.append({
    severity: "medium",
    message: f"Portfolio correlation {avg_correlation:.2f} above {corr_warn:.2f} target"
  })

# 4. Thin PPP margins
dsr_warn = thresholds.dsr_margin_warn ?? 0.20
pbo_warn = thresholds.pbo_margin_warn ?? 0.10
at_risk = [
  c.strategy for c in active_campaigns
  if c.wfo_metrics is not null
  and ((c.wfo_metrics.dsr is not null and c.wfo_metrics.dsr - 1.96 < dsr_warn)
       or (c.wfo_metrics.pbo is not null and 0.30 - c.wfo_metrics.pbo < pbo_warn))
]
if at_risk:
  concerns.append({
    severity: "low",
    message: f"{len(at_risk)} strategy(s) with thin PPP margin: {', '.join(at_risk[:3])}"
  })

# 5. Per-strategy divergence watch (approaching Trigger F)
for c in active_campaigns:
  if (c.paper_trading is not null
      and c.paper_trading.divergence_pct is not null
      and c.paper_trading.divergence_pct > 0.20):
    trigger_dist = 0.30 - c.paper_trading.divergence_pct
    concerns.append({
      severity: "low" if trigger_dist > 0.05 else "medium",
      message: f"{c.strategy} divergence {c.paper_trading.divergence_pct:.0%}, watch for Trigger F"
    })

# 6. Group with only 1 strategy (fragile coverage)
thin_groups = [g for g, count in by_group.items() if count == 1]
for g in thin_groups:
  strat = next((c.strategy for c in active_campaigns if c.correlation_group == g), "?")
  concerns.append({
    severity: "low",
    message: f"{g.upper()} group has only 1 strategy ({strat}), target 2+"
  })

# 7. Bot with 0 season trades (not contributing to season P&L)
for c in active_campaigns:
  if (c.paper_trading is not null
      and (c.paper_trading.season_trade_count ?? 0) == 0
      and c.paper_trading.deployed_at is not null
      and (now - c.paper_trading.deployed_at).days >= 3):
    elapsed_days = (now - c.paper_trading.deployed_at).days
    concerns.append({
      severity: "low",
      message: f"{c.strategy}: 0 season trades after {elapsed_days}d — not contributing to season P&L"
    })

season.dashboard.concerns = concerns
```

**Write and sync:**

```
# Append daily snapshot for trend tracking
snapshot = {
  date: today_iso,
  day_number: day_number,
  score_pct: score_pct,
  alpha_pct: alpha_pct,
  slots_filled: slots_filled,
  groups_covered: groups_covered,
  knowledge_discoveries: discoveries_growth,
  knowledge_antipatterns: antipatterns_growth,
  concerns_count: len(concerns)
}
season.snapshots.append(snapshot)
season.dashboard.last_computed = now ISO
season.dashboard.day_number = day_number

write auto-mode/season.json

Log: "Season dashboard: Day {day_number}/{season.duration_days}, alpha={alpha_pct}, slots={slots_filled}/{slots_total}, {len(concerns)} concerns"
```

### Step 8f: REGIME EFFECTIVENESS (daily, same cadence as Step 8)

Skip unless `knowledge/live-outcomes.jsonl` exists with >= 5 entries.

Compute regime prediction lift from accumulated deployment outcomes.
Uses the archetype taxonomy (`preferred_regimes`, `anti_regimes`) to classify
each historical deployment as preferred, anti, or neutral at deploy time.

```
outcomes = read_jsonl("knowledge/live-outcomes.jsonl")
if len(outcomes) < 5: skip

# Classify each outcome by regime alignment at deploy time
for o in outcomes:
  if o.regime_at_deploy is null: o.alignment = "unknown"
  elif o.regime_at_deploy in archetype_taxonomy[o.archetype].preferred_regimes: o.alignment = "preferred"
  elif o.regime_at_deploy in archetype_taxonomy[o.archetype].anti_regimes: o.alignment = "anti"
  else: o.alignment = "neutral"

preferred = [o for o in outcomes if o.alignment == "preferred"]
anti = [o for o in outcomes if o.alignment == "anti"]
other = [o for o in outcomes if o.alignment in ("neutral", "unknown")]

# 1. Graduation rate lift
preferred_grad_rate = count(o.outcome == "graduated" for o in preferred) / len(preferred) if preferred else null
other_grad_rate = count(o.outcome == "graduated" for o in (anti + other)) / len(anti + other) if (anti + other) else null
regime_lift_graduation = preferred_grad_rate - other_grad_rate if both non-null else null

# 2. P&L lift
preferred_avg_pnl = mean(o.pnl_pct for o in preferred) if preferred else null
anti_avg_pnl = mean(o.pnl_pct for o in anti) if anti else null
regime_lift_pnl = preferred_avg_pnl - anti_avg_pnl if both non-null else null

# 3. Verdict
verdict = "insufficient_data" if len(outcomes) < 10
        else "positive" if (regime_lift_graduation ?? 0) > 0.10 or (regime_lift_pnl ?? 0) > 1.0
        else "neutral" if (regime_lift_graduation ?? 0) > -0.05
        else "negative"

Log: "REGIME EFFECTIVENESS: {verdict} — preferred grad={preferred_grad_rate:.0%} vs rest={other_grad_rate:.0%} (lift={regime_lift_graduation:+.0%}), pref P&L={preferred_avg_pnl:+.1f}% vs anti={anti_avg_pnl:+.1f}%, n={len(outcomes)}"
```

Write `reports/regime-effectiveness.json`:
```json
{
  "ts": "<ISO>",
  "n_outcomes": 15,
  "preferred_deploys": 8,
  "anti_deploys": 2,
  "other_deploys": 5,
  "preferred_grad_rate": 0.50,
  "other_grad_rate": 0.20,
  "regime_lift_graduation": 0.30,
  "preferred_avg_pnl": 2.1,
  "anti_avg_pnl": -3.2,
  "regime_lift_pnl": 5.3,
  "verdict": "positive"
}
```

Graceful degradation: missing or sparse `live-outcomes.jsonl` → skip entirely,
no file written. Verdict `"insufficient_data"` when < 10 outcomes.

## Epilogue — Sync and Log

After completing rollup:

1. Append completion entry to tick-log:
   ```
   append to auto-mode/tick-log.jsonl:
     {"ts": now, "tick_id": null, "skill": "monitor-rollup", "step": "8e-8f",
      "phase": "complete",
      "outcome": "rollup_alpha_{alpha_pct}_season_{season_status}_regime_{verdict}"}
   ```

2. Message user with rollup summary including:
   - Competition scorecard (if active)
   - Season dashboard (if active)
   - Regime effectiveness verdict
   - Daily briefing path

3. Write auto-memory summary to `~/.claude/memory/monitor-rollup.md`:
   ```
   # Monitor-Rollup Tick Summary
   Updated: {ISO timestamp} | Day {day_number}/{duration_days}

   ## Season Progress
   Alpha: {alpha_pct}% | Score: {score_pct}% | Knowledge velocity: {net_per_day}/day

   ## Regime Effectiveness
   Verdict: {verdict} | Lift: {regime_lift_graduation:+.0%} graduation, {regime_lift_pnl:+.1f}% P&L

   ## Next Tick Notes
   {any open concerns, regime warnings, or items to recheck next run}
   ```

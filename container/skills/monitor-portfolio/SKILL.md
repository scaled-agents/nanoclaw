---
name: monitor-portfolio
description: >
  Daily portfolio analysis (Steps 8-8d). Runs at 00:00 UTC: computes portfolio
  correlation, regime transition frequencies (weekly), tail risk CVaR,
  and portfolio diagnosis. Part of the split monitor pipeline
  (see also: monitor-health, monitor-deploy, monitor-kata, monitor-rollup).
  Trigger on: "portfolio analysis", "portfolio health", "portfolio correlation",
  "tail risk", "cvar", "monitor portfolio", "portfolio diagnosis".
---

# Monitor — Portfolio Analysis (Steps 8-8d)

Computes portfolio-level metrics, risk analysis, and daily operational
summaries. Runs daily at 00:00 UTC — independent from the 15-minute
health checks and 30-minute deployment cycles.

**This skill does NOT check bot health, deploy bots, or manage signals.**
Those responsibilities belong to monitor-health and monitor-deploy.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `freqtrade-mcp` | `compute_portfolio_cvar` MCP tool |
| `aphexdata` | Audit trail |
| `experiment-ledger` | Experiment resolution procedure |

Files read:
- `auto-mode/campaigns.json` — bot metrics, P&L data
- `auto-mode/portfolio-correlation.json` — historical daily returns
- `auto-mode/market-prior.json` — regime tick history
- `auto-mode/portfolio.json` — existing risk state
- `auto-mode/portfolio-risk.json` — tail contribution data
- `scoring-config.json` — TAIL_RISK, SLOT_MANAGEMENT config
- `knowledge/live-attribution-rollup.json` — attribution data (Step 8d)

Files written:
- `auto-mode/portfolio-correlation.json` — updated correlation data
- `auto-mode/regime-transitions.json` — transition probabilities
- `auto-mode/portfolio.json` — tail risk + risk scaling
- `auto-mode/portfolio-risk.json` — tail contribution breakdown
- `reports/portfolio-audit.json` — diagnosis results
- `auto-mode/tick-log.jsonl` — step trace (append)

_(Competition snapshots, briefings, season dashboard, and regime effectiveness
are written by the `monitor-rollup` skill.)_

## Console Sync — Mandatory

After writing any state file, sync to Supabase:

| File | state_key |
|------|-----------|
| `portfolio-correlation.json` | `portfolio_correlation` |
| `regime-transitions.json` | `regime_transitions` |
| `campaigns.json` | `campaigns` |

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


### Step 8c: PORTFOLIO TAIL RISK (daily, same cadence as Step 8)

Skip unless Step 8 ran this tick (current hour == 0, daily_returns updated).

Compute CVaR (Expected Shortfall) and update portfolio risk state. This is
non-blocking — if the MCP tool is unavailable or fails, the existing
portfolio state continues unchanged.

```
cfg = scoring_config.get("TAIL_RISK", {})
if not cfg:
    skip  # TAIL_RISK config block not present

result = compute_portfolio_cvar(
    workspace_dir=<workspace_root>,
    alpha=cfg.get("alpha", 0.975),
    lookback_days=cfg.get("lookback_days", 365),
    estimator=cfg.get("estimator", "ew_hist"),
    target_cvar_daily_pct=cfg.get("target_cvar_daily_pct", 1.5),
    smoothing_halflife_days=cfg.get("smoothing_halflife_days", 7),
    multiplier_min=cfg.get("multiplier_min", 0.25),
    multiplier_max=cfg.get("multiplier_max", 1.0),
    shadow_mode=cfg.get("shadow_mode", true),
    write_state=true,
)

# The tool writes:
#   auto-mode/portfolio.json  → tail_risk{} + risk_scaling{} blocks
#   auto-mode/portfolio-risk.json → tail contribution breakdown

Log: "Tail risk: CVaR={result.cvar_daily_pct}% (α={result.alpha}),
      m={result.multiplier} ({result.mode}),
      confidence={result.confidence},
      top_contributor={result.top_tail_contributor}"
```

**CVaR shadow log** — append one line to `knowledge/cvar-shadow-log.jsonl`:

```json
{
  "ts": "<ISO-8601 UTC>",
  "cvar_daily_pct": 1.23,
  "multiplier": 0.85,
  "multiplier_raw": 0.82,
  "mode": "SCALING",
  "confidence": "high",
  "n_obs": 45,
  "top_contributor": "theforce-xrp-1h",
  "would_have_blocked": false
}
```

`would_have_blocked` = true when `result.multiplier < cfg.deploy_gate_multiplier_threshold`.
This is the key counterfactual: would active CVaR have blocked trial deployments today?

If the append fails, log a warning and continue — passive data collection only.

**Portfolio intel snapshot** — read the shadow log, evaluate promotion criteria,
write `reports/portfolio-intel.json`. Modeled on the HMM `regime-intel.json` pattern.

```
shadow_log = read_jsonl("knowledge/cvar-shadow-log.jsonl")  # [] if missing
promo_cfg = cfg.get("promotion_criteria", {})

shadow_days = (now - shadow_log[0].ts).days if shadow_log else 0
shadow_entries = len(shadow_log)

# Criterion 1: enough calendar days
min_days_met = shadow_days >= promo_cfg.min_shadow_days

# Criterion 2: enough actual entries (no big gaps)
min_entries_met = shadow_entries >= promo_cfg.min_shadow_entries

# Criterion 3: multiplier discriminates (not always 1.0)
discriminating_days = count(e for e in shadow_log if e.multiplier < 0.95)
discriminating_pct = discriminating_days / shadow_entries if shadow_entries else 0
discriminating_met = discriminating_pct >= promo_cfg.multiplier_discriminating_pct

# Criterion 4: confidence is sufficient
confident_days = count(e for e in shadow_log if e.confidence in ["high", "medium"])
confident_pct = confident_days / shadow_entries if shadow_entries else 0
confident_met = confident_pct >= promo_cfg.confidence_sufficient_pct

# Criterion 5: no long failure streaks (consecutive missing days)
# Compare expected daily entries vs actual — find max gap
max_gap = max consecutive calendar days without an entry in shadow_log
failures_met = max_gap < promo_cfg.max_consecutive_failures

promotion_ready = all([min_days_met, min_entries_met, discriminating_met,
                       confident_met, failures_met])
```

Write `reports/portfolio-intel.json`:

```json
{
  "shadow_mode": true,
  "shadow_days": 12,
  "shadow_entries": 12,
  "promotion_ready": false,
  "promotion_criteria": {
    "min_shadow_days":           {"met": false, "value": 12, "threshold": 14},
    "min_shadow_entries":        {"met": false, "value": 12, "threshold": 14},
    "multiplier_discriminating": {"met": true,  "value": 0.42, "threshold": 0.30},
    "confidence_sufficient":     {"met": true,  "value": 0.67, "threshold": 0.50},
    "no_consecutive_failures":   {"met": true,  "value": 0, "threshold": 3}
  },
  "recent_multipliers": [0.85, 0.91, 1.0, 0.78, 0.95, 0.88, 1.0],
  "would_have_blocked_count": 2,
  "avg_multiplier_7d": 0.88,
  "last_updated": "<ISO>"
}
```

`recent_multipliers` = last 7 entries' `multiplier` values (most recent last).
`would_have_blocked_count` = total entries where `would_have_blocked == true`.
`avg_multiplier_7d` = mean of `recent_multipliers`.

When `promotion_ready` flips to true, log:
`"CVaR PROMOTION READY: all criteria met after {shadow_days} days — recommend flipping TAIL_RISK.shadow_mode to false"`

Graceful degradation: missing shadow log → 0 entries, all criteria fail,
`promotion_ready: false`. Missing `promotion_criteria` config → skip intel
evaluation entirely, write `portfolio-intel.json` with `promotion_ready: null`.

**Risk-off gating** (when `shadow_mode == false`):

When the risk multiplier falls below the deploy gate threshold, block
new trial deployments to avoid adding risk during stressed periods.

```
portfolio = read("auto-mode/portfolio.json")
m = portfolio.risk_scaling?.multiplier ?? 1.0
shadow = portfolio.risk_scaling?.shadow_mode ?? true

if !shadow AND m < cfg.deploy_gate_multiplier_threshold:
    Log: "RISK-OFF: m={m} < {threshold} — blocking new trial deployments"
    Skip Step 6 trial deployment this tick
```

This interacts with the circuit breaker:
- Circuit breaker (15% DD) → halts ALL activity (binary, reactive)
- CVaR risk-off (m < 0.60) → blocks new trial deployments only (continuous, pre-emptive)
- CVaR scaling (0.60 ≤ m < 1.0) → existing bots continue but nanoclaw scales suggested_stake_pct

### Step 8d: PORTFOLIO DIAGNOSIS (daily, same cadence as Step 8)

Skip unless Step 8c ran this tick (daily, after CVaR computation).

Level 3 Discover — diagnose portfolio allocation problems using the
tail risk data from Step 8c and live attribution data. This is the
sensor that triggers portfolio kata (Level 3 Improve) when allocation
rules are drifting from optimal.

```
portfolio_risk = read("auto-mode/portfolio-risk.json")
portfolio = read("auto-mode/portfolio.json")
rollup = read("knowledge/live-attribution-rollup.json")
campaigns = read("auto-mode/campaigns.json")
scoring_config = read("scoring-config.json")

issues = []

# 1. Concentration risk: any single strategy > 40% of tail risk
if portfolio_risk.tail_contrib.by_strategy exists:
  for strategy, share in portfolio_risk.tail_contrib.by_strategy:
    if share > 0.40:
      issues.append({
        type: "concentration_risk",
        entity: strategy,
        value: share,
        threshold: 0.40,
        severity: "high" if share > 0.60 else "medium"
      })

# 2. Group imbalance: correlation group targets not met
group_targets = scoring_config.SLOT_MANAGEMENT.group_targets
  ?? {trend: 3, range: 3, vol: 2, carry: 1}
active_by_group = count campaigns with slot_state in {"trial","graduated"}
  grouped by correlation_group
for group, target in group_targets:
  actual = active_by_group.get(group, 0)
  if actual == 0 and target > 0:
    issues.append({
      type: "group_imbalance",
      group: group,
      actual: 0,
      target: target,
      severity: "high"
    })
  elif actual < target * 0.5:
    issues.append({
      type: "group_imbalance",
      group: group,
      actual: actual,
      target: target,
      severity: "medium"
    })

# 3. Risk parity drift: actual allocation weights vs equal-risk target
if len(active_campaigns) >= 4:
  # Compute actual weights (by stake allocation)
  # Compute equal-risk weights (inverse volatility)
  # drift = mean absolute deviation between actual and target
  if drift > 0.15:
    issues.append({
      type: "risk_parity_drift",
      drift: drift,
      threshold: 0.15,
      severity: "medium"
    })

# 4. Archetype over-allocation
archetype_counts = count active campaigns by archetype
max_per_arch = scoring_config.PORTFOLIO_CONSTRAINTS.max_per_archetype ?? 5
for arch, count in archetype_counts:
  if count > max_per_arch * 0.8:
    issues.append({
      type: "archetype_over_allocation",
      archetype: arch,
      count: count,
      limit: max_per_arch,
      severity: "low"
    })

# Compute portfolio health score
high_severity = len([i for i in issues if i.severity == "high"])
medium_severity = len([i for i in issues if i.severity == "medium"])
portfolio_health_score = max(0, 1.0 - (high_severity * 0.20) - (medium_severity * 0.10))

Write reports/portfolio-audit.json:
  {
    last_audit: now_utc,
    issues: issues,
    portfolio_health_score: portfolio_health_score,
    portfolio_kata_recommended: portfolio_health_score < 0.60,
    n_active_bots: len(active_campaigns),
    group_coverage: {group: count for group, count in active_by_group}
  }

If portfolio_health_score < 0.60:
  Log: "PORTFOLIO HEALTH LOW: score={score}, {n} issues detected.
        Portfolio kata recommended."
```

## Epilogue — Sync and Log

After completing portfolio analysis (Steps 8-8d):

1. Append completion entry to tick-log:
   ```
   append to auto-mode/tick-log.jsonl:
     {"ts": now, "tick_id": null, "skill": "monitor-portfolio", "step": 8,
      "phase": "complete",
      "outcome": "portfolio_analysis_correlation_{corr}_cvar_{cvar}_health_{score}"}
   ```

2. Sync to Supabase: `portfolio_correlation`, `regime_transitions`, `campaigns`.

3. Message user with daily summary:
   - Portfolio Sharpe estimate and correlation
   - Any portfolio diagnosis issues (from Step 8d)

4. Write auto-memory summary to `~/.claude/memory/monitor-portfolio.md`:
   ```
   # Monitor-Portfolio Tick Summary
   Updated: {ISO timestamp}

   ## Portfolio Health
   Sharpe estimate: {value} | Correlation: {value} | CVaR: {value}
   Circuit breaker: {armed|safe} | Concerns: {count}

   ## Next Tick Notes
   {any open concerns or items to recheck next run}
   ```

**Note:** Competition scorecard, season dashboard (Step 8e), regime effectiveness (Step 8f),
and daily briefing are handled by the `monitor-rollup` skill — run it separately
(daily when season/competition active, weekly otherwise).


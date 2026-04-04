---
name: scout
description: >
  Portfolio Gap Scanner — scores 560 cells (7 archetypes x 20 pairs x 4 timeframes),
  ranks uncovered gaps by composite quality, regime alignment, group diversity, qualifier
  readiness, and deployment history. Produces a prioritized gap report with fast-validation
  targets and suggested next actions. Trigger on: "scout", "gap scan", "gap report",
  "what should we build", "portfolio gaps", "coverage scan", "show gaps",
  "research priorities", "find opportunities", "top gaps".
---

# Scout — Portfolio Gap Scanner

Scores 560 cells and ranks portfolio gaps to identify the highest-value research targets.

## DATA SOURCES

All paths are container-local under `/workspace/group/`.

| File | Purpose | Required |
|------|---------|----------|
| `reports/cell-grid-latest.json` | Primary: per-cell composite scores from Market Timing | Yes |
| `reports/cell-grid-5m.json` | Fallback: per-timeframe grid (5m) | No |
| `reports/cell-grid-15m.json` | Fallback: per-timeframe grid (15m) | No |
| `reports/cell-grid-1h.json` | Fallback: per-timeframe grid (1h) | No |
| `reports/cell-grid-4h.json` | Fallback: per-timeframe grid (4h) | No |
| `auto-mode/roster.json` | Graduated strategies (deployed or roster-ready) | Yes |
| `auto-mode/deployments.json` | Currently active/shadow/paused deployments | Yes |
| `auto-mode/triage-progress.json` | Active triage queue and qualifier results | Yes |
| `auto-mode/missed-opportunities.json` | Historical missed-opportunity hit counts | No |
| `reports/sentiment-latest.json` | Sizing modifier from CT/macro sentiment | No |
| `auto-mode/portfolio.json` | Portfolio-level drawdown and circuit breaker state | No |
| `/workspace/skills/archetype-taxonomy/archetypes.yaml` | Archetype definitions, preferred/anti regimes | Yes |
| `scoring-config.json` | Optional weight overrides (see Scoring Algorithm) | No |

**NOTE:** State files remain under `auto-mode/` for backward compatibility (the directory was NOT renamed).

Read data:
```bash
cat /workspace/group/reports/cell-grid-latest.json
cat /workspace/group/auto-mode/roster.json
cat /workspace/group/auto-mode/deployments.json
cat /workspace/group/auto-mode/triage-progress.json
cat /workspace/group/auto-mode/missed-opportunities.json 2>/dev/null || echo "[]"
cat /workspace/group/reports/sentiment-latest.json 2>/dev/null || echo "{}"
cat /workspace/group/auto-mode/portfolio.json 2>/dev/null || echo "{}"
cat /workspace/skills/archetype-taxonomy/archetypes.yaml
cat /workspace/group/scoring-config.json 2>/dev/null || echo "{}"
```

## THE 560-CELL GRID

**Dimensions:** 7 archetypes x 20 pairs x 4 timeframes = **560 cells**

### Archetypes

| Archetype | Correlation Group |
|-----------|------------------|
| TREND_MOMENTUM | trend |
| BREAKOUT | trend |
| MEAN_REVERSION | range |
| RANGE_BOUND | range |
| SCALPING | vol |
| VOLATILITY_HARVEST | vol |
| CARRY_FUNDING | carry |

### Correlation Groups

Groups cluster correlated archetypes. Zero coverage in a group is the strongest diversity signal.

| Group | Archetypes |
|-------|-----------|
| **trend** | TREND_MOMENTUM, BREAKOUT |
| **range** | MEAN_REVERSION, RANGE_BOUND |
| **vol** | SCALPING, VOLATILITY_HARVEST |
| **carry** | CARRY_FUNDING |

### Pairs (20)

BTC, ETH, SOL, XRP, BNB, DOGE, ADA, AVAX, LINK, TON, SUI, DOT, SHIB, NEAR, UNI, LTC, BCH, APT, ARB, OP

### Timeframes (4)

5m, 15m, 1h, 4h

Horizon mapping: 5m -> H1_MICRO, 15m -> H1_MICRO, 1h -> H2_SHORT, 4h -> H3_MEDIUM

### Cell States

| State | Meaning |
|-------|---------|
| **COVERED** | Strategy deployed (active, shadow, or paused) in roster/deployments |
| **GAP** | No strategy deployed -- eligible for gap scoring |
| **DEPRIORITIZED** | Gap but scored <= 0 due to penalties (anti-regime, failed deployments, etc.) |

## SCORING ALGORITHM

For each GAP cell (not COVERED), compute `gap_score`. If `/workspace/group/scoring-config.json` exists,
read weight overrides from it (keys match the names below). Otherwise use defaults.

### Step 0: Pre-checks

These apply before the main scoring formula:

| Check | Condition | Effect |
|-------|-----------|--------|
| Already covered | Cell is in roster or deployments (active/shadow/paused) | `gap_score = 0` -- skip |
| No cell data | Cell missing from cell-grid-latest.json | `gap_score = -10` |
| Anti-regime active | Current regime is in archetype.anti_regimes AND conviction >= 60 | `gap_score = -5` |
| Active kata running | Cell (archetype, pair, timeframe) has an active kata in triage | `gap_score += -10` |
| Active triage | Cell is in the triage queue (not yet graduated) | `gap_score += -8` |

### Step 1: Base Gap Score

Uses the cell's composite from the Market Timing grid:

```
base_gap_score = composite x COMPOSITE_SCORE_WEIGHT
```

| Factor | Weight | Description |
|--------|--------|-------------|
| COMPOSITE_SCORE | **2.0** | Cell composite from market-timing (regime_fit x 0.4 + execution_fit x 0.25 + net_edge x 0.35) |

### Step 2: Diversity Bonuses

| Factor | Weight | Description |
|--------|--------|-------------|
| GROUP_DIVERSITY | **5.0** | Correlation group has ZERO graduated strategies in roster |
| ARCHETYPE_ZERO_COVERAGE | **3.0** | Archetype has ZERO graduated strategies in roster |
| TIMEFRAME_FREQUENCY | **2.0** | Timeframe bonus: 5m=1.0, 15m=1.0, 1h=0.7, 4h=0.3 (faster TFs = faster validation) |

### Step 3: Regime Match

| Factor | Weight | Description |
|--------|--------|-------------|
| REGIME_MATCH | **3.0** | Current regime is in archetype.preferred_regimes (binary: 1 or 0) |

When the regime is preferred, the cell is more likely to produce a valid backtest during research.
Applied as: `+3.0` if preferred regime is active, `+0` otherwise.

### Step 4: Edge Signals

| Factor | Value | Description |
|--------|-------|-------------|
| NET_EDGE_BONUS | from composite | Already embedded in composite via net_edge subscore (weight 0.35) |
| QUALIFIER_BOOST | **+3.0** | Triage qualifier exists for this cell (a starting strategy is ready) |
| Edge bonus (high) | **+2.0** | Qualifier Sortino >= 1.5 |
| Edge bonus (mid) | **+1.0** | Qualifier Sortino >= 0.5 |

### Step 5: Penalties

| Factor | Value | Cap | Description |
|--------|-------|-----|-------------|
| DEPLOYMENT_FAILURE_PENALTY | **-3.0** | -- | Previous deployment at this (archetype, pair) retired with negative PnL |
| DEPLOYMENT_CHURN_PENALTY | **-1.0** per pause cycle | **-5.0** | 4+ pause cycles indicate persistent anti-regime alignment |
| PERSISTENCE_BONUS | **+0.5** per consistent snapshot | **+3.0** | Cell has appeared in top gaps for 3+ consecutive snapshots |
| Abandoned campaign | **-2.0** | -- | Research campaign for this cell was abandoned |
| Active campaign | **+1.0** | -- | Research campaign is active or monitoring |
| Far from deploy | **-2.0** | -- | Composite > 1.0 below archetype-specific min_composite threshold |
| Stability weight | **1.5** | -- | Cell consistency across historical snapshots (x consistency ratio) |
| Falling trend penalty | **-0.5** | -- | Cell composite trending downward across snapshots |
| Graduation speed | **2.0** | -- | Faster graduation archetypes/timeframes score higher (x speed factor) |

### Step 6: Multipliers

Applied after all additive factors:

| Multiplier | Range | Description |
|------------|-------|-------------|
| SENTIMENT | floor **0.4** | `max(0.4, 0.4 + 0.6 x sizing_modifier)` from sentiment-latest.json. Never fully zeroes out a gap. |
| CIRCUIT_BREAKER | **0** if active | If portfolio DD > 15%, all gap_scores = 0. No new research recommended. |

### Step 7: Net Edge Rebalancing

When ALL cells in the grid have `net_edge = 0` (no backtest data exists anywhere), the composite
formula underweights cells. Rebalance by recomputing composite without net_edge:

```
adjusted_composite = regime_fit x 0.62 + execution_fit x 0.38
delta = adjusted_composite - original_composite
gap_score += delta x COMPOSITE_SCORE_WEIGHT
```

Also apply proxy net_edge from triage qualifiers when net_edge data is unavailable:
- Qualifier Sortino >= 1.5 -> proxy net_edge 5
- Qualifier Sortino >= 1.0 -> proxy net_edge 4
- Qualifier Sortino >= 0.5 -> proxy net_edge 3
- Qualifier Sortino > 0 -> proxy net_edge 2

### Final Formula (Summary)

```
gap_score = (
    composite x 2.0                              # base quality
  + (group_zero ? 5.0 : 0)                       # group diversity
  + (archetype_zero ? 3.0 : 0)                   # archetype coverage
  + tf_frequency_bonus x 2.0                     # timeframe speed
  + (regime_preferred ? 3.0 : 0)                 # regime match
  + (qualifier_exists ? 3.0 : 0)                 # qualifier boost
  + edge_bonus                                   # 0, 1.0, or 2.0
  + deployment_failure_penalty                   # -3.0 or 0
  + deployment_churn_penalty                     # -1.0 per cycle, cap -5.0
  + persistence_bonus                            # +0.5 per snapshot, cap +3.0
  + campaign_adjustment                          # -2.0, 0, or +1.0
  + far_from_deploy_penalty                      # -2.0 or 0
  + stability_term                               # consistency x 1.5
  + falling_trend_penalty                        # -0.5 or 0
  + graduation_speed_term                        # speed x 2.0
) x sentiment_factor                             # floor 0.4
x circuit_breaker_gate                           # 0 or 1
```

## OUTPUT

Write the report to: `/workspace/group/reports/gap-report.json`

```json
{
  "generated_at": "2026-04-04T12:00:00Z",
  "data_freshness_hours": 2.3,
  "sentiment_modifier": 0.85,
  "circuit_breaker": false,
  "net_edge_rebalanced": false,
  "summary": {
    "total_cells": 560,
    "gaps_scored": 480,
    "covered_cells": 80,
    "group_coverage": {"trend": 3, "range": 2, "vol": 0, "carry": 0},
    "archetype_coverage": {"TREND_MOMENTUM": 2, "BREAKOUT": 1, "MEAN_REVERSION": 1, "RANGE_BOUND": 1, "SCALPING": 0, "VOLATILITY_HARVEST": 0, "CARRY_FUNDING": 0},
    "empty_groups": ["vol", "carry"]
  },
  "top_gaps": [
    {
      "rank": 1,
      "archetype": "SCALPING",
      "pair": "BTC",
      "timeframe": "5m",
      "group": "vol",
      "regime": "EFFICIENT_TREND",
      "conviction": 82,
      "composite": 3.8,
      "gap_score": 18.4,
      "preferred_regime_active": true,
      "qualifier_strategy": "ScalpBTC_v2",
      "qualifier_sortino": 1.8,
      "graduation_days": 7,
      "distance_to_deploy": 0.3,
      "sentiment_factor": 0.92,
      "in_active_kata": false,
      "campaign_state": null,
      "net_edge_rebalanced": false
    }
  ],
  "fast_validation_targets": [
    {
      "archetype": "SCALPING",
      "pair": "BTC",
      "timeframe": "5m",
      "gap_score": 18.4,
      "graduation_days": 7,
      "qualifier_strategy": "ScalpBTC_v2"
    }
  ],
  "deprioritized": [
    {
      "archetype": "CARRY_FUNDING",
      "pair": "SHIB",
      "timeframe": "4h",
      "gap_score": -3.2,
      "reason": "anti-regime active + deployment failure history"
    }
  ]
}
```

**fast_validation_targets**: Top 5 gaps from the top_gaps list where timeframe is 5m or 15m AND
preferred regime is active. These can be validated fastest.

## DISPLAY FORMAT

Present the report to the user in this format:

```
## Scout -- Gap Report
**Time:** YYYY-MM-DD HH:MM UTC
**Data freshness:** Xh | **Sentiment:** X.XX | **Net-edge rebalanced:** yes/no

### Coverage
- Groups: trend=N, range=N, vol=N, carry=N
- EMPTY GROUPS: vol, carry
- Covered: N/560 cells | Gaps scored: N

### Top 15 Gaps
| # | Archetype | Pair | TF | Score | Comp | Grad | Qualifier | Status |
|---|-----------|------|----|-------|------|------|-----------|--------|
| 1 | SCALPING | BTC | 5m | 18.4 | 3.8 | 7d | ScalpBTC_v2 (S=1.8) | regime OK |
| 2 | VOLATILITY_HARVEST | ETH | 1h | 15.2 | 3.2 | 14d | -- | regime OK |
| ... | | | | | | | | |

### Fast Validation (5m/15m + regime favorable)
1. SCALPING BTC 5m score=18.4 grad=7d [Q: ScalpBTC_v2]
2. ...

### Suggested Next Actions
1. Start kata for top gap: SCALPING BTC 5m
2. Investigate empty groups: vol, carry
3. Re-run market timing to refresh stale cells (if freshness > 8h)
```

## WORKFLOW

1. **Load data** -- read all data sources listed above
2. **Build coverage index** -- identify COVERED cells from roster + deployments
3. **Count graduates** -- per correlation group and per archetype from roster
4. **Score each GAP cell** -- apply the full scoring algorithm
5. **Sort by gap_score descending** -- rank all gaps
6. **Extract fast validation targets** -- top 5 where TF in (5m, 15m) and regime preferred
7. **Write report** -- save to `/workspace/group/reports/gap-report.json`
8. **Display summary** -- show coverage stats, top gaps table, fast targets, next actions

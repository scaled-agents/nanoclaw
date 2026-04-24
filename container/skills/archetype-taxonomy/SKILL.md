---
name: archetype-taxonomy
description: >
  Canonical definition of 7 strategy archetypes, configurable cell scoring grid (default 560 cells),
  and portfolio constraints for the Market Timing Agent. Reference this when scoring cells,
  mapping strategies to archetypes, or evaluating deployment readiness.
---

# Archetype Taxonomy — Strategy Classification & Cell Scoring

Defines the 7 archetypes, their regime preferences, the cell grid schema (default 7 × 20 × 4 = 560),
scoring rubrics for regime_fit/execution_fit/net_edge, and portfolio constraints.

## The 7 Archetypes

| Archetype | Best Regimes | Anti Regimes | Preferred Pairs | Timeframes | Strategy Tags |
|-----------|-------------|-------------|-----------------|------------|---------------|
| **TREND_MOMENTUM** | EFFICIENT_TREND | CHAOS, COMPRESSION | T1+T2 (10) | 1h, 4h | trend_following, momentum, ema_crossover |
| **MEAN_REVERSION** | TRANQUIL, COMPRESSION | EFFICIENT_TREND, CHAOS | T1+T2+T3 (15) | 15m, 1h | mean_reversion, rsi, bollinger |
| **BREAKOUT** | COMPRESSION | TRANQUIL, CHAOS | T1 (5) | 1h, 4h | breakout, donchian, range_breakout |
| **RANGE_BOUND** | TRANQUIL | EFFICIENT_TREND, CHAOS | T1+T2+T3 (15) | 15m, 1h | range, support_resistance, grid |
| **SCALPING** | EFFICIENT_TREND, TRANQUIL | CHAOS | BTC, ETH, SOL | 5m, 15m | scalping, micro_trend |
| **CARRY_FUNDING** | TRANQUIL | CHAOS, EFFICIENT_TREND | T1+T2+T3 (15) | 4h, 1d | carry, funding_rate, basis_trade |
| **VOLATILITY_HARVEST** | CHAOS, COMPRESSION | TRANQUIL | T1 (5) | 1h, 4h | volatility, supertrend, atr_expansion |

## Pair Tiers

| Tier | Pairs | Liquidity | Notes |
|------|-------|-----------|-------|
| **T1** | BTC, ETH, SOL, XRP, BNB | Highest | All archetypes viable |
| **T2** | DOGE, ADA, AVAX, LINK, TON | Good | Most archetypes except scalping |
| **T3** | SUI, DOT, SHIB, NEAR, UNI | Moderate | Trend, range, mean-reversion, carry |
| **T4** | LTC, BCH, APT, ARB, OP | Adequate | Wider spreads, execution_fit naturally lower |
| **T5** | (user-added via instance-config.json) | Lowest assumed | Not in preferred_pairs; execution_fit handles liquidity |

All default pairs appear in the grid. Additional pairs can be added via `instance-config.json`
(see exchange-config skill). Execution_fit scoring handles liquidity — low-liquidity pairs
get lower execution_fit scores, which keeps composites below deploy threshold for archetypes
that need tight spreads. Preferred_pairs is advisory guidance for research prioritization.

## Cell Grid

**Default dimensions:** 7 archetypes × 20 pairs × 4 timeframes = **560 cells**

The pair list can be extended or reduced via `instance-config.json` (see exchange-config skill).
Effective cell count = 7 × effective_pair_count × 4.

**Default pairs (20):** BTC, ETH, SOL, XRP, BNB, DOGE, ADA, AVAX, LINK, TON, SUI, DOT, SHIB, NEAR, UNI, LTC, BCH, APT, ARB, OP
**Timeframes:** 5m, 15m, 1h, 4h

Each cell stores:
```json
{
  "archetype": "TREND_MOMENTUM",
  "pair": "BTC",
  "timeframe": "1h",
  "regime_fit": 5,
  "execution_fit": 4,
  "net_edge": 3,
  "composite": 4.05,
  "deployed_strategy": "EMA_Crossover_v3",
  "deployment_id": "dep_abc123",
  "last_scored": "2026-03-25T18:00:00Z"
}
```

## Scoring Rubrics

### regime_fit (0–6) — Weight: 40%

Does the current market regime match this archetype?

| Score | Condition |
|-------|-----------|
| 6 | Regime is preferred AND conviction >= 80% |
| 5 | Regime is preferred AND conviction >= 60% |
| 4 | Regime is preferred AND conviction < 60% |
| 3 | Regime is neutral (not preferred, not anti) |
| 2 | Regime is anti BUT conviction < 40% |
| 1 | Regime is anti AND conviction >= 40% |
| 0 | Regime is anti AND conviction >= 60% |

**Data source:** `orderflow_fetch_regime(symbols=[pair], horizon=<mapped>)`

Horizon mapping: 5m→H1_MICRO, 15m→H1_MICRO, 1h→H2_SHORT, 4h→H3_MEDIUM

### execution_fit (0–6) — Weight: 25%

Is the market microstructure suitable for clean execution?

| Score | Condition |
|-------|-----------|
| 6 | Book balanced, whale flow aligned, aggressor confirms direction |
| 5 | Two of three microstructure signals aligned |
| 4 | One strong signal, others neutral |
| 3 | All neutral |
| 2 | One negative signal |
| 1 | Two negative signals |
| 0 | All three negative — adverse microstructure |

**Data source:** `orderflow_fetch_microstructure(symbols=[pair], horizon=<mapped>)`

Microstructure signals:
- **Whale flow:** buying → bullish aligned, selling → bearish aligned, neutral → neutral
- **Book imbalance:** bid_heavy → supports longs, ask_heavy → supports shorts, balanced → neutral
- **Aggressor ratio:** accumulation → bullish, distribution → bearish, neutral → neutral

### net_edge (0–6) — Weight: 35%

Historical backtest performance for the best strategy at this (archetype, pair, timeframe) cell.

| Score | Condition |
|-------|-----------|
| 6 | WF Sharpe >= 1.5, max DD < 10%, trades >= 30 |
| 5 | WF Sharpe >= 1.0, max DD < 15% |
| 4 | WF Sharpe >= 0.5, max DD < 20% |
| 3 | WF Sharpe >= 0.0 (breakeven) |
| 2 | WF Sharpe > -0.5 (mild negative) |
| 1 | WF Sharpe > -1.0 |
| 0 | No data OR WF Sharpe <= -1.0 |

**Data source:** FreqHub registry (`freqhub leaderboard`), triage-matrix results, or aphexDATA historical backtests.

### Composite Score

```
composite = (regime_fit × 0.4) + (execution_fit × 0.25) + (net_edge × 0.35)
```

| Composite | Action |
|-----------|--------|
| >= 3.5 | **DEPLOY** — cell meets deployment threshold |
| 2.0–3.5 | **MONITOR** — watch but don't deploy |
| < 2.0 | **UNDEPLOY** — if active, remove deployment |

## Portfolio Constraints

| Constraint | Limit |
|------------|-------|
| Max deployments per archetype | 5 |
| Max deployments per pair | 3 |
| Max total active deployments | 20 |
| Max capital % per single deployment | 10% |
| Max capital % per archetype | 25% |
| Max capital % per pair | 15% |
| Portfolio DD circuit breaker | 15% — pause ALL new deployments |

## Mapping Strategies to Archetypes

To classify an existing strategy:
1. Check its `strategy_tags` against the archetype tag lists above
2. Use `freqhub search --tag <tag>` to find matching strategies in the registry
3. Or grep the strategy source for archetype indicator signatures

A strategy can match multiple archetypes. Use the one with the highest `net_edge` score for that cell.

## Configuration

The canonical archetype definitions live in:
```
container/skills/archetype-taxonomy/archetypes.yaml
```

This file is mounted into the container and can be read by the agent via Bash:
```bash
cat /workspace/skills/archetype-taxonomy/archetypes.yaml
```

## Usage in Market Timing Workflow

1. Read `archetypes.yaml` for archetype definitions
2. For each cell, call `orderflow_fetch_regime` → compute `regime_fit`
3. Call `orderflow_fetch_microstructure` → compute `execution_fit`
4. Look up historical performance → compute `net_edge`
5. Compute `composite` → compare against thresholds
6. Apply portfolio constraints → final deployment plan

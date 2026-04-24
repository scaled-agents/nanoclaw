---
name: freqhub
description: >
  Use this skill to manage TRADE.md strategy files and interact with the FreqHub
  strategy registry. Covers the trade-md CLI (lint, compile, explain, diff) for
  strategy format operations and the freqhub CLI (build, search, get, leaderboard)
  for registry discovery. TRADE.md is the source of truth — compiled .py files are
  build artifacts.
  Trigger on: "freqhub", "registry", "trade-md", "compile strategy",
  "lint strategy", "strategy registry", "search strategies", "leaderboard".
---

# FreqHub — Strategy Registry + TRADE.md Format

Two CLI tools for the **Create → Lint → Compile → Backtest → Update Provenance → Publish** workflow.

- **trade-md** (Python) — Strategy format: lint, compile, explain, diff
- **freqhub** (Node.js) — Strategy registry: build, search, get, leaderboard

## TRADE.md Format

Strategies use **YAML front matter + Markdown prose**:

```yaml
---
trade_md_spec: "0.2"
name: heritage-rsi-ema
version: 0.4.0

market:
  regime: [trending, high-volatility]
  timeframe: 5m
  informative_timeframes: [1h]
  pair_universe:
    quote: USDT
    exchange: binance
    filter: top50_volume

indicators:
  trend_filter: "ema(200)"
  vol_surge: "volume > sma(20).rolling(20).mean() * 1.5"

signals:
  entry_long:
    conditions:
      - "rsi(14) < 30"
      - "close > {trend_filter}"
      - "{vol_surge}"
    tag: "rsi_oversold_uptrend"
  exit_long:
    conditions:
      - "rsi(14) > 70 or close < ema(50)"
    tag: "rsi_overbought"

risk:
  stoploss: -0.03
  roi:
    "0": 0.04
    "30": 0.02
    "60": 0.01
    "120": 0
  trailing:
    enabled: true
    positive: 0.01
    offset: 0.015

sizing:
  method: fixed_stake
  max_open_trades: 5

provenance:
  backtest_start: "2024-01-01"
  backtest_end: "2025-12-31"
  sharpe: 1.9
  max_dd: 0.12
  win_rate: 0.59
  profit_factor: 1.62
  trades: 312
  last_validated: "2026-04-22"

lineage:
  parent: heritage-rsi-ema@0.3.1
  kata_iteration: 15
  graduation_status: simulation

disable_when:
  - max_drawdown_exceeds: 0.15
    lookback_days: 14
  - regime_shifts_to: [ranging, low-volatility]
---

## Thesis
RSI(14) oversold pullback with EMA(200) trend confirmation and volume surge gate.

## When this works
Trending markets with clear pullback structure. Works best in high-volume conditions.

## When to disable
Ranging or low-volatility markets where mean-reversion dominates.

## Kata lineage
v0.3.1→v0.4.0: Widened trailing offset from 0.01 to 0.015 based on ATR analysis.

## Known failure modes
False RSI oversold signals during extended downtrends. Volume gate helps but doesn't eliminate.
```

### Key Format Rules

- **Front matter** (YAML): Machine-readable tokens — compiled to .py
- **Prose** (Markdown H2 sections): Human-readable rationale — not compiled
- **Indicators**: DSL expressions using built-in functions (rsi, ema, sma, atr, bb, macd, etc.)
- **Signals**: Conditions are ANDed within a block. Use `or` within a string for OR logic
- **Informative timeframes**: Suffix indicators with `@1h` for higher timeframe confirmation
- **User indicators**: Reference with `{name}` curly braces
- **Custom indicators** (v0.2): Python `@indicator` modules in `indicators/` subdirectory

## trade-md CLI (4 commands)

```bash
# Validate against 16 linter rules (R001-R016)
trade-md lint TRADE.md
trade-md lint my-strategy/                    # Directory mode (v0.2)
trade-md lint TRADE.md --format json          # Machine-readable

# Compile to FreqTrade IStrategy Python
trade-md compile --target freqtrade TRADE.md -o Strategy.py
trade-md compile --allow-version-drift ...    # Suppress version pin mismatches

# Natural-language summary (~25 lines)
trade-md explain TRADE.md
trade-md explain TRADE.md --format json

# Regression detection between versions
trade-md diff old.TRADE.md new.TRADE.md

# Indicator tooling (v0.2)
trade-md new-indicator sep_score              # Scaffold template
trade-md lint-indicator indicators/sep_score.py

# Spec reference
trade-md spec [--rules-only] [--format json]
```

## freqhub CLI (4 commands)

```bash
# Build registry.json from content directory of TRADE.md files
freqhub build content/ -o dist/

# Search strategies by text, tag, min Sharpe, timeframe, pair
freqhub search "rsi" --tag mean-reversion --min-sharpe 0.5 --timeframe 1h --json

# Fetch a strategy by ID (returns TRADE.md content or metadata)
freqhub get freqtrade/CMF_EMA
freqhub get freqtrade/CMF_EMA --json         # Metadata only

# Leaderboard — ranked by Sharpe
freqhub leaderboard --top 20 --tier strong
```

## Quality Tiers

| Tier | Sharpe Threshold |
|------|-----------------|
| exceptional | ≥ 1.5 |
| strong | ≥ 1.0 |
| viable | ≥ 0.5 |
| experimental | < 0.5 |

## Configuration

FreqHub config lives at `~/.freqhub/config.yaml`:

```yaml
sources:
  - name: community
    url: https://raw.githubusercontent.com/scaled-agents/freqhub/main/dist
```

Remote registries are cached locally at `~/.freqhub/sources/<name>/registry.json`.

## Typical Agent Workflows

### Discover → Compile → Backtest

```
1. freqhub search --tag momentum --min-sharpe 0.5 --json  # Find strategies
2. freqhub get <id>                                        # Fetch TRADE.md
3. trade-md lint TRADE.md                                  # Validate
4. trade-md compile --target freqtrade TRADE.md -o strategies/  # Compile to .py
5. Use freqtrade tools to backtest the compiled strategy
6. Update provenance block in TRADE.md with backtest results
```

### Kata Iteration (behavioral change)

```
1. Bump version PATCH, increment kata_iteration
2. Update lineage.parent to current version
3. Make the behavioral change in front matter tokens
4. Update ## Kata lineage prose section
5. trade-md lint TRADE.md                    # Validate
6. trade-md compile --target freqtrade ...   # Recompile
7. Backtest compiled .py
8. Write results into provenance block
9. trade-md diff old.TRADE.md new.TRADE.md   # Check for regressions
```

### After Graduation (aphexDATA → FreqHub Pipeline)

When a strategy graduates from paper trading:

1. **Update TRADE.md provenance** with live metrics (sharpe, win_rate, trades, pnl)
2. **Update lineage.graduation_status** to `paper` or `live`
3. **Lint**: `trade-md lint TRADE.md`
4. **Rebuild registry**: `freqhub build content/ -o dist/`
5. **Log to aphexDATA**: `aphexdata_record_event(verb_id="strategy_graduated", ...)`

When a strategy is retired:

1. **Log to aphexDATA only**: `aphexdata_record_event(verb_id="retired", ...)`
2. **Update lineage.graduation_status** to `retired`
3. No registry update needed — retired strategies don't need publishing

### Browse the Registry

```
1. freqhub leaderboard --top 10              # See top strategies by Sharpe
2. freqhub search --tag trend-following       # Filter by archetype tag
3. freqhub get <id> --json                   # Full metadata for a strategy
```

## Content Layout

```
content/
  freqtrade/
    CMF_EMA/TRADE.md
    RSI21_MACD_STOCH_TON/TRADE.md
    BigZ04_BNB_15m/TRADE.md
    ...
```

Registry is built to `dist/registry.json` with strategies, leaderboard, and stats.

## Condition DSL Reference

### Built-in indicators
`rsi(N)`, `ema(N)`, `sma(N)`, `atr(N)`, `adx(N)`, `macd()`, `macd_signal()`,
`macd_hist()`, `bb_upper(N, std)`, `bb_lower(N, std)`, `bb_middle(N)`,
`stoch_k(N)`, `stoch_d(N)`

### OHLCV references
`open`, `high`, `low`, `close`, `volume`, `hl2`, `hlc3`, `ohlc4`

### Informative timeframes
Suffix with `@<tf>`: `rsi(14)@1h`, `close > ema(200)@4h`

### Pandas methods
`volume.rolling(20).mean()`, `close.pct_change(5)`, `close.shift(1)`

### Crossovers
`crosses_above(a, b)`, `crosses_below(a, b)`

### Operators
Comparison: `<`, `>`, `<=`, `>=`, `==`, `!=`
Logical: `and`, `or`, `not`
Arithmetic: `+`, `-`, `*`, `/`

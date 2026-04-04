---
name: strategyzer
description: >
  Diverge-Evaluate-Converge pipeline for finding strategy candidates to fill
  portfolio gaps. Searches the strategy library, generates Pine Scripts via
  LuxAlgo Quant, or builds from scratch. Quick-backtests each candidate,
  selects up to 3 diverse race candidates for kata optimization.
  Trigger on: "strategyzer", "explore gap", "find strategy for",
  "explore options for", "explore top gap", "fill the gap",
  "generate strategy", "diverge".
---

# Strategyzer -- Diverge-Evaluate-Converge Pipeline

Find strategy candidates to fill a portfolio gap. Three search paths
(cheapest first), quick-backtest each, select the best from each path
for maximum diversity. Output: race candidates ready for kata.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `scout` | Provides `gap-report.json` with ranked gaps (input Option A) |
| `freqtrade-mcp` | `freqtrade_run_backtest` for quick evaluation |
| `luxalgo` MCP | Pine Script generation (Path B) |
| `ps2python` | Pine Script to FreqTrade Python conversion |
| `archetype-taxonomy` | Archetype definitions, indicator signatures |

---

## Input

Three ways to invoke strategyzer. Determine which applies:

### Option A: From gap-report.json (default)

Read `/workspace/group/reports/gap-report.json` (produced by scout).
Each gap entry has:
```json
{
  "archetype": "MEAN_REVERSION",
  "pair": "XRP/USDT:USDT",
  "timeframe": "15m",
  "composite": 1.2,
  "net_edge": 0,
  "reason": "no_strategy"
}
```
Pick the top gap (highest composite with lowest net_edge). If the user says
"explore top gap", use rank 1. If the user says "explore gap #3", use rank 3.

### Option B: Explicit target

User specifies archetype, pair, and timeframe directly:
> "Find a TREND_MOMENTUM strategy for ETH/USDT:USDT 1h"

### Option C: Auto from monitor

Monitor triggers strategyzer when a high-scoring cell has no strategy.
Input arrives as the same gap entry JSON.

---

## PHASE 1: DIVERGE -- Generate Candidates

Search three paths, cheapest first. Stop adding paths once you have
at least 2 viable candidates (but always complete the current path).

### Path A: Strategy Library (cheapest)

Search the existing strategy library for matches. Three tiers of fit:

**Tier 1 -- Qualifiers:** Strategies already validated for this exact cell.
```bash
# Read strategy header tags
grep -l "# ARCHETYPE: $ARCHETYPE" /workspace/group/user_data/strategies/*.py
```
Filter to strategies whose `VALIDATED_PAIRS` includes the target pair and
whose timeframe matches. These are already graduated -- skip to PHASE 2.

**Tier 2 -- Partial Edge:** Same archetype, different pair or timeframe.
These have proven the archetype logic works but need re-validation on the
target cell. Include them as candidates.

**Tier 3 -- Untested by Archetype Indicators:** Scan the strategy library
for strategies that use indicator signatures matching the target archetype,
even if not tagged. Match against these archetype indicator signatures:

| Archetype | Indicator Signatures |
|-----------|---------------------|
| MEAN_REVERSION | bbands, rsi, stochastic, keltner |
| TREND_MOMENTUM | ema, macd, adx, supertrend, aroon |
| BREAKOUT | donchian, bbands_squeeze, keltner_squeeze |
| SCALPING | vwap, rsi, ema_short, volume |
| RANGE_BOUND | keltner, pivots, stochastic, rsi |
| VOLATILITY_HARVEST | atr, bbands_width, keltner |
| CARRY_FUNDING | rsi_extreme, sma_long |

```bash
# Example: scan for MEAN_REVERSION indicators
grep -l -E '(bbands|rsi|stochastic|keltner)' /workspace/group/user_data/strategies/*.py
```

### Path B: LuxAlgo Quant (moderate cost)

Generate 2 Pine Scripts per archetype using the LuxAlgo MCP tools.
Start a new conversation for each prompt. Use the archetype-specific
prompts below (each is a complete, self-contained instruction).

**MEAN_REVERSION prompts:**

Prompt 1 -- Keltner Channel mean reversion:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: Keltner Channel mean reversion. EMA length 20, ATR multiplier 1.5. Long when close < lower band AND RSI(7) < 35. Short when close > upper band AND RSI(7) > 65. Exit long when close crosses above midline EMA. Exit short when close crosses below midline EMA. Stoploss: ATR(14) * 1.5 below/above entry, set via strategy.exit(stop=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.ema, ta.atr, ta.rsi, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

Prompt 2 -- Bollinger Bands mean reversion:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: Bollinger Bands mean reversion, BB length 20 stddev 2.0. Long entry: close crosses below lower band AND RSI(14) < 40. Short entry: close crosses above upper band AND RSI(14) > 60. Exit long: close crosses above basis (BB midline). Exit short: close crosses below basis. Stoploss: ATR(14) * 2.0 set via strategy.exit(stop=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.bb, ta.atr, ta.rsi, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

**TREND_MOMENTUM prompts:**

Prompt 1 -- EMA crossover:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: EMA crossover trend following. EMA fast=9, EMA slow=21. Long when ema_fast crosses above ema_slow. Short when ema_fast crosses below ema_slow. Exit long on opposite cross. Exit short on opposite cross. Stoploss: ATR(14) * 2.0 trailing via strategy.exit(trail_points=, trail_offset=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.ema, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

Prompt 2 -- MACD momentum:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: MACD momentum. MACD(12,26,9). Long when MACD line crosses above signal line. Short when MACD line crosses below signal line. Exit on opposite cross. Stoploss: ATR(14) * 2.0 fixed from entry via strategy.exit(stop=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.macd, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

**BREAKOUT prompts:**

Prompt 1 -- Donchian channel breakout:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: Donchian channel breakout. Channel period=20. Long when close breaks above the 20-period highest high. Short when close breaks below the 20-period lowest low. Exit long when close drops below midline ((highest+lowest)/2). Exit short when close rises above midline. Stoploss: ATR(14) * 1.5 via strategy.exit(stop=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.highest, ta.lowest, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

Prompt 2 -- High-low range breakout:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: High-low range breakout. Use previous 10-bar highest high and lowest low. Long when close crosses above previous 10-bar high. Short when close crosses below previous 10-bar low. Exit long after 8 bars (time-based) OR when close drops 1 ATR(14) from high. Exit short after 8 bars OR when close rises 1 ATR(14) from low. Stoploss: ATR(14) * 1.5 via strategy.exit(stop=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.highest, ta.lowest, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

**SCALPING prompts:**

Prompt 1 -- RSI scalp:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: RSI scalp. RSI length=5. Long when RSI crosses above 30. Short when RSI crosses below 70. Exit long when RSI crosses above 60 OR after 4 bars. Exit short when RSI crosses below 40 OR after 4 bars. Stoploss: ATR(14) * 1.0 fixed from entry via strategy.exit(stop=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.rsi, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

Prompt 2 -- EMA micro-trend scalp:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: EMA micro-trend scalp. EMA5 and EMA13. Long when ema5 crosses above ema13 AND close is above EMA(50). Short when ema5 crosses below ema13 AND close is below EMA(50). Exit on opposite EMA5/13 cross OR after 5 bars whichever comes first. Stoploss: ATR(14) * 1.0 via strategy.exit(stop=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.ema, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

**RANGE_BOUND prompts:**

Prompt 1 -- Keltner Channel range:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: Keltner Channel range. EMA length=20, ATR multiplier=2.0. Long when close touches or crosses below lower band. Short when close touches or crosses above upper band. Exit long at midline (EMA). Exit short at midline. Stoploss: ATR(14) * 1.5 via strategy.exit(stop=). No ADX filter. Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.ema, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

Prompt 2 -- CCI range reversion:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: CCI range reversion. CCI length=20. Long when CCI crosses above -100 (coming from below). Short when CCI crosses below +100 (coming from above). Exit long when CCI crosses above 0. Exit short when CCI crosses below 0. Stoploss: ATR(14) * 1.5 via strategy.exit(stop=). No trend filter. Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.cci, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

**VOLATILITY_HARVEST prompts:**

Prompt 1 -- ATR expansion momentum:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: ATR expansion momentum. ATR length=14. Compute ATR SMA over 20 bars. Long when ATR crosses above ATR_SMA * 1.3 AND close > EMA(20). Short when ATR crosses above ATR_SMA * 1.3 AND close < EMA(20). Exit when ATR drops back below ATR_SMA. Stoploss: ATR(14) * 2.0 trailing via strategy.exit(trail_points=, trail_offset=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.atr, ta.sma, ta.ema, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

Prompt 2 -- BB width expansion:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: BB width expansion. BB length=20, std=2.0. BB width = (upper-lower)/basis. Long when BB width crosses above its 20-bar SMA AND close > basis. Short when BB width crosses above its 20-bar SMA AND close < basis. Exit when BB width crosses below its SMA. Stoploss: ATR(14) * 2.0 via strategy.exit(stop=). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.bb, ta.sma, ta.atr, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

**CARRY_FUNDING prompts:**

Prompt 1 -- EMA distance mean reversion:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: EMA distance mean reversion on daily. EMA length=50. Long when close is more than 5% below EMA(50). Short when close is more than 5% above EMA(50). Exit long when close crosses above EMA(50). Exit short when close crosses below EMA(50). Stoploss: -0.10 (10% fixed). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.ema, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

Prompt 2 -- RSI extreme mean reversion:
```
You are a professional Pine Script v6 quant. Output ONLY a complete //@version=6 strategy() block. No explanation before or after. No markdown. The code block must begin with //@version=6 and end with the last Pine Script line.

Strategy: RSI extreme mean reversion for slow timeframes. RSI length=21. Long when RSI drops below 25 and closes there for 2 consecutive bars. Short when RSI rises above 75 and closes there for 2 consecutive bars. Exit long when RSI crosses above 50. Exit short when RSI crosses below 50. Stoploss: -0.08 (8% fixed). Allow pyramiding=0. Do NOT use request.security, arrays, matrices, or user-defined functions. Use only: ta.rsi, ta.crossover, ta.crossunder.

strategy() settings: commission_type=strategy.commission.percent, commission_value=0.075, slippage=2, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100.

Target: {pair} on {timeframe} timeframe.
```

Replace `{pair}` and `{timeframe}` with the actual target values before sending.

After receiving each Pine Script, convert to FreqTrade Python using `ps2python`
or the conversion system prompt (see Conversion Notes below).

### Path C: Build from Scratch (last resort)

Only use if Path A yields 0 candidates AND Path B yields 0 candidates
(LuxAlgo unavailable or all conversions fail).

Write a FreqTrade IStrategy from scratch based on the archetype's indicator
signatures. Use `freqtrade_create_strategy` or `freqtrade_write_strategy_file`.
Keep the logic simple -- one primary indicator plus one confirmation filter.

---

## PHASE 2: EVALUATE -- Quick Backtest Each Candidate

For every candidate from all paths, run a single-window quick backtest.

### Backtest periods by timeframe

| Timeframe | Calendar Days |
|-----------|--------------|
| 1m | 30 |
| 5m | 60 |
| 15m | 90 |
| 1h | 365 |
| 4h | 1095 |
| 1d | 1825 |

### Procedure

For each candidate:
1. Write strategy to `/workspace/group/user_data/strategies/Candidate_{N}.py`
2. Pre-flight check: verify syntax, class name, no Pine Script leaks
3. Run `freqtrade_run_backtest` with the target pair, timeframe, and
   computed timerange
4. Extract: trades, sharpe, profit, max_drawdown, win_rate

### Scoring

```
score_backtest(result):
  if fatal_error:           return 0.0, "<error detail>"
  if indicator_error:       return 0.1, "<error detail>"
  if freqtrade_startup_err: return 0.15, "FreqTrade_error"
  if trades == 0:           return 0.3, "zero trades"
  if trades < 3:            return 0.5, "too few trades"
  if trades < 10:           return 0.7, "check exits"
  if sharpe ~= 0:           return 0.8, "all trades same result"
  else:                     return 1.0, "clean run"
```

### Selection criterion

Winner per path = `max(trades)` where `trades > 0`.
More trades = more data for kata to work with. Sharpe is irrelevant at
this stage -- kata will optimize it.

---

## PHASE 3: CONVERGE -- Select Race Candidates

Pick the best candidate from EACH path that produced viable results
(up to 3 total for diversity). This ensures the kata race has
diversity of approach, not just parameter variations.

### Favorable Sharpe Gate

For each selected candidate, compute `favorable_sharpe` from the
quick-backtest result:
- **favorable_sharpe >= 0.5:** Strategy already qualifies. Skip kata --
  send directly to deployment staging with a `pending_deploy` campaign.
  Log: `"SKIP_KATA: favorable_sharpe={value}, direct to staging"`
- **favorable_sharpe < -0.5:** Drop candidate. Not worth optimizing.
  Log: `"DROPPED: favorable_sharpe={value}, below -0.5 threshold"`
- **-0.5 <= favorable_sharpe < 0.5:** Normal path. Send to kata race.

### Zero Candidates

If all paths produced 0 viable candidates:
1. Log failure to `/workspace/group/reports/strategyzer-result.json`
2. Set `status: "no_candidates"`
3. Message the user: "Strategyzer found no viable candidates for
   {archetype} on {pair} {timeframe}. Paths searched: {paths}.
   Consider: adjusting prompts, trying a different archetype, or
   manual strategy creation."
4. Do NOT retry automatically.

---

## Output

Write results to `/workspace/group/reports/strategyzer-result.json`:

```json
{
  "target": {
    "archetype": "MEAN_REVERSION",
    "pair": "XRP/USDT:USDT",
    "timeframe": "15m",
    "source": "gap-report"
  },
  "paths_searched": {
    "library": {
      "searched": true,
      "qualifiers": 0,
      "partial_edge": 1,
      "indicator_match": 2,
      "viable": 1,
      "best": {
        "name": "BBands_RSI_v2",
        "trades": 47,
        "sharpe": 0.31,
        "source": "partial_edge"
      }
    },
    "luxalgo": {
      "searched": true,
      "prompts_sent": 2,
      "pine_received": 2,
      "conversions_ok": 1,
      "viable": 1,
      "best": {
        "name": "Candidate_LuxAlgo_1",
        "trades": 83,
        "sharpe": 0.12,
        "prompt_index": 1
      }
    },
    "scratch": {
      "searched": false,
      "reason": "sufficient candidates from earlier paths"
    }
  },
  "race_candidates": [
    {
      "name": "BBands_RSI_v2",
      "path": "library",
      "trades": 47,
      "sharpe": 0.31,
      "favorable_sharpe": 0.31,
      "strategy_path": "/workspace/group/user_data/strategies/BBands_RSI_v2.py",
      "action": "send_to_kata"
    },
    {
      "name": "Candidate_LuxAlgo_1",
      "path": "luxalgo",
      "trades": 83,
      "sharpe": 0.12,
      "favorable_sharpe": 0.12,
      "strategy_path": "/workspace/group/user_data/strategies/Candidate_LuxAlgo_1.py",
      "action": "send_to_kata"
    }
  ],
  "status": "candidates_found",
  "timestamp": "2026-04-04T14:30:00Z"
}
```

---

## Display Format

### Per-Path Results

```
STRATEGYZER RESULTS -- MEAN_REVERSION on XRP/USDT:USDT 15m
============================================================

PATH A: Strategy Library
  Qualifiers:      0
  Partial Edge:    1 (BBands_RSI_v2)
  Indicator Match: 2 (RSI_Channel_v1, Stoch_Keltner_v3)
  Best: BBands_RSI_v2 -- 47 trades, Sharpe 0.31

PATH B: LuxAlgo Quant
  Prompts sent:    2
  Pine received:   2
  Conversions OK:  1
  Best: Candidate_LuxAlgo_1 -- 83 trades, Sharpe 0.12

PATH C: Build from Scratch
  Skipped (sufficient candidates from earlier paths)
```

### Evaluation Table

```
EVALUATION TABLE
+-----+-----------------------+--------+--------+--------+--------+--------+
| #   | Candidate             | Path   | Trades | Sharpe | Profit | Action |
+-----+-----------------------+--------+--------+--------+--------+--------+
|  1  | Candidate_LuxAlgo_1   | luxalgo|     83 |   0.12 |  +4.2% | RACE   |
|  2  | BBands_RSI_v2         | library|     47 |   0.31 |  +2.8% | RACE   |
|  3  | RSI_Channel_v1        | library|     12 |  -0.05 | -0.3%  | DROP   |
|  4  | Stoch_Keltner_v3      | library|      0 |   0.00 |  0.0%  | DROP   |
|  5  | Candidate_LuxAlgo_2   | luxalgo|      0 |   0.00 |  0.0%  | FAIL   |
+-----+-----------------------+--------+--------+--------+--------+--------+
```

### Race Candidate List

```
RACE CANDIDATES (send to kata-bridge)
  1. BBands_RSI_v2         [library]  47 trades, fav_sharpe 0.31 -> KATA
  2. Candidate_LuxAlgo_1   [luxalgo]  83 trades, fav_sharpe 0.12 -> KATA

Next: "start race" to begin kata optimization
```

---

## Conversion Notes

Pine Script to pandas_ta mapping for manual conversions:

| Pine Script | pandas_ta |
|-------------|-----------|
| ta.ema | pta.ema |
| ta.atr | pta.atr |
| ta.rsi | pta.rsi |
| ta.bb | pta.bbands |
| ta.macd | pta.macd |
| ta.stoch | pta.stoch |
| ta.cci | pta.cci |
| ta.wpr | pta.willr |
| ta.supertrend | pta.supertrend |
| ta.highest | rolling.max |
| ta.lowest | rolling.min |
| ta.crossover | shift comparison |
| ta.crossunder | shift comparison |
| ta.dmi | pta.adx (returns DMP/DMN/ADX columns) |

### Conversion Rules

- Class MUST be named `KataStrategy`
- Use `pandas_ta` (imported as `pta`) for ALL indicators
- Set `startup_candle_count` >= longest indicator lookback + 10
- Handle None returns from pandas_ta with null checks
- Use `.fillna(0)` on boolean conditions to prevent NaN issues
- For bbands: use positional access (`bb.iloc[:, 0]`) not named columns
- Signal columns must be `.fillna(0).astype(int)`
- No Python loops in `populate_*` methods -- vectorized operations only
- No look-ahead bias: never `.shift()` with negative values
- NEVER import `stoploss` from `freqtrade.strategy`
- NEVER use `strategy.entry()` / `strategy.exit()` (Pine Script, not Python)
- NEVER use `ta.ema()` / `ta.rsi()` -- use `pta.ema()` / `pta.rsi()`

---
name: ps2python
description: >
  Pine Script to FreqTrade Python converter. Takes a Pine Script strategy, converts it to
  a FreqTrade IStrategy (KataStrategy class), runs backtests to validate, and iterates on
  errors up to 10 times. Uses pandas-ta indicators, vectorized pandas operations, and
  FreqTrade best practices. Trigger on: "ps2python", "convert pine", "pine to python",
  "convert strategy", "pine to freqtrade", "translate pine script".
---

# PS2Python — Pine Script to FreqTrade Converter

Converts Pine Script strategies to FreqTrade IStrategy Python classes with iterative
backtest validation.

## INPUT FORMAT

The user provides Pine Script source code, either:
- Pasted directly in the message
- As a file path: `cat /workspace/group/pine/<filename>.pine`
- As a TradingView strategy name (search for it)

## OUTPUT FORMAT

A complete Python file saved to:
```
/workspace/group/strategies/KataStrategy.py
```

The file must be a valid FreqTrade IStrategy that can be backtested immediately.

## STRATEGY CLASS TEMPLATE

Every converted strategy MUST follow this template:

```python
# --- Auto-converted from Pine Script by ps2python ---
# Original: <pine_script_name>
# Converted: <date>

import numpy as np
import pandas as pd
import pandas_ta as pta
from freqtrade.strategy import IStrategy, IntParameter, DecimalParameter
from functools import reduce

class KataStrategy(IStrategy):
    """
    <Brief description of the strategy logic>
    Converted from Pine Script: <original_name>
    """

    INTERFACE_VERSION = 3

    # Timeframe
    timeframe = '<timeframe>'

    # Risk management
    stoploss = -0.05          # MANDATORY: class-level stoploss
    minimal_roi = {"0": 100}  # Disable ROI exits by default, let strategy exits work
    can_short = True          # MANDATORY if Pine Script has short entries

    # Startup candle count: must be >= max(all lookback periods) + 10
    startup_candle_count = <calculated>

    def populate_indicators(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        # Compute all indicators here
        # ALWAYS check for None returns from pandas-ta
        # ALWAYS use .fillna(0) at the end
        dataframe.fillna(0, inplace=True)
        return dataframe

    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        # Long entries
        dataframe.loc[
            (
                <conditions>
            ),
            'enter_long'] = 1

        # Short entries (if applicable)
        dataframe.loc[
            (
                <conditions>
            ),
            'enter_short'] = 1

        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        # Long exits
        dataframe.loc[
            (
                <conditions>
            ),
            'exit_long'] = 1

        # Short exits (if applicable)
        dataframe.loc[
            (
                <conditions>
            ),
            'exit_short'] = 1

        return dataframe
```

## CONVERSION RULES

### Indicator Mapping: Pine Script to pandas-ta

| Pine Script | pandas-ta | Notes |
|-------------|-----------|-------|
| `ta.bb(src, len, mult)` | `pta.bbands(close, length=len, std=mult)` | Returns DF: use `.iloc[:, 0]` (upper), `.iloc[:, 1]` (mid), `.iloc[:, 2]` (lower) |
| `ta.rsi(src, len)` | `pta.rsi(close, length=len)` | Returns Series |
| `ta.atr(len)` | `pta.atr(high, low, close, length=len)` | Returns Series, needs H/L/C |
| `ta.ema(src, len)` | `pta.ema(close, length=len)` | Returns Series |
| `ta.sma(src, len)` | `pta.sma(close, length=len)` | Returns Series |
| `ta.macd(src, fast, slow, signal)` | `pta.macd(close, fast=f, slow=s, signal=sig)` | Returns DF with 3 columns |
| `ta.stoch(high, low, close, k, d)` | `pta.stoch(high, low, close, k=k, d=d)` | Returns DF |
| `ta.adx(dilen, adxlen)` | `pta.adx(high, low, close, length=adxlen)` | Returns DF |
| `ta.percentrank(src, len)` | `src.rolling(len).apply(lambda x: percentileofscore(x[:-1], x.iloc[-1]) if len(x)>1 else 50)` | Needs `from scipy.stats import percentileofscore` |
| `ta.crossover(a, b)` | `(a > b) & (a.shift(1) <= b.shift(1))` | Boolean Series |
| `ta.crossunder(a, b)` | `(a < b) & (a.shift(1) >= b.shift(1))` | Boolean Series |
| `ta.highest(src, len)` | `src.rolling(len).max()` | Rolling max |
| `ta.lowest(src, len)` | `src.rolling(len).min()` | Rolling min |
| `ta.change(src)` | `src.diff()` | First difference |
| `ta.barssince(cond)` | No direct equivalent. Use cumsum trick. | Complex — see below |
| `nz(val, replacement)` | `val.fillna(replacement)` | NaN handling |

### Structure Mapping: Pine Script to FreqTrade

| Pine Script | FreqTrade |
|-------------|-----------|
| `strategy.entry("Long", strategy.long)` | `dataframe.loc[cond, 'enter_long'] = 1` |
| `strategy.entry("Short", strategy.short)` | `dataframe.loc[cond, 'enter_short'] = 1` |
| `strategy.close("Long")` | `dataframe.loc[cond, 'exit_long'] = 1` |
| `strategy.close("Short")` | `dataframe.loc[cond, 'exit_short'] = 1` |
| `strategy.exit("name", stop=price)` | `custom_stoploss()` method |
| `input.int(default, "label")` | Class constant or `IntParameter` |
| `strategy.position_size > 0` | Cannot check in `populate_*`. Use exit signals only. |

### ATR-Based Dynamic Stoploss

Pine:
```
strategy.exit("Exit Long", "Long", stop=entry_price - atr * mult)
```

FreqTrade Option A -- Static approximation (simpler, usually good enough):
```python
stoploss = -0.05  # set based on typical ATR * mult / price
```

FreqTrade Option B -- Custom stoploss (exact match):
```python
stoploss = -0.99  # disabled, using custom
use_custom_stoploss = True

def custom_stoploss(self, pair, trade, current_time,
                     current_rate, current_profit, **kwargs):
    dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
    if len(dataframe) < 1:
        return -0.05
    last_candle = dataframe.iloc[-1]
    atr = last_candle.get('atr', 0)
    if atr == 0:
        return -0.05
    if trade.is_short:
        sl_price = trade.open_rate + (atr * 1.5)
        return (current_rate / sl_price) - 1
    else:
        sl_price = trade.open_rate - (atr * 1.5)
        return (sl_price / current_rate) - 1
```

### Bollinger Band Width Percentile (common in MR strategies)

Pine:
```
bbw = (upper - lower) / basis
bbwRank = ta.percentrank(bbw, lookback)
isCompressed = bbwRank <= threshold
```

FreqTrade:
```python
from scipy.stats import percentileofscore

bb = pta.bbands(dataframe['close'], length=20, std=2.0)
if bb is not None and len(bb.columns) >= 3:
    dataframe['bb_upper'] = bb.iloc[:, 0]
    dataframe['bb_mid'] = bb.iloc[:, 1]
    dataframe['bb_lower'] = bb.iloc[:, 2]
    dataframe['bbw'] = (dataframe['bb_upper'] - dataframe['bb_lower']) / dataframe['bb_mid']
    dataframe['bbw_rank'] = dataframe['bbw'].rolling(100).apply(
        lambda x: percentileofscore(x[:-1], x.iloc[-1]) if len(x) > 1 else 50,
        raw=False
    )
    dataframe['is_compressed'] = (dataframe['bbw_rank'] <= 25).astype(int)
```

## MANDATORY RULES

1. **Class name:** Always `KataStrategy`
2. **INTERFACE_VERSION = 3** required
3. **Required attributes:** `timeframe`, `stoploss`, `minimal_roi`, `startup_candle_count`
4. **startup_candle_count** >= longest indicator lookback + 10
5. **Use pandas-ta** (`import pandas_ta as pta`), NOT ta-lib
6. **No Python loops** in `populate_*` methods -- vectorized pandas/numpy only
7. **No look-ahead bias:** never use `.shift()` with negative values
8. **Signal columns:** `.fillna(0).astype(int)` on boolean conditions
9. **End of populate_indicators:** `dataframe.fillna(0, inplace=True)`
10. **Handle None returns** from pandas-ta before using results
11. **Set `can_short = True`** if short signals are used
12. **Never use deprecated attrs:** use `use_exit_signal` not `use_sell_signal`
13. **Stoploss as class attribute** (`stoploss = -0.05`) is mandatory
14. **No pair-specific or timeframe-specific hardcoded values**
15. **bbands column access:** use `.iloc[:, 0]`, `.iloc[:, 1]`, `.iloc[:, 2]` for upper/mid/lower (names vary by params)

## ITERATION LOOP

Convert -> backtest -> diagnose -> fix -> repeat (max 10 iterations).

### Step 1: Convert

1. Read the Pine Script source
2. Identify all indicators, entries, exits, and risk management
3. Map each Pine construct to its FreqTrade equivalent using the tables above
4. Generate the complete `KataStrategy` class
5. Run preflight checks (syntax, no Pine leaks, class name present)

### Step 2: Backtest

```bash
# Save the strategy
cat > /workspace/group/strategies/KataStrategy.py << 'PYEOF'
<generated code>
PYEOF

# Run backtest via freqtrade-mcp or CLI
freqtrade_run_backtest(
  strategy="KataStrategy",
  timeframe="<tf>",
  timerange="20250101-20260101"
)
```

### Step 3: Diagnose

Score the backtest output using the tier system:

| Score | Tier | Diagnosis |
|-------|------|-----------|
| 0.0 | **Tier 0: Fatal** | SyntaxError, ModuleNotFoundError, ImportError, NameError |
| 0.1 | **Tier 1: Indicator** | AttributeError, TypeError, KeyError (indicator returned None) |
| 0.15 | **Tier 1.5: Startup** | FreqTrade error during startup (EXIT_CODE=1) |
| 0.3 | **Tier 2: Zero trades** | Entry conditions never trigger |
| 0.5 | **Tier 3: Few trades** | Only 1-2 trades -- conditions too strict |
| 0.7 | **Tier 3.5: Low trades** | 3-9 trades -- check exits and stoploss |
| 0.8 | **Tier 4: Sharpe zero** | Trades present but Sharpe~0 -- all same result |
| 1.0 | **Success** | Clean run with trades and non-zero Sharpe |

### Step 4: Fix

Based on the tier, apply targeted fixes:

**Tier 0 fixes:**
- SyntaxError: check for Pine `:=` assignment syntax, missing colons, unclosed parens
- NameError `ta`: replace `ta.xxx()` with `pta.xxx()`
- ModuleNotFoundError: check imports, `scipy` is available

**Tier 1 fixes:**
- `AttributeError: 'NoneType'`: add null check before using pandas-ta result
- `KeyError 'BBU_20_2.0'`: use positional `.iloc[:, N]` instead of column name
- `TypeError: expected Series, got DataFrame`: extract with `.iloc[:, 0]`

**Tier 2 fixes (zero trades):**
1. Print indicator value ranges to check for NaN
2. Check if conditions are too strict (AND of 3+ conditions)
3. Verify boolean logic: `&` not `and`, `|` not `or`
4. Check `can_short = True` if shorts expected
5. Check `startup_candle_count` not consuming too many candles

**Tier 3 fixes (few trades):**
- Check if exits fire on same candle as entry (add `.shift(1)` to exit conditions)
- Check for missing short signals
- Verify `minimal_roi` is not overriding strategy exits

**Tier 4 fixes (Sharpe zero):**
- Set `minimal_roi = {"0": 100}` to disable ROI exits
- Check if all trades hit the same stoploss

### Step 5: Repeat

If score < 1.0 and iteration < 10, go back to Step 4 with the diagnosis.
If score = 1.0, the conversion is complete.
If 10 iterations reached, report the best score achieved and remaining issues.

## ERROR TIERS (Reference)

### Tier 0: Fatal errors (score 0.0)

- **"No module named 'scipy'"** -- scipy is included in the container. If missing: use `series.rank(pct=True) * 100` as alternative
- **"SyntaxError: invalid syntax"** -- Pine Script syntax left in the Python file. Check for `:=`, `if/else` without colon, unconverted `strategy.entry()` calls
- **"NameError: name 'ta' is not defined"** -- using Pine's `ta.xxx` instead of `pta.xxx`

### Tier 1: Indicator errors (score 0.1)

- **"AttributeError: 'NoneType' object has no attribute 'iloc'"** -- pandas-ta indicator returned None (not enough data or bad params). Add null check before use.
- **"KeyError: 'BBU_20_2.0'"** -- bbands columns by name; name format varies. Use positional access: `bb.iloc[:, 0]`
- **"TypeError: expected Series, got DataFrame"** -- pandas-ta returned DataFrame. Extract: `result.iloc[:, 0]`

### Tier 2: Zero trades (score 0.3)

- Entry conditions never trigger. Debug by printing indicator ranges.
- Missing `can_short = True` silently ignores all short entries.
- `startup_candle_count` too high -- consuming too many candles for warmup.

### Tier 3: Wrong trade count (score 0.5)

- Exits fire immediately after entry. Add `.shift(1)` to exit conditions.
- Only long trades when Pine has both. Check `can_short` and debug short conditions.

### Tier 4: Almost correct (score 0.7-0.8)

- ATR-based stops use entry price (not available in `populate_exit_trend`). Use `custom_stoploss()` instead.
- Sharpe is 0 despite trades. Check `minimal_roi` -- too tight overrides natural exits. Set `{"0": 100}`.

## COMMON GOTCHAS

1. bbands() column names include parameters: `BBU_20_2.0`, `BBM_20_2.0`, `BBL_20_2.0` -- safest to use `.iloc[:, 0/1/2]`
2. Always check for None return from pandas-ta indicators
3. `startup_candle_count` must be >= max(all lookback periods) + 10
4. FreqTrade `populate_*` methods operate on the FULL dataframe, not row-by-row
5. Cannot access `strategy.position_size` in `populate_entry/exit`
6. Use `.fillna(0)` or `.fillna(False)` on boolean conditions
7. `can_short = True` MUST be set for strategies with short entries
8. `percentileofscore(x[:-1], x.iloc[-1])` -- exclude current value from the sample

## DISPLAY FORMAT

After each iteration, report:

```
## PS2Python — Iteration N/10
**Source:** <pine_script_name>
**Score:** X.X / 1.0 (Tier N)
**Diagnosis:** <one-line diagnosis>

### Changes Made
- <bullet list of fixes applied>

### Backtest Result
- Trades: N | Sharpe: X.XX | Max DD: X.X%
- Status: <PASS / iterating / max iterations reached>
```

On completion (score 1.0):

```
## PS2Python — Conversion Complete
**Source:** <pine_script_name>
**Iterations:** N
**Final Score:** 1.0

### Backtest Summary
- Trades: N | Sharpe: X.XX | Sortino: X.XX | Max DD: X.X%
- Win rate: X.X% | Avg profit: X.X%

### Output
- Strategy: `/workspace/group/strategies/KataStrategy.py`
- Ready for triage or deployment
```

"""Indicator registry mapping genome signal names to TA-Lib code generation."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class IndicatorDef:
    """Definition of a technical indicator for code generation."""

    talib_func: str | None
    default_params: dict[str, int | float] = field(default_factory=dict)
    column: str = ""
    multi_output: list[str] = field(default_factory=list)
    ohlcv_input: str = "close"

    @property
    def is_multi_output(self) -> bool:
        return len(self.multi_output) > 0

    def resolve_column(self, params: dict[str, Any]) -> str:
        """Resolve column name with parameter substitution."""
        if self.is_multi_output:
            return self.multi_output[0]
        col = self.column
        for key, val in params.items():
            col = col.replace(f"{{{key}}}", str(val))
        return col

    def generate_code(self, params: dict[str, Any]) -> list[str]:
        """Generate Python code lines for populate_indicators()."""
        if self.talib_func is None:
            return []

        merged = {**self.default_params, **params}
        param_str = ", ".join(f"{k}={v}" for k, v in merged.items())

        if self.is_multi_output:
            outputs = ", ".join(f"dataframe['{c}']" for c in self.multi_output)
            if param_str:
                return [f"    {outputs} = ta.{self.talib_func}(dataframe, {param_str})"]
            return [f"    {outputs} = ta.{self.talib_func}(dataframe)"]

        col = self.resolve_column(merged)
        if param_str:
            return [f"    dataframe['{col}'] = ta.{self.talib_func}(dataframe, {param_str})"]
        return [f"    dataframe['{col}'] = ta.{self.talib_func}(dataframe)"]


INDICATOR_REGISTRY: dict[str, IndicatorDef] = {
    "rsi": IndicatorDef(
        talib_func="RSI", default_params={"timeperiod": 14}, column="rsi_{timeperiod}"
    ),
    "ema": IndicatorDef(
        talib_func="EMA", default_params={"timeperiod": 21}, column="ema_{timeperiod}"
    ),
    "sma": IndicatorDef(
        talib_func="SMA", default_params={"timeperiod": 20}, column="sma_{timeperiod}"
    ),
    "macd": IndicatorDef(
        talib_func="MACD",
        default_params={"fastperiod": 12, "slowperiod": 26, "signalperiod": 9},
        multi_output=["macd", "macdsignal", "macdhist"],
    ),
    "bbands": IndicatorDef(
        talib_func="BBANDS",
        default_params={"timeperiod": 20},
        multi_output=["bb_upper", "bb_middle", "bb_lower"],
    ),
    "atr": IndicatorDef(
        talib_func="ATR", default_params={"timeperiod": 14}, column="atr"
    ),
    "adx": IndicatorDef(
        talib_func="ADX", default_params={"timeperiod": 14}, column="adx"
    ),
    "stochrsi": IndicatorDef(
        talib_func="STOCHRSI",
        default_params={"timeperiod": 14},
        multi_output=["stochrsi_k", "stochrsi_d"],
    ),
    "cci": IndicatorDef(
        talib_func="CCI", default_params={"timeperiod": 14}, column="cci"
    ),
    "mfi": IndicatorDef(
        talib_func="MFI", default_params={"timeperiod": 14}, column="mfi"
    ),
    "obv": IndicatorDef(talib_func="OBV", default_params={}, column="obv"),
    "sar": IndicatorDef(talib_func="SAR", default_params={}, column="sar"),
    "volume": IndicatorDef(talib_func=None, column="volume"),
}


def parse_indicator_name(name: str) -> tuple[str, dict[str, Any]]:
    """Parse indicator name like 'rsi_14' or 'ema_50' into (base_name, params).

    Supports formats:
    - 'rsi' -> ('rsi', {})
    - 'rsi_14' -> ('rsi', {'timeperiod': 14})
    - 'ema_50' -> ('ema', {'timeperiod': 50})
    """
    match = re.match(r"^([a-z]+)(?:_(\d+))?$", name)
    if not match:
        return name, {}

    base = match.group(1)
    if match.group(2) is not None:
        return base, {"timeperiod": int(match.group(2))}
    return base, {}


def get_indicator(name: str) -> tuple[IndicatorDef, dict[str, Any]]:
    """Look up an indicator by signal name. Returns (def, resolved_params).

    Raises ValueError if indicator not found.
    """
    base, parsed_params = parse_indicator_name(name)
    if base not in INDICATOR_REGISTRY:
        raise ValueError(f"Unknown indicator: '{name}' (base: '{base}')")
    return INDICATOR_REGISTRY[base], parsed_params


def normalize_params(params: dict[str, Any]) -> dict[str, Any]:
    """Map FreqHub param names to TA-Lib param names."""
    result = dict(params)
    if "period" in result and "timeperiod" not in result:
        result["timeperiod"] = result.pop("period")
    if "fast" in result and "fastperiod" not in result:
        result["fastperiod"] = result.pop("fast")
    if "slow" in result and "slowperiod" not in result:
        result["slowperiod"] = result.pop("slow")
    if "signal" in result and "signalperiod" not in result:
        result["signalperiod"] = result.pop("signal")
    if "std" in result and "nbdevup" not in result:
        result["nbdevup"] = result.pop("std")
        result["nbdevdn"] = result.get("nbdevdn", result["nbdevup"])
    return result


def resolve_column_name(indicator_name: str, extra_params: dict[str, Any] | None = None) -> str:
    """Resolve the DataFrame column name for a given indicator signal name."""
    defn, parsed_params = get_indicator(indicator_name)
    normalized = normalize_params(extra_params or {})
    merged = {**defn.default_params, **parsed_params, **normalized}
    return defn.resolve_column(merged)

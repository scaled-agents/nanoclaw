"""Parse FreqTrade backtest result bundles into StrategyDNA verification models."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from strategydna.verification import (
    BacktestMetrics,
    DatasetManifest,
    EnvironmentFingerprint,
)


def ingest_backtest_bundle(
    result_path: str | Path,
) -> tuple[BacktestMetrics, DatasetManifest, EnvironmentFingerprint]:
    """Parse a FreqTrade backtest result file and extract all verification data.

    Args:
        result_path: Path to backtest-result-*.json file

    Returns:
        (BacktestMetrics, DatasetManifest, EnvironmentFingerprint) tuple
    """
    path = Path(result_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    metrics, dataset = parse_freqtrade_result(data)
    environment = extract_environment(data)
    return metrics, dataset, environment


def parse_freqtrade_result(
    data: dict[str, Any],
) -> tuple[BacktestMetrics, DatasetManifest]:
    """Parse a FreqTrade backtest-result dict into metrics + dataset.

    Handles both nested strategy format and flat format.

    Raises:
        ValueError: If the result format is not recognized
    """
    result = _extract_strategy_result(data)
    metrics = _parse_metrics(result)
    dataset = _parse_dataset(result)
    return metrics, dataset


def parse_freqtrade_result_file(
    path: str | Path,
) -> tuple[BacktestMetrics, DatasetManifest]:
    """Read and parse a FreqTrade backtest-result JSON file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return parse_freqtrade_result(data)


def extract_environment(data: dict[str, Any]) -> EnvironmentFingerprint:
    """Extract environment fingerprint from a FreqTrade backtest result."""
    _extract_strategy_result(data)  # validate format
    metadata = data.get("metadata", {})

    # Try to find version info from metadata or result
    freqtrade_version = None
    for _key, meta_val in metadata.items():
        if isinstance(meta_val, dict):
            freqtrade_version = meta_val.get("freqtrade_version")
            if freqtrade_version:
                break

    return EnvironmentFingerprint(
        freqtrade_version=freqtrade_version,
    )


def _extract_strategy_result(data: dict[str, Any]) -> dict[str, Any]:
    """Navigate FreqTrade result JSON to find the strategy result dict.

    FreqTrade results are structured as:
    {"strategy": {"StrategyName": {...}}} or flat dict with "total_trades" etc.
    """
    # Nested format: {"strategy": {"Name": {...}}}
    if "strategy" in data and isinstance(data["strategy"], dict):
        strategies = data["strategy"]
        if strategies:
            first_key = next(iter(strategies))
            result = strategies[first_key]
            if isinstance(result, dict) and "total_trades" in result:
                return result

    # Flat format: result fields at top level
    if "total_trades" in data:
        return data

    raise ValueError(
        "Unrecognized FreqTrade result format: expected 'strategy.StrategyName' "
        "or flat dict with 'total_trades'"
    )


def _parse_metrics(result: dict[str, Any]) -> BacktestMetrics:
    """Extract BacktestMetrics from a strategy result dict."""
    total_trades = result.get("total_trades", 0)
    wins = result.get("wins", 0)
    win_rate = wins / total_trades if total_trades > 0 else 0.0

    return BacktestMetrics(
        total_trades=total_trades,
        win_rate=round(win_rate, 4),
        profit_total=result.get("profit_total", 0.0),
        profit_factor=result.get("profit_factor"),
        sharpe_ratio=result.get("sharpe"),
        sortino_ratio=result.get("sortino"),
        calmar_ratio=result.get("calmar"),
        max_drawdown=result.get("max_drawdown", 0.0),
        avg_trade_duration=result.get("holding_avg"),
        trades_per_day=result.get("trades_per_day"),
        expectancy=result.get("expectancy"),
    )


def _parse_dataset(result: dict[str, Any]) -> DatasetManifest:
    """Extract DatasetManifest from a strategy result dict."""
    pairs = result.get("pairlist", [])
    timeframe = result.get("timeframe", "1h")

    start = result.get("backtest_start", "")
    end = result.get("backtest_end", "")
    # Normalize datetime strings to date-only if they end with time
    if " " in start:
        start = start.split(" ")[0]
    if " " in end:
        end = end.split(" ")[0]

    return DatasetManifest(
        pairs=pairs,
        timeframe=timeframe,
        start_date=start,
        end_date=end,
        candle_count=result.get("backtest_days"),
    )

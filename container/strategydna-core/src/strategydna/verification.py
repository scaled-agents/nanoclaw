"""Pydantic v2 models for deterministic verification, attestation, and walk-forward records."""

from __future__ import annotations

import enum
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

# --- Enumerations ---


class AttestationVerdict(str, enum.Enum):
    """Outcome of a verification run."""

    QUALIFIED = "qualified"
    ELIMINATED = "eliminated"
    NEEDS_REVIEW = "needs_review"


class WindowType(str, enum.Enum):
    """Walk-forward window types (aligned with TradeV)."""

    ROLLING = "rolling"
    ANCHORED = "anchored"
    EXPANDING = "expanding"


class LossFunction(str, enum.Enum):
    """Optimization loss functions."""

    SHARPE = "sharpe"
    SORTINO = "sortino"
    CALMAR = "calmar"
    MAX_DRAWDOWN = "max_drawdown"
    PROFIT = "profit"


class FoldJobType(str, enum.Enum):
    """Type of fold job within a walk-forward run."""

    FOLD = "fold"
    HOLDOUT = "holdout"
    SMOKE_CHECK = "smoke_check"


# --- Dataset Manifest ---


class DatasetManifest(BaseModel):
    """Describes the exact dataset used for a backtest or verification run."""

    pairs: list[str] = Field(..., description="Trading pairs")
    timeframe: str = Field(..., description="Candle timeframe, e.g. '1h'")
    exchange: str = Field(default="binance")
    start_date: str = Field(..., description="ISO date string")
    end_date: str = Field(..., description="ISO date string")
    candle_count: int | None = Field(default=None)
    data_hash: str | None = Field(default=None, description="SHA-256 of raw OHLCV data")
    source: str = Field(default="freqtrade")


# --- Environment Fingerprint ---


class EnvironmentFingerprint(BaseModel):
    """Captures the execution environment for reproducibility verification."""

    freqtrade_version: str | None = Field(default=None)
    python_version: str | None = Field(default=None)
    os_platform: str | None = Field(default=None)
    talib_version: str | None = Field(default=None)
    sdna_version: str | None = Field(default=None)
    extra: dict[str, str] = Field(default_factory=dict)


# --- Backtest Metrics ---


class BacktestMetrics(BaseModel):
    """Core performance metrics extracted from a backtest result."""

    total_trades: int = Field(...)
    win_rate: float = Field(..., description="Win rate as fraction (0.0 - 1.0)")
    profit_total: float = Field(..., description="Total profit as fraction")
    profit_factor: float | None = Field(default=None)
    sharpe_ratio: float | None = Field(default=None)
    sortino_ratio: float | None = Field(default=None)
    calmar_ratio: float | None = Field(default=None)
    max_drawdown: float = Field(..., description="Maximum drawdown as fraction (positive)")
    avg_trade_duration: str | None = Field(default=None)
    trades_per_day: float | None = Field(default=None)
    expectancy: float | None = Field(default=None)
    extra: dict[str, Any] = Field(default_factory=dict)


# --- Fold Result (Walk-Forward) ---


class FoldResult(BaseModel):
    """Result of a single fold within a walk-forward verification run."""

    fold_number: int = Field(..., description="0 = holdout, 1-N = folds")
    job_type: FoldJobType = Field(default=FoldJobType.FOLD)
    dataset: DatasetManifest
    in_sample_metrics: BacktestMetrics | None = Field(default=None)
    out_of_sample_metrics: BacktestMetrics | None = Field(default=None)
    parameters: dict[str, Any] = Field(default_factory=dict)


# --- Walk-Forward Configuration ---


class WalkForwardConfig(BaseModel):
    """Configuration for a walk-forward verification run."""

    window_type: WindowType = Field(default=WindowType.ROLLING)
    in_sample_days: int = Field(...)
    out_of_sample_days: int = Field(...)
    step_days: int | None = Field(default=None)
    n_folds: int = Field(...)
    loss_function: LossFunction = Field(default=LossFunction.SHARPE)
    epochs_per_fold: int | None = Field(default=None)


# --- Walk-Forward Record ---


class WalkForwardRecord(BaseModel):
    """Complete walk-forward verification record with all fold results."""

    config: WalkForwardConfig
    folds: list[FoldResult] = Field(default_factory=list)
    aggregate_metrics: BacktestMetrics | None = Field(default=None)
    consistency_score: float | None = Field(default=None)
    robustness_index: float | None = Field(default=None)


# --- Attestation ---


class Attestation(BaseModel):
    """Cryptographic attestation linking a genome to its verification results."""

    format_version: Literal["0.1"] = Field(default="0.1")
    hash: str | None = Field(default=None, description="SHA-256 content hash")

    # What was tested
    genome_hash: str = Field(...)
    genome_name: str = Field(default="")

    # How it was tested
    dataset: DatasetManifest
    environment: EnvironmentFingerprint = Field(default_factory=EnvironmentFingerprint)

    # Results
    metrics: BacktestMetrics | None = Field(default=None)
    walk_forward: WalkForwardRecord | None = Field(default=None)

    # Verdict
    verdict: AttestationVerdict | None = Field(default=None)
    verdict_reason: str = Field(default="")

    # Provenance
    attested_by: str = Field(default="")
    attested_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    parent_attestation_hash: str | None = Field(default=None)

    annotations: dict[str, Any] = Field(default_factory=dict)

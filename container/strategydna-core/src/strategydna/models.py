"""Pydantic v2 data models for the .sdna genome format (FreqHub-compatible).

Format: YAML frontmatter (metadata, hash, lineage) + JSON body (strategy signals, risk, market).
Hash computed from JSON body only.
"""

from __future__ import annotations

import enum
import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

# --- Retained enums (for backwards compat / reference) ---


class StrategyArchetype(str, enum.Enum):
    """Strategy classification archetypes (optional, for tagging)."""

    TREND_FOLLOWING = "trend-following"
    MEAN_REVERSION = "mean-reversion"
    BREAKOUT = "breakout"
    MOMENTUM = "momentum"
    SCALPING = "scalping"
    RANGE = "range"


class MarketRegime(str, enum.Enum):
    """Market regime classifications."""

    CHAOS = "CHAOS"
    EFFICIENT_TREND = "EFFICIENT_TREND"
    COMPRESSION = "COMPRESSION"
    TRANQUIL = "TRANQUIL"


# --- Signal type hierarchy (discriminated union) ---


_SAFE_IDENTIFIER = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_SAFE_CONDITIONS = {
    "crosses_below", "crosses_above", "below", "above",
    "<", ">", "<=", ">=", "==",
}


class ThresholdCrossSignal(BaseModel):
    """Indicator crosses or compares against a fixed value."""

    type: Literal["threshold_cross"] = "threshold_cross"
    indicator: str = Field(..., description="Indicator name, e.g. 'rsi'")
    params: dict[str, Any] = Field(default_factory=dict, description="Indicator parameters")
    condition: str = Field(..., description="Comparison operator or crossing type")
    value: int | float = Field(..., description="Threshold value")

    @field_validator("indicator")
    @classmethod
    def validate_indicator(cls, v: str) -> str:
        if not _SAFE_IDENTIFIER.match(v):
            raise ValueError(f"Indicator name must be alphanumeric/underscore, got: {v!r}")
        return v

    @field_validator("condition")
    @classmethod
    def validate_condition(cls, v: str) -> str:
        if v not in _SAFE_CONDITIONS:
            raise ValueError(f"Invalid condition: {v!r}")
        return v


class IndicatorCrossSignal(BaseModel):
    """Two indicators cross each other."""

    type: Literal["indicator_cross"] = "indicator_cross"
    fast: dict[str, Any] = Field(..., description="Fast indicator: {indicator, params}")
    slow: dict[str, Any] = Field(..., description="Slow indicator: {indicator, params}")
    condition: str = Field(..., description="crosses_above or crosses_below")


class CompositeAndSignal(BaseModel):
    """All conditions must be true."""

    type: Literal["composite_and"] = "composite_and"
    conditions: list[Signal] = Field(default_factory=list)


class CompositeOrSignal(BaseModel):
    """Any condition must be true."""

    type: Literal["composite_or"] = "composite_or"
    conditions: list[Signal] = Field(default_factory=list)


class PatternSignal(BaseModel):
    """Candlestick or chart pattern."""

    type: Literal["pattern"] = "pattern"
    pattern: str = Field(..., description="Pattern name")

    @field_validator("pattern")
    @classmethod
    def validate_pattern(cls, v: str) -> str:
        if not _SAFE_IDENTIFIER.match(v):
            raise ValueError(f"Pattern name must be alphanumeric/underscore, got: {v!r}")
        return v


class CustomSignal(BaseModel):
    """Raw expression for custom logic."""

    type: Literal["custom"] = "custom"
    expression: str = Field(..., description="Raw Python/pandas expression")


# Discriminated union of all signal types
Signal = Annotated[
    ThresholdCrossSignal | IndicatorCrossSignal
    | CompositeAndSignal | CompositeOrSignal
    | PatternSignal | CustomSignal,
    Field(discriminator="type"),
]


# --- Signal set (four entry/exit slots) ---


class SignalSet(BaseModel):
    """Strategy signals organized by direction/action."""

    entry_long: Signal | None = None
    exit_long: Signal | None = None
    entry_short: Signal | None = None
    exit_short: Signal | None = None


# --- Regime filter ---


class RegimeFilter(BaseModel):
    """Market regime filter defining when the strategy should be active."""

    enabled: bool = False
    detector: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    allowed_regimes: list[str] = Field(default_factory=list)


# --- Risk model (method-based) ---


class PositionSize(BaseModel):
    """Position sizing method."""

    method: str = "fixed_stake"
    amount_usdt: float | None = None
    params: dict[str, Any] = Field(default_factory=dict)


class StopLoss(BaseModel):
    """Stop loss method."""

    method: str = "fixed_pct"
    params: dict[str, Any] = Field(default_factory=dict)


class TakeProfit(BaseModel):
    """Take profit method."""

    method: str = "fixed_pct"
    params: dict[str, Any] = Field(default_factory=dict)


class RiskModel(BaseModel):
    """Risk management parameters."""

    position_size: PositionSize = Field(default_factory=PositionSize)
    stop_loss: StopLoss = Field(default_factory=StopLoss)
    take_profit: TakeProfit = Field(default_factory=TakeProfit)
    max_drawdown: float = 0.20
    max_open_trades: int = 3


# --- Exchange ---


class Exchange(BaseModel):
    """Exchange and trading mode configuration."""

    name: str = "binance"
    trading_mode: Literal["spot", "futures"] = "spot"
    margin_mode: str | None = None


# --- Attestation status ---


class AttestationStatus(BaseModel):
    """Attestation metadata stored in frontmatter."""

    status: str = "unattested"
    walk_forward_sharpe: float | None = None
    win_rate: float | None = None
    max_drawdown: float | None = None
    profit_factor: float | None = None
    total_trades: int | None = None
    attested_at: str | None = None


# --- Frontmatter (YAML section — not hashed) ---


class Frontmatter(BaseModel):
    """YAML frontmatter: metadata, identity, lineage, attestation."""

    name: str = ""
    description: str = ""
    author: str = ""
    operator: str = ""
    created: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    tags: list[str] = Field(default_factory=list)
    parent: str | None = None
    hash: str | None = None
    attestation: AttestationStatus = Field(default_factory=AttestationStatus)
    runtime: str = "freqtrade"
    freqtrade_version: str = ">=2024.1"
    sdna_version: str = "0.1"


# --- Genome body (JSON section — this is what gets hashed) ---


class GenomeBody(BaseModel):
    """JSON body: the hashable strategy declaration."""

    signals: SignalSet = Field(default_factory=SignalSet)
    regime_filter: RegimeFilter = Field(default_factory=RegimeFilter)
    risk: RiskModel = Field(default_factory=RiskModel)
    pairs: list[str] = Field(default_factory=list)
    timeframe: str = "4h"
    informative_timeframes: list[str] = Field(default_factory=list)
    exchange: Exchange = Field(default_factory=Exchange)


# --- Root document ---


class GenomeDocument(BaseModel):
    """
    Root .sdna genome document.

    Composed of YAML frontmatter (metadata, hash, lineage) + JSON body (strategy).
    Hash is computed from JSON body only.
    """

    frontmatter: Frontmatter = Field(default_factory=Frontmatter)
    body: GenomeBody = Field(default_factory=GenomeBody)


# Rebuild models to resolve forward references for recursive Signal type
CompositeAndSignal.model_rebuild()
CompositeOrSignal.model_rebuild()
SignalSet.model_rebuild()
GenomeBody.model_rebuild()
GenomeDocument.model_rebuild()

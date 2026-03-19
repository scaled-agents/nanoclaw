"""Pure scoring functions for registry entries.

Computes multi-component scores from attestation data, aligned with
TradeV strategy_scores tier system.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from pydantic import BaseModel, Field

from strategydna.verification import (
    Attestation,
    AttestationVerdict,
    BacktestMetrics,
    WalkForwardRecord,
)

# --- Tier Enum ---


class RegistryTier(str, enum.Enum):
    """Strategy quality tier, aligned with TradeV strategy_scores.tier."""

    POOR = "poor"
    FAIR = "fair"
    GOOD = "good"
    EXCELLENT = "excellent"


# --- Score Model ---


class RegistryScore(BaseModel):
    """Composite score for a registry entry."""

    composite_score: float = Field(default=0.0, description="Overall score 0-100")
    backtest_score: float = Field(default=0.0, description="Backtest component 0-100")
    robustness_score: float = Field(
        default=0.0, description="Walk-forward robustness 0-100"
    )
    adoption_score: float = Field(
        default=0.0, description="Adoption/attestation count 0-100"
    )
    tier: RegistryTier = Field(default=RegistryTier.POOR)
    scored_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


# --- Scoring Functions ---


def compute_backtest_score(metrics: BacktestMetrics | None) -> float:
    """Compute backtest component score 0-100 from BacktestMetrics.

    Components (each normalized 0-100, then weighted):
    - sharpe_ratio: 30% — min(1, max(0, sharpe / 3)) * 100
    - profit_total: 30% — min(1, max(0, (profit + 0.1) / 0.5)) * 100
    - win_rate: 25% — win_rate * 100
    - max_drawdown: 15% — (1 - min(1, drawdown / 0.3)) * 100
    """
    if metrics is None:
        return 0.0

    sharpe = metrics.sharpe_ratio or 0.0
    sharpe_norm = min(1.0, max(0.0, sharpe / 3.0)) * 100

    profit = metrics.profit_total
    profit_norm = min(1.0, max(0.0, (profit + 0.1) / 0.5)) * 100

    win_rate_norm = min(1.0, max(0.0, metrics.win_rate)) * 100

    drawdown = abs(metrics.max_drawdown)
    drawdown_norm = (1.0 - min(1.0, drawdown / 0.3)) * 100

    score = (
        sharpe_norm * 0.30
        + profit_norm * 0.30
        + win_rate_norm * 0.25
        + drawdown_norm * 0.15
    )
    return round(score, 1)


def compute_robustness_score(
    walk_forward: WalkForwardRecord | None,
    verdict: AttestationVerdict | None = None,
) -> float:
    """Compute robustness component score 0-100 from WalkForwardRecord.

    Components:
    - consistency_score: 50% — direct percentage (0-1 -> 0-100)
    - robustness_index: 30% — min(1, max(0, ri / 1.5)) * 100
    - verdict bonus: 20% — QUALIFIED=100, NEEDS_REVIEW=50, ELIMINATED=0, None=25
    """
    if walk_forward is None:
        return 0.0

    consistency = (walk_forward.consistency_score or 0.0) * 100

    ri = walk_forward.robustness_index
    robustness = min(1.0, max(0.0, (ri or 0.0) / 1.5)) * 100

    verdict_map = {
        AttestationVerdict.QUALIFIED: 100.0,
        AttestationVerdict.NEEDS_REVIEW: 50.0,
        AttestationVerdict.ELIMINATED: 0.0,
    }
    verdict_bonus = verdict_map.get(verdict, 25.0) if verdict is not None else 25.0

    score = consistency * 0.50 + robustness * 0.30 + verdict_bonus * 0.20
    return round(score, 1)


def compute_adoption_score(
    attestation_count: int,
    unique_operators: set[str],
) -> float:
    """Compute adoption component score 0-100.

    Components:
    - attestation_count: 60% — min(1, count / 10) * 100
    - unique_operators: 40% — min(1, len(operators) / 4) * 100
    """
    count_norm = min(1.0, attestation_count / 10.0) * 100
    ops_norm = min(1.0, len(unique_operators) / 4.0) * 100

    score = count_norm * 0.60 + ops_norm * 0.40
    return round(score, 1)


def compute_composite_score(
    backtest_score: float,
    robustness_score: float,
    adoption_score: float,
) -> float:
    """Compute composite score: 40% backtest + 40% robustness + 20% adoption."""
    return round(
        backtest_score * 0.4 + robustness_score * 0.4 + adoption_score * 0.2, 1
    )


def derive_tier(composite_score: float) -> RegistryTier:
    """Map composite score to tier.

    poor: <30, fair: 30-<50, good: 50-<75, excellent: >=75
    """
    if composite_score >= 75:
        return RegistryTier.EXCELLENT
    if composite_score >= 50:
        return RegistryTier.GOOD
    if composite_score >= 30:
        return RegistryTier.FAIR
    return RegistryTier.POOR


def score_entry(attestations: list[Attestation]) -> RegistryScore:
    """Compute full RegistryScore from a list of attestations.

    Uses best metrics (highest sharpe) for backtest score, best walk-forward
    (highest consistency) for robustness, and counts unique operators for adoption.
    """
    if not attestations:
        return RegistryScore()

    # Single pass: find best metrics, best walk-forward, and collect operators
    best_metrics: BacktestMetrics | None = None
    best_sharpe = -float("inf")
    best_wf: WalkForwardRecord | None = None
    best_verdict: AttestationVerdict | None = None
    best_consistency = -1.0
    operators: set[str] = set()

    for att in attestations:
        # Best backtest metrics (highest sharpe)
        m = att.metrics
        if m is not None:
            s = m.sharpe_ratio or 0.0
            if s > best_sharpe:
                best_sharpe = s
                best_metrics = m

        # Also consider aggregate metrics from walk-forward
        if att.walk_forward and att.walk_forward.aggregate_metrics:
            agg = att.walk_forward.aggregate_metrics
            s = agg.sharpe_ratio or 0.0
            if s > best_sharpe:
                best_sharpe = s
                best_metrics = agg

        # Best walk-forward (highest consistency)
        if att.walk_forward is not None:
            c = att.walk_forward.consistency_score or 0.0
            if c > best_consistency:
                best_consistency = c
                best_wf = att.walk_forward
                best_verdict = att.verdict

        # Collect unique operators
        if att.attested_by:
            operators.add(att.attested_by)

    bt_score = compute_backtest_score(best_metrics)
    rb_score = compute_robustness_score(best_wf, best_verdict)
    ad_score = compute_adoption_score(len(attestations), operators)
    composite = compute_composite_score(bt_score, rb_score, ad_score)
    tier = derive_tier(composite)

    return RegistryScore(
        composite_score=composite,
        backtest_score=bt_score,
        robustness_score=rb_score,
        adoption_score=ad_score,
        tier=tier,
    )

"""Attestation lifecycle: create, stamp, verify, chain validation, walk-forward collation."""

from __future__ import annotations

import hashlib
import hmac

from strategydna.canon import canonical_json
from strategydna.models import GenomeDocument
from strategydna.verification import (
    Attestation,
    AttestationVerdict,
    BacktestMetrics,
    DatasetManifest,
    EnvironmentFingerprint,
    FoldResult,
    WalkForwardConfig,
    WalkForwardRecord,
)


def compute_attestation_hash(attestation: Attestation) -> str:
    """Compute SHA-256 content hash for an Attestation (excluding top-level 'hash')."""
    data = attestation.model_dump(mode="json")
    hashable = {k: v for k, v in data.items() if k != "hash"}
    canonical = canonical_json(hashable)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def stamp_attestation(attestation: Attestation) -> Attestation:
    """Compute and set the content hash, returning a new copy."""
    h = compute_attestation_hash(attestation)
    return attestation.model_copy(update={"hash": h})


def verify_attestation(attestation: Attestation) -> bool:
    """Verify that an attestation's hash matches its content (constant-time)."""
    if attestation.hash is None:
        return False
    return hmac.compare_digest(compute_attestation_hash(attestation), attestation.hash)


def create_attestation(
    genome: GenomeDocument,
    metrics: BacktestMetrics,
    dataset: DatasetManifest,
    environment: EnvironmentFingerprint | None = None,
    verdict: AttestationVerdict | None = None,
    verdict_reason: str = "",
    attested_by: str = "",
    parent_attestation_hash: str | None = None,
) -> Attestation:
    """Create a stamped attestation linking a genome to single-run backtest results.

    Raises:
        ValueError: If genome is not stamped (has no hash)
    """
    if genome.frontmatter.hash is None:
        raise ValueError("Genome must be stamped before creating an attestation")

    att = Attestation(
        genome_hash=genome.frontmatter.hash,
        genome_name=genome.frontmatter.name,
        dataset=dataset,
        environment=environment or EnvironmentFingerprint(),
        metrics=metrics,
        verdict=verdict,
        verdict_reason=verdict_reason,
        attested_by=attested_by,
        parent_attestation_hash=parent_attestation_hash,
    )
    return stamp_attestation(att)


def create_walkforward_attestation(
    genome: GenomeDocument,
    config: WalkForwardConfig,
    folds: list[FoldResult],
    environment: EnvironmentFingerprint | None = None,
    verdict: AttestationVerdict | None = None,
    verdict_reason: str = "",
    attested_by: str = "",
    parent_attestation_hash: str | None = None,
) -> Attestation:
    """Create an attestation for a walk-forward verification run.

    Auto-computes aggregate metrics, consistency score, robustness index,
    and overall dataset from fold data. Derives verdict if not provided.

    Raises:
        ValueError: If genome is not stamped
    """
    if genome.frontmatter.hash is None:
        raise ValueError("Genome must be stamped before creating an attestation")

    agg_metrics = aggregate_oos_metrics(folds)
    consistency = compute_consistency_score(folds)
    robustness = compute_robustness_index(folds)

    wf_record = WalkForwardRecord(
        config=config,
        folds=folds,
        aggregate_metrics=agg_metrics,
        consistency_score=consistency,
        robustness_index=robustness,
    )

    if verdict is None and folds:
        verdict, verdict_reason = derive_verdict(wf_record)

    # Build overall dataset from fold datasets
    overall_dataset = _merge_fold_datasets(folds)

    att = Attestation(
        genome_hash=genome.frontmatter.hash,
        genome_name=genome.frontmatter.name,
        dataset=overall_dataset,
        environment=environment or EnvironmentFingerprint(),
        walk_forward=wf_record,
        verdict=verdict,
        verdict_reason=verdict_reason,
        attested_by=attested_by,
        parent_attestation_hash=parent_attestation_hash,
    )
    return stamp_attestation(att)


def compute_consistency_score(folds: list[FoldResult]) -> float:
    """Fraction of folds where OOS profit > 0. Returns 0.0 if no OOS metrics."""
    oos_folds = [f for f in folds if f.out_of_sample_metrics is not None]
    if not oos_folds:
        return 0.0
    profitable = sum(
        1 for f in oos_folds
        if f.out_of_sample_metrics is not None and f.out_of_sample_metrics.profit_total > 0
    )
    return round(profitable / len(oos_folds), 4)


def compute_robustness_index(folds: list[FoldResult]) -> float | None:
    """Average of (OOS_sharpe / IS_sharpe) across folds. None if insufficient data."""
    ratios: list[float] = []
    for fold in folds:
        is_m = fold.in_sample_metrics
        oos_m = fold.out_of_sample_metrics
        if (
            is_m is not None
            and oos_m is not None
            and is_m.sharpe_ratio is not None
            and oos_m.sharpe_ratio is not None
            and is_m.sharpe_ratio != 0
        ):
            ratios.append(oos_m.sharpe_ratio / is_m.sharpe_ratio)
    if not ratios:
        return None
    return round(sum(ratios) / len(ratios), 4)


def aggregate_oos_metrics(folds: list[FoldResult]) -> BacktestMetrics | None:
    """Aggregate out-of-sample metrics across all folds."""
    oos = [f.out_of_sample_metrics for f in folds if f.out_of_sample_metrics is not None]
    if not oos:
        return None

    n = len(oos)
    return BacktestMetrics(
        total_trades=sum(m.total_trades for m in oos),
        win_rate=round(sum(m.win_rate for m in oos) / n, 4),
        profit_total=round(sum(m.profit_total for m in oos), 6),
        profit_factor=_avg_optional([m.profit_factor for m in oos]),
        sharpe_ratio=_avg_optional([m.sharpe_ratio for m in oos]),
        sortino_ratio=_avg_optional([m.sortino_ratio for m in oos]),
        calmar_ratio=_avg_optional([m.calmar_ratio for m in oos]),
        max_drawdown=round(max(m.max_drawdown for m in oos), 6),
        trades_per_day=_avg_optional([m.trades_per_day for m in oos]),
        expectancy=_avg_optional([m.expectancy for m in oos]),
    )


def derive_verdict(
    walk_forward: WalkForwardRecord,
    min_consistency: float = 0.6,
    min_robustness: float = 0.5,
    min_trades_per_fold: int = 10,
) -> tuple[AttestationVerdict, str]:
    """Derive a verification verdict from walk-forward results.

    Rules:
    - QUALIFIED: consistency >= min_consistency AND robustness >= min_robustness
      AND all folds have >= min_trades_per_fold
    - ELIMINATED: consistency < 0.3 OR robustness < 0.2
    - NEEDS_REVIEW: everything else
    """
    consistency = walk_forward.consistency_score or 0.0
    robustness = walk_forward.robustness_index

    # Check trade count per fold
    low_trade_folds = [
        f
        for f in walk_forward.folds
        if f.out_of_sample_metrics is not None
        and f.out_of_sample_metrics.total_trades < min_trades_per_fold
    ]

    if consistency < 0.3:
        return AttestationVerdict.ELIMINATED, (
            f"Consistency too low: {consistency:.1%} < 30%"
        )

    if robustness is not None and robustness < 0.2:
        return AttestationVerdict.ELIMINATED, (
            f"Robustness too low: {robustness:.2f} < 0.20"
        )

    if (
        consistency >= min_consistency
        and (robustness is None or robustness >= min_robustness)
        and not low_trade_folds
    ):
        reason = f"Consistency {consistency:.1%}, robustness {robustness or 'N/A'}"
        return AttestationVerdict.QUALIFIED, reason

    reasons = []
    if consistency < min_consistency:
        reasons.append(f"consistency {consistency:.1%} < {min_consistency:.0%}")
    if robustness is not None and robustness < min_robustness:
        reasons.append(f"robustness {robustness:.2f} < {min_robustness:.2f}")
    if low_trade_folds:
        reasons.append(f"{len(low_trade_folds)} fold(s) with < {min_trades_per_fold} trades")
    return AttestationVerdict.NEEDS_REVIEW, "Needs review: " + ", ".join(reasons)


def to_attestation_json(attestation: Attestation) -> str:
    """Serialize a stamped Attestation to canonical JSON + newline."""
    stamped = stamp_attestation(attestation)
    data = stamped.model_dump(mode="json")
    return canonical_json(data) + "\n"


def from_attestation_json(content: str) -> Attestation:
    """Parse attestation JSON content into an Attestation model."""
    import json

    data = json.loads(content.strip())
    return Attestation.model_validate(data)


def verify_attestation_chain(
    attestation: Attestation,
    genome: GenomeDocument,
) -> list[str]:
    """Validate attestation integrity against its genome.

    Returns list of error strings (empty = all valid).
    """
    from strategydna.canon import verify as verify_genome

    errors: list[str] = []

    if not verify_attestation(attestation):
        errors.append(
            f"Attestation hash invalid: stored={attestation.hash}, "
            f"computed={compute_attestation_hash(attestation)}"
        )

    if genome.frontmatter.hash is None:
        errors.append("Genome is not stamped (no hash)")
    elif genome.frontmatter.hash != attestation.genome_hash:
        errors.append(
            f"Genome hash mismatch: genome={genome.frontmatter.hash}, "
            f"attestation.genome_hash={attestation.genome_hash}"
        )

    if genome.frontmatter.hash is not None and not verify_genome(genome):
        errors.append("Genome content hash verification failed")

    return errors


def _merge_fold_datasets(folds: list[FoldResult]) -> DatasetManifest:
    """Merge fold datasets into an overall dataset manifest."""
    if not folds:
        return DatasetManifest(pairs=[], timeframe="1h", start_date="", end_date="")

    all_pairs: set[str] = set()
    start_dates: list[str] = []
    end_dates: list[str] = []
    timeframe = folds[0].dataset.timeframe
    exchange = folds[0].dataset.exchange

    for fold in folds:
        all_pairs.update(fold.dataset.pairs)
        start_dates.append(fold.dataset.start_date)
        end_dates.append(fold.dataset.end_date)

    return DatasetManifest(
        pairs=sorted(all_pairs),
        timeframe=timeframe,
        exchange=exchange,
        start_date=min(start_dates) if start_dates else "",
        end_date=max(end_dates) if end_dates else "",
    )


def _avg_optional(values: list[float | None]) -> float | None:
    """Average non-None values. Returns None if all are None."""
    valid = [v for v in values if v is not None]
    if not valid:
        return None
    return round(sum(valid) / len(valid), 4)

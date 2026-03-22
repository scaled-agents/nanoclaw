"""File-backed strategy registry with scoring, search, and leaderboard."""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from aphexdna.attestation import from_attestation_json, to_attestation_json
from aphexdna.models import GenomeDocument
from aphexdna.scoring import RegistryScore, RegistryTier, score_entry
from aphexdna.verification import Attestation

logger = logging.getLogger(__name__)
_VALID_HASH = re.compile(r"^(?:sha256:)?[0-9a-f]+$")

# --- Models ---


class RegistryEntry(BaseModel):
    """A single entry in the strategy registry."""

    genome_hash: str = Field(..., description="Display hash (sha256:xxxx)")

    # Metadata snapshot (captured at registration time)
    name: str = Field(...)
    author: str = Field(default="")
    tags: list[str] = Field(default_factory=list)
    pairs: list[str] = Field(default_factory=list)
    timeframe: str = Field(default="4h")
    parent_hash: str | None = Field(default=None)

    # Registry-specific fields
    attestation_hashes: list[str] = Field(default_factory=list)
    score: RegistryScore = Field(default_factory=RegistryScore)
    registered_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    registered_by: str = Field(default="")
    is_public: bool = Field(default=True)


class RegistryIndex(BaseModel):
    """Root index document for a .sdna-registry directory."""

    format_version: Literal["0.1"] = Field(default="0.1")
    entries: dict[str, RegistryEntry] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class LeaderboardEntry(BaseModel):
    """A single ranked entry in a leaderboard."""

    rank: int
    genome_hash: str
    name: str
    tags: list[str] = Field(default_factory=list)
    pairs: list[str] = Field(default_factory=list)
    timeframe: str = ""
    composite_score: float = 0.0
    backtest_score: float = 0.0
    robustness_score: float = 0.0
    adoption_score: float = 0.0
    tier: RegistryTier = RegistryTier.POOR
    attestation_count: int = 0
    parent_hash: str | None = None


class RegistrySnapshot(BaseModel):
    """Full registry export snapshot, TradeV-importable."""

    format_version: Literal["0.1"] = Field(default="0.1")
    snapshot_date: str = Field(description="ISO date")
    total_entries: int
    entries: list[RegistryEntry]
    leaderboard: list[LeaderboardEntry]


# --- Registry Class ---


class Registry:
    """File-backed strategy registry.

    Directory structure:
        .sdna-registry/
            index.json          # RegistryIndex
            attestations/       # individual attestation files
                {hash}.json
    """

    def __init__(self, path: Path | str = ".sdna-registry") -> None:
        self._path = Path(path)
        self._index: RegistryIndex | None = None

    @property
    def index_path(self) -> Path:
        return self._path / "index.json"

    @property
    def attestations_dir(self) -> Path:
        return self._path / "attestations"

    @property
    def entries(self) -> dict[str, RegistryEntry]:
        return self._load_index().entries

    def __len__(self) -> int:
        return len(self._load_index().entries)

    def __contains__(self, genome_hash: str) -> bool:
        return genome_hash in self._load_index().entries

    def init(self) -> None:
        """Create the registry directory and empty index."""
        if self._path.exists():
            raise FileExistsError(f"Registry already exists at {self._path}")
        self._path.mkdir(parents=True)
        self.attestations_dir.mkdir()
        self._index = RegistryIndex()
        self._save_index()

    def add(
        self,
        genome: GenomeDocument,
        attestation: Attestation | None = None,
        registered_by: str = "",
    ) -> RegistryEntry:
        """Register a genome, optionally with an initial attestation."""
        if genome.frontmatter.hash is None:
            raise ValueError("Genome must be stamped before registering")

        index = self._load_index()
        gh = genome.frontmatter.hash
        if gh in index.entries:
            raise ValueError(f"Genome {gh} already registered")

        entry = RegistryEntry(
            genome_hash=gh,
            name=genome.frontmatter.name,
            author=genome.frontmatter.author,
            tags=list(genome.frontmatter.tags),
            pairs=list(genome.body.pairs),
            timeframe=genome.body.timeframe,
            parent_hash=genome.frontmatter.parent,
            registered_by=registered_by,
        )

        if attestation is not None:
            self._validate_attestation(gh, attestation)
            self._save_attestation(attestation)
            assert attestation.hash is not None
            entry.attestation_hashes.append(attestation.hash)
            entry.score = score_entry([attestation])

        index.entries[gh] = entry
        index.updated_at = datetime.now(UTC)
        self._save_index()
        return entry

    def attach_attestation(
        self,
        genome_hash: str,
        attestation: Attestation,
    ) -> RegistryEntry:
        """Attach an attestation to an existing registry entry."""
        index = self._load_index()
        if genome_hash not in index.entries:
            raise KeyError(f"Genome {genome_hash} not in registry")

        self._validate_attestation(genome_hash, attestation)

        entry = index.entries[genome_hash]
        self._save_attestation(attestation)

        assert attestation.hash is not None
        if attestation.hash not in entry.attestation_hashes:
            entry.attestation_hashes.append(attestation.hash)

        # Re-score from all attestations
        all_atts = self._load_attestations(entry.attestation_hashes)
        entry.score = score_entry(all_atts)

        index.updated_at = datetime.now(UTC)
        self._save_index()
        return entry

    def get(self, genome_hash: str) -> RegistryEntry | None:
        """Look up an entry by genome hash."""
        return self._load_index().entries.get(genome_hash)

    def search(
        self,
        pairs: list[str] | None = None,
        timeframe: str | None = None,
        tier: str | None = None,
        tags: list[str] | None = None,
        author: str | None = None,
        limit: int = 50,
    ) -> list[RegistryEntry]:
        """Filtered discovery across registry entries."""
        results: list[RegistryEntry] = []

        for entry in self._load_index().entries.values():
            if pairs and not any(p in entry.pairs for p in pairs):
                continue
            if timeframe and entry.timeframe != timeframe:
                continue
            if tier and entry.score.tier.value != tier:
                continue
            if tags and not any(t in entry.tags for t in tags):
                continue
            if author and entry.author != author:
                continue
            results.append(entry)

        # Sort by composite score descending
        results.sort(key=lambda e: e.score.composite_score, reverse=True)
        return results[:limit]

    def leaderboard(
        self,
        sort_by: str = "composite_score",
        limit: int = 20,
        pair: str | None = None,
        timeframe: str | None = None,
    ) -> list[LeaderboardEntry]:
        """Generate ranked leaderboard from registry entries."""
        entries = list(self._load_index().entries.values())

        # Apply filters
        if pair:
            entries = [e for e in entries if pair in e.pairs]
        if timeframe:
            entries = [e for e in entries if e.timeframe == timeframe]

        # Sort
        sort_field = sort_by if sort_by in {
            "composite_score", "backtest_score", "robustness_score", "adoption_score"
        } else "composite_score"
        entries.sort(
            key=lambda e: getattr(e.score, sort_field, 0.0),
            reverse=True,
        )
        entries = entries[:limit]

        # Build ranked entries
        return [
            LeaderboardEntry(
                rank=i + 1,
                genome_hash=e.genome_hash,
                name=e.name,
                tags=e.tags,
                pairs=e.pairs,
                timeframe=e.timeframe,
                composite_score=e.score.composite_score,
                backtest_score=e.score.backtest_score,
                robustness_score=e.score.robustness_score,
                adoption_score=e.score.adoption_score,
                tier=e.score.tier,
                attestation_count=len(e.attestation_hashes),
                parent_hash=e.parent_hash,
            )
            for i, e in enumerate(entries)
        ]

    def lineage_tree(self, genome_hash: str) -> dict[str, list[str]]:
        """Find ancestors and descendants of a genome within the registry."""
        index = self._load_index()
        if genome_hash not in index.entries:
            raise KeyError(f"Genome {genome_hash} not in registry")

        entry = index.entries[genome_hash]

        # Ancestors: walk parent chain
        ancestors = []
        current_parent = entry.parent_hash
        while current_parent and current_parent in index.entries:
            ancestors.append(current_parent)
            current_parent = index.entries[current_parent].parent_hash

        # Descendants: entries whose parent is genome_hash
        descendants = [
            h for h, e in index.entries.items()
            if h != genome_hash and e.parent_hash == genome_hash
        ]

        return {"ancestors": ancestors, "descendants": descendants}

    def export_snapshot(self) -> RegistrySnapshot:
        """Export full registry as a TradeV-importable snapshot."""
        index = self._load_index()
        entries = list(index.entries.values())
        lb = self.leaderboard(limit=len(entries))

        return RegistrySnapshot(
            snapshot_date=datetime.now(UTC).strftime("%Y-%m-%d"),
            total_entries=len(entries),
            entries=entries,
            leaderboard=lb,
        )

    # --- Internal helpers ---

    def _load_index(self) -> RegistryIndex:
        """Load index from disk. Uses cached version if available."""
        if self._index is not None:
            return self._index

        if not self.index_path.exists():
            raise FileNotFoundError(
                f"Registry not found at {self._path}. "
                "Run 'sdna registry init' first."
            )

        data = json.loads(self.index_path.read_text(encoding="utf-8"))
        self._index = RegistryIndex.model_validate(data)
        return self._index

    def _save_index(self) -> None:
        """Write current index to disk atomically."""
        if self._index is None:
            return
        data = self._index.model_dump(mode="json")
        content = json.dumps(data, indent=2, ensure_ascii=False) + "\n"

        fd, tmp_path = tempfile.mkstemp(
            dir=str(self._path), suffix=".tmp", prefix=".index_",
        )
        closed = False
        try:
            os.write(fd, content.encode("utf-8"))
            os.close(fd)
            closed = True
            os.replace(tmp_path, str(self.index_path))
        except BaseException:
            if not closed:
                os.close(fd)
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise

    def _validate_attestation(
        self, genome_hash: str, attestation: Attestation
    ) -> None:
        """Validate attestation before attaching."""
        if attestation.hash is None:
            raise ValueError("Attestation must be stamped")
        if attestation.genome_hash != genome_hash:
            raise ValueError(
                f"Attestation genome_hash {attestation.genome_hash} "
                f"does not match {genome_hash}"
            )

    @staticmethod
    def _validate_hash_filename(h: str) -> str:
        """Validate that a hash string is safe for use as a filename."""
        if not _VALID_HASH.match(h):
            raise ValueError(f"Invalid hash format: {h!r}")
        return h

    def _save_attestation(self, attestation: Attestation) -> None:
        """Save attestation to attestations/{hash}.json atomically."""
        assert attestation.hash is not None
        self._validate_hash_filename(attestation.hash)
        if not self.attestations_dir.exists():
            self.attestations_dir.mkdir(parents=True)
        content = to_attestation_json(attestation)
        target = self.attestations_dir / f"{attestation.hash}.json"
        fd, tmp_path = tempfile.mkstemp(
            dir=str(self.attestations_dir), suffix=".tmp", prefix=".att_",
        )
        closed = False
        try:
            os.write(fd, content.encode("utf-8"))
            os.close(fd)
            closed = True
            os.replace(tmp_path, str(target))
        except BaseException:
            if not closed:
                os.close(fd)
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise

    def _load_attestation(self, att_hash: str) -> Attestation | None:
        """Load a single attestation from the attestations directory."""
        self._validate_hash_filename(att_hash)
        path = self.attestations_dir / f"{att_hash}.json"
        if not path.exists():
            return None
        content = path.read_text(encoding="utf-8")
        return from_attestation_json(content)

    def _load_attestations(self, hashes: list[str]) -> list[Attestation]:
        """Load multiple attestations, warning on missing files."""
        result: list[Attestation] = []
        for h in hashes:
            att = self._load_attestation(h)
            if att is not None:
                result.append(att)
            else:
                logger.warning("Attestation file missing: %s", h)
        return result

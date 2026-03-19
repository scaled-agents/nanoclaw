"""Semantic diff between two .sdna genomes.

Operates on the JSON body only (strategy content).
Frontmatter metadata (hash, parent, tags) is not diffed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from strategydna.models import GenomeDocument


@dataclass
class DiffEntry:
    """A single diff entry."""

    path: str
    change_type: str  # "added", "removed", "changed"
    old_value: Any = None
    new_value: Any = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"path": self.path, "type": self.change_type}
        if self.old_value is not None:
            result["old"] = self.old_value
        if self.new_value is not None:
            result["new"] = self.new_value
        return result


@dataclass
class GenomeDiff:
    """Result of diffing two genomes."""

    base_hash: str | None
    target_hash: str | None
    entries: list[DiffEntry] = field(default_factory=list)

    @property
    def has_changes(self) -> bool:
        return len(self.entries) > 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "base_hash": self.base_hash,
            "target_hash": self.target_hash,
            "changes": [e.to_dict() for e in self.entries],
            "total_changes": len(self.entries),
        }

    def summary(self) -> str:
        """Human-readable summary."""
        if not self.has_changes:
            return "No changes."
        lines = [f"{len(self.entries)} change(s):"]
        for entry in self.entries:
            if entry.change_type == "changed":
                lines.append(f"  ~ {entry.path}: {entry.old_value!r} -> {entry.new_value!r}")
            elif entry.change_type == "added":
                lines.append(f"  + {entry.path}: {entry.new_value!r}")
            elif entry.change_type == "removed":
                lines.append(f"  - {entry.path}: {entry.old_value!r}")
        return "\n".join(lines)


def _diff_dicts(
    base: dict[str, Any],
    target: dict[str, Any],
    path_prefix: str = "",
) -> list[DiffEntry]:
    """Recursively diff two dicts."""
    entries: list[DiffEntry] = []
    all_keys = sorted(set(base.keys()) | set(target.keys()))

    for key in all_keys:
        current_path = f"{path_prefix}.{key}" if path_prefix else key

        if key not in base:
            entries.append(DiffEntry(current_path, "added", new_value=target[key]))
        elif key not in target:
            entries.append(DiffEntry(current_path, "removed", old_value=base[key]))
        elif base[key] != target[key]:
            if isinstance(base[key], dict) and isinstance(target[key], dict):
                entries.extend(_diff_dicts(base[key], target[key], current_path))
            elif isinstance(base[key], list) and isinstance(target[key], list):
                entries.extend(_diff_lists(base[key], target[key], current_path))
            else:
                entries.append(
                    DiffEntry(current_path, "changed", old_value=base[key], new_value=target[key])
                )

    return entries


def _diff_lists(
    base: list[Any],
    target: list[Any],
    path: str,
) -> list[DiffEntry]:
    """Diff two lists by index."""
    entries: list[DiffEntry] = []

    max_len = max(len(base), len(target))
    for i in range(max_len):
        item_path = f"{path}[{i}]"
        if i >= len(base):
            entries.append(DiffEntry(item_path, "added", new_value=target[i]))
        elif i >= len(target):
            entries.append(DiffEntry(item_path, "removed", old_value=base[i]))
        elif base[i] != target[i]:
            if isinstance(base[i], dict) and isinstance(target[i], dict):
                entries.extend(_diff_dicts(base[i], target[i], item_path))
            else:
                entries.append(
                    DiffEntry(item_path, "changed", old_value=base[i], new_value=target[i])
                )

    return entries


def diff(base: GenomeDocument, target: GenomeDocument) -> GenomeDiff:
    """
    Compute semantic diff between two genomes.

    Compares body (strategy content) only. Frontmatter is excluded.
    """
    base_data = base.body.model_dump(mode="json")
    target_data = target.body.model_dump(mode="json")

    entries = _diff_dicts(base_data, target_data)

    return GenomeDiff(
        base_hash=base.frontmatter.hash,
        target_hash=target.frontmatter.hash,
        entries=entries,
    )

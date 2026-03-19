"""Canonical JSON serialization, SHA-256 hashing, and .sdna file I/O.

FreqHub format: YAML frontmatter + JSON body.
Hash computed from JSON body only (canonical JSON, sorted keys, no whitespace).
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import yaml

from strategydna.models import Frontmatter, GenomeBody, GenomeDocument


def canonical_json(data: dict[str, Any]) -> str:
    """Produce canonical JSON: sorted keys at all levels, no whitespace, UTF-8."""
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_hash(document: GenomeDocument) -> str:
    """
    Compute SHA-256 content hash of the genome body only.

    Returns the full 64-char hex digest.
    """
    body_data = document.body.model_dump(mode="json")
    canonical = canonical_json(body_data)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def display_hash(full_hash: str) -> str:
    """Format hash for display: sha256: prefix + first 16 hex chars."""
    return f"sha256:{full_hash[:16]}"


def parse_display_hash(display: str) -> str:
    """Extract hex from display hash. 'sha256:a1b2c3d4' → 'a1b2c3d4'."""
    if display.startswith("sha256:"):
        return display[7:]
    return display


def stamp(document: GenomeDocument) -> GenomeDocument:
    """Compute and set the content hash, returning a new copy."""
    full = compute_hash(document)
    new_fm = document.frontmatter.model_copy(update={"hash": display_hash(full)})
    return document.model_copy(update={"frontmatter": new_fm})


def verify(document: GenomeDocument) -> bool:
    """Verify that a document's hash matches its body content. False if unstamped."""
    if document.frontmatter.hash is None:
        return False
    computed = compute_hash(document)
    expected = parse_display_hash(document.frontmatter.hash)
    # Support both full hash and truncated prefix comparison (constant-time)
    if len(expected) == 64:
        return hmac.compare_digest(computed, expected)
    return hmac.compare_digest(computed[:len(expected)], expected)


def to_sdna(document: GenomeDocument) -> str:
    """Serialize a GenomeDocument to .sdna file content (YAML frontmatter + JSON body)."""
    stamped = stamp(document)
    fm_data = stamped.frontmatter.model_dump(mode="json")
    body_data = stamped.body.model_dump(mode="json")

    yaml_str = yaml.dump(
        fm_data,
        default_flow_style=False,
        sort_keys=True,
        width=1000,
        allow_unicode=True,
    ).strip()

    json_str = json.dumps(body_data, indent=2)
    return f"---\n{yaml_str}\n---\n{json_str}\n"


MAX_SDNA_SIZE = 1_048_576  # 1 MB


def from_sdna(content: str) -> GenomeDocument:
    """Parse .sdna file content into a GenomeDocument.

    Supports the FreqHub YAML+JSON format (--- delimited).
    """
    if len(content) > MAX_SDNA_SIZE:
        raise ValueError(f"Payload too large: {len(content)} bytes (max {MAX_SDNA_SIZE})")
    trimmed = content.strip()

    if not trimmed.startswith("---"):
        raise ValueError(
            "Invalid .sdna format: expected YAML frontmatter starting with '---'. "
            "Legacy JSON-only format is no longer supported."
        )

    # Find the closing --- delimiter
    second_delim = trimmed.index("---", 4)
    yaml_str = trimmed[3:second_delim].strip()
    json_str = trimmed[second_delim + 3:].strip()

    fm_data = yaml.safe_load(yaml_str) or {}
    body_data = json.loads(json_str)

    return GenomeDocument(
        frontmatter=Frontmatter.model_validate(fm_data),
        body=GenomeBody.model_validate(body_data),
    )

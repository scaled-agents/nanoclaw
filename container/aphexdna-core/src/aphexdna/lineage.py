"""Lineage / parent pointer management for genome DAGs.

FreqHub format: parent is stored as frontmatter.parent (display hash).
No lineage array — just parent pointers forming a DAG.
"""

from __future__ import annotations

from aphexdna.canon import stamp
from aphexdna.models import GenomeDocument


def set_parent(child: GenomeDocument, parent: GenomeDocument) -> GenomeDocument:
    """
    Set a parent-child relationship.

    1. Stamp parent to ensure it has a hash
    2. Set child.frontmatter.parent = parent's display hash
    3. Re-stamp the child
    """
    stamped_parent = stamp(parent)
    assert stamped_parent.frontmatter.hash is not None

    new_fm = child.frontmatter.model_copy(
        update={"parent": stamped_parent.frontmatter.hash}
    )
    updated = child.model_copy(update={"frontmatter": new_fm})
    return stamp(updated)


def get_depth(document: GenomeDocument) -> int:
    """Generation depth (0 = root, 1+ = has parent)."""
    return 0 if document.frontmatter.parent is None else 1

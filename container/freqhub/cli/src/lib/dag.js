/**
 * DAG (Directed Acyclic Graph) utilities for genome lineage.
 * Edges point from parent → child.
 */

/**
 * Build adjacency list from an array of genome entries.
 * Each entry must have { id, hash, parent }.
 * @returns {{ children: Map, parents: Map, roots: string[], leaves: string[] }}
 */
export function buildDAG(genomes) {
  const children = new Map(); // hash → [child hashes]
  const parents = new Map();  // hash → parent hash
  const allHashes = new Set();

  for (const g of genomes) {
    const h = g.hash;
    allHashes.add(h);
    if (!children.has(h)) children.set(h, []);

    if (g.parent) {
      parents.set(h, g.parent);
      if (!children.has(g.parent)) children.set(g.parent, []);
      children.get(g.parent).push(h);
    }
  }

  // Roots: nodes with no parent
  const roots = genomes
    .filter(g => !g.parent)
    .map(g => g.hash);

  // Leaves: nodes with no children
  const leaves = genomes
    .filter(g => (children.get(g.hash) || []).length === 0)
    .map(g => g.hash);

  return { children, parents, roots, leaves };
}

/**
 * Walk lineage from a genome back to its root.
 * @returns {string[]} Array of hashes from current → root
 */
export function getLineage(hash, parents) {
  const lineage = [hash];
  let current = hash;
  const visited = new Set();

  while (parents.has(current)) {
    if (visited.has(current)) break; // prevent cycles
    visited.add(current);
    current = parents.get(current);
    lineage.push(current);
  }

  return lineage;
}

/**
 * Get the depth of each node in the DAG.
 */
export function getDepths(genomes, parents) {
  const depths = new Map();

  for (const g of genomes) {
    const lineage = getLineage(g.hash, parents);
    depths.set(g.hash, lineage.length - 1);
  }

  return depths;
}

/**
 * Build edges array for the DAG.
 */
export function getEdges(genomes) {
  const edges = [];
  for (const g of genomes) {
    if (g.parent) {
      edges.push({ from: g.parent, to: g.hash });
    }
  }
  return edges;
}

/**
 * Compute frontier: leaf nodes sorted by walk-forward Sharpe descending.
 * These are the most promising unexplored branches.
 */
export function computeFrontier(genomes, leaves, topN = 10) {
  const leafSet = new Set(leaves);
  const leafGenomes = genomes.filter(g => leafSet.has(g.hash));

  return leafGenomes
    .filter(g => g.attestation?.walk_forward_sharpe != null)
    .sort((a, b) =>
      (b.attestation.walk_forward_sharpe || 0) -
      (a.attestation.walk_forward_sharpe || 0)
    )
    .slice(0, topN)
    .map(g => ({
      hash: g.hash,
      name: g.name || g.id,
      sharpe: g.attestation.walk_forward_sharpe,
      tags: g.tags || [],
      depth: 0, // filled in later if needed
    }));
}

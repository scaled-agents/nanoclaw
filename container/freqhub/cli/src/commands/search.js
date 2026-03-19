import path from 'path';
import { loadMergedRegistry, loadLocalRegistry } from '../lib/registry.js';

/**
 * Simple fuzzy match: check if query words appear in target string.
 */
function fuzzyMatch(query, target) {
  if (!query) return true;
  const words = query.toLowerCase().split(/\s+/);
  const lower = target.toLowerCase();
  return words.every(w => lower.includes(w));
}

/**
 * Search the registry for genomes matching query and filters.
 */
export async function searchRegistry(query, opts = {}) {
  // Try local dist/registry.json first, then merged sources
  let registry;
  const localPath = path.join(process.cwd(), 'dist', 'registry.json');
  try {
    registry = await loadMergedRegistry(localPath);
  } catch {
    registry = { genomes: [] };
  }

  let results = registry.genomes || [];

  // Text search across name, description, tags, id
  if (query) {
    results = results.filter(g => {
      const searchable = [
        g.name,
        g.description,
        g.id,
        ...(g.tags || []),
      ].join(' ');
      return fuzzyMatch(query, searchable);
    });
  }

  // Filter by tag
  if (opts.tag) {
    results = results.filter(g =>
      (g.tags || []).some(t => t.toLowerCase() === opts.tag.toLowerCase())
    );
  }

  // Filter by operator
  if (opts.operator) {
    results = results.filter(g =>
      g.operator?.toLowerCase() === opts.operator.toLowerCase()
    );
  }

  // Filter by min Sharpe
  if (opts.minSharpe != null) {
    results = results.filter(g =>
      (g.attestation?.walk_forward_sharpe || 0) >= opts.minSharpe
    );
  }

  // Filter by timeframe
  if (opts.timeframe) {
    results = results.filter(g =>
      g.timeframe === opts.timeframe
    );
  }

  // Filter by pair
  if (opts.pair) {
    results = results.filter(g =>
      (g.pairs || []).some(p => p.toUpperCase() === opts.pair.toUpperCase())
    );
  }

  // Sort by Sharpe descending
  results.sort((a, b) =>
    (b.attestation?.walk_forward_sharpe || 0) -
    (a.attestation?.walk_forward_sharpe || 0)
  );

  return results;
}

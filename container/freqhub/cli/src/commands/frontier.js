import path from 'path';
import { loadMergedRegistry } from '../lib/registry.js';

/**
 * Show most promising unexplored DAG branches (frontier).
 * Frontier = leaf nodes sorted by walk-forward Sharpe.
 */
export async function showFrontier(opts = {}) {
  const localRegistry = path.join(process.cwd(), 'dist', 'registry.json');
  const registry = await loadMergedRegistry(localRegistry);

  let frontier = registry.dag?.frontier || [];

  // Limit to top N
  const top = opts.top || 10;
  frontier = frontier.slice(0, top);

  if (frontier.length === 0) {
    console.log('No frontier genomes found. Build the registry first: sdna build content/');
    return;
  }

  console.log('');
  console.log('  Frontier — Most Promising Unexplored Branches');
  console.log('  ' + '-'.repeat(60));

  for (const f of frontier) {
    const name = (f.name || f.hash).padEnd(30);
    const sharpe = (f.sharpe?.toFixed(2) || '-').padEnd(6);
    const tags = (f.tags || []).join(', ');
    console.log(`  ${name} Sharpe: ${sharpe}  ${tags}`);
  }

  console.log('');
  console.log(`  ${frontier.length} frontier nodes. Fork these for further exploration.`);
}

import path from 'path';
import { loadMergedRegistry } from '../lib/registry.js';

/**
 * Show strategy leaderboard ranked by walk-forward Sharpe.
 */
export async function showLeaderboard(opts = {}) {
  const localRegistry = path.join(process.cwd(), 'dist', 'registry.json');
  const registry = await loadMergedRegistry(localRegistry);

  let entries = registry.leaderboard || [];

  // If no pre-built leaderboard, build from genomes
  if (entries.length === 0) {
    entries = (registry.genomes || [])
      .filter(g => g.attestation?.walk_forward_sharpe != null)
      .sort((a, b) =>
        (b.attestation.walk_forward_sharpe || 0) -
        (a.attestation.walk_forward_sharpe || 0)
      )
      .map((g, i) => ({
        rank: i + 1,
        id: g.id,
        name: g.name,
        hash: g.hash,
        sharpe: g.attestation.walk_forward_sharpe,
        tier: g.tier,
        operator: g.operator,
        tags: g.tags || [],
      }));
  }

  // Filter by tier
  if (opts.tier) {
    entries = entries.filter(e =>
      e.tier?.toLowerCase() === opts.tier.toLowerCase()
    );
  }

  // Limit to top N
  const top = opts.top || 10;
  entries = entries.slice(0, top);

  if (entries.length === 0) {
    console.log('No attested genomes found in registry.');
    return;
  }

  // Print header
  console.log('');
  console.log('  #  Name                           Sharpe  Tier          Operator');
  console.log('  ' + '-'.repeat(75));

  for (const e of entries) {
    const rank = String(e.rank).padStart(2);
    const name = (e.name || e.id).padEnd(30);
    const sharpe = (e.sharpe?.toFixed(2) || '-').padEnd(6);
    const tier = (e.tier || '-').padEnd(13);
    const op = e.operator || '-';
    console.log(`  ${rank} ${name} ${sharpe}  ${tier} ${op}`);
  }

  console.log('');
  console.log(`  ${entries.length} entries shown.`);
}

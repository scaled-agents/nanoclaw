import fs from 'fs';
import path from 'path';
import { loadMergedRegistry } from '../lib/registry.js';
import { parse } from '../lib/frontmatter.js';

/**
 * Fetch a genome by registry ID.
 * Looks in local content directory first, then registry sources.
 */
export async function getGenome(id, opts = {}) {
  // Try local content directory
  const localPaths = [
    path.join(process.cwd(), 'content', id, 'GENOME.sdna'),
    path.join(process.cwd(), 'content', `${id}.sdna`),
  ];

  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      if (opts.json) {
        const { body } = parse(raw);
        return JSON.stringify(body, null, 2) + '\n';
      }
      if (opts.full) {
        return raw;
      }
      return raw;
    }
  }

  // Search registry for the genome
  const localRegistry = path.join(process.cwd(), 'dist', 'registry.json');
  const registry = await loadMergedRegistry(localRegistry);
  const genome = (registry.genomes || []).find(g =>
    g.id === id || g.hash === id || g.hash.startsWith(id) || g.name === id
  );

  if (!genome) {
    throw new Error(`Genome "${id}" not found in registry or local content.`);
  }

  // Try to load from path in registry
  if (genome.path) {
    const contentPath = path.join(process.cwd(), 'content', genome.path);
    if (fs.existsSync(contentPath)) {
      const raw = fs.readFileSync(contentPath, 'utf-8');
      if (opts.json) {
        const { body } = parse(raw);
        return JSON.stringify(body, null, 2) + '\n';
      }
      return raw;
    }
  }

  // Return metadata from registry
  if (opts.json) {
    return JSON.stringify(genome, null, 2) + '\n';
  }

  // Format as text
  const lines = [
    `ID:       ${genome.id}`,
    `Name:     ${genome.name}`,
    `Hash:     ${genome.hash}`,
    `Operator: ${genome.operator}`,
    `Tags:     ${(genome.tags || []).join(', ')}`,
    `Tier:     ${genome.tier}`,
  ];
  if (genome.attestation?.walk_forward_sharpe != null) {
    lines.push(`Sharpe:   ${genome.attestation.walk_forward_sharpe.toFixed(2)}`);
  }
  lines.push(`Path:     ${genome.path || 'remote'}`);
  return lines.join('\n') + '\n';
}

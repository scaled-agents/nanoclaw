import fs from 'fs';
import path from 'path';
import { parse, serialize } from '../lib/frontmatter.js';
import { computeHash, displayHash } from '../lib/hash.js';

/**
 * Create or update attestation for a genome.
 * Phase 4 will add full walk-forward validation integration.
 * For now, accepts manual attestation data.
 */
export function attestGenome(sourcePath, attestationData) {
  const raw = fs.readFileSync(sourcePath, 'utf-8');
  const { frontmatter, body } = parse(raw);

  // Ensure hash is set
  const hash = computeHash(body);
  frontmatter.hash = displayHash(hash);

  // Update attestation
  frontmatter.attestation = {
    status: 'attested',
    attested_at: new Date().toISOString(),
    ...attestationData,
  };

  const content = serialize(frontmatter, body);
  fs.writeFileSync(sourcePath, content);

  // Write ATTESTATION.json alongside genome
  const dir = path.dirname(sourcePath);
  const attestPath = path.join(dir, 'ATTESTATION.json');
  const attestDoc = {
    genome_hash: frontmatter.hash,
    attested_at: frontmatter.attestation.attested_at,
    ...attestationData,
  };
  fs.writeFileSync(attestPath, JSON.stringify(attestDoc, null, 2));

  return {
    path: sourcePath,
    attestationPath: attestPath,
    hash: frontmatter.hash,
    attestation: frontmatter.attestation,
  };
}

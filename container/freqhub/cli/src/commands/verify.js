import fs from 'fs';
import { parse } from '../lib/frontmatter.js';
import { verifyHash, computeHash, displayHash } from '../lib/hash.js';

/**
 * Verify a genome's integrity: hash matches body.
 * Phase 4 will add walk-forward validation (shells to freqtrade backtesting).
 */
export function verifyGenome(sourcePath) {
  const raw = fs.readFileSync(sourcePath, 'utf-8');
  const { frontmatter, body } = parse(raw);

  const computedHash = computeHash(body);
  const computedDisplay = displayHash(computedHash);

  const result = {
    path: sourcePath,
    name: frontmatter.name || sourcePath,
    declaredHash: frontmatter.hash || null,
    computedHash: computedDisplay,
    hashValid: false,
    attestation: frontmatter.attestation || { status: 'unattested' },
  };

  if (!frontmatter.hash || frontmatter.hash === '') {
    result.hashValid = false;
    result.message = 'No hash declared in frontmatter.';
  } else {
    result.hashValid = verifyHash(body, frontmatter.hash);
    result.message = result.hashValid
      ? 'Hash verified successfully.'
      : `Hash mismatch: declared ${frontmatter.hash}, computed ${computedDisplay}`;
  }

  return result;
}

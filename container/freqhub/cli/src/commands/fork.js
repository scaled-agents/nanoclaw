import fs from 'fs';
import path from 'path';
import { computeHash, displayHash } from '../lib/hash.js';
import { parse, serialize } from '../lib/frontmatter.js';
import { loadConfig } from '../lib/config.js';

/**
 * Deep-set a value using dot-notation path.
 * "risk.stop_loss.params.multiplier" → sets obj.risk.stop_loss.params.multiplier
 */
function deepSet(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null) {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Fork a genome with mutations, producing a child genome.
 */
export function forkGenome(sourcePath, options = {}) {
  const { mutations, name, output } = options;
  const config = loadConfig();

  // Read parent genome
  const raw = fs.readFileSync(sourcePath, 'utf-8');
  const { frontmatter, body } = parse(raw);

  const parentHash = frontmatter.hash;
  if (!parentHash) {
    throw new Error('Parent genome has no hash. Run sdna init or sdna build first.');
  }

  // Apply mutations to body
  const newBody = JSON.parse(JSON.stringify(body)); // deep clone
  if (mutations) {
    const muts = typeof mutations === 'string' ? JSON.parse(mutations) : mutations;
    for (const [dotPath, value] of Object.entries(muts)) {
      deepSet(newBody, dotPath, value);
    }
  }

  // Build child frontmatter
  const newFrontmatter = { ...frontmatter };
  newFrontmatter.parent = parentHash;
  newFrontmatter.created = new Date().toISOString();
  newFrontmatter.author = config.author;
  newFrontmatter.operator = config.operator;
  if (name) newFrontmatter.name = name;

  // Reset attestation
  newFrontmatter.attestation = { status: 'unattested' };

  // Compute new hash
  const hash = computeHash(newBody);
  newFrontmatter.hash = displayHash(hash);

  const content = serialize(newFrontmatter, newBody);

  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, content);
    return {
      path: output,
      hash: newFrontmatter.hash,
      parent: parentHash,
      name: newFrontmatter.name,
    };
  }

  return {
    content,
    hash: newFrontmatter.hash,
    parent: parentHash,
    name: newFrontmatter.name,
  };
}

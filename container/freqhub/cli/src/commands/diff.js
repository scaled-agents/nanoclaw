import fs from 'fs';
import { parse } from '../lib/frontmatter.js';

/**
 * Deep comparison of two objects, returning structured changes.
 */
function deepDiff(a, b, prefix = '') {
  const changes = [];

  const allKeys = new Set([
    ...Object.keys(a || {}),
    ...Object.keys(b || {}),
  ]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const valA = a?.[key];
    const valB = b?.[key];

    if (valA === valB) continue;

    if (
      valA !== null && valB !== null &&
      typeof valA === 'object' && typeof valB === 'object' &&
      !Array.isArray(valA) && !Array.isArray(valB)
    ) {
      // Recurse into objects
      changes.push(...deepDiff(valA, valB, path));
    } else {
      changes.push({ path, from: valA, to: valB });
    }
  }

  return changes;
}

/**
 * Group changes by top-level section.
 */
function groupChanges(changes) {
  const groups = {};
  for (const change of changes) {
    const section = change.path.split('.')[0];
    if (!groups[section]) groups[section] = [];
    groups[section].push(change);
  }
  return groups;
}

/**
 * Diff two .sdna files and return structured changes.
 */
export function diffGenomes(pathA, pathB) {
  const rawA = fs.readFileSync(pathA, 'utf-8');
  const rawB = fs.readFileSync(pathB, 'utf-8');

  const { frontmatter: fmA, body: bodyA } = parse(rawA);
  const { frontmatter: fmB, body: bodyB } = parse(rawB);

  const changes = deepDiff(bodyA, bodyB);
  const grouped = groupChanges(changes);

  // Find unchanged top-level sections
  const allSections = new Set([
    ...Object.keys(bodyA || {}),
    ...Object.keys(bodyB || {}),
  ]);
  const changedSections = new Set(Object.keys(grouped));
  const unchanged = [...allSections].filter(s => !changedSections.has(s));

  return {
    nameA: fmA.name || pathA,
    nameB: fmB.name || pathB,
    hashA: fmA.hash || 'unknown',
    hashB: fmB.hash || 'unknown',
    changes: grouped,
    unchanged,
    totalChanges: changes.length,
  };
}

/**
 * Format diff result as human-readable text.
 */
export function formatDiff(result) {
  const lines = [];
  lines.push(`Comparing: ${result.nameA} ↔ ${result.nameB}`);
  lines.push(`Hashes: ${result.hashA} ↔ ${result.hashB}`);
  lines.push('');

  if (result.totalChanges === 0) {
    lines.push('No changes in strategy body.');
    return lines.join('\n');
  }

  for (const [section, changes] of Object.entries(result.changes)) {
    lines.push(`${section} changes:`);
    for (const change of changes) {
      const from = JSON.stringify(change.from);
      const to = JSON.stringify(change.to);
      lines.push(`  ${change.path}: ${from} → ${to}`);
    }
    lines.push('');
  }

  if (result.unchanged.length > 0) {
    lines.push(`Unchanged: ${result.unchanged.join(', ')}`);
  }

  return lines.join('\n');
}

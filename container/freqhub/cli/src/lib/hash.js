import { createHash } from 'crypto';

/**
 * Recursively sort object keys at every nesting level.
 * Arrays preserve order; objects get sorted keys.
 */
export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);

  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}

/**
 * Produce canonical JSON string: sorted keys, no whitespace.
 */
export function toCanonicalJSON(obj) {
  return JSON.stringify(canonicalize(obj));
}

/**
 * Compute SHA-256 hash of a JSON body object.
 * Returns the full 64-char hex digest.
 */
export function computeHash(jsonBody) {
  const canonical = toCanonicalJSON(jsonBody);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Format hash for display: sha256: prefix + first 16 hex chars.
 */
export function displayHash(fullHash) {
  return `sha256:${fullHash.slice(0, 16)}`;
}

/**
 * Parse a display hash back to the prefix for matching.
 * "sha256:a1b2c3d4e5f6a7b8" → "a1b2c3d4e5f6a7b8"
 */
export function parseDisplayHash(display) {
  if (display.startsWith('sha256:')) return display.slice(7);
  return display;
}

/**
 * Verify that a hash matches the JSON body.
 */
export function verifyHash(jsonBody, expectedHash) {
  const computed = computeHash(jsonBody);
  const expected = parseDisplayHash(expectedHash);
  // Support both full hash and truncated comparison
  return computed === expected || computed.startsWith(expected);
}

import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from './config.js';

const CACHE_DIR = path.join(os.homedir(), '.sdna', 'sources');

/**
 * Load a registry from a local path.
 */
export function loadLocalRegistry(registryPath) {
  const raw = fs.readFileSync(registryPath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Load a registry from a remote URL.
 * Caches to ~/.sdna/sources/<name>/registry.json
 */
export async function loadRemoteRegistry(sourceName, baseUrl) {
  const url = `${baseUrl}/registry.json`;
  const cacheDir = path.join(CACHE_DIR, sourceName);
  const cachePath = path.join(cacheDir, 'registry.json');

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Cache locally
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    // Fall back to cache
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
    throw new Error(`Cannot fetch registry from ${url}: ${err.message}`);
  }
}

/**
 * Load and merge registries from all configured sources.
 * Local paths take precedence over remote.
 */
export async function loadMergedRegistry(localPath) {
  const config = loadConfig();
  const registries = [];

  // Load local registry if exists
  if (localPath && fs.existsSync(localPath)) {
    registries.push(loadLocalRegistry(localPath));
  }

  // Load remote sources
  for (const source of config.sources || []) {
    try {
      const reg = await loadRemoteRegistry(source.name, source.url);
      registries.push(reg);
    } catch {
      // Skip unreachable sources
    }
  }

  if (registries.length === 0) {
    return { genomes: [], stats: {}, dag: {}, leaderboard: [] };
  }

  // Merge: first registry wins for duplicate hashes
  const seen = new Set();
  const merged = [];

  for (const reg of registries) {
    for (const g of reg.genomes || []) {
      if (!seen.has(g.hash)) {
        seen.add(g.hash);
        merged.push(g);
      }
    }
  }

  return {
    genomes: merged,
    stats: registries[0].stats || {},
    dag: registries[0].dag || {},
    leaderboard: registries[0].leaderboard || [],
  };
}

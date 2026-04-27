/**
 * Shared state file loaders and config helpers.
 * Used by health-ticker.ts and deploy-ticker.ts.
 */

import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { parse as parseYaml } from 'yaml';

import { GROUPS_DIR } from './config.js';
import type { ScoringConfig, ArchetypeConfig } from './health-types.js';

const logger = pino({ name: 'state-loaders' });

// ─── Config Loading ─────────────────────────────────────────────────

export function loadScoringConfig(): ScoringConfig | null {
  const defaultsPath = path.resolve(
    process.cwd(),
    '..',
    'freqtrade-agents',
    'setup',
    'scoring-config-defaults.json',
  );

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
  } catch {
    logger.error(
      { path: defaultsPath },
      'Failed to load scoring-config-defaults.json',
    );
    return null;
  }

  // Override with workspace scoring-config.json if it exists
  try {
    if (fs.existsSync(GROUPS_DIR)) {
      for (const folder of fs.readdirSync(GROUPS_DIR)) {
        const overridePath = path.join(
          GROUPS_DIR,
          folder,
          'scoring-config.json',
        );
        if (!fs.existsSync(overridePath)) continue;
        const overrides = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
        config = deepMerge(config, overrides);
        break; // Use first group's override
      }
    }
  } catch {
    /* use defaults */
  }

  return config as ScoringConfig;
}

export function loadArchetypeConfigs(): Record<string, ArchetypeConfig> | null {
  const yamlPath = path.resolve(
    process.cwd(),
    '..',
    'freqtrade-agents',
    'skills',
    'archetype-taxonomy',
    'archetypes.yaml',
  );
  try {
    const content = fs.readFileSync(yamlPath, 'utf-8');
    const data = parseYaml(content);
    return (data?.archetypes ?? data) as Record<string, ArchetypeConfig>;
  } catch (err) {
    logger.error({ err, path: yamlPath }, 'Failed to load archetypes.yaml');
    return null;
  }
}

export function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ─── State Loading ──────────────────────────────────────────────────

/** Returns the first group folder path that exists, or null. */
export function findGroupDir(): string | null {
  try {
    if (!fs.existsSync(GROUPS_DIR)) return null;
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const fullPath = path.join(GROUPS_DIR, folder);
      if (fs.statSync(fullPath).isDirectory()) return fullPath;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function loadCampaigns(): any[] {
  const all: any[] = [];
  try {
    if (!fs.existsSync(GROUPS_DIR)) return [];
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const filePath = path.join(
        GROUPS_DIR,
        folder,
        'research-planner',
        'campaigns.json',
      );
      if (!fs.existsSync(filePath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.campaigns) all.push(...data.campaigns);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return all;
}

export function loadDeployments(): any[] {
  const all: any[] = [];
  try {
    if (!fs.existsSync(GROUPS_DIR)) return [];
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const filePath = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'deployments.json',
      );
      if (!fs.existsSync(filePath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.deployments) all.push(...data.deployments);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return all;
}

export function loadRoster(): any | null {
  try {
    if (!fs.existsSync(GROUPS_DIR)) return null;
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const filePath = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'roster.json',
      );
      if (!fs.existsSync(filePath)) continue;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function loadCellGrid(): any | null {
  try {
    if (!fs.existsSync(GROUPS_DIR)) return null;
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const filePath = path.join(
        GROUPS_DIR,
        folder,
        'reports',
        'cell-grid-latest.json',
      );
      if (!fs.existsSync(filePath)) continue;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function loadMarketPrior(): any | null {
  try {
    if (!fs.existsSync(GROUPS_DIR)) return null;
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const filePath = path.join(
        GROUPS_DIR,
        folder,
        'reports',
        'market-prior.json',
      );
      if (!fs.existsSync(filePath)) continue;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function loadTickId(): number {
  try {
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const depPath = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'deployments.json',
      );
      if (!fs.existsSync(depPath)) continue;
      const data = JSON.parse(fs.readFileSync(depPath, 'utf-8'));
      return (data._meta?.tick_count ?? 0) + 1;
    }
  } catch {
    /* ignore */
  }
  return 1;
}

export function saveTickId(tickId: number): void {
  try {
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const depPath = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'deployments.json',
      );
      if (!fs.existsSync(depPath)) continue;
      const data = JSON.parse(fs.readFileSync(depPath, 'utf-8'));
      if (!data._meta) data._meta = {};
      data._meta.tick_count = tickId;
      fs.writeFileSync(depPath, JSON.stringify(data, null, 2));
      break;
    }
  } catch {
    /* ignore */
  }
}

// ─── Generic JSON helpers ───────────────────────────────────────────

export function readJsonFile(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeJsonFile(filePath: string, data: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

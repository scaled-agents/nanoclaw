/**
 * Console Sync Service
 *
 * Periodically pushes nanoclaw state to the freqtrade.ai console Supabase project.
 * Runs every 60s as a scheduled task within nanoclaw's main process.
 *
 * Environment variables:
 *   CONSOLE_SUPABASE_URL   — e.g., https://<project>.supabase.co
 *   CONSOLE_SYNC_KEY       — operator sync key from onboarding (NOT service-role key)
 *   CONSOLE_OPERATOR_ID    — operator UUID from onboarding
 */

import fs from 'fs';
import path from 'path';
import { Database } from 'better-sqlite3';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { GROUPS_DIR } from './config.js';

const SYNC_INTERVAL_MS = 60_000;
const MAX_RETRIES = 3;
const CURSOR_FILE = 'console-sync/cursor.json';
const USAGE_FETCH_EVERY_N_CYCLES = 60; // ~hourly (60 × 60s)
const COMPOSITES_FILE = '.cell-grid-composites.json';

// Canonical archetype names from archetypes.yaml.  The market-timing agent
// sometimes shortens names (e.g. "CARRY" instead of "CARRY_FUNDING").
// Normalize before pushing to Supabase so the frontend always finds them.
const CANONICAL_ARCHETYPES = new Set([
  'TREND_MOMENTUM',
  'BREAKOUT',
  'MEAN_REVERSION',
  'RANGE_BOUND',
  'SCALPING',
  'VOLATILITY_HARVEST',
  'CARRY_FUNDING',
]);
const ARCHETYPE_ALIASES: Record<string, string> = {
  CARRY: 'CARRY_FUNDING',
  RANGE: 'RANGE_BOUND',
  MOMENTUM_DIVERGENCE: 'VOLATILITY_HARVEST',
  MOMENTUM_BREAKOUT: 'BREAKOUT',
  GRID: 'RANGE_BOUND',
  TREND: 'TREND_MOMENTUM',
  VOL_HARVEST: 'VOLATILITY_HARVEST',
  VOLATILITY: 'VOLATILITY_HARVEST',
  MEAN_REV: 'MEAN_REVERSION',
  FUNDING: 'CARRY_FUNDING',
};

function normalizeArchetype(raw: string): string | null {
  if (CANONICAL_ARCHETYPES.has(raw)) return raw;
  return ARCHETYPE_ALIASES[raw] ?? null; // null = garbage, skip row
}
let syncCycleCount = 0;

// Trend boost: track previous scoring cycle composites for delta computation
let prevComposites: Map<string, number> = new Map();
let prevScoredAt: string | null = null;
let currentTrendBoosts: Map<string, number> = new Map();
let compositesInitialized = false;

const CONSOLE_ENV_KEYS = [
  'CONSOLE_SUPABASE_URL',
  'CONSOLE_SUPABASE_ANON_KEY',
  'CONSOLE_SYNC_KEY',
  'CONSOLE_OPERATOR_ID',
  'APHEXDATA_URL',
  'APHEXDATA_API_KEY',
];

interface SyncCursor {
  last_event_id: string | null;
  last_roster_hash: string | null;
  last_event_at: string | null;
}

interface SyncConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  syncKey: string;
  operatorId: string;
  dataDir: string;
  aphexdataUrl: string;
  aphexdataApiKey: string;
}

function loadCursor(dataDir: string): SyncCursor {
  const cursorPath = path.join(dataDir, CURSOR_FILE);
  try {
    if (fs.existsSync(cursorPath)) {
      return JSON.parse(fs.readFileSync(cursorPath, 'utf-8'));
    }
  } catch {
    // Ignore parse errors, start fresh
  }
  return { last_event_id: null, last_roster_hash: null, last_event_at: null };
}

function saveCursor(dataDir: string, cursor: SyncCursor): void {
  const cursorPath = path.join(dataDir, CURSOR_FILE);
  const dir = path.dirname(cursorPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cursorPath, JSON.stringify(cursor, null, 2));
}

function loadPrevComposites(groupDir: string): {
  composites: Map<string, number>;
  scoredAt: string | null;
  trendBoosts: Map<string, number>;
} {
  const filePath = path.join(groupDir, 'reports', COMPOSITES_FILE);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return {
        composites: new Map(Object.entries(data.composites ?? {})),
        scoredAt: data.scored_at ?? null,
        trendBoosts: new Map(Object.entries(data.trend_boosts ?? {})),
      };
    }
  } catch {
    // Ignore parse errors, start fresh
  }
  return { composites: new Map(), scoredAt: null, trendBoosts: new Map() };
}

function savePrevComposites(
  groupDir: string,
  scoredAt: string,
  composites: Map<string, number>,
  trendBoosts: Map<string, number>,
): void {
  const filePath = path.join(groupDir, 'reports', COMPOSITES_FILE);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        scored_at: scoredAt,
        composites: Object.fromEntries(composites),
        trend_boosts: Object.fromEntries(trendBoosts),
      },
      null,
      2,
    ),
  );
}

function computeTrendBoost(
  current: number,
  previous: number | undefined,
): number {
  if (previous === undefined) return 0.0;
  const delta = current - previous;
  if (delta > 0.3) return 0.2;
  if (delta < -0.3) return -0.1;
  return 0.0;
}

function loadBotStatuses(dataDir: string): any[] {
  const botsDir = path.join(dataDir, 'bot-runner/bots');
  if (!fs.existsSync(botsDir)) return [];
  return fs
    .readdirSync(botsDir)
    .filter((f) => f.endsWith('.status.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(botsDir, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadDeployments(): any[] {
  // Deployments live under groups/<folder>/auto-mode/deployments.json
  const allDeployments: any[] = [];
  try {
    if (!fs.existsSync(GROUPS_DIR)) return [];
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const deploymentsFile = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'deployments.json',
      );
      if (!fs.existsSync(deploymentsFile)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(deploymentsFile, 'utf-8'));
        if (data.deployments) allDeployments.push(...data.deployments);
        if (data.deployments_shadow_ungraduated)
          allDeployments.push(...data.deployments_shadow_ungraduated);
        if (data.deployments_active_untracked)
          allDeployments.push(...data.deployments_active_untracked);
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // ignore
  }
  return allDeployments;
}

function loadCampaigns(): { campaigns: any[]; budget: any | null } {
  // Campaigns live under groups/<folder>/research-planner/campaigns.json (legacy path)
  const allCampaigns: any[] = [];
  let budget: any | null = null;
  try {
    if (!fs.existsSync(GROUPS_DIR)) return { campaigns: [], budget: null };
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const campaignsFile = path.join(
        GROUPS_DIR,
        folder,
        'research-planner',
        'campaigns.json',
      );
      if (!fs.existsSync(campaignsFile)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(campaignsFile, 'utf-8'));
        if (data.campaigns) allCampaigns.push(...data.campaigns);
        if (data.budget && !budget) budget = data.budget;
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // ignore
  }
  return { campaigns: allCampaigns, budget };
}

function loadTriageMatrix(): any[] {
  const allResults: any[] = [];
  try {
    if (!fs.existsSync(GROUPS_DIR)) return [];
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const triageFile = path.join(
        GROUPS_DIR,
        folder,
        'research-planner',
        'triage-matrix.json',
      );
      if (!fs.existsSync(triageFile)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(triageFile, 'utf-8'));
        if (data.results) allResults.push(...data.results);
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // ignore
  }
  return allResults;
}

function loadGroupsFromDb(db: Database): any[] {
  try {
    const rows = db.prepare('SELECT * FROM registered_groups').all() as any[];
    return rows.map((r: any) => ({
      jid: r.jid,
      name: r.name,
      folder: r.folder,
      trigger_pattern: r.trigger_pattern,
      added_at: r.added_at,
      container_config: r.container_config
        ? JSON.parse(r.container_config)
        : {},
      requires_trigger: r.requires_trigger === 1,
      is_main: r.is_main === 1,
    }));
  } catch {
    return [];
  }
}

function loadTasksFromDb(db: Database): any[] {
  try {
    const stmt = db.prepare('SELECT * FROM scheduled_tasks');
    return stmt.all();
  } catch {
    return [];
  }
}

async function fetchEventsIncremental(
  config: SyncConfig,
  cursor: SyncCursor,
): Promise<{ events: any[]; newCursorEventId: string | null }> {
  try {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor.last_event_at) {
      params.set('from', cursor.last_event_at);
    }
    const res = await fetch(`${config.aphexdataUrl}/api/v1/events?${params}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.aphexdataApiKey,
      },
    });
    if (!res.ok) return { events: [], newCursorEventId: cursor.last_event_id };
    const { events } = (await res.json()) as { events: any[] };
    const newEvents = cursor.last_event_id
      ? events.filter((e: any) => e.id !== cursor.last_event_id)
      : events;
    const lastEvent =
      newEvents.length > 0 ? newEvents[newEvents.length - 1] : null;
    return {
      events: newEvents,
      newCursorEventId: lastEvent?.id ?? cursor.last_event_id,
    };
  } catch {
    return { events: [], newCursorEventId: cursor.last_event_id };
  }
}

function loadResearchData(): {
  roster: any[];
  cellGrid: any[];
  missedOpportunities: any[];
} {
  const empty = { roster: [], cellGrid: [], missedOpportunities: [] };
  try {
    if (!fs.existsSync(GROUPS_DIR)) return empty;
    // Read from the first group that has reports (typically whatsapp_main)
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const groupDir = path.join(GROUPS_DIR, folder);

      // Cell grid — read the full 560-cell grid file
      const cellGridFile = path.join(
        groupDir,
        'reports',
        'cell-grid-latest.json',
      );
      const cellGridRaw: any[] = fs.existsSync(cellGridFile)
        ? JSON.parse(fs.readFileSync(cellGridFile, 'utf-8'))
        : [];

      // Gap report — scout's authoritative gap scores
      const gapReportFile = path.join(groupDir, 'reports', 'gap-report.json');
      const gapScoreMap = new Map<string, number>();
      if (fs.existsSync(gapReportFile)) {
        try {
          const gapData = JSON.parse(fs.readFileSync(gapReportFile, 'utf-8'));
          for (const g of gapData.top_gaps ?? []) {
            // gap-report uses short pairs (e.g. "XRP"), cell grid uses full (e.g. "XRP/USDT:USDT")
            const pairFull = g.pair.includes('/')
              ? g.pair
              : `${g.pair}/USDT:USDT`;
            gapScoreMap.set(
              `${g.archetype}:${pairFull}:${g.timeframe}`,
              g.gap_score,
            );
          }
        } catch {
          // ignore parse errors
        }
      }

      // Roster — graduated strategies
      const rosterFile = path.join(groupDir, 'auto-mode', 'roster.json');
      let roster: any[] = [];
      if (fs.existsSync(rosterFile)) {
        const data = JSON.parse(fs.readFileSync(rosterFile, 'utf-8'));
        roster = data.roster ?? (Array.isArray(data) ? data : []);
      }

      // Deployments — for deployed_strategy mapping
      const deploymentsFile = path.join(
        groupDir,
        'auto-mode',
        'deployments.json',
      );
      const deployedMap = new Map<string, string>();
      if (fs.existsSync(deploymentsFile)) {
        try {
          const depData = JSON.parse(fs.readFileSync(deploymentsFile, 'utf-8'));
          for (const d of depData.deployments ?? []) {
            if (!['active', 'shadow', 'throttled'].includes(d.state)) continue;
            for (const pair of d.pairs ?? []) {
              deployedMap.set(
                `${d.archetype}:${pair}:${d.timeframe}`,
                d.strategy,
              );
            }
          }
        } catch {
          // ignore parse errors
        }
      }
      // Also map from roster validated_pairs
      for (const r of roster) {
        for (const pair of r.validated_pairs ?? []) {
          const key = `${r.archetype}:${pair}:${r.timeframe}`;
          if (!deployedMap.has(key)) {
            deployedMap.set(key, r.strategy_name);
          }
        }
      }

      // Trend boost: compare current composites vs previous scoring cycle
      const currentScoredAt = cellGridRaw[0]?.scored_at ?? null;

      if (!compositesInitialized && cellGridRaw.length > 0) {
        const persisted = loadPrevComposites(groupDir);
        prevComposites = persisted.composites;
        prevScoredAt = persisted.scoredAt;
        currentTrendBoosts = persisted.trendBoosts;
        compositesInitialized = true;
      }

      if (
        currentScoredAt &&
        currentScoredAt !== prevScoredAt &&
        cellGridRaw.length > 0
      ) {
        const newTrendBoosts = new Map<string, number>();
        const newComposites = new Map<string, number>();

        for (const c of cellGridRaw) {
          const key = `${c.archetype}:${c.pair}:${c.timeframe}`;
          newComposites.set(key, c.composite ?? 0);
          newTrendBoosts.set(
            key,
            computeTrendBoost(c.composite ?? 0, prevComposites.get(key)),
          );
        }

        const rising = [...newTrendBoosts.values()].filter((v) => v > 0).length;
        const falling = [...newTrendBoosts.values()].filter(
          (v) => v < 0,
        ).length;
        logger.info(
          {
            rising,
            falling,
            flat: newTrendBoosts.size - rising - falling,
          },
          '[console-sync] Trend boost computed for new scoring cycle',
        );

        prevComposites = newComposites;
        prevScoredAt = currentScoredAt;
        currentTrendBoosts = newTrendBoosts;

        savePrevComposites(
          groupDir,
          currentScoredAt,
          newComposites,
          newTrendBoosts,
        );
      }

      // Merge trend_boost, gap_score, deployed_strategy, and scored_at → last_scored.
      // Normalize archetype names and drop garbage rows (strategy tags etc.).
      const cellGrid: any[] = [];
      let normalizedCount = 0;
      let droppedCount = 0;
      for (const c of cellGridRaw) {
        const canonical = normalizeArchetype(c.archetype ?? '');
        if (!canonical) {
          droppedCount++;
          continue;
        }
        if (canonical !== c.archetype) normalizedCount++;
        const key = `${canonical}:${c.pair}:${c.timeframe}`;
        cellGrid.push({
          ...c,
          archetype: canonical,
          last_scored: c.scored_at ?? c.last_scored,
          gap_score:
            gapScoreMap.get(key) ??
            gapScoreMap.get(`${c.archetype}:${c.pair}:${c.timeframe}`) ??
            c.gap_score,
          deployed_strategy:
            deployedMap.get(key) ??
            deployedMap.get(`${c.archetype}:${c.pair}:${c.timeframe}`) ??
            c.deployed_strategy,
          trend_boost:
            currentTrendBoosts.get(key) ??
            currentTrendBoosts.get(`${c.archetype}:${c.pair}:${c.timeframe}`) ??
            0.0,
        });
      }
      if (normalizedCount > 0 || droppedCount > 0) {
        logger.info(
          {
            normalized: normalizedCount,
            dropped: droppedCount,
            total: cellGridRaw.length,
          },
          '[console-sync] Cell grid archetype cleanup',
        );
      }

      // Missed opportunities
      const missedFile = path.join(
        groupDir,
        'auto-mode',
        'missed-opportunities.json',
      );
      const missedOpportunities = fs.existsSync(missedFile)
        ? JSON.parse(fs.readFileSync(missedFile, 'utf-8'))
        : [];

      if (cellGrid.length > 0 || roster.length > 0) {
        return { roster, cellGrid, missedOpportunities };
      }
    }
  } catch {
    // ignore read errors
  }
  return empty;
}

async function fetchAnthropicUsage(config: SyncConfig): Promise<void> {
  const url = `${config.supabaseUrl}/functions/v1/fetch-anthropic-usage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      'X-Sync-Key': config.syncKey,
    },
    body: JSON.stringify({ operator_id: config.operatorId }),
  });
  if (res.ok) {
    const body = (await res.json()) as Record<string, any>;
    logger.info(
      { days: body.days?.length ?? 0 },
      '[console-sync] Usage fetch complete',
    );
  } else {
    logger.warn(`[console-sync] Usage fetch failed: ${res.status}`);
  }
}

async function pushToConsole(
  config: SyncConfig,
  payload: any,
): Promise<boolean> {
  const url = `${config.supabaseUrl}/functions/v1/sync-ingest`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
          'X-Sync-Key': config.syncKey,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok || res.status === 207) {
        return true;
      }
      logger.error(
        `[console-sync] Push failed (${res.status}): ${await res.text()}`,
      );
    } catch (err) {
      logger.error({ err, attempt: attempt + 1 }, `[console-sync] Push error`);
    }

    if (attempt < MAX_RETRIES - 1) {
      const delay = [5000, 15000, 45000][attempt];
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return false;
}

export async function runConsoleSync(
  db: Database,
  dataDir: string,
): Promise<void> {
  const env = readEnvFile(CONSOLE_ENV_KEYS);
  const supabaseUrl = env.CONSOLE_SUPABASE_URL;
  const supabaseAnonKey = env.CONSOLE_SUPABASE_ANON_KEY;
  const syncKey = env.CONSOLE_SYNC_KEY;
  const operatorId = env.CONSOLE_OPERATOR_ID;
  const aphexdataUrl = env.APHEXDATA_URL || 'http://localhost:3100';
  const aphexdataApiKey = env.APHEXDATA_API_KEY || '';

  if (!supabaseUrl || !syncKey || !operatorId || !supabaseAnonKey) {
    // Console sync not configured — skip silently
    return;
  }

  const config: SyncConfig = {
    supabaseUrl,
    supabaseAnonKey,
    syncKey,
    operatorId,
    dataDir,
    aphexdataUrl,
    aphexdataApiKey,
  };
  const cursor = loadCursor(dataDir);

  // Collect local data
  const bots = loadBotStatuses(dataDir);
  const deployments = loadDeployments();
  const { campaigns, budget: campaignBudget } = loadCampaigns();
  const triageMatrix = loadTriageMatrix();
  const groups = loadGroupsFromDb(db);
  const tasks = loadTasksFromDb(db);

  // Fetch from aphexDATA (incremental for events)
  const { events, newCursorEventId } = await fetchEventsIncremental(
    config,
    cursor,
  );
  const research = loadResearchData();

  // Build payload
  const payload = {
    health: {
      nanoclaw_pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      container_count: bots.filter((b: any) => b.status === 'running').length,
      sync_cursor: { ...cursor, last_event_id: newCursorEventId },
    },
    bots,
    groups,
    tasks,
    deployments,
    events,
    roster: research.roster,
    campaigns,
    campaign_budget: campaignBudget,
    cell_grid: research.cellGrid,
    missed_opportunities: research.missedOpportunities,
    triage_matrix: triageMatrix,
  };

  const success = await pushToConsole(config, payload);

  if (success) {
    // Only advance cursor after successful push
    saveCursor(dataDir, {
      last_event_id: newCursorEventId,
      last_roster_hash: cursor.last_roster_hash, // TODO: hash comparison
      last_event_at:
        events.length > 0
          ? (events[events.length - 1].occurred_at ??
            events[events.length - 1].recorded_at)
          : cursor.last_event_at,
    });
    logger.info(
      {
        bots: bots.length,
        groups: groups.length,
        tasks: tasks.length,
        deployments: deployments.length,
        events: events.length,
        roster: research.roster.length,
        campaigns: campaigns.length,
        cellGrid: research.cellGrid.length,
        trendBoosted: research.cellGrid.filter((c: any) => c.trend_boost !== 0)
          .length,
        triageMatrix: triageMatrix.length,
      },
      '[console-sync] Push complete',
    );
  } else {
    logger.warn(
      '[console-sync] Push failed after retries — will retry next cycle',
    );
  }

  // Hourly: fetch Anthropic usage data into usage_daily
  syncCycleCount++;
  if (syncCycleCount % USAGE_FETCH_EVERY_N_CYCLES === 0) {
    await fetchAnthropicUsage(config).catch((err) =>
      logger.error({ err }, '[console-sync] Usage fetch error'),
    );
  }
}

/**
 * Start the console sync loop. Call once from nanoclaw's main entry point.
 * Non-blocking — runs in the background via setInterval.
 */
export function startConsoleSync(db: Database, dataDir: string): void {
  const env = readEnvFile(CONSOLE_ENV_KEYS);
  if (!env.CONSOLE_SUPABASE_URL) {
    logger.info('[console-sync] CONSOLE_SUPABASE_URL not set — sync disabled');
    return;
  }

  logger.info(
    { url: env.CONSOLE_SUPABASE_URL, operatorId: env.CONSOLE_OPERATOR_ID },
    '[console-sync] Starting sync loop (60s interval)',
  );

  // Run immediately, then every 60s
  runConsoleSync(db, dataDir).catch((err) =>
    logger.error({ err }, '[console-sync] Initial sync error'),
  );

  setInterval(() => {
    runConsoleSync(db, dataDir).catch((err) =>
      logger.error({ err }, '[console-sync] Sync error'),
    );
  }, SYNC_INTERVAL_MS);
}

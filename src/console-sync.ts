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

const SYNC_INTERVAL_MS = 60_000;
const MAX_RETRIES = 3;
const CURSOR_FILE = 'data/console-sync/cursor.json';

interface SyncCursor {
  last_event_id: string | null;
  last_roster_hash: string | null;
  last_event_at: string | null;
}

interface SyncConfig {
  supabaseUrl: string;
  syncKey: string;
  operatorId: string;
  dataDir: string;
  aphexdataUrl: string;
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

function loadBotStatuses(dataDir: string): any[] {
  const botsDir = path.join(dataDir, 'data/bot-runner/bots');
  if (!fs.existsSync(botsDir)) return [];
  return fs.readdirSync(botsDir)
    .filter(f => f.endsWith('.status.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(botsDir, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadDeployments(dataDir: string): any[] {
  const deploymentsFile = path.join(dataDir, 'data/auto-mode/deployments.json');
  if (!fs.existsSync(deploymentsFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(deploymentsFile, 'utf-8'));
    return data.deployments || [];
  } catch {
    return [];
  }
}

function loadGroupsFromDb(db: Database): any[] {
  try {
    const stmt = db.prepare('SELECT * FROM chats WHERE registered = 1');
    return stmt.all();
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
  aphexdataUrl: string,
  cursor: SyncCursor,
): Promise<{ events: any[]; newCursorEventId: string | null }> {
  try {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor.last_event_at) {
      params.set('from', cursor.last_event_at);
    }
    const res = await fetch(`${aphexdataUrl}/api/v1/events?${params}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return { events: [], newCursorEventId: cursor.last_event_id };
    const { events } = await res.json();
    const newEvents = cursor.last_event_id
      ? events.filter((e: any) => e.id !== cursor.last_event_id)
      : events;
    const lastEvent = newEvents.length > 0 ? newEvents[newEvents.length - 1] : null;
    return {
      events: newEvents,
      newCursorEventId: lastEvent?.id ?? cursor.last_event_id,
    };
  } catch {
    return { events: [], newCursorEventId: cursor.last_event_id };
  }
}

async function fetchResearchData(aphexdataUrl: string): Promise<{
  roster: any[];
  campaigns: any[];
  cellGrid: any[];
  missedOpportunities: any[];
}> {
  try {
    const res = await fetch(`${aphexdataUrl}/api/v1/research`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return { roster: [], campaigns: [], cellGrid: [], missedOpportunities: [] };
    const data = await res.json();
    return {
      roster: data.roster ?? data.leaderboard ?? [],
      campaigns: data.campaigns ?? [],
      cellGrid: data.cell_grid ?? data.cellGrid ?? [],
      missedOpportunities: data.missed_opportunities ?? [],
    };
  } catch {
    return { roster: [], campaigns: [], cellGrid: [], missedOpportunities: [] };
  }
}

async function pushToConsole(config: SyncConfig, payload: any): Promise<boolean> {
  const url = `${config.supabaseUrl}/functions/v1/sync-ingest`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sync-Key': config.syncKey,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok || res.status === 207) {
        return true;
      }
      console.error(`[console-sync] Push failed (${res.status}): ${await res.text()}`);
    } catch (err) {
      console.error(`[console-sync] Push error (attempt ${attempt + 1}/${MAX_RETRIES}):`, err);
    }

    if (attempt < MAX_RETRIES - 1) {
      const delay = [5000, 15000, 45000][attempt];
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return false;
}

export async function runConsoleSync(
  db: Database,
  dataDir: string,
): Promise<void> {
  const supabaseUrl = process.env.CONSOLE_SUPABASE_URL;
  const syncKey = process.env.CONSOLE_SYNC_KEY;
  const operatorId = process.env.CONSOLE_OPERATOR_ID;
  const aphexdataUrl = process.env.APHEXDATA_URL || 'http://localhost:3100';

  if (!supabaseUrl || !syncKey || !operatorId) {
    // Console sync not configured — skip silently
    return;
  }

  const config: SyncConfig = { supabaseUrl, syncKey, operatorId, dataDir, aphexdataUrl };
  const cursor = loadCursor(dataDir);

  // Collect local data
  const bots = loadBotStatuses(dataDir);
  const deployments = loadDeployments(dataDir);
  const groups = loadGroupsFromDb(db);
  const tasks = loadTasksFromDb(db);

  // Fetch from aphexDATA (incremental for events)
  const { events, newCursorEventId } = await fetchEventsIncremental(aphexdataUrl, cursor);
  const research = await fetchResearchData(aphexdataUrl);

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
    campaigns: research.campaigns,
    cell_grid: research.cellGrid,
    missed_opportunities: research.missedOpportunities,
  };

  const success = await pushToConsole(config, payload);

  if (success) {
    // Only advance cursor after successful push
    saveCursor(dataDir, {
      last_event_id: newCursorEventId,
      last_roster_hash: cursor.last_roster_hash, // TODO: hash comparison
      last_event_at: events.length > 0
        ? events[events.length - 1].occurred_at ?? events[events.length - 1].recorded_at
        : cursor.last_event_at,
    });
    console.log(`[console-sync] Pushed ${bots.length} bots, ${events.length} events, ${deployments.length} deployments`);
  } else {
    console.warn('[console-sync] Push failed after retries — will retry next cycle');
  }
}

/**
 * Start the console sync loop. Call once from nanoclaw's main entry point.
 * Non-blocking — runs in the background via setInterval.
 */
export function startConsoleSync(db: Database, dataDir: string): void {
  if (!process.env.CONSOLE_SUPABASE_URL) {
    console.log('[console-sync] CONSOLE_SUPABASE_URL not set — sync disabled');
    return;
  }

  console.log('[console-sync] Starting sync loop (60s interval)');

  // Run immediately, then every 60s
  runConsoleSync(db, dataDir).catch(err =>
    console.error('[console-sync] Initial sync error:', err)
  );

  setInterval(() => {
    runConsoleSync(db, dataDir).catch(err =>
      console.error('[console-sync] Sync error:', err)
    );
  }, SYNC_INTERVAL_MS);
}

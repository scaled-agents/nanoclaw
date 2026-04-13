/**
 * TV Inbox Poller
 *
 * Polls the Supabase tv_signal_inbox table for pending TradingView signals
 * that were received by the edge function. When found, writes them to the
 * agent's local tv-inbox directory and notifies the main group.
 *
 * This replaces the need for a tunnel or public IP — TradingView POSTs to
 * Supabase (public HTTPS), and NanoClaw polls from behind NAT (outbound only).
 *
 * Environment variables (from .env):
 *   CONSOLE_SUPABASE_URL       — Supabase project URL
 *   CONSOLE_SUPABASE_ANON_KEY  — Supabase anon key
 *   CONSOLE_OPERATOR_ID        — operator UUID
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const POLL_INTERVAL_MS = 5_000; // 5 seconds
const BATCH_SIZE = 10;

const ENV_KEYS = [
  'CONSOLE_SUPABASE_URL',
  'CONSOLE_SUPABASE_ANON_KEY',
  'CONSOLE_OPERATOR_ID',
];

export interface TvInboxPollerDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface InboxSignal {
  id: string;
  signal_id: string;
  source_id: string;
  raw_payload: Record<string, unknown>;
  received_at: string;
}

function findMainGroup(
  groups: Record<string, RegisteredGroup>,
): { jid: string; folder: string } | null {
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) return { jid, folder: group.folder };
  }
  return null;
}

function writeSignalToLocalInbox(
  groupFolder: string,
  signal: InboxSignal,
): void {
  const inboxDir = path.join(GROUPS_DIR, groupFolder, 'auto-mode', 'tv-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(inboxDir, `${signal.signal_id}.json`),
    JSON.stringify(
      {
        signal_id: signal.signal_id,
        source_id: signal.source_id,
        received_at: signal.received_at,
        raw_payload: signal.raw_payload,
      },
      null,
      2,
    ),
  );
}

function summarizeSignal(payload: Record<string, unknown>): string {
  const pair =
    (payload.ticker as string) ||
    (payload.symbol as string) ||
    (payload.pair as string) ||
    '?';
  const action =
    (payload.action as string) ||
    (payload.side as string) ||
    ((
      (payload.strategy as Record<string, unknown>)?.order as Record<
        string,
        unknown
      >
    )?.action as string) ||
    '?';
  const price =
    (payload.close as number) ||
    (payload.price as number) ||
    (payload.entry_price as number) ||
    null;
  return `${pair} ${action}${price ? ` @ ${price}` : ''}`;
}

async function pollInbox(
  deps: TvInboxPollerDeps,
  supabaseUrl: string,
  supabaseAnonKey: string,
  operatorId: string,
): Promise<void> {
  try {
    // Query pending signals via PostgREST
    const url = `${supabaseUrl}/rest/v1/tv_signal_inbox?` +
      `operator_id=eq.${operatorId}&status=eq.pending&order=received_at.asc&limit=${BATCH_SIZE}`;

    const res = await fetch(url, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status !== 406) {
        // 406 = no rows, expected
        logger.debug(
          { status: res.status },
          '[tv-inbox-poller] Fetch failed',
        );
      }
      return;
    }

    const signals = (await res.json()) as InboxSignal[];
    if (!signals || signals.length === 0) return;

    const groups = deps.registeredGroups();
    const main = findMainGroup(groups);
    if (!main) {
      logger.warn('[tv-inbox-poller] No main group registered, skipping');
      return;
    }

    logger.info(
      { count: signals.length },
      '[tv-inbox-poller] Found pending signals',
    );

    for (const signal of signals) {
      // Write to local inbox
      writeSignalToLocalInbox(main.folder, signal);

      // Mark as picked_up in Supabase
      const updateUrl = `${supabaseUrl}/rest/v1/tv_signal_inbox?id=eq.${signal.id}`;
      await fetch(updateUrl, {
        method: 'PATCH',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          status: 'picked_up',
          picked_up_at: new Date().toISOString(),
        }),
      });

      // Notify main group
      const summary = summarizeSignal(signal.raw_payload);
      const text = `[TV Signal] ${summary} from "${signal.source_id}" (${signal.signal_id})\nProcess via tv-signals skill.`;
      deps.sendMessage(main.jid, text).catch((err) => {
        logger.error(
          { err, signalId: signal.signal_id },
          '[tv-inbox-poller] Failed to notify main group',
        );
      });

      logger.info(
        { signalId: signal.signal_id, sourceId: signal.source_id },
        '[tv-inbox-poller] Signal written to local inbox',
      );
    }
  } catch (err) {
    logger.error({ err }, '[tv-inbox-poller] Poll error');
  }
}

/**
 * Start the TV inbox poller. Call once from nanoclaw's main entry point.
 * Non-blocking — runs in the background via setInterval.
 */
export function startTvInboxPoller(deps: TvInboxPollerDeps): void {
  const env = readEnvFile(ENV_KEYS);
  const supabaseUrl = env.CONSOLE_SUPABASE_URL;
  const supabaseAnonKey = env.CONSOLE_SUPABASE_ANON_KEY;
  const operatorId = env.CONSOLE_OPERATOR_ID;

  if (!supabaseUrl || !supabaseAnonKey || !operatorId) {
    logger.info(
      '[tv-inbox-poller] Supabase not configured — TV inbox polling disabled',
    );
    return;
  }

  logger.info(
    { interval: POLL_INTERVAL_MS },
    '[tv-inbox-poller] Starting poll loop',
  );

  // Poll immediately, then every 5s
  pollInbox(deps, supabaseUrl, supabaseAnonKey, operatorId).catch((err) =>
    logger.error({ err }, '[tv-inbox-poller] Initial poll error'),
  );

  setInterval(() => {
    pollInbox(deps, supabaseUrl, supabaseAnonKey, operatorId).catch((err) =>
      logger.error({ err }, '[tv-inbox-poller] Poll error'),
    );
  }, POLL_INTERVAL_MS);
}

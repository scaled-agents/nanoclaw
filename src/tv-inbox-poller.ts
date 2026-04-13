/**
 * TV Inbox Poller
 *
 * Polls the Supabase tv-inbox-poll edge function for pending TradingView
 * signals that were received by the tv-webhook edge function. When found,
 * writes them to the agent's local tv-inbox directory and injects a system
 * message into the main group's message queue so the agent processes it.
 *
 * This replaces the need for a tunnel or public IP — TradingView POSTs to
 * Supabase (public HTTPS), and NanoClaw polls from behind NAT (outbound only).
 *
 * Environment variables (from .env):
 *   CONSOLE_SUPABASE_URL       — Supabase project URL
 *   CONSOLE_SUPABASE_ANON_KEY  — Supabase anon key
 *   CONSOLE_SYNC_KEY           — operator sync key for edge function auth
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const POLL_INTERVAL_MS = 5_000; // 5 seconds

const ENV_KEYS = [
  'CONSOLE_SUPABASE_URL',
  'CONSOLE_SUPABASE_ANON_KEY',
  'CONSOLE_SYNC_KEY',
];

export interface TvInboxPollerDeps {
  /**
   * Inject a message directly into the DB as a non-bot system message.
   * Unlike sendMessage (which goes via WhatsApp and gets flagged is_bot_message=true
   * then filtered out by getMessagesSince), this stores the message so the agent
   * actually sees it in the next poll cycle.
   */
  injectSystemMessage: (jid: string, text: string) => void;
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
  syncKey: string,
): Promise<void> {
  try {
    // Poll via edge function (bypasses RLS using sync key auth)
    const pollUrl = `${supabaseUrl}/functions/v1/tv-inbox-poll`;
    const res = await fetch(pollUrl, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json',
        'X-Sync-Key': syncKey,
      },
      body: JSON.stringify({ action: 'poll' }),
    });

    if (!res.ok) {
      // Don't log for every 5s tick when there's nothing
      if (res.status !== 200) {
        logger.debug(
          { status: res.status },
          '[tv-inbox-poller] Poll request failed',
        );
      }
      return;
    }

    const data = (await res.json()) as { signals: InboxSignal[] };
    const signals = data.signals;
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

    const ackIds: string[] = [];

    for (const signal of signals) {
      // Write to local inbox
      writeSignalToLocalInbox(main.folder, signal);
      ackIds.push(signal.id);

      // Inject system message into DB (NOT via WhatsApp sendMessage which
      // marks it is_bot_message=true and gets filtered by getMessagesSince).
      const summary = summarizeSignal(signal.raw_payload);
      const text = `[TV Signal] ${summary} from "${signal.source_id}" (${signal.signal_id})\nInbound signal waiting in auto-mode/tv-inbox/${signal.signal_id}.json — process it now using the tv-signals skill (read the inbox file, normalize, run signal rules, execute if validated).`;
      deps.injectSystemMessage(main.jid, text);

      logger.info(
        { signalId: signal.signal_id, sourceId: signal.source_id },
        '[tv-inbox-poller] Signal written to local inbox + system message injected',
      );
    }

    // Acknowledge all signals in a single call
    if (ackIds.length > 0) {
      await fetch(pollUrl, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json',
          'X-Sync-Key': syncKey,
        },
        body: JSON.stringify({ action: 'ack', signal_ids: ackIds }),
      });
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
  const syncKey = env.CONSOLE_SYNC_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !syncKey) {
    logger.info(
      '[tv-inbox-poller] Supabase or sync key not configured — TV inbox polling disabled',
    );
    return;
  }

  logger.info(
    { interval: POLL_INTERVAL_MS },
    '[tv-inbox-poller] Starting poll loop',
  );

  // Poll immediately, then every 5s
  pollInbox(deps, supabaseUrl, supabaseAnonKey, syncKey).catch((err) =>
    logger.error({ err }, '[tv-inbox-poller] Initial poll error'),
  );

  setInterval(() => {
    pollInbox(deps, supabaseUrl, supabaseAnonKey, syncKey).catch((err) =>
      logger.error({ err }, '[tv-inbox-poller] Poll error'),
    );
  }, POLL_INTERVAL_MS);
}

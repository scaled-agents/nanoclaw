/**
 * Inbound TradingView Webhook Server.
 *
 * Receives TV alerts, validates against registered sources in tv-signals.json,
 * writes the payload to the agent's TV inbox for processing, and sends a
 * notification to the main group chat. The agent picks up the inbox file on
 * its next wake-up and runs the tv-signals skill workflow.
 *
 * Runs on a dedicated port (TV_WEBHOOK_PORT, default 3200).
 */

import crypto from 'crypto';
import { createServer, Server } from 'http';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// ─── Configuration ──────────────────────────────────────────────────

const tvEnv = readEnvFile(['TV_WEBHOOK_SECRET', 'TV_WEBHOOK_PORT']);

const WEBHOOK_PORT = parseInt(
  process.env.TV_WEBHOOK_PORT || tvEnv.TV_WEBHOOK_PORT || '3200',
  10,
);
const GLOBAL_SECRET =
  process.env.TV_WEBHOOK_SECRET || tvEnv.TV_WEBHOOK_SECRET || '';

// ─── Types ──────────────────────────────────────────────────────────

interface TvSource {
  source_id: string;
  name: string;
  secret_hash: string;
  status: string;
  allowed_pairs: string[];
  signal_rules: string[];
  stake_pct: number;
  stats: {
    signals_received: number;
    signals_validated: number;
    signals_rejected: number;
    last_signal_at: string | null;
  };
}

export interface TvWebhookDeps {
  injectSystemMessage: (jid: string, text: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// ─── Helpers ────────────────────────────────────────────────────────

function findMainGroup(
  groups: Record<string, RegisteredGroup>,
): { jid: string; folder: string } | null {
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) return { jid, folder: group.folder };
  }
  return null;
}

function loadTvSources(groupFolder: string): TvSource[] {
  const filePath = path.join(
    GROUPS_DIR,
    groupFolder,
    'auto-mode',
    'tv-signals.json',
  );
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(data) ? data : data.sources || [];
  } catch {
    return [];
  }
}

function verifySecret(
  payload: Record<string, unknown>,
  source: TvSource,
): boolean {
  const payloadSecret =
    (payload.secret as string) || (payload.key as string) || '';
  const hash = crypto.createHash('sha256').update(payloadSecret).digest('hex');
  return hash === source.secret_hash;
}

function verifyGlobalSecret(payload: Record<string, unknown>): boolean {
  if (!GLOBAL_SECRET) return false;
  const payloadSecret =
    (payload.secret as string) || (payload.key as string) || '';
  return payloadSecret === GLOBAL_SECRET;
}

function writeSignalToInbox(
  groupFolder: string,
  signalId: string,
  sourceId: string,
  payload: Record<string, unknown>,
): void {
  const inboxDir = path.join(GROUPS_DIR, groupFolder, 'auto-mode', 'tv-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(inboxDir, `${signalId}.json`),
    JSON.stringify(
      {
        signal_id: signalId,
        source_id: sourceId,
        received_at: new Date().toISOString(),
        raw_payload: payload,
      },
      null,
      2,
    ),
  );
}

function generateSignalId(): string {
  return `tvs_${crypto.randomBytes(4).toString('hex')}`;
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

// ─── HTTP Handler ───────────────────────────────────────────────────

function handleWebhook(
  deps: TvWebhookDeps,
  reqUrl: string,
  body: Buffer,
  respond: (status: number, data: object) => void,
): void {
  // Parse URL: /api/webhooks/tv/:sourceId
  const match = reqUrl.match(/^\/api\/webhooks\/tv\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    respond(404, { error: 'Not found' });
    return;
  }

  const sourceId = match[1];
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString('utf-8'));
  } catch {
    respond(400, { error: 'Invalid JSON' });
    return;
  }

  const groups = deps.registeredGroups();
  const main = findMainGroup(groups);
  if (!main) {
    logger.warn('TV webhook: no main group registered');
    respond(503, { error: 'Service not ready' });
    return;
  }

  // Load registered TV sources
  const sources = loadTvSources(main.folder);
  const source = sources.find((s) => s.source_id === sourceId);

  // If source exists, use per-source secret hash verification
  // Otherwise fall back to global secret verification
  if (source) {
    if (source.status !== 'active') {
      logger.warn({ sourceId }, 'TV webhook: source not active');
      respond(403, { error: 'Source not active' });
      return;
    }

    if (!verifySecret(payload, source)) {
      logger.warn({ sourceId }, 'TV webhook: invalid secret');
      respond(401, { error: 'Invalid secret' });
      return;
    }
  } else {
    // No registered source — verify against global secret as fallback
    if (!verifyGlobalSecret(payload)) {
      logger.warn(
        { sourceId },
        'TV webhook: unknown source, bad global secret',
      );
      respond(401, { error: 'Unknown source_id or invalid secret' });
      return;
    }
  }

  // Generate signal ID and acknowledge immediately
  const signalId = generateSignalId();
  respond(200, { received: true, signal_id: signalId });

  // Write signal to inbox (async — already acknowledged)
  try {
    writeSignalToInbox(main.folder, signalId, sourceId, payload);
    logger.info({ signalId, sourceId }, 'TV signal written to inbox');
  } catch (err) {
    logger.error(
      { err, signalId, sourceId },
      'Failed to write TV signal to inbox',
    );
    return;
  }

  // Notify main group via DB-direct injection so the agent sees it.
  // sendMessage goes via WhatsApp which marks it is_bot_message=true and
  // causes getMessagesSince to filter it out — the agent never wakes up.
  const summary = summarizeSignal(payload);
  const text = `[TV Signal] ${summary} from "${sourceId}" (${signalId})\nInbound signal waiting in auto-mode/tv-inbox/${signalId}.json — process it now using the tv-signals skill (read the inbox file, normalize, run signal rules, execute if validated).`;
  try {
    deps.injectSystemMessage(main.jid, text);
  } catch (err) {
    logger.error({ err, signalId }, 'Failed to inject system message for TV signal');
  }
}

// ─── Server ─────────────────────────────────────────────────────────

export function startTvWebhook(deps: TvWebhookDeps): Server | null {
  if (!GLOBAL_SECRET) {
    logger.info('TV webhook server disabled (TV_WEBHOOK_SECRET not set)');
    return null;
  }

  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      handleWebhook(deps, req.url || '/', body, (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
    });
  });

  server.listen(WEBHOOK_PORT, '0.0.0.0', () => {
    logger.info({ port: WEBHOOK_PORT }, 'TV webhook server started');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'TV webhook server error');
  });

  return server;
}

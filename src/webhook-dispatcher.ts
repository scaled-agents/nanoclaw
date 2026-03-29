/**
 * Webhook Dispatcher — Outbound signal delivery engine.
 *
 * Reads webhook config from data/bot-runner/webhooks.json, builds payloads,
 * signs with HMAC-SHA256, delivers with retries, tracks stats, logs deliveries.
 * No cloud dependency — everything is local.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ─── Paths ──────────────────────────────────────────────────────────

const BOT_RUNNER_DIR = path.join(DATA_DIR, 'bot-runner');
const WEBHOOKS_FILE = path.join(BOT_RUNNER_DIR, 'webhooks.json');
const WEBHOOK_LOG_FILE = path.join(BOT_RUNNER_DIR, 'webhook-log.json');
const MAX_CONSECUTIVE_FAILURES = 10;
const MAX_LOG_ENTRIES = 200;

// ─── Types ──────────────────────────────────────────────────────────

export interface TradeEvent {
  pair: string;
  is_short: boolean;
  is_exit: boolean;
  open_rate: number;
  close_rate?: number;
  profit_pct?: number;
  exit_reason?: string;
  holding_minutes?: number;
}

interface SourceFilter {
  deployment_ids: string[];
  archetypes: string[];
  pairs: string[];
  timeframes: string[];
}

interface EventFilter {
  entry: boolean;
  exit: boolean;
  signal_toggle: boolean;
  lifecycle_change: boolean;
}

interface Transform {
  format: string;
  include_regime_context: boolean;
  include_paper_pnl: boolean;
  include_confidence: boolean;
  include_raw_indicators: boolean;
  custom_fields: Record<string, unknown>;
}

interface Delivery {
  timeout_ms: number;
  retry_count: number;
  retry_delay_ms: number;
  headers: Record<string, string>;
}

interface WebhookStats {
  deliveries_total: number;
  deliveries_ok: number;
  deliveries_failed: number;
  last_delivery_at: string | null;
  last_status_code: number | null;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  consecutive_failures: number;
}

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  secret: string;
  enabled: boolean;
  created_at: string;
  source_filter: SourceFilter;
  event_filter: EventFilter;
  transform: Transform;
  delivery: Delivery;
  stats: WebhookStats;
}

export interface DeliveryResult {
  webhook_id: string;
  event_id: string;
  status: 'ok' | 'failed' | 'timeout' | 'disabled';
  status_code?: number;
  response_body?: string;
  error?: string;
  duration_ms: number;
  attempt: number;
  delivered_at: string;
}

// BotStatusFile shape (matches bot-runner.ts)
interface BotStatusFile {
  deployment_id: string;
  status: string;
  container_name: string;
  api_port: number;
  api_url: string;
  signals_active: boolean;
  strategy: string;
  pair: string;
  timeframe: string;
  dry_run: boolean;
  started_at: string;
  paper_pnl?: {
    profit_pct: number;
    trade_count: number;
    win_rate: number;
    last_updated: string;
  };
}

// ─── Config I/O ─────────────────────────────────────────────────────

function loadWebhooks(): WebhookConfig[] {
  if (!fs.existsSync(WEBHOOKS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8'));
    return data.webhooks || [];
  } catch {
    return [];
  }
}

function saveWebhooks(webhooks: WebhookConfig[]): void {
  const data = { version: 1, webhooks };
  const tmp = WEBHOOKS_FILE + '.tmp';
  fs.mkdirSync(path.dirname(WEBHOOKS_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, WEBHOOKS_FILE);
}

// ─── Signature ──────────────────────────────────────────────────────

function signPayload(payload: string, secret: string): string {
  return (
    'sha256=' +
    crypto.createHmac('sha256', secret).update(payload).digest('hex')
  );
}

// ─── Header substitution ────────────────────────────────────────────

function resolveHeaders(
  headers: Record<string, string>,
  env: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(
      /\{\{(\w+)\}\}/g,
      (_, envVar) => env[envVar] || '',
    );
  }
  return resolved;
}

// ─── Pair format conversion ─────────────────────────────────────────

function convertPair(pair: string, format: string): string {
  const base = pair.split('/')[0];
  switch (format) {
    case 'katoshi':
      return `${base}-USD`;
    case '3commas':
      return `USDT_${base}`;
    default:
      return pair;
  }
}

// ─── Payload building ───────────────────────────────────────────────

function buildPayload(
  webhook: WebhookConfig,
  trade: TradeEvent,
  botStatus: BotStatusFile,
  deployment: any | null,
  marketPrior: any | null,
): object {
  const format = webhook.transform?.format || 'standard';

  if (format === 'katoshi') {
    return buildKatoshiPayload(webhook, trade, botStatus, deployment);
  }

  // Standard format
  const payload: Record<string, unknown> = {
    event_id: `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    event_type: trade.is_exit ? 'signal.exit' : 'signal.entry',
    timestamp: new Date().toISOString(),
    webhook_id: webhook.id,
    signal: {
      direction: trade.is_short ? 'short' : 'long',
      pair: trade.pair,
      exchange: 'binance',
      timeframe: botStatus.timeframe,
      strategy: botStatus.strategy,
      ...(trade.is_exit
        ? {
            exit_price: trade.close_rate,
            profit_pct: trade.profit_pct,
            exit_reason: trade.exit_reason,
            holding_duration_minutes: trade.holding_minutes,
          }
        : {
            entry_price: trade.open_rate,
          }),
    },
    source: {
      agent: 'wolf',
      deployment_id: botStatus.deployment_id,
      bot_container: botStatus.container_name,
      dry_run: botStatus.dry_run,
    },
  };

  if (webhook.transform?.include_regime_context && marketPrior) {
    const pairBase = trade.pair.split('/')[0];
    const regimeData = marketPrior.regimes?.[pairBase]?.['H2_SHORT'];
    payload.context = {
      regime: regimeData?.regime || deployment?.last_regime || 'UNKNOWN',
      conviction: regimeData?.conviction || deployment?.last_conviction || 0,
      composite_score: deployment?.last_composite || 0,
      direction: regimeData?.direction || 'NEUTRAL',
      archetype: deployment?.archetype || 'UNKNOWN',
    };
  }

  if (webhook.transform?.include_paper_pnl && botStatus.paper_pnl) {
    payload.performance = {
      paper_profit_pct: botStatus.paper_pnl.profit_pct,
      paper_trade_count: botStatus.paper_pnl.trade_count,
      paper_win_rate: botStatus.paper_pnl.win_rate,
      paper_max_dd_pct: deployment?.max_dd_since_deploy || 0,
      wf_sharpe: deployment?.wfo_sharpe || null,
      wf_sortino: deployment?.wfo_sortino || null,
    };
  }

  if (webhook.transform?.custom_fields) {
    Object.assign(payload, webhook.transform.custom_fields);
  }

  return payload;
}

function buildKatoshiPayload(
  _webhook: WebhookConfig,
  trade: TradeEvent,
  botStatus: BotStatusFile,
  deployment: any | null,
): object {
  let action: string;
  if (!trade.is_exit) {
    action = trade.is_short ? 'open_short' : 'open_long';
  } else {
    action = trade.is_short ? 'close_short' : 'close_long';
  }

  return {
    action,
    symbol: convertPair(trade.pair, 'katoshi'),
    price: trade.is_exit ? trade.close_rate : trade.open_rate,
    metadata: {
      source: 'scaled-agents',
      strategy: botStatus.strategy,
      regime: deployment?.last_regime || 'UNKNOWN',
      conviction: deployment?.last_conviction || 0,
    },
  };
}

// ─── Delivery ───────────────────────────────────────────────────────

async function deliverWebhook(
  webhook: WebhookConfig,
  payload: object,
  env: Record<string, string>,
): Promise<DeliveryResult> {
  const eventId =
    (payload as any).event_id ||
    `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const bodyStr = JSON.stringify(payload);
  const signature = signPayload(bodyStr, webhook.secret);
  const customHeaders = resolveHeaders(webhook.delivery?.headers || {}, env);

  const maxAttempts = (webhook.delivery?.retry_count ?? 3) + 1;
  const retryDelay = webhook.delivery?.retry_delay_ms || 5000;
  const timeout = webhook.delivery?.timeout_ms || 10000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': webhook.id,
          'X-Webhook-Signature': signature,
          'X-Event-Id': eventId,
          'X-Timestamp': new Date().toISOString(),
          'User-Agent': 'ScaledAgents-Webhook/1.0',
          ...customHeaders,
        },
        body: bodyStr,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const duration = Date.now() - start;
      const responseBody = await response.text().catch(() => '');

      if (response.ok) {
        return {
          webhook_id: webhook.id,
          event_id: eventId,
          status: 'ok',
          status_code: response.status,
          response_body: responseBody.slice(0, 500),
          duration_ms: duration,
          attempt,
          delivered_at: new Date().toISOString(),
        };
      }

      // Non-2xx — retry if attempts remain
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
        continue;
      }

      return {
        webhook_id: webhook.id,
        event_id: eventId,
        status: 'failed',
        status_code: response.status,
        response_body: responseBody.slice(0, 500),
        error: `HTTP ${response.status}: ${responseBody.slice(0, 200)}`,
        duration_ms: duration,
        attempt,
        delivered_at: new Date().toISOString(),
      };
    } catch (err: any) {
      const duration = Date.now() - start;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
        continue;
      }
      return {
        webhook_id: webhook.id,
        event_id: eventId,
        status: err.name === 'AbortError' ? 'timeout' : 'failed',
        error: err.message,
        duration_ms: duration,
        attempt,
        delivered_at: new Date().toISOString(),
      };
    }
  }

  return {
    webhook_id: webhook.id,
    event_id: eventId,
    status: 'failed',
    error: 'Exhausted all retry attempts',
    duration_ms: 0,
    attempt: maxAttempts,
    delivered_at: new Date().toISOString(),
  };
}

// ─── Main dispatch (called by bot-runner) ────────────────────────────

export async function dispatchSignal(
  trade: TradeEvent,
  botStatus: BotStatusFile,
  deployment: any | null,
  marketPrior: any | null,
  env: Record<string, string>,
): Promise<DeliveryResult[]> {
  const webhooks = loadWebhooks();
  const results: DeliveryResult[] = [];

  for (const webhook of webhooks) {
    // Skip disabled webhooks
    if (!webhook.enabled) continue;

    // Skip auto-disabled (too many failures)
    if (webhook.stats.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
      continue;
    }

    // Check source filter — empty arrays match all
    if (
      webhook.source_filter.deployment_ids.length > 0 &&
      !webhook.source_filter.deployment_ids.includes(botStatus.deployment_id)
    ) {
      continue;
    }
    if (
      webhook.source_filter.pairs.length > 0 &&
      !webhook.source_filter.pairs.includes(trade.pair)
    ) {
      continue;
    }

    // Check event filter
    if (!trade.is_exit && !webhook.event_filter.entry) continue;
    if (trade.is_exit && !webhook.event_filter.exit) continue;

    // Build payload
    const payload = buildPayload(
      webhook,
      trade,
      botStatus,
      deployment,
      marketPrior,
    );

    // Deliver
    const result = await deliverWebhook(webhook, payload, env);
    results.push(result);

    // Update webhook stats
    webhook.stats.deliveries_total++;
    webhook.stats.last_delivery_at = result.delivered_at;
    webhook.stats.last_status_code = result.status_code || null;

    if (result.status === 'ok') {
      webhook.stats.deliveries_ok++;
      webhook.stats.consecutive_failures = 0;
    } else {
      webhook.stats.deliveries_failed++;
      webhook.stats.consecutive_failures++;
      webhook.stats.last_failure_at = result.delivered_at;
      webhook.stats.last_failure_reason = result.error || null;

      // Auto-disable after too many failures
      if (webhook.stats.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
        webhook.enabled = false;
      }
    }
  }

  // Save updated stats
  if (results.length > 0) {
    saveWebhooks(webhooks);
    appendToLog(results);
  }

  return results;
}

// ─── Delivery log ───────────────────────────────────────────────────

function appendToLog(results: DeliveryResult[]): void {
  let log: DeliveryResult[] = [];
  if (fs.existsSync(WEBHOOK_LOG_FILE)) {
    try {
      log = JSON.parse(fs.readFileSync(WEBHOOK_LOG_FILE, 'utf8'));
    } catch {
      log = [];
    }
  }
  log.unshift(...results);
  log = log.slice(0, MAX_LOG_ENTRIES);
  const tmp = WEBHOOK_LOG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
  fs.renameSync(tmp, WEBHOOK_LOG_FILE);
}

// ─── Webhook CRUD (called by MCP tools via IPC) ─────────────────────

export function createWebhook(config: Partial<WebhookConfig>): WebhookConfig {
  const webhooks = loadWebhooks();
  const id = `wh_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;

  const webhook: WebhookConfig = {
    id,
    name: config.name || 'Unnamed webhook',
    url: config.url!,
    secret,
    enabled: true,
    created_at: new Date().toISOString(),
    source_filter: config.source_filter || {
      deployment_ids: [],
      archetypes: [],
      pairs: [],
      timeframes: [],
    },
    event_filter: config.event_filter || {
      entry: true,
      exit: true,
      signal_toggle: false,
      lifecycle_change: false,
    },
    transform: config.transform || {
      format: 'standard',
      include_regime_context: true,
      include_paper_pnl: true,
      include_confidence: true,
      include_raw_indicators: false,
      custom_fields: {},
    },
    delivery: config.delivery || {
      timeout_ms: 10000,
      retry_count: 3,
      retry_delay_ms: 5000,
      headers: {},
    },
    stats: {
      deliveries_total: 0,
      deliveries_ok: 0,
      deliveries_failed: 0,
      last_delivery_at: null,
      last_status_code: null,
      last_failure_at: null,
      last_failure_reason: null,
      consecutive_failures: 0,
    },
  };

  webhooks.push(webhook);
  saveWebhooks(webhooks);
  return webhook;
}

export function deleteWebhook(webhookId: string): boolean {
  const webhooks = loadWebhooks();
  const idx = webhooks.findIndex((w) => w.id === webhookId);
  if (idx === -1) return false;
  webhooks.splice(idx, 1);
  saveWebhooks(webhooks);
  return true;
}

export function updateWebhook(
  webhookId: string,
  updates: Partial<WebhookConfig>,
): WebhookConfig | null {
  const webhooks = loadWebhooks();
  const webhook = webhooks.find((w) => w.id === webhookId);
  if (!webhook) return null;
  Object.assign(webhook, updates);
  saveWebhooks(webhooks);
  return webhook;
}

export async function testWebhook(
  webhookId: string,
  env: Record<string, string>,
): Promise<DeliveryResult> {
  const webhooks = loadWebhooks();
  const webhook = webhooks.find((w) => w.id === webhookId);
  if (!webhook) throw new Error('Webhook not found');

  const testPayload = {
    event_id: `test_${Date.now()}`,
    event_type: 'webhook.test',
    timestamp: new Date().toISOString(),
    webhook_id: webhook.id,
    message:
      'This is a test delivery from Scaled Agents. If you receive this, your webhook is configured correctly.',
    signal: {
      direction: 'long',
      pair: 'BTC/USDT:USDT',
      exchange: 'binance',
      timeframe: '1h',
      strategy: 'TEST_STRATEGY',
      entry_price: 87000.0,
    },
    source: {
      agent: 'wolf',
      deployment_id: 'test',
      bot_container: 'test',
      dry_run: true,
    },
  };

  return deliverWebhook(webhook, testPayload, env);
}

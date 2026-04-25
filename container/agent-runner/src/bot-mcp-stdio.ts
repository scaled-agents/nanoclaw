/**
 * Stdio MCP Server for NanoClaw Bot Runner Integration
 *
 * Provides 8 tools for managing FreqTrade paper trading bots:
 *   bot_start          — request a new FreqTrade dry-run container
 *   bot_stop           — request container removal
 *   bot_toggle_signals — enable/disable trading signals
 *   bot_status         — read status of a specific bot
 *   bot_list           — list all managed bots
 *   bot_profit         — read paper P&L
 *   bot_trades         — read recent trade history
 *   bot_place_trade    — force-execute a trade via /forcebuy
 *
 * Communication: writes .request.json files to a shared mount directory,
 * reads .status.json files written by the host-side bot-runner.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const BOT_RUNNER_DIR =
  process.env.BOT_RUNNER_DIR || '/workspace/extra/bot-runner';
const REQUEST_DIR = path.join(BOT_RUNNER_DIR, 'requests');
const BOTS_DIR = path.join(BOT_RUNNER_DIR, 'bots');

function log(message: string): void {
  console.error(`[BOT] ${message}`);
}

function ok(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function generateRequestId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `bot_${ts}_${rand}`;
}

/**
 * Write a request file and wait for the host-side bot-runner to process it.
 * Polls for a .status.json response file up to the specified timeout.
 */
async function submitAndWait(
  requestId: string,
  request: Record<string, unknown>,
  timeoutMs: number = 30_000,
): Promise<Record<string, unknown>> {
  const requestPath = path.join(REQUEST_DIR, `${requestId}.request.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
  log(`Request submitted: ${requestId} (${request.type})`);

  // Poll for status
  const statusPath = path.join(REQUEST_DIR, `${requestId}.status.json`);
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      log(`Response received: ${requestId} → ${status.status}`);
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for bot-runner response (${timeoutMs / 1000}s). ` +
      `Is the NanoClaw host process running?`,
  );
}

const server = new McpServer({ name: 'botrunner', version: '1.0.0' });

// ─── Bot Start ──────────────────────────────────────────────────────

server.tool(
  'bot_start',
  'Start a FreqTrade dry-run bot container for a deployment. The bot starts with signals OFF (initial_state=stopped). Use bot_toggle_signals to enable trading. Returns the container name and API port.',
  {
    deployment_id: z
      .string()
      .describe('Deployment ID (e.g. "keltner-eth-1h")'),
    strategy_name: z
      .string()
      .describe('Strategy class name (e.g. "KeltnerAdxChop")'),
    pair: z
      .string()
      .describe('Trading pair (e.g. "ETH/USDT:USDT")'),
    timeframe: z
      .string()
      .optional()
      .describe('Timeframe (e.g. "1h"). Default: "1h"'),
    group_folder: z
      .string()
      .optional()
      .describe('Group folder name for locating strategy files'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(REQUEST_DIR)) {
        return err(
          'Bot runner request directory not found. Is the bot-runner enabled on the host?',
        );
      }

      const requestId = generateRequestId();
      const result = await submitAndWait(requestId, {
        type: 'start_bot',
        deployment_id: args.deployment_id,
        strategy_name: args.strategy_name,
        pair: args.pair,
        timeframe: args.timeframe || '1h',
        group_folder: args.group_folder,
        dry_run: true,
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return err(`Failed to start bot: ${result.error}`);
      }

      return ok(result);
    } catch (e) {
      return err(`bot_start failed: ${(e as Error).message}`);
    }
  },
);

// ─── Bot Stop ───────────────────────────────────────────────────────

server.tool(
  'bot_stop',
  'Stop and remove a FreqTrade bot container. This is irreversible — the container and its trade state are removed. Use bot_toggle_signals(enable=false) to pause signals without removing the container.',
  {
    deployment_id: z.string().describe('Deployment ID to stop'),
    confirm: z
      .boolean()
      .describe('Must be true to confirm container removal'),
  },
  async (args) => {
    try {
      if (!args.confirm) {
        return err(
          'confirm must be true to stop a bot. This removes the container.',
        );
      }

      if (!fs.existsSync(REQUEST_DIR)) {
        return err('Bot runner request directory not found.');
      }

      const requestId = generateRequestId();
      const result = await submitAndWait(requestId, {
        type: 'stop_bot',
        deployment_id: args.deployment_id,
        confirm: true,
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return err(`Failed to stop bot: ${result.error}`);
      }

      return ok(result);
    } catch (e) {
      return err(`bot_stop failed: ${(e as Error).message}`);
    }
  },
);

// ─── Toggle Signals ─────────────────────────────────────────────────

server.tool(
  'bot_toggle_signals',
  'Enable or disable trading signals on a running FreqTrade bot. When disabled, the bot process stays alive but stops opening new trades (existing positions are managed). When enabled, the bot resumes trading.',
  {
    deployment_id: z.string().describe('Deployment ID'),
    enable: z
      .boolean()
      .describe('true = enable signals (start trading), false = disable'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(REQUEST_DIR)) {
        return err('Bot runner request directory not found.');
      }

      const requestId = generateRequestId();
      const result = await submitAndWait(requestId, {
        type: 'toggle_signals',
        deployment_id: args.deployment_id,
        enable: args.enable,
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return err(`Failed to toggle signals: ${result.error}`);
      }

      return ok(result);
    } catch (e) {
      return err(`bot_toggle_signals failed: ${(e as Error).message}`);
    }
  },
);

// ─── Bot Status ─────────────────────────────────────────────────────

server.tool(
  'bot_status',
  'Read the current status of a specific bot. Returns container status (running/stopped/error), signals state, API port, and paper P&L if available.',
  {
    deployment_id: z.string().describe('Deployment ID to check'),
  },
  async (args) => {
    try {
      // Read directly from status file (no request needed — read-only)
      const statusPath = path.join(
        BOTS_DIR,
        `${args.deployment_id}.status.json`,
      );
      const content = readFile(statusPath);
      if (!content) {
        return err(
          `No bot status found for ${args.deployment_id}. Bot may not be started.`,
        );
      }

      const status = JSON.parse(content);
      log(`Status read: ${args.deployment_id} → ${status.status}`);
      return ok(status);
    } catch (e) {
      return err(`bot_status failed: ${(e as Error).message}`);
    }
  },
);

// ─── Bot List ───────────────────────────────────────────────────────

server.tool(
  'bot_list',
  'List all managed FreqTrade bots with their current status. Returns an array of bot status objects.',
  {},
  async () => {
    try {
      if (!fs.existsSync(BOTS_DIR)) {
        return ok({ bots: [], count: 0 });
      }

      const files = fs
        .readdirSync(BOTS_DIR)
        .filter((f) => f.endsWith('.status.json'));
      const bots = files.map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(BOTS_DIR, f), 'utf-8'));
        } catch {
          return { deployment_id: f.replace('.status.json', ''), status: 'unknown' };
        }
      });

      log(`Listed ${bots.length} bots`);
      return ok({ bots, count: bots.length });
    } catch (e) {
      return err(`bot_list failed: ${(e as Error).message}`);
    }
  },
);

// ─── Bot Profit ─────────────────────────────────────────────────────

server.tool(
  'bot_profit',
  'Read the paper trading P&L for a specific bot. Returns profit percentage, trade count, and win rate. Data is updated by the host-side health check every 60 seconds.',
  {
    deployment_id: z.string().describe('Deployment ID'),
  },
  async (args) => {
    try {
      const statusPath = path.join(
        BOTS_DIR,
        `${args.deployment_id}.status.json`,
      );
      const content = readFile(statusPath);
      if (!content) {
        return err(`No bot status found for ${args.deployment_id}.`);
      }

      const status = JSON.parse(content);
      if (!status.paper_pnl) {
        return ok({
          deployment_id: args.deployment_id,
          status: status.status,
          signals_active: status.signals_active,
          paper_pnl: null,
          message:
            'No paper P&L data yet. Bot may still be starting or has not completed any trades.',
        });
      }

      return ok({
        deployment_id: args.deployment_id,
        status: status.status,
        signals_active: status.signals_active,
        paper_pnl: status.paper_pnl,
      });
    } catch (e) {
      return err(`bot_profit failed: ${(e as Error).message}`);
    }
  },
);

// ─── Bot Trades ─────────────────────────────────────────────────────

server.tool(
  'bot_trades',
  'Read recent trade history from a running bot. Submits a get_status request to the host which queries the bot REST API for open/closed trades.',
  {
    deployment_id: z.string().describe('Deployment ID'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(REQUEST_DIR)) {
        return err('Bot runner request directory not found.');
      }

      const requestId = generateRequestId();
      const result = await submitAndWait(requestId, {
        type: 'get_status',
        deployment_id: args.deployment_id,
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return err(`Failed to get trades: ${result.error}`);
      }

      return ok(result);
    } catch (e) {
      return err(`bot_trades failed: ${(e as Error).message}`);
    }
  },
);

// ─── Place Trade ───────────────────────────────────────────────────

server.tool(
  'bot_place_trade',
  'Place a forced trade on a running FreqTrade bot via the /forcebuy API endpoint. The bot must have force_entry_enable=true in its config. Returns trade details from FreqTrade.',
  {
    deployment_id: z.string().describe('Deployment ID (e.g. "tv-manual")'),
    pair: z.string().describe('Trading pair (e.g. "ETH/USDT:USDT")'),
    side: z.enum(['long', 'short']).describe('Trade direction'),
    stake_amount: z.number().positive().describe('Stake amount in USDT'),
    price: z
      .number()
      .nullable()
      .optional()
      .describe('Limit price (null for market order)'),
    stoploss: z
      .number()
      .nullable()
      .optional()
      .describe('Stop-loss price'),
    takeprofit: z
      .number()
      .nullable()
      .optional()
      .describe('Take-profit price'),
    order_tag: z
      .string()
      .optional()
      .describe('Order tag for attribution (e.g. "tv_source_signalid")'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(REQUEST_DIR)) {
        return err('Bot runner request directory not found.');
      }

      const requestId = generateRequestId();
      const result = await submitAndWait(
        requestId,
        {
          type: 'place_trade',
          deployment_id: args.deployment_id,
          pair: args.pair,
          side: args.side,
          stake_amount: args.stake_amount,
          price: args.price ?? null,
          stoploss: args.stoploss ?? null,
          takeprofit: args.takeprofit ?? null,
          order_tag: args.order_tag,
          submitted_at: new Date().toISOString(),
        },
        15_000,
      );

      if (result.status === 'failed') {
        return err(`Failed to place trade: ${result.error}`);
      }

      return ok(result);
    } catch (e) {
      return err(`bot_place_trade failed: ${(e as Error).message}`);
    }
  },
);

// ─── Server Start ───────────────────────────────────────────────────

async function main() {
  log('Bot Runner MCP server starting...');

  const hasRequestDir = fs.existsSync(REQUEST_DIR);
  const hasBotsDir = fs.existsSync(BOTS_DIR);
  log(
    `Directories: requests=${hasRequestDir}, bots=${hasBotsDir}`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Bot Runner MCP server connected via stdio');
}

main().catch((err) => {
  console.error(`[BOT] Fatal: ${err}`);
  process.exit(1);
});

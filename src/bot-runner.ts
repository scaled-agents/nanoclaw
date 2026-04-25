/**
 * Host-side FreqTrade bot runner.
 *
 * Watches data/bot-runner/requests/ for .request.json files submitted by
 * container agents via bot_* MCP tools. Manages persistent FreqTrade Docker
 * containers (one per deployment) for paper trading.
 *
 * Request types:
 *   start_bot     — generate config, docker run a FreqTrade container
 *   stop_bot      — docker stop + rm the container
 *   toggle_signals — REST API start_bot/stop_bot on a running container
 *   get_status    — read status from running bot's REST API
 *
 * Status files written to data/bot-runner/bots/{deployment_id}.status.json
 * for agents to read back.
 *
 * Persistent containers use --restart=unless-stopped to survive NanoClaw
 * restarts. On startup, recovers state from existing Docker containers.
 */

import { execFileSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  computeTradeSharpe,
  computeDailyEquityCurve,
  computeByRegime,
  computeExecutionDrag,
  type ByRegime,
  type ExecutionDrag,
} from './sharpe.js';
import {
  enrichTrades,
  stampOpenTrade,
  dropDeployment as dropEnrichmentDeployment,
  type EnrichedTrade,
  type FtTradeLike,
} from './trade-enrichment.js';
import { dispatchSignal, type TradeEvent } from './webhook-dispatcher.js';

// ─── Configuration ──────────────────────────────────────────────────

const botEnv = readEnvFile([
  'BOT_RUNNER_BASE_PORT',
  'BOT_RUNNER_MAX_BOTS',
  'FREQTRADE_BOT_IMAGE',
]);

const POLL_MS = 3000;
const HEALTH_CHECK_MS = 60_000;
const BOT_RUNNER_DIR = path.join(DATA_DIR, 'bot-runner');
const REQUEST_DIR = path.join(BOT_RUNNER_DIR, 'requests');
const BOTS_DIR = path.join(BOT_RUNNER_DIR, 'bots');
const CONFIGS_DIR = path.join(BOT_RUNNER_DIR, 'configs');
const PORT_MAP_PATH = path.join(BOT_RUNNER_DIR, 'port-map.json');

const BASE_PORT = parseInt(
  process.env.BOT_RUNNER_BASE_PORT || botEnv.BOT_RUNNER_BASE_PORT || '8081',
  10,
);
const MAX_BOTS = parseInt(
  process.env.BOT_RUNNER_MAX_BOTS || botEnv.BOT_RUNNER_MAX_BOTS || '20',
  10,
);
const BOT_IMAGE =
  process.env.FREQTRADE_BOT_IMAGE ||
  botEnv.FREQTRADE_BOT_IMAGE ||
  'freqtradeorg/freqtrade:stable';

const CONTAINER_PREFIX = 'nanoclaw-bot-';
const FT_API_USERNAME = 'freqtrade';

// Signal marketplace: track trade counts to detect new trades
const lastTradeCount = new Map<string, number>();

// Track consecutive 401 counts per bot for stale-proxy detection
const consecutiveAuthFailures = new Map<string, number>();
const AUTH_FAILURE_RESTART_THRESHOLD = 3; // restart container after 3 consecutive 401s

// ─── Types ──────────────────────────────────────────────────────────

interface BotRequest {
  type:
    | 'start_bot'
    | 'stop_bot'
    | 'toggle_signals'
    | 'get_status'
    | 'place_trade'
    | 'webhook_create'
    | 'webhook_test'
    | 'webhook_delete';
  deployment_id: string;
  strategy_name?: string;
  pair?: string;
  timeframe?: string;
  group_folder?: string;
  chat_jid?: string;
  enable?: boolean; // for toggle_signals
  confirm?: boolean; // for stop_bot
  dry_run?: boolean; // default true
  webhook_config?: any; // for webhook_create
  webhook_id?: string; // for webhook_test/delete
  // place_trade fields
  side?: 'long' | 'short';
  stake_amount?: number;
  price?: number | null;
  stoploss?: number | null;
  takeprofit?: number | null;
  order_tag?: string;
  submitted_at: string;
}

interface BotInstance {
  deploymentId: string;
  containerName: string;
  port: number;
  password: string;
  strategy: string;
  pair: string;
  timeframe: string;
  dryRun: boolean;
  startedAt: string;
  signalsActive: boolean;
  status: 'running' | 'stopped' | 'starting' | 'error';
  error?: string;
}

interface BotStatusFile {
  deployment_id: string;
  status: 'running' | 'stopped' | 'starting' | 'error';
  container_name: string;
  api_port: number;
  api_url: string;
  api_username?: string;
  api_password?: string;
  signals_active: boolean;
  strategy: string;
  pair: string;
  timeframe: string;
  dry_run: boolean;
  started_at: string;
  last_health_check?: string;
  error?: string;
  paper_pnl?: {
    profit_pct: number;
    trade_count: number;
    win_rate: number;
    sharpe: number;
    daily_equity?: Array<{ date: string; cumulative_pnl_pct: number }>;
    // Rolling window of the most recent enriched trades for attribution
    // downstream (Finding 2). Capped at 50 — enough for by_regime rollups
    // without bloating the status file. Unused by existing consumers.
    enriched_trades?: EnrichedTrade[];
    // Finding 1 — regime-conditional P&L rollup derived from enriched_trades.
    // Keyed by regime string (EFFICIENT_TREND, COMPRESSION, CHAOS, TRANQUIL,
    // UNKNOWN). Consumers: monitor (regime-aware retirement), dashboard
    // (regime P&L tab), kata (regime-conditional optimization targets).
    by_regime?: ByRegime;
    // Finding 12 — execution drag rollup. Slippage-aware quality score.
    // Null when no enriched trades carry slippage estimates (legacy data
    // or deployment lacks volume_weight). Consumers: monitor Trigger J
    // (pause on execution drag), monitor Step 5 (graduation gate),
    // dashboard (ExQ column), edge audit Finding 12.
    execution?: ExecutionDrag | null;
    last_updated: string;
  };
}

export interface BotRunnerDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, { folder: string; name: string }>;
}

// ─── Deployment / Market Prior readers (for webhook context) ────────

function readDeployment(deploymentId: string): any | null {
  try {
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const depFile = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'deployments.json',
      );
      if (!fs.existsSync(depFile)) continue;
      const data = JSON.parse(fs.readFileSync(depFile, 'utf-8'));
      const dep = data.deployments?.find((d: any) => d.id === deploymentId);
      if (dep) return dep;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readMarketPrior(): any | null {
  try {
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const mpFile = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'market-prior.json',
      );
      if (!fs.existsSync(mpFile)) continue;
      return JSON.parse(fs.readFileSync(mpFile, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readPortfolio(): any | null {
  try {
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const pfFile = path.join(
        GROUPS_DIR,
        folder,
        'auto-mode',
        'portfolio.json',
      );
      if (!fs.existsSync(pfFile)) continue;
      return JSON.parse(fs.readFileSync(pfFile, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ─── State ──────────────────────────────────────────────────────────

const activeBots = new Map<string, BotInstance>();
const portMap = new Map<number, string>(); // port → deploymentId
const processingRequests = new Set<string>(); // request IDs currently in-flight
const startingDeployments = new Set<string>(); // deployment IDs currently starting
let running = false;
let deps: BotRunnerDeps | undefined;
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

// ─── Helpers ────────────────────────────────────────────────────────

function generatePassword(): string {
  const chars =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 24; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function resolveJobChatJid(manifest: {
  chat_jid?: string;
  group_folder?: string;
}): string | undefined {
  if (manifest.chat_jid) return manifest.chat_jid;
  if (!deps || !manifest.group_folder) return undefined;
  const groups = deps.registeredGroups();
  const entry = Object.entries(groups).find(
    ([, g]) => g.folder === manifest.group_folder,
  );
  return entry?.[0];
}

function notifyUser(chatJid: string | undefined, text: string): void {
  if (!chatJid || !deps) return;
  deps
    .sendMessage(chatJid, text)
    .catch((err) =>
      logger.error({ err, chatJid }, 'Failed to send bot runner notification'),
    );
}

function allocatePort(deploymentId: string): number | null {
  for (let p = BASE_PORT; p < BASE_PORT + MAX_BOTS; p++) {
    if (!portMap.has(p)) {
      portMap.set(p, deploymentId); // reserve immediately to prevent race
      savePortMap();
      return p;
    }
  }
  return null;
}

function savePortMap(): void {
  const obj: Record<string, string> = {};
  for (const [port, id] of portMap) {
    obj[String(port)] = id;
  }
  fs.writeFileSync(PORT_MAP_PATH, JSON.stringify(obj, null, 2));
}

function loadPortMap(): void {
  try {
    if (!fs.existsSync(PORT_MAP_PATH)) return;
    const obj = JSON.parse(fs.readFileSync(PORT_MAP_PATH, 'utf-8'));
    for (const [port, id] of Object.entries(obj)) {
      portMap.set(parseInt(port, 10), id as string);
    }
  } catch {
    // Start fresh
  }
}

/**
 * Reconcile portMap against live Docker containers.
 * Frees ports claimed by containers that no longer exist (ghost entries).
 * Called at startup after recoverExistingBots() and periodically during
 * health checks to prevent port exhaustion from stale entries.
 */
function reconcilePorts(): void {
  let liveIds: Set<string>;
  try {
    const output = dockerExec([
      'ps',
      '--filter',
      `name=${CONTAINER_PREFIX}`,
      '--format',
      '"{{.Names}}"',
    ]);
    liveIds = new Set(
      (output || '')
        .split('\n')
        .map((s) => s.replace(/"/g, '').trim())
        .filter((s) => s.startsWith(CONTAINER_PREFIX))
        .map((s) => s.replace(CONTAINER_PREFIX, '')),
    );
  } catch {
    return; // Can't reach Docker — skip reconciliation
  }

  let freed = 0;
  for (const [port, deploymentId] of portMap) {
    if (!liveIds.has(deploymentId)) {
      portMap.delete(port);
      activeBots.delete(deploymentId);
      freed++;
    }
  }
  if (freed > 0) {
    savePortMap();
    logger.info(
      { freed, remaining: portMap.size },
      'Port reconciliation: freed ghost entries',
    );
  }
}

function writeBotStatus(
  bot: BotInstance,
  extra?: Partial<BotStatusFile>,
): void {
  const statusPath = path.join(BOTS_DIR, `${bot.deploymentId}.status.json`);

  // Preserve transient fields (paper_pnl, last_health_check) across status
  // updates that don't explicitly refresh them — stop, toggle, error, port
  // rebind, etc. Without this, every non-getBotStatus() write wipes paper_pnl
  // from disk and the dashboard regresses on win_rate and sharpe for stopped
  // bots (peak_trade_count survives via the sync-ingest ratchet, but the
  // jsonb paper_pnl field does not).
  let prev: Partial<BotStatusFile> = {};
  try {
    if (fs.existsSync(statusPath)) {
      prev = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    }
  } catch {
    // Corrupt file — fall through and rewrite from scratch.
  }

  const statusFile: BotStatusFile = {
    deployment_id: bot.deploymentId,
    status: bot.status,
    container_name: bot.containerName,
    api_port: bot.port,
    api_url: `http://127.0.0.1:${bot.port}`,
    api_username: FT_API_USERNAME,
    api_password: bot.password || undefined,
    signals_active: bot.signalsActive,
    strategy: bot.strategy,
    pair: bot.pair,
    timeframe: bot.timeframe,
    dry_run: bot.dryRun,
    started_at: bot.startedAt,
    ...(prev.paper_pnl ? { paper_pnl: prev.paper_pnl } : {}),
    ...(prev.last_health_check
      ? { last_health_check: prev.last_health_check }
      : {}),
    ...(bot.error ? { error: bot.error } : {}),
    ...extra,
  };
  fs.writeFileSync(statusPath, JSON.stringify(statusFile, null, 2));
}

function writeRequestStatus(
  requestId: string,
  status: Record<string, unknown>,
): void {
  const statusPath = path.join(REQUEST_DIR, `${requestId}.status.json`);
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

/**
 * Make a FreqTrade REST API call to a running bot.
 */
function ftApiCall(
  port: number,
  method: string,
  endpoint: string,
  password: string,
  body?: object,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${FT_API_USERNAME}:${password}`).toString(
      'base64',
    );
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/v1/${endpoint}`,
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          ...(bodyStr
            ? { 'Content-Length': Buffer.byteLength(bodyStr) }
            : {}),
        },
        timeout: 10_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Poll the FreqTrade API until it responds to /ping.
 * Prevents "socket hang up" when toggle_signals is called before uvicorn is ready.
 */
async function waitForBotReady(
  port: number,
  password: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await ftApiCall(port, 'GET', 'ping', password);
      if (res.status === 200) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  logger.warn({ port }, 'Bot API did not become ready within timeout');
}

/**
 * Fetch custom_data for a single trade via /trade/<id>.
 *
 * Track B (measured execution): graduated strategies stamp `signal_close`
 * via `trade.set_custom_data()` in the ExecBenchmark mixin. This function
 * retrieves that value for newly closed trades so enrichTrades can compute
 * implementation shortfall. Only called for NEW trades (1-2 per health
 * check cycle), never bulk.
 *
 * Returns the signal_close value or null on any failure — non-critical.
 */
async function fetchSignalClose(
  port: number,
  password: string,
  tradeId: number,
): Promise<number | null> {
  try {
    const res = await ftApiCall(port, 'GET', `trade/${tradeId}`, password);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const sc = data?.custom_data?.signal_close?.value;
      return typeof sc === 'number' && sc > 0 ? sc : null;
    }
  } catch {
    /* non-critical — falls through to measured > estimated */
  }
  return null;
}

// ─── Strategy file resolution ───────────────────────────────────────

function findStrategyFile(
  strategyName: string,
  groupFolder?: string,
): string | null {
  // Check group-specific strategies first
  if (groupFolder) {
    const groupDir = path.join(
      DATA_DIR,
      'sessions',
      groupFolder,
      'freqtrade-user-data',
      'strategies',
    );
    const groupFile = path.join(groupDir, `${strategyName}.py`);
    if (fs.existsSync(groupFile)) return groupFile;
  }
  return null;
}

// ─── FreqTrade Config Generation ────────────────────────────────────

function generateBotConfig(
  deploymentId: string,
  strategy: string,
  pair: string,
  timeframe: string,
  port: number,
  password: string,
  dryRun: boolean,
): string {
  const configDir = path.join(CONFIGS_DIR, deploymentId);
  fs.mkdirSync(configDir, { recursive: true });

  const config = {
    strategy,
    trading_mode: 'futures',
    margin_mode: 'isolated',
    stake_currency: 'USDT',
    stake_amount: 'unlimited',
    max_open_trades: 1,
    dry_run: dryRun,
    dry_run_wallet: 1000,
    db_url: 'sqlite:////freqtrade/user_data/data/tradesv3.dryrun.sqlite',
    exchange: {
      name: 'binance',
      pair_whitelist: [pair],
      key: '',
      secret: '',
    },
    timeframe,
    entry_pricing: {
      price_side: 'other',
      use_order_book: true,
      order_book_top: 1,
    },
    exit_pricing: {
      price_side: 'other',
      use_order_book: true,
      order_book_top: 1,
    },
    pairlists: [{ method: 'StaticPairList' }],
    // tv-manual bots accept only forced entries via the FreqTrade API;
    // without this flag the /forcebuy endpoint returns 401.
    force_entry_enable: true,
    api_server: {
      enabled: true,
      listen_ip_address: '0.0.0.0',
      listen_port: 8080,
      username: FT_API_USERNAME,
      password,
      jwt_secret_key: generatePassword(),
    },
    initial_state: 'stopped',
    internals: {
      process_throttle_secs: 5,
    },
  };

  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ─── Docker Container Management ────────────────────────────────────

/**
 * Execute a Docker command by spawning docker directly (no shell).
 * Using execFileSync avoids cmd.exe shell escaping issues on Windows
 * where volume-mount colons and backslashes get misinterpreted.
 */
function dockerExec(args: string[], timeoutMs = 30_000): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Docker command failed: ${msg}`);
  }
}

function isContainerRunning(containerName: string): boolean {
  try {
    const result = dockerExec([
      'inspect',
      '--format',
      '"{{.State.Running}}"',
      containerName,
    ]);
    return result.replace(/"/g, '') === 'true';
  } catch {
    return false;
  }
}

function removeContainer(containerName: string): void {
  try {
    dockerExec(['rm', '-f', containerName]);
  } catch {
    // Container may not exist
  }
}

async function startBotContainer(req: BotRequest): Promise<BotInstance> {
  const deploymentId = req.deployment_id;

  // Per-deployment mutex: prevent concurrent starts of the same bot
  if (startingDeployments.has(deploymentId)) {
    throw new Error(
      `Bot ${deploymentId} is already starting — duplicate start ignored`,
    );
  }
  startingDeployments.add(deploymentId);

  try {
    const containerName = `${CONTAINER_PREFIX}${deploymentId}`;
    const strategy = req.strategy_name!;
    const pair = req.pair!;
    const timeframe = req.timeframe || '1h';
    const dryRun = req.dry_run !== false;

    // If this bot is already running in activeBots, reuse its port and stop the
    // existing container before regenerating the config.  This avoids the race
    // window where config.json is overwritten with a new password while the old
    // container is still live (NanoClaw restart between write and docker-rm would
    // leave recovery reading a password the container was never started with).
    const existingBot = activeBots.get(deploymentId);
    if (existingBot) {
      logger.info(
        { deploymentId, existingPort: existingBot.port },
        'start_bot called for already-running bot — stopping existing container first',
      );
      // Release the old port so allocatePort() can reuse it
      portMap.delete(existingBot.port);
      removeContainer(containerName);
      activeBots.delete(deploymentId);
    }

    // Allocate port (reserves in portMap atomically)
    const port = allocatePort(deploymentId);
    if (port === null) {
      throw new Error(
        `No free ports available (max ${MAX_BOTS} bots, base port ${BASE_PORT})`,
      );
    }

    // Find strategy file
    const strategyFile = findStrategyFile(strategy, req.group_folder);
    if (!strategyFile) {
      throw new Error(
        `Strategy file ${strategy}.py not found in group ${req.group_folder || 'unknown'}`,
      );
    }

    // Remove existing container BEFORE writing the new config so the race window
    // between "config overwritten with P2" and "old container still running with P1"
    // is eliminated.  If NanoClaw crashes after this point, recovery will find no
    // running container and the orphan config is harmless.
    removeContainer(containerName);

    // Generate password and config (written AFTER the old container is gone)
    const password = generatePassword();
    const configPath = generateBotConfig(
      deploymentId,
      strategy,
      pair,
      timeframe,
      port,
      password,
      dryRun,
    );

    // Build docker run command
    const strategiesDir = path.dirname(strategyFile);
    const dataDir = path.join(CONFIGS_DIR, deploymentId, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const dockerArgs = [
      'run',
      '-d',
      '--name',
      containerName,
      '--restart',
      'unless-stopped',
      '-v',
      `${strategiesDir}:/freqtrade/user_data/strategies:ro`,
      '-v',
      `${configPath}:/freqtrade/config.json:ro`,
      '-v',
      `${dataDir}:/freqtrade/user_data/data`,
      '-p',
      `${port}:8080`,
      BOT_IMAGE,
      'trade',
      '--config',
      '/freqtrade/config.json',
      '--strategy',
      strategy,
    ];

    logger.info(
      { deploymentId, containerName, port, strategy, pair },
      'Starting FreqTrade bot container',
    );

    // Retry with backoff for transient Docker failures (network, daemon restarts)
    const MAX_START_RETRIES = 3;
    const RETRY_DELAYS = [2_000, 5_000, 10_000];
    let lastStartError: Error | undefined;

    for (let attempt = 0; attempt < MAX_START_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          removeContainer(containerName); // Clean up partial start
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
          logger.info(
            { deploymentId, attempt: attempt + 1 },
            'Retrying bot container start',
          );
        }
        dockerExec(dockerArgs);
        lastStartError = undefined;
        break;
      } catch (err) {
        lastStartError = err as Error;
        logger.warn(
          { deploymentId, attempt: attempt + 1, error: (err as Error).message },
          'Docker run failed',
        );
      }
    }

    if (lastStartError) {
      // Release the pre-reserved port on failure
      portMap.delete(port);
      savePortMap();
      throw lastStartError;
    }

    // Wait for FreqTrade API to accept connections before returning
    try {
      await waitForBotReady(port, password);
    } catch (err) {
      // Release port on readiness failure
      portMap.delete(port);
      savePortMap();
      throw err;
    }

    const bot: BotInstance = {
      deploymentId,
      containerName,
      port,
      password,
      strategy,
      pair,
      timeframe,
      dryRun,
      startedAt: new Date().toISOString(),
      signalsActive: false, // starts stopped, monitor enables
      status: 'running',
    };

    activeBots.set(deploymentId, bot);
    // Port already reserved by allocatePort() — no need to set again
    writeBotStatus(bot);

    return bot;
  } finally {
    startingDeployments.delete(deploymentId);
  }
}

async function stopBotContainer(deploymentId: string): Promise<void> {
  const bot = activeBots.get(deploymentId);
  if (!bot) {
    // Try to stop by container name anyway
    removeContainer(`${CONTAINER_PREFIX}${deploymentId}`);
    // Clean up status file
    const statusPath = path.join(BOTS_DIR, `${deploymentId}.status.json`);
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      status.status = 'stopped';
      status.signals_active = false;
      fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    }
    return;
  }

  logger.info(
    { deploymentId, containerName: bot.containerName },
    'Stopping FreqTrade bot container',
  );

  removeContainer(bot.containerName);

  // Release port
  portMap.delete(bot.port);
  savePortMap();

  bot.status = 'stopped';
  bot.signalsActive = false;
  writeBotStatus(bot);
  activeBots.delete(deploymentId);
  // Finding 2: drop the trade-enrichment store slice so it doesn't
  // accumulate dead entries across retirements.
  dropEnrichmentDeployment(deploymentId);
}

async function toggleBotSignals(
  deploymentId: string,
  enable: boolean,
): Promise<void> {
  const bot = activeBots.get(deploymentId);
  if (!bot) {
    throw new Error(`Bot ${deploymentId} not found in active bots`);
  }

  if (bot.status !== 'running') {
    throw new Error(
      `Bot ${deploymentId} is ${bot.status}, cannot toggle signals`,
    );
  }

  const endpoint = enable ? 'start' : 'stop';
  try {
    await ftApiCall(bot.port, 'POST', endpoint, bot.password);
    bot.signalsActive = enable;
    writeBotStatus(bot);
    logger.info(
      { deploymentId, enable },
      `Bot signals ${enable ? 'enabled' : 'disabled'}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ deploymentId, err: msg }, 'Failed to toggle bot signals');
    throw new Error(`Failed to toggle signals: ${msg}`);
  }
}

async function getBotStatus(deploymentId: string): Promise<BotStatusFile> {
  const bot = activeBots.get(deploymentId);
  if (!bot) {
    // Check if status file exists from a previous run
    const statusPath = path.join(BOTS_DIR, `${deploymentId}.status.json`);
    if (fs.existsSync(statusPath)) {
      return JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    }
    throw new Error(`Bot ${deploymentId} not found`);
  }

  // Preserve previous paper_pnl in case the API fetch fails
  let prevPnl: BotStatusFile['paper_pnl'];
  try {
    const prevPath = path.join(BOTS_DIR, `${bot.deploymentId}.status.json`);
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, 'utf-8'));
      prevPnl = prev.paper_pnl;
    }
  } catch {
    // Ignore read errors
  }

  // Fetch live data from bot API
  let pnl: BotStatusFile['paper_pnl'];
  try {
    const profitRes = await ftApiCall(bot.port, 'GET', 'profit', bot.password);
    if (profitRes.status === 200) {
      const profit = JSON.parse(profitRes.body);

      // Best-effort live Sharpe + equity curve from per-trade returns. Must
      // not break the health check loop, so we wrap the trades fetch in its
      // own try/catch and fall back to previously persisted values.
      let sharpe = 0;
      let dailyEquity:
        | Array<{ date: string; cumulative_pnl_pct: number }>
        | undefined = prevPnl?.daily_equity;
      let enrichedTrades: EnrichedTrade[] | undefined =
        prevPnl?.enriched_trades;
      try {
        const tradesRes = await ftApiCall(
          bot.port,
          'GET',
          'trades?limit=200',
          bot.password,
        );
        if (tradesRes.status === 200) {
          const tradesData = JSON.parse(tradesRes.body);
          const tradeList: FtTradeLike[] = tradesData.trades || [];
          sharpe = computeTradeSharpe(tradeList);
          dailyEquity = computeDailyEquityCurve(tradeList);

          // Finding 2: enrich every trade with regime/MAE/MFE/attribution
          // context. Store the most recent 50 in the status file for
          // downstream by_regime aggregation (Finding 1) and dashboard display.
          try {
            const deployment = readDeployment(bot.deploymentId);
            const marketPrior = readMarketPrior();
            const enriched = enrichTrades(
              bot.deploymentId,
              tradeList,
              marketPrior,
              deployment,
              deployment?.archetype ?? null,
              bot.timeframe ?? null,
            );
            enrichedTrades = enriched.slice(-50);
          } catch (enrichErr) {
            logger.debug(
              {
                deploymentId: bot.deploymentId,
                err:
                  enrichErr instanceof Error
                    ? enrichErr.message
                    : String(enrichErr),
              },
              'Trade enrichment failed — falling back to previous',
            );
          }
        } else {
          sharpe = prevPnl?.sharpe ?? 0;
        }
      } catch {
        sharpe = prevPnl?.sharpe ?? 0;
      }

      // Finding 2: open-trade scanner — stamp any fresh open trades with
      // entry-time regime context so regime_at_entry is accurate by the time
      // the close arrives. Non-blocking and best-effort.
      try {
        const statusRes = await ftApiCall(
          bot.port,
          'GET',
          'status',
          bot.password,
        );
        if (statusRes.status === 200) {
          const openTrades = JSON.parse(statusRes.body);
          if (Array.isArray(openTrades) && openTrades.length > 0) {
            const deployment = readDeployment(bot.deploymentId);
            const marketPrior = readMarketPrior();
            for (const ot of openTrades as FtTradeLike[]) {
              stampOpenTrade(bot.deploymentId, ot, marketPrior, deployment);
            }
          }
        }
      } catch {
        // Non-critical — enrichment degrades gracefully to close-time snapshot
      }

      // Finding 1 — roll enriched trades into regime-conditional metrics.
      // Runs only when we have enriched_trades (post-warm-up) and silently
      // omits the field otherwise so existing consumers aren't broken.
      const byRegime =
        enrichedTrades && enrichedTrades.length > 0
          ? computeByRegime(enrichedTrades)
          : undefined;

      // Finding 12 — execution drag rollup. Returns null when no enriched
      // trades carry slippage estimates (legacy data, or deployment lacks
      // volume_weight). Downstream gates handle the null case as
      // "informational only" — never blocks spuriously.
      const execution =
        enrichedTrades && enrichedTrades.length > 0
          ? computeExecutionDrag(enrichedTrades)
          : null;

      pnl = {
        profit_pct: profit.profit_all_percent || 0,
        trade_count: profit.trade_count || 0,
        win_rate: profit.winning_trades
          ? (profit.winning_trades / (profit.trade_count || 1)) * 100
          : 0,
        sharpe,
        ...(dailyEquity && dailyEquity.length > 0
          ? { daily_equity: dailyEquity }
          : {}),
        ...(enrichedTrades && enrichedTrades.length > 0
          ? { enriched_trades: enrichedTrades }
          : {}),
        ...(byRegime && Object.keys(byRegime).length > 0
          ? { by_regime: byRegime }
          : {}),
        ...(execution ? { execution } : {}),
        last_updated: new Date().toISOString(),
      };
    } else {
      logger.warn(
        { deploymentId, status: profitRes.status },
        'Bot profit API returned non-200',
      );
    }
  } catch (err) {
    logger.warn(
      { deploymentId, err: err instanceof Error ? err.message : String(err) },
      'Bot profit API fetch failed',
    );
  }

  // Use fresh pnl if available, otherwise preserve previous
  const effectivePnl = pnl || prevPnl;

  writeBotStatus(bot, {
    last_health_check: new Date().toISOString(),
    ...(effectivePnl ? { paper_pnl: effectivePnl } : {}),
  });

  return JSON.parse(
    fs.readFileSync(
      path.join(BOTS_DIR, `${bot.deploymentId}.status.json`),
      'utf-8',
    ),
  );
}

// ─── Signal Marketplace Publishing ───────────────────────────────────

async function publishSignalEvent(
  deploymentId: string,
  status: BotStatusFile,
): Promise<void> {
  const signalEnv = readEnvFile([
    'CONSOLE_SUPABASE_URL',
    'CONSOLE_SUPABASE_ANON_KEY',
    'CONSOLE_OPERATOR_ID',
  ]);
  const supabaseUrl = (
    process.env.CONSOLE_SUPABASE_URL ||
    signalEnv.CONSOLE_SUPABASE_URL ||
    ''
  ).replace(/\/+$/, '');
  const anonKey =
    process.env.CONSOLE_SUPABASE_ANON_KEY ||
    signalEnv.CONSOLE_SUPABASE_ANON_KEY ||
    '';
  const operatorId =
    process.env.CONSOLE_OPERATOR_ID || signalEnv.CONSOLE_OPERATOR_ID || '';

  if (!supabaseUrl || !anonKey || !operatorId) return;

  // Check if this deployment has an active catalog entry
  const catalogUrl = `${supabaseUrl}/rest/v1/signal_catalog?publisher_id=eq.${operatorId}&strategy_name=eq.${encodeURIComponent(status.strategy || '')}&pair=eq.${encodeURIComponent(status.pair || '')}&status=eq.active&limit=1`;
  const catalogRes = await fetch(catalogUrl, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
  });
  if (!catalogRes.ok) return;
  const catalogs = await catalogRes.json();
  if (!Array.isArray(catalogs) || catalogs.length === 0) return;

  const catalog = catalogs[0];

  // Publish signal event
  const signalEvent = {
    catalog_id: catalog.id,
    publisher_id: operatorId,
    signal_type: 'entry',
    direction: 'long',
    pair: catalog.pair,
    timeframe: catalog.timeframe,
    archetype: catalog.archetype,
    paper_pnl_snapshot: status.paper_pnl || {},
  };

  await fetch(`${supabaseUrl}/rest/v1/signal_events`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(signalEvent),
  });

  logger.info(
    { deploymentId, catalogId: catalog.id },
    'Signal event published to marketplace',
  );
}

/**
 * Post a trade event to aphexDATA so it shows up in the Event Log / Notifications
 * via the console-sync pipeline.
 */
async function postTradeEvent(
  deploymentId: string,
  status: BotStatusFile,
): Promise<void> {
  const aphexEnv = readEnvFile([
    'APHEXDATA_URL',
    'APHEXDATA_API_KEY',
    'APHEXDATA_AGENT_ID',
  ]);
  const aphexUrl = (
    process.env.APHEXDATA_URL ||
    aphexEnv.APHEXDATA_URL ||
    ''
  ).replace(/\/+$/, '');
  const apiKey =
    process.env.APHEXDATA_API_KEY || aphexEnv.APHEXDATA_API_KEY || '';
  const agentId =
    process.env.APHEXDATA_AGENT_ID || aphexEnv.APHEXDATA_AGENT_ID || '';

  if (!aphexUrl || !apiKey) return;

  // Read regime context (same helpers used by webhook dispatch)
  const deployment = readDeployment(deploymentId);
  const marketPrior = readMarketPrior();
  const pairBase = (status.pair || '').split('/')[0];
  const regimeData = marketPrior?.regimes?.[pairBase]?.['H2_SHORT'];

  // Finding 2: pull the most recent enriched trade for attribution context.
  // The enriched_trades array in paper_pnl is populated by getBotStatus and
  // carries per-trade regime@entry, MAE, MFE, holding minutes etc.
  const enrichedList = status.paper_pnl?.enriched_trades || [];
  const lastEnriched = enrichedList[enrichedList.length - 1];

  const body = {
    agent_id: agentId || undefined,
    verb_id: 'trade_detected',
    verb_category: 'execution',
    object_type: 'trade',
    object_id: status.pair || deploymentId,
    trust_level: 'agent_asserted',
    result_data: {
      deployment_id: deploymentId,
      strategy: status.strategy,
      pair: status.pair,
      timeframe: status.timeframe,
      trade_count: status.paper_pnl?.trade_count ?? 0,
      profit_pct: status.paper_pnl?.profit_pct ?? 0,
      win_rate: status.paper_pnl?.win_rate ?? 0,
      sharpe: status.paper_pnl?.sharpe ?? 0,
      regime: regimeData?.regime || deployment?.last_regime || null,
      regime_conviction:
        regimeData?.conviction || deployment?.last_conviction || null,
      archetype: deployment?.archetype || null,
      // Per-trade attribution (Finding 2) — null when no enriched trade is
      // available yet (first few health checks after deploy).
      last_trade: lastEnriched
        ? {
            trade_id: lastEnriched.trade_id,
            regime_at_entry: lastEnriched.regime_at_entry,
            regime_at_exit: lastEnriched.regime_at_exit,
            conviction_at_entry: lastEnriched.conviction_at_entry,
            composite_at_entry: lastEnriched.composite_at_entry,
            mae_pct: lastEnriched.mae_pct,
            mfe_pct: lastEnriched.mfe_pct,
            holding_minutes: lastEnriched.holding_minutes,
            profit_pct: lastEnriched.profit_pct,
            exit_reason: lastEnriched.exit_reason,
          }
        : null,
    },
    context: {
      source: 'bot_runner',
      deployment_id: deploymentId,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  await fetch(`${aphexUrl}/api/v1/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  logger.info({ deploymentId }, 'Trade event posted to aphexDATA');
}

// ─── Request Processing ─────────────────────────────────────────────

async function processRequest(requestFile: string): Promise<void> {
  const requestId = path.basename(requestFile, '.request.json');

  // Skip if already processed
  const statusPath = path.join(REQUEST_DIR, `${requestId}.status.json`);
  if (fs.existsSync(statusPath)) return;

  // Skip if this request is already being processed (prevents concurrent
  // invocations from the poll loop while docker run is still in progress)
  if (processingRequests.has(requestId)) return;
  processingRequests.add(requestId);

  const requestPath = path.join(REQUEST_DIR, requestFile);
  let req: BotRequest;
  try {
    req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  } catch (e) {
    processingRequests.delete(requestId);
    logger.error({ err: e, requestId }, 'Failed to read bot request');
    return;
  }

  const chatJid = resolveJobChatJid(req);

  try {
    switch (req.type) {
      case 'start_bot': {
        if (!req.strategy_name || !req.pair) {
          throw new Error('start_bot requires strategy_name and pair');
        }
        const bot = await startBotContainer(req);
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          deployment_id: req.deployment_id,
          container_name: bot.containerName,
          api_port: bot.port,
          started_at: bot.startedAt,
        });
        notifyUser(
          chatJid,
          `FreqTrade bot started for ${req.strategy_name} on ${req.pair} (port ${bot.port}, dry_run=${bot.dryRun})`,
        );
        break;
      }

      case 'stop_bot': {
        if (!req.confirm) {
          throw new Error('stop_bot requires confirm=true');
        }
        await stopBotContainer(req.deployment_id);
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          deployment_id: req.deployment_id,
          stopped_at: new Date().toISOString(),
        });
        notifyUser(chatJid, `FreqTrade bot stopped: ${req.deployment_id}`);
        break;
      }

      case 'toggle_signals': {
        const enable = req.enable !== false;
        await toggleBotSignals(req.deployment_id, enable);
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          deployment_id: req.deployment_id,
          signals_active: enable,
        });
        break;
      }

      case 'get_status': {
        const botStatus = await getBotStatus(req.deployment_id);
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          bot_status: botStatus,
        });
        break;
      }

      case 'place_trade': {
        if (!req.pair || !req.side || !req.stake_amount) {
          throw new Error('place_trade requires pair, side, and stake_amount');
        }
        const tradeBot = activeBots.get(req.deployment_id);
        if (!tradeBot) throw new Error(`Bot ${req.deployment_id} not found`);
        if (tradeBot.status !== 'running') {
          throw new Error(
            `Bot ${req.deployment_id} is ${tradeBot.status}, cannot place trade`,
          );
        }

        const tradeResult = await ftApiCall(
          tradeBot.port,
          'POST',
          'forcebuy',
          tradeBot.password,
          {
            pair: req.pair,
            stake_amount: req.stake_amount,
            side: req.side,
            price: req.price ?? null,
            order_type: 'market',
            ...(req.stoploss != null ? { stoploss: req.stoploss } : {}),
            ...(req.takeprofit != null ? { takeprofit: req.takeprofit } : {}),
            ...(req.order_tag ? { enter_tag: req.order_tag } : {}),
          },
        );

        if (tradeResult.status >= 400) {
          throw new Error(
            `FreqTrade forcebuy failed (${tradeResult.status}): ${tradeResult.body}`,
          );
        }

        const parsed = JSON.parse(tradeResult.body);
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          deployment_id: req.deployment_id,
          trade: parsed,
          placed_at: new Date().toISOString(),
        });
        notifyUser(
          chatJid,
          `Trade placed: ${req.side} ${req.pair} @ ${req.stake_amount} USDT (${req.order_tag || 'no tag'})`,
        );
        break;
      }

      case 'webhook_create': {
        const { createWebhook } = await import('./webhook-dispatcher.js');
        const webhook = createWebhook(req.webhook_config || {});
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          webhook,
        });
        break;
      }

      case 'webhook_test': {
        const { testWebhook } = await import('./webhook-dispatcher.js');
        const result = await testWebhook(
          req.webhook_id!,
          process.env as Record<string, string>,
        );
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          delivery_result: result,
        });
        break;
      }

      case 'webhook_delete': {
        const { deleteWebhook } = await import('./webhook-dispatcher.js');
        const deleted = deleteWebhook(req.webhook_id!);
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: deleted ? 'completed' : 'failed',
          error: deleted ? undefined : 'Webhook not found',
        });
        break;
      }

      default:
        throw new Error(`Unknown request type: ${req.type}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ requestId, err: msg, type: req.type }, 'Bot request failed');
    writeRequestStatus(requestId, {
      request_id: requestId,
      type: req.type,
      status: 'failed',
      deployment_id: req.deployment_id,
      error: msg,
    });
    notifyUser(
      chatJid,
      `Bot request failed (${req.type} ${req.deployment_id}): ${msg}`,
    );
  } finally {
    processingRequests.delete(requestId);
  }
}

// ─── Recovery ───────────────────────────────────────────────────────

function recoverExistingBots(): void {
  try {
    const output = dockerExec([
      'ps',
      '--filter',
      `name=${CONTAINER_PREFIX}`,
      '--format',
      '"{{.Names}}"',
    ]);
    if (!output) return;

    const containers = output
      .split('\n')
      .map((s) => s.replace(/"/g, '').trim())
      .filter((s) => s.startsWith(CONTAINER_PREFIX));

    for (const containerName of containers) {
      const deploymentId = containerName.replace(CONTAINER_PREFIX, '');
      // Read existing status file if available
      const statusPath = path.join(BOTS_DIR, `${deploymentId}.status.json`);
      if (fs.existsSync(statusPath)) {
        try {
          const status: BotStatusFile = JSON.parse(
            fs.readFileSync(statusPath, 'utf-8'),
          );
          // Query Docker for the actual host port (may differ from status
          // file after a Docker Desktop restart).
          let actualPort = status.api_port;
          try {
            const portOutput = execFileSync(
              'docker',
              ['port', containerName, '8080'],
              {
                encoding: 'utf-8',
                timeout: 5000,
              },
            ).trim();
            // Output like "8080/tcp -> 0.0.0.0:8085\n8080/tcp -> [::]:8085"
            const match = portOutput.match(/:(\d+)/);
            if (match) {
              actualPort = parseInt(match[1], 10);
              if (actualPort !== status.api_port) {
                logger.info(
                  {
                    deploymentId,
                    oldPort: status.api_port,
                    newPort: actualPort,
                  },
                  'Port changed after Docker restart — using actual port',
                );
              }
            }
          } catch {
            // Fall back to status file port
          }

          const bot: BotInstance = {
            deploymentId,
            containerName,
            port: actualPort,
            password: '', // Lost on restart — will need re-auth or status file enrichment
            strategy: status.strategy,
            pair: status.pair,
            timeframe: status.timeframe,
            dryRun: status.dry_run,
            startedAt: status.started_at,
            signalsActive: status.signals_active,
            status: 'running',
          };

          // Try to read password from config
          const configPath = path.join(
            CONFIGS_DIR,
            deploymentId,
            'config.json',
          );
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            bot.password = config.api_server?.password || '';
          }

          activeBots.set(deploymentId, bot);
          portMap.set(bot.port, deploymentId);

          logger.info(
            { deploymentId, containerName, port: bot.port },
            'Recovered existing bot container',
          );
        } catch (err) {
          logger.warn(
            { deploymentId, err },
            'Failed to recover bot from status file',
          );
        }
      } else {
        logger.warn(
          { deploymentId, containerName },
          'Found bot container without status file — stopping orphan',
        );
        removeContainer(containerName);
      }
    }

    if (containers.length > 0) {
      savePortMap();
      logger.info({ recovered: activeBots.size }, 'Bot recovery complete');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to recover existing bot containers');
  }
}

// ─── Health Check ───────────────────────────────────────────────────

let healthCheckCount = 0;

async function healthCheckBots(): Promise<void> {
  // Reconcile ports every 5th check (~5 minutes) to free ghost entries
  healthCheckCount++;
  if (healthCheckCount % 5 === 0) {
    reconcilePorts();
  }

  for (const [deploymentId, bot] of activeBots) {
    try {
      // Check Docker container is still running
      if (!isContainerRunning(bot.containerName)) {
        logger.warn(
          { deploymentId },
          'Bot container is not running — marking as error',
        );
        bot.status = 'error';
        bot.error = 'Container stopped unexpectedly';
        writeBotStatus(bot);
        continue;
      }

      // Ping the REST API
      const pingRes = await ftApiCall(bot.port, 'GET', 'ping', bot.password);
      if (pingRes.status !== 200) {
        logger.warn(
          { deploymentId, status: pingRes.status },
          'Bot API ping failed',
        );
        continue;
      }

      // Container is alive and API responds — clear any stale error
      if (bot.status === 'error') {
        bot.status = 'running';
        bot.error = undefined;
        logger.info({ deploymentId }, 'Bot recovered from error state');
      }

      // Verify auth works — detect Docker Desktop stale port-proxy (gives 401 from
      // host even though container is healthy and password is correct).
      // After AUTH_FAILURE_RESTART_THRESHOLD consecutive 401s on /profit, restart
      // the container to force Docker Desktop to refresh its proxy table.
      const authCheckRes = await ftApiCall(
        bot.port,
        'GET',
        'profit',
        bot.password,
      ).catch(() => ({ status: 0, body: '' }));

      if (authCheckRes.status === 401) {
        const failures = (consecutiveAuthFailures.get(deploymentId) ?? 0) + 1;
        consecutiveAuthFailures.set(deploymentId, failures);
        logger.warn(
          { deploymentId, consecutiveFailures: failures },
          'Bot API returned 401 — possible stale Docker proxy',
        );
        if (failures >= AUTH_FAILURE_RESTART_THRESHOLD) {
          logger.warn(
            { deploymentId },
            `${AUTH_FAILURE_RESTART_THRESHOLD} consecutive 401s — restarting container to refresh Docker port proxy`,
          );
          try {
            dockerExec(['restart', bot.containerName]);
            consecutiveAuthFailures.set(deploymentId, 0);
            logger.info(
              { deploymentId },
              'Container restarted — Docker port proxy refreshed',
            );
          } catch (restartErr) {
            logger.error(
              { deploymentId, err: String(restartErr) },
              'Failed to restart container for proxy refresh',
            );
          }
        }
        continue;
      } else {
        // Auth succeeded — reset failure counter
        consecutiveAuthFailures.set(deploymentId, 0);
      }

      // Re-send start command if signals should be active but FreqTrade
      // is in STOPPED state (happens after Docker Desktop restart).
      if (bot.signalsActive && bot.password) {
        try {
          const stateRes = await ftApiCall(
            bot.port,
            'GET',
            'state',
            bot.password,
          );
          if (stateRes.status === 200) {
            const state = JSON.parse(stateRes.body);
            if (state.state === 'stopped') {
              logger.info(
                { deploymentId },
                'Bot is stopped but signals_active=true — sending start',
              );
              await ftApiCall(bot.port, 'POST', 'start', bot.password);
            }
          }
        } catch {
          // Non-critical — will retry next health check
        }
      }

      // Fetch profit data for status file
      const status = await getBotStatus(deploymentId);

      // Signal marketplace + webhooks: detect new trades
      try {
        const tradeCount = status.paper_pnl?.trade_count ?? 0;
        const prevCount = lastTradeCount.get(deploymentId) ?? tradeCount;
        lastTradeCount.set(deploymentId, tradeCount);

        if (tradeCount > prevCount && tradeCount > 0) {
          await publishSignalEvent(deploymentId, status);
          await postTradeEvent(deploymentId, status);

          // Webhook dispatch: fetch trade details from FreqTrade API
          try {
            const newTradeCount = tradeCount - prevCount;
            const tradesRes = await ftApiCall(
              bot.port,
              'GET',
              `trades?limit=${newTradeCount}`,
              bot.password,
            );
            if (tradesRes.status === 200) {
              const tradesData = JSON.parse(tradesRes.body);
              const deployment = readDeployment(deploymentId);
              const marketPrior = readMarketPrior();
              const portfolio = readPortfolio();

              // Track B: fetch signal_close custom_data for new trades.
              // Only 1-2 trades per cycle — individual /trade/<id> calls
              // are acceptable overhead for implementation shortfall data.
              const signalCloseMap = new Map<number | string, number>();
              const newTrades = (tradesData.trades || []) as FtTradeLike[];
              for (const nt of newTrades) {
                if (typeof nt.trade_id === 'number') {
                  const sc = await fetchSignalClose(
                    bot.port,
                    bot.password,
                    nt.trade_id,
                  );
                  if (sc != null) signalCloseMap.set(nt.trade_id, sc);
                }
              }

              // Finding 2: enrich each closed trade with full attribution
              // context before dispatch. enrichTrades hydrates regime_at_entry
              // from the stamped entry snapshot when available.
              // Track B: signalCloseMap enables shortfall tier for trades
              // whose strategy stamps signal_close via ExecBenchmark mixin.
              const enriched = enrichTrades(
                deploymentId,
                newTrades,
                marketPrior,
                deployment,
                deployment?.archetype ?? null,
                status.timeframe ?? null,
                signalCloseMap.size > 0 ? signalCloseMap : undefined,
              );

              for (let i = 0; i < (tradesData.trades || []).length; i++) {
                const trade = tradesData.trades[i];
                const enr = enriched[i];
                const tradeEvent: TradeEvent = {
                  pair: trade.pair,
                  is_short: trade.is_short || false,
                  is_exit: trade.close_date !== null,
                  open_rate: trade.open_rate,
                  close_rate: trade.close_rate,
                  profit_pct: trade.profit_pct,
                  exit_reason: trade.exit_reason,
                  holding_minutes: trade.trade_duration,
                  trade_id: enr.trade_id,
                  regime_at_entry: enr.regime_at_entry,
                  regime_at_exit: enr.regime_at_exit,
                  conviction_at_entry: enr.conviction_at_entry,
                  composite_at_entry: enr.composite_at_entry,
                  mae_pct: enr.mae_pct,
                  mfe_pct: enr.mfe_pct,
                  archetype: enr.archetype,
                  timeframe: enr.timeframe,
                  opened_at: enr.opened_at,
                  closed_at: enr.closed_at,
                };
                await dispatchSignal(
                  tradeEvent,
                  status,
                  deployment,
                  marketPrior,
                  process.env as Record<string, string>,
                  undefined,
                  portfolio,
                );
              }
            }
          } catch (whErr) {
            logger.debug(
              { deploymentId, err: String(whErr) },
              'Webhook dispatch failed',
            );
          }
        }
      } catch {
        // Non-critical — signal publishing failure should never break health checks
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(
        { deploymentId, err: msg },
        'Bot health check failed (may still be starting)',
      );
    }
  }
}

// ─── Poll Loop ──────────────────────────────────────────────────────

function pollRequests(): void {
  if (!running) return;

  try {
    if (!fs.existsSync(REQUEST_DIR)) {
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
    }

    const files = fs
      .readdirSync(REQUEST_DIR)
      .filter((f) => f.endsWith('.request.json'));

    for (const file of files) {
      processRequest(file).catch((err) => {
        logger.error({ err, file }, 'Unhandled error processing bot request');
      });
    }
  } catch (err) {
    logger.error({ err }, 'Error polling bot requests');
  }

  setTimeout(pollRequests, POLL_MS);
}

// ─── Public API ─────────────────────────────────────────────────────

export function startBotRunner(runnerDeps?: BotRunnerDeps): void {
  if (running) {
    logger.debug('Bot runner already running, skipping duplicate start');
    return;
  }
  deps = runnerDeps;
  running = true;

  // Ensure directories exist
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
  fs.mkdirSync(BOTS_DIR, { recursive: true });
  fs.mkdirSync(CONFIGS_DIR, { recursive: true });

  // Recover state
  loadPortMap();
  recoverExistingBots();
  reconcilePorts(); // Free ports for containers that died while we were down

  // Start polling
  pollRequests();

  // Start health checks
  healthCheckTimer = setInterval(() => {
    healthCheckBots().catch((err) =>
      logger.error({ err }, 'Bot health check cycle failed'),
    );
  }, HEALTH_CHECK_MS);

  logger.info(
    {
      requestDir: REQUEST_DIR,
      botsDir: BOTS_DIR,
      basePort: BASE_PORT,
      maxBots: MAX_BOTS,
      image: BOT_IMAGE,
      activeBots: activeBots.size,
    },
    'Bot runner started',
  );
}

export function stopBotRunner(): void {
  running = false;
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = undefined;
  }
  // Note: bot containers persist (--restart unless-stopped).
  // They survive NanoClaw restarts by design.
  logger.info(
    { activeBots: activeBots.size },
    'Bot runner stopped (containers persist)',
  );
}

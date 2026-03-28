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

import { execSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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
  process.env.BOT_RUNNER_MAX_BOTS || botEnv.BOT_RUNNER_MAX_BOTS || '10',
  10,
);
const BOT_IMAGE =
  process.env.FREQTRADE_BOT_IMAGE ||
  botEnv.FREQTRADE_BOT_IMAGE ||
  'freqtradeorg/freqtrade:stable';

const CONTAINER_PREFIX = 'nanoclaw-bot-';
const FT_API_USERNAME = 'freqtrade';

// ─── Types ──────────────────────────────────────────────────────────

interface BotRequest {
  type: 'start_bot' | 'stop_bot' | 'toggle_signals' | 'get_status';
  deployment_id: string;
  strategy_name?: string;
  pair?: string;
  timeframe?: string;
  group_folder?: string;
  chat_jid?: string;
  enable?: boolean; // for toggle_signals
  confirm?: boolean; // for stop_bot
  dry_run?: boolean; // default true
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
    last_updated: string;
  };
}

export interface BotRunnerDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, { folder: string; name: string }>;
}

// ─── State ──────────────────────────────────────────────────────────

const activeBots = new Map<string, BotInstance>();
const portMap = new Map<number, string>(); // port → deploymentId
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

function allocatePort(): number | null {
  for (let p = BASE_PORT; p < BASE_PORT + MAX_BOTS; p++) {
    if (!portMap.has(p)) return p;
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

function writeBotStatus(
  bot: BotInstance,
  extra?: Partial<BotStatusFile>,
): void {
  const statusFile: BotStatusFile = {
    deployment_id: bot.deploymentId,
    status: bot.status,
    container_name: bot.containerName,
    api_port: bot.port,
    api_url: `http://127.0.0.1:${bot.port}`,
    signals_active: bot.signalsActive,
    strategy: bot.strategy,
    pair: bot.pair,
    timeframe: bot.timeframe,
    dry_run: bot.dryRun,
    started_at: bot.startedAt,
    ...(bot.error ? { error: bot.error } : {}),
    ...extra,
  };
  const statusPath = path.join(BOTS_DIR, `${bot.deploymentId}.status.json`);
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
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${FT_API_USERNAME}:${password}`).toString(
      'base64',
    );
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/v1/${endpoint}`,
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
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
    req.end();
  });
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

function dockerExec(args: string[]): string {
  try {
    return execSync(`docker ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30_000,
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
  const containerName = `${CONTAINER_PREFIX}${deploymentId}`;
  const strategy = req.strategy_name!;
  const pair = req.pair!;
  const timeframe = req.timeframe || '1h';
  const dryRun = req.dry_run !== false;

  // Allocate port
  const port = allocatePort();
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

  // Generate password and config
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

  // Remove existing container if present (stale from prior run)
  removeContainer(containerName);

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

  dockerExec(dockerArgs);

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
    signalsActive: false, // starts stopped, auto-mode enables
    status: 'running',
  };

  activeBots.set(deploymentId, bot);
  portMap.set(port, deploymentId);
  savePortMap();
  writeBotStatus(bot);

  return bot;
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

  // Fetch live data from bot API
  let pnl: BotStatusFile['paper_pnl'];
  try {
    const profitRes = await ftApiCall(bot.port, 'GET', 'profit', bot.password);
    if (profitRes.status === 200) {
      const profit = JSON.parse(profitRes.body);
      pnl = {
        profit_pct: profit.profit_all_percent || 0,
        trade_count: profit.trade_count || 0,
        win_rate: profit.winning_trades
          ? (profit.winning_trades / (profit.trade_count || 1)) * 100
          : 0,
        last_updated: new Date().toISOString(),
      };
    }
  } catch {
    // Bot may not be ready yet
  }

  writeBotStatus(bot, {
    last_health_check: new Date().toISOString(),
    ...(pnl ? { paper_pnl: pnl } : {}),
  });

  return JSON.parse(
    fs.readFileSync(
      path.join(BOTS_DIR, `${bot.deploymentId}.status.json`),
      'utf-8',
    ),
  );
}

// ─── Request Processing ─────────────────────────────────────────────

async function processRequest(requestFile: string): Promise<void> {
  const requestId = path.basename(requestFile, '.request.json');

  // Skip if already processed
  const statusPath = path.join(REQUEST_DIR, `${requestId}.status.json`);
  if (fs.existsSync(statusPath)) return;

  const requestPath = path.join(REQUEST_DIR, requestFile);
  let req: BotRequest;
  try {
    req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  } catch (e) {
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
          const bot: BotInstance = {
            deploymentId,
            containerName,
            port: status.api_port,
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

async function healthCheckBots(): Promise<void> {
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

      // Fetch profit data for status file
      await getBotStatus(deploymentId);
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

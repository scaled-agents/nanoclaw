/**
 * Deployment verification — 30-day independent backtest via Docker.
 * Runs `freqtrade backtesting` in an ephemeral container and checks
 * trade_count > 0, win_rate > min, regime not anti.
 * No persistent side effects.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import pino from 'pino';

import { DATA_DIR } from './config.js';
import type { ArchetypeConfig } from './health-types.js';
import type { VerificationResult } from './deploy-types.js';

const logger = pino({ name: 'deploy-verification' });

const BOT_IMAGE =
  process.env.FREQTRADE_BOT_IMAGE || 'freqtradeorg/freqtrade:stable';

const BACKTEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function computeTimerange(days: number): string {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return `${formatDate(start)}-${formatDate(end)}`;
}

function findStrategyFile(
  strategyName: string,
  groupFolder: string,
): string | null {
  const groupDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    'freqtrade-user-data',
    'strategies',
  );
  const file = path.join(groupDir, `${strategyName}.py`);
  if (fs.existsSync(file)) return file;
  return null;
}

function findDataDir(groupFolder: string): string | null {
  const dataDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    'freqtrade-user-data',
    'data',
  );
  if (fs.existsSync(dataDir)) return dataDir;
  return null;
}

function dockerExecAsync(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      'docker',
      args,
      { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `Docker backtest failed: ${err.message}\nstderr: ${stderr}`,
            ),
          );
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
        }
      },
    );
  });
}

// ─── Backtest Config ────────────────────────────────────────────────

function generateBacktestConfig(
  strategy: string,
  pair: string,
  timeframe: string,
  outputDir: string,
): string {
  const config = {
    strategy,
    trading_mode: 'futures',
    margin_mode: 'isolated',
    stake_currency: 'USDT',
    stake_amount: 'unlimited',
    max_open_trades: 1,
    dry_run: true,
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
  };

  const configPath = path.join(outputDir, 'backtest-config.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ─── Parse Results ──────────────────────────────────────────────────

function parseBacktestResults(
  resultsDir: string,
): { trade_count: number; win_rate: number } | null {
  try {
    if (!fs.existsSync(resultsDir)) return null;
    const files = fs
      .readdirSync(resultsDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    if (files.length === 0) return null;

    // Use the most recent results file
    const latestFile = files.sort().pop()!;
    const data = JSON.parse(
      fs.readFileSync(path.join(resultsDir, latestFile), 'utf-8'),
    );

    // FreqTrade backtest results structure
    const strategyResults = data.strategy ?? {};
    const firstKey = Object.keys(strategyResults)[0];
    const result = firstKey ? strategyResults[firstKey] : data;

    const tradeCount = result?.total_trades ?? result?.trade_count ?? 0;
    const wins = result?.wins ?? 0;
    const winRate = tradeCount > 0 ? wins / tradeCount : 0;

    return { trade_count: tradeCount, win_rate: winRate };
  } catch (err) {
    logger.warn({ err, resultsDir }, 'Failed to parse backtest results');
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export async function runVerificationBacktest(
  strategy: string,
  pair: string,
  timeframe: string,
  groupFolder: string,
): Promise<VerificationResult> {
  const strategyFile = findStrategyFile(strategy, groupFolder);
  if (!strategyFile) {
    return {
      passed: false,
      trade_count: 0,
      win_rate: 0,
      regime_blocked: false,
      reason: `Strategy file ${strategy}.py not found`,
    };
  }

  const dataDir = findDataDir(groupFolder);
  if (!dataDir) {
    return {
      passed: false,
      trade_count: 0,
      win_rate: 0,
      regime_blocked: false,
      reason: 'Freqtrade data directory not found',
    };
  }

  const strategiesDir = path.dirname(strategyFile);
  const tmpDir = path.join(DATA_DIR, 'deploy-verification', `bt-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const resultsDir = path.join(tmpDir, 'backtest_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const configPath = generateBacktestConfig(strategy, pair, timeframe, tmpDir);
  const timerange = computeTimerange(30);

  const dockerArgs = [
    'run',
    '--rm',
    '-v',
    `${strategiesDir}:/freqtrade/user_data/strategies:ro`,
    '-v',
    `${configPath}:/freqtrade/config.json:ro`,
    '-v',
    `${dataDir}:/freqtrade/user_data/data:ro`,
    '-v',
    `${resultsDir}:/freqtrade/user_data/backtest_results`,
    BOT_IMAGE,
    'backtesting',
    '--config',
    '/freqtrade/config.json',
    '--strategy',
    strategy,
    '--timerange',
    timerange,
  ];

  try {
    logger.info(
      { strategy, pair, timeframe, timerange },
      'Running verification backtest',
    );
    await dockerExecAsync(dockerArgs, BACKTEST_TIMEOUT_MS);

    const results = parseBacktestResults(resultsDir);
    if (!results) {
      return {
        passed: false,
        trade_count: 0,
        win_rate: 0,
        regime_blocked: false,
        reason: 'No backtest results produced',
      };
    }

    return {
      passed: true, // Gates checked separately
      trade_count: results.trade_count,
      win_rate: results.win_rate,
      regime_blocked: false,
    };
  } catch (err) {
    logger.warn(
      { err, strategy, pair },
      'Verification backtest failed',
    );
    return {
      passed: false,
      trade_count: 0,
      win_rate: 0,
      regime_blocked: false,
      reason: `Backtest error: ${(err as Error).message.slice(0, 200)}`,
    };
  } finally {
    // Cleanup tmp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failures */
    }
  }
}

export function checkVerificationGates(
  result: VerificationResult,
  archetype: ArchetypeConfig,
  currentRegime: string | null,
  minWinRate: number,
): { passed: boolean; reason?: string } {
  if (result.trade_count === 0) {
    return { passed: false, reason: 'zero_trades' };
  }

  if (result.win_rate < minWinRate) {
    return {
      passed: false,
      reason: `win_rate ${(result.win_rate * 100).toFixed(0)}% < ${(minWinRate * 100).toFixed(0)}%`,
    };
  }

  if (
    currentRegime &&
    archetype.anti_regimes.includes(currentRegime)
  ) {
    return {
      passed: false,
      reason: `regime ${currentRegime} in anti_regimes`,
    };
  }

  return { passed: true };
}

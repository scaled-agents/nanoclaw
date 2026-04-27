/**
 * Data Downloader — deterministic host-side service replacing data-download LLM task.
 * Runs daily. Downloads fresh market data via Docker freqtrade, then syncs
 * files from futures/ to binance/futures/ (needed by some freqtrade configs).
 * Silent on success, logs errors only.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import pino from 'pino';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const logger = pino({ name: 'data-downloader' });

const BOT_IMAGE =
  process.env.FREQTRADE_BOT_IMAGE || 'freqtradeorg/freqtrade:stable';

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const PAIRS = [
  'ADA/USDT:USDT',
  'APT/USDT:USDT',
  'ARB/USDT:USDT',
  'ATOM/USDT:USDT',
  'AVAX/USDT:USDT',
  'BCH/USDT:USDT',
  'BNB/USDT:USDT',
  'BTC/USDT:USDT',
  'DOGE/USDT:USDT',
  'DOT/USDT:USDT',
  'ETH/USDT:USDT',
  'GRT/USDT:USDT',
  'ICP/USDT:USDT',
  'INJ/USDT:USDT',
  'JTO/USDT:USDT',
  'LINK/USDT:USDT',
  'NEAR/USDT:USDT',
  'OP/USDT:USDT',
  'SOL/USDT:USDT',
  'STX/USDT:USDT',
  'SUI/USDT:USDT',
  'TON/USDT:USDT',
  'XRP/USDT:USDT',
];

const TIMEFRAMES = ['15m', '1h', '4h', '1d'];

// ─── Helpers ────────────────────────────────────────────────────────

function findDataDir(): string | null {
  try {
    if (!fs.existsSync(GROUPS_DIR)) return null;
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const dataDir = path.join(
        GROUPS_DIR,
        folder,
        'freqtrade-user-data',
        'data',
      );
      if (fs.existsSync(dataDir)) return dataDir;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function dockerExecAsync(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `Docker download failed: ${err.message}\nstderr: ${stderr}`,
            ),
          );
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
        }
      },
    );
  });
}

// ─── File Sync ──────────────────────────────────────────────────────

/**
 * Sync files from dataDir/futures/ to dataDir/binance/futures/.
 * Only copies when source is newer than destination (or dest doesn't exist).
 */
function syncFuturesToBinance(dataDir: string): number {
  const srcDir = path.join(dataDir, 'futures');
  const dstDir = path.join(dataDir, 'binance', 'futures');

  if (!fs.existsSync(srcDir)) {
    logger.debug('No futures/ directory to sync');
    return 0;
  }

  fs.mkdirSync(dstDir, { recursive: true });
  let synced = 0;

  function syncDir(src: string, dst: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        syncDir(srcPath, dstPath);
      } else if (entry.isFile()) {
        const srcStat = fs.statSync(srcPath);
        let needsCopy = true;
        if (fs.existsSync(dstPath)) {
          const dstStat = fs.statSync(dstPath);
          needsCopy = srcStat.mtimeMs > dstStat.mtimeMs;
        }
        if (needsCopy) {
          fs.copyFileSync(srcPath, dstPath);
          synced++;
        }
      }
    }
  }

  syncDir(srcDir, dstDir);
  return synced;
}

// ─── Main Download ──────────────────────────────────────────────────

async function runDownload(): Promise<void> {
  const now = new Date();
  logger.info('Data download starting');

  const dataDir = findDataDir();
  if (!dataDir) {
    logger.error('No freqtrade data directory found — skipping download');
    return;
  }

  // Build docker args
  const dockerArgs = [
    'run',
    '--rm',
    '-v',
    `${dataDir}:/freqtrade/user_data/data`,
    BOT_IMAGE,
    'download-data',
    '--pairs',
    ...PAIRS,
    '--timeframes',
    ...TIMEFRAMES,
    '--exchange',
    'binance',
    '--trading-mode',
    'futures',
    '--days',
    '365',
    '--datadir',
    '/freqtrade/user_data/data',
  ];

  try {
    await dockerExecAsync(dockerArgs, DOWNLOAD_TIMEOUT_MS);
    logger.info('Data download completed');
  } catch (err) {
    logger.error({ err }, 'Data download failed');
    return;
  }

  // Sync futures/ → binance/futures/
  try {
    const synced = syncFuturesToBinance(dataDir);
    if (synced > 0) {
      logger.info({ synced }, 'Synced files from futures/ to binance/futures/');
    }
  } catch (err) {
    logger.error({ err }, 'File sync failed');
  }

  logger.info(
    { elapsed: Date.now() - now.getTime() },
    'Data download tick complete',
  );
}

// ─── Service Entry Point ────────────────────────────────────────────

let downloadTimer: ReturnType<typeof setInterval> | null = null;

export function startDataDownloader(): void {
  logger.info({ intervalMs: INTERVAL_MS }, 'Data downloader started');

  // Check if we should run immediately or wait
  // Run at ~3 AM local time (matching the original cron: 0 3 * * *)
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(3, 0, 0, 0);
  if (nextRun.getTime() <= now.getTime()) {
    // Already past 3 AM today, schedule for tomorrow
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const delayMs = nextRun.getTime() - now.getTime();
  logger.info(
    { nextRunAt: nextRun.toISOString(), delayMinutes: Math.round(delayMs / 60000) },
    'First download scheduled',
  );

  setTimeout(() => {
    runDownload().catch((err) =>
      logger.error({ err }, 'Data download failed'),
    );

    // Then every 24 hours
    downloadTimer = setInterval(() => {
      runDownload().catch((err) =>
        logger.error({ err }, 'Data download failed'),
      );
    }, INTERVAL_MS);
  }, delayMs);
}

export function stopDataDownloader(): void {
  if (downloadTimer) {
    clearInterval(downloadTimer);
    downloadTimer = null;
    logger.info('Data downloader stopped');
  }
}

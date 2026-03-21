/**
 * Host-side swarm request runner.
 *
 * Watches {SWARM_REPORT_DIR}/requests/ for new .request.json files
 * submitted by container agents via swarm_trigger_run MCP tool.
 * For each request:
 *   1. Read request manifest and spec JSON
 *   2. Spawn `python -m src job submit --spec <path> --report-dir <dir>`
 *   3. Write {run_id}.status.json with live status
 *   4. On exit: update to completed/failed with exit code
 *
 * Respects .cancel marker files to kill running processes.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const POLL_MS = 3000;
const MAX_CONCURRENT_SWARM_JOBS = 2;
const SWARM_REPORT_DIR =
  process.env.SWARM_REPORT_DIR || path.join(DATA_DIR, 'swarm-reports');
const REQUEST_DIR = path.join(SWARM_REPORT_DIR, 'requests');
const FREQTRADE_SWARM_DIR = process.env.FREQTRADE_SWARM_DIR || '';

interface RunningJob {
  runId: string;
  process: ChildProcess;
  startedAt: string;
}

const activeJobs = new Map<string, RunningJob>();
let running = false;

function writeStatus(runId: string, status: Record<string, unknown>): void {
  const statusPath = path.join(REQUEST_DIR, `${runId}.status.json`);
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

function processRequest(requestFile: string): void {
  const runId = path.basename(requestFile, '.request.json');

  // Skip if already processing or completed
  const statusPath = path.join(REQUEST_DIR, `${runId}.status.json`);
  if (fs.existsSync(statusPath)) return;
  if (activeJobs.has(runId)) return;

  // Read request manifest
  const requestPath = path.join(REQUEST_DIR, requestFile);
  let manifest: { run_id: string; run_type: string; submitted_at: string };
  try {
    manifest = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  } catch (e) {
    logger.error({ err: e, runId }, 'Failed to read request manifest');
    return;
  }

  // Read spec (may still be flushing from container — retry on next poll if missing)
  const specPath = path.join(REQUEST_DIR, `${runId}.spec.json`);
  if (!fs.existsSync(specPath)) {
    logger.debug({ runId }, 'Spec file not yet available, will retry');
    return;
  }

  if (!FREQTRADE_SWARM_DIR) {
    logger.error(
      { runId },
      'FREQTRADE_SWARM_DIR not set — cannot run swarm jobs',
    );
    writeStatus(runId, {
      run_id: runId,
      status: 'failed',
      error: 'FREQTRADE_SWARM_DIR environment variable not configured',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    return;
  }

  const startedAt = new Date().toISOString();

  // Write running status
  writeStatus(runId, {
    run_id: runId,
    status: 'running',
    run_type: manifest.run_type,
    started_at: startedAt,
    pid: null, // filled after spawn
  });

  // Spawn the freqtrade-swarm process
  const reportDir = path.join(SWARM_REPORT_DIR, 'jobs', runId);
  fs.mkdirSync(reportDir, { recursive: true });

  const child = spawn(
    'python',
    [
      '-m',
      'src',
      'job',
      'submit',
      '--spec',
      specPath,
      '--report-dir',
      reportDir,
    ],
    {
      cwd: FREQTRADE_SWARM_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const job: RunningJob = { runId, process: child, startedAt };
  activeJobs.set(runId, job);

  // Update status with PID
  writeStatus(runId, {
    run_id: runId,
    status: 'running',
    run_type: manifest.run_type,
    started_at: startedAt,
    pid: child.pid,
  });

  logger.info(
    { runId, pid: child.pid, runType: manifest.run_type },
    'Swarm job started',
  );

  // Capture output
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on('close', (code) => {
    activeJobs.delete(runId);
    const finishedAt = new Date().toISOString();
    const succeeded = code === 0;

    // Try to read summary stats from results.json for the status
    let summary: Record<string, unknown> | undefined;
    if (succeeded) {
      try {
        const resultsPath = path.join(reportDir, 'latest', 'results.json');
        if (fs.existsSync(resultsPath)) {
          const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
          summary = {
            total_combinations: results.results?.length ?? 0,
            total_backtests: results.total_backtests ?? 0,
            successful_backtests: results.successful_backtests ?? 0,
            failed_backtests: results.failed_backtests ?? 0,
            top_combo: results.top_k?.[0]
              ? `${results.top_k[0].pair} ${results.top_k[0].timeframe} (score=${results.top_k[0].composite_score?.toFixed(3)})`
              : null,
          };
        }
      } catch {
        // Non-critical — status still written without summary
      }
    }

    writeStatus(runId, {
      run_id: runId,
      status: succeeded ? 'completed' : 'failed',
      run_type: manifest.run_type,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: code,
      report_dir: reportDir,
      ...(summary ? { summary } : {}),
      ...(stderr && !succeeded ? { error: stderr.slice(0, 2000) } : {}),
    });

    if (succeeded) {
      logger.info({ runId, code }, 'Swarm job completed');
    } else {
      logger.error(
        { runId, code, stderr: stderr.slice(0, 500) },
        'Swarm job failed',
      );
    }
  });

  child.on('error', (err) => {
    activeJobs.delete(runId);
    writeStatus(runId, {
      run_id: runId,
      status: 'failed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error: `Spawn error: ${err.message}`,
    });
    logger.error({ runId, err }, 'Failed to spawn swarm process');
  });
}

function checkCancellations(): void {
  for (const [runId, job] of activeJobs) {
    const cancelPath = path.join(REQUEST_DIR, `${runId}.cancel`);
    if (fs.existsSync(cancelPath)) {
      logger.info({ runId, pid: job.process.pid }, 'Cancelling swarm job');
      job.process.kill('SIGTERM');
      activeJobs.delete(runId);
      writeStatus(runId, {
        run_id: runId,
        status: 'cancelled',
        started_at: job.startedAt,
        finished_at: new Date().toISOString(),
      });
      // Clean up cancel marker
      try {
        fs.unlinkSync(cancelPath);
      } catch {
        // ignore
      }
    }
  }
}

function pollRequests(): void {
  if (!running) return;

  try {
    if (!fs.existsSync(REQUEST_DIR)) {
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
    }

    // Check for cancellations first
    checkCancellations();

    // Look for new requests (respect concurrency limit)
    if (activeJobs.size >= MAX_CONCURRENT_SWARM_JOBS) {
      setTimeout(pollRequests, POLL_MS);
      return;
    }

    const files = fs
      .readdirSync(REQUEST_DIR)
      .filter((f) => f.endsWith('.request.json'));

    for (const file of files) {
      if (activeJobs.size >= MAX_CONCURRENT_SWARM_JOBS) break;
      processRequest(file);
    }
  } catch (err) {
    logger.error({ err }, 'Error polling swarm requests');
  }

  setTimeout(pollRequests, POLL_MS);
}

export function startSwarmRunner(): void {
  if (running) {
    logger.debug('Swarm runner already running, skipping duplicate start');
    return;
  }
  running = true;

  fs.mkdirSync(REQUEST_DIR, { recursive: true });
  logger.info(
    { requestDir: REQUEST_DIR, swarmDir: FREQTRADE_SWARM_DIR || '(not set)' },
    'Swarm request runner started',
  );

  pollRequests();
}

export function stopSwarmRunner(): void {
  running = false;
  for (const [runId, job] of activeJobs) {
    logger.info({ runId }, 'Stopping swarm job on shutdown');
    job.process.kill('SIGTERM');
  }
  activeJobs.clear();
}

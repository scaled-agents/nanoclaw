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
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const swarmEnv = readEnvFile(['SWARM_REPORT_DIR', 'FREQSWARM_DIR']);

const POLL_MS = 3000;
const MAX_CONCURRENT_SWARM_JOBS = 2;
const SWARM_REPORT_DIR =
  process.env.SWARM_REPORT_DIR ||
  swarmEnv.SWARM_REPORT_DIR ||
  path.join(DATA_DIR, 'swarm-reports');
const REQUEST_DIR = path.join(SWARM_REPORT_DIR, 'requests');
const FREQSWARM_DIR = process.env.FREQSWARM_DIR || swarmEnv.FREQSWARM_DIR || '';

export interface SwarmRunnerDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, { folder: string; name: string }>;
}

interface RunningJob {
  runId: string;
  process: ChildProcess;
  startedAt: string;
  chatJid?: string;
  runType?: string;
}

const activeJobs = new Map<string, RunningJob>();
let running = false;
let deps: SwarmRunnerDeps | undefined;

/** Max job duration before watchdog kills it (2 hours) */
const MAX_JOB_DURATION_MS = 2 * 60 * 60 * 1000;

/**
 * Resolve the chatJid for a job from the manifest's chat_jid field,
 * falling back to scanning registeredGroups by group_folder.
 */
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

/**
 * Send a notification message to the user who submitted a swarm job.
 */
function notifyUser(chatJid: string | undefined, text: string): void {
  if (!chatJid || !deps) return;
  deps
    .sendMessage(chatJid, text)
    .catch((err) =>
      logger.error({ err, chatJid }, 'Failed to send swarm job notification'),
    );
}

function writeStatus(runId: string, status: Record<string, unknown>): void {
  const statusPath = path.join(REQUEST_DIR, `${runId}.status.json`);
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

/**
 * Copy strategy .py files from the group's freqtrade-user-data into the
 * swarm's strategies directory so FreqSwarm can find them.
 * Extracts strategy names from the spec JSON and copies only those files.
 */
function copyGroupStrategiesToSwarm(
  groupFolder: string,
  specPath: string,
): void {
  const swarmStrategiesDir = path.join(
    FREQSWARM_DIR,
    'data',
    'user_data',
    'strategies',
  );
  fs.mkdirSync(swarmStrategiesDir, { recursive: true });

  const srcDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    'freqtrade-user-data',
    'strategies',
  );
  if (!fs.existsSync(srcDir)) {
    logger.warn(
      { srcDir },
      'Group strategies dir not found — swarm may not locate strategy',
    );
    return;
  }

  // Extract strategy names from the spec
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
  } catch {
    logger.warn({ specPath }, 'Could not parse spec for strategy copy');
    return;
  }

  const names = new Set<string>();

  // Matrix sweep: spec.genome.identity.name or spec.strategy_name
  const genome = spec.genome as Record<string, unknown> | undefined;
  if (genome?.identity) {
    const identity = genome.identity as Record<string, unknown>;
    if (identity.name) names.add(String(identity.name));
  }
  if (spec.strategy_name) names.add(String(spec.strategy_name));

  // Autoresearch: spec.seed_genomes[].genome.identity.name
  if (Array.isArray(spec.seed_genomes)) {
    for (const sg of spec.seed_genomes as Record<string, unknown>[]) {
      const sgGenome = sg.genome as Record<string, unknown> | undefined;
      if (sgGenome?.identity) {
        const identity = sgGenome.identity as Record<string, unknown>;
        if (identity.name) names.add(String(identity.name));
      }
    }
  }

  // Batch backtest: spec.strategies[] (array of strategy class names)
  if (Array.isArray(spec.strategies)) {
    for (const s of spec.strategies as string[]) {
      if (s) names.add(String(s));
    }
  }

  if (names.size === 0) {
    // Fallback: copy ALL .py files from the group's strategies dir
    logger.info(
      { srcDir },
      'No strategy names found in spec — copying all .py files',
    );
    for (const file of fs.readdirSync(srcDir)) {
      if (file.endsWith('.py')) {
        fs.copyFileSync(
          path.join(srcDir, file),
          path.join(swarmStrategiesDir, file),
        );
      }
    }
    return;
  }

  for (const name of names) {
    const src = path.join(srcDir, `${name}.py`);
    if (fs.existsSync(src)) {
      const dst = path.join(swarmStrategiesDir, `${name}.py`);
      fs.copyFileSync(src, dst);
      logger.info({ name, dst }, 'Copied strategy to swarm strategies dir');
    } else {
      logger.warn(
        { name, src },
        'Strategy .py not found in group strategies dir',
      );
    }
  }
}

/**
 * Ensure a freqtrade config file exists in the swarm's data directory.
 * Copies the group's config if available, otherwise generates a minimal
 * backtest-only config from the spec's exchange settings.
 * Returns the swarm-local config path (relative to FREQSWARM_DIR).
 */
function ensureSwarmConfig(groupFolder: string, specPath: string): string {
  const swarmConfigDir = path.join(FREQSWARM_DIR, 'data', 'user_data');
  const swarmConfigPath = path.join(swarmConfigDir, 'config.json');

  // Try to copy the group's binance futures config
  const groupConfigDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    'freqtrade-user-data',
  );
  const groupConfig = path.join(groupConfigDir, 'config_binance_futures.json');

  if (fs.existsSync(groupConfig)) {
    fs.mkdirSync(swarmConfigDir, { recursive: true });
    fs.copyFileSync(groupConfig, swarmConfigPath);
    // freqtrade 2026.2 requires price_side="other" for lookahead analysis
    try {
      const cfg = JSON.parse(fs.readFileSync(swarmConfigPath, 'utf-8'));
      let patched = false;
      if (
        cfg.entry_pricing?.price_side &&
        cfg.entry_pricing.price_side !== 'other'
      ) {
        cfg.entry_pricing.price_side = 'other';
        patched = true;
      }
      if (
        cfg.exit_pricing?.price_side &&
        cfg.exit_pricing.price_side !== 'other'
      ) {
        cfg.exit_pricing.price_side = 'other';
        patched = true;
      }
      if (patched) {
        fs.writeFileSync(swarmConfigPath, JSON.stringify(cfg, null, 2));
        logger.info(
          { dst: swarmConfigPath },
          'Patched price_side to "other" for freqtrade 2026.2',
        );
      }
    } catch {
      // Non-critical — config still usable without patch
    }
    logger.info(
      { src: groupConfig, dst: swarmConfigPath },
      'Copied group config to swarm',
    );
    return './data/user_data/config.json';
  }

  // No group config — generate a minimal one from the spec
  let exchange = 'binance';
  let tradingMode = 'futures';
  let marginMode = 'isolated';

  try {
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    if (spec.exchange) exchange = spec.exchange;
    const genome = spec.genome as Record<string, unknown> | undefined;
    const exch = genome?.exchange as Record<string, string> | undefined;
    if (exch?.name) exchange = exch.name;
    if (exch?.trading_mode) tradingMode = exch.trading_mode;
    if (exch?.margin_mode) marginMode = exch.margin_mode;
  } catch {
    // Use defaults
  }

  const minimalConfig = {
    trading_mode: tradingMode,
    margin_mode: marginMode,
    stake_currency: 'USDT',
    stake_amount: 'unlimited',
    dry_run: true,
    dry_run_wallet: 1000,
    max_open_trades: 1,
    exchange: {
      name: exchange,
      key: '',
      secret: '',
    },
    entry_pricing: { price_side: 'other' },
    exit_pricing: { price_side: 'other' },
    pairlists: [{ method: 'StaticPairList' }],
  };

  fs.mkdirSync(swarmConfigDir, { recursive: true });
  fs.writeFileSync(swarmConfigPath, JSON.stringify(minimalConfig, null, 2));
  logger.info(
    { dst: swarmConfigPath, exchange, tradingMode },
    'Generated minimal swarm config',
  );
  return './data/user_data/config.json';
}

/**
 * Rewrite the spec's config_path to point to a swarm-local config file.
 * Writes a new spec file in the report directory and returns its path.
 */
function rewriteSpecConfigPath(
  specPath: string,
  reportDir: string,
  swarmConfigPath: string,
): string {
  try {
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    const originalPath = spec.config_path;
    spec.config_path = swarmConfigPath;
    const rewrittenPath = path.join(reportDir, 'spec_rewritten.json');
    fs.writeFileSync(rewrittenPath, JSON.stringify(spec, null, 2));
    logger.debug(
      { original: originalPath, rewritten: swarmConfigPath },
      'Rewrote spec config_path for swarm',
    );
    return rewrittenPath;
  } catch (err) {
    logger.warn(
      { err, specPath },
      'Failed to rewrite spec config_path — using original',
    );
    return specPath;
  }
}

function processRequest(requestFile: string): void {
  const runId = path.basename(requestFile, '.request.json');

  // Skip if already processing or completed
  const statusPath = path.join(REQUEST_DIR, `${runId}.status.json`);
  if (fs.existsSync(statusPath)) return;
  if (activeJobs.has(runId)) return;

  // Read request manifest
  const requestPath = path.join(REQUEST_DIR, requestFile);
  let manifest: {
    run_id: string;
    run_type: string;
    submitted_at: string;
    workers?: number;
    priority?: string;
    group_folder?: string;
    chat_jid?: string;
  };
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

  if (!FREQSWARM_DIR) {
    logger.error({ runId }, 'FREQSWARM_DIR not set — cannot run swarm jobs');
    writeStatus(runId, {
      run_id: runId,
      status: 'failed',
      error: 'FREQSWARM_DIR environment variable not configured',
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

  // Spawn the FreqSwarm process
  const reportDir = path.join(SWARM_REPORT_DIR, 'jobs', runId);
  fs.mkdirSync(reportDir, { recursive: true });

  // Copy strategy files and ensure config exists in swarm dir
  let effectiveSpecPath = specPath;
  if (manifest.group_folder) {
    copyGroupStrategiesToSwarm(manifest.group_folder, specPath);
    const swarmConfigPath = ensureSwarmConfig(manifest.group_folder, specPath);
    effectiveSpecPath = rewriteSpecConfigPath(
      specPath,
      reportDir,
      swarmConfigPath,
    );
  }

  // Pass workers count as env var (default 4, capped at 8)
  const workers = Math.min(manifest.workers || 4, 8);

  // Route by run_type: each type uses a different CLI subcommand
  let pythonArgs: string[];
  if (manifest.run_type === 'strategy_scan') {
    // Read strategy_name from spec
    let strategyName = '';
    try {
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
      strategyName = spec.strategy_name || '';
    } catch {
      // Will fail below
    }
    if (!strategyName) {
      writeStatus(runId, {
        run_id: runId,
        status: 'failed',
        run_type: manifest.run_type,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: 'strategy_scan spec must contain strategy_name',
      });
      return;
    }
    const swarmStrategiesDir = path.join(
      FREQSWARM_DIR,
      'data',
      'user_data',
      'strategies',
    );
    pythonArgs = [
      '-m',
      'src',
      'scan',
      strategyName,
      '--strategies-dir',
      swarmStrategiesDir,
    ];
  } else if (manifest.run_type === 'autoresearch') {
    pythonArgs = [
      '-m',
      'src',
      'autoresearch',
      'submit',
      '--spec',
      effectiveSpecPath,
      '--report-dir',
      reportDir,
    ];
  } else if (manifest.run_type === 'batch_backtest') {
    pythonArgs = [
      '-m',
      'src',
      'batch',
      'submit',
      '--spec',
      effectiveSpecPath,
      '--report-dir',
      reportDir,
    ];
  } else {
    pythonArgs = [
      '-m',
      'src',
      'job',
      'submit',
      '--spec',
      effectiveSpecPath,
      '--report-dir',
      reportDir,
    ];
  }

  const child = spawn('python', pythonArgs, {
    cwd: FREQSWARM_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MAX_CONCURRENT_BACKTESTS: String(workers) },
  });

  const chatJid = resolveJobChatJid(
    manifest as { chat_jid?: string; group_folder?: string },
  );
  const job: RunningJob = {
    runId,
    process: child,
    startedAt,
    chatJid,
    runType: manifest.run_type,
  };
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

    // For strategy_scan: parse JSON from stdout and embed in status
    if (manifest.run_type === 'strategy_scan') {
      let scanResult: Record<string, unknown> | undefined;
      if (succeeded) {
        try {
          scanResult = JSON.parse(stdout.trim());
        } catch {
          // stdout was not valid JSON
        }
      }
      writeStatus(runId, {
        run_id: runId,
        status: succeeded ? 'completed' : 'failed',
        run_type: 'strategy_scan',
        started_at: startedAt,
        finished_at: finishedAt,
        exit_code: code,
        ...(scanResult ? { result: scanResult } : {}),
        ...(stderr && !succeeded ? { error: stderr.slice(0, 2000) } : {}),
      });
      if (succeeded && scanResult) {
        const eligibility = (scanResult as Record<string, unknown>)
          .mutation_eligibility as Record<string, unknown> | undefined;
        const families = eligibility?.eligible_patch_families as
          | string[]
          | undefined;
        notifyUser(
          job.chatJid,
          `Strategy scan complete for ${(scanResult as Record<string, unknown>).strategy_ref ? JSON.stringify((scanResult as Record<string, unknown>).strategy_ref) : 'unknown'}.\nEligible families: ${families?.join(', ') || 'none'}`,
        );
      }
      return;
    }

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

    // On failure: extract common_error and validation_error from Python-side output
    let commonError: string | undefined;
    let validationError: boolean | undefined;
    if (!succeeded) {
      try {
        const resultsPath = path.join(reportDir, 'latest', 'results.json');
        if (fs.existsSync(resultsPath)) {
          const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
          commonError = results.common_error;
        }
        const pyStatusPath = path.join(reportDir, 'latest', 'status.json');
        if (fs.existsSync(pyStatusPath)) {
          const pyStatus = JSON.parse(fs.readFileSync(pyStatusPath, 'utf-8'));
          if (!commonError)
            commonError = pyStatus.common_error || pyStatus.error;
          validationError = pyStatus.validation_error;
        }
      } catch {
        // Non-critical — status still written without enrichment
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
      ...(commonError ? { common_error: commonError } : {}),
      ...(validationError ? { validation_error: true } : {}),
    });

    if (succeeded) {
      logger.info(
        { runId, code, ...(stderr ? { stderr: stderr.slice(0, 500) } : {}) },
        'Swarm job completed',
      );
      const topCombo = summary?.top_combo ? `\nTop: ${summary.top_combo}` : '';
      notifyUser(
        job.chatJid,
        `Swarm job \`${runId}\` completed (${manifest.run_type || 'unknown'}).${topCombo}`,
      );
    } else {
      logger.error(
        { runId, code, stderr: stderr.slice(0, 500) },
        'Swarm job failed',
      );
      const reason = commonError || stderr.slice(0, 300) || `exit code ${code}`;
      notifyUser(
        job.chatJid,
        `Swarm job \`${runId}\` failed (${manifest.run_type || 'unknown'}).\nReason: ${reason}`,
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
    notifyUser(
      chatJid,
      `Swarm job \`${runId}\` failed to start: ${err.message}`,
    );
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
      notifyUser(job.chatJid, `Swarm job \`${runId}\` cancelled.`);
      // Clean up cancel marker
      try {
        fs.unlinkSync(cancelPath);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Watchdog: kill jobs that exceed MAX_JOB_DURATION_MS.
 * Prevents zombie jobs from running forever without feedback.
 */
function checkJobTimeouts(): void {
  const now = Date.now();
  for (const [runId, job] of activeJobs) {
    const elapsed = now - new Date(job.startedAt).getTime();
    if (elapsed > MAX_JOB_DURATION_MS) {
      const durationMin = Math.round(elapsed / 60000);
      logger.warn(
        { runId, pid: job.process.pid, durationMin },
        'Swarm job exceeded max duration, killing',
      );
      job.process.kill('SIGTERM');
      activeJobs.delete(runId);
      writeStatus(runId, {
        run_id: runId,
        status: 'failed',
        run_type: job.runType,
        started_at: job.startedAt,
        finished_at: new Date().toISOString(),
        error: `Job killed by watchdog after ${durationMin} minutes (max ${MAX_JOB_DURATION_MS / 60000} min)`,
      });
      notifyUser(
        job.chatJid,
        `Swarm job \`${runId}\` killed by watchdog — ran for ${durationMin} min without completing. This usually means the process is stuck.`,
      );
    }
  }
}

function pollRequests(): void {
  if (!running) return;

  try {
    if (!fs.existsSync(REQUEST_DIR)) {
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
    }

    // Check for cancellations and timeouts first
    checkCancellations();
    checkJobTimeouts();

    // Look for new requests (respect concurrency limit)
    if (activeJobs.size >= MAX_CONCURRENT_SWARM_JOBS) {
      setTimeout(pollRequests, POLL_MS);
      return;
    }

    const files = fs
      .readdirSync(REQUEST_DIR)
      .filter((f) => f.endsWith('.request.json'));

    // Sort by priority (high first) then by submission time
    const sorted = files
      .map((file) => {
        try {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(REQUEST_DIR, file), 'utf-8'),
          );
          return {
            file,
            priority: manifest.priority || 'normal',
            submitted_at: manifest.submitted_at || '',
          };
        } catch {
          return { file, priority: 'normal', submitted_at: '' };
        }
      })
      .sort((a, b) => {
        if (a.priority === 'high' && b.priority !== 'high') return -1;
        if (b.priority === 'high' && a.priority !== 'high') return 1;
        return a.submitted_at.localeCompare(b.submitted_at);
      });

    for (const { file } of sorted) {
      if (activeJobs.size >= MAX_CONCURRENT_SWARM_JOBS) break;
      processRequest(file);
    }
  } catch (err) {
    logger.error({ err }, 'Error polling swarm requests');
  }

  setTimeout(pollRequests, POLL_MS);
}

export function startSwarmRunner(runnerDeps?: SwarmRunnerDeps): void {
  if (running) {
    logger.debug('Swarm runner already running, skipping duplicate start');
    return;
  }
  deps = runnerDeps;

  // Validate configuration before starting
  if (!FREQSWARM_DIR) {
    logger.warn(
      'FREQSWARM_DIR not set — swarm runner disabled. Set it in .env to enable matrix sweeps.',
    );
    return;
  }
  if (!fs.existsSync(FREQSWARM_DIR)) {
    logger.warn(
      { swarmDir: FREQSWARM_DIR },
      'FREQSWARM_DIR does not exist — swarm runner disabled',
    );
    return;
  }
  if (!path.isAbsolute(SWARM_REPORT_DIR)) {
    logger.warn(
      { reportDir: SWARM_REPORT_DIR },
      'SWARM_REPORT_DIR is a relative path — this may cause mount mismatches. Use an absolute path in .env.',
    );
  }

  running = true;

  fs.mkdirSync(REQUEST_DIR, { recursive: true });
  logger.info(
    {
      requestDir: REQUEST_DIR,
      swarmDir: FREQSWARM_DIR,
      workers: 'env-passthrough',
    },
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

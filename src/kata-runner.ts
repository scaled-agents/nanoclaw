/**
 * Host-side kata race runner.
 *
 * Watches data/kata-runner/requests/ for .request.json files submitted by
 * container agents via kata_* MCP tools. Manages persistent Docker containers
 * (one per race) running iterate_container.py for strategy optimization.
 *
 * Request types:
 *   start_race  — docker run a kata container for a race
 *   stop_race   — docker stop + rm the container
 *
 * Status files written to data/kata-runner/races/{race_id}.status.json
 * for agents to read back.
 *
 * Monitors kata-state.json inside race dirs every 30s to update status.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
} from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  hostGatewayArgs,
} from './container-runtime.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// ─── Configuration ──────────────────────────────────────────────────

const kataEnv = readEnvFile([
  'KATA_RUNNER_MAX_RACES',
  'KATA_RUNNER_KATA_DIR',
  'KATA_RUNNER_FT_CONFIG',
]);

const POLL_MS = 5_000;
const MONITOR_MS = 30_000;
const KATA_RUNNER_DIR = path.join(DATA_DIR, 'kata-runner');
const REQUEST_DIR = path.join(KATA_RUNNER_DIR, 'requests');
const RACES_DIR = path.join(KATA_RUNNER_DIR, 'races');

const MAX_RACES = parseInt(
  process.env.KATA_RUNNER_MAX_RACES || kataEnv.KATA_RUNNER_MAX_RACES || '3',
  10,
);

// kata/ dir on host — mounted as /app/kata:ro inside containers
const KATA_DIR =
  process.env.KATA_RUNNER_KATA_DIR ||
  kataEnv.KATA_RUNNER_KATA_DIR ||
  path.resolve(process.cwd(), '..', 'freqtrade-agents', 'kata');

// FreqTrade config.json on host
const FT_CONFIG =
  process.env.KATA_RUNNER_FT_CONFIG ||
  kataEnv.KATA_RUNNER_FT_CONFIG ||
  path.join(DATA_DIR, 'sessions', 'ft-config.json');

const CONTAINER_PREFIX = 'nanoclaw-kata-';

// ─── Types ──────────────────────────────────────────────────────────

interface KataRequest {
  type: 'start_race' | 'stop_race';
  race_id: string;
  candidate_name?: string;
  strategy_code?: string;
  pair?: string;
  timeframe?: string;
  archetype?: string;
  max_experiments?: number;
  group_folder?: string;
  confirm?: boolean; // for stop_race
  submitted_at: string;
}

interface RaceInstance {
  raceId: string;
  containerName: string;
  candidateName: string;
  pair: string;
  timeframe: string;
  archetype: string;
  maxExperiments: number;
  groupFolder: string;
  startedAt: string;
  status: 'running' | 'graduated' | 'stopped' | 'failed';
  error?: string;
}

interface RaceStatusFile {
  race_id: string;
  status: 'running' | 'graduated' | 'stopped' | 'failed';
  container_name: string;
  candidate_name: string;
  target: { archetype: string; pair: string; timeframe: string };
  experiments: number;
  max_experiments: number;
  current_score: number;
  best_score: number;
  sharpe_trajectory: number[];
  wf_pattern: string | null;
  dsr: number | null;
  pbo: number | null;
  graduate_path: string | null;
  started_at: string;
  updated_at: string;
  error: string | null;
}

// ─── State ──────────────────────────────────────────────────────────

const activeRaces = new Map<string, RaceInstance>();
const processingRequests = new Set<string>();
let running = false;
let monitorTimer: ReturnType<typeof setInterval> | undefined;

// ─── Helpers ────────────────────────────────────────────────────────

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

function writeRaceStatus(
  race: RaceInstance,
  extra?: Partial<RaceStatusFile>,
): void {
  const statusPath = path.join(RACES_DIR, `${race.raceId}.status.json`);

  // Preserve fields from previous status
  let prev: Partial<RaceStatusFile> = {};
  try {
    if (fs.existsSync(statusPath)) {
      prev = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    }
  } catch {
    /* rewrite from scratch */
  }

  const statusFile: RaceStatusFile = {
    race_id: race.raceId,
    status: race.status,
    container_name: race.containerName,
    candidate_name: race.candidateName,
    target: {
      archetype: race.archetype,
      pair: race.pair,
      timeframe: race.timeframe,
    },
    experiments: prev.experiments || 0,
    max_experiments: race.maxExperiments,
    current_score: prev.current_score || 0,
    best_score: prev.best_score || 0,
    sharpe_trajectory: prev.sharpe_trajectory || [],
    wf_pattern: prev.wf_pattern || null,
    dsr: prev.dsr ?? null,
    pbo: prev.pbo ?? null,
    graduate_path: prev.graduate_path || null,
    started_at: race.startedAt,
    updated_at: new Date().toISOString(),
    error: race.error || null,
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
 * Resolve the race directory on the host filesystem.
 * Race dirs live at groups/{folder}/races/{race_id}/
 */
function resolveRaceDir(raceId: string, groupFolder?: string): string {
  if (groupFolder) {
    const raceDir = path.join(GROUPS_DIR, groupFolder, 'races', raceId);
    if (fs.existsSync(raceDir)) return raceDir;
  }
  // Scan all groups
  for (const folder of fs.readdirSync(GROUPS_DIR)) {
    const candidate = path.join(GROUPS_DIR, folder, 'races', raceId);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Create in the first group or specified group
  const target = groupFolder || fs.readdirSync(GROUPS_DIR)[0];
  const raceDir = path.join(GROUPS_DIR, target, 'races', raceId);
  fs.mkdirSync(raceDir, { recursive: true });
  return raceDir;
}

/**
 * Resolve the knowledge directory for a group.
 */
function resolveKnowledgeDir(groupFolder?: string): string {
  if (groupFolder) {
    const dir = path.join(GROUPS_DIR, groupFolder, 'knowledge');
    if (fs.existsSync(dir)) return dir;
  }
  // Scan groups
  for (const folder of fs.readdirSync(GROUPS_DIR)) {
    const dir = path.join(GROUPS_DIR, folder, 'knowledge');
    if (fs.existsSync(dir)) return dir;
  }
  // Create default
  const target = groupFolder || fs.readdirSync(GROUPS_DIR)[0];
  const dir = path.join(GROUPS_DIR, target, 'knowledge');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve FreqTrade data directory (OHLCV data).
 */
function resolveDataDir(): string {
  // Check for group-level freqtrade data
  for (const folder of fs.readdirSync(GROUPS_DIR)) {
    const ftData = path.join(
      DATA_DIR,
      'sessions',
      folder,
      'freqtrade-user-data',
      'data',
    );
    if (fs.existsSync(ftData)) return ftData;
  }
  // Fallback
  return path.join(DATA_DIR, 'freqtrade-data');
}

/**
 * Copy the graduate strategy file from the race dir to data/kata-runner/races/
 * so agent containers can read it via the read-only mount.
 */
function copyGraduateToRacesDir(raceId: string, raceDir: string): void {
  try {
    // Try graduates/ directory first
    const graduatesDir = path.join(raceDir, 'graduates');
    let sourceFile: string | null = null;

    if (fs.existsSync(graduatesDir)) {
      const pyFiles = fs
        .readdirSync(graduatesDir)
        .filter((f) => f.endsWith('.py'))
        .sort()
        .reverse();
      if (pyFiles.length > 0) {
        sourceFile = path.join(graduatesDir, pyFiles[0]);
      }
    }

    // Fallback: best_strategy.py
    if (!sourceFile) {
      const bestPath = path.join(raceDir, 'best_strategy.py');
      if (fs.existsSync(bestPath)) sourceFile = bestPath;
    }

    if (sourceFile) {
      const destPath = path.join(RACES_DIR, `${raceId}.graduate.py`);
      fs.copyFileSync(sourceFile, destPath);
      logger.info(
        { raceId, source: sourceFile },
        'Copied graduate to races dir',
      );
    }
  } catch (err) {
    logger.warn({ raceId, err }, 'Failed to copy graduate file');
  }
}

// ─── Container Lifecycle ────────────────────────────────────────────

async function startRaceContainer(req: KataRequest): Promise<RaceInstance> {
  const raceId = req.race_id;
  const containerName = `${CONTAINER_PREFIX}${raceId}`;

  // Check concurrent limit
  const runningCount = Array.from(activeRaces.values()).filter(
    (r) => r.status === 'running',
  ).length;
  if (runningCount >= MAX_RACES) {
    throw new Error(
      `Max concurrent races reached (${MAX_RACES}). Stop a race first.`,
    );
  }

  // If already running, stop first
  if (activeRaces.has(raceId)) {
    logger.info({ raceId }, 'start_race: stopping existing race first');
    removeContainer(containerName);
    activeRaces.delete(raceId);
  }

  const raceDir = resolveRaceDir(raceId, req.group_folder);
  const knowledgeDir = resolveKnowledgeDir(req.group_folder);
  const dataDir = resolveDataDir();

  // Write strategy code to race dir
  if (req.strategy_code) {
    fs.writeFileSync(path.join(raceDir, 'agent.py'), req.strategy_code);
  }

  // Ensure agent.py exists
  const agentPath = path.join(raceDir, 'agent.py');
  if (!fs.existsSync(agentPath)) {
    throw new Error(`No strategy file at ${agentPath}`);
  }

  // Pre-launch validation: catch environment problems before container start
  if (!fs.existsSync(FT_CONFIG) || !fs.statSync(FT_CONFIG).isFile()) {
    const isDir =
      fs.existsSync(FT_CONFIG) && fs.statSync(FT_CONFIG).isDirectory();
    throw new Error(
      `Kata pre-launch failed: FT_CONFIG ${isDir ? 'is a directory' : 'does not exist'}: ${FT_CONFIG}. ` +
        (isDir
          ? 'Delete it and create a proper FreqTrade config JSON file.'
          : ''),
    );
  }
  if (!fs.existsSync(dataDir)) {
    throw new Error(
      `Kata pre-launch failed: data directory does not exist: ${dataDir}`,
    );
  }

  // Clean up existing container
  removeContainer(containerName);

  const pair = req.pair || 'BTC/USDT:USDT';
  const timeframe = req.timeframe || '4h';
  const maxExperiments = req.max_experiments || 50;

  // Build docker run command
  // --entrypoint overrides the image's Node.js entrypoint so we can run Python directly
  const dockerArgs = [
    'run',
    '-d',
    '--name',
    containerName,
    '--entrypoint',
    'python3',
    // No --restart: kata containers are finite-duration jobs
    '-v',
    `${raceDir}:/workspace/race`,
    '-v',
    `${dataDir}:/freqtrade/user_data/data:ro`,
    '-v',
    `${knowledgeDir}:/workspace/knowledge`,
    '-v',
    `${KATA_DIR}:/app/kata:ro`,
    '-v',
    `${FT_CONFIG}:/freqtrade/user_data/config.json:ro`,
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    '-e',
    'ANTHROPIC_API_KEY=placeholder',
    '-e',
    `TARGET_PAIR=${pair}`,
    '-e',
    `TARGET_TIMEFRAME=${timeframe}`,
    ...hostGatewayArgs(),
    CONTAINER_IMAGE,
    '/app/kata/iterate_container.py',
    '--race-dir',
    '/workspace/race',
    '--data-dir',
    '/freqtrade/user_data/data',
    '--knowledge-dir',
    '/workspace/knowledge',
    '--max-experiments',
    String(maxExperiments),
    '--target-pair',
    pair,
    '--target-timeframe',
    timeframe,
  ];

  logger.info(
    { raceId, containerName, pair, timeframe, maxExperiments },
    'Starting kata race container',
  );

  // Retry with backoff for transient Docker failures (network, daemon restarts)
  const MAX_START_RETRIES = 3;
  const RETRY_DELAYS = [2_000, 5_000, 10_000];
  let lastStartError: Error | undefined;

  for (let attempt = 0; attempt < MAX_START_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        removeContainer(containerName);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
        logger.info(
          { raceId, attempt: attempt + 1 },
          'Retrying kata container start',
        );
      }
      // Use 120s timeout for docker run (volume mount sharing on Windows can be slow)
      dockerExec(dockerArgs, 120_000);
      lastStartError = undefined;
      break;
    } catch (err) {
      lastStartError = err as Error;
      logger.warn(
        { raceId, attempt: attempt + 1, error: (err as Error).message },
        'Docker run failed',
      );
    }
  }

  if (lastStartError) {
    throw new Error(
      `Failed to start kata container after ${MAX_START_RETRIES} attempts: ${lastStartError.message}`,
    );
  }

  const race: RaceInstance = {
    raceId,
    containerName,
    candidateName: req.candidate_name || raceId,
    pair,
    timeframe,
    archetype: req.archetype || 'UNKNOWN',
    maxExperiments,
    groupFolder: req.group_folder || '',
    startedAt: new Date().toISOString(),
    status: 'running',
  };

  activeRaces.set(raceId, race);
  writeRaceStatus(race);

  return race;
}

async function stopRaceContainer(raceId: string): Promise<void> {
  const race = activeRaces.get(raceId);
  const containerName = race?.containerName || `${CONTAINER_PREFIX}${raceId}`;

  logger.info({ raceId, containerName }, 'Stopping kata race container');
  removeContainer(containerName);

  if (race) {
    race.status = 'stopped';
    writeRaceStatus(race);
    activeRaces.delete(raceId);
  } else {
    // Update status file directly
    const statusPath = path.join(RACES_DIR, `${raceId}.status.json`);
    if (fs.existsSync(statusPath)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
        status.status = 'stopped';
        status.updated_at = new Date().toISOString();
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── Monitor ────────────────────────────────────────────────────────

/**
 * Poll kata-state.json from each active race's directory and update
 * the status file in data/kata-runner/races/.
 */
function monitorRaces(): void {
  for (const [raceId, race] of activeRaces) {
    if (race.status !== 'running') continue;

    // Check container health
    if (!isContainerRunning(race.containerName)) {
      logger.info({ raceId }, 'Kata container stopped — checking final state');
      race.status = 'stopped';

      // Read final kata-state to determine if graduated
      const raceDir = resolveRaceDir(raceId, race.groupFolder);
      const statePath = path.join(raceDir, 'kata-state.json');
      try {
        if (fs.existsSync(statePath)) {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
          if (state.status === 'graduated') {
            race.status = 'graduated';
            // Copy graduate file to races dir so agent MCP can read it
            copyGraduateToRacesDir(raceId, raceDir);
          } else if (state.status === 'failed') {
            race.status = 'failed';
            race.error = state.error || 'Unknown failure';
          }
          writeRaceStatus(race, {
            experiments: state.experiments || 0,
            current_score: state.current_score || 0,
            best_score: state.best_score || 0,
            sharpe_trajectory: state.sharpe_trajectory || [],
            wf_pattern: state.wf_pattern || null,
            dsr: state.dsr ?? null,
            pbo: state.pbo ?? null,
            graduate_path: state.graduate_path || null,
          });
        } else {
          writeRaceStatus(race);
        }
      } catch {
        writeRaceStatus(race);
      }

      activeRaces.delete(raceId);
      continue;
    }

    // Read kata-state.json from race dir
    const raceDir = resolveRaceDir(raceId, race.groupFolder);
    const statePath = path.join(raceDir, 'kata-state.json');
    try {
      if (!fs.existsSync(statePath)) continue;

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      // Update status based on kata-state
      if (state.status === 'graduated') {
        race.status = 'graduated';
        copyGraduateToRacesDir(raceId, raceDir);
        activeRaces.delete(raceId);
      } else if (state.status === 'failed') {
        race.status = 'failed';
        race.error = state.error || 'Unknown failure';
        activeRaces.delete(raceId);
      }

      writeRaceStatus(race, {
        experiments: state.experiments || 0,
        current_score: state.current_score || 0,
        best_score: state.best_score || 0,
        sharpe_trajectory: state.sharpe_trajectory || [],
        wf_pattern: state.wf_pattern || null,
        dsr: state.dsr ?? null,
        pbo: state.pbo ?? null,
        graduate_path: state.graduate_path || null,
      });
    } catch {
      // kata-state.json not ready yet — skip
    }
  }
}

// ─── Request Processing ─────────────────────────────────────────────

async function processRequest(requestFile: string): Promise<void> {
  const requestId = path.basename(requestFile, '.request.json');

  // Skip if already processed
  const statusPath = path.join(REQUEST_DIR, `${requestId}.status.json`);
  if (fs.existsSync(statusPath)) return;

  // Skip if in-flight
  if (processingRequests.has(requestId)) return;
  processingRequests.add(requestId);

  const requestPath = path.join(REQUEST_DIR, requestFile);
  let req: KataRequest;
  try {
    req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  } catch (e) {
    processingRequests.delete(requestId);
    logger.error({ err: e, requestId }, 'Failed to read kata request');
    return;
  }

  try {
    switch (req.type) {
      case 'start_race': {
        if (!req.race_id) {
          throw new Error('start_race requires race_id');
        }
        const race = await startRaceContainer(req);
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          race_id: req.race_id,
          container_name: race.containerName,
          started_at: race.startedAt,
        });
        break;
      }

      case 'stop_race': {
        if (!req.confirm) {
          throw new Error('stop_race requires confirm=true');
        }
        await stopRaceContainer(req.race_id);
        writeRequestStatus(requestId, {
          request_id: requestId,
          type: req.type,
          status: 'completed',
          race_id: req.race_id,
          stopped_at: new Date().toISOString(),
        });
        break;
      }

      default:
        throw new Error(`Unknown request type: ${req.type}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { requestId, err: msg, type: req.type },
      'Kata request failed',
    );
    writeRequestStatus(requestId, {
      request_id: requestId,
      type: req.type,
      status: 'failed',
      race_id: req.race_id,
      error: msg,
    });
  } finally {
    processingRequests.delete(requestId);
  }
}

// ─── Recovery ───────────────────────────────────────────────────────

function recoverExistingRaces(): void {
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
      const raceId = containerName.replace(CONTAINER_PREFIX, '');
      const statusPath = path.join(RACES_DIR, `${raceId}.status.json`);

      if (fs.existsSync(statusPath)) {
        try {
          const status: RaceStatusFile = JSON.parse(
            fs.readFileSync(statusPath, 'utf-8'),
          );
          const race: RaceInstance = {
            raceId,
            containerName,
            candidateName: status.candidate_name || raceId,
            pair: status.target?.pair || 'BTC/USDT:USDT',
            timeframe: status.target?.timeframe || '4h',
            archetype: status.target?.archetype || 'UNKNOWN',
            maxExperiments: status.max_experiments || 50,
            groupFolder: '',
            startedAt: status.started_at || new Date().toISOString(),
            status: 'running',
          };
          activeRaces.set(raceId, race);
          logger.info({ raceId, containerName }, 'Recovered kata race');
        } catch {
          logger.warn(
            { raceId },
            'Failed to parse race status — tracking container only',
          );
          activeRaces.set(raceId, {
            raceId,
            containerName,
            candidateName: raceId,
            pair: 'BTC/USDT:USDT',
            timeframe: '4h',
            archetype: 'UNKNOWN',
            maxExperiments: 50,
            groupFolder: '',
            startedAt: new Date().toISOString(),
            status: 'running',
          });
        }
      }
    }

    if (containers.length > 0) {
      logger.info(
        { count: containers.length },
        'Recovered existing kata races',
      );
    }
  } catch {
    // No Docker or no containers — fine
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
        logger.error({ err, file }, 'Unhandled error processing kata request');
      });
    }
  } catch (err) {
    logger.error({ err }, 'Error polling kata requests');
  }

  setTimeout(pollRequests, POLL_MS);
}

// ─── Public API ─────────────────────────────────────────────────────

export function startKataRunner(): void {
  if (running) {
    logger.debug('Kata runner already running, skipping duplicate start');
    return;
  }
  running = true;

  // Ensure directories exist
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
  fs.mkdirSync(RACES_DIR, { recursive: true });

  // Recover state
  recoverExistingRaces();

  // Start polling
  pollRequests();

  // Start monitoring
  monitorTimer = setInterval(() => {
    try {
      monitorRaces();
    } catch (err) {
      logger.error({ err }, 'Kata monitor cycle failed');
    }
  }, MONITOR_MS);

  logger.info(
    {
      requestDir: REQUEST_DIR,
      racesDir: RACES_DIR,
      maxRaces: MAX_RACES,
      kataDir: KATA_DIR,
    },
    'Kata runner started',
  );
}

export function stopKataRunner(): void {
  running = false;
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = undefined;
  }
  // Kata containers keep running — they're finite jobs
  logger.info(
    { activeRaces: activeRaces.size },
    'Kata runner stopped (containers persist)',
  );
}

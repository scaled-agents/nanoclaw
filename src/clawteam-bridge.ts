/**
 * ClawTeam Bridge — host-side worker lifecycle management.
 *
 * Spawns worker containers via runContainerAgent(), captures their output,
 * and writes results to the leader's IPC team/results/ directory so the
 * leader's clawteam MCP tools can read them.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, MAX_TEAM_WORKERS } from './config.js';
import {
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

interface ActiveWorker {
  workerId: string;
  name: string;
  leaderFolder: string;
  startedAt: string;
}

export interface WorkerResult {
  worker_id: string;
  name: string;
  status: 'completed' | 'failed';
  output: string;
  error: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

const activeWorkers = new Map<string, ActiveWorker>();

/** Count active workers for a specific leader. */
export function getActiveWorkerCount(leaderFolder?: string): number {
  if (!leaderFolder) return activeWorkers.size;
  let count = 0;
  for (const w of activeWorkers.values()) {
    if (w.leaderFolder === leaderFolder) count++;
  }
  return count;
}

/** Get status of all workers for a leader. */
export function getWorkerStatuses(
  leaderFolder: string,
): Array<{ workerId: string; name: string; status: string; startedAt: string }> {
  const statuses: Array<{
    workerId: string;
    name: string;
    status: string;
    startedAt: string;
  }> = [];
  for (const w of activeWorkers.values()) {
    if (w.leaderFolder === leaderFolder) {
      statuses.push({
        workerId: w.workerId,
        name: w.name,
        status: 'running',
        startedAt: w.startedAt,
      });
    }
  }
  return statuses;
}

function writeResult(
  leaderFolder: string,
  result: WorkerResult,
): void {
  const leaderIpcDir = resolveGroupIpcPath(leaderFolder);
  const resultsDir = path.join(leaderIpcDir, 'team', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const resultPath = path.join(resultsDir, `${result.worker_id}.json`);
  const tmpPath = `${resultPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
  fs.renameSync(tmpPath, resultPath);
  logger.info(
    { workerId: result.worker_id, status: result.status },
    'Worker result written',
  );
}

function cleanupWorkerFolder(workerId: string): void {
  const paths = [
    path.join(GROUPS_DIR, workerId),
    path.join(DATA_DIR, 'sessions', workerId),
    path.join(DATA_DIR, 'ipc', workerId),
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn({ path: p, err }, 'Failed to cleanup worker artifact');
    }
  }
  logger.debug({ workerId }, 'Worker artifacts cleaned up');
}

/**
 * Spawn a worker container. Returns immediately after launching;
 * writes result to leader's IPC when the worker completes.
 */
export async function spawnWorker(
  leaderGroup: RegisteredGroup,
  leaderFolder: string,
  workerId: string,
  name: string,
  prompt: string,
  timeoutMinutes: number,
): Promise<void> {
  // Check concurrency limit
  const leaderCount = getActiveWorkerCount(leaderFolder);
  if (leaderCount >= MAX_TEAM_WORKERS) {
    logger.warn(
      { leaderFolder, activeCount: leaderCount, max: MAX_TEAM_WORKERS },
      'Team worker limit reached, writing failure result',
    );
    writeResult(leaderFolder, {
      worker_id: workerId,
      name,
      status: 'failed',
      output: '',
      error: `Worker limit reached (${MAX_TEAM_WORKERS} max). Wait for existing workers to complete.`,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 0,
    });
    return;
  }

  const startedAt = new Date().toISOString();

  // Track active worker
  activeWorkers.set(workerId, {
    workerId,
    name,
    leaderFolder,
    startedAt,
  });

  // Create synthetic RegisteredGroup for the worker
  const workerGroup: RegisteredGroup = {
    name: `worker-${name}`,
    folder: workerId,
    trigger: '',
    added_at: startedAt,
    containerConfig: {
      // Inherit leader's additional mounts (read-only for workers)
      additionalMounts: leaderGroup.containerConfig?.additionalMounts?.map(
        (m) => ({ ...m, readonly: true }),
      ),
      timeout: timeoutMinutes * 60_000,
    },
  };

  const input: ContainerInput = {
    prompt,
    groupFolder: workerGroup.folder,
    chatJid: `team:${workerId}`,
    isMain: false,
    isScheduledTask: false,
    assistantName: name,
  };

  logger.info(
    { workerId, name, leaderFolder, timeoutMinutes },
    'Spawning team worker',
  );

  // Accumulate output from streaming callbacks
  let accumulatedOutput = '';

  // Fire and forget — don't block the IPC loop
  runContainerAgent(
    workerGroup,
    input,
    (_proc, containerName) => {
      logger.debug({ workerId, containerName }, 'Worker container started');
    },
    async (output: ContainerOutput) => {
      if (output.result) {
        accumulatedOutput += output.result + '\n';
      }
    },
  )
    .then((finalOutput) => {
      const finishedAt = new Date().toISOString();
      const durationMs =
        new Date(finishedAt).getTime() - new Date(startedAt).getTime();

      const result: WorkerResult = {
        worker_id: workerId,
        name,
        status: finalOutput.status === 'success' ? 'completed' : 'failed',
        output: accumulatedOutput.trim() || finalOutput.result || '',
        error: finalOutput.error || null,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
      };

      writeResult(leaderFolder, result);
      activeWorkers.delete(workerId);

      // Cleanup worker artifacts after a short delay
      setTimeout(() => cleanupWorkerFolder(workerId), 60_000);
    })
    .catch((err) => {
      const finishedAt = new Date().toISOString();
      const durationMs =
        new Date(finishedAt).getTime() - new Date(startedAt).getTime();

      writeResult(leaderFolder, {
        worker_id: workerId,
        name,
        status: 'failed',
        output: accumulatedOutput.trim(),
        error: err instanceof Error ? err.message : String(err),
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
      });
      activeWorkers.delete(workerId);

      setTimeout(() => cleanupWorkerFolder(workerId), 60_000);

      logger.error({ workerId, err }, 'Worker container failed');
    });
}

/** Clean up stale worker folders from previous runs. */
export function cleanupStaleWorkers(): void {
  // Clean up worker group folders (start with 'w_')
  for (const dir of [GROUPS_DIR, path.join(DATA_DIR, 'sessions'), path.join(DATA_DIR, 'ipc')]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('w_')) {
          const fullPath = path.join(dir, entry);
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            logger.debug({ path: fullPath }, 'Cleaned up stale worker artifact');
          } catch (err) {
            logger.warn({ path: fullPath, err }, 'Failed to clean stale worker');
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }
}

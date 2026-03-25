/**
 * ClawTeam MCP Server — container-side tools for the leader agent.
 *
 * Provides team_spawn_worker, team_wait_all, and team_list_workers.
 * Only registered for main group containers (leader privilege).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const TEAM_DIR = path.join(IPC_DIR, 'team');
const TEAM_RESULTS_DIR = path.join(TEAM_DIR, 'results');
const WORKERS_FILE = path.join(TEAM_DIR, 'workers.json');

const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

interface WorkerEntry {
  worker_id: string;
  name: string;
  spawned_at: string;
}

function loadWorkers(): WorkerEntry[] {
  try {
    if (fs.existsSync(WORKERS_FILE)) {
      return JSON.parse(fs.readFileSync(WORKERS_FILE, 'utf-8'));
    }
  } catch { /* ignore parse errors */ }
  return [];
}

function saveWorkers(workers: WorkerEntry[]): void {
  fs.mkdirSync(TEAM_DIR, { recursive: true });
  const tmpPath = `${WORKERS_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(workers, null, 2));
  fs.renameSync(tmpPath, WORKERS_FILE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = new McpServer({
  name: 'clawteam',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// team_spawn_worker
// ---------------------------------------------------------------------------
server.tool(
  'team_spawn_worker',
  `Spawn a worker agent in a separate container. The worker runs the given prompt with full MCP tool access (freqtrade, swarm, aphexdna) and exits when done. Returns a worker_id immediately — use team_wait_all to collect results.

Worker containers are isolated: own filesystem, own session, no conversation history. Include ALL context the worker needs in the prompt (seeds, specs, output format instructions).

Typical worker prompt pattern:
- Describe the research task clearly
- Include any JSON specs inline
- Tell the worker to call swarm_execute_autoresearch or swarm_execute_sweep
- Tell the worker to output results as structured JSON at the end`,
  {
    name: z.string().min(1).max(30).describe(
      'Short identifier for this worker (e.g. "btc-researcher", "eth-mutations"). Used in logs and results.',
    ),
    prompt: z.string().min(10).describe(
      'The full prompt for the worker agent. Must contain all context needed — the worker has no prior conversation history.',
    ),
    timeout_minutes: z.number().min(1).max(120).default(30).describe(
      'Maximum runtime in minutes before the worker is killed. Default: 30.',
    ),
  },
  async (args) => {
    const workerId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Write IPC command for the host bridge
    writeIpcFile(TASKS_DIR, {
      type: 'team_spawn_worker',
      worker_id: workerId,
      name: args.name,
      prompt: args.prompt,
      timeout_minutes: args.timeout_minutes,
      leader_folder: groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Track locally so team_list_workers knows about pending workers
    const workers = loadWorkers();
    workers.push({
      worker_id: workerId,
      name: args.name,
      spawned_at: new Date().toISOString(),
    });
    saveWorkers(workers);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ worker_id: workerId, name: args.name, status: 'spawning' }),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// team_wait_all
// ---------------------------------------------------------------------------
server.tool(
  'team_wait_all',
  `Wait for one or more workers to complete and return their results. Blocks until all specified workers have finished or the timeout is reached.

Returns an object with:
- results: array of worker results (output text, status, duration)
- all_completed: true if all workers finished before timeout
- timed_out: list of worker_ids that didn't finish in time

Each worker result contains the full text output from the worker agent. If the worker called swarm_execute_autoresearch, the results JSON will be embedded in the output text.`,
  {
    worker_ids: z.array(z.string()).min(1).describe(
      'Array of worker_id strings returned by team_spawn_worker.',
    ),
    timeout_minutes: z.number().min(1).max(180).default(45).describe(
      'Maximum time to wait for all workers. Default: 45 minutes.',
    ),
  },
  async (args) => {
    fs.mkdirSync(TEAM_RESULTS_DIR, { recursive: true });

    const deadline = Date.now() + args.timeout_minutes * 60_000;
    const pending = new Set(args.worker_ids);
    const results: Array<Record<string, unknown>> = [];

    while (pending.size > 0 && Date.now() < deadline) {
      for (const wid of [...pending]) {
        const resultPath = path.join(TEAM_RESULTS_DIR, `${wid}.json`);
        if (fs.existsSync(resultPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
            results.push(data);
            pending.delete(wid);
          } catch {
            // File may be partially written, retry next iteration
          }
        }
      }
      if (pending.size > 0) {
        await sleep(3000);
      }
    }

    const timedOut = [...pending];

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          results,
          all_completed: timedOut.length === 0,
          timed_out: timedOut,
          total_workers: args.worker_ids.length,
          completed_count: results.length,
        }, null, 2),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// team_list_workers
// ---------------------------------------------------------------------------
server.tool(
  'team_list_workers',
  'List all workers spawned in this session and their current status (running, completed, or failed).',
  {},
  async () => {
    const workers = loadWorkers();
    fs.mkdirSync(TEAM_RESULTS_DIR, { recursive: true });

    const statuses = workers.map((w) => {
      const resultPath = path.join(TEAM_RESULTS_DIR, `${w.worker_id}.json`);
      if (fs.existsSync(resultPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          return {
            worker_id: w.worker_id,
            name: w.name,
            status: data.status || 'completed',
            spawned_at: w.spawned_at,
            finished_at: data.finished_at,
            duration_ms: data.duration_ms,
            has_output: !!(data.output),
            error: data.error || null,
          };
        } catch { /* fall through */ }
      }
      return {
        worker_id: w.worker_id,
        name: w.name,
        status: 'running',
        spawned_at: w.spawned_at,
      };
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ workers: statuses }, null, 2),
      }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

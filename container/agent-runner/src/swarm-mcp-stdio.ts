/**
 * Stdio MCP Server for NanoClaw Freqtrade Swarm Integration
 * Read-only process providing 6 tools for viewing overnight strategy
 * research reports produced by freqtrade-swarm.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

const REPORT_DIR = process.env.SWARM_REPORT_DIR || '/workspace/extra/swarm-reports';

function log(message: string): void {
  console.error(`[SWARM] ${message}`);
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
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

const server = new McpServer({ name: 'swarm', version: '1.0.0' });

// ─── Report Reading ──────────────────────────────────────────────────

server.tool(
  'swarm_latest_report',
  'Read the latest morning report leaderboard (Markdown format). Shows ranked strategies from the most recent overnight screening run.',
  {},
  async () => {
    try {
      const content = readFile(path.join(REPORT_DIR, 'latest', 'leaderboard.md'));
      if (!content) {
        return err('No leaderboard report found. Has the swarm run completed? Check swarm_run_status for details.');
      }
      log('Read latest leaderboard.md');
      return ok(content);
    } catch (e) {
      return err(`Failed to read report: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_leaderboard',
  'Read the latest leaderboard as structured JSON. Contains total_screened, top_k count, and ranked strategy entries with metrics (sharpe, sortino, max_drawdown, profit_factor, win_rate, composite_score).',
  {},
  async () => {
    try {
      const content = readFile(path.join(REPORT_DIR, 'latest', 'leaderboard.json'));
      if (!content) {
        return err('No leaderboard data found. Has the swarm run completed?');
      }
      const data = JSON.parse(content);
      log(`Read leaderboard: ${data.total_screened || 0} screened, ${data.top_k || 0} in top-K`);
      return ok(data);
    } catch (e) {
      return err(`Failed to read leaderboard: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_run_status',
  'Check the status of the latest swarm run. Returns status (running/completed/failed), timestamps, program name, and task statistics.',
  {},
  async () => {
    try {
      const content = readFile(path.join(REPORT_DIR, 'latest', 'status.json'));
      if (!content) {
        return err('No status file found. No swarm run has been started yet.');
      }
      const data = JSON.parse(content);
      log(`Run status: ${data.status} (program=${data.program || 'unknown'})`);
      return ok(data);
    } catch (e) {
      return err(`Failed to read status: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_list_runs',
  'List all archived swarm runs with their timestamps. Returns an array of run IDs (ISO timestamps) sorted newest first.',
  {},
  async () => {
    try {
      const runsDir = path.join(REPORT_DIR, 'runs');
      if (!fs.existsSync(runsDir)) {
        return ok({ runs: [], message: 'No archived runs yet.' });
      }
      const entries = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
        .reverse();
      log(`Listed ${entries.length} archived runs`);
      return ok({ runs: entries, total: entries.length });
    } catch (e) {
      return err(`Failed to list runs: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_run_details',
  'Get detailed results for a specific archived run by its ID (ISO timestamp). Returns the leaderboard JSON and status for that run.',
  {
    run_id: z.string().describe('Run ID (ISO timestamp, e.g. "2026-03-17T02:00:00Z"). Get available IDs from swarm_list_runs.'),
  },
  async (args) => {
    try {
      const runDir = path.join(REPORT_DIR, 'runs', args.run_id);
      if (!fs.existsSync(runDir)) {
        return err(`Run not found: ${args.run_id}. Use swarm_list_runs to see available runs.`);
      }
      const leaderboard = readFile(path.join(runDir, 'leaderboard.json'));
      const status = readFile(path.join(runDir, 'status.json'));
      const result: Record<string, unknown> = { run_id: args.run_id };
      if (leaderboard) result.leaderboard = JSON.parse(leaderboard);
      if (status) result.status = JSON.parse(status);
      log(`Read run details: ${args.run_id}`);
      return ok(result);
    } catch (e) {
      return err(`Failed to read run details: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_health',
  'Check if the swarm report directory is configured and contains recent data. Useful for diagnosing integration issues.',
  {},
  async () => {
    try {
      const health: Record<string, unknown> = {
        report_dir: REPORT_DIR,
        exists: fs.existsSync(REPORT_DIR),
      };

      if (health.exists) {
        const latestDir = path.join(REPORT_DIR, 'latest');
        health.latest_dir_exists = fs.existsSync(latestDir);

        const statusPath = path.join(latestDir, 'status.json');
        if (fs.existsSync(statusPath)) {
          const stat = fs.statSync(statusPath);
          const ageMs = Date.now() - stat.mtimeMs;
          const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
          health.last_status_age_hours = ageHours;
          health.last_status_fresh = ageHours < 48;

          const content = readFile(statusPath);
          if (content) {
            const data = JSON.parse(content);
            health.last_run_status = data.status;
            health.last_run_program = data.program;
          }
        } else {
          health.last_status_age_hours = null;
          health.last_status_fresh = false;
        }

        const runsDir = path.join(REPORT_DIR, 'runs');
        if (fs.existsSync(runsDir)) {
          const runs = fs.readdirSync(runsDir, { withFileTypes: true })
            .filter(d => d.isDirectory());
          health.total_archived_runs = runs.length;
        } else {
          health.total_archived_runs = 0;
        }
      }

      log(`Health check: exists=${health.exists}, fresh=${health.last_status_fresh}`);
      return ok(health);
    } catch (e) {
      return err(`Health check failed: ${(e as Error).message}`);
    }
  },
);

// ─── Trigger Tools ──────────────────────────────────────────────────

const REQUEST_DIR = path.join(REPORT_DIR, 'requests');

server.tool(
  'swarm_trigger_run',
  'Submit a matrix sweep or nightly run request. Writes a spec JSON to the request queue; the host-side runner picks it up and spawns the freqtrade-swarm process. Returns a run_id for polling.',
  {
    spec_json: z.string().describe('MatrixSweepSpec JSON string (genome, pairs, timeframes, n_walkforward_windows)'),
    run_type: z.string().optional().describe('Run type: "matrix_sweep" (default) or "nightly"'),
  },
  async (args) => {
    try {
      // Validate JSON
      const spec = JSON.parse(args.spec_json);

      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      // Write spec file
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify(spec, null, 2),
      );

      // Write request manifest
      const manifest = {
        run_id: runId,
        run_type: args.run_type || 'matrix_sweep',
        submitted_at: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify(manifest, null, 2),
      );

      log(`Trigger: submitted ${runId} (type=${manifest.run_type})`);
      return ok({ run_id: runId, status: 'submitted', message: 'Request queued. Use swarm_poll_run to check progress.' });
    } catch (e) {
      return err(`Failed to submit run: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_poll_run',
  'Check the status of a submitted swarm run by its run_id. Returns status (queued/running/completed/failed), exit code, and timestamps. For completed jobs, includes report_dir path — use swarm_job_results to read full results.',
  {
    run_id: z.string().describe('Run ID returned by swarm_trigger_run'),
  },
  async (args) => {
    try {
      const statusPath = path.join(REQUEST_DIR, `${args.run_id}.status.json`);
      if (!fs.existsSync(statusPath)) {
        // Check if request exists but hasn't been picked up yet
        const requestPath = path.join(REQUEST_DIR, `${args.run_id}.request.json`);
        if (fs.existsSync(requestPath)) {
          return ok({ run_id: args.run_id, status: 'queued', message: 'Request is queued but not yet started by the host runner.' });
        }
        return err(`Run not found: ${args.run_id}. Use swarm_trigger_run to submit a new run.`);
      }

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      log(`Poll: ${args.run_id} → ${status.status}`);
      return ok(status);
    } catch (e) {
      return err(`Failed to poll run: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_job_results',
  'Read the full results of a completed matrix sweep job. Returns heatmap, top-K rankings, cluster analysis, and per-combination metrics. Call after swarm_poll_run shows status=completed.',
  {
    run_id: z.string().describe('Run ID returned by swarm_trigger_run'),
  },
  async (args) => {
    try {
      // First check status to get report_dir
      const statusPath = path.join(REQUEST_DIR, `${args.run_id}.status.json`);
      if (!fs.existsSync(statusPath)) {
        return err(`Run not found: ${args.run_id}. Use swarm_trigger_run to submit a new run.`);
      }

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      if (status.status !== 'completed') {
        return err(`Run ${args.run_id} is not completed (status: ${status.status}). Wait for completion before reading results.`);
      }

      if (!status.report_dir) {
        return err(`Run ${args.run_id} completed but has no report_dir. Check exit code: ${status.exit_code}`);
      }

      // Read results.json from report dir
      const resultsPath = path.join(status.report_dir, 'latest', 'results.json');
      const content = readFile(resultsPath);
      if (!content) {
        return err(`Results file not found at ${resultsPath}. The job may have failed to write output.`);
      }

      const results = JSON.parse(content);
      log(`Job results: ${args.run_id} — ${results.results?.length || 0} combinations, status=${results.status}`);
      return ok(results);
    } catch (e) {
      return err(`Failed to read job results: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_cancel_run',
  'Cancel a running or queued swarm run by writing a cancel marker. The host runner will stop the process on next poll.',
  {
    run_id: z.string().describe('Run ID to cancel'),
  },
  async (args) => {
    try {
      const cancelPath = path.join(REQUEST_DIR, `${args.run_id}.cancel`);
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
      fs.writeFileSync(cancelPath, JSON.stringify({ cancelled_at: new Date().toISOString() }));
      log(`Cancel: wrote cancel marker for ${args.run_id}`);
      return ok({ run_id: args.run_id, status: 'cancel_requested', message: 'Cancel marker written. The host runner will stop the process shortly.' });
    } catch (e) {
      return err(`Failed to cancel run: ${(e as Error).message}`);
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────

log(`Starting Swarm MCP server (report_dir=${REPORT_DIR})`);
const transport = new StdioServerTransport();
await server.connect(transport);

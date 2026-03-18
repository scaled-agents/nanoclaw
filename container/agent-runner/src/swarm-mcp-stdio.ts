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

// ─── Start ───────────────────────────────────────────────────────────

log(`Starting Swarm MCP server (report_dir=${REPORT_DIR})`);
const transport = new StdioServerTransport();
await server.connect(transport);

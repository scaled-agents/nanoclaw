/**
 * Stdio MCP Server for NanoClaw FreqSwarm Integration
 * Provides 11 tools: 6 read-only for viewing strategy research reports,
 * 5 trigger tools for matrix sweeps, autoresearch batches, and job management.
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
  'Check swarm health: report directory, recent data freshness, and last 5 triggered job outcomes. Returns swarm_likely_broken=true if the last 3 jobs all failed (infrastructure may need restart). Use before triggering new jobs.',
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

        // Scan recent triggered job statuses for failure pattern detection
        const requestDir = path.join(REPORT_DIR, 'requests');
        if (fs.existsSync(requestDir)) {
          const statusFiles = fs.readdirSync(requestDir)
            .filter(f => f.endsWith('.status.json'))
            .sort().reverse()   // newest first (timestamp in run_id)
            .slice(0, 5);

          const recentJobs = statusFiles.map(f => {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(requestDir, f), 'utf-8'));
              return {
                run_id: data.run_id || f.replace('.status.json', ''),
                status: data.status,
                finished_at: data.finished_at,
                exit_code: data.exit_code,
                error: data.error?.slice(0, 200),
                common_error: data.common_error,
              };
            } catch {
              return { run_id: f.replace('.status.json', ''), status: 'unknown' };
            }
          });

          health.recent_jobs = recentJobs;
          const recentFailures = recentJobs.filter(j => j.status === 'failed').length;
          health.consecutive_failures = recentFailures;
          // All recent jobs failed → swarm may be broken
          health.swarm_likely_broken = recentJobs.length >= 3
            && recentJobs.slice(0, 3).every(j => j.status === 'failed');
        } else {
          health.recent_jobs = [];
          health.consecutive_failures = 0;
          health.swarm_likely_broken = false;
        }
      }

      log(`Health check: exists=${health.exists}, fresh=${health.last_status_fresh}, likely_broken=${health.swarm_likely_broken}`);
      return ok(health);
    } catch (e) {
      return err(`Health check failed: ${(e as Error).message}`);
    }
  },
);

// ─── Trigger Tools ──────────────────────────────────────────────────

const REQUEST_DIR = path.join(REPORT_DIR, 'requests');

server.tool(
  'swarm_selftest',
  'Run a minimal smoke test (BTC/USDT:USDT, 1h, 1 WF window, SampleStrategy) to verify the swarm pipeline works end-to-end. Returns a run_id — poll with swarm_poll_run. Takes ~2-3 minutes. Use when swarm_health shows swarm_likely_broken=true.',
  {},
  async () => {
    try {
      const runId = `selftest_${Date.now()}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      const spec = {
        genome: {
          identity: { genome_id: `selftest_${Date.now()}`, name: 'BbandsRsiAdx', version: '1.0' },
        },
        pairs: ['BTC/USDT:USDT'],
        timeframes: ['1h'],
        timerange: '20250901-20260301',
        n_walkforward_windows: 2,
        skip_hyperopt: true,
        exchange: 'binance',
        strategy_path: 'data/user_data/strategies/BbandsRsiAdx.py',
      };

      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify(spec, null, 2),
      );
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify({
          run_id: runId,
          run_type: 'selftest',
          submitted_at: new Date().toISOString(),
          workers: 1,
          priority: 'high',
          group_folder: process.env.GROUP_FOLDER || '',
        }, null, 2),
      );

      log(`Self-test submitted: ${runId}`);
      return ok({
        run_id: runId,
        status: 'submitted',
        message: 'Self-test submitted. Poll with swarm_poll_run. Expected ~2-3 min.',
      });
    } catch (e) {
      return err(`Failed to submit self-test: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_trigger_run',
  'Submit a matrix sweep or nightly run request. Writes a spec JSON to the request queue; the host-side runner picks it up and spawns the FreqSwarm process with the specified worker count. Returns a run_id for polling with swarm_poll_run.',
  {
    spec_json: z.string().describe('MatrixSweepSpec JSON string (genome, pairs, timeframes, n_walkforward_windows)'),
    run_type: z.string().optional().describe('Run type: "matrix_sweep" (default) or "nightly"'),
    workers: z.number().optional().describe('Parallel worker count: 4 for small sweeps (≤50 combos), 6 for medium, 8 for large (100+). Default 4, max 8.'),
    priority: z.string().optional().describe('Queue priority: "high" for interactive user requests (jumps queue), "normal" for scheduled/background. Default "normal".'),
  },
  async (args) => {
    try {
      // Validate JSON
      const spec = JSON.parse(args.spec_json);

      // Structural validation — catch bad specs before writing to disk
      const validationErrors: string[] = [];
      if (!spec.genome || typeof spec.genome !== 'object') {
        validationErrors.push('Missing "genome" object');
      } else if (!spec.genome.identity || typeof spec.genome.identity !== 'object') {
        validationErrors.push('Missing "genome.identity" object');
      } else {
        if (!spec.genome.identity.name || typeof spec.genome.identity.name !== 'string') {
          validationErrors.push('Missing or empty "genome.identity.name"');
        }
        if (!spec.genome.identity.genome_id || typeof spec.genome.identity.genome_id !== 'string') {
          validationErrors.push('Missing or empty "genome.identity.genome_id"');
        }
      }
      if (!Array.isArray(spec.pairs) || spec.pairs.length === 0) {
        validationErrors.push('Missing or empty "pairs" array');
      }
      if (!Array.isArray(spec.timeframes) || spec.timeframes.length === 0) {
        validationErrors.push('Missing or empty "timeframes" array');
      }
      if (validationErrors.length > 0) {
        return err(`Invalid sweep spec: ${validationErrors.join('; ')}. Fix the spec and resubmit.`);
      }

      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      // Write spec file
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify(spec, null, 2),
      );

      // Write request manifest with workers and priority
      const workers = Math.min(Math.max(args.workers || 4, 1), 8);
      const priority = args.priority === 'high' ? 'high' : 'normal';
      const manifest = {
        run_id: runId,
        run_type: args.run_type || 'matrix_sweep',
        submitted_at: new Date().toISOString(),
        workers,
        priority,
        group_folder: process.env.GROUP_FOLDER || '',
      };
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify(manifest, null, 2),
      );

      log(`Trigger: submitted ${runId} (type=${manifest.run_type}, workers=${workers}, priority=${priority})`);
      return ok({ run_id: runId, status: 'submitted', workers, priority, message: 'Request queued. Use swarm_poll_run to check progress.' });
    } catch (e) {
      return err(`Failed to submit run: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_poll_run',
  'Check the status of a submitted swarm run by its run_id. Returns status (queued/running/completed/failed), exit code, timestamps, and common_error (if most tasks failed with the same root cause). For completed jobs, includes report_dir path — use swarm_job_results to read full results.',
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

server.tool(
  'swarm_trigger_autoresearch',
  'Submit an autoresearch batch job that generates mutations from seed genomes, runs walk-forward validation on each variant in parallel, and classifies results as keepers or rejects. Returns a run_id for polling with swarm_poll_run. Use swarm_job_results to read the final keepers/rejects after completion.',
  {
    spec_json: z.string().describe('AutoresearchSpec JSON string. Required fields: seed_genomes (array of {genome, pair, timeframe, parent_sharpe}), mutations_per_genome (int), timerange (string). Optional: mutation_seed, allowed_families, max_mutations_per_variant, n_walkforward_windows, exchange, config_path, keeper_sharpe_threshold, parent_sharpe_gate, discard_hashes.'),
    workers: z.number().optional().describe('Parallel worker count (1-8). Default 4. Use 4 for ≤10 variants, 6 for 10-20, 8 for 20+.'),
    priority: z.string().optional().describe('Queue priority: "high" for interactive (jumps queue), "normal" for background. Default "normal".'),
  },
  async (args) => {
    try {
      // Validate JSON
      const spec = JSON.parse(args.spec_json);

      // Basic validation
      if (!spec.seed_genomes || !Array.isArray(spec.seed_genomes) || spec.seed_genomes.length === 0) {
        return err('spec_json must contain a non-empty seed_genomes array');
      }
      if (!spec.timerange) {
        return err('spec_json must contain a timerange (e.g. "20250101-20260301")');
      }

      // Validate each seed genome has required structure
      for (let i = 0; i < spec.seed_genomes.length; i++) {
        const sg = spec.seed_genomes[i];
        if (!sg.genome || typeof sg.genome !== 'object') {
          return err(`seed_genomes[${i}]: missing "genome" object`);
        }
        if (!sg.genome.identity?.name) {
          return err(`seed_genomes[${i}]: missing "genome.identity.name"`);
        }
        if (!sg.pair || typeof sg.pair !== 'string') {
          return err(`seed_genomes[${i}]: missing "pair" (string)`);
        }
        if (!sg.timeframe || typeof sg.timeframe !== 'string') {
          return err(`seed_genomes[${i}]: missing "timeframe" (string)`);
        }
      }

      const runId = `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      // Write spec file
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify(spec, null, 2),
      );

      // Write request manifest
      const workers = Math.min(Math.max(args.workers || 4, 1), 8);
      const priority = args.priority === 'high' ? 'high' : 'normal';
      const totalVariants = spec.seed_genomes.length * (spec.mutations_per_genome || 7);
      const manifest = {
        run_id: runId,
        run_type: 'autoresearch',
        submitted_at: new Date().toISOString(),
        workers,
        priority,
        group_folder: process.env.GROUP_FOLDER || '',
      };
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify(manifest, null, 2),
      );

      log(`Autoresearch: submitted ${runId} (${spec.seed_genomes.length} seeds × ${spec.mutations_per_genome || 7} mutations = ~${totalVariants} variants, workers=${workers})`);
      return ok({
        run_id: runId,
        status: 'submitted',
        seeds: spec.seed_genomes.length,
        mutations_per_genome: spec.mutations_per_genome || 7,
        estimated_variants: totalVariants,
        workers,
        priority,
        message: 'Autoresearch job queued. Use swarm_poll_run to check progress, swarm_job_results to read keepers/rejects when done.',
      });
    } catch (e) {
      return err(`Failed to submit autoresearch: ${(e as Error).message}`);
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────

log(`Starting Swarm MCP server (report_dir=${REPORT_DIR})`);
const transport = new StdioServerTransport();
await server.connect(transport);

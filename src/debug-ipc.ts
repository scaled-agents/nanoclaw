/**
 * Browser Debug - Host-side IPC Handler
 *
 * Handles debug_* IPC messages from container agents.
 * Spawns diagnostic scripts that check X and LuxAlgo integration health.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const { CHROME_PATH } = readEnvFile(['CHROME_PATH']);

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function runScript(
  script: string,
  args: object,
  timeout = 60000,
): Promise<SkillResult> {
  const scriptPath = path.join(
    process.cwd(),
    '.claude',
    'skills',
    'browser-debug',
    'scripts',
    `${script}.ts`,
  );

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NANOCLAW_ROOT: process.cwd(),
        ...(CHROME_PATH ? { CHROME_PATH } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const killTree = () => {
      if (proc.pid == null) return;
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        } catch {
          // process may have already exited
        }
      } else {
        proc.kill('SIGTERM');
      }
    };

    const timer = setTimeout(() => {
      killTree();
      resolve({
        success: false,
        message: `Script timed out (${timeout / 1000}s)`,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const trimmedStdout = stdout.trim();
      if (trimmedStdout) {
        try {
          const lines = trimmedStdout.split('\n');
          const parsed = JSON.parse(lines[lines.length - 1]) as SkillResult;
          resolve(parsed);
          return;
        } catch {
          // stdout wasn't valid JSON — fall through
        }
      }
      if (code !== 0) {
        const detail = stderr.trim().slice(-500);
        resolve({
          success: false,
          message: `Script exited with code: ${code}${detail ? ` — ${detail}` : ''}`,
        });
        return;
      }
      resolve({
        success: false,
        message: `Failed to parse output: ${trimmedStdout.slice(0, 200)}`,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn: ${err.message}` });
    });
  });
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: SkillResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'debug_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

/**
 * Handle browser debug IPC messages.
 * @returns true if message was handled, false if not a debug message
 */
export async function handleDebugIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('debug_')) {
    return false;
  }

  if (!isMain) {
    logger.warn(
      { sourceGroup, type },
      'Debug integration blocked: not main group',
    );
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Debug integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing debug request');

  let result: SkillResult;
  const target = (data.target as string) || 'both';

  switch (type) {
    case 'debug_health_check':
      result = await runScript('health-check', { target });
      break;

    case 'debug_probe':
      result = await runScript('probe', { target }, 90000);
      break;

    case 'debug_cleanup':
      result = await runScript('cleanup', {
        target,
        kill_chrome: data.kill_chrome ?? false,
      });
      break;

    case 'debug_reauth': {
      const t = target === 'both' ? 'x and luxalgo' : target;
      const commands: string[] = [];
      if (target === 'x' || target === 'both') {
        commands.push(
          'npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/setup.ts',
        );
      }
      if (target === 'luxalgo' || target === 'both') {
        commands.push(
          'npx dotenv -e .env -- npx tsx .claude/skills/luxalgo-quant/scripts/setup.ts',
        );
      }
      result = {
        success: true,
        message: `Re-authentication required for ${t}. Run setup on the host machine (requires interactive browser).`,
        data: { commands },
      };
      break;
    }

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'Debug request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'Debug request failed',
    );
  }
  return true;
}

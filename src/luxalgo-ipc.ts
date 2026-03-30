/**
 * LuxAlgo Quant Integration - Host-side IPC Handler
 *
 * Handles luxalgo_* IPC messages from container agents.
 * Spawns script subprocesses that use Playwright browser automation.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

const DEFAULT_TIMEOUT = 120000;
const CHAT_TIMEOUT = 180000; // 3 minutes for LLM streaming responses

function runScript(
  script: string,
  args: object,
  timeout = DEFAULT_TIMEOUT,
): Promise<SkillResult> {
  const scriptPath = path.join(
    process.cwd(),
    '.claude',
    'skills',
    'luxalgo-quant',
    'scripts',
    `${script}.ts`,
  );

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        message: `Script timed out (${timeout / 1000}s)`,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          success: false,
          message: `Script exited with code: ${code}`,
        });
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        resolve({
          success: false,
          message: `Failed to parse output: ${stdout.slice(0, 200)}`,
        });
      }
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
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'luxalgo_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

/**
 * Handle LuxAlgo Quant IPC messages.
 * @returns true if message was handled, false if not a luxalgo message
 */
export async function handleLuxAlgoIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('luxalgo_')) {
    return false;
  }

  if (!isMain) {
    logger.warn(
      { sourceGroup, type },
      'LuxAlgo integration blocked: not main group',
    );
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'LuxAlgo integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing LuxAlgo request');

  let result: SkillResult;

  switch (type) {
    case 'luxalgo_chat':
      if (!data.message) {
        result = { success: false, message: 'Missing message' };
        break;
      }
      result = await runScript(
        'chat',
        { message: data.message, archetype: data.archetype },
        CHAT_TIMEOUT,
      );
      break;

    case 'luxalgo_new_conversation':
      result = await runScript('new-conversation', {});
      break;

    case 'luxalgo_get_history':
      result = await runScript('get-history', {});
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'LuxAlgo request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'LuxAlgo request failed',
    );
  }
  return true;
}

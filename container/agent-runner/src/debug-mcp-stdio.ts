/**
 * Browser Debug - MCP Server (Container Side)
 *
 * Runs inside the container as a stdio MCP server.
 * Tools write IPC task files for the host to process diagnostic scripts,
 * then poll for results.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'debug_results');

const isMain = process.env.NANOCLAW_IS_MAIN === '1';
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

async function waitForResult(
  requestId: string,
  maxWait = 120000,
): Promise<{ success: boolean; message: string; data?: unknown }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return {
    success: false,
    message: `Request timed out waiting for host diagnostic (${maxWait / 1000}s)`,
  };
}

function mainOnly(): {
  content: [{ type: 'text'; text: string }];
  isError: true;
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'Only the main group can use browser debug tools.',
      },
    ],
    isError: true,
  };
}

const targetSchema = z
  .enum(['x', 'luxalgo', 'both'])
  .default('both')
  .describe('Which integration to check: "x", "luxalgo", or "both" (default)');

const server = new McpServer({
  name: 'browser-debug',
  version: '1.0.0',
});

server.tool(
  'debug_health_check',
  `Non-invasive health check of X and/or LuxAlgo browser integrations.
Checks Chrome binary, browser profiles, auth files, lock files, and platform config.
No browser is launched — safe to call frequently.`,
  {
    target: targetSchema,
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `dbghc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'debug_health_check',
      requestId,
      target: args.target,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId);
    return {
      content: [
        {
          type: 'text' as const,
          text: result.success
            ? JSON.stringify(result.data ?? result.message, null, 2)
            : result.message,
        },
      ],
      isError: !result.success,
    };
  },
);

server.tool(
  'debug_probe',
  `Live browser probe — launches Chrome headless and verifies login status.
Tests if sessions are still active by navigating to X.com and/or LuxAlgo Quant.
Takes 10-30 seconds per integration.`,
  {
    target: targetSchema,
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `dbgpr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'debug_probe',
      requestId,
      target: args.target,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId, 120000);
    return {
      content: [
        {
          type: 'text' as const,
          text: result.success
            ? JSON.stringify(result.data ?? result.message, null, 2)
            : result.message,
        },
      ],
      isError: !result.success,
    };
  },
);

server.tool(
  'debug_cleanup',
  `Clean up stale browser locks and optionally kill orphaned Chrome processes.
Removes SingletonLock/SingletonSocket/SingletonCookie files that block browser launch.`,
  {
    target: targetSchema,
    kill_chrome: z
      .boolean()
      .default(false)
      .describe(
        'Also kill orphaned headless Chrome processes (default: false)',
      ),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `dbgcl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'debug_cleanup',
      requestId,
      target: args.target,
      kill_chrome: args.kill_chrome,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId);
    return {
      content: [
        {
          type: 'text' as const,
          text: result.success
            ? JSON.stringify(result.data ?? result.message, null, 2)
            : result.message,
        },
      ],
      isError: !result.success,
    };
  },
);

server.tool(
  'debug_reauth',
  `Get re-authentication instructions for expired browser sessions.
Returns the exact commands to run on the host machine (requires interactive browser).
Cannot automate login — user must interact with the browser.`,
  {
    target: targetSchema,
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `dbgra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'debug_reauth',
      requestId,
      target: args.target,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId);
    return {
      content: [
        {
          type: 'text' as const,
          text: result.success
            ? JSON.stringify(result.data ?? result.message, null, 2)
            : result.message,
        },
      ],
      isError: !result.success,
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

/**
 * LuxAlgo Quant Integration - MCP Server (Container Side)
 *
 * Runs inside the container as a stdio MCP server.
 * Tools write IPC task files for the host to process via browser automation,
 * then poll for results.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'luxalgo_results');

const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

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
  maxWait = 60000,
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
    message: `Request timed out waiting for host browser automation (${maxWait / 1000}s)`,
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
        text: 'Only the main group can use LuxAlgo integration.',
      },
    ],
    isError: true,
  };
}

const server = new McpServer({
  name: 'luxalgo',
  version: '1.0.0',
});

server.tool(
  'luxalgo_chat',
  `Send a message to LuxAlgo's Quant LLM and get the response including any code blocks.
The host will open the LuxAlgo chat, type your message, wait for the streaming response, and extract text + code blocks.

Returns: response_text (full text), code_blocks (array of {language, code}), conversation_url.

Use this to search for TradingView PineScript indicators by archetype, description, or specific indicators.
After receiving PineScript code, you can convert it to a FreqTrade Python strategy.`,
  {
    message: z
      .string()
      .describe(
        'The message to send to LuxAlgo Quant chat (e.g., "Find me RSI-based mean reversion indicators")',
      ),
    archetype: z
      .string()
      .optional()
      .describe(
        'Optional archetype context (TREND_MOMENTUM, MEAN_REVERSION, BREAKOUT, etc.)',
      ),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `luxchat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'luxalgo_chat',
      requestId,
      message: args.message,
      archetype: args.archetype,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Longer timeout for chat — LLM streaming can take 60-90s
    const result = await waitForResult(requestId, 120000);
    return {
      content: [
        {
          type: 'text' as const,
          text: result.data
            ? JSON.stringify(result.data, null, 2)
            : result.message,
        },
      ],
      isError: !result.success,
    };
  },
);

server.tool(
  'luxalgo_new_conversation',
  'Start a fresh conversation thread in LuxAlgo Quant. Use this before researching a new archetype or topic to clear previous context.',
  {},
  async () => {
    if (!isMain) return mainOnly();

    const requestId = `luxnew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'luxalgo_new_conversation',
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'luxalgo_get_history',
  'Get the message history from the current LuxAlgo Quant conversation. Useful for reviewing what was discussed and extracting code from earlier responses.',
  {},
  async () => {
    if (!isMain) return mainOnly();

    const requestId = `luxhist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'luxalgo_get_history',
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId);
    return {
      content: [
        {
          type: 'text' as const,
          text: result.data
            ? JSON.stringify(result.data, null, 2)
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

/**
 * X (Twitter) Integration - MCP Server (Container Side)
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
const RESULTS_DIR = path.join(IPC_DIR, 'x_results');

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

// Default must exceed host-side script timeout (120s) to avoid orphaned results
async function waitForResult(requestId: string, maxWait = 150000): Promise<{ success: boolean; message: string; data?: unknown }> {
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
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: `Request timed out waiting for host browser automation (${maxWait / 1000}s)` };
}

function mainOnly(): { content: [{ type: 'text'; text: string }]; isError: true } {
  return {
    content: [{ type: 'text' as const, text: 'Only the main group can use X integration.' }],
    isError: true,
  };
}

const server = new McpServer({
  name: 'x',
  version: '1.0.0',
});

server.tool(
  'x_post',
  `Post a tweet to X (Twitter). Main group only.
The host machine will execute browser automation to post the tweet.`,
  {
    content: z.string().max(280).describe('The tweet content to post (max 280 characters)'),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `xpost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_post',
      requestId,
      content: args.content,
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
  'x_like',
  'Like a tweet on X (Twitter). Main group only.',
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `xlike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_like',
      requestId,
      tweetUrl: args.tweet_url,
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
  'x_reply',
  'Reply to a tweet on X (Twitter). Main group only.',
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
    content: z.string().max(280).describe('The reply content (max 280 characters)'),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `xreply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_reply',
      requestId,
      tweetUrl: args.tweet_url,
      content: args.content,
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
  'x_retweet',
  'Retweet a tweet on X (Twitter). Main group only.',
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `xretweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_retweet',
      requestId,
      tweetUrl: args.tweet_url,
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
  'x_quote',
  'Quote tweet on X (Twitter) with your own comment. Main group only.',
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
    comment: z.string().max(280).describe('Your comment for the quote tweet (max 280 characters)'),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `xquote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_quote',
      requestId,
      tweetUrl: args.tweet_url,
      comment: args.comment,
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
  'x_read_timeline',
  `Read the authenticated user's X (Twitter) home timeline. Returns tweet text, author, metrics, and URLs. Main group only.`,
  {
    count: z.number().min(1).max(50).default(20).describe('Number of tweets to read (default 20, max 50)'),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `xread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_read_timeline',
      requestId,
      count: args.count,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId, 150000);
    return {
      content: [{ type: 'text' as const, text: result.success ? JSON.stringify(result.data ?? result.message) : result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'x_search',
  `Search X (Twitter) for tweets matching a query. Returns tweet text, author, metrics, and URLs. Main group only.`,
  {
    query: z.string().describe('Search query (e.g., "BTC", "from:elonmusk", "#crypto")'),
    count: z.number().min(1).max(50).default(20).describe('Number of tweets to return (default 20, max 50)'),
    tab: z.enum(['top', 'latest', 'people', 'media']).default('latest').describe('Search tab (default: latest)'),
  },
  async (args) => {
    if (!isMain) return mainOnly();

    const requestId = `xsearch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_search',
      requestId,
      query: args.query,
      count: args.count,
      tab: args.tab,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForResult(requestId, 150000);
    return {
      content: [{ type: 'text' as const, text: result.success ? JSON.stringify(result.data ?? result.message) : result.message }],
      isError: !result.success,
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

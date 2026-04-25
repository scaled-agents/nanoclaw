/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    skills_allowlist: z.array(z.string()).optional().describe('Optional list of skill names to mount in the container. When set, only these skills are available. When omitted, all skills are mounted.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, unknown> = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.skills_allowlist) {
      data.skills_allowlist = JSON.stringify(args.skills_allowlist);
    }

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    skills_allowlist: z.array(z.string()).optional().describe('Optional list of skill names to mount in the container. When set, only these skills are available. Pass empty array to clear (restore all skills).'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;
    if (args.skills_allowlist !== undefined) {
      data.skills_allowlist = args.skills_allowlist.length > 0
        ? JSON.stringify(args.skills_allowlist)
        : undefined; // empty array = clear allowlist (NULL in DB = all skills)
    }

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ─── Agent Feed ───────────────────────────────────────────────────────

const APHEXDATA_URL = (process.env.APHEXDATA_URL || '').replace(/\/+$/, '');
const APHEXDATA_API_KEY = process.env.APHEXDATA_API_KEY || '';
const APHEXDATA_AGENT_ID = process.env.APHEXDATA_AGENT_ID || '';

async function feedFetch(urlPath: string, options?: RequestInit): Promise<any> {
  if (!APHEXDATA_URL) throw new Error('APHEXDATA_URL not configured');
  const url = `${APHEXDATA_URL}${urlPath}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (APHEXDATA_API_KEY) headers['Authorization'] = `Bearer ${APHEXDATA_API_KEY}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`aphexDATA ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Signal Marketplace ──────────────────────────────────────────────

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const OPERATOR_ID = process.env.CONSOLE_OPERATOR_ID || '';

async function supabaseFetch(
  tablePath: string,
  options?: RequestInit & { params?: Record<string, string> },
): Promise<any> {
  if (!SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
  const url = new URL(`${SUPABASE_URL}/rest/v1/${tablePath}`);
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
  const { params: _, ...fetchOpts } = options || {};
  const res = await fetch(url.toString(), {
    ...fetchOpts,
    headers: { ...headers, ...(fetchOpts?.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  return res.json();
}

function getRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

server.tool(
  'agent_post_status',
  "Post a short status update to the shared agent feed. Other agents and the console dashboard can see these updates. Use this to broadcast what you're currently working on, findings, progress, and decisions.",
  {
    status: z.string().max(280).describe('Short status message, max 280 characters. What are you doing right now?'),
    tags: z.array(z.string()).describe('1-3 tags categorizing this update. Use: research, auto_mode, deployment, graduation, triage, evolution, error, finding, decision'),
    context: z.object({
      task: z.string().optional().describe('Current task name'),
      progress: z.string().optional().describe("Progress indicator, e.g. '30/200 combinations'"),
      archetype: z.string().optional().describe('Archetype being worked on'),
      pair: z.string().optional().describe('Pair being tested'),
      timeframe: z.string().optional().describe('Timeframe'),
      finding: z.string().optional().describe('Key finding or result'),
      metric: z.record(z.string(), z.unknown()).optional().describe('Any relevant metric, e.g. {sharpe: 0.62, sortino: 1.1}'),
    }).optional().describe('Optional structured context for this update'),
  },
  async (args) => {
    try {
      const status = args.status.slice(0, 280);
      const agentName = process.env.AGENT_NAME || groupFolder || 'unknown';

      const body = {
        agent_id: APHEXDATA_AGENT_ID || undefined,
        verb_id: 'status_update',
        verb_category: 'communication',
        object_type: 'report',
        object_id: agentName,
        result_data: {
          status,
          tags: args.tags,
          agent_name: agentName,
          group_folder: groupFolder,
          context: args.context || {},
        },
        context: {
          source: 'agent_feed',
          agent_name: agentName,
        },
        trust_level: 'agent_asserted',
      };

      const data = await feedFetch('/api/v1/events', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Status posted: "${status}"`,
            tags: args.tags,
            agent: agentName,
            event_id: data.id,
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Failed to post status: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'agent_read_feed',
  "Read the shared agent feed — see what all agents have posted recently. Use this before starting work to avoid duplicating what another agent is already doing.",
  {
    since_hours: z.number().optional().describe('How many hours back to look. Default: 4'),
    limit: z.number().optional().describe('Maximum number of updates to return. Default: 20'),
    tags: z.array(z.string()).optional().describe("Optional: filter by tags (e.g. ['research'] to see only research updates)"),
    agent_name: z.string().optional().describe('Optional: filter by specific agent name'),
  },
  async (args) => {
    try {
      const sinceHours = args.since_hours || 4;
      const limit = args.limit || 20;
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

      const params = new URLSearchParams({
        verb_id: 'status_update',
        from: since,
        limit: limit.toString(),
      });

      if (args.agent_name) {
        params.set('object_id', args.agent_name);
      }

      const data = await feedFetch(`/api/v1/events?${params.toString()}`);

      let events = data.events || data.data || data || [];
      if (!Array.isArray(events)) events = [];

      // Apply tag filter client-side
      if (args.tags && args.tags.length > 0) {
        events = events.filter((e: any) => {
          const eventTags = e.result_data?.tags || [];
          return args.tags!.some(tag => eventTags.includes(tag));
        });
      }

      const feed = events.map((e: any) => ({
        agent: e.result_data?.agent_name || e.object_id,
        status: e.result_data?.status,
        tags: e.result_data?.tags,
        context: e.result_data?.context,
        timestamp: e.occurred_at,
        relative: getRelativeTime(e.occurred_at),
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            feed,
            count: feed.length,
            since,
            note: feed.length === 0
              ? "No recent updates in the feed. You're the first to post."
              : `${feed.length} updates from the last ${sinceHours} hours.`,
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Failed to read feed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Signal Marketplace Tools ────────────────────────────────────────

server.tool(
  'signal_catalog_query',
  "Search the signal marketplace for available signals from other agents. Use to find signals that fill your coverage gaps. Returns catalog entries with publisher info, performance metrics, and subscriber counts.",
  {
    archetype: z.string().optional().describe('Filter by archetype (e.g. "MEAN_REVERSION", "TREND_MOMENTUM")'),
    pair: z.string().optional().describe('Filter by pair (e.g. "ETH/USDT:USDT")'),
    timeframe: z.string().optional().describe('Filter by timeframe (e.g. "1h", "4h")'),
    min_wf_sharpe: z.number().optional().describe('Minimum walk-forward Sharpe ratio (e.g. 0.5)'),
    min_subscribers: z.number().optional().describe('Minimum subscriber count for social proof'),
    access_type: z.string().optional().describe('Filter by access type: "public", "private", or "paid"'),
    limit: z.number().optional().describe('Max results to return (default 10)'),
  },
  async (args) => {
    try {
      const params: Record<string, string> = {
        'status': 'eq.active',
        'order': 'wf_sharpe.desc.nullslast,subscriber_count.desc',
        'limit': String(args.limit || 10),
      };

      if (args.archetype) params['archetype'] = `eq.${args.archetype}`;
      if (args.pair) params['pair'] = `eq.${args.pair}`;
      if (args.timeframe) params['timeframe'] = `eq.${args.timeframe}`;
      if (args.min_wf_sharpe != null) params['wf_sharpe'] = `gte.${args.min_wf_sharpe}`;
      if (args.min_subscribers != null) params['subscriber_count'] = `gte.${args.min_subscribers}`;
      if (args.access_type) params['access_type'] = `eq.${args.access_type}`;

      const data = await supabaseFetch('signal_catalog', { params });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results: data,
            count: Array.isArray(data) ? data.length : 0,
            filters: {
              archetype: args.archetype,
              pair: args.pair,
              timeframe: args.timeframe,
              min_wf_sharpe: args.min_wf_sharpe,
            },
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Failed to query signal catalog: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'signal_subscribe',
  "Subscribe to a signal from the marketplace. Requires a catalog_id from signal_catalog_query results. Creates a subscription so you receive signal events from the publisher.",
  {
    catalog_id: z.string().describe('Signal catalog entry UUID from signal_catalog_query results'),
    delivery_method: z.enum(['realtime', 'webhook', 'feed_only']).default('feed_only').describe('How to receive signals. Default: feed_only'),
    action_on_signal: z.enum(['log_only', 'paper_trade', 'notify']).default('log_only').describe('What to do when a signal arrives. Default: log_only'),
  },
  async (args) => {
    try {
      if (!OPERATOR_ID) throw new Error('CONSOLE_OPERATOR_ID not configured');

      const body = {
        catalog_id: args.catalog_id,
        subscriber_id: OPERATOR_ID,
        delivery_method: args.delivery_method,
        action_on_signal: args.action_on_signal,
        status: 'active',
      };

      const data = await supabaseFetch('signal_subscriptions', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Prefer': 'return=representation' } as Record<string, string>,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Subscribed to signal ${args.catalog_id}`,
            subscription: Array.isArray(data) ? data[0] : data,
            delivery_method: args.delivery_method,
            action_on_signal: args.action_on_signal,
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Failed to subscribe: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'signal_publish',
  "Publish a paper-trading bot's signals to the marketplace. Other agents can then discover and subscribe to your signals. Reads deployment data from deployments.json to auto-fill strategy details.",
  {
    deployment_id: z.string().describe('Bot deployment ID from deployments.json'),
    access_type: z.enum(['public', 'private']).default('public').describe('Who can subscribe. Default: public'),
    include_sizing: z.boolean().default(false).describe('Include position sizing info in signals. Default: false'),
  },
  async (args) => {
    try {
      if (!OPERATOR_ID) throw new Error('CONSOLE_OPERATOR_ID not configured');

      // Read deployment data
      const deploymentsPath = '/workspace/group/auto-mode/deployments.json';
      if (!fs.existsSync(deploymentsPath)) {
        throw new Error('deployments.json not found — no deployments to publish');
      }
      const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf-8'));
      const deployment = Array.isArray(deployments)
        ? deployments.find((d: any) => d.id === args.deployment_id)
        : deployments[args.deployment_id];

      if (!deployment) {
        throw new Error(`Deployment ${args.deployment_id} not found in deployments.json`);
      }

      const agentName = process.env.AGENT_NAME || groupFolder || 'unknown';

      const body = {
        publisher_id: OPERATOR_ID,
        publisher_name: agentName,
        agent_name: agentName,
        strategy_name: deployment.strategy || '',
        pair: deployment.pairs?.[0] || deployment.pair || '',
        timeframe: deployment.timeframe || '',
        archetype: deployment.archetype || '',
        paper_pnl: deployment.paper_pnl || {},
        wf_sharpe: deployment.wfo_sharpe ?? deployment.wf_sharpe ?? null,
        wf_degradation: deployment.wfo_degradation ?? deployment.wf_degradation ?? null,
        graduation_date: deployment.graduated_at || deployment.graduated || null,
        preferred_regimes: deployment.preferred_regimes || [],
        anti_regimes: deployment.anti_regimes || [],
        access_type: args.access_type,
        signal_config: {
          include_entry: true,
          include_exit: true,
          include_sizing: args.include_sizing,
          include_regime_context: true,
          include_confidence: true,
        },
        status: 'active',
      };

      const data = await supabaseFetch('signal_catalog', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Prefer': 'return=representation' } as Record<string, string>,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Published signals for ${deployment.strategy} on ${body.pair}/${body.timeframe}`,
            catalog_entry: Array.isArray(data) ? data[0] : data,
            access_type: args.access_type,
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Failed to publish signal: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── State Sync ──────────────────────────────────────────────────────

const SUPABASE_USER_ID = process.env.SUPABASE_USER_ID || '';

server.tool(
  'sync_state_to_supabase',
  'Push a local state file to Supabase so the console dashboard can read it. Call this after writing campaigns.json, roster.json, deployments.json, or any state file that the console needs.',
  {
    state_key: z.string().describe('State identifier: campaigns, roster, deployments, cell_grid, missed_opps, triage_matrix, market_prior'),
    file_path: z.string().describe('Absolute path to local JSON file to sync'),
  },
  async (args) => {
    try {
      if (!SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
      if (!SUPABASE_USER_ID) throw new Error('SUPABASE_USER_ID not configured');

      const raw = fs.readFileSync(args.file_path, 'utf-8');
      const content = JSON.parse(raw);

      // Read current version for increment
      let version = 1;
      try {
        const existing = await supabaseFetch('agent_state_sync', {
          params: {
            'user_id': `eq.${SUPABASE_USER_ID}`,
            'state_key': `eq.${args.state_key}`,
            'select': 'version',
          },
        });
        if (Array.isArray(existing) && existing[0]) {
          version = (existing[0].version || 0) + 1;
        }
      } catch {
        // First write — version stays 1
      }

      await supabaseFetch('agent_state_sync', {
        method: 'POST',
        headers: {
          'Prefer': 'resolution=merge-duplicates,return=representation',
        } as Record<string, string>,
        body: JSON.stringify({
          user_id: SUPABASE_USER_ID,
          state_key: args.state_key,
          data: content,
          version,
          synced_at: new Date().toISOString(),
        }),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, synced: args.state_key, version }),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Failed to sync ${args.state_key}: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Webhook MCP Tools ────────────────────────────────────────────────

const BOT_RUNNER_DIR = process.env.BOT_RUNNER_DIR || '/workspace/extra/bot-runner';
const WEBHOOK_REQUEST_DIR = path.join(BOT_RUNNER_DIR, 'requests');
const WEBHOOKS_FILE = path.join(BOT_RUNNER_DIR, 'webhooks.json');

function generateWebhookRequestId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `wh_${ts}_${rand}`;
}

async function submitWebhookRequest(
  request: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const requestId = generateWebhookRequestId();
  const requestPath = path.join(WEBHOOK_REQUEST_DIR, `${requestId}.request.json`);

  if (!fs.existsSync(WEBHOOK_REQUEST_DIR)) {
    throw new Error('Bot runner request directory not found. Is bot-runner enabled on the host?');
  }

  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));

  const statusPath = path.join(WEBHOOK_REQUEST_DIR, `${requestId}.status.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(statusPath)) {
      return JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timeout waiting for webhook response from bot-runner');
}

server.tool(
  'webhook_list',
  'List all configured outbound webhooks with their delivery stats.',
  {},
  async () => {
    try {
      if (!fs.existsSync(WEBHOOKS_FILE)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ webhooks: [], message: 'No webhooks configured yet.' }, null, 2),
          }],
        };
      }
      const data = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8'));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Failed to read webhooks: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'webhook_create',
  'Create a new outbound webhook for signal delivery. Returns the webhook config including the auto-generated signing secret.',
  {
    name: z.string().describe('Descriptive name, e.g. "Katoshi Hyperliquid"'),
    url: z.string().describe('HTTPS endpoint URL'),
    deployment_ids: z
      .array(z.string())
      .optional()
      .describe('Which bot deployment IDs trigger this webhook. Empty = all bots.'),
    format: z
      .enum(['standard', 'katoshi', '3commas', 'custom'])
      .optional()
      .describe('Payload format. Default: standard'),
    events: z
      .object({
        entry: z.boolean().optional(),
        exit: z.boolean().optional(),
      })
      .optional()
      .describe('Which event types to deliver'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Custom headers. Use {{ENV_VAR}} for secrets from .env'),
  },
  async (args) => {
    try {
      const config: Record<string, unknown> = {
        name: args.name,
        url: args.url,
      };

      if (args.deployment_ids) {
        config.source_filter = {
          deployment_ids: args.deployment_ids,
          archetypes: [],
          pairs: [],
          timeframes: [],
        };
      }

      if (args.events) {
        config.event_filter = {
          entry: args.events.entry !== false,
          exit: args.events.exit !== false,
          signal_toggle: false,
          lifecycle_change: false,
        };
      }

      if (args.format) {
        config.transform = {
          format: args.format,
          include_regime_context: true,
          include_paper_pnl: true,
          include_confidence: true,
          include_raw_indicators: false,
          custom_fields: {},
        };
      }

      if (args.headers) {
        config.delivery = {
          timeout_ms: 10000,
          retry_count: 3,
          retry_delay_ms: 5000,
          headers: args.headers,
        };
      }

      const result = await submitWebhookRequest({
        type: 'webhook_create',
        webhook_config: config,
        deployment_id: '',
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return {
          content: [{ type: 'text' as const, text: `Failed to create webhook: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Webhook "${args.name}" created successfully.`,
            webhook: result.webhook,
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `webhook_create failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'webhook_test',
  'Send a test payload to a webhook to verify it is working. Returns the delivery result.',
  {
    webhook_id: z.string().describe('ID of webhook to test (from webhook_list)'),
  },
  async (args) => {
    try {
      const result = await submitWebhookRequest({
        type: 'webhook_test',
        webhook_id: args.webhook_id,
        deployment_id: '',
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return {
          content: [{ type: 'text' as const, text: `Webhook test failed: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: 'Test payload delivered.',
            delivery_result: result.delivery_result,
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `webhook_test failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'webhook_delete',
  'Delete a webhook permanently. Requires the webhook_id.',
  {
    webhook_id: z.string().describe('ID of webhook to delete'),
    confirm: z.boolean().describe('Must be true to confirm deletion'),
  },
  async (args) => {
    if (!args.confirm) {
      return {
        content: [{ type: 'text' as const, text: 'Deletion cancelled — confirm must be true.' }],
      };
    }

    try {
      const result = await submitWebhookRequest({
        type: 'webhook_delete',
        webhook_id: args.webhook_id,
        deployment_id: '',
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return {
          content: [{ type: 'text' as const, text: `Failed to delete webhook: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Webhook ${args.webhook_id} deleted successfully.`,
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `webhook_delete failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

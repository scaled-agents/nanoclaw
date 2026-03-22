/**
 * Stdio MCP Server for NanoClaw aphexDATA (aphexDATA)
 * Standalone process providing 13 tools for recording paper trades,
 * signals, and events to a aphexDATA instance via its REST API.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const APHEXDATA_URL = (process.env.APHEXDATA_URL || '').replace(/\/+$/, '');
const APHEXDATA_API_KEY = process.env.APHEXDATA_API_KEY || '';
const APHEXDATA_AGENT_ID = process.env.APHEXDATA_AGENT_ID || '';

function log(message: string): void {
  console.error(`[aphexDATA] ${message}`);
}

async function aphexdataFetch(path: string, options?: RequestInit): Promise<any> {
  if (!APHEXDATA_URL) throw new Error('APHEXDATA_URL not configured');
  const url = `${APHEXDATA_URL}${path}`;
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

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// Resolve agent_id: use explicit param, fall back to env, or error
function resolveAgentId(explicit?: string): string {
  const id = explicit || APHEXDATA_AGENT_ID;
  if (!id) throw new Error('agent_id required — set APHEXDATA_AGENT_ID in .env or pass explicitly');
  return id;
}

const server = new McpServer({ name: 'aphexdata', version: '1.0.0' });

// ─── Agent Management ────────────────────────────────────────────────

server.tool(
  'aphexdata_register_agent',
  'Register a new agent in the aphexDATA. Returns the agent record with its UUID.',
  {
    external_id: z.string().describe('Unique external identifier for the agent'),
    name: z.string().describe('Display name for the agent'),
    agent_type: z.string().optional().describe('Agent type (e.g. "nanoclaw", "freqtrade")'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata'),
  },
  async (args) => {
    try {
      const data = await aphexdataFetch('/api/v1/agents', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      log(`Registered agent: ${data.id} (${args.name})`);
      return ok(data);
    } catch (e) {
      return err(`Failed to register agent: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_list_agents',
  'List all registered agents in the aphexDATA.',
  {},
  async () => {
    try {
      const data = await aphexdataFetch('/api/v1/agents');
      return ok(data);
    } catch (e) {
      return err(`Failed to list agents: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_get_agent',
  'Get details of a specific agent by ID.',
  {
    agent_id: z.string().describe('Agent UUID'),
  },
  async (args) => {
    try {
      const data = await aphexdataFetch(`/api/v1/agents/${args.agent_id}`);
      return ok(data);
    } catch (e) {
      return err(`Failed to get agent: ${(e as Error).message}`);
    }
  },
);

// ─── Event Recording ─────────────────────────────────────────────────

server.tool(
  'aphexdata_record_event',
  `Record a generic event in the aphexDATA. Use aphexdata_record_trade or aphexdata_record_signal for convenience.

verb_category: analysis | action | adjustment | communication | execution | monitoring
object_type: strategy | bot | trade | pair | portfolio | regime | report | signal | backtest | episode | config
trust_level: agent_asserted (default for agents)`,
  {
    agent_id: z.string().optional().describe('Agent UUID (defaults to APHEXDATA_AGENT_ID env var)'),
    competition_id: z.string().optional().describe('Competition UUID'),
    verb_id: z.string().describe('Action verb (e.g. "opened", "closed", "generated")'),
    verb_category: z.enum(['analysis', 'action', 'adjustment', 'communication', 'execution', 'monitoring']),
    object_type: z.enum(['strategy', 'bot', 'trade', 'pair', 'portfolio', 'regime', 'report', 'signal', 'backtest', 'episode', 'config']),
    object_id: z.string().describe('Object identifier (e.g. pair name, strategy name)'),
    result_data: z.record(z.string(), z.unknown()).optional().describe('Result data (arbitrary JSON)'),
    context: z.record(z.string(), z.unknown()).optional().describe('Context data (arbitrary JSON)'),
    occurred_at: z.string().optional().describe('ISO timestamp (defaults to now)'),
  },
  async (args) => {
    try {
      const body = {
        ...args,
        agent_id: resolveAgentId(args.agent_id),
        trust_level: 'agent_asserted',
      };
      const data = await aphexdataFetch('/api/v1/events', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      log(`Recorded event: ${data.id} (${args.verb_id} ${args.object_type}:${args.object_id})`);
      return ok(data);
    } catch (e) {
      return err(`Failed to record event: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_record_trade',
  'Record a paper trade event. Convenience wrapper that pre-fills verb_category=execution and object_type=trade.',
  {
    pair: z.string().describe('Trading pair (e.g. "BTC/USDT")'),
    side: z.enum(['long', 'short']).describe('Trade direction'),
    action: z.enum(['opened', 'closed', 'modified']).describe('What happened to the trade'),
    entry_price: z.number().optional().describe('Entry price'),
    exit_price: z.number().optional().describe('Exit price (for closed trades)'),
    stake_amount: z.number().optional().describe('Position size in quote currency'),
    profit_pct: z.number().optional().describe('Profit percentage (for closed trades)'),
    strategy: z.string().optional().describe('Strategy name'),
    timeframe: z.string().optional().describe('Timeframe (e.g. "5m", "1h")'),
    agent_id: z.string().optional().describe('Agent UUID (defaults to APHEXDATA_AGENT_ID)'),
    competition_id: z.string().optional().describe('Competition UUID'),
    context: z.record(z.string(), z.unknown()).optional().describe('Additional context'),
  },
  async (args) => {
    try {
      const result_data: Record<string, unknown> = { side: args.side };
      if (args.entry_price !== undefined) result_data.entry_price = args.entry_price;
      if (args.exit_price !== undefined) result_data.exit_price = args.exit_price;
      if (args.stake_amount !== undefined) result_data.stake_amount = args.stake_amount;
      if (args.profit_pct !== undefined) result_data.profit_pct = args.profit_pct;
      if (args.strategy) result_data.strategy = args.strategy;
      if (args.timeframe) result_data.timeframe = args.timeframe;

      const body = {
        agent_id: resolveAgentId(args.agent_id),
        competition_id: args.competition_id,
        verb_id: args.action,
        verb_category: 'execution',
        object_type: 'trade',
        object_id: args.pair,
        trust_level: 'agent_asserted',
        result_data,
        context: args.context || {},
      };

      const data = await aphexdataFetch('/api/v1/events', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      log(`Recorded trade: ${data.id} (${args.action} ${args.side} ${args.pair})`);
      return ok(data);
    } catch (e) {
      return err(`Failed to record trade: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_record_signal',
  'Record a trading signal event. Convenience wrapper that pre-fills verb_category=analysis and object_type=signal.',
  {
    pair: z.string().describe('Trading pair (e.g. "BTC/USDT")'),
    signal_type: z.enum(['buy', 'sell', 'hold']).describe('Signal direction'),
    confidence: z.number().min(0).max(1).optional().describe('Confidence score (0-1)'),
    strategy: z.string().optional().describe('Strategy that generated the signal'),
    indicators: z.record(z.string(), z.unknown()).optional().describe('Indicator values that triggered the signal'),
    agent_id: z.string().optional().describe('Agent UUID (defaults to APHEXDATA_AGENT_ID)'),
    competition_id: z.string().optional().describe('Competition UUID'),
    context: z.record(z.string(), z.unknown()).optional().describe('Additional context'),
  },
  async (args) => {
    try {
      const result_data: Record<string, unknown> = {};
      if (args.confidence !== undefined) result_data.confidence = args.confidence;
      if (args.strategy) result_data.strategy = args.strategy;
      if (args.indicators) result_data.indicators = args.indicators;

      const body = {
        agent_id: resolveAgentId(args.agent_id),
        competition_id: args.competition_id,
        verb_id: args.signal_type,
        verb_category: 'analysis',
        object_type: 'signal',
        object_id: args.pair,
        trust_level: 'agent_asserted',
        result_data,
        context: args.context || {},
      };

      const data = await aphexdataFetch('/api/v1/events', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      log(`Recorded signal: ${data.id} (${args.signal_type} ${args.pair})`);
      return ok(data);
    } catch (e) {
      return err(`Failed to record signal: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_query_events',
  'Query events from the aphexDATA with optional filters.',
  {
    agent_id: z.string().optional().describe('Filter by agent UUID'),
    competition_id: z.string().optional().describe('Filter by competition UUID'),
    verb_id: z.string().optional().describe('Filter by verb (e.g. "opened", "buy")'),
    verb_category: z.string().optional().describe('Filter by category (e.g. "execution", "analysis")'),
    object_type: z.string().optional().describe('Filter by object type (e.g. "trade", "signal")'),
    from: z.string().optional().describe('Start date (ISO format)'),
    to: z.string().optional().describe('End date (ISO format)'),
    limit: z.number().optional().describe('Max results (1-200, default 50)'),
  },
  async (args) => {
    try {
      const params = new URLSearchParams();
      for (const [key, val] of Object.entries(args)) {
        if (val !== undefined) params.set(key, String(val));
      }
      const qs = params.toString();
      const data = await aphexdataFetch(`/api/v1/events${qs ? `?${qs}` : ''}`);
      return ok(data);
    } catch (e) {
      return err(`Failed to query events: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_get_event',
  'Get a specific event by ID.',
  {
    event_id: z.string().describe('Event UUID'),
  },
  async (args) => {
    try {
      const data = await aphexdataFetch(`/api/v1/events/${args.event_id}`);
      return ok(data);
    } catch (e) {
      return err(`Failed to get event: ${(e as Error).message}`);
    }
  },
);

// ─── Competition ─────────────────────────────────────────────────────

server.tool(
  'aphexdata_list_competitions',
  'List all competitions in the aphexDATA.',
  {},
  async () => {
    try {
      const data = await aphexdataFetch('/api/v1/competitions');
      return ok(data);
    } catch (e) {
      return err(`Failed to list competitions: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_get_competition',
  'Get details of a specific competition.',
  {
    competition_id: z.string().describe('Competition UUID'),
  },
  async (args) => {
    try {
      const data = await aphexdataFetch(`/api/v1/competitions/${args.competition_id}`);
      return ok(data);
    } catch (e) {
      return err(`Failed to get competition: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_get_standings',
  'Get competition standings (leaderboard).',
  {
    competition_id: z.string().describe('Competition UUID'),
  },
  async (args) => {
    try {
      const data = await aphexdataFetch(`/api/v1/competitions/${args.competition_id}/standings`);
      return ok(data);
    } catch (e) {
      return err(`Failed to get standings: ${(e as Error).message}`);
    }
  },
);

// ─── System ──────────────────────────────────────────────────────────

server.tool(
  'aphexdata_health',
  'Check aphexDATA server health and database connectivity.',
  {},
  async () => {
    try {
      const data = await aphexdataFetch('/health');
      return ok(data);
    } catch (e) {
      return err(`aphexDATA health check failed: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'aphexdata_verify_integrity',
  'Verify the hash chain integrity of recorded events.',
  {
    limit: z.number().optional().describe('Number of events to verify (default 1000, max 10000)'),
    offset: z.number().optional().describe('Starting offset'),
  },
  async (args) => {
    try {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      const qs = params.toString();
      const data = await aphexdataFetch(`/api/v1/integrity/verify${qs ? `?${qs}` : ''}`);
      return ok(data);
    } catch (e) {
      return err(`Integrity verification failed: ${(e as Error).message}`);
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────

log(`Starting aphexDATA MCP server (url=${APHEXDATA_URL || 'NOT SET'}, agent=${APHEXDATA_AGENT_ID || 'NOT SET'})`);
const transport = new StdioServerTransport();
await server.connect(transport);

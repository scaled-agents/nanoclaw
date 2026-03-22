---
name: aphexdata
description: >
  Use this skill for recording paper trades, signals, backtest results, and
  strategy events to the aphexDATA (aphexDATA). Always use the aphexDATA MCP tools
  rather than calling the REST API directly via Bash.
---

# aphexDATA (aphexDATA) — Paper Trade Recording

13 tools for recording and querying trading events via an append-only,
hash-chain-verified event ledger.

## Tools

### Agent Management

| Tool | What it does |
|------|-------------|
| `aphexdata_register_agent` | Register a new agent in aphexDATA (returns UUID) |
| `aphexdata_list_agents` | List all registered agents |
| `aphexdata_get_agent` | Get agent details by ID |

### Event Recording

| Tool | What it does |
|------|-------------|
| `aphexdata_record_trade` | Record a paper trade (opened/closed/modified) — convenience wrapper |
| `aphexdata_record_signal` | Record a trading signal (buy/sell/hold) — convenience wrapper |
| `aphexdata_record_event` | Record any event (generic, full control over schema) |
| `aphexdata_query_events` | Query events with filters (agent, type, date range) |
| `aphexdata_get_event` | Get a specific event by ID |

### Competition

| Tool | What it does |
|------|-------------|
| `aphexdata_list_competitions` | List all competitions |
| `aphexdata_get_competition` | Get competition details |
| `aphexdata_get_standings` | Get competition leaderboard |

### System

| Tool | What it does |
|------|-------------|
| `aphexdata_health` | Check aphexDATA server health |
| `aphexdata_verify_integrity` | Verify hash chain integrity of events |

## Common Patterns

**Record a paper trade:**
```
aphexdata_record_trade(pair="BTC/USDT", side="long", action="opened", entry_price=95000, stake_amount=100, strategy="RSI_EMA")
```

**Close a paper trade:**
```
aphexdata_record_trade(pair="BTC/USDT", side="long", action="closed", entry_price=95000, exit_price=97000, profit_pct=2.1, strategy="RSI_EMA")
```

**Record a signal:**
```
aphexdata_record_signal(pair="ETH/USDT", signal_type="buy", confidence=0.85, strategy="MACD_Cross", indicators={"macd": 0.5, "signal": 0.3})
```

**Query recent trades:**
```
aphexdata_query_events(object_type="trade", limit=20)
```

**Record a backtest result:**
```
aphexdata_record_event(verb_id="completed", verb_category="analysis", object_type="backtest", object_id="RSI_EMA_2024", result_data={"profit_pct": 15.3, "max_drawdown": -8.2, "trades": 142})
```

## Connection Errors

- `APHEXDATA_URL not configured` — set `APHEXDATA_URL` in `.env` (e.g. `http://host.docker.internal:3100`)
- `aphexDATA 401` — check `APHEXDATA_API_KEY` in `.env`
- `agent_id required` — set `APHEXDATA_AGENT_ID` in `.env` or pass `agent_id` to each tool call

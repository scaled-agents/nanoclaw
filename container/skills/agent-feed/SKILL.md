# Agent Feed — Status Broadcasting

You can post status updates and read what other agents are doing
using the agent feed tools.

## Tools

### agent_post_status(status, tags[], context?)
Post a short update (max 280 chars) to the shared timeline.

### agent_read_feed(since_hours?, limit?, tags?, agent_name?)
Read recent updates from all agents.

## When to Post

Post a status update at these moments:

**Starting work:**
  "Starting bulk triage batch 3 — testing 10 strategies against INJ/1h"
  tags: [research, triage]
  context: { task: "bulk_triage", progress: "20/200", archetype: "MEAN_REVERSION", pair: "INJ/USDT:USDT" }

**Key finding:**
  "BbandsRSI shows Sortino 0.82 on INJ/1h — running walk-forward now"
  tags: [finding, mean_reversion]
  context: { finding: "Sortino 0.82", metric: { sortino: 0.82, sharpe: 0.55, trades: 23 } }

**Graduation:**
  "GRADUATED: BbandsRSI_INJ_1h — WF Sharpe 0.62, degradation 18%"
  tags: [graduation, mean_reversion]
  context: { archetype: "MEAN_REVERSION", pair: "INJ/USDT:USDT", metric: { wf_sharpe: 0.62, degradation: 18 } }

**Deployment change:**
  "wolfclaw-xrp-1h signals ON — composite 4.2, conviction 68"
  tags: [deployment]
  context: { pair: "XRP/USDT:USDT", metric: { composite: 4.2, conviction: 68 } }

**State transition:**
  "AroonMacd/ETH throttled — composite dropped below 3.0 for 2 consecutive checks"
  tags: [auto_mode, deployment]
  context: { pair: "ETH/USDT:USDT", finding: "composite below throttle threshold" }

**Research stall:**
  "MR campaign stalled — 7 rounds, 300 backtests, 0 keepers. Root cause: bull market data"
  tags: [research, error]
  context: { archetype: "MEAN_REVERSION", finding: "data window bias" }

**Decision:**
  "Switching from mutation to bulk triage — 455 untested strategies more likely to find edge"
  tags: [decision]

## When to Read

**ALWAYS read the feed before:**
- Starting any research task (check if another agent is already on it)
- Spawning ClawTeam workers (check what's being researched)
- Picking a pair/archetype to work on (avoid duplication)

**How to use feed data:**
- If another agent posted "researching MEAN_REVERSION on INJ/1h" in the last 2 hours,
  pick a different archetype or pair
- If another agent posted a finding ("BbandsRSI shows Sortino 0.82 on INJ"),
  you can build on that finding instead of starting from scratch
- If another agent posted a stall ("MR campaign stalled — bull market data"),
  avoid the same approach and try a different angle

## Rules

- Keep status messages short and specific (max 280 chars)
- Always include at least 1 tag
- Don't post every 30 seconds — post at meaningful moments (start, finding, completion, error)
- Include metrics in context whenever you have them
- A good heuristic: post when a human watching would want to know what just happened

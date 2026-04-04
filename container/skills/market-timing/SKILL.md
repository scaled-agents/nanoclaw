---
name: market-timing
description: >
  Market Timing Agent — scores 560 cells (7 archetypes × 20 pairs × 4 timeframes) with
  regime_fit, execution_fit, net_edge subscores (0–6 scale), produces deployment rotation
  plans, and manages portfolio-level risk. Orchestrates orderflow, macro-sentiment,
  onchain-intel, ct-sentiment, archetype-taxonomy, freqtrade-mcp, freqswarm, and aphexdata
  skills. Trigger on: "market timing", "score cells", "deployment rotation", "what should
  we deploy", "rebalance deployments", "scoring cycle", "run timing agent".
---

# Market Timing Agent — Orchestration Workflow

Scores 560 cells (7 archetypes × 20 pairs × 4 timeframes), compares against current
deployments, produces rotation plans, and logs all decisions to aphexDATA.

## Dependencies

| Skill | Purpose |
|-------|---------|
| `orderflow` | regime_fit + execution_fit data (MCP tools) |
| `macro-sentiment` | Macro context overlay (reports) |
| `onchain-intel` | Derivatives + on-chain context (reports) |
| `ct-sentiment` | Narrative sentiment context (reports) |
| `archetype-taxonomy` | Archetype definitions + scoring rubrics |
| `freqtrade-mcp` | Live bot control (deploy/undeploy) |
| `freqswarm` | Historical backtest data (net_edge) |
| `aphexdata` | Audit trail for all decisions |
| `freqhub` | Strategy registry (strategy lookup) |

## Full Scoring Cycle Workflow

### Phase 1: Gather Data

**1a. Read archetype taxonomy**
```bash
cat /workspace/skills/archetype-taxonomy/archetypes.yaml
```

**1b. Fetch regime data for all pairs**
```
orderflow_scan_opportunities(min_conviction=0)
```
This returns regime + conviction + `liquidity_percentile` for all 22 tracked symbols across all 5 horizons.
Filter to the 20 grid pairs and the relevant horizons.

**1b-extra. Extract volume weights from regime data**

From the Phase 1b scan results, for each pair extract `liquidity_percentile` (0–100).
Compute `volume_weight` per pair:
```
max_liq = max(liquidity_percentile across all 20 pairs)
volume_weight[pair] = liquidity_percentile[pair] / max_liq   # normalized 0.0–1.0
```
If `max_liq == 0` or liquidity data is unavailable, set `volume_weight = 1.0` for all pairs.

**1c. Fetch microstructure for all pairs**
```
orderflow_fetch_microstructure(symbols=["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "TON", "SUI", "DOT", "SHIB", "NEAR", "UNI", "LTC", "BCH", "APT", "ARB", "OP"])
```

**1d. Read context reports (if available)**
Read these workspace files if they exist — don't fail if missing:
```bash
cat /workspace/group/reports/macro-latest.json 2>/dev/null || echo "{}"
cat /workspace/group/reports/onchain-latest.json 2>/dev/null || echo "{}"
cat /workspace/group/reports/sentiment-latest.json 2>/dev/null || echo "{}"
```

**1e. Read previous cell grid (if exists)**
```bash
cat /workspace/group/reports/cell-grid-latest.json 2>/dev/null || echo "[]"
```

**1e-extra. Compute trend_boost from previous grid**

For each cell `(archetype, pair, timeframe)`, look up its `composite` in the previous grid:
- If previous composite exists:
  - `delta = current_composite - previous_composite`
  - `delta > 0.3` → `trend_boost = +0.2` (rising)
  - `delta < -0.3` → `trend_boost = -0.1` (falling)
  - else → `trend_boost = 0.0` (flat)
- If no previous data → `trend_boost = 0.0`

### Phase 2: Score All 560 Cells

For each cell `(archetype, pair, timeframe)`:

**2a. Compute regime_fit (0–6)**

Map timeframe to horizon: 5m→H1_MICRO, 15m→H1_MICRO, 1h→H2_SHORT, 4h→H3_MEDIUM

Look up the regime data from Phase 1b for this (pair, horizon). Then:
- If regime is in archetype.preferred_regimes:
  - conviction >= 80 → **6**
  - conviction >= 60 → **5**
  - conviction < 60 → **4**
- If regime is NOT in preferred AND NOT in anti → **3**
- If regime is in archetype.anti_regimes:
  - conviction < 40 → **2**
  - conviction >= 40 → **1**
  - conviction >= 60 → **0**

**2b. Compute execution_fit (0–6)**

Use microstructure data from Phase 1c. For each pair, evaluate:
- **Whale signal:** whaleFlowDelta > 0 = bullish, < 0 = bearish, ~0 = neutral
- **Book signal:** bookImbalanceEma > 0.15 = bid_heavy, < -0.15 = ask_heavy, else balanced
- **Aggressor signal:** aggressorRatio > 0.55 = accumulation, < 0.45 = distribution, else neutral

Count aligned signals (signals matching the archetype's direction preference):
- 3 aligned → **6**
- 2 aligned, 1 neutral → **5**
- 1 aligned, others neutral → **4**
- All neutral → **3**
- 1 negative → **2**
- 2 negative → **1**
- 3 negative → **0**

**2c. Compute net_edge (0–6)**

Look up historical WFO performance for the best strategy matching this cell:
1. Search FreqHub: `sdna search --tag <archetype_tag> --json` filtered to this pair+timeframe
2. Or query aphexDATA: `aphexdata_query_events(verb_id="attested", object_type="strategy")` for strategies matching this archetype+pair+timeframe

Use the best WF Sharpe found:
- WF Sharpe >= 1.5, DD < 10%, trades >= 30 → **6**
- WF Sharpe >= 1.0, DD < 15% → **5**
- WF Sharpe >= 0.5, DD < 20% → **4**
- WF Sharpe >= 0.0 → **3**
- WF Sharpe > -0.5 → **2**
- WF Sharpe > -1.0 → **1**
- No data or WF Sharpe <= -1.0 → **0**

If no backtest data exists for this cell, score **0** (no edge proven).

**2d. Compute composite + priority fields**

If `/workspace/group/scoring-config.json` exists, read composite weights from it
instead of the defaults below (keys: `COMPOSITE_WEIGHTS`, `DEPLOY_THRESHOLD`,
`UNDEPLOY_THRESHOLD`, `MACRO_OVERLAY`, `REGIME_FIT_RUBRIC`, `NET_EDGE_THRESHOLDS`,
`PORTFOLIO_CONSTRAINTS`).

```
composite = (regime_fit × 0.4) + (execution_fit × 0.25) + (net_edge × 0.35)
```

Attach volume_weight (from Phase 1b-extra) and trend_boost (from Phase 1e-extra) to each cell.
Compute adjusted_priority for ranking (not stored separately):
```
adjusted_priority = composite × volume_weight × (1 + trend_boost)
```

**2e. Apply macro overlay (optional boost/penalty)**

If macro context reports are available:
- `risk_sentiment.level == "risk_off"` → reduce all composite scores by 0.5
- `risk_sentiment.level == "risk_on"` → boost TREND_MOMENTUM and BREAKOUT by 0.3
- `sentiment_extreme_risk == true` (from ct-sentiment) → reduce all by 0.5
- `narrative_alignment == true` → boost aligned archetypes by 0.2

### Phase 3: Rank & Apply Portfolio Constraints

**3a. Sort all 560 cells by adjusted_priority (descending)**

```
adjusted_priority = composite × volume_weight × (1 + trend_boost)
```

**3b. Apply portfolio constraints (from archetypes.yaml)**

Walk through cells top-down. For each cell scoring above deploy threshold (3.5):
- Check: max 5 deployments per archetype
- Check: max 3 deployments per pair
- Check: max 20 total deployments
- Check: max 10% capital per deployment
- Check: max 25% capital per archetype
- Check: max 15% capital per pair

**3c. Check portfolio circuit breaker**

If current portfolio drawdown exceeds 15%:
- **PAUSE all new deployments**
- Only allow undeployments
- Log to aphexDATA: `verb_id="circuit_breaker", result_data={dd_pct, threshold}`

### Phase 4: Deployment Diff

**4a. Get current live deployments**
```
freqtrade_fetch_bot_status()
```

**4b. Compare target vs current**

For each cell in the target deployment list (above threshold + within constraints):
- If already deployed with the right strategy → **HOLD** (no action)
- If not deployed → **DEPLOY**
- If deployed with a different/inferior strategy → **ROTATE** (undeploy old, deploy new)

For each current deployment NOT in the target list:
- If cell composite < undeploy threshold (2.0) → **UNDEPLOY**
- If cell composite between 2.0 and 3.5 → **MONITOR** (keep but flag)

**4c. Generate rotation plan**

```json
{
  "timestamp": "ISO-8601",
  "actions": [
    {"type": "DEPLOY", "archetype": "TREND_MOMENTUM", "pair": "BTC/USDT", "timeframe": "1h", "strategy": "EMA_Crossover_v3", "composite": 4.8, "reason": "High regime_fit + proven edge"},
    {"type": "UNDEPLOY", "pair": "XRP/USDT", "strategy": "RSI_Range_v2", "composite": 1.5, "reason": "Regime shifted to CHAOS"},
    {"type": "HOLD", "pair": "ETH/USDT", "strategy": "Trend_v4", "composite": 4.2}
  ],
  "portfolio_summary": {
    "total_deployments": 7,
    "capital_allocated_pct": 65,
    "max_archetype_concentration": "TREND_MOMENTUM: 28%",
    "circuit_breaker_active": false
  }
}
```

### Phase 5: Execute (with approval gate)

**For each DEPLOY action:**
1. Ensure strategy is compiled: `sdna compile <genome>.sdna -o strategies/`
2. Start the bot: `freqtrade_start_bot(strategy=<name>, pairs=[pair], timeframe=tf)`
3. Log: `aphexdata_record_event(verb_id="deployed", object_type="strategy", result_data={...})`

**For each UNDEPLOY action:**
1. Stop the bot: `freqtrade_stop_bot(strategy=<name>)`
2. Log: `aphexdata_record_event(verb_id="undeployed", object_type="strategy", result_data={...})`

**For each HOLD action:**
1. Log only if score changed significantly: `aphexdata_record_event(verb_id="held", ...)`

### Phase 6: Store & Log

**6a. Save cell grid snapshot**

Each cell in the JSON array must include `volume_weight` and `trend_boost`:
```json
{
  "archetype": "TREND_MOMENTUM", "pair": "BTC/USDT:USDT", "timeframe": "1h",
  "regime": "EFFICIENT_TREND", "conviction": 78,
  "regime_fit": 5, "execution_fit": 4, "net_edge": 5, "composite": 4.8,
  "volume_weight": 0.95, "trend_boost": 0.2,
  "deployed_strategy": "TrendV4_BTC", "deployment_id": "wolfclaw-btc-1h",
  "scored_at": "2026-03-31T12:34:28Z"
}
```

```bash
# Write the full 560-cell grid with scores to workspace
cat > /workspace/group/reports/cell-grid-latest.json << 'EOF'
[... full grid ...]
EOF

# Also save timestamped version for history
cp /workspace/group/reports/cell-grid-latest.json \
   /workspace/group/reports/cell-grid-$(date +%Y-%m-%d-%H%M).json
```

**6b. Log scoring cycle to aphexDATA**
```
aphexdata_record_event(
  verb_id="scoring_cycle",
  verb_category="analysis",
  object_type="report",
  object_id="market_timing_YYYY-MM-DD_HH",
  result_data={
    "cells_scored": 560,
    "cells_above_deploy": <count>,
    "cells_above_undeploy": <count>,
    "actions_deploy": <count>,
    "actions_undeploy": <count>,
    "actions_hold": <count>,
    "top_cell": {"archetype": "...", "pair": "...", "timeframe": "...", "composite": 4.8},
    "volume_weight_range": {"min": 0.12, "avg": 0.65, "max": 1.0},
    "trend_distribution": {"rising": <count>, "flat": <count>, "falling": <count>},
    "portfolio_dd_pct": <current>,
    "circuit_breaker_active": false
  }
)
```

**6c. Log each deployment action**
```
aphexdata_record_event(
  verb_id="deployed" | "undeployed" | "rotated",
  verb_category="execution",
  object_type="strategy",
  object_id=<strategy_name>,
  result_data={
    "archetype": "...",
    "pair": "...",
    "timeframe": "...",
    "composite": 4.8,
    "regime_fit": 5, "execution_fit": 4, "net_edge": 5,
    "reason": "High regime alignment + proven WF edge"
  }
)
```

## Scheduled Execution

The Market Timing scoring cycle should run every 4 hours as a scheduled task:

```
schedule_task(
  name: "market_timing_cycle",
  schedule: "0 */4 * * *",
  prompt: "Run a full Market Timing scoring cycle: score all 560 cells (7 archetypes × 20 pairs × 4 timeframes), compare against current deployments, generate rotation plan, execute approved actions, and log everything to aphexDATA."
)
```

## Quick Commands

| Request | What Happens |
|---------|-------------|
| "Score all cells" | Phase 1–2 only: gather data, score 560 cells, report |
| "Run scoring cycle" | Full Phase 1–6: score, diff, plan, execute, log |
| "What should we deploy?" | Phase 1–4: score + diff + rotation plan (no execution) |
| "Rebalance deployments" | Phase 1–6 with emphasis on portfolio constraints |
| "Check deployment alignment" | `orderflow_check_alignment` with current deployments |
| "Show cell grid" | Read and display `/workspace/group/reports/cell-grid-latest.json` |

## Reporting

After each scoring cycle, send a summary message:

```markdown
## Market Timing — Scoring Cycle Report
**Time:** YYYY-MM-DD HH:MM UTC
**Cells scored:** 560 | **Above deploy:** N | **Above undeploy:** N

### Top 5 Cells
| Archetype | Pair | TF | Regime | R-Fit | E-Fit | Edge | Comp | Action |
|-----------|------|----|--------|-------|-------|------|------|--------|
| TREND_MOMENTUM | BTC | 1h | EFFICIENT_TREND | 6 | 5 | 5 | 5.35 | DEPLOY |

### Rotation Plan
- DEPLOY: N strategies
- UNDEPLOY: N strategies
- HOLD: N strategies

### Portfolio
- Active: N/20 | Capital: N% | DD: N%
- Circuit breaker: OFF
```

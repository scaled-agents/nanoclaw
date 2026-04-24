# NANOCLAW_QUICKSTART.md
# Getting NanoClaw running your first strategy analysis

---

## The immediate scenario

You hand NanoClaw:
- A `strategy.py` file
- An exchange `config.json` file
- Optionally: date range, specific instructions

NanoClaw does the rest: validate → backtest → optimize → walk-forward → report.

---

## What needs to exist for this to work

### Already built
- [x] freqtrade-mcp — 50 tools wrapping FreqTrade CLI (strategy management, backtesting, hyperopt, walk-forward, live trading)
- [x] aphexDATA — 13 tools for tamper-evident event recording (trades, signals, backtests)
- [x] NanoClaw — scheduling, messaging, orchestration, IPC
- [x] Tool routing — MCP servers auto-discovered via `buildMcpServers()` in `container/agent-runner/src/index.ts`
- [x] File handoff — strategies at `/workspace/group/user_data/strategies/`, configs at `/workspace/group/user_data/`

### What the system prompt gives you (no code needed)
- [x] Decision logic for when to proceed vs ask
- [x] Default settings for every parameter
- [x] Report format
- [x] Quality thresholds
- [x] Workflow selection (strategy analysis, validation, data management, reporting)

### What you need to wire up
- [ ] **Deploy the system prompt** — replace the generic Andy persona in `groups/global/CLAUDE.md` with the NanoClaw strategy analyst persona from `docs/NANOCLAW_SYSTEM_PROMPT.md`

That's it. Everything else is wired.

---

## Example interaction

```
You: Here's my strategy [attaches EMA_Cross_Strategy.py and binance_config.json].
     Test it on BTC/USDT and ETH/USDT from Jan 2025 to now.
     Run a walk-forward and tell me if it's worth deploying.

NanoClaw: [internally executes Workflow A]

1. freqtrade_validate_strategy("EMA_Cross_Strategy.py") → PASS
2. freqtrade_detect_strategy_issues("EMA_Cross_Strategy.py") → No issues
3. freqtrade_download_data(pairs=["BTC/USDT","ETH/USDT"], timeframe="4h",
                            start="2025-01-01", end="2026-03-18")
4. freqtrade_run_backtest(strategy="EMA_Cross_Strategy", config="binance_config.json")
5. freqtrade_run_hyperopt(epochs=200, loss="SortinoHyperOptLoss")
6. freqtrade_run_walk_forward(strategy="EMA_Cross_Strategy_opt",
                               windows=6, train_ratio=0.7)
7. aphexdata_record_event(type="pipeline_complete", strategy="EMA_Cross_Strategy")
8. send_message(report)
```

---

## The answer to your three questions

### 1. "Do I need to implement UC1/UC2 as runnable workflows?"

**Not yet.** The system prompt gives NanoClaw the decision logic to execute
these workflows through its normal reasoning loop. You don't need a hardcoded
DAG or state machine. The LLM reads the system prompt, sees the available
tools, and chains them together.

What you DO need:
- The system prompt deployed (in `groups/global/CLAUDE.md`)
- The MCP servers connected (freqtrade-mcp, aphexdata — all already wired)
- NanoClaw's messaging working (send_message)

### 2. "Should we build a system prompt?"

**Yes, that's the NANOCLAW_SYSTEM_PROMPT.md above.** It encodes:
- What tools exist and when to use each one
- The step-by-step workflow for each scenario
- Decision rules for autonomous operation vs asking the user
- Default parameters so the user doesn't have to specify everything
- Quality thresholds so NanoClaw can make judgment calls
- Anti-patterns to prevent common mistakes
- A standardized report format

### 3. "Can I just give it files and have it analyze/test/report?"

**Yes — that's Workflow A in the system prompt.** The key insight is that
you don't need workflow orchestration infrastructure for this. The system
prompt + tool access is sufficient. The LLM's reasoning loop IS the
orchestrator.

The sequence is:
1. Deploy system prompt into `groups/global/CLAUDE.md`
2. MCP servers are already connected
3. Say "here's my strategy, test it"
4. NanoClaw follows Workflow A autonomously

---

## Build progression

Each step builds on the last. Don't skip ahead.

### Step 1: Single strategy analysis (Workflow A) ← YOU ARE HERE
- Deploy the system prompt
- Test: give NanoClaw a strategy.py + config.json, verify it runs the full pipeline
- Goal: tight validate → backtest → optimize → walk-forward → report loop

### Step 2: Batch mode
- "Test these 5 strategies" → NanoClaw runs Workflow A for each
- Compare results across strategies

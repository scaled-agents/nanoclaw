# TECHNICAL_ROADMAP.md
# FreqHub Technical Roadmap — Phased Implementation Plan
# For Claude Code: Work through these phases in order. Do not skip ahead.

---

## How to Use This Document

This roadmap has 7 phases (plus Phase 1 already complete). Each phase has a gate — a concrete test that must
pass before moving to the next phase. Do not start Phase N+1 until Phase N's
gate passes. This is intentional. Each phase fixes or builds something that
the next phase depends on.

When you start a new phase, read the entire phase first, explore the relevant
code, then implement. Test against the gate criteria before reporting done.

---

## Current State (March 2026)

What works:
- NanoClaw agent with 100 MCP tools across 5 servers
- FreqHub registry with genomes, DAG, leaderboard
- aphexDNA core with genome format, compile, attest
- FreqTrade MCP with 57 tools
- aphexDATA with 13 tools and event logging
- FreqSwarm with parallel execution (4-8 workers)
- Autoresearch loop (Workflow I) defined in system prompt

What's broken:
- FreqSwarm orchestrator crashes on walkforward_batch
- No pre-flight validation before swarm runs
- Error reporting: 0/400 failures return exit code 0 with no error message
- Spec format confusion causes silent failures
- NanoClaw goes unresponsive under concurrent load
- Leaderboard ranks by raw Sharpe (Sharpe 18.93 = #1 with 6 trades)
- No dashboard for research metrics
- No composite scoring (Aphex)

---

## Target Architecture

The system has five components, each with a single responsibility.
The diagram below shows the end state we're building toward across
all 6 phases.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   ClawTeam (Phase 4+)                                          │
│   Role: BRAIN — coordination, communication, strategy           │
│                                                                 │
│   What it does:                                                 │
│   • Spawns multiple NanoClaw worker agents                      │
│   • Assigns research directions (RSI explorer, regime tuner...) │
│   • Routes messages between workers (inbox protocol)            │
│   • Cross-pollinates discoveries across workers                 │
│   • Tracks task dependencies and worker lifecycle               │
│   • Provides tmux dashboard for monitoring                      │
│                                                                 │
│   What it does NOT do:                                          │
│   • Run backtests (that's FreqSwarm)                            │
│   • Manage genomes (that's FreqHub)                             │
│   • Know anything about trading (domain-agnostic)               │
│                                                                 │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐      │
│   │ NanoClaw     │   │ NanoClaw     │   │ NanoClaw     │      │
│   │ Worker 1     │   │ Worker 2     │   │ Worker 3     │      │
│   │ (RSI expert) │   │ (Regime exp) │   │ (Risk tuner) │      │
│   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘      │
│          │                  │                   │               │
│   Future: workers can be any CLI agent runtime:                 │
│   NanoClaw (Claude) | OpenClaw | nanobot | Codex                │
│   All connect to the same MCP tools and FreqHub registry.       │
│                                                                 │
└──────────┼──────────────────┼───────────────────┼───────────────┘
           │                  │                   │
           └──────────────────┼───────────────────┘
                              │
                    Each worker is a
                    NanoClaw instance (today)
                    Any CLI agent (future)
                              │
┌─────────────────────────────┼───────────────────────────────────┐
│                             │                                   │
│   NanoClaw                  ▼                                   │
│   Role: AGENT RUNTIME — identity, tools, skills                 │
│                                                                 │
│   What it does:                                                 │
│   • Provides the WolfClaw system prompt (agent identity)        │
│   • Connects MCP tools (FreqTrade, aphexDNA, aphexDATA)            │
│   • Hosts the skills library (how to use each tool)             │
│   • Runs the agent container (boot, auth, lifecycle)            │
│   • Bridges to ClawTeam (inbox ↔ send_message)                  │
│                                                                 │
│   What it does NOT do:                                          │
│   • Coordinate multiple agents (that's ClawTeam)                │
│   • Run parallel backtests (that's FreqSwarm)                   │
│   • Store genomes or DAG (that's FreqHub)                       │
│                                                                 │
│   Talks to:                                                     │
│   ┌─────────────┐  ┌──────────────┐  ┌─────────────┐           │
│   │ FreqTrade   │  │ aphexDNA  │  │ aphexDATA         │           │
│   │ MCP (57)    │  │ MCP (16)     │  │ MCP (13)    │           │
│   └──────┬──────┘  └──────┬───────┘  └──────┬──────┘           │
│          │                │                  │                  │
└──────────┼────────────────┼──────────────────┼──────────────────┘
           │                │                  │
           ▼                ▼                  ▼
┌──────────────────┐ ┌───────────────┐ ┌──────────────────┐
│                  │ │               │ │                  │
│ FreqSwarm        │ │ FreqHub       │ │ aphexDATA              │
│ (lib, Phase 5)   │ │               │ │                  │
│                  │ │ Role: MEMORY  │ │ Role: NERVOUS    │
│ Role: MUSCLE     │ │               │ │ SYSTEM           │
│                  │ │ What it does: │ │                  │
│ What it does:    │ │ • Genome      │ │ What it does:    │
│ • Parallel       │ │   registry    │ │ • Event logging  │
│   backtest       │ │ • DAG with    │ │ • Audit trail    │
│   execution      │ │   lineage     │ │ • Metric         │
│ • Walk-forward   │ │ • Leaderboard │ │   computation    │
│   validation     │ │   (Aphex)     │ │ • Dashboard      │
│ • Mutation       │ │ • Attestation │ │   API + UI       │
│   engine         │ │   storage     │ │ • Weekly         │
│ • Dataset prep   │ │ • Frontier    │ │   snapshots      │
│   and freeze     │ │   computation │ │ • North star     │
│ • Preflight      │ │ • sdna CLI    │ │   metric         │
│   validation     │ │ • GitHub      │ │                  │
│                  │ │   hosting     │ │ Does NOT:        │
│ Does NOT:        │ │               │ │ • Run backtests  │
│ • Coordinate     │ │ Does NOT:     │ │ • Store genomes  │
│   agents         │ │ • Run any     │ │ • Coordinate     │
│ • Manage job     │ │   backtests   │ │   agents         │
│   queues         │ │ • Coordinate  │ │                  │
│   (Phase 5)      │ │   agents      │ │                  │
│ • Poll for jobs  │ │ • Execute     │ │                  │
│   (Phase 5)      │ │   trades      │ │                  │
│                  │ │               │ │                  │
└──────────────────┘ └───────────────┘ └──────────────────┘
```

### Data flow for one autoresearch experiment

```
1. ClawTeam leader assigns: "Explore RSI mutations"
                    │
                    ▼
2. NanoClaw worker receives task via inbox
   Reads frontier from FreqHub (sdna frontier)
   Picks top genome, generates mutation
                    │
                    ▼
3. NanoClaw calls aphexDNA: sdna fork --mutations
   New child genome created with parent pointer
                    │
                    ▼
4. NanoClaw calls aphexDNA: sdna compile
   Genome → FreqTrade IStrategy .py file
                    │
                    ▼
5. NanoClaw calls FreqSwarm library: execute_walkforward
   FreqSwarm runs 4-window walk-forward with parallel workers
   Returns structured results
                    │
                    ▼
6. NanoClaw compares child Sharpe to parent Sharpe
                    │
              ┌─────┴─────┐
              ▼           ▼
         IMPROVED     NOT IMPROVED
              │           │
              ▼           ▼
7a. sdna attest    7b. aphexdata_record_event
    sdna registry      (verb: discarded,
    add                 mutation details)
              │           │
              └─────┬─────┘
                    ▼
8. NanoClaw reports to ClawTeam leader via inbox:
   "Tested RSI period 21: Sharpe 1.24→1.31, KEPT"
                    │
                    ▼
9. Leader cross-pollinates: tells other workers
   "RSI period 21 worked — try it with your genomes too"
                    │
                    ▼
10. Loop: worker picks next frontier node, repeats from step 2
```

### Component lifecycle across phases

```
Phase 1: [NanoClaw] ←→ [FreqSwarm (fix bugs)] ←→ [FreqHub] ←→ [aphexDATA]          ✅ DONE
         Single agent, stable execution, clear errors

Phase 2: [NanoClaw] ←→ [FreqTrade MCP] ←→ [FreqHub (seed 397 strategies)]     ← YOU ARE HERE
         Single agent, validate → screen → walk-forward → register

Phase 3: [NanoClaw] ←→ [FreqSwarm (+ autoresearch)] ←→ [FreqHub] ←→ [aphexDATA]
         Single agent, autoresearch loop, daytime → overnight

Phase 4: [NanoClaw] ←→ [FreqSwarm] ←→ [FreqHub (+ Aphex)] ←→ [aphexDATA (+ dashboard)]
         Single agent, measurement framework, correct scoring

Phase 5: [ClawTeam] → [NanoClaw ×3] ←→ [FreqSwarm] ←→ [FreqHub] ←→ [aphexDATA]
         Multi-agent, coordinated research, cross-pollination

Phase 6: [ClawTeam] → [NanoClaw ×3] ←→ [FreqSwarm (lib)] ←→ [FreqHub] ←→ [aphexDATA]
         FreqSwarm slimmed to library, no daemon/queue

Phase 7: [ClawTeam] → [NanoClaw ×3] ←→ [FreqSwarm (lib)] ←→ [FreqHub] ←→ [aphexDATA]
         Production hardened, monitored, documented
```

---

## Phase 1: Stabilize the Foundation ✅ COMPLETE
**Timeline: 1 week — DONE**
**Goal: One NanoClaw agent can reliably run sweeps and autoresearch loops
without crashing, with clear error messages when something goes wrong.**

### 1.1 Fix the walkforward_batch crash

This is the #1 blocker. The swarm orchestrator has been crashing on every
walkforward_batch task. Nothing else matters until this works.

Steps:
1. Find the actual Python traceback from a failed walkforward_batch
   (check stderr logs, job report directories, swarm.db)
2. Identify the root cause (corrupted DB, resource leak, code regression,
   Docker image issue)
3. Fix it
4. Run a single walkforward_batch manually to confirm the fix
5. Run a 10-combination sweep to confirm it works under parallel load

### 1.2 Add pre-flight checks

Implement the swarm pre-flight system from SWARM_QUALITY_SPEC.md:
- New preflight_check thread type in FreqSwarm
- Insert preflight as first DAG node in all DAG builders
- System prompt update with mandatory pre-flight checklist

### 1.3 Fix error reporting

From SWARM_QUALITY_SPEC.md:
- Common error detection (surface the actual error, not "0/400 succeeded")
- Fix exit codes (exit 1 on total failure, not exit 0)
- Fix status: "failed" when all tasks fail, not "completed"
- Surface common_error in swarm_poll_run response

### 1.4 Fix spec format validation

The CMCWinner incident showed that invalid spec formats are silently
accepted and crash the orchestrator. Add validation:
- Validate spec JSON against the schema before writing .request.json
- Reject invalid specs with a clear error message
- Document the correct spec format in the swarm SKILL.md with examples

### Phase 1 Gate

All of the following must pass:

```
[ ] A 100-combination sweep (20 pairs × 5 timeframes) completes
    with >80% of backtests succeeding (some failures for missing
    data are expected)
[ ] A sweep with a missing strategy file fails IMMEDIATELY with
    a clear "strategy not found" message (not after 400 individual failures)
[ ] A sweep with wrong spec format is rejected at submission time
    with a clear error (not accepted and crashed during execution)
[ ] Exit code is 1 when all tasks fail
[ ] NanoClaw can read common_error from swarm_poll_run and report
    the root cause to the user without digging through logs
[ ] Run 3 consecutive sweeps for different strategies — all complete
    successfully without orchestrator crashes
```
---

## Phase 2: Seed the Registry
**Timeline: 2-3 days**
**Goal: Turn 397 open-source FreqTrade strategies into a seeded FreqHub
registry with walk-forward validated, Aphex-scored genomes ready for
the autoresearch loop to mutate.**

Phase 1 is complete — the swarm is stable. NanoClaw can now run all
three stages. Stages 1 and 2 run sequentially (no swarm needed).
Stage 3 uses the swarm for parallel walk-forward execution.

### Source data

397 FreqTrade strategy .py files located at:
`D:\Users\scale\Code\open-strategy\open-strategy\quant-tactics\nova\`

### Target pairs (top 20 by market cap)

```
BTC/USDT:USDT    ETH/USDT:USDT    BNB/USDT:USDT    SOL/USDT:USDT
XRP/USDT:USDT    ADA/USDT:USDT    DOGE/USDT:USDT   AVAX/USDT:USDT
DOT/USDT:USDT    LINK/USDT:USDT   MATIC/USDT:USDT  UNI/USDT:USDT
ATOM/USDT:USDT   LTC/USDT:USDT    NEAR/USDT:USDT   AAVE/USDT:USDT
SUI/USDT:USDT    APT/USDT:USDT    ARB/USDT:USDT    OP/USDT:USDT
```

### Stage 1: Validate and filter (~1-2 hours)

**NanoClaw prompt:**

```
I have 397 FreqTrade strategy .py files in /nova directory.

For each file:
1. Copy it to /freqtrade/user_data/strategies/
2. Run freqtrade_validate_strategy to check if it loads cleanly
3. Record the result: PASS (loads, class found) or FAIL (error message)

After scanning all 397:
- Produce a summary report:
  - Total: 397
  - PASS: [count] — ready for backtesting
  - FAIL: [count] — broken
- Group failures by error type (import error, syntax error, missing
  dependency, wrong FreqTrade version, no class found, etc.)
- List the top 10 most common failure reasons with counts
- Save the list of PASS strategies to a file: valid_strategies.json
  Format: [{"class_name": "ActionZone", "file": "ActionZone.py"}, ...]

Do NOT attempt to fix broken strategies. Just classify and report.
Work through them in batches of 20 to avoid overwhelming the system.
```

**What to check after Stage 1:**
- valid_strategies.json exists with the list of loadable strategies
- The failure report makes sense (common failures should be known issues
  like old FreqTrade API, missing ta-lib indicators, Python 2 syntax)
- Probably 200-280 strategies pass, 120-200 fail

### Stage 2: Quick screen across 20 pairs (~8-12 hours)

**NanoClaw prompt:**

```
Read valid_strategies.json — it contains all strategies that passed
validation in Stage 1.

For each valid strategy, run a single backtest across these 20 pairs
on the 4h timeframe, using the last 12 months of data:

Pairs: BTC/USDT:USDT, ETH/USDT:USDT, BNB/USDT:USDT, SOL/USDT:USDT,
XRP/USDT:USDT, ADA/USDT:USDT, DOGE/USDT:USDT, AVAX/USDT:USDT,
DOT/USDT:USDT, LINK/USDT:USDT, MATIC/USDT:USDT, UNI/USDT:USDT,
ATOM/USDT:USDT, LTC/USDT:USDT, NEAR/USDT:USDT, AAVE/USDT:USDT,
SUI/USDT:USDT, APT/USDT:USDT, ARB/USDT:USDT, OP/USDT:USDT

Config: futures mode, USDT stake, 1000 USDT starting balance.
Timeframe: 4h. Timerange: last 12 months.

Before starting: download 4h candle data for all 20 pairs for the
last 14 months (extra 2 months for indicator warmup).

This is a TRIAGE pass — simple backtests, no walk-forward yet.

For each strategy, record:
- Strategy name
- Total trades
- Win rate %
- Profit factor
- Total profit %
- Max drawdown %
- Sharpe ratio
- Best performing pair
- Worst performing pair

After all strategies are tested, produce a ranked report:
1. Filter OUT strategies with:
   - Total trades < 10 (insufficient data)
   - Profit factor < 0.5 (catastrophically bad)
   - Max drawdown > 60% (unmanageable risk)
2. Rank remaining by profit factor descending
3. Show top 60 strategies with all metrics

Save the survivors list to: screen_survivors.json
Format: [{"class_name": "...", "file": "...", "trades": N,
  "win_rate": N, "profit_factor": N, "sharpe": N, "drawdown": N}, ...]

Work through strategies sequentially — one backtest at a time.
This will take several hours. Report progress every 25 strategies:
"Progress: 75/250 tested, 23 survivors so far, best PF: 2.14 (StrategyX)"
```

**What to check after Stage 2:**
- screen_survivors.json exists with 40-80 strategies
- The ranking looks reasonable (no Sharpe 100+ outliers at the top)
- Strategies with high trade counts AND positive profit factor rank highest
- The "best performing pair" column shows diversity (not all BTC)

### Stage 3: Walk-forward validate survivors (~2-3 days)

**Requires Phase 1.1 (walkforward crash fix) to be complete.**

**NanoClaw prompt:**

```
Read screen_survivors.json — it contains strategies that passed the
Stage 2 triage screen.

For each survivor, run the FULL FreqHub pipeline:

1. Create a minimal genome wrapper:
   - name: strategy class name (lowercase, hyphenated)
   - parent: null (these are root genomes — no lineage yet)
   - runtime: "freqtrade"
   - portability: 0 (raw .py reference, not declarative)
   - strategy_ref with class_name and strategy_path
   - pairs: all 20 pairs
   - timeframe: 4h (use the timeframe the strategy was designed for
     if you can detect it from the code, otherwise default to 4h)

2. Run walk-forward validation:
   - 6 windows
   - 70/30 train/test split
   - All 20 pairs
   - Record per-window results (Sharpe, trades, profit)

3. Compute metrics from the walk-forward results:
   - Walk-forward Sharpe (average across test windows)
   - Total trades across all windows
   - Win rate
   - Profit factor
   - Max drawdown
   - Sortino, Calmar, expectancy (if available from FreqTrade output)
   - Per-window Sharpe array (for consistency measurement)

4. Attest the genome:
   - sdna attest with all walk-forward metrics
   - Include per_window_sharpes in the attestation

5. Register to FreqHub:
   - sdna registry add
   - The genome enters the DAG as a root node

6. Log to aphexDATA:
   - Record the experiment event
   - Include all metrics

After processing all survivors, rebuild the registry:
   sdna build

Produce a final seeding report:
- Total strategies tested: [N]
- Attested (walk-forward positive): [N]
- Rejected (walk-forward negative): [N]
- Registry size: [N] genomes
- DAG: [N] root nodes, frontier size [N]
- Top 10 by walk-forward Sharpe with full metrics
- Tier distribution: Exceptional / Strong / Viable / Experimental

Work through survivors in batches of 5. After each batch, report:
"Batch 3/12 complete: 3 attested, 2 rejected. Registry now has 14 genomes.
Best so far: StrategyX (WF Sharpe 1.31, 187 trades, PF 1.68)"

If the swarm is available, use it for parallel walk-forward execution.
If not, run walk-forwards sequentially.

Pairs: BTC/USDT:USDT, ETH/USDT:USDT, BNB/USDT:USDT, SOL/USDT:USDT,
XRP/USDT:USDT, ADA/USDT:USDT, DOGE/USDT:USDT, AVAX/USDT:USDT,
DOT/USDT:USDT, LINK/USDT:USDT, MATIC/USDT:USDT, UNI/USDT:USDT,
ATOM/USDT:USDT, LTC/USDT:USDT, NEAR/USDT:USDT, AAVE/USDT:USDT,
SUI/USDT:USDT, APT/USDT:USDT, ARB/USDT:USDT, OP/USDT:USDT
```

**What to check after Stage 3:**
- FreqHub registry has 30-60 attested genomes
- DAG has root nodes for each attested genome
- Leaderboard shows walk-forward Sharpe rankings
- Tier distribution has genomes in multiple tiers
- The autoresearch loop now has a rich frontier to explore

### Phase 2 Gate

```
[ ] Stage 1: valid_strategies.json exists with 200+ loadable strategies
[ ] Stage 1: Failure report categorized by error type
[ ] Stage 2: screen_survivors.json exists with 40-80 screened strategies
[ ] Stage 2: All survivors have positive profit factor and 10+ trades
[ ] Stage 3: FreqHub registry has 20+ walk-forward attested genomes
[ ] Stage 3: DAG has root nodes with correct hashes
[ ] Stage 3: Leaderboard ranks by walk-forward Sharpe (or Aphex if Phase 3 done)
[ ] Stage 3: aphexDATA has experiment events for all tested strategies
[ ] The autoresearch loop (Phase 3) now has 20+ frontier nodes to explore
    instead of the handful of manually-created genomes from before
```

### Why this matters for the roadmap

The autoresearch loop (Phase 3) is only as good as its starting material.
With 3-5 hand-built genomes, the frontier is shallow and mutations explore
a tiny region of strategy space. With 30-60 diverse, validated strategies
from open-source collections, the frontier is broad and mutations can
explore RSI variants, MACD crossovers, Bollinger breakouts, trend
following, mean reversion, and dozens of other approaches simultaneously.

This seeding also stress-tests the entire pipeline at scale: 397 validations,
250 backtests, 60 walk-forwards, 30 attestations, 30 registrations. If
anything in the pipeline breaks under load, you'll discover it here —
during the day, with immediate debugging access — rather than during
an overnight autoresearch run.


---

## Phase 3: Reliable Autoresearch Loop
**Timeline: 3-5 days**
**Goal: The autoresearch loop works reliably — tested incrementally
during the day, then proven unattended.**

Phase 2 is broken into four sub-phases of increasing scope. Each can
run during the day so you see results immediately and debug in real time.
Do not skip sub-phases.

### Phase 3a: Single mutation, manual trigger (~30 minutes)

Tell NanoClaw:
"Pull the top genome from the FreqHub frontier. Fork it with one mutation
you think will improve it. Run the full pipeline: compile, walk-forward
with 4 windows, attest if improved, register to FreqHub."

This is one iteration of the autoresearch loop, manually triggered.
Watch the whole thing — it should take about 15 minutes for walk-forward
plus a few minutes for compile and attest.

After it finishes, check:
- Did the genome get attested (if keeper)?
- Is it in the registry?
- Did aphexDATA log the experiment event?
- If it was a reject, was the negative result logged to aphexDATA?
- Does the DAG show the new genome as a child of the frontier node?

**Phase 3a Gate:**
```
[ ] One mutation completes end-to-end
[ ] Keeper path works: attest → register → leaderboard updated
[ ] Reject path works: negative result logged to aphexDATA with mutation details
[ ] DAG has 1 new node with correct parent pointer
```

### Phase 3b: Five mutations, manual trigger (~90 minutes)

Tell NanoClaw:
"Run 5 mutations on the top frontier genome. Budget: 15 minutes each.
Run sequentially — I want to watch each one."

This tests the loop logic — NanoClaw picks a genome, tries a mutation,
keeps or reverts, picks the next mutation, repeats. Watch in real time.

After 5 mutations, check:
- Did the DAG grow by 5 nodes?
- Were keepers registered and rejects logged?
- Did NanoClaw avoid re-testing any mutation that was already discarded?
  (aphexDATA negative result deduplication)
- Does the frontier look different now? (new leaves from keepers,
  original node may no longer be the top if a child beat it)
- Did NanoClaw generate a summary of all 5 experiments?

**Phase 3b Gate:**
```
[ ] 5 mutations complete sequentially
[ ] At least 1 keeper registered OR all 5 rejects logged with reasons
[ ] DAG has 5 new nodes
[ ] No duplicate mutations tested (aphexDATA dedup working)
[ ] NanoClaw produced a summary: "5 tested, N kept, M reverted"
```

### Phase 3c: Twenty-one mutations across 3 genomes, swarm-triggered (~2-3 hours)

This sub-phase requires autoresearch_batch to be implemented in FreqSwarm.
If it's not built yet, build it now following the autoresearch_batch spec.

Tell NanoClaw:
"Run autoresearch on my top 3 frontier genomes. 7 mutations each.
Use the swarm with 4 workers."

This is the full autoresearch_batch job: 21 variants, parallel execution,
batch report. Check in every 30 minutes or wait for the final report.

After completion, check:
- Did all 21 variants get tested? (some may fail for data reasons — that's OK)
- Were keepers batch-attested and registered?
- Were rejects batch-logged to aphexDATA?
- Did the swarm complete without crashing?
- Does the report show a clear keeper/reject breakdown with Sharpe comparisons?
- Did the registry grow?

**Phase 3c Gate:**
```
[ ] autoresearch_batch completes 21 variants (3×7) in <40 min with 4 workers
[ ] Keepers attested and registered to FreqHub automatically
[ ] Rejects logged to aphexDATA with parent hash, mutation, and Sharpe comparison
[ ] Swarm completed without orchestrator crash
[ ] Report shows keeper/reject breakdown
[ ] Registry has new genomes from this batch
```

### Phase 3d: Scheduled repeat, unattended (~4 hours)

Schedule two autoresearch runs 3 hours apart using schedule_task.
First run at 1 PM, second at 4 PM (or whenever works for your day).
Go do something else. Come back after the second run should have
completed and check results.

```
schedule_task: autoresearch on top 3 frontier, 7 mutations each, at 1:00 PM
schedule_task: autoresearch on top 3 frontier, 7 mutations each, at 4:00 PM
```

After both runs, check:
- Did both runs complete?
- Did both produce reports?
- Did the second run explore DIFFERENT mutations than the first?
  (The frontier should have changed after the first run's keepers)
- Is the registry growing from both runs?
- Were there any crashes or stalls?

**Phase 3d Gate:**
```
[ ] Two scheduled runs complete without intervention
[ ] Both produce reports with keeper/reject breakdowns
[ ] Second run explored different genomes/mutations than the first
    (frontier shifted after first run's results)
[ ] Registry grew from both runs
[ ] No crashes, stalls, or agent unresponsiveness during the 4-hour window
```

### After Phase 3d: Overnight is just "2d but longer"

If Phase 2d passes, the overnight run is a confidence step, not a
technical milestone. You've already proven the loop runs unattended for
4+ hours. Configure the overnight schedule:
- schedule_task with cron for 2 AM
- Budget: 15 minutes per experiment, stop at 8 AM
- Morning report (Workflow D) at 8 AM

Run overnight for 3 consecutive nights. If all 3 succeed, Phase 2 is done.

---

## Phase 4: Measurement and Scoring
**Timeline: 1-2 weeks**
**Goal: The dashboard shows real metrics and the leaderboard ranks
strategies correctly using Aphex scoring.**

### 4.1 Implement Aphex scoring

From APHEX_SCORING_SPEC.md:
- New scoring.py module in aphexdna-core
- Enrich attestation with new fields (win_rate, sortino, calmar,
  expectancy, cagr, avg_profit_pct, rejection_rate, per_window_sharpes)
- Update sdna ingest_backtest to extract new fields from FreqTrade output
- Update sdna attest to compute Aphex score
- Update sdna build to sort leaderboard by aphex_score

### 4.2 Re-attest existing genomes

Run the enriched ingest + attest on all existing genomes in the registry.
Rebuild the registry. Verify that:
- BigZ04_XRP_1h (Sharpe 18.93, few trades) drops from #1 to bottom half
- Strategies with 100+ trades and moderate Sharpe rank higher
- Tier distribution looks reasonable

### 4.3 Implement metric computation

From the dashboard spec:
- sdna metrics command (or Python script) that queries aphexDATA + registry
- Outputs JSON with north star, velocity, quality, discovery metrics
- Weekly snapshot storage for trend computation

### 4.4 Build the aphexDATA dashboard

From the dashboard implementation plan:
- research-data.ts service reading registry.json + snapshots + swarm reports
- GET /api/v1/research/dashboard endpoint
- Static HTML dashboard at /dashboard/
- Hero cards with Aphex-based metrics (not raw Sharpe)
- Leaderboard showing Aphex score, Sharpe, trades, WR, PF, DD, tier
- Throughput chart, discovery panel, experiment history

### Phase 4 Gate

```
[ ] Aphex score computation produces correct results:
    - High Sharpe + low trades scores < 50
    - Moderate Sharpe + high trades scores > 55
    - The low-trades strategy ranks BELOW the high-trades strategy
[ ] All existing genomes re-attested with Aphex scores
[ ] Leaderboard at /dashboard/ shows Aphex as primary sort
[ ] Dashboard shows real numbers from actual research data
[ ] North star metric (viable per human-hour) is computed and displayed
[ ] Weekly snapshot saving works for trend computation
```

---

## Phase 5: Multi-Agent Research with ClawTeam
**Timeline: 2-3 weeks**
**Goal: Multiple NanoClaw agents coordinate via ClawTeam to explore
strategy space faster than a single agent.**

### Prerequisites
- Phase 1 gate passed (swarm is stable)
- Phase 3 gate passed (overnight loop works reliably)
- Phase 3 gate passed (metrics show the system is producing value)

### 5.1 Install and evaluate ClawTeam

```bash
pip install clawteam
clawteam config show
clawteam config health
```

Run ClawTeam's built-in examples to verify it works on your machine:
- Spawn a simple team with 2 agents
- Verify inbox communication works
- Verify tmux window management works
- Verify git worktree isolation works

### 5.2 Create the research team TOML template

Create a ClawTeam template for strategy research:

```toml
[team]
name = "freqhub-research"
description = "Autonomous trading strategy research team"

[leader]
name = "prime"
agent = "claude"
prompt = """
You are the research director for FreqHub. You coordinate a team of
specialized research agents. Your job:
1. Read the FreqHub frontier (sdna frontier)
2. Assign research directions to workers
3. Monitor their progress via inbox
4. Cross-pollinate discoveries between workers
5. Compile the final research report
"""

[[workers]]
name = "rsi-explorer"
agent = "claude"
prompt = """
You are a specialist in RSI-family strategies. You have access to
FreqTrade MCP and aphexDNA MCP tools. Your job:
1. Receive a research direction from the leader
2. Explore mutations in your specialty area
3. Report keepers and rejects to the leader via inbox
4. Incorporate cross-pollination suggestions from the leader
"""
task = "Explore RSI-family mutations on assigned frontier genomes"

[[workers]]
name = "regime-explorer"
agent = "claude"
prompt = """
You are a specialist in regime filter optimization. Your job:
1. Explore different regime detector configurations
2. Test SI threshold variations, ADX-based regimes, volatility regimes
3. Report which regime filters improve walk-forward performance
"""
task = "Explore regime filter variations on assigned frontier genomes"

[[workers]]
name = "risk-tuner"
agent = "claude"
prompt = """
You are a specialist in risk parameter optimization. Your job:
1. Explore stop-loss, take-profit, and position sizing variations
2. Test Kelly fraction ranges, ATR-based stops, risk-reward ratios
3. Report which risk configurations improve Aphex score
"""
task = "Optimize risk parameters on assigned frontier genomes"
```

### 5.3 Build the NanoClaw-ClawTeam bridge

Create clawteam-bridge.ts in the NanoClaw repo:
- When ClawTeam spawns a worker, boot a NanoClaw container
- Inject the WolfClaw system prompt + worker-specific specialization
- Connect MCP tools (FreqTrade, aphexDNA, aphexDATA)
- Wire ClawTeam inbox to NanoClaw's send_message capability
- Handle worker lifecycle (idle, shutdown)

### 5.4 Run the first multi-agent research session

Start small:
- Leader + 1 worker (not 3)
- Leader assigns: "Test the top frontier genome with 5 RSI mutations"
- Worker runs the experiments using FreqTrade MCP directly
- Worker reports results to leader via inbox
- Leader registers keepers to FreqHub

Verify:
- Communication works (leader → worker → leader)
- Worker has full tool access
- Results are correctly registered
- No resource contention issues

### 5.5 Scale to full team

Once 1 worker is stable:
- Add 2 more workers with different specializations
- Run a full research session: leader assigns frontier genomes,
  each worker explores their specialty, leader cross-pollinates
- Compare throughput to single-agent: are we finding more viable
  strategies per hour?

### Phase 5 Gate

```
[ ] ClawTeam installed and basic examples work
[ ] Research team template launches successfully
[ ] NanoClaw-ClawTeam bridge boots workers with full MCP access
[ ] Leader → worker → leader communication works via inbox
[ ] 3-worker research session completes without crashes
[ ] Multi-agent session discovers more viable strategies per hour
    than single-agent (measure via dashboard)
[ ] No resource contention: 3 workers don't thrash the machine
```

---

## Phase 6: Slim FreqSwarm into an Execution Library
**Timeline: 1-2 weeks**
**Goal: FreqSwarm becomes a focused execution library that ClawTeam
workers call, instead of a full coordination system.**

### Prerequisites
- Phase 5 gate passed (ClawTeam coordination works)

### 6.1 Identify what to keep vs remove

Keep (the execution layer):
- DAG executor with asyncio semaphore for parallel backtests
- Mutation engine (expand_seed)
- Task implementations: dataset_prep, dataset_freeze, genome_compile,
  walkforward_batch, autoresearch_report
- Preflight check

Remove (replaced by ClawTeam):
- swarm-runner.ts daemon (ClawTeam spawns workers directly)
- Job queue (.request.json polling)
- MCP trigger tools (swarm_trigger_run, swarm_trigger_autoresearch)
- MCP poll tools (swarm_poll_run, swarm_job_results)
- Status file management
- Nightly cron scheduling

### 6.2 Create the execution library API

Expose the execution capabilities as a simple Python API that
NanoClaw agents call directly:

```python
from freqswarm import execute_sweep, execute_autoresearch

# Direct call from agent (no job queue, no polling)
results = await execute_sweep(
    strategy_path="/user_data/strategies/RSI_Regime.py",
    pairs=["BTC/USDT", "ETH/USDT"],
    timeframes=["1h", "4h"],
    n_windows=4,
    max_workers=4,
)

# Or via MCP tool that wraps the library
results = await execute_autoresearch(
    seed_genomes=[genome1, genome2],
    mutations_per_genome=7,
    max_workers=4,
)
```

### 6.3 Create new MCP tools for direct execution

Replace the old swarm trigger/poll tools with simpler direct-execution tools:

```
freqtrade_execute_sweep      — runs sweep, returns results (blocking)
freqtrade_execute_autoresearch — runs autoresearch batch, returns results (blocking)
```

These are blocking calls — the agent waits for results. No job queue,
no polling loop, no status files. ClawTeam handles the coordination
(the worker agent calls the tool and reports back to the leader).

### 6.4 Update NanoClaw skills and system prompt

- Remove swarm_trigger_run, swarm_poll_run references
- Add freqtrade_execute_sweep, freqtrade_execute_autoresearch
- Update workflows to use direct execution calls
- Keep single-agent workflows working (they call the same library,
  just without ClawTeam coordination)

### Phase 6 Gate

```
[ ] Execution library API works: execute_sweep returns results directly
[ ] New MCP tools work: NanoClaw agent calls freqtrade_execute_sweep
[ ] ClawTeam worker calls execution library successfully
[ ] Single-agent workflows still work (no ClawTeam required)
[ ] Old swarm daemon, job queue, and polling code removed
[ ] Codebase is smaller and simpler
```

---

## Phase 7: Production Hardening
**Timeline: 2-4 weeks**
**Goal: The system runs reliably in production with monitoring,
alerting, and graceful failure handling.**

### 7.1 Resource management

- Profile memory and CPU usage during multi-agent research
- Set per-worker resource limits (max memory, max CPU cores)
- Add resource monitoring to the dashboard
- Automatic worker throttling when resources are constrained

### 7.2 Comprehensive error recovery

- Agent auto-restart on crash (ClawTeam lifecycle + NanoClaw bridge)
- Partial result recovery (if 2 of 3 workers crash, keep the results
  from the one that succeeded)
- Stale lock cleanup (if a worker dies holding a frontier lock, release it)
- Database integrity checks on startup

### 7.3 End-to-end monitoring

- Health check endpoint that verifies all components are alive
- Alert when overnight research produces zero viable strategies
- Alert when the walkforward_batch failure rate exceeds 50%
- Weekly automated test that runs a known-good strategy through
  the full pipeline and verifies the result matches expected output

### 7.4 Documentation

- Updated architecture diagram showing all components
- Runbook: "How to diagnose common failures"
- Runbook: "How to restart the system after a crash"
- Runbook: "How to add a new research worker"

### Phase 7 Gate

```
[ ] System runs for 30 consecutive days without manual intervention
    (beyond reviewing morning reports)
[ ] Dashboard shows 30 days of continuous metric history
[ ] At least one alert fired and was correctly diagnosed from
    the runbook without deep investigation
[ ] A new worker can be added by editing the TOML template
    (no code changes required)
[ ] Viable strategies per human-hour has improved 3x vs Phase 2 baseline
```

---

## End State Summary

```
ClawTeam          — Brain (coordination, communication, strategy)
NanoClaw          — Agent runtime (identity, tools, skills, aphexDATA)
FreqSwarm   — Muscle (parallel backtest execution library)
FreqHub           — Memory (genome registry, DAG, leaderboard)
aphexDATA               — Nervous system (events, metrics, dashboard)
```

Each component does one thing well. The boundaries are clean.
A failure in one component produces a clear error that the others
can understand and respond to.

---

## Future Goal: Agent Runtime Agnostic

NanoClaw is currently the only agent runtime in the system. Every worker
is a NanoClaw instance running Claude Code with the WolfClaw system prompt.
This works well but creates a dependency on a single agent framework.

The long-term goal is to make the system **agent runtime agnostic** — any
CLI agent that can call MCP tools should be able to participate as a
research worker. ClawTeam already supports this at the coordination layer
(it works with Claude Code, Codex, OpenClaw, nanobot, and any CLI agent).
The remaining dependency is in the NanoClaw-specific pieces: the WolfClaw
system prompt, the MCP bridge, and the container configuration.

### What runtime-agnostic means

A research team could have:
- A Claude Code worker running NanoClaw (strongest reasoning, best for
  complex mutation hypotheses)
- An OpenClaw worker (open-source, lower cost, good for batch parameter
  sweeps where reasoning depth matters less)
- A nanobot worker (lightweight, fast startup, good for simple
  fork-verify-keep/revert loops)

Each worker connects to the same MCP servers (FreqTrade, aphexDNA, aphexDATA),
reads from the same FreqHub registry, and reports to the same ClawTeam
leader. The coordination protocol is the same — only the LLM inside
the worker differs.

### What needs to change

The NanoClaw-specific pieces that would need runtime-agnostic equivalents:

| Component | Currently NanoClaw-specific | Runtime-agnostic version |
|-----------|---------------------------|--------------------------|
| System prompt | WolfClaw CLAUDE.md | Portable prompt format that works in Claude Code, OpenClaw, nanobot |
| MCP bridge | NanoClaw container agent-runner | Standardized MCP connection config per runtime |
| Skills | NanoClaw /container/skills/ | Skill files in each runtime's native format (SKILL.md for Claude Code, equivalent for others) |
| Container | NanoClaw Docker setup | Runtime-specific Dockerfiles or install scripts |
| ClawTeam bridge | clawteam-bridge.ts | Per-runtime spawn adapters (ClawTeam already has this for Claude Code, Codex, OpenClaw, nanobot) |

### What stays the same regardless of runtime

- FreqTrade MCP server (same 57 tools, any agent can call them)
- aphexDNA MCP server (same 16 tools)
- aphexDATA MCP server (same 13 tools)
- FreqHub registry (genomes, DAG, leaderboard — runtime-agnostic)
- FreqSwarm execution library (called via MCP, doesn't care who's calling)
- The genome format, attestation format, and scoring (Aphex)
- The autoresearch loop logic (fork → verify → keep/revert)
- The ClawTeam coordination protocol (spawn, inbox, tasks, lifecycle)

### When to pursue this

Not now. This is a post-Phase 6 goal. The priority is getting the system
working reliably with one runtime (NanoClaw/Claude Code) before adding
the abstraction layer for multiple runtimes. Premature abstraction would
slow down every phase by adding a "does this work on 3 runtimes?" test
to every change.

The trigger for starting this work is: the system runs in production for
30+ days (Phase 6 gate), and either (a) cost becomes a concern (OpenClaw
as a cheaper alternative for batch work), or (b) you want to distribute
workers across machines where different runtimes make sense.

### The architecture supports it already

The key insight is that the five-component architecture (ClawTeam, NanoClaw,
FreqSwarm, FreqHub, aphexDATA) was designed with this in mind. NanoClaw is the
agent runtime layer — it's the only component that knows which LLM is
running inside. Everything below it (FreqSwarm, FreqHub, aphexDATA) communicates
via MCP, which is runtime-agnostic by design. Everything above it (ClawTeam)
communicates via CLI commands, which are also runtime-agnostic.

Replacing NanoClaw with OpenClaw or nanobot for a specific worker means
swapping the runtime layer while keeping everything else identical. That's
a clean substitution, not a rewrite.

---

## Future Goal: Harden the Genome Protocol (aphexDNA v2)

The GENOME.sdna format is the most important piece of the entire system.
Every other component depends on it: the autoresearch loop mutates genomes,
the DAG tracks genome lineage, the attestation verifies genome performance,
the compiler produces executable code from genomes, the NFT marketplace
sells access to genome-produced signals, and the royalty chain traces
revenue through genome ancestry.

Today the genome format works — NanoClaw can create, fork, compile, and
attest genomes. But it's underspecified. The format exists as an implicit
contract between the aphexDNA CLI and NanoClaw's system prompt. There's
no formal spec that a third-party agent or compiler could implement from.

This matters the moment you have:
- Multiple agent runtimes (OpenClaw, nanobot) reading and writing genomes
- Multiple compiler backends (FreqTrade, Backtrader, Lean, Jesse)
- External contributors submitting genomes to the registry
- A marketplace where genomes have monetary value

Any of these require the genome format to be a formal protocol, not an
internal implementation detail.

### What "hardened" means

A hardened genome protocol has five properties:

**1. Complete field specification**

Every field in the genome JSON has a documented type, valid value range,
default value, and semantic meaning. An implementor can read the spec and
know exactly what `"op": "crosses_below"` means without looking at
NanoClaw's source code.

Current state: fields are implied by usage in the compile and attest commands.
Target state: a formal JSON Schema + prose spec document.

Example of what's missing today:

```
Q: What operators are valid in a signal condition?
A: Currently whatever the compiler happens to support: crosses_above,
   crosses_below, greater_than, less_than, between, equals.
   But this isn't documented anywhere. A new compiler backend would
   have to reverse-engineer the list from existing genomes.

Q: What happens if a genome references an indicator the compiler
   doesn't know?
A: Currently: the compile command crashes with a Python ImportError.
   Target: the compile command returns a structured error saying
   "unknown indicator: lorentzian_classify, known indicators: [list]"
```

**2. Canonical indicator vocabulary**

A versioned, enumerated list of every indicator primitive the genome
format supports, with exact computation definitions. This is the
"instruction set" of the genome — analogous to how x86 defines every
opcode a CPU must support.

Each indicator entry specifies:
- Name (e.g., "RSI")
- Parameters with types and valid ranges (e.g., period: int, 2-200)
- Input (e.g., "close prices as float array")
- Output (e.g., "float array, range 0-100")
- Reference implementation (Python function or link to TA-Lib docs)
- Version added (so compilers know which spec version they support)

```json
{
  "indicators": {
    "RSI": {
      "version": "1.0",
      "params": {
        "period": { "type": "int", "min": 2, "max": 200, "default": 14 },
        "source": { "type": "enum", "values": ["open", "high", "low", "close"], "default": "close" }
      },
      "output": { "type": "float", "range": [0, 100] },
      "reference": "ta-lib RSI, Wilder smoothing"
    },
    "MACD": {
      "version": "1.0",
      "params": {
        "fast": { "type": "int", "min": 2, "max": 200, "default": 12 },
        "slow": { "type": "int", "min": 2, "max": 200, "default": 26 },
        "signal": { "type": "int", "min": 2, "max": 200, "default": 9 }
      },
      "output": { "type": "object", "fields": ["macd", "signal", "histogram"] },
      "reference": "ta-lib MACD, standard EMA"
    }
  }
}
```

Starting vocabulary (indicators already used in existing genomes):
RSI, MACD, EMA, SMA, Bollinger Bands, ATR, ADX, Supertrend,
Stochastic, CCI, MFI, OBV, VWAP, Aroon, Donchian, Ichimoku,
Williams %R, Chaikin Money Flow, Keltner Channel.

Future additions: Lorentzian Classification, Order Block detection,
Smart Money Concepts, Hurst Exponent, Separation Index.

**3. Compiler conformance tests**

A test suite of genome → expected output pairs. Any compiler backend
that passes the test suite is conformant. This is how you verify that
a new Backtrader compiler produces strategies that behave identically
to the FreqTrade compiler for the same genome.

The test suite has three levels:

Level 1 — Signal generation: Given this genome and this price data,
the compiled strategy must produce these exact entry/exit signals at
these exact timestamps.

Level 2 — Trade execution: Given this genome, this price data, and
this execution config (slippage, fees), the compiled strategy must
produce these exact trades with these exact P&L values.

Level 3 — Walk-forward: Given this genome and this data split config,
the walk-forward result hash must match the expected hash.

```
test_vectors/
├── signal_tests/
│   ├── rsi_cross_basic.json      # Genome + price data + expected signals
│   ├── macd_regime_filtered.json
│   └── multi_indicator_and.json
├── trade_tests/
│   ├── simple_long_only.json     # Genome + data + expected trades
│   ├── long_short_with_stops.json
│   └── kelly_position_sizing.json
└── walkforward_tests/
    ├── 4_window_btc_4h.json      # Genome + data + expected result hash
    └── 6_window_eth_1h.json
```

A new compiler runs: `sdna test --compiler backtrader --level 2`
Result: "47/50 tests pass. Failing: kelly_position_sizing (expected
0.25 Kelly, got 0.24 — rounding difference in position calculator)"

**4. Versioned schema with migration**

The genome format will evolve. New indicator types, new risk primitives,
new regime filters. Each change increments the schema version. Older
genomes continue to work (backward compatibility). Newer genomes declare
which version they require.

```yaml
---
schema_version: "2.1"
name: "rsi-regime-v3"
...
---
```

The compiler checks: "I support schema ≤ 2.3. This genome requires 2.1.
Compatible." Or: "This genome requires 3.0. I only support ≤ 2.3.
Incompatible — upgrade the compiler."

Migration tool: `sdna migrate --from 1.0 --to 2.0 genome.sdna`
automatically upgrades older genomes (e.g., renaming deprecated fields,
expanding shorthand into full notation).

**5. The custom_logic escape hatch**

Not everything can be expressed declaratively. Complex strategies that
use ML models, custom indicators, or exotic logic need a `custom_logic`
field. This is the escape hatch — it contains actual code, which breaks
portability.

The protocol acknowledges this explicitly:

```json
{
  "signals": {
    "entry_long": {
      "type": "custom",
      "code": "def entry_signal(df): ...",
      "dependencies": ["lorentzian_classify"],
      "portable": false
    }
  }
}
```

The `portable: false` flag tells compilers: "I can't compile this to
your runtime unless you have a compatible implementation of the
dependencies." The compiler can check: "Do I have lorentzian_classify?
No → compilation fails with: 'custom dependency lorentzian_classify
not available in backtrader backend.'"

The long-term path is to promote frequently-used custom_logic into
first-class indicator primitives. When enough genomes use
lorentzian_classify, it gets added to the canonical vocabulary with
a reference implementation, and those genomes become fully portable.

### Portability ladder

Every genome sits on a portability ladder:

```
Level 3: Fully portable (all signals declarative, no custom_logic)
         → Compiles to any backend. Any agent can reproduce.
         → Eligible for cross-platform attestation.

Level 2: Partially portable (some custom_logic, dependencies documented)
         → Compiles to backends that have the dependencies.
         → Cross-platform attestation requires dependency check.

Level 1: Runtime-specific (heavy custom_logic, Python-only)
         → Only compiles to FreqTrade (or target runtime).
         → Attestation valid only on the original runtime.

Level 0: Raw code (not a genome, just a .py strategy file)
         → No portability. No structured mutation. No DAG lineage.
         → Can be "lifted" into a genome via sdna lift.
```

The registry tracks portability level per genome. The leaderboard can
filter by level. The marketplace may price Level 3 genomes higher
because they're more valuable (run anywhere, verify anywhere).

### How this connects to everything else

| System | Depends on genome protocol for |
|--------|-------------------------------|
| Autoresearch loop | Structured mutations: swap indicator, change param, add filter. Only works if mutations are operations on a typed schema, not text edits on Python files. |
| DAG lineage | Parent→child relationships via content hashes. The hash is computed from canonical JSON — any change to the JSON spec changes how hashes are computed. |
| Attestation | Reproducibility guarantee: genome_hash + data_hash = result_hash. Fails if two compilers produce different code from the same genome. |
| NFT marketplace | What you're selling is the right to receive signals from a genome. The genome must be well-defined enough that "signals from genome X" is unambiguous. |
| Royalty chain | Revenue splits follow DAG lineage. Lineage is genome→genome. Unclear genome boundaries = unclear royalty claims. |
| Multi-runtime | A genome compiled by FreqTrade backend and compiled by Backtrader backend must produce the same signals. Only possible with a formal indicator spec. |
| External contributors | Someone submitting a genome to the registry needs to know the format without reading NanoClaw source code. The spec IS the API. |

### When to pursue this

Start during Phase 3 (Measurement), harden during Phase 5 (Slim FreqSwarm),
complete before marketplace launch (Phase 7+).

Phased approach:
- **Phase 3:** Document the current implicit schema as a JSON Schema file.
  Add validation to `sdna compile` that rejects genomes with unknown
  fields or invalid values. This costs a few hours and immediately
  catches malformed genomes.
- **Phase 5:** Write the canonical indicator vocabulary for the 20
  indicators already in use. Add Level 1 compiler conformance tests
  (signal generation). This is a week of work and enables multi-runtime.
- **Pre-marketplace:** Complete the full spec document, Level 2+3 tests,
  versioned schema with migration, and the portability ladder metadata
  in the registry. This is the "Docker for trading strategies" promise
  fulfilled.

### The one-sentence version

The genome format is the protocol that makes everything else possible:
if two agents read the same genome and produce different results, the
entire system — autoresearch, attestation, marketplace, royalties — is
broken. Hardening it is not optional. It's the foundation.

---

## What NOT to Do (Anti-patterns)

1. **Don't skip phases.** Phase 5 (ClawTeam) without Phase 1 (stable swarm)
   means 3 agents all hitting the same broken infrastructure.

2. **Don't build the marketplace before the research works.** Signal
   subscriptions, NFTs, royalty chains, x402 payments — all of that is
   Phase 8+ and only makes sense when you have a deep registry of
   verified strategies that the overnight loop is continuously growing.

3. **Don't optimize before measuring.** Phase 4 (dashboard + Aphex scoring)
   must come before scaling, because you need to know whether adding more
   agents actually improves the north star metric.

4. **Don't add ClawTeam workers faster than you can debug them.** Start
   with leader + 1 worker. Get that stable. Then add worker 2. Then 3.
   Each worker you add is another failure surface.

5. **Don't keep the swarm daemon running alongside ClawTeam.** Phase 5
   explicitly removes the daemon and coordination code from FreqSwarm.
   Running both is a recipe for conflicting job queues and resource fights.
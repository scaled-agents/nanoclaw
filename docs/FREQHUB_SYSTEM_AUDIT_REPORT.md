# FreqHub System Audit Report

**Date:** 2026-03-19
**Auditor:** Claude Code (Opus 4.6)
**System:** FreqHub + NanoClaw + FreqSwarm + aphexDATA
**Container image:** `nanoclaw-agent:latest` (3.68 GB)

---

## Summary

| Metric | Count |
|--------|-------|
| Total checks | 68 |
| Passing | 52 |
| Partial / Wrong Signature | 10 |
| Missing entirely | 6 |

**Autoresearch loop readiness:**
- [x] sdna fork + hash — WORKING
- [x] sdna compile — WORKING
- [ ] sdna verify (walk-forward) — MISSING (hash-only, no walk-forward)
- [x] NanoClaw system prompt loaded — WORKING (8 workflows, decision rules, quality tiers)
- [x] MCP tool routing — WORKING (all 5 servers configured)
- [x] sdna attest + registry — WORKING (different interface than spec)
- [ ] aphexDATA logging — INSTALLED but requires aphexDATA server running
- [x] FreqSwarm parallel loops — INSTALLED (read-only, host-triggered)

**Verdict: The system can run a single-agent experiment loop today with two workarounds:**
1. Use `freqtrade_run_walk_forward` MCP tool instead of `sdna verify --windows`
2. Extract metrics manually from backtest output for `sdna attest`

---

## Section 1: FreqHub CLI (`sdna`)

### 1.1 CLI Installation — PASS

- **Version:** 0.1.0
- **Location:** `/usr/local/bin/sdna` (npm link from `/app/freqhub`)
- **Package:** `@tradev/sdna`

### 1.2 Command Signatures

| Command | Status | Missing flags |
|---------|--------|---------------|
| `sdna init` | EXISTS — MOSTLY CORRECT | `--from-strategy` (reverse compile not implemented), `--list-templates` (separate `sdna templates` cmd) |
| `sdna fork` | EXISTS — CORRECT | None |
| `sdna diff` | EXISTS — CORRECT | None |
| `sdna compile` | EXISTS — CORRECT | None |
| `sdna verify` | EXISTS — **WRONG SIGNATURE** | `--data-dir`, `--windows`, `--train-ratio` all MISSING. Only does hash integrity check, not walk-forward. Source says "Phase 4 will add walk-forward validation." |
| `sdna attest` | EXISTS — **WRONG SIGNATURE** | `--result` MISSING. Takes individual metrics instead: `--sharpe`, `--win-rate`, `--max-drawdown`, `--profit-factor`, `--total-trades` |
| `sdna search` | EXISTS — PARTIAL | `--source` MISSING. Always reads local `dist/registry.json`. |
| `sdna get` | EXISTS — MOSTLY CORRECT | `--attestation` MISSING (has `--full` instead) |
| `sdna build` | EXISTS — CORRECT | `--validate-only` not implemented |
| `sdna leaderboard` | EXISTS — PARTIAL | `--source` MISSING |
| `sdna frontier` | EXISTS — PARTIAL | `--source` MISSING |
| `sdna templates` | EXISTS (bonus) | Not in spec — lists templates with descriptions |

### 1.3 Hashing — PASS (verified in integration tests)

- SHA-256 on canonical JSON (recursive key sorting, compact serialization)
- Display format: `sha256:{first-16-hex-chars}`
- Two genomes with same logic, different metadata → identical hashes

### 1.4 Fork Lineage — PASS (verified in integration tests)

- Child's `parent:` field = parent's `hash:` field
- Child hash differs from parent hash
- Mutations correctly applied (e.g., `period: 14 → 21`)
- Attestation correctly reset on fork

### 1.5 Build DAG — PASS (verified in integration tests)

- Registry correctly computes: roots, edges, leaves, frontier
- 2 genomes → 1 root, 1 edge, 1 leaf, 1 frontier node
- Quality tiers auto-computed from walk-forward Sharpe

### 1.6 Templates — PASS

| Template | Status |
|----------|--------|
| `rsi-basic` | EXISTS |
| `ema-crossover` | EXISTS |
| `macd-regime` | EXISTS |
| `supertrend-filtered` | EXISTS |

All 4 templates compile to valid Python and pass FreqTrade backtests.

---

## Section 2: FreqTrade Integration

### 2.1 Compile — PASS

- `sdna compile genome.sdna --output dir/` produces `.py` + `config_*.json`
- Python syntax valid (`ast.parse` passes)
- Strategy loadable by FreqTrade (`list-strategies` finds it)
- Inherits from `IStrategy`, generates `populate_indicators`, `populate_entry_trend`, `populate_exit_trend`
- `import ta` used (requires `ta` pip package — now installed in container)

### 2.2 Signal Types — PARTIAL

| Signal type | Status |
|-------------|--------|
| `threshold_cross` | PASS (RSI crosses below threshold) |
| `indicator_cross` | PASS (EMA crossover) |
| `composite_and` | NOT TESTED (no template uses it) |
| `composite_or` | NOT TESTED (no template uses it) |
| `custom` | NOT TESTED |

### 2.3 FreqTrade MCP Tools — ALL PASS

| Tool | Status | Notes |
|------|--------|-------|
| `freqtrade_validate_strategy` | AVAILABLE | AST-based validation |
| `freqtrade_detect_strategy_issues` | AVAILABLE | Pattern detection |
| `freqtrade_download_data` | AVAILABLE | CLI subprocess, verified in integration tests |
| `freqtrade_run_backtest` | AVAILABLE | CLI subprocess, verified with futures data |
| `freqtrade_run_hyperopt` | AVAILABLE | CLI subprocess |
| `freqtrade_run_walk_forward` | AVAILABLE | CLI subprocess, multi-window |

**Total FreqTrade MCP tools:** 55+ across 8 categories.

### 2.4 Walk-Forward Validation

**`sdna verify` CLI:** DOES NOT do walk-forward. Hash integrity only.

**`freqtrade_run_walk_forward` MCP:** DOES work. Multi-window walk-forward via FreqTrade backtesting CLI. This is the actual walk-forward implementation.

**Gap:** No `sdna verify --windows N` to pipe directly to `sdna attest --result`. The agent must:
1. Call `freqtrade_run_walk_forward` MCP tool
2. Extract metrics from the result
3. Call `sdna attest` with individual metric flags

### 2.5 Attest Hash Chain

**`sdna attest` CLI:** Updates genome frontmatter `attestation` section with metrics. Creates `ATTESTATION.json` sidecar file. Status changes from `unattested` → `attested`.

**Gap:** No `--result` flag to pipe walk-forward output. Agent must parse and pass individual metrics. The MCP `sdna_attest` tool also takes `backtest_result` as a string and parses it internally — this is the better path.

### 2.6 Data Format

**Critical finding from integration tests:** FreqTrade 2026.2 defaults to **feather** (Apache Arrow) format, not JSON. Using `--data-format-ohlcv json` creates files the backtester can't find by default. Must let FreqTrade use its default format.

---

## Section 3: aphexDNA MCP Tools

**All 16 tools registered and operational.**

| Tool | Status |
|------|--------|
| `sdna_init` | REGISTERED |
| `sdna_fork` | REGISTERED |
| `sdna_compile` | REGISTERED |
| `sdna_compile_config` | REGISTERED |
| `sdna_diff` | REGISTERED |
| `sdna_verify` | REGISTERED (hash integrity) |
| `sdna_inspect` | REGISTERED (metadata display) |
| `sdna_attest` | REGISTERED (takes `backtest_result` string) |
| `sdna_verify_attestation` | REGISTERED |
| `sdna_ingest_backtest` | REGISTERED (parses FreqTrade result) |
| `sdna_list_templates` | REGISTERED |
| `sdna_registry_add` | REGISTERED |
| `sdna_registry_search` | REGISTERED |
| `sdna_registry_leaderboard` | REGISTERED |
| `sdna_registry_show` | REGISTERED |
| `sdna_registry_export` | REGISTERED |

**Note:** The MCP `sdna_attest` tool accepts a `backtest_result` string parameter and parses it internally. This is more capable than the CLI's individual-flag approach.

**Minor issue:** `REGISTRY_PATH` env var set in `buildMcpServers()` (`/workspace/group/registry`) is not consumed by the MCP tools. Tools default to `.sdna-registry` relative to CWD (`/workspace/group/.sdna-registry`). Not blocking but inconsistent.

---

## Section 4: NanoClaw System Prompt

### 4.1 Prompt Loading — PASS

- `groups/global/CLAUDE.md` (406 lines) loaded for all groups
- `groups/{name}/CLAUDE.md` loaded per-group
- Claude Agent SDK discovers CLAUDE.md from `cwd: '/workspace/group'`
- Non-main groups get global CLAUDE.md appended via `systemPrompt.append`
- Skill files loaded on-demand via SDK skill system

### 4.2 Section Audit

| Section | Status | Notes |
|---------|--------|-------|
| Identity | EXISTS | "You are WolfClaw, an autonomous trading strategy analyst." |
| freqtrade-mcp tools | EXISTS | "50 tools" referenced + full skill file |
| aphexdna-mcp tools | EXISTS | "16 tools" referenced + full skill file |
| aphexdata tools | EXISTS | "13 tools" referenced + full skill file |
| nanoclaw tools | PARTIAL | `send_message` and `schedule_task` mentioned in prose but no formal tool table |
| Workflow A (Strategy Analysis) | EXISTS | Full 7-step pipeline with sub-steps |
| Workflow B (Conversational R&D) | EXISTS | template → genome → compile → backtest flow |
| Workflow C (Comparison) | EXISTS | Multi-registry leaderboard + diff + lineage |
| Workflow D (Morning Report) | EXISTS | Swarm result consumption |
| Workflow E (FreqHub Discovery) | EXISTS | Community strategy search |
| Workflow F (Neighborhood Search) | EXISTS | Systematic mutation exploration |
| Workflow G (Batch Exploration) | EXISTS | Fork/test multiple strategies |
| Workflow H (Data Management) | EXISTS | Check data availability |
| Report format | EXISTS | Full structured template with all metric sections |
| Decision rules | EXISTS | Autonomous vs stop-and-ask with thresholds |
| Default settings | EXISTS | 12mo data, 200 epochs SortinoHyperOptLoss, 6 windows 70/30 |
| Quality thresholds | EXISTS | Viable (>0.5), Strong (>1.0), Exceptional (>1.5) |
| Anti-patterns | EXISTS | 5 explicit "never do" rules |
| **Autoresearch loop** | **MISSING** | No unified autonomous experiment loop workflow |
| **Time budgets** | **MISSING** | No time budget mechanism for experiments |

### 4.3 Autoresearch Loop — MISSING

Workflow F (Neighborhood Search) and Workflow G (Batch Exploration) cover parts of the loop, but there is no unified "Workflow I: Autoresearch" that defines:

```
1. Pick highest-performing leaf from DAG frontier (sdna frontier)
2. Generate a mutation hypothesis
3. Fork the genome (sdna fork --mutations)
4. Compile to FreqTrade (sdna compile)
5. Run walk-forward validation (freqtrade_run_walk_forward)
6. Compare walk-forward Sharpe to parent's Sharpe
7. If improved: attest and register
8. If not improved: discard, log negative result to aphexDATA
9. Return to step 1 with updated frontier
```

### 4.4 Time Budgets — MISSING

No mention of time budgets, fixed time limits per experiment, or comparable-results constraints anywhere in the prompt.

---

## Section 5: FreqSwarm Integration — INSTALLED AND WORKING

| Component | Status |
|-----------|--------|
| MCP server (`swarm-mcp-stdio.ts`) | INSTALLED (200 lines, 6 tools) |
| Agent-runner config | CORRECT (conditional on report dir) |
| Skill docs | COMPLETE (`FreqSwarm/SKILL.md`) |
| Docker Compose | EXISTS (`integrations/FreqSwarm/docker-compose.yml`) |
| Volume mount | CORRECT (read-only) |
| Env forwarding | CORRECT (`SWARM_REPORT_DIR`) |
| Global prompt integration | EXISTS (Workflow D: Morning Report) |

**Tools available:** `swarm_latest_report`, `swarm_leaderboard`, `swarm_run_status`, `swarm_list_runs`, `swarm_run_details`, `swarm_health`

**By design:** No `swarm_launch`/`swarm_stop` — swarm runs are host-triggered via cron/systemd, not from agent sessions. The MCP is read-only.

---

## Section 6: aphexDATA Integration — INSTALLED AND WORKING

| Component | Status |
|-----------|--------|
| MCP server (`aphexdata-mcp-stdio.ts`) | INSTALLED (377 lines, 13 tools) |
| Agent-runner config | CORRECT (conditional on `APHEXDATA_URL`) |
| Skill docs | COMPLETE (`aphexdata/SKILL.md`) |
| Env forwarding | CORRECT (`APHEXDATA_URL`, `APHEXDATA_API_KEY`, `APHEXDATA_AGENT_ID`) |
| `.env.example` | CORRECT |

**Tools available:** Agent management (3), Event recording (5), Competition (3), System (2)

**Note:** `aphexdata_record_event` supports arbitrary `verb_id` values including `discarded` for negative results. There is no dedicated `experiment_discard` tool — the generic event tool handles it.

**Operational dependency:** Requires a running aphexDATA server instance and `APHEXDATA_URL` set in `.env`.

---

## Section 7: E2E Smoke Test Readiness

### 7.1 Single Strategy Test — CAN RUN (with workarounds)

| Step | Tool | Status |
|------|------|--------|
| Validate | `freqtrade_validate_strategy` | AVAILABLE |
| Issue check | `freqtrade_detect_strategy_issues` | AVAILABLE |
| Init genome | `sdna_init` (from template) | AVAILABLE; `--from-strategy` MISSING |
| Download data | `freqtrade_download_data` | AVAILABLE |
| Baseline backtest | `freqtrade_run_backtest` | AVAILABLE |
| Hyperopt | `freqtrade_run_hyperopt` | AVAILABLE |
| Fork with optimized params | `sdna_fork` | AVAILABLE |
| Walk-forward | `freqtrade_run_walk_forward` | AVAILABLE (via MCP, not `sdna verify`) |
| Ingest result | `sdna_ingest_backtest` | AVAILABLE (MCP) |
| Attest | `sdna_attest` | AVAILABLE (MCP takes backtest_result string) |
| Register | `sdna_registry_add` | AVAILABLE (MCP) |
| Log events | `aphexdata_record_event` | AVAILABLE (if aphexDATA running) |
| Report | `send_message` | AVAILABLE |

### 7.2 Fork and Compare — CAN RUN

All required tools available. Agent can reference parent genome hash, fork, backtest both, compare.

### 7.3 Autoresearch Loop — CANNOT RUN (no workflow defined)

The autoresearch loop requires a system prompt workflow that doesn't exist yet. The building blocks are all present (frontier, fork, compile, walk-forward, attest, registry) but the orchestration logic is missing.

---

## Section 8: Configuration Consistency

### 8.1 Path Alignment — PASS (with one inconsistency)

| Config | Setting | Value | Consistent? |
|--------|---------|-------|-------------|
| Dockerfile | `FREQTRADE_PATH` | `/usr/local/bin/freqtrade` | YES |
| freqtrade-mcp | `_get_strategies_dir()` | `user_data/strategies` (relative to CWD) | YES |
| Container CWD | `WORKDIR` | `/workspace/group` | YES |
| Volume mount | Group workspace | `/workspace/group` | YES |
| SKILL.md | Strategy dir | `/workspace/group/user_data/strategies/` | YES |
| `REGISTRY_PATH` env | aphexdna MCP | `/workspace/group/registry` | **NO** — MCP tools default to `.sdna-registry` |

### 8.2 MCP Server Routing — PASS

| Tool prefix | MCP server | Loading | Status |
|-------------|-----------|---------|--------|
| `freqtrade_*` | freqtrade | Always | CORRECT |
| `sdna_*` | aphexdna | Always | CORRECT |
| `aphexdata_*` | aphexdata | Conditional (`APHEXDATA_URL`) | CORRECT |
| `mcp__nanoclaw__*` | nanoclaw | Always | CORRECT |
| `mcp__swarm__*` | swarm | Conditional (dir exists) | CORRECT |

All 5 servers in `allowedTools` with wildcard patterns.

---

## Critical Gaps (blocks the experiment loop)

| # | Gap | What's Wrong | Fix | Priority |
|---|-----|-------------|-----|----------|
| 1 | `sdna verify` has no walk-forward | CLI only checks hash integrity. Source says "Phase 4 will add walk-forward." | **Workaround exists:** Use `freqtrade_run_walk_forward` MCP tool directly. Long-term: implement Phase 4 in CLI. | P1 |
| 2 | Autoresearch loop workflow missing | No unified system prompt workflow for: frontier → fork → verify → attest/discard → repeat | Add "Workflow I: Autoresearch" to `groups/global/CLAUDE.md` composing existing building blocks | P1 |
| 3 | `sdna init --from-strategy` missing | Cannot reverse-compile an existing .py strategy into a .sdna genome | Implement in `cli/src/commands/init.js`. Critical for ingesting user-uploaded strategies. | P2 |

## Important Gaps (degrades quality but loop can run)

| # | Gap | What's Wrong | Fix | Priority |
|---|-----|-------------|-----|----------|
| 4 | `sdna attest --result` flag missing | CLI takes individual metrics, not a result bundle. Agent must manually extract and pass each metric. | The MCP `sdna_attest` tool handles this better (takes `backtest_result` string). Upgrade CLI to match. | P3 |
| 5 | Time budget not in system prompt | No mechanism to time-box experiments for comparable results | Add `time_budget_minutes` default (e.g., 15) and stopping logic to the autoresearch workflow | P3 |
| 6 | `--source` flag missing on search/leaderboard/frontier | CLI can only query local `dist/registry.json`, cannot query remote/alternate registries | Add `--source` flag to all three commands | P3 |
| 7 | `REGISTRY_PATH` env var unused | Agent-runner sets `/workspace/group/registry` but MCP tools default to `.sdna-registry` | Either read the env var in MCP tools or remove from `buildMcpServers()` | P4 |
| 8 | Nanoclaw tool table missing from global prompt | `send_message`, `schedule_task`, `register_group` mentioned in prose but no formal reference table | Add a tools table to `groups/global/CLAUDE.md` | P4 |
| 9 | Composite signal types untested | `composite_and`, `composite_or`, `custom` signal compilation not verified | Add integration tests for all signal types | P4 |

## Nice-to-Have Gaps (polish)

| # | Gap | What's Wrong | Fix | Priority |
|---|-----|-------------|-----|----------|
| 10 | `sdna build --validate-only` not implemented | Always builds; can't validate without writing | Minor — validation always runs during build anyway | P5 |
| 11 | `sdna get --attestation` missing | Has `--full` flag instead | Alias `--attestation` to `--full` or add dedicated flag | P5 |
| 12 | FreqHub CLI `freqtrade_user_data` not configured | `~/.sdna/config.yaml` defaults empty | Set during container build or first-run | P5 |
| 13 | `ta.__version__` AttributeError | `ta` module loads but has no `__version__` attribute | Non-blocking; only affects version-check scripts, not actual usage | P5 |
| 14 | Data format documentation | FreqTrade 2026.2 defaults to feather, not JSON | Document in system prompt / skill docs to prevent `--data-format-ohlcv json` usage | P5 |

---

## Working Components

| Component | Status | Tools |
|-----------|--------|-------|
| FreqHub CLI (`sdna`) | 11/12 commands working | init, fork, diff, compile, verify (hash), attest, search, get, build, leaderboard, frontier, templates |
| aphexDNA MCP | All 16 tools registered and operational | Full genome lifecycle |
| FreqTrade MCP | All 55+ tools available | Introspection, backtesting, hyperopt, walk-forward, data, live trading |
| aphexDATA MCP | All 13 tools implemented | Agent mgmt, events, competitions, system |
| FreqSwarm MCP | All 6 read-only tools working | Reports, status, archive, health |
| NanoClaw agent-runner | 5 MCP servers configured | Correct conditional loading, env forwarding, volume mounts |
| System prompt | 8 workflows + decision rules + quality tiers | Identity, tools, workflows A-H, report format, anti-patterns |
| Container build | FreqTrade 2026.2, TA-Lib, `ta`, aphexdna, FreqHub | All dependencies installed |
| Hash integrity | SHA-256, deterministic, canonical JSON | Verified in tests |
| Fork lineage | Parent-child DAG tracking | Verified in tests |
| Compile pipeline | .sdna → .py + config.json | Verified with futures backtest |
| Attestation | Metrics embedded in genome frontmatter | Verified in tests |
| Registry | Build, search, leaderboard, frontier | DAG, quality tiers, operators |

---

## Recommended Fix Order

| Order | Fix | Why First | Effort |
|-------|-----|-----------|--------|
| 1 | **Add autoresearch workflow to system prompt** | Unblocks the autonomous experiment loop — all tools exist, just need orchestration instructions | Small (prompt addition) |
| 2 | **Add `sdna init --from-strategy`** | Unblocks user-uploaded strategy ingestion into genome format | Medium (reverse compiler) |
| 3 | **Add time budget to system prompt** | Enables comparable experiments and prevents runaway loops | Small (prompt addition) |
| 4 | **Fix `REGISTRY_PATH` env var alignment** | Prevents confusion about where registry lives | Small (code fix) |
| 5 | **Add `--source` to search/leaderboard/frontier** | Enables querying remote/community registries | Medium (CLI enhancement) |
| 6 | **Implement `sdna verify` Phase 4 (walk-forward)** | Completes the CLI pipeline (currently works via MCP workaround) | Large (significant feature) |
| 7 | **Document feather data format requirement** | Prevents backtest failures from wrong data format | Small (docs update) |
| 8 | **Add composite signal type tests** | Validates full signal type matrix | Small (test addition) |

---

## Autoresearch Loop Readiness

**Can the system run the full experiment loop today?**

**YES — with two workarounds and one addition:**

1. **Walk-forward:** Use `freqtrade_run_walk_forward` MCP tool instead of `sdna verify --windows` (workaround exists)
2. **Attest:** Use `sdna_attest` MCP tool with `backtest_result` parameter instead of `sdna attest --result` CLI (workaround exists)
3. **Missing:** Add autoresearch workflow (Workflow I) to the system prompt — all building blocks are in place, just need orchestration instructions

**The highest-impact fix is adding the autoresearch workflow to the system prompt (fix #1 above).** This is a prompt-only change that composes existing, working tools into the experiment loop. No code changes needed.

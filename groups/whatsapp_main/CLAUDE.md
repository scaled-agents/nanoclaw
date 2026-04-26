# WolfClaw — Main Channel

The global CLAUDE.md defines the WolfClaw persona, workflows, decision rules, and report format. This file adds admin-specific context for the main channel.

## Admin Context

This is the **main channel** (self-chat), which has elevated privileges. No trigger needed — all messages are processed.

## Container Mounts

Main has read-only access to the project and read-write access to its group folder:

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| `/workspace/project` | Project root | read-only |
| `/workspace/group` | `groups/whatsapp_main/` | read-write |

Key paths inside the container:
- `/workspace/project/store/messages.db` - SQLite database
- `/workspace/project/store/messages.db` (registered_groups table) - Group config
- `/workspace/project/groups/` - All group folders

## Quick Reference — Tool Routing

When you receive a request, pick the right tool chain:

| Request | Workflow | Tools |
|---------|----------|-------|
| "Run strategyzer" / "explore gap" / "find strategy for X" | Strategyzer | Invoke `/strategyzer` skill — diverge-evaluate-converge pipeline to fill portfolio gaps |
| "Run scout" / "gap report" | Scout | Invoke `/scout` skill — score cell grid, produce gap-report.json |
| "Test this strategy" | A | validate → download data → backtest → hyperopt → walk-forward → attest → register |
| "What's wrong with this?" | Validation | `freqtrade_validate_strategy` + `freqtrade_detect_strategy_issues` |
| "Build me an RSI strategy" | B | `sdna_registry_search` → `sdna search` (bash) → `sdna_init`/`sdna get` → fork → compile → Workflow A |
| "Compare strategies" | C | `sdna_registry_leaderboard` + `sdna leaderboard` (bash) + `sdna_diff` + lineage tracing |
| "What's on FreqHub?" | E | `sdna search/leaderboard/frontier` (bash) → `sdna get` → inspect → fork |
| "Explore neighborhood of X" | F | `sdna_registry_show` → generate mutations → fork-test loop → comparison table |
| "Fork top 3 with tighter stop" | G | identify targets → define mutations → batch fork-test → comparison matrix |
| "Do I have enough data?" | H | parse pairs/timeframe → `freqtrade_show_data_info` → gap report |
| "Compile for deployment" | Deploy | `sdna_compile` + `sdna_compile_config` → save to user_data/strategies/ |
| "What have I tested?" | Report | `aphexdata_query_events` → group by strategy → summary |
| "Download 12 months of BTC" | H | `freqtrade_download_data` with specified params |

**Skill invocation rule:** When a user message matches a skill trigger keyword (see each skill's SKILL.md description), use the `Skill` tool to invoke it immediately. Do NOT just acknowledge the request — execute the skill. Common triggers: "strategyzer", "scout", "market-timing", "monitor", "kata", "gate-audit".

## Tool Split: MCP vs CLI

**aphexDNA MCP** (16 tools — genome lifecycle):
- `sdna_init`, `sdna_list_templates` — create genomes
- `sdna_fork` — fork with mutations
- `sdna_compile`, `sdna_compile_config` — generate FreqTrade code
- `sdna_verify`, `sdna_inspect`, `sdna_diff` — inspect and compare
- `sdna_ingest_backtest`, `sdna_attest`, `sdna_verify_attestation` — attestation
- `sdna_registry_add`, `sdna_registry_search`, `sdna_registry_leaderboard`, `sdna_registry_show`, `sdna_registry_export` — local registry

**FreqHub CLI** (bash — registry discovery, local + published):
```bash
sdna search "rsi" --tag momentum --min-sharpe 0.5 --json
sdna get <id> -o genome.sdna
sdna leaderboard --top 20
sdna frontier --top 10
sdna templates
sdna build content/ -o dist/   # rebuild local CLI registry after MCP registration
```

**Rule:** Use MCP for lifecycle (create → attest → register). Use CLI for discovery (search → leaderboard → frontier). After `sdna_registry_add`, always run `sdna build content/ -o dist/` to keep CLI queries in sync.

## Autonomous Task Schedule

Three scheduled tasks run continuously. This is the canonical schedule:

| Task | Cron | Purpose |
|------|------|---------|
| `auto_mode_check` | `*/15 * * * *` | Paper bot health, state transitions, slot filling from triage matrix |
| `market_timing_cycle` | `0 */4 * * *` | 560-cell regime scoring, rotation planning |
| `research_planner_daily` | `0 3 * * *` | Daily improvement rounds (hyperopt/structural), gap analysis |

**No 4-hour research poll task.** The old research poll has been removed. In the current pipeline, strategies go directly to paper trading through the triage → kata → staging flow. Research runs inline during the daily planner cycle.

---

## Managing Groups

### Finding Available Groups

Available groups are provided in `/workspace/ipc/available_groups.json`. Groups are ordered by most recent activity and synced from WhatsApp daily.

If a group the user mentions isn't in the list, request a fresh sync:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

### Adding a Group

1. Query the database to find the group's JID
2. Use the `register_group` MCP tool with the JID, name, folder, and trigger
3. Optionally include `containerConfig` for additional mounts
4. The group folder is created automatically: `/workspace/project/groups/{folder-name}/`
5. Optionally create an initial `CLAUDE.md` for the group

Folder naming convention — channel prefix with underscore separator:
- WhatsApp "Family Chat" → `whatsapp_family-chat`
- Telegram "Dev Team" → `telegram_dev-team`

---

## Global Memory

You can read and write to `/workspace/project/groups/global/CLAUDE.md` for facts that should apply to all groups. Only update global memory when explicitly asked to "remember this globally" or similar.

---

## Scheduling for Other Groups

When scheduling tasks for other groups, use the `target_group_jid` parameter with the group's JID:
- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "<jid>")`

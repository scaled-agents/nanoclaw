# FreqHub Measurement Framework

## Context

We need a lightweight metric export to measure the autonomous research pipeline's health. Three deliverables: (1) a `sdna metrics` CLI command that queries aphexDATA + registry and outputs structured JSON, (2) weekly snapshot storage for trend tracking, (3) NanoClaw reporting integration for "how's research going" and morning report.

No web UI, no new services, no schema changes to aphexDATA or registry.

---

## Architecture

### Data Flow

```
sdna metrics --json
  ├── reads: /workspace/group/dist/registry.json (local, built by `sdna build`)
  │   └── already contains: genomes[], dag{roots,leaves,edges,frontier}, leaderboard[], stats
  ├── HTTP GET: APHEXDATA_URL/api/v1/events (filtered by verb/date)
  │   └── experiments = events where verb_id in ("attested","discarded","loop_complete")
  ├── reads: ~/.sdna/snapshots/metrics-YYYY-WW.json (previous week, if exists)
  └── outputs: JSON matching the requested schema
```

Key insight: `sdna build` (in `container/freqhub/cli/src/commands/build.js`) already computes DAG metrics via `dag.js` utilities — roots, leaves, edges, depths, frontier. The `metrics` command can read the built `registry.json` directly instead of recomputing.

---

## Files Summary

| # | File | Action | ~Lines |
|---|------|--------|--------|
| 1 | `container/freqhub/cli/src/commands/metrics.js` | **New** | ~220 |
| 2 | `container/freqhub/cli/bin/sdna.js` | Modify — register `metrics` command | ~15 |
| 3 | `container/skills/research-metrics/SKILL.md` | **New** | ~90 |
| 4 | `groups/global/CLAUDE.md` | Modify — add Workflow J, modify Workflow D | ~15 |

**Total: ~340 lines, 2 new files, 2 modified files**

---

## File 1: `container/freqhub/cli/src/commands/metrics.js` (NEW)

### Inputs

- `--registry <path>` — path to `registry.json` (default: `dist/registry.json`)
- `--aphexdata-url <url>` — aphexDATA base URL (default: `$APHEXDATA_URL` env var)
- `--snapshot` — save to `~/.sdna/snapshots/metrics-YYYY-WW.json` after computing
- `--json` — output raw JSON (default: formatted text summary)

### Logic

```js
export async function computeMetrics(opts) {
  // 1. Load registry.json
  const registry = JSON.parse(fs.readFileSync(registryPath))
  // Already has: genomes[], dag{roots, leaves, edges, frontier}, leaderboard[], stats

  // 2. Query aphexDATA for experiment events (last 7 days + previous 7 days)
  const thisWeek = await queryTDS(aphexdataUrl, { verb_id: "attested", from: weekAgoISO, limit: 200 })
  const thisWeekDiscards = await queryTDS(aphexdataUrl, { verb_id: "discarded", from: weekAgoISO, limit: 200 })
  const lastWeek = await queryTDS(aphexdataUrl, { verb_id: "attested", from: twoWeeksAgoISO, to: weekAgoISO, limit: 200 })
  const lastWeekDiscards = await queryTDS(aphexdataUrl, { verb_id: "discarded", from: twoWeeksAgoISO, to: weekAgoISO, limit: 200 })
  const recentExperiments = await queryTDS(aphexdataUrl, { verb_id: "loop_complete", from: weekAgoISO, limit: 10 })

  // 3. Compute velocity
  const experiments_this_week = thisWeek.length + thisWeekDiscards.length
  const experiments_last_week = lastWeek.length + lastWeekDiscards.length
  const hit_rate_this_week = thisWeek.length / (experiments_this_week || 1)
  const hit_rate_last_week = lastWeek.length / (experiments_last_week || 1)

  // 4. Compute quality from registry leaderboard
  const top5 = registry.leaderboard.slice(0, 5)
  const top5_avg_sharpe = mean(top5.map(e => e.sharpe))
  const tier_counts = countBy(registry.genomes, g => g.tier)
  const overfit_rate = countOverfit(registry.genomes)

  // 5. Compute discovery from DAG
  const dag_depth_max = maxDepthFromEdges(registry)
  const dag_branches = registry.dag.roots.length
  const frontier_nodes = registry.dag.frontier.length

  // 6. Load previous snapshot for trends
  const prevSnapshot = loadSnapshot(previousWeekKey)
  const top5_sharpe_trend = prevSnapshot ? top5_avg_sharpe - prevSnapshot.quality.top5_avg_sharpe : null
  const hit_rate_trend = prevSnapshot ? hit_rate_this_week - prevSnapshot.velocity.hit_rate.this_week : null

  // 7. Build recent_experiments from aphexDATA events
  // 8. Build experiment_history (hourly buckets, last 24h)
  // 9. North star: viable / hours_in_week
  // 10. Optionally save snapshot
  if (opts.snapshot) saveSnapshot(weekKey, result)

  return result
}
```

### aphexDATA query helper

```js
async function queryTDS(baseUrl, params) {
  if (!baseUrl) return [] // graceful degradation if aphexDATA not configured
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v))
  }
  const res = await fetch(`${baseUrl}/api/v1/events?${qs}`)
  if (!res.ok) return []
  return await res.json()
}
```

### Snapshot storage

- Path: `~/.sdna/snapshots/metrics-YYYY-WW.json` (ISO week number)
- Create `~/.sdna/snapshots/` directory if it doesn't exist
- Load previous week: `metrics-YYYY-(WW-1).json` — handle year boundary
- If no previous snapshot, all trend fields are `null`

### Output JSON schema

```json
{
  "computed_at": "ISO timestamp",
  "north_star": { "viable_strategies_per_human_hour": 0.0 },
  "velocity": {
    "experiments_total": { "today": 0, "this_week": 0, "last_week": 0 },
    "experiments_viable": { "today": 0, "this_week": 0, "last_week": 0 },
    "hit_rate": { "today": 0.0, "this_week": 0.0, "last_week": 0.0 },
    "hit_rate_trend": null,
    "avg_experiment_duration_minutes": 0.0,
    "experiments_per_hour": { "today": 0.0, "this_week": 0.0, "last_week": 0.0 }
  },
  "quality": {
    "top5_avg_sharpe": 0.0, "top5_sharpe_trend": null,
    "avg_max_drawdown": 0.0, "total_attested": 0, "overfit_rate": 0.0
  },
  "discovery": {
    "total_genomes": 0, "dag_depth_max": 0, "dag_branches": 0,
    "frontier_nodes": 0, "agent_originated_pct": 0.0,
    "signal_types_explored": [], "regime_coverage": {}
  },
  "recent_experiments": [],
  "experiment_history": []
}
```

### Metric computation details

**North star — `viable_strategies_per_human_hour`:**
- viable = registry genomes with `tier` in ("viable", "strong", "exceptional")
- human_hours = hours elapsed from first aphexDATA event this week to now (capped at 168)
- If no aphexDATA events: use `null` and note gap

**Velocity — `experiments_total/viable`:**
- `today`: filter aphexDATA events where `occurred_at` >= start of today
- `this_week`: filter where `occurred_at` >= 7 days ago
- `last_week`: filter where `occurred_at` between 14 and 7 days ago
- `experiments_viable` = events with verb_id="attested"
- `experiments_total` = attested + discarded events

**Velocity — `avg_experiment_duration_minutes`:**
- Parse `result_data.duration_seconds` from `loop_complete` events if available
- Fallback: estimate from average gap between consecutive experiment events
- If unavailable: `null`

**Velocity — `experiments_per_hour`:**
- `experiments_total.this_week / active_hours_this_week`
- active_hours = hours between first and last event in period (minimum 1)

**Quality — `top5_avg_sharpe`:**
- From `registry.leaderboard` (already sorted by WF Sharpe descending), take top 5
- Average their `sharpe` field

**Quality — `avg_max_drawdown`:**
- From registry genomes with attestation data, average `attestation.max_drawdown`

**Quality — `total_attested`:**
- `registry.stats.attested`

**Quality — `overfit_rate`:**
- Genomes where in-sample Sharpe is >2x the WF Sharpe (if both available)
- = overfit_count / total_attested

**Discovery — DAG metrics:**
- `total_genomes`: `registry.stats.total`
- `dag_depth_max`: max depth computed from registry genomes + parent pointers
- `dag_branches`: `registry.dag.roots.length` (number of independent lineage trees)
- `frontier_nodes`: `registry.dag.frontier.length`

**Discovery — `agent_originated_pct`:**
- Count genomes where `author` or `operator` contains "wolf" or "agent" (case-insensitive)
- / total_genomes

**Discovery — `signal_types_explored`:**
- Extract unique tags from registry genomes (e.g., "momentum", "mean-reversion", "volatility")

**Discovery — `regime_coverage`:**
- Count genomes by their primary tag/signal family
- Output: `{ "momentum": 5, "mean_reversion": 3, "trend_following": 2 }`

**Recent experiments (last 20):**
- Combine attested + discarded aphexDATA events, sort by `occurred_at` desc, take 20
- Each entry: `{ time, genome_name, parent_sharpe, result_sharpe, mutation, verdict }`
- Extract from `result_data` fields (genome name from `object_id`, sharpe from result_data)

**Experiment history (hourly buckets, last 24h):**
- Bucket attested + discarded events by hour
- Each: `{ hour: "ISO", experiments: N, viable: N }`

### Error handling

- aphexDATA not configured / unreachable: set all velocity fields to 0, note `"_gaps": ["aphexDATA unavailable"]`
- Registry not built: error message telling user to run `sdna build content/ -o dist/`
- No previous snapshot: all trend fields `null`
- <10 experiments: add `"_gaps": ["fewer than 10 experiments this week"]`

---

## File 2: `container/freqhub/cli/bin/sdna.js` (MODIFY)

Add `metrics` command after existing commands:

```js
// --- metrics ---
program
  .command('metrics')
  .description('Compute research pipeline health metrics')
  .option('-r, --registry <path>', 'path to registry.json', 'dist/registry.json')
  .option('--aphexdata-url <url>', 'aphexDATA base URL (default: $APHEXDATA_URL)')
  .option('--snapshot', 'save weekly snapshot to ~/.sdna/snapshots/')
  .option('--json', 'output as JSON')
  .action(async (opts) => {
    const { computeMetrics } = await import('../src/commands/metrics.js');
    try {
      const result = await computeMetrics({
        registryPath: opts.registry,
        aphexdataUrl: opts.aphexdataUrl || process.env.APHEXDATA_URL,
        snapshot: opts.snapshot,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printMetricsSummary(result); // human-readable text
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });
```

---

## File 3: `container/skills/research-metrics/SKILL.md` (NEW)

Skill document that instructs the agent to:

1. **Run** `sdna metrics --json -r /workspace/group/dist/registry.json --snapshot` via bash
2. **Parse** the JSON output
3. **Format** as WhatsApp-friendly text using the template below
4. **Handle** gaps (empty registry, aphexDATA offline)

### Full Dashboard Template (for "how's research going")

```
*Research Dashboard*
_{date}_

*North Star*
• Viable strategies per hour: {viable_per_hour}

*Velocity (this week)*
• Experiments: {exp_this_week} ({exp_viable} viable, {hit_rate}% hit rate)
• vs last week: {exp_delta} experiments, {hit_rate_delta} hit rate
• Speed: {exp_per_hour}/hr

*Quality*
• Top 5 avg Sharpe: {top5_sharpe} ({top5_trend})
• Total attested: {total_attested}
• Avg max drawdown: {avg_dd}%
• Overfit rate: {overfit}%

*Discovery*
• Genomes: {total} | DAG depth: {depth} | Branches: {branches}
• Frontier: {frontier} unexplored nodes
• Signals: {signal_list}

*Recent* (last 5)
{recent_experiments formatted as bullets}
```

### Morning Report Integration (compact 3-line block)

```
*Research Pulse*
• {exp_this_week} experiments this week ({hit_rate}% hit rate)
• Registry: {total_genomes} genomes, best Sharpe {top1_sharpe}
• Frontier: {frontier} nodes, {viable} viable strategies
```

---

## File 4: `groups/global/CLAUDE.md` (MODIFY)

### Add to Workflow Selection (after Workflow I line)

```
- User asks "how's research going", "stats", "dashboard", "metrics" → **Workflow J** (Research Metrics)
```

### Add Workflow J section (after Workflow I)

```
## Workflow J: Research Metrics Dashboard

**Trigger:** "how's research going" / "stats" / "dashboard" / "metrics" / "research health"

1. First ensure registry is current: `sdna build /workspace/group/content/ -o /workspace/group/dist/` (bash)
2. Run `sdna metrics --json -r /workspace/group/dist/registry.json --snapshot` (bash)
3. Parse the JSON output
4. Format using the research-metrics skill templates (full dashboard or morning compact)
5. If `_gaps` array is non-empty, mention the gaps at the bottom
```

### Modify Workflow D (prepend step 0)

```
0. **Research pulse** — run `sdna metrics --json -r /workspace/group/dist/registry.json` (bash), format as the compact 3-line Research Pulse block from research-metrics skill, place at top of morning report.
```

---

## Reused Existing Code

| What | File | Reuse |
|------|------|-------|
| DAG computation (roots, leaves, depths, frontier) | `container/freqhub/cli/src/lib/dag.js` | Called by `build.js`, output stored in `registry.json` — metrics reads the built result |
| Quality tiers | `container/freqhub/cli/src/commands/build.js:10-16` | Tiers already computed per genome in registry |
| Registry stats | `build.js:128-138` | `registry.stats.total`, `.attested` already computed |
| Leaderboard | `build.js:109-125` | Already sorted by WF Sharpe, stored in `registry.leaderboard` |
| aphexDATA HTTP pattern | `container/agent-runner/src/aphexdata-mcp-stdio.ts:19-35` | Reuse URL + auth pattern for HTTP queries |
| Commander.js CLI pattern | `container/freqhub/cli/bin/sdna.js` | Follow existing async import + action pattern |

---

## What We DON'T Change

- aphexDATA event schemas — query existing verbs (attested, discarded, loop_complete)
- Registry format — read existing `registry.json` output from `sdna build`
- aphexDNA core — no changes to Python registry/scoring code
- Morning report thread in FreqSwarm — modification is only in CLAUDE.md instructions
- Container Dockerfile — `sdna` CLI is already available in container
- MCP servers — no new tools needed

---

## Verification

1. **Unit test metrics.js**: Mock `registry.json` with 10 genomes + mock aphexDATA HTTP responses → verify all metrics compute correctly
2. **Test with empty data**: Empty registry + no aphexDATA → verify graceful degradation with `_gaps`
3. **Test snapshot**: Run with `--snapshot`, verify file created at `~/.sdna/snapshots/metrics-YYYY-WW.json`, run again and verify trends compute from previous snapshot
4. **Integration in container**: Build registry (`sdna build content/ -o dist/`), run `sdna metrics --json`, verify output matches schema
5. **End-to-end via WhatsApp**: Say "how's research going" → verify formatted dashboard appears with real numbers
6. **Morning report**: Trigger Workflow D → verify Research Pulse header appears at top

# Research Metrics Dashboard

Compute and format pipeline health metrics from the FreqHub registry and aphexDATA event store.

## When to Use

- User asks "how's research going", "stats", "dashboard", "metrics", "research health"
- Morning report (Workflow D) — include the compact Research Pulse block

## Steps

1. Ensure registry is current:
   ```bash
   sdna build /workspace/group/content/ -o /workspace/group/dist/
   ```

2. Compute metrics:
   ```bash
   sdna metrics --json -r /workspace/group/dist/registry.json --snapshot
   ```

3. Parse the JSON output and format using the templates below.

4. If `_gaps` array is non-empty, mention gaps at the bottom.

## Full Dashboard Template

Use for "how's research going" / "stats" / "dashboard" / "metrics":

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

## Morning Report Compact Template

Use as the first section in Workflow D morning reports:

```
*Research Pulse*
• {exp_this_week} experiments this week ({hit_rate}% hit rate)
• Registry: {total_genomes} genomes, best Sharpe {top1_sharpe}
• Frontier: {frontier} nodes, {viable} viable strategies
```

## Field Mapping

| Template field | JSON path |
|---|---|
| viable_per_hour | north_star.viable_strategies_per_human_hour |
| exp_this_week | velocity.experiments_total.this_week |
| exp_viable | velocity.experiments_viable.this_week |
| hit_rate | velocity.hit_rate.this_week × 100 |
| exp_delta | velocity.experiments_total.this_week − last_week |
| hit_rate_delta | velocity.hit_rate_trend × 100 |
| exp_per_hour | velocity.experiments_per_hour.this_week |
| top5_sharpe | quality.top5_avg_sharpe |
| top5_trend | quality.top5_sharpe_trend (format as +/−) |
| total_attested | quality.total_attested |
| avg_dd | quality.avg_max_drawdown |
| overfit | quality.overfit_rate × 100 |
| total / total_genomes | discovery.total_genomes |
| depth | discovery.dag_depth_max |
| branches | discovery.dag_branches |
| frontier | discovery.frontier_nodes |
| signal_list | discovery.signal_types_explored (join with ", ") |
| top1_sharpe | leaderboard[0].sharpe from registry (or quality.top5_avg_sharpe as fallback) |
| viable | count of genomes with tier in (viable, strong, exceptional) |

## Error Handling

- **Registry not built**: Tell user to run `sdna build content/ -o dist/` first
- **aphexDATA offline**: Show registry-only metrics, note "aphexDATA unavailable — velocity data not shown"
- **No experiments**: Show registry stats with note "No experiments recorded yet"
- **`_gaps` present**: Append as italic footnote

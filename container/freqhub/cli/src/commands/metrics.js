import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDepths, buildDAG } from '../lib/dag.js';

// ── Helpers ──────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function countBy(arr, fn) {
  const counts = {};
  for (const item of arr) {
    const key = fn(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

function prevWeekKey(key) {
  const [year, week] = key.split('-').map(Number);
  if (week <= 1) return `${year - 1}-52`;
  return `${year}-${String(week - 1).padStart(2, '0')}`;
}

function snapshotDir() {
  return path.join(os.homedir(), '.sdna', 'snapshots');
}

function loadSnapshot(weekKey) {
  const p = path.join(snapshotDir(), `metrics-${weekKey}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function saveSnapshot(weekKey, data) {
  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `metrics-${weekKey}.json`), JSON.stringify(data, null, 2));
}

// ── aphexDATA Query ────────────────────────────────────────────────────────

async function queryTDS(baseUrl, params) {
  if (!baseUrl) return [];
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  try {
    const headers = {};
    if (process.env.APHEXDATA_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.APHEXDATA_API_KEY}`;
    }
    const res = await fetch(`${baseUrl}/api/v1/events?${qs}`, { headers });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Compute research pipeline health metrics.
 * @param {{ registryPath: string, tdsUrl?: string, snapshot?: boolean }} opts
 */
export async function computeMetrics(opts) {
  const gaps = [];
  const now = new Date();
  const registryPath = opts.registryPath || 'dist/registry.json';

  // 1. Load registry
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Registry not found at ${registryPath}. Run: sdna build content/ -o dist/`);
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  const genomes = registry.genomes || [];
  const leaderboard = registry.leaderboard || [];
  const stats = registry.stats || {};
  const dag = registry.dag || {};

  // 2. Time boundaries
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);
  const dayAgo = new Date(now.getTime() - 24 * 3600000);

  const tdsUrl = opts.tdsUrl || '';

  // 3. Query aphexDATA events
  const [thisWeekAttested, thisWeekDiscards, lastWeekAttested, lastWeekDiscards, loopEvents] =
    await Promise.all([
      queryTDS(tdsUrl, { verb_id: 'attested', from: weekAgo.toISOString(), limit: 200 }),
      queryTDS(tdsUrl, { verb_id: 'discarded', from: weekAgo.toISOString(), limit: 200 }),
      queryTDS(tdsUrl, { verb_id: 'attested', from: twoWeeksAgo.toISOString(), to: weekAgo.toISOString(), limit: 200 }),
      queryTDS(tdsUrl, { verb_id: 'discarded', from: twoWeeksAgo.toISOString(), to: weekAgo.toISOString(), limit: 200 }),
      queryTDS(tdsUrl, { verb_id: 'loop_complete', from: weekAgo.toISOString(), limit: 50 }),
    ]);

  if (!tdsUrl) gaps.push('aphexDATA unavailable');

  // Filter today's events
  const todayAttested = thisWeekAttested.filter(e => new Date(e.occurred_at) >= todayStart);
  const todayDiscards = thisWeekDiscards.filter(e => new Date(e.occurred_at) >= todayStart);

  // 4. Velocity
  const expTotalToday = todayAttested.length + todayDiscards.length;
  const expTotalWeek = thisWeekAttested.length + thisWeekDiscards.length;
  const expTotalLastWeek = lastWeekAttested.length + lastWeekDiscards.length;

  const hitRateToday = todayAttested.length / (expTotalToday || 1);
  const hitRateWeek = thisWeekAttested.length / (expTotalWeek || 1);
  const hitRateLastWeek = lastWeekAttested.length / (expTotalLastWeek || 1);

  // Experiment duration from loop_complete events
  let avgDurationMinutes = null;
  const durations = loopEvents
    .map(e => e.result_data?.duration_seconds)
    .filter(d => d != null);
  if (durations.length > 0) {
    avgDurationMinutes = Math.round(mean(durations) / 60 * 10) / 10;
  }

  // Experiments per hour
  function expPerHour(events, periodHours) {
    if (!events.length) return 0;
    const timestamps = events.map(e => new Date(e.occurred_at).getTime()).sort();
    const activeHours = Math.max((timestamps[timestamps.length - 1] - timestamps[0]) / 3600000, 1);
    return Math.round((events.length / activeHours) * 10) / 10;
  }

  const allTodayEvents = [...todayAttested, ...todayDiscards];
  const allWeekEvents = [...thisWeekAttested, ...thisWeekDiscards];
  const allLastWeekEvents = [...lastWeekAttested, ...lastWeekDiscards];

  // 5. Quality
  const top5 = leaderboard.slice(0, 5);
  const top5AvgSharpe = top5.length > 0
    ? Math.round(mean(top5.map(e => e.sharpe)) * 1000) / 1000
    : 0;

  const attestedGenomes = genomes.filter(g => g.attestation?.status === 'attested');
  const avgMaxDrawdown = attestedGenomes.length > 0
    ? Math.round(mean(attestedGenomes.map(g => g.attestation?.max_drawdown).filter(d => d != null)) * 100) / 100
    : 0;

  // Overfit: in-sample Sharpe > 2× WF Sharpe
  let overfitCount = 0;
  for (const g of attestedGenomes) {
    const wfSharpe = g.attestation?.walk_forward_sharpe;
    const isSharpe = g.attestation?.in_sample_sharpe;
    if (wfSharpe != null && isSharpe != null && isSharpe > 2 * wfSharpe) {
      overfitCount++;
    }
  }
  const overfitRate = attestedGenomes.length > 0
    ? Math.round((overfitCount / attestedGenomes.length) * 1000) / 1000
    : 0;

  // 6. Discovery
  // Recompute depths from genomes + parent pointers
  let dagDepthMax = 0;
  try {
    const dagData = buildDAG(genomes);
    const depths = getDepths(genomes, dagData.parents);
    dagDepthMax = depths.size > 0 ? Math.max(...depths.values()) : 0;
  } catch {
    // Fall back to edge count estimate
    dagDepthMax = (dag.edges || []).length > 0 ? Math.max(...(dag.edges || []).map(() => 1)) : 0;
  }

  const dagBranches = (dag.roots || []).length;
  const frontierNodes = (dag.frontier || []).length;

  // Agent-originated percentage
  const agentGenomes = genomes.filter(g => {
    const a = (g.author || '').toLowerCase();
    const o = (g.operator || '').toLowerCase();
    return a.includes('wolf') || a.includes('agent') || o.includes('wolf') || o.includes('agent');
  });
  const agentOriginatedPct = genomes.length > 0
    ? Math.round((agentGenomes.length / genomes.length) * 1000) / 1000
    : 0;

  // Signal types and regime coverage
  const allTags = new Set();
  const tagCounts = {};
  for (const g of genomes) {
    for (const tag of g.tags || []) {
      allTags.add(tag);
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  // 7. North star
  const viableTiers = new Set(['viable', 'strong', 'exceptional']);
  const viableCount = genomes.filter(g => viableTiers.has(g.tier)).length;

  // Human hours: span from first event this week to now
  let humanHours = null;
  if (allWeekEvents.length > 0) {
    const firstEvent = Math.min(...allWeekEvents.map(e => new Date(e.occurred_at).getTime()));
    humanHours = Math.min((now.getTime() - firstEvent) / 3600000, 168);
  }
  const viablePerHour = humanHours != null && humanHours > 0
    ? Math.round((viableCount / humanHours) * 1000) / 1000
    : null;

  // 8. Trends from previous snapshot
  const weekKey = isoWeekKey(now);
  const prevSnapshot = loadSnapshot(prevWeekKey(weekKey));

  const top5SharpeTrend = prevSnapshot?.quality?.top5_avg_sharpe != null
    ? Math.round((top5AvgSharpe - prevSnapshot.quality.top5_avg_sharpe) * 1000) / 1000
    : null;

  const hitRateTrend = prevSnapshot?.velocity?.hit_rate?.this_week != null
    ? Math.round((hitRateWeek - prevSnapshot.velocity.hit_rate.this_week) * 1000) / 1000
    : null;

  // 9. Recent experiments (last 20 from aphexDATA)
  const allRecentEvents = [...thisWeekAttested, ...thisWeekDiscards]
    .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
    .slice(0, 20);

  const recentExperiments = allRecentEvents.map(e => ({
    time: e.occurred_at,
    genome_name: e.object_id || e.result_data?.genome_name || 'unknown',
    parent_sharpe: e.result_data?.parent_sharpe ?? null,
    result_sharpe: e.result_data?.sharpe ?? e.result_data?.walk_forward_sharpe ?? null,
    mutation: e.result_data?.mutation || null,
    verdict: e.verb_id === 'attested' ? 'kept' : 'discarded',
  }));

  // 10. Experiment history (hourly buckets, last 24h)
  const last24hEvents = [...thisWeekAttested, ...thisWeekDiscards]
    .filter(e => new Date(e.occurred_at) >= dayAgo);

  const hourBuckets = {};
  for (let h = 0; h < 24; h++) {
    const bucketStart = new Date(dayAgo.getTime() + h * 3600000);
    const bucketKey = bucketStart.toISOString().slice(0, 13) + ':00:00Z';
    hourBuckets[bucketKey] = { hour: bucketKey, experiments: 0, viable: 0 };
  }
  for (const e of last24hEvents) {
    const bucketKey = new Date(e.occurred_at).toISOString().slice(0, 13) + ':00:00Z';
    if (hourBuckets[bucketKey]) {
      hourBuckets[bucketKey].experiments++;
      if (e.verb_id === 'attested') hourBuckets[bucketKey].viable++;
    }
  }

  if (expTotalWeek < 10) gaps.push('fewer than 10 experiments this week');

  // 11. Build result
  const result = {
    computed_at: now.toISOString(),
    north_star: { viable_strategies_per_human_hour: viablePerHour },
    velocity: {
      experiments_total: { today: expTotalToday, this_week: expTotalWeek, last_week: expTotalLastWeek },
      experiments_viable: { today: todayAttested.length, this_week: thisWeekAttested.length, last_week: lastWeekAttested.length },
      hit_rate: {
        today: Math.round(hitRateToday * 1000) / 1000,
        this_week: Math.round(hitRateWeek * 1000) / 1000,
        last_week: Math.round(hitRateLastWeek * 1000) / 1000,
      },
      hit_rate_trend: hitRateTrend,
      avg_experiment_duration_minutes: avgDurationMinutes,
      experiments_per_hour: {
        today: expPerHour(allTodayEvents),
        this_week: expPerHour(allWeekEvents),
        last_week: expPerHour(allLastWeekEvents),
      },
    },
    quality: {
      top5_avg_sharpe: top5AvgSharpe,
      top5_sharpe_trend: top5SharpeTrend,
      avg_max_drawdown: avgMaxDrawdown,
      total_attested: stats.attested || 0,
      overfit_rate: overfitRate,
    },
    discovery: {
      total_genomes: stats.total || genomes.length,
      dag_depth_max: dagDepthMax,
      dag_branches: dagBranches,
      frontier_nodes: frontierNodes,
      agent_originated_pct: agentOriginatedPct,
      signal_types_explored: [...allTags].sort(),
      regime_coverage: tagCounts,
    },
    recent_experiments: recentExperiments,
    experiment_history: Object.values(hourBuckets).sort((a, b) => a.hour.localeCompare(b.hour)),
  };

  if (gaps.length > 0) result._gaps = gaps;

  // 12. Optionally save snapshot
  if (opts.snapshot) {
    saveSnapshot(weekKey, result);
  }

  return result;
}

/**
 * Print a human-readable metrics summary to stdout.
 */
export function printMetricsSummary(m) {
  const v = m.velocity;
  const q = m.quality;
  const d = m.discovery;

  console.log('');
  console.log('  Research Pipeline Metrics');
  console.log(`  ${m.computed_at}`);
  console.log('');

  const ns = m.north_star.viable_strategies_per_human_hour;
  console.log(`  North Star: ${ns != null ? ns.toFixed(3) : 'n/a'} viable strategies/human-hour`);
  console.log('');

  console.log('  Velocity');
  console.log(`    Experiments (today/week/last): ${v.experiments_total.today} / ${v.experiments_total.this_week} / ${v.experiments_total.last_week}`);
  console.log(`    Viable     (today/week/last): ${v.experiments_viable.today} / ${v.experiments_viable.this_week} / ${v.experiments_viable.last_week}`);
  console.log(`    Hit rate   (today/week/last): ${(v.hit_rate.today * 100).toFixed(1)}% / ${(v.hit_rate.this_week * 100).toFixed(1)}% / ${(v.hit_rate.last_week * 100).toFixed(1)}%`);
  if (v.hit_rate_trend != null) console.log(`    Hit rate trend: ${v.hit_rate_trend > 0 ? '+' : ''}${(v.hit_rate_trend * 100).toFixed(1)}%`);
  if (v.avg_experiment_duration_minutes != null) console.log(`    Avg duration: ${v.avg_experiment_duration_minutes} min`);
  console.log(`    Speed (per hr): ${v.experiments_per_hour.today} / ${v.experiments_per_hour.this_week} / ${v.experiments_per_hour.last_week}`);
  console.log('');

  console.log('  Quality');
  console.log(`    Top 5 avg Sharpe: ${q.top5_avg_sharpe.toFixed(3)}${q.top5_sharpe_trend != null ? ` (${q.top5_sharpe_trend > 0 ? '+' : ''}${q.top5_sharpe_trend.toFixed(3)})` : ''}`);
  console.log(`    Total attested: ${q.total_attested}`);
  console.log(`    Avg max drawdown: ${q.avg_max_drawdown.toFixed(2)}%`);
  console.log(`    Overfit rate: ${(q.overfit_rate * 100).toFixed(1)}%`);
  console.log('');

  console.log('  Discovery');
  console.log(`    Genomes: ${d.total_genomes} | DAG depth: ${d.dag_depth_max} | Branches: ${d.dag_branches}`);
  console.log(`    Frontier: ${d.frontier_nodes} nodes`);
  console.log(`    Agent-originated: ${(d.agent_originated_pct * 100).toFixed(1)}%`);
  if (d.signal_types_explored.length) console.log(`    Signals: ${d.signal_types_explored.join(', ')}`);
  console.log('');

  if (m._gaps?.length) {
    console.log(`  Gaps: ${m._gaps.join('; ')}`);
    console.log('');
  }
}

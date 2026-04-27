/**
 * Candidate gathering and ranking — pure deterministic functions.
 * Collects deployment candidates from 4 sources (campaigns, roster,
 * triage-matrix, gap-report, competition queue) and ranks them.
 * No I/O, no side effects.
 */

import type { ArchetypeConfig, ScoringConfig } from './health-types.js';
import type { DeployCandidate, CandidateSource } from './deploy-types.js';

// ─── Helpers ────────────────────────────────────────────────────────

function isDuplicate(
  candidates: DeployCandidate[],
  strategy: string,
  pair: string,
): boolean {
  return candidates.some((c) => c.strategy === strategy && c.pair === pair);
}

function isAlreadyDeployed(
  deployments: any[],
  strategy: string,
  pair: string,
): boolean {
  return deployments.some(
    (d: any) =>
      d.strategy === strategy &&
      (d.pairs?.includes(pair) || d.pair === pair) &&
      d.state !== 'retired',
  );
}

function countDeploymentFailures(
  campaigns: any[],
  archetype: string,
  pair: string,
  timeframe: string,
): number {
  return campaigns.filter(
    (c: any) =>
      c.archetype === archetype &&
      c.pair === pair &&
      c.timeframe === timeframe &&
      c.state === 'retired' &&
      c.retire_reason?.startsWith('verification_failed'),
  ).length;
}

function lookupGapScore(
  gapReport: any,
  archetype: string,
  pair: string,
  timeframe: string,
): number {
  if (!gapReport?.top_gaps) return 1.0;
  const gap = gapReport.top_gaps.find(
    (g: any) =>
      g.archetype === archetype &&
      g.pair === pair &&
      g.timeframe === timeframe,
  );
  return gap?.gap_score ?? 1.0;
}

// ─── Source A: Kata Graduates (campaigns.json) ──────────────────

function gatherFromCampaigns(
  campaigns: any[],
  archetypes: Record<string, ArchetypeConfig>,
  gapReport: any,
  candidates: DeployCandidate[],
): void {
  for (const c of campaigns) {
    if (c.state !== 'pending_deploy') continue;
    if (!c.strategy || !c.pair) continue;
    if (isDuplicate(candidates, c.strategy, c.pair)) continue;

    const arch = archetypes[c.archetype];
    if (!arch) continue;

    candidates.push({
      strategy: c.strategy,
      strategy_path: c.strategy_path,
      pair: c.pair,
      timeframe: c.timeframe ?? '1h',
      archetype: c.archetype,
      correlation_group: arch.correlation_group,
      source: 'kata_graduated',
      quality: 1.5,
      favorable_sharpe: c.triage?.favorable_sharpe ?? c.favorable_sharpe ?? null,
      gap_score: lookupGapScore(gapReport, c.archetype, c.pair, c.timeframe),
      deployment_failures: countDeploymentFailures(
        campaigns,
        c.archetype,
        c.pair,
        c.timeframe,
      ),
    });
  }
}

// ─── Source A-bis: Roster Graduates (roster.json) ───────────────

function gatherFromRoster(
  roster: any,
  archetypes: Record<string, ArchetypeConfig>,
  gapReport: any,
  campaigns: any[],
  candidates: DeployCandidate[],
): void {
  const entries = roster?.roster ?? (Array.isArray(roster) ? roster : []);

  for (const r of entries) {
    if (!r.archetype || !archetypes[r.archetype]) continue;
    const arch = archetypes[r.archetype];

    // Structure 1: nested cells array
    if (Array.isArray(r.cells)) {
      for (const cell of r.cells) {
        if (cell.status !== 'pending_deploy') continue;
        const pair = cell.pair ?? r.pair;
        if (!pair) continue;
        if (isDuplicate(candidates, r.strategy_name ?? r.strategy, pair))
          continue;

        candidates.push({
          strategy: r.strategy_name ?? r.strategy,
          strategy_path: r.strategy_path,
          pair,
          timeframe: r.timeframe ?? cell.timeframe ?? '1h',
          archetype: r.archetype,
          correlation_group: arch.correlation_group,
          source: 'roster_graduated',
          quality: 1.5,
          favorable_sharpe:
            r.wf_sharpe ?? r.kata_score ?? r.favorable_sharpe ?? null,
          gap_score: lookupGapScore(
            gapReport,
            r.archetype,
            pair,
            r.timeframe,
          ),
          deployment_failures: countDeploymentFailures(
            campaigns,
            r.archetype,
            pair,
            r.timeframe,
          ),
        });
      }
      continue;
    }

    // Structure 2: flat (no cells array)
    if (r.status !== 'pending_deploy') continue;
    const pair = r.pair;
    if (!pair) continue;
    if (isDuplicate(candidates, r.strategy_name ?? r.strategy, pair)) continue;

    candidates.push({
      strategy: r.strategy_name ?? r.strategy,
      strategy_path: r.strategy_path,
      pair,
      timeframe: r.timeframe ?? '1h',
      archetype: r.archetype,
      correlation_group: arch.correlation_group,
      source: 'roster_graduated',
      quality: 1.5,
      favorable_sharpe:
        r.wf_sharpe ?? r.kata_score ?? r.favorable_sharpe ?? null,
      gap_score: lookupGapScore(gapReport, r.archetype, pair, r.timeframe),
      deployment_failures: countDeploymentFailures(
        campaigns,
        r.archetype,
        pair,
        r.timeframe,
      ),
    });
  }
}

// ─── Source B: Triage Qualifiers (triage-matrix.json) ───────────

function gatherFromTriage(
  triageMatrix: any,
  archetypes: Record<string, ArchetypeConfig>,
  gapReport: any,
  campaigns: any[],
  deployments: any[],
  candidates: DeployCandidate[],
): void {
  const winners = triageMatrix?.winners ?? triageMatrix?.qualifiers ?? [];

  for (const w of winners) {
    if ((w.favorable_sharpe ?? 0) < 0.5) continue;
    if (!w.strategy || !w.pair) continue;
    if (isAlreadyDeployed(deployments, w.strategy, w.pair)) continue;
    if (isDuplicate(candidates, w.strategy, w.pair)) continue;

    const arch = archetypes[w.archetype];
    if (!arch) continue;

    candidates.push({
      strategy: w.strategy,
      strategy_path: w.strategy_path,
      pair: w.pair,
      timeframe: w.timeframe ?? '1h',
      archetype: w.archetype,
      correlation_group: arch.correlation_group,
      source: 'qualifier',
      quality: 1.2,
      favorable_sharpe: w.favorable_sharpe ?? null,
      gap_score: lookupGapScore(gapReport, w.archetype, w.pair, w.timeframe),
      deployment_failures: countDeploymentFailures(
        campaigns,
        w.archetype,
        w.pair,
        w.timeframe,
      ),
    });
  }
}

// ─── Source C: Untested Gap Cells (gap-report.json) ─────────────

function gatherFromGaps(
  gapReport: any,
  archetypes: Record<string, ArchetypeConfig>,
  campaigns: any[],
  deployments: any[],
  candidates: DeployCandidate[],
): void {
  const gaps = gapReport?.top_gaps ?? [];

  for (const g of gaps) {
    if (!g.archetype || !g.pair) continue;
    // Skip if there's already a qualifier for this cell
    if (
      candidates.some(
        (c) =>
          c.archetype === g.archetype &&
          c.pair === g.pair &&
          c.timeframe === (g.timeframe ?? '1h'),
      )
    )
      continue;

    const arch = archetypes[g.archetype];
    if (!arch) continue;

    candidates.push({
      strategy: g.strategy ?? `gap_${g.archetype}_${g.pair}`,
      pair: g.pair,
      timeframe: g.timeframe ?? '1h',
      archetype: g.archetype,
      correlation_group: arch.correlation_group,
      source: 'untested',
      quality: 1.0,
      favorable_sharpe: null,
      gap_score: g.gap_score ?? 1.0,
      deployment_failures: countDeploymentFailures(
        campaigns,
        g.archetype,
        g.pair,
        g.timeframe,
      ),
    });
  }
}

// ─── Source D: Competition Queue ────────────────────────────────

function gatherFromCompetition(
  competitionState: any,
  candidateQueue: any[],
  archetypes: Record<string, ArchetypeConfig>,
  campaigns: any[],
  candidates: DeployCandidate[],
  now: Date,
): void {
  if (!competitionState?.active) return;

  for (const entry of candidateQueue) {
    if (entry.status !== 'active') continue;
    if (entry.expires_at && new Date(entry.expires_at) <= now) continue;
    if (
      isDuplicate(
        candidates,
        entry.strategy_name ?? entry.strategy,
        entry.pair,
      )
    )
      continue;

    const arch = archetypes[entry.archetype];
    if (!arch) continue;

    candidates.push({
      strategy: entry.strategy_name ?? entry.strategy,
      strategy_path: entry.strategy_path,
      pair: entry.pair,
      timeframe: entry.timeframe ?? '1h',
      archetype: entry.archetype,
      correlation_group: entry.correlation_group ?? arch.correlation_group,
      source: 'competition_queue',
      quality: 1.3,
      favorable_sharpe: entry.favorable_sharpe ?? null,
      gap_score: entry.gap_score ?? 1.0,
      deployment_failures: countDeploymentFailures(
        campaigns,
        entry.archetype,
        entry.pair,
        entry.timeframe,
      ),
    });
  }
}

// ─── Public API ─────────────────────────────────────────────────

export function gatherCandidates(
  campaigns: any[],
  roster: any,
  triageMatrix: any,
  gapReport: any,
  competitionState: any | null,
  candidateQueue: any[] | null,
  archetypes: Record<string, ArchetypeConfig>,
  deployments: any[],
  now: Date,
): DeployCandidate[] {
  const candidates: DeployCandidate[] = [];

  gatherFromCampaigns(campaigns, archetypes, gapReport, candidates);
  gatherFromRoster(roster, archetypes, gapReport, campaigns, candidates);
  gatherFromTriage(
    triageMatrix,
    archetypes,
    gapReport,
    campaigns,
    deployments,
    candidates,
  );
  gatherFromGaps(gapReport, archetypes, campaigns, deployments, candidates);
  gatherFromCompetition(
    competitionState,
    candidateQueue ?? [],
    archetypes,
    campaigns,
    candidates,
    now,
  );

  return candidates;
}

export function rankCandidates(
  candidates: DeployCandidate[],
  deployments: any[],
  config: ScoringConfig,
): DeployCandidate[] {
  // Count bots per correlation group
  const groupCounts: Record<string, number> = {};
  for (const d of deployments) {
    if (d.state === 'retired') continue;
    const group = d.correlation_group ?? 'unknown';
    groupCounts[group] = (groupCounts[group] ?? 0) + 1;
  }

  const qualityMultipliers: Record<string, number> =
    (config.SLOT_MANAGEMENT as any).candidate_quality_multipliers ?? {
      kata_graduated: 1.5,
      roster_graduated: 1.5,
      competition_queue: 1.3,
      qualifier: 1.2,
      untested: 1.0,
    };

  for (const c of candidates) {
    let score = c.gap_score;

    // Quality multiplier by source
    score *= qualityMultipliers[c.source] ?? c.quality;

    // Group diversity bonus
    const groupCount = groupCounts[c.correlation_group] ?? 0;
    if (groupCount === 0) {
      score *= 2.0; // empty group
    } else if (groupCount === 1) {
      score *= 1.3; // under-represented
    }

    // Dead cell cooldown
    if (c.deployment_failures >= 3) {
      score *= 0.3;
    }

    c.ranked_score = score;
  }

  // Sort descending by ranked_score
  return candidates.sort((a, b) => (b.ranked_score ?? 0) - (a.ranked_score ?? 0));
}

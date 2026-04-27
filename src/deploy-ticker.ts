/**
 * Deploy Ticker — deterministic host-side service replacing monitor-deploy LLM.
 * Runs every 30 minutes. Counts slots, gathers candidates, verifies, deploys.
 * Replaces the scheduled LLM monitor-deploy task (~1.4M tokens/day saved).
 */

import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { GROUPS_DIR } from './config.js';
import {
  loadScoringConfig,
  loadArchetypeConfigs,
  loadCampaigns,
  loadDeployments,
  loadRoster,
  loadCellGrid,
} from './state-loaders.js';
import { gatherCandidates, rankCandidates } from './deploy-candidates.js';
import {
  runVerificationBacktest,
  checkVerificationGates,
} from './deploy-verification.js';
import {
  loadPortfolio,
  loadTriageMatrix,
  loadGapReport,
  loadCompetitionState,
  loadCandidateQueue,
  loadSeason,
  checkCellGridStaleness,
  countSlots,
  countByGroup,
  executeDeployment,
  executeReplacement,
  writeDeployTickLog,
  fetchRegimes,
} from './deploy-actions.js';
import type { ScoringConfig, ArchetypeConfig } from './health-types.js';
import type { DeployTickerDeps, DeployTickResult } from './deploy-types.js';

const logger = pino({ name: 'deploy-ticker' });

const TICKER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_VERIFICATIONS_PER_TICK = 3;

// ─── Current Regime Lookup ──────────────────────────────────────────

function getCurrentRegime(
  cellGrid: any,
  pair: string,
): string | null {
  if (!cellGrid?.cells) return null;
  const cell = cellGrid.cells.find((c: any) => c.pair === pair);
  return cell?.regime ?? null;
}

// ─── Group Folder Name ──────────────────────────────────────────────

function getGroupFolderName(): string | null {
  try {
    if (!fs.existsSync(GROUPS_DIR)) return null;
    for (const folder of fs.readdirSync(GROUPS_DIR)) {
      const fullPath = path.join(GROUPS_DIR, folder);
      if (fs.statSync(fullPath).isDirectory()) return folder;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ─── Main Tick ──────────────────────────────────────────────────────

async function runDeployTick(
  deps: DeployTickerDeps,
  config: ScoringConfig,
  archetypes: Record<string, ArchetypeConfig>,
): Promise<void> {
  const now = new Date();
  logger.info('Deploy tick starting');

  const result: DeployTickResult = {
    deployed: 0,
    verified: 0,
    replaced: 0,
    slot_summary: { graduated: 0, trials: 0, total: 0, trial_room: 0 },
  };

  // ── 1. GUARD CLAUSES ──────────────────────────────────────────────

  const portfolio = loadPortfolio();
  if (portfolio?.circuit_breaker_active) {
    logger.info('Circuit breaker active — no deployments');
    result.skipped_guard = 'circuit_breaker';
    writeDeployTickLog(result);
    return;
  }

  if (
    portfolio?.risk_scaling?.shadow_mode === false &&
    (portfolio?.risk_scaling?.multiplier ?? 1) < 0.6
  ) {
    logger.info(
      { multiplier: portfolio.risk_scaling.multiplier },
      'Risk-off: multiplier < 0.60 — blocking trial deployments',
    );
    result.skipped_guard = 'risk_off';
    writeDeployTickLog(result);
    return;
  }

  const { stale, ageHours } = checkCellGridStaleness();
  if (stale) {
    logger.info(
      { ageHours: ageHours.toFixed(1) },
      'Cell grid stale — no deployments',
    );
    result.skipped_guard = 'stale_grid';
    writeDeployTickLog(result);
    return;
  }

  // ── 2. COUNT SLOTS ────────────────────────────────────────────────

  const deployments = loadDeployments();
  const slots = countSlots(deployments, config);
  result.slot_summary = slots;

  logger.info(
    {
      graduated: slots.graduated,
      trials: slots.trials,
      total: slots.total,
      trial_room: slots.trial_room,
    },
    `Slots: ${slots.graduated}G + ${slots.trials}T = ${slots.total}/${config.SLOT_MANAGEMENT.max_total_bots} (trial_room ${slots.trial_room})`,
  );

  if (slots.trial_room <= 0 && slots.total >= config.SLOT_MANAGEMENT.max_total_bots) {
    logger.info('Slots full — checking replacements only');
  }

  // ── 3. GATHER + RANK CANDIDATES ──────────────────────────────────

  const campaigns = loadCampaigns();
  const roster = loadRoster();
  const triageMatrix = loadTriageMatrix();
  const gapReport = loadGapReport();
  const competitionState = loadCompetitionState();
  const candidateQueue = loadCandidateQueue();
  const cellGrid = loadCellGrid();
  const groupFolderName = getGroupFolderName();

  if (!groupFolderName) {
    logger.warn('No group folder found — skipping deploy tick');
    writeDeployTickLog(result);
    return;
  }

  const candidates = gatherCandidates(
    campaigns,
    roster,
    triageMatrix,
    gapReport,
    competitionState,
    candidateQueue,
    archetypes,
    deployments,
    now,
  );

  if (candidates.length === 0) {
    logger.info('No deployment candidates found');
    writeDeployTickLog(result);
    return;
  }

  const ranked = rankCandidates(candidates, deployments, config);
  logger.info(
    { count: ranked.length, topScore: ranked[0]?.ranked_score?.toFixed(1) },
    'Candidates ranked',
  );

  // ── 4. DEPLOY TRIALS ─────────────────────────────────────────────

  let trialRoom = slots.trial_room;
  let verificationsThisTick = 0;
  const groupCounts = countByGroup(deployments);
  const maxPerGroup = config.SLOT_MANAGEMENT.max_per_group;
  const minVerifyWinRate = (config as any).DEPLOY_VERIFICATION?.min_win_rate ?? 0.3;

  for (const candidate of ranked) {
    if (trialRoom <= 0) break;

    // Group cap check
    const groupCount = groupCounts[candidate.correlation_group] ?? 0;
    if (groupCount >= maxPerGroup) {
      logger.debug(
        { group: candidate.correlation_group, count: groupCount },
        'Group cap reached — skipping',
      );
      continue;
    }

    // Verification cap
    if (verificationsThisTick >= MAX_VERIFICATIONS_PER_TICK) {
      logger.info('Verification cap reached — deferring remaining candidates');
      break;
    }

    // Run verification backtest
    const verResult = await runVerificationBacktest(
      candidate.strategy,
      candidate.pair,
      candidate.timeframe,
      groupFolderName,
    );
    verificationsThisTick++;
    result.verified++;

    // Check gates
    const currentRegime = getCurrentRegime(cellGrid, candidate.pair);
    const gateCheck = checkVerificationGates(
      verResult,
      archetypes[candidate.archetype],
      currentRegime,
      minVerifyWinRate,
    );

    if (!gateCheck.passed) {
      logger.info(
        {
          strategy: candidate.strategy,
          pair: candidate.pair,
          reason: gateCheck.reason,
        },
        'Verification failed — skipping',
      );
      try {
        await deps.sendMessage(
          deps.chatJid,
          `Slot fill skipped: ${candidate.strategy} on ${candidate.pair} — ${gateCheck.reason}`,
        );
      } catch {
        /* ignore */
      }
      continue;
    }

    // Deploy
    const deployed = await executeDeployment(
      deps,
      candidate,
      config,
      archetypes,
      groupFolderName,
      cellGrid,
      trialRoom,
    );

    if (deployed) {
      result.deployed++;
      trialRoom--;
      groupCounts[candidate.correlation_group] =
        (groupCounts[candidate.correlation_group] ?? 0) + 1;
    }
  }

  // ── 5. GRADUATED REPLACEMENT ──────────────────────────────────────

  const replacementThreshold =
    config.SLOT_MANAGEMENT.replacement_sharpe_threshold;

  for (const dep of deployments) {
    if (dep.slot_state !== 'graduated') continue;
    if (dep.state === 'retired') continue;
    if ((dep.eviction_priority ?? 0) <= 50) continue;

    // Find kata-graduated candidates for same cell
    const cellCandidates = campaigns.filter(
      (c: any) =>
        c.state === 'pending_deploy' &&
        c.archetype === dep.archetype &&
        c.pair === (dep.pairs?.[0] ?? dep.pair) &&
        c.timeframe === dep.timeframe,
    );

    for (const candidate of cellCandidates) {
      const sharpeImprovement =
        (candidate.triage?.favorable_sharpe ?? candidate.favorable_sharpe ?? 0) -
        (dep.live_sharpe ?? dep.wfo_sharpe ?? 0);

      if (sharpeImprovement <= replacementThreshold) continue;

      const arch = archetypes[candidate.archetype];
      if (!arch) continue;

      const deployCandidate = {
        strategy: candidate.strategy,
        pair: candidate.pair,
        timeframe: candidate.timeframe,
        archetype: candidate.archetype,
        correlation_group: arch.correlation_group,
        source: 'kata_graduated' as const,
        quality: 1.5,
        favorable_sharpe:
          candidate.triage?.favorable_sharpe ?? candidate.favorable_sharpe ?? null,
        gap_score: 1.0,
        deployment_failures: 0,
      };

      const replaced = await executeReplacement(
        deps,
        dep,
        deployCandidate,
        config,
        archetypes,
        groupFolderName,
        cellGrid,
      );
      if (replaced) {
        result.replaced++;
        break; // One replacement per graduate
      }
    }
  }

  // ── 6. GROUP BALANCE (informational) ──────────────────────────────

  const groupBalance = config.SLOT_MANAGEMENT.group_balance;
  if (groupBalance) {
    const finalGroupCounts = countByGroup([
      ...deployments.filter((d) => d.state !== 'retired'),
    ]);
    for (const [group, targets] of Object.entries(groupBalance)) {
      const count = finalGroupCounts[group] ?? 0;
      if (count < targets.min) {
        logger.warn(
          { group, count, min: targets.min },
          `Group ${group} below minimum`,
        );
      }
    }
  }

  // ── 7. LOG ────────────────────────────────────────────────────────

  writeDeployTickLog(result);

  // Summary message only if deployments or replacements happened
  if (result.deployed > 0 || result.replaced > 0) {
    const msg = `Slot allocation: deployed ${result.deployed} trials, replaced ${result.replaced} graduates. Verified ${result.verified} candidates.`;
    try {
      await deps.sendMessage(deps.chatJid, msg);
    } catch {
      /* ignore */
    }
  }

  logger.info(
    {
      deployed: result.deployed,
      verified: result.verified,
      replaced: result.replaced,
      slots: result.slot_summary,
    },
    'Deploy tick complete',
  );
}

// ─── Service Entry Point ────────────────────────────────────────────

let tickerTimer: ReturnType<typeof setInterval> | null = null;

export function startDeployTicker(deps: DeployTickerDeps): void {
  const config = loadScoringConfig();
  if (!config) {
    logger.error('Cannot start deploy ticker — scoring config not found');
    return;
  }

  const archetypes = loadArchetypeConfigs();
  if (!archetypes) {
    logger.error('Cannot start deploy ticker — archetypes.yaml not found');
    return;
  }

  logger.info(
    { intervalMs: TICKER_INTERVAL_MS },
    'Deploy ticker started',
  );

  // Delay first run by 7 minutes to stagger from health-ticker
  const INITIAL_DELAY_MS = 7 * 60 * 1000;
  setTimeout(() => {
    runDeployTick(deps, config, archetypes).catch((err) =>
      logger.error({ err }, 'Deploy tick failed'),
    );

    tickerTimer = setInterval(() => {
      runDeployTick(deps, config, archetypes).catch((err) =>
        logger.error({ err }, 'Deploy tick failed'),
      );
    }, TICKER_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}

export function stopDeployTicker(): void {
  if (tickerTimer) {
    clearInterval(tickerTimer);
    tickerTimer = null;
    logger.info('Deploy ticker stopped');
  }
}

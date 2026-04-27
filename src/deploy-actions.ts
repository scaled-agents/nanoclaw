/**
 * Deploy actions — side effects layer for the deterministic deploy ticker.
 * State file mutations, bot deployment, messaging, and audit.
 */

import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { recordAphexdataEvent, fetchRegimes } from './health-actions.js';
import { findGroupDir, readJsonFile, writeJsonFile } from './state-loaders.js';
import {
  runVerificationBacktest,
  checkVerificationGates,
} from './deploy-verification.js';
import type { ScoringConfig, ArchetypeConfig } from './health-types.js';
import type {
  DeployCandidate,
  DeployTickResult,
  DeployTickerDeps,
} from './deploy-types.js';

const logger = pino({ name: 'deploy-actions' });

export { fetchRegimes };

// ─── State Loaders (deploy-specific files) ──────────────────────────

export function loadPortfolio(): any | null {
  const groupDir = findGroupDir();
  if (!groupDir) return null;
  return readJsonFile(path.join(groupDir, 'auto-mode', 'portfolio.json'));
}

export function loadTriageMatrix(): any | null {
  const groupDir = findGroupDir();
  if (!groupDir) return null;
  return readJsonFile(path.join(groupDir, 'reports', 'triage-matrix.json'));
}

export function loadGapReport(): any | null {
  const groupDir = findGroupDir();
  if (!groupDir) return null;
  return readJsonFile(path.join(groupDir, 'reports', 'gap-report.json'));
}

export function loadCompetitionState(): any | null {
  const groupDir = findGroupDir();
  if (!groupDir) return null;
  return readJsonFile(
    path.join(groupDir, 'auto-mode', 'competition-state.json'),
  );
}

export function loadCandidateQueue(): any[] {
  const groupDir = findGroupDir();
  if (!groupDir) return [];
  const filePath = path.join(groupDir, 'auto-mode', 'candidate-queue.jsonl');
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    return lines
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function loadSeason(): any | null {
  const groupDir = findGroupDir();
  if (!groupDir) return null;
  return readJsonFile(path.join(groupDir, 'auto-mode', 'season.json'));
}

// ─── Guard Checks ───────────────────────────────────────────────────

export function checkCellGridStaleness(): { stale: boolean; ageHours: number } {
  const groupDir = findGroupDir();
  if (!groupDir) return { stale: true, ageHours: Infinity };
  const filePath = path.join(groupDir, 'reports', 'cell-grid-latest.json');
  try {
    const stat = fs.statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageHours = ageMs / (1000 * 60 * 60);
    return { stale: ageHours > 8, ageHours };
  } catch {
    return { stale: true, ageHours: Infinity };
  }
}

// ─── Slot Counting ──────────────────────────────────────────────────

export function countSlots(
  deployments: any[],
  config: ScoringConfig,
): { graduated: number; trials: number; total: number; trial_room: number } {
  const graduated = deployments.filter(
    (d) => d.slot_state === 'graduated' && d.state !== 'retired',
  ).length;
  const trials = deployments.filter(
    (d) => d.slot_state === 'trial' && d.state !== 'retired',
  ).length;
  const total = graduated + trials;
  const maxTotal = config.SLOT_MANAGEMENT.max_total_bots;
  const maxTrials = config.SLOT_MANAGEMENT.max_trial_bots;
  const empty = maxTotal - total;
  const trial_room = Math.min(empty, maxTrials - trials);

  return { graduated, trials, total, trial_room: Math.max(0, trial_room) };
}

export function countByGroup(deployments: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of deployments) {
    if (d.state === 'retired') continue;
    const group = d.correlation_group ?? 'unknown';
    counts[group] = (counts[group] ?? 0) + 1;
  }
  return counts;
}

// ─── Volume-Weighted Stake ──────────────────────────────────────────

export function computeEffectiveStake(
  volumeWeight: number,
  allVolumeWeights: number[],
  basePct: number,
  floorMultiplier: number,
  ceilingMultiplier: number,
): number {
  const avgVw =
    allVolumeWeights.length > 0
      ? allVolumeWeights.reduce((a, b) => a + b, 0) / allVolumeWeights.length
      : 0.65;
  const raw = basePct * (volumeWeight / (avgVw || 0.65));
  const floor = basePct * floorMultiplier;
  const ceiling = basePct * ceilingMultiplier;
  return Math.max(floor, Math.min(ceiling, raw));
}

// ─── Campaign & Deployment Records ─────────────────────────────────

export function createCampaignRecord(
  candidate: DeployCandidate,
  deploymentId: string,
  trialDeadline: string,
  effectiveStake: number,
  volumeWeight: number,
): any {
  return {
    id: `campaign-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    strategy: candidate.strategy,
    pair: candidate.pair,
    timeframe: candidate.timeframe,
    archetype: candidate.archetype,
    correlation_group: candidate.correlation_group,
    state: 'paper_trading',
    slot_state: 'trial',
    source: candidate.source,
    candidate_quality: candidate.quality,
    eviction_priority: 100,
    eviction_factors: ['trial_base:100'],
    graduated_at: null,
    evicted_at: null,
    eviction_reason: null,
    paper_trading: {
      bot_deployment_id: deploymentId,
      deployed_at: new Date().toISOString(),
      validation_deadline: trialDeadline,
      trial_deadline: trialDeadline,
      effective_stake_pct: effectiveStake,
      volume_weight: volumeWeight,
      base_stake_pct: 5,
      current_pnl_pct: 0,
      current_trade_count: 0,
      current_sharpe: 0,
      current_max_dd: 0,
      current_win_rate: 0,
      current_avg_win_pct: 0,
      current_avg_loss_pct: 0,
      max_consecutive_losses: 0,
      ticks_signals_on: 0,
      ticks_signals_off: 0,
      extended: false,
      regime_extension: false,
      investigation_mode: false,
      investigation_reason: null,
      rr_extension: false,
      retire_reason: null,
    },
  };
}

export function createDeploymentRecord(
  candidate: DeployCandidate,
  deploymentId: string,
): any {
  const now = new Date().toISOString();
  return {
    deployment_id: deploymentId,
    strategy: candidate.strategy,
    archetype: candidate.archetype,
    pairs: [candidate.pair],
    timeframe: candidate.timeframe,
    slot_state: 'trial',
    state: 'active',
    correlation_group: candidate.correlation_group,
    source: candidate.source,
    candidate_quality: candidate.quality,
    staged_at: now,
    activated_at: now,
    graduated: null,
    wfo_sharpe: candidate.favorable_sharpe,
    total_pnl_pct: 0,
    trades_since_deploy: 0,
    state_history: [{ state: 'active', ts: now }],
  };
}

// ─── State File Writers ─────────────────────────────────────────────

export function writeCampaign(campaign: any): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;
  const filePath = path.join(groupDir, 'research-planner', 'campaigns.json');
  const data = readJsonFile(filePath) ?? { campaigns: [] };
  if (!data.campaigns) data.campaigns = [];
  data.campaigns.push(campaign);
  writeJsonFile(filePath, data);
}

export function writeDeployment(deployment: any): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;
  const filePath = path.join(groupDir, 'auto-mode', 'deployments.json');
  const data = readJsonFile(filePath) ?? { deployments: [] };
  if (!data.deployments) data.deployments = [];

  // Update existing or add new
  const idx = data.deployments.findIndex(
    (d: any) => d.deployment_id === deployment.deployment_id,
  );
  if (idx >= 0) {
    data.deployments[idx] = { ...data.deployments[idx], ...deployment };
  } else {
    data.deployments.push(deployment);
  }
  writeJsonFile(filePath, data);
}

export function updateRosterStatus(
  strategy: string,
  pair: string,
  newStatus: string,
): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;
  const filePath = path.join(groupDir, 'auto-mode', 'roster.json');
  const data = readJsonFile(filePath);
  if (!data) return;

  const entries = data.roster ?? (Array.isArray(data) ? data : []);
  for (const r of entries) {
    const name = r.strategy_name ?? r.strategy;
    if (name !== strategy) continue;

    // Nested cells
    if (Array.isArray(r.cells)) {
      for (const cell of r.cells) {
        if (cell.pair === pair && cell.status === 'pending_deploy') {
          cell.status = newStatus;
        }
      }
    }
    // Flat structure
    if (r.pair === pair && r.status === 'pending_deploy') {
      r.status = newStatus;
    }
  }

  writeJsonFile(filePath, data);
}

export function allocateSeasonCapital(
  deploymentId: string,
  candidate: DeployCandidate,
  trialRoom: number,
): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;
  const filePath = path.join(groupDir, 'auto-mode', 'season.json');
  const season = readJsonFile(filePath);
  if (!season?.status || season.status !== 'active') return;
  if (!season.capital_allocation) return;

  const remaining = season.capital_allocation.remaining_usdt ?? 0;
  const total = season.capital_allocation.total_usdt ?? 0;
  if (remaining <= 0 || total <= 0) return;

  let allocated = Math.min(
    remaining / Math.max(trialRoom + 1, 1),
    total * 0.2,
  );
  allocated = Math.max(allocated, total * 0.05);
  allocated = Math.min(allocated, remaining);

  season.capital_allocation.allocated_usdt =
    (season.capital_allocation.allocated_usdt ?? 0) + allocated;
  season.capital_allocation.remaining_usdt = remaining - allocated;

  if (!season.capital_allocation.deployments) {
    season.capital_allocation.deployments = [];
  }
  season.capital_allocation.deployments.push({
    deployment_id: deploymentId,
    strategy: candidate.strategy,
    pair: candidate.pair,
    timeframe: candidate.timeframe,
    allocated_usdt: allocated,
    deployed_at: new Date().toISOString(),
    retired_at: null,
  });

  writeJsonFile(filePath, season);
  logger.info(
    {
      deploymentId,
      allocated: allocated.toFixed(0),
      remaining: (remaining - allocated).toFixed(0),
    },
    'Season capital allocated',
  );
}

export function markCompetitionCandidateDeployed(candidateId: string): void {
  const groupDir = findGroupDir();
  if (!groupDir) return;
  const filePath = path.join(groupDir, 'auto-mode', 'candidate-queue.jsonl');
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    const updated = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line);
        if (entry.id === candidateId) {
          entry.status = 'deployed';
        }
        return JSON.stringify(entry);
      } catch {
        return line;
      }
    });
    fs.writeFileSync(filePath, updated.join('\n') + '\n');
  } catch {
    /* ignore */
  }
}

// ─── Composite Executors ────────────────────────────────────────────

export async function executeDeployment(
  deps: DeployTickerDeps,
  candidate: DeployCandidate,
  config: ScoringConfig,
  archetypes: Record<string, ArchetypeConfig>,
  groupFolderName: string,
  cellGrid: any,
  trialRoom: number,
): Promise<boolean> {
  const archetype = archetypes[candidate.archetype];
  if (!archetype) {
    logger.warn({ candidate: candidate.strategy }, 'Unknown archetype');
    return false;
  }

  // Generate deployment ID
  const deploymentId = `${candidate.strategy.toLowerCase().replace(/[^a-z0-9]/g, '')}-${candidate.pair.split('/')[0].toLowerCase()}-${candidate.timeframe}`;

  // Compute trial deadline
  const deadlineDays =
    config.SLOT_MANAGEMENT.trial_deadlines_days[candidate.timeframe] ?? 7;
  const deadline = new Date(
    Date.now() + deadlineDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Compute volume-weighted stake
  const cellEntry = cellGrid?.cells?.find(
    (c: any) =>
      c.archetype === candidate.archetype && c.pair === candidate.pair,
  );
  const vw = cellEntry?.volume_weight ?? 0.65;
  const allVw = (cellGrid?.cells ?? [])
    .filter((c: any) => c.deployed_strategy)
    .map((c: any) => c.volume_weight ?? 0.65);
  const vwStakeConfig = (config as any).VOLUME_WEIGHTED_STAKE ?? {};
  const effectiveStake = computeEffectiveStake(
    vw,
    allVw,
    5,
    vwStakeConfig.floor_multiplier ?? 0.4,
    vwStakeConfig.ceiling_multiplier ?? 1.5,
  );

  // Start bot container
  try {
    const bot = await deps.startBotContainer({
      type: 'start_bot',
      deployment_id: deploymentId,
      strategy_name: candidate.strategy,
      pair: candidate.pair,
      timeframe: candidate.timeframe,
      group_folder: groupFolderName,
      dry_run: true,
    });

    // Write campaign record
    const campaign = createCampaignRecord(
      candidate,
      deploymentId,
      deadline,
      effectiveStake,
      vw,
    );
    writeCampaign(campaign);

    // Write deployment record
    const deployment = createDeploymentRecord(candidate, deploymentId);
    writeDeployment(deployment);

    // Update roster status
    updateRosterStatus(candidate.strategy, candidate.pair, 'paper_trading');

    // Season capital allocation
    allocateSeasonCapital(deploymentId, candidate, trialRoom);

    // Competition queue update
    if (candidate.source === 'competition_queue') {
      markCompetitionCandidateDeployed(
        `cq_${candidate.strategy}_${candidate.pair}`,
      );
    }

    // Send message
    const msg = `DEPLOYED TRIAL: ${candidate.strategy} on ${candidate.pair}/${candidate.timeframe} — source=${candidate.source}, score=${(candidate.ranked_score ?? 0).toFixed(1)}, deadline=${deadline.split('T')[0]}, stake=${effectiveStake.toFixed(1)}% (vw=${vw.toFixed(2)})`;
    try {
      await deps.sendMessage(deps.chatJid, msg);
    } catch {
      /* ignore message failures */
    }

    // Audit trail
    await recordAphexdataEvent({
      verb_id: 'slot_trial_deployed',
      verb_category: 'execution',
      object_type: 'deployment',
      object_id: deploymentId,
      result_data: {
        strategy: candidate.strategy,
        pair: candidate.pair,
        timeframe: candidate.timeframe,
        archetype: candidate.archetype,
        source: candidate.source,
        gap_score: candidate.gap_score,
        trial_deadline: deadline,
        group: candidate.correlation_group,
      },
    });

    logger.info(
      {
        deploymentId,
        strategy: candidate.strategy,
        pair: candidate.pair,
        source: candidate.source,
      },
      'Trial deployed',
    );
    return true;
  } catch (err) {
    logger.error(
      { err, strategy: candidate.strategy, pair: candidate.pair },
      'Failed to deploy trial',
    );
    try {
      await deps.sendMessage(
        deps.chatJid,
        `Slot fill failed: ${candidate.strategy} on ${candidate.pair} — ${(err as Error).message}`,
      );
    } catch {
      /* ignore */
    }
    return false;
  }
}

export async function executeReplacement(
  deps: DeployTickerDeps,
  incumbent: any,
  candidate: DeployCandidate,
  config: ScoringConfig,
  archetypes: Record<string, ArchetypeConfig>,
  groupFolderName: string,
  cellGrid: any,
): Promise<boolean> {
  const incumbentId = incumbent.deployment_id;
  const sharpeImprovement =
    (candidate.favorable_sharpe ?? 0) - (incumbent.live_sharpe ?? 0);

  try {
    // Retire incumbent
    await deps.stopBotContainer(incumbentId);

    // Update incumbent in campaigns and deployments
    const groupDir = findGroupDir();
    if (groupDir) {
      // Update campaigns
      const campPath = path.join(
        groupDir,
        'research-planner',
        'campaigns.json',
      );
      const campData = readJsonFile(campPath);
      if (campData?.campaigns) {
        for (const c of campData.campaigns) {
          if (
            c.paper_trading?.bot_deployment_id === incumbentId ||
            c.id === incumbentId
          ) {
            c.state = 'retired';
            c.retire_reason = 'replaced_by_better';
            c.retired_at = new Date().toISOString();
          }
        }
        writeJsonFile(campPath, campData);
      }

      // Update deployments
      const depPath = path.join(
        groupDir,
        'auto-mode',
        'deployments.json',
      );
      const depData = readJsonFile(depPath);
      if (depData?.deployments) {
        for (const d of depData.deployments) {
          if (d.deployment_id === incumbentId) {
            d.state = 'retired';
            d.retired_reason = 'replaced_by_better';
          }
        }
        writeJsonFile(depPath, depData);
      }
    }

    const msg = `REPLACED: ${incumbent.strategy} (Sharpe ${(incumbent.live_sharpe ?? 0).toFixed(2)}, prio ${incumbent.eviction_priority}) with ${candidate.strategy} (Sharpe ${(candidate.favorable_sharpe ?? 0).toFixed(2)}, +${sharpeImprovement.toFixed(2)})`;
    try {
      await deps.sendMessage(deps.chatJid, msg);
    } catch {
      /* ignore */
    }

    await recordAphexdataEvent({
      verb_id: 'slot_graduated_replaced',
      verb_category: 'execution',
      object_type: 'deployment',
      object_id: incumbentId,
      result_data: {
        old_strategy: incumbent.strategy,
        new_strategy: candidate.strategy,
        sharpe_improvement: sharpeImprovement,
      },
    });

    // Deploy replacement as fresh trial
    return await executeDeployment(
      deps,
      candidate,
      config,
      archetypes,
      groupFolderName,
      cellGrid,
      1,
    );
  } catch (err) {
    logger.error(
      { err, incumbent: incumbentId, candidate: candidate.strategy },
      'Replacement failed',
    );
    return false;
  }
}

// ─── Tick Log ───────────────────────────────────────────────────────

export function writeDeployTickLog(result: DeployTickResult): void {
  const logDir = path.join(DATA_DIR, 'monitor-deploy');
  fs.mkdirSync(logDir, { recursive: true });

  const entry = {
    ts: new Date().toISOString(),
    skill: 'monitor-deploy',
    step: 6,
    phase: 'complete',
    outcome: `deployed_${result.deployed}_verified_${result.verified}_replaced_${result.replaced}`,
    slot_summary: result.slot_summary,
    skipped_guard: result.skipped_guard,
  };

  // Append to tick-log.jsonl
  const groupDir = findGroupDir();
  if (groupDir) {
    const tickLogPath = path.join(groupDir, 'auto-mode', 'tick-log.jsonl');
    try {
      fs.appendFileSync(tickLogPath, JSON.stringify(entry) + '\n');
    } catch {
      /* ignore */
    }
  }

  // Write latest tick state
  writeJsonFile(path.join(logDir, 'latest-tick.json'), entry);
}

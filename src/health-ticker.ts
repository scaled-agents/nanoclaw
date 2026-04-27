/**
 * Health Ticker — deterministic host-side service replacing monitor-health LLM.
 * Runs every 15 minutes. Evaluates triggers, graduation gates, signal hysteresis.
 * Only triggers messaging/actions when state transitions occur.
 * Phase 2 of the deterministic health ticker plan.
 */

import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { DATA_DIR } from './config.js';
import { computeHealthSnapshot } from './health-snapshot.js';
import {
  evaluateAllTriggers,
  getFirstFiredTrigger,
} from './health-triggers.js';
import { evaluateGraduation } from './health-graduation.js';
import { computeSignalDecision } from './health-signal-gating.js';
import { reconcileState } from './health-reconcile.js';
import {
  fetchRegimes,
  applyReconcilePatches,
  executeRetirement,
  executeGraduation,
  executeSignalToggle,
  executePause,
  writeValidationExtension,
  updateSignalTicks,
  writeTickLog,
  stampTickCompletion,
} from './health-actions.js';
import {
  loadScoringConfig,
  loadArchetypeConfigs,
  loadCampaigns,
  loadDeployments,
  loadRoster,
  loadCellGrid,
  loadMarketPrior,
  loadTickId,
  saveTickId,
} from './state-loaders.js';
import type {
  HealthTickerDeps,
  ScoringConfig,
  ArchetypeConfig,
  TickResult,
  Transition,
  SignalChange,
  BotSnapshot,
} from './health-types.js';

const logger = pino({ name: 'health-ticker' });

const TICKER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const TICKER_DATA_DIR = path.join(DATA_DIR, 'monitor-health');

// ─── Cell Grid Composite Lookup ─────────────────────────────────────

function getCellComposite(
  cellGrid: any,
  archetype: string,
  pair: string,
): number {
  if (!cellGrid?.cells) return 0;
  // Find the cell matching this archetype + pair
  const cell = cellGrid.cells.find(
    (c: any) => c.archetype === archetype && c.pair === pair,
  );
  return cell?.composite ?? cell?.composite_score ?? 0;
}

// ─── Market Prior BOCPD Lookup ──────────────────────────────────────

function getBocpdData(
  marketPrior: any,
  pair: string,
): { changeProb: number | null; expectedRunLength: number | null } {
  if (!marketPrior?.regimes)
    return { changeProb: null, expectedRunLength: null };

  // Extract symbol from pair (e.g., "BTC/USDT" → "BTC")
  const symbol = pair.split('/')[0];
  const regimeData = marketPrior.regimes[symbol] ?? marketPrior.regimes[pair];
  if (!regimeData) return { changeProb: null, expectedRunLength: null };

  // Use H3_MEDIUM horizon by default
  const horizon = regimeData.H3_MEDIUM ?? regimeData;
  const transition = horizon?.transition;
  if (!transition) return { changeProb: null, expectedRunLength: null };

  return {
    changeProb: transition.change_prob ?? null,
    expectedRunLength: transition.expected_run_length ?? null,
  };
}

// ─── WFO Metrics Lookup ─────────────────────────────────────────────

function getWfoMetrics(
  campaign: any,
): { dsr?: number; pbo?: number; n_strategies_tried?: number } | null {
  const wfo = campaign?.wfo_metrics;
  if (!wfo) return null;
  return {
    dsr: wfo.dsr,
    pbo: wfo.pbo,
    n_strategies_tried: wfo.n_strategies_tried,
  };
}

// ─── Main Tick ──────────────────────────────────────────────────────

async function runTick(
  deps: HealthTickerDeps,
  config: ScoringConfig,
  archetypes: Record<string, ArchetypeConfig>,
): Promise<void> {
  const now = new Date();
  const tickId = loadTickId();

  logger.info({ tickId }, 'Health tick starting');

  // a. READ STATE
  const snapshot = computeHealthSnapshot();
  if (!snapshot || snapshot.bots.length === 0) {
    logger.info({ tickId }, 'No active bots — clean tick');
    saveTickId(tickId);
    return;
  }

  const campaigns = loadCampaigns();
  const deployments = loadDeployments();
  const roster = loadRoster();
  const cellGrid = loadCellGrid();
  const marketPrior = loadMarketPrior();

  // b. RECONCILE
  const { patches, orphans } = reconcileState(
    campaigns,
    deployments,
    roster,
    snapshot.bots,
  );
  if (patches.length > 0) {
    applyReconcilePatches(patches);
    logger.info(
      { patchCount: patches.length },
      'Applied reconciliation patches',
    );
  }
  if (orphans.length > 0) {
    logger.warn({ orphans }, 'Orphaned deployments detected');
  }

  // c. REFRESH REGIMES
  const symbols = [...new Set(snapshot.bots.map((b) => b.pair.split('/')[0]))];
  const regimes = await fetchRegimes(symbols);
  if (regimes.length > 0) {
    logger.debug({ regimeCount: regimes.length }, 'Regimes refreshed');
  }

  const transitions: Transition[] = [];
  const signalChanges: SignalChange[] = [];
  const escalations: string[] = [];

  for (const bot of snapshot.bots) {
    const archetype = archetypes[bot.archetype ?? ''];
    if (!archetype) {
      logger.warn(
        { strategy: bot.strategy, archetype: bot.archetype },
        'Unknown archetype',
      );
      continue;
    }

    // d. SIGNAL GATING
    const composite = getCellComposite(cellGrid, bot.archetype ?? '', bot.pair);
    const { changeProb, expectedRunLength } = getBocpdData(
      marketPrior,
      bot.pair,
    );

    const signalDecision = computeSignalDecision(
      bot.signals_active,
      composite,
      bot.consecutive_above,
      bot.consecutive_below,
      changeProb,
      expectedRunLength,
      bot.investigation_mode,
      config.SIGNAL_HYSTERESIS_TICKS,
    );

    // Update consecutive counters
    let newAbove = bot.consecutive_above;
    let newBelow = bot.consecutive_below;
    if (!bot.signals_active && composite >= 3.5) {
      newAbove++;
      newBelow = 0;
    } else if (!bot.signals_active) {
      newAbove = 0;
    } else if (bot.signals_active && composite < 3.5) {
      newBelow++;
      newAbove = 0;
    } else {
      newBelow = 0;
    }

    // Execute signal toggle if needed
    if (signalDecision.toggle !== 'none') {
      const enable = signalDecision.toggle === 'on';
      await executeSignalToggle(
        deps,
        bot,
        enable,
        signalDecision.ticks_required,
      );
      signalChanges.push({
        campaign_id: bot.campaign_id ?? bot.deployment_id,
        strategy: bot.strategy,
        toggled: signalDecision.toggle,
        ticks_required: signalDecision.ticks_required,
      });
      // Reset counters after toggle
      newAbove = 0;
      newBelow = 0;
    }

    // Update signal tick counters
    const currentSignals =
      signalDecision.toggle === 'on'
        ? true
        : signalDecision.toggle === 'off'
          ? false
          : bot.signals_active;
    updateSignalTicks(
      bot.campaign_id ?? bot.deployment_id,
      currentSignals,
      newAbove,
      newBelow,
    );

    // e. EVALUATE TRIGGERS
    const triggers = evaluateAllTriggers(bot, archetype, config, now);
    const firedTrigger = getFirstFiredTrigger(triggers);

    if (firedTrigger) {
      // Trigger H → evaluate graduation
      if (firedTrigger.id === 'H') {
        const campaign = campaigns.find(
          (c: any) =>
            c.id === bot.campaign_id ||
            c.paper_trading?.bot_deployment_id === bot.deployment_id,
        );
        const wfoMetrics = campaign ? getWfoMetrics(campaign) : null;

        const gradResult = evaluateGraduation(
          bot,
          archetype,
          config,
          now,
          wfoMetrics,
        );

        switch (gradResult.action) {
          case 'graduate': {
            const t = await executeGraduation(deps, bot, gradResult.reason);
            transitions.push(t);
            break;
          }
          case 'retire': {
            const t = await executeRetirement(
              deps,
              bot,
              gradResult.reason,
              'H',
            );
            transitions.push(t);
            break;
          }
          case 'extend': {
            const deadlineDays =
              config.SLOT_MANAGEMENT.trial_deadlines_days[bot.timeframe] ?? 7;
            const extensionDays = Math.ceil(deadlineDays * 0.5);
            writeValidationExtension(
              bot.campaign_id ?? bot.deployment_id,
              extensionDays,
              gradResult.reason,
              { extended: true },
            );
            const msg = `${bot.strategy} has ${bot.metrics.trade_count} trades at deadline. Extending by ${extensionDays} days.`;
            try {
              await deps.sendMessage(deps.chatJid, msg);
            } catch {
              /* ignore */
            }
            break;
          }
          case 'extend_regime': {
            const deadlineDays =
              config.SLOT_MANAGEMENT.trial_deadlines_days[bot.timeframe] ?? 7;
            writeValidationExtension(
              bot.campaign_id ?? bot.deployment_id,
              deadlineDays,
              gradResult.reason,
              { regime_extension: true },
            );
            const totalTicks = bot.ticks_signals_on + bot.ticks_signals_off;
            const blockedPct =
              totalTicks > 0
                ? ((bot.ticks_signals_off / totalTicks) * 100).toFixed(0)
                : '100';
            const msg = `${bot.strategy} was regime-blocked ${blockedPct}%. Resetting validation clock (+${deadlineDays} days).`;
            try {
              await deps.sendMessage(deps.chatJid, msg);
            } catch {
              /* ignore */
            }
            break;
          }
          case 'investigate_rr': {
            const deadlineDays =
              config.SLOT_MANAGEMENT.trial_deadlines_days[bot.timeframe] ?? 7;
            writeValidationExtension(
              bot.campaign_id ?? bot.deployment_id,
              deadlineDays,
              gradResult.reason,
              { rr_extension: true },
            );
            const msg = `${bot.strategy} passed trade count and Sharpe gates but R:R is inverted. Extending + routing to kata.`;
            try {
              await deps.sendMessage(deps.chatJid, msg);
            } catch {
              /* ignore */
            }
            break;
          }
          // 'none' = overfitting/execution block, do nothing
        }
      } else if (firedTrigger.action === 'retire') {
        const t = await executeRetirement(
          deps,
          bot,
          firedTrigger.reason,
          firedTrigger.id,
        );
        transitions.push(t);
      } else if (firedTrigger.action === 'pause') {
        await executePause(
          deps,
          bot,
          firedTrigger.reason,
          firedTrigger.obstacle ?? firedTrigger.reason,
        );
      } else if (firedTrigger.action === 'warn') {
        const msg = `WARNING: ${bot.strategy} on ${bot.pair}/${bot.timeframe} — ${firedTrigger.details ?? firedTrigger.reason}`;
        try {
          await deps.sendMessage(deps.chatJid, msg);
        } catch {
          /* ignore */
        }
      }

      continue; // Skip early graduation check for bots with fired triggers
    }

    // f. EARLY GRADUATION (only for trials without fired triggers)
    if (bot.slot_state === 'trial') {
      const campaign = campaigns.find(
        (c: any) =>
          c.id === bot.campaign_id ||
          c.paper_trading?.bot_deployment_id === bot.deployment_id,
      );
      const wfoMetrics = campaign ? getWfoMetrics(campaign) : null;
      const gradResult = evaluateGraduation(
        bot,
        archetype,
        config,
        now,
        wfoMetrics,
      );

      if (gradResult.action === 'graduate') {
        const t = await executeGraduation(deps, bot, gradResult.reason);
        transitions.push(t);
      }
    }
  }

  // g. ESCALATION CHECK
  if (transitions.filter((t) => t.to_state === 'retired').length > 2) {
    escalations.push('multiple_simultaneous_retirements');
  }
  if (
    snapshot.portfolio_win_rate != null &&
    snapshot.portfolio_win_rate < 0.3 &&
    snapshot.total_trade_count >= 10
  ) {
    escalations.push('portfolio_emergency_audit');
  }

  // h. BUILD SLOT SUMMARY
  const activeBots = snapshot.bots.filter(
    (b) =>
      !transitions.some(
        (t) =>
          t.campaign_id === (b.campaign_id ?? b.deployment_id) &&
          t.to_state === 'retired',
      ),
  );
  const byGroup: Record<string, number> = {};
  for (const b of activeBots) {
    const group = b.correlation_group ?? 'unknown';
    byGroup[group] = (byGroup[group] ?? 0) + 1;
  }

  const tickResult: TickResult = {
    tick_id: tickId,
    computed_at: now.toISOString(),
    has_transitions: transitions.length > 0 || signalChanges.length > 0,
    transitions,
    signal_changes: signalChanges,
    reconcile_patches: patches,
    escalations,
    slot_summary: {
      total: activeBots.length,
      trials: activeBots.filter((b) => b.slot_state === 'trial').length,
      graduated: activeBots.filter((b) => b.slot_state === 'graduated').length,
      by_group: byGroup,
    },
  };

  // i. LOG + STAMP
  writeTickLog(tickResult);
  saveTickId(tickId);
  stampTickCompletion();

  const verdict =
    transitions.length > 0
      ? transitions.some((t) => t.to_state.startsWith('graduated'))
        ? 'graduation'
        : 'retirement'
      : 'healthy';

  logger.info(
    {
      tickId,
      bots: snapshot.bots.length,
      transitions: transitions.length,
      signalChanges: signalChanges.length,
      patches: patches.length,
      verdict,
    },
    'Health tick complete',
  );

  if (escalations.length > 0) {
    logger.warn({ escalations }, 'Escalations detected — manual review needed');
    fs.mkdirSync(TICKER_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TICKER_DATA_DIR, 'escalation.json'),
      JSON.stringify(
        {
          tick_id: tickId,
          escalations,
          transitions,
          timestamp: now.toISOString(),
        },
        null,
        2,
      ),
    );
  }
}

// ─── Service Entry Point ────────────────────────────────────────────

let tickerTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthTicker(deps: HealthTickerDeps): void {
  const config = loadScoringConfig();
  if (!config) {
    logger.error('Cannot start health ticker — scoring config not found');
    return;
  }

  const archetypes = loadArchetypeConfigs();
  if (!archetypes) {
    logger.error('Cannot start health ticker — archetypes.yaml not found');
    return;
  }

  logger.info(
    {
      intervalMs: TICKER_INTERVAL_MS,
      archetypeCount: Object.keys(archetypes).length,
    },
    'Health ticker started',
  );

  // Run immediately
  runTick(deps, config, archetypes).catch((err) =>
    logger.error({ err }, 'Health tick failed'),
  );

  // Then every 15 minutes
  tickerTimer = setInterval(() => {
    runTick(deps, config, archetypes).catch((err) =>
      logger.error({ err }, 'Health tick failed'),
    );
  }, TICKER_INTERVAL_MS);
}

export function stopHealthTicker(): void {
  if (tickerTimer) {
    clearInterval(tickerTimer);
    tickerTimer = null;
    logger.info('Health ticker stopped');
  }
}

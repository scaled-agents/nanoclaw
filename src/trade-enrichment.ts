/**
 * Trade Enrichment — attribution fields for live paper trades.
 *
 * Finding 2 of the edge audit: stamp every trade with the context needed to
 * answer "why did this win/lose?" — not just "whether." Without this, the
 * downstream attribution loop (Finding 1 regime-conditional P&L, feature
 * causality, ensemble evaluation) has nothing to work with.
 *
 * What we enrich:
 *   - regime_at_entry   — market-prior regime at the moment the trade opened
 *   - regime_at_exit    — market-prior regime at the moment the trade closed
 *   - conviction_at_entry / composite_at_entry — regime strength at open
 *   - mae_pct           — Maximum Adverse Excursion (worst drawdown DURING the trade)
 *   - mfe_pct           — Maximum Favorable Excursion (best profit DURING the trade)
 *   - holding_minutes   — how long the position was held
 *   - archetype         — tagged from the deployment record
 *
 * Why a persistent store: the close-trade loop in bot-runner runs only when
 * trade_count increases (trade closed). At that point we already have
 * `regime_at_exit = marketPrior(now)` but we've lost the entry-time regime.
 * A tiny open-trade scanner stamps every freshly-seen open trade into
 * `trade-enrichment.json`; when the close arrives, we hydrate `regime_at_entry`
 * from that snapshot. Approximation for long holds: the first time we see a
 * trade, whether newly opened or mid-flight, we stamp it — so regime_at_entry
 * is accurate within one health-check tick of the actual open.
 *
 * Pure helpers + file-backed store. No external deps. Safe to call from the
 * health-check loop (failures never throw).
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ─── Paths ──────────────────────────────────────────────────────────

const BOT_RUNNER_DIR = path.join(DATA_DIR, 'bot-runner');
const ENRICHMENT_FILE = path.join(BOT_RUNNER_DIR, 'trade-enrichment.json');

// Per-deployment trade cap — drop oldest when exceeded. Keeps the store
// bounded without losing recent attribution signal.
const MAX_TRADES_PER_DEPLOYMENT = 200;

// ─── Types ──────────────────────────────────────────────────────────

/** Regime snapshot captured at a single point in time. */
export interface RegimeSnapshot {
  regime: string | null;
  conviction: number | null;
  composite: number | null;
  direction: string | null;
  recorded_at: string;
}

/**
 * Entry-time snapshot stored for a single trade. Captured the first time we
 * see the trade (either as a new open via the open-trade scanner, or as a
 * closed trade via the close-trade loop if the scanner missed it).
 */
export interface TradeEntryRecord extends RegimeSnapshot {
  trade_id: number | string;
  opened_at: string | null;
}

/**
 * Per-deployment slice of the enrichment store. Keyed by trade_id as string
 * (FreqTrade emits numeric trade IDs; we normalize to string for JSON safety).
 */
interface DeploymentEnrichment {
  trades: Record<string, TradeEntryRecord>;
}

interface EnrichmentStore {
  version: 1;
  deployments: Record<string, DeploymentEnrichment>;
}

/**
 * Fully enriched trade ready for attribution downstream. This is what we
 * write into `paper_pnl.enriched_trades` and what consumers (dashboards,
 * regime-conditional P&L, feature attribution) should read.
 */
export interface EnrichedTrade {
  trade_id: number | string;
  pair: string;
  is_short: boolean;
  opened_at: string | null;
  closed_at: string | null;
  open_rate: number;
  close_rate: number | null;
  profit_ratio: number | null;
  profit_pct: number | null;
  holding_minutes: number | null;
  exit_reason: string | null;

  // Attribution enrichment
  regime_at_entry: string | null;
  regime_at_exit: string | null;
  conviction_at_entry: number | null;
  composite_at_entry: number | null;
  mae_pct: number | null;
  mfe_pct: number | null;
  archetype: string | null;
  timeframe: string | null;

  // Execution realism (Finding 12) — estimated, not measured
  slippage_estimate_pct: number | null;
}

/**
 * Minimal FreqTrade trade shape we consume. FreqTrade's /trades and /status
 * endpoints return many more fields than this — we only type what we use.
 */
export interface FtTradeLike {
  trade_id?: number;
  pair?: string;
  is_short?: boolean;
  open_date?: string;
  close_date?: string | null;
  open_rate?: number;
  close_rate?: number | null;
  profit_ratio?: number;
  profit_pct?: number;
  max_rate?: number;
  min_rate?: number;
  trade_duration?: number;
  exit_reason?: string;
}

// ─── Store I/O ──────────────────────────────────────────────────────

function readStore(): EnrichmentStore {
  if (!fs.existsSync(ENRICHMENT_FILE)) {
    return { version: 1, deployments: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ENRICHMENT_FILE, 'utf-8'));
    if (raw && typeof raw === 'object' && raw.deployments) {
      return raw as EnrichmentStore;
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to read trade enrichment store — starting fresh',
    );
  }
  return { version: 1, deployments: {} };
}

function writeStore(store: EnrichmentStore): void {
  try {
    fs.mkdirSync(BOT_RUNNER_DIR, { recursive: true });
    const tmp = ENRICHMENT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, ENRICHMENT_FILE);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to write trade enrichment store',
    );
  }
}

// ─── Regime snapshot extraction ─────────────────────────────────────

/**
 * Pull a regime snapshot out of market-prior.json for a given pair.
 * Falls back to the deployment's last_regime fields when the pair has no
 * market-prior entry. Returns null fields on complete absence rather than
 * throwing — attribution is best-effort and must never break health checks.
 */
export function snapshotRegime(
  pair: string | null | undefined,
  marketPrior: any | null,
  deployment: any | null,
): RegimeSnapshot {
  const pairBase = (pair || '').split('/')[0];
  const regimeData =
    marketPrior?.regimes?.[pairBase]?.['H2_SHORT'] ||
    marketPrior?.regimes?.[pairBase]?.['H1_MICRO'] ||
    null;

  return {
    regime: regimeData?.regime || deployment?.last_regime || null,
    conviction:
      typeof regimeData?.conviction === 'number'
        ? regimeData.conviction
        : (deployment?.last_conviction ?? null),
    composite:
      typeof deployment?.last_composite === 'number'
        ? deployment.last_composite
        : null,
    direction: regimeData?.direction || null,
    recorded_at: new Date().toISOString(),
  };
}

// ─── MAE / MFE ──────────────────────────────────────────────────────

/**
 * Maximum Adverse Excursion as a signed percentage of open_rate.
 * For longs: how far price dropped below open_rate during the trade.
 * For shorts: how far price rose above open_rate.
 * Always reported as a negative number (worst drawdown). Returns null if
 * FreqTrade did not expose min_rate/max_rate (older versions or paper mode).
 */
export function computeMae(trade: FtTradeLike): number | null {
  if (
    typeof trade.open_rate !== 'number' ||
    trade.open_rate <= 0 ||
    typeof trade.min_rate !== 'number' ||
    typeof trade.max_rate !== 'number'
  ) {
    return null;
  }
  const adverse = trade.is_short
    ? (trade.max_rate - trade.open_rate) / trade.open_rate
    : (trade.min_rate - trade.open_rate) / trade.open_rate;
  // Clamp to non-positive (adverse by definition). A positive result means
  // the bot never went underwater — report 0 rather than a misleading +value.
  return Math.min(0, adverse) * 100;
}

/**
 * Maximum Favorable Excursion as a signed percentage of open_rate.
 * For longs: peak unrealized profit before close.
 * For shorts: peak unrealized profit (price dropped below open).
 * Always reported as a non-negative number. Returns null on missing data.
 */
export function computeMfe(trade: FtTradeLike): number | null {
  if (
    typeof trade.open_rate !== 'number' ||
    trade.open_rate <= 0 ||
    typeof trade.min_rate !== 'number' ||
    typeof trade.max_rate !== 'number'
  ) {
    return null;
  }
  const favorable = trade.is_short
    ? (trade.open_rate - trade.min_rate) / trade.open_rate
    : (trade.max_rate - trade.open_rate) / trade.open_rate;
  return Math.max(0, favorable) * 100;
}

/**
 * Estimate per-trade slippage from the deployment's volume_weight tier.
 *
 * Cannot measure actual signal-vs-fill — FreqTrade doesn't expose the
 * order-book top at signal dispatch. Uses volume_weight as a liquidity
 * proxy: high-liquidity pairs (BTC, ETH) have ~1 bps spread; mid-cap
 * pairs ~3 bps; low-volume pairs ~7 bps. Numbers are tunable in
 * scoring-config.json EXECUTION_GATES.estimated_slippage_bps.
 *
 * Returns null when volume_weight is unavailable so downstream gates
 * can record the gate as `met: null` rather than blocking spuriously.
 *
 * Replaceable: when order-book signal capture lands, swap the body of
 * this function for measured slippage. Every gate downstream stays the
 * same — the gate machinery is the durable artifact.
 */
export function computeSlippageEstimate(
  deployment: any | null,
  executionConfig: any | null = null,
): number | null {
  const vw = deployment?.volume_weight;
  if (typeof vw !== 'number') return null;

  const cfg = executionConfig ?? {
    estimated_slippage_bps: {
      high_liquidity: 1,
      medium_liquidity: 3,
      low_liquidity: 7,
    },
    volume_weight_thresholds: { high: 0.7, medium: 0.3 },
  };

  const bps =
    vw >= cfg.volume_weight_thresholds.high
      ? cfg.estimated_slippage_bps.high_liquidity
      : vw >= cfg.volume_weight_thresholds.medium
        ? cfg.estimated_slippage_bps.medium_liquidity
        : cfg.estimated_slippage_bps.low_liquidity;

  // bps → pct: 1 bps = 0.01%
  return bps / 100;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Stamp an open trade with the current regime context if we haven't seen it
 * before. Called by the open-trade scanner in bot-runner once per health
 * check. Idempotent — replaying the same trade is a no-op, preserving the
 * original entry-time snapshot.
 */
export function stampOpenTrade(
  deploymentId: string,
  trade: FtTradeLike,
  marketPrior: any | null,
  deployment: any | null,
): void {
  if (typeof trade.trade_id !== 'number') return;

  const store = readStore();
  const deploymentSlice = store.deployments[deploymentId] ?? { trades: {} };
  const key = String(trade.trade_id);

  if (deploymentSlice.trades[key]) return; // already stamped — preserve entry snapshot

  const snap = snapshotRegime(trade.pair, marketPrior, deployment);
  deploymentSlice.trades[key] = {
    trade_id: trade.trade_id,
    opened_at: trade.open_date ?? null,
    ...snap,
  };

  // Enforce cap — drop oldest entries by insertion order (JSON object key order).
  const keys = Object.keys(deploymentSlice.trades);
  if (keys.length > MAX_TRADES_PER_DEPLOYMENT) {
    const excess = keys.length - MAX_TRADES_PER_DEPLOYMENT;
    for (const oldKey of keys.slice(0, excess)) {
      delete deploymentSlice.trades[oldKey];
    }
  }

  store.deployments[deploymentId] = deploymentSlice;
  writeStore(store);
}

/**
 * Enrich a single FreqTrade trade object with attribution fields. Pure —
 * reads from the store but does not write. Use `stampOpenTrade` for writes.
 *
 * Order of regime_at_entry resolution:
 *   1. Stored snapshot from open-trade scanner (most accurate)
 *   2. Current market-prior (approximation; used if the scanner never saw it)
 *   3. deployment.last_regime (coarse fallback)
 */
export function enrichTrade(
  deploymentId: string,
  trade: FtTradeLike,
  marketPrior: any | null,
  deployment: any | null,
  archetype: string | null,
  timeframe: string | null,
): EnrichedTrade {
  const store = readStore();
  const stored =
    typeof trade.trade_id === 'number'
      ? store.deployments[deploymentId]?.trades[String(trade.trade_id)]
      : undefined;

  const exitSnap = snapshotRegime(trade.pair, marketPrior, deployment);
  const entrySnap: RegimeSnapshot = stored
    ? {
        regime: stored.regime,
        conviction: stored.conviction,
        composite: stored.composite,
        direction: stored.direction,
        recorded_at: stored.recorded_at,
      }
    : exitSnap;

  return {
    trade_id: trade.trade_id ?? '',
    pair: trade.pair ?? '',
    is_short: trade.is_short ?? false,
    opened_at: trade.open_date ?? null,
    closed_at: trade.close_date ?? null,
    open_rate: trade.open_rate ?? 0,
    close_rate: trade.close_rate ?? null,
    profit_ratio:
      typeof trade.profit_ratio === 'number' ? trade.profit_ratio : null,
    profit_pct: typeof trade.profit_pct === 'number' ? trade.profit_pct : null,
    holding_minutes:
      typeof trade.trade_duration === 'number' ? trade.trade_duration : null,
    exit_reason: trade.exit_reason ?? null,
    regime_at_entry: entrySnap.regime,
    regime_at_exit: exitSnap.regime,
    conviction_at_entry: entrySnap.conviction,
    composite_at_entry: entrySnap.composite,
    mae_pct: computeMae(trade),
    mfe_pct: computeMfe(trade),
    archetype,
    timeframe,
    slippage_estimate_pct: computeSlippageEstimate(deployment, null),
  };
}

/**
 * Enrich a list of FreqTrade trades in one pass. Convenience wrapper — does
 * a single read of the store instead of once per trade.
 */
export function enrichTrades(
  deploymentId: string,
  trades: FtTradeLike[],
  marketPrior: any | null,
  deployment: any | null,
  archetype: string | null,
  timeframe: string | null,
): EnrichedTrade[] {
  return trades.map((t) =>
    enrichTrade(deploymentId, t, marketPrior, deployment, archetype, timeframe),
  );
}

/**
 * Drop a deployment's entire slice from the store. Called on retirement to
 * keep the store from accumulating dead entries.
 */
export function dropDeployment(deploymentId: string): void {
  const store = readStore();
  if (store.deployments[deploymentId]) {
    delete store.deployments[deploymentId];
    writeStore(store);
  }
}

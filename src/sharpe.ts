/**
 * Sharpe ratio computation for live paper trading bots.
 *
 * TypeScript port of kata/lib/metrics.py:compute_sharpe_ratio() so live and
 * backtest figures stay numerically consistent.
 *
 * The backtest path passes DAILY returns into compute_sharpe_ratio and
 * annualizes with periods_per_year=365. This live path must do the same —
 * feeding per-trade returns into the same formula would over-annualize an
 * active strategy (a bot firing 10 trades in 2 days would yield an implied
 * "periods_per_year" of 1825 and a nonsense Sharpe in the 8-10 range).
 *
 * Pure utility — no I/O, no dependencies.
 */

/** Annualized Sharpe ratio from per-period returns (sample std dev, Bessel n-1). */
export function computeSharpe(
  returns: number[],
  periodsPerYear: number,
  riskFreeRate: number = 0,
): number {
  const n = returns.length;
  if (n < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const excess = mean - riskFreeRate / periodsPerYear;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = variance > 0 ? Math.sqrt(variance) : 0;
  if (std === 0) return 0;
  return (excess / std) * Math.sqrt(periodsPerYear);
}

/**
 * Bucket trades into a continuous daily return series.
 *
 * - Uses `close_date` when available, falling back to `open_date`.
 * - Sums each day's `profit_ratio` (additive approximation; fine for
 *   small per-trade returns and matches how kata builds daily_returns).
 * - Fills the span between first and last trade day with zero-return days
 *   so the std reflects real calendar-time variance, not just active days.
 */
function tradesToDailyReturns(
  trades: Array<{
    profit_ratio?: number;
    open_date?: string;
    close_date?: string | null;
  }>,
): number[] {
  const byDay = new Map<number, number>();
  for (const t of trades) {
    if (typeof t.profit_ratio !== 'number') continue;
    const dateStr = t.close_date || t.open_date;
    if (!dateStr) continue;
    const ts = Date.parse(dateStr);
    if (Number.isNaN(ts)) continue;
    // Floor to UTC day
    const day = Math.floor(ts / 86_400_000);
    byDay.set(day, (byDay.get(day) ?? 0) + t.profit_ratio);
  }
  if (byDay.size === 0) return [];

  const days = Array.from(byDay.keys());
  const minDay = Math.min(...days);
  const maxDay = Math.max(...days);

  const series: number[] = [];
  for (let d = minDay; d <= maxDay; d++) {
    series.push(byDay.get(d) ?? 0);
  }
  return series;
}

/**
 * Compute annualized Sharpe from a list of FreqTrade trade objects.
 *
 * Requires at least 3 calendar days of trading history with at least 2
 * non-zero days — below that, the sample is too small for the figure to
 * be statistically meaningful and we return 0 (shown as "—" in the UI).
 *
 * Result is clamped to [-10, 10] as a sanity cap.
 */
export function computeTradeSharpe(
  trades: Array<{
    profit_ratio?: number;
    open_date?: string;
    close_date?: string | null;
  }>,
): number {
  if (!trades || trades.length < 2) return 0;

  const dailyReturns = tradesToDailyReturns(trades);
  if (dailyReturns.length < 3) return 0;

  const nonZeroDays = dailyReturns.filter((r) => r !== 0).length;
  if (nonZeroDays < 2) return 0;

  const sharpe = computeSharpe(dailyReturns, 365);

  // Sanity clamp — anything outside [-10, 10] is almost certainly a
  // small-sample artifact, not a real edge.
  if (!Number.isFinite(sharpe)) return 0;
  if (sharpe > 10) return 10;
  if (sharpe < -10) return -10;
  return sharpe;
}

/**
 * Finding 1 — Regime-conditional P&L rollup.
 *
 * Aggregates Finding 2's per-trade enrichment into a `{regime: metrics}`
 * map so monitor, dashboard, and kata can reason about *where* a strategy
 * wins and loses instead of only the integrated Sharpe.
 *
 * Input: enriched trades with `regime_at_entry` set (null entries are
 * bucketed under `UNKNOWN` — expected during bot warm-up before the first
 * market-prior tick).
 *
 * Output keys are regimes (`EFFICIENT_TREND`, `COMPRESSION`, `CHAOS`,
 * `TRANQUIL`, `UNKNOWN`); per-regime metrics are:
 *   - `n_trades` — closed-trade count in this regime
 *   - `pnl_pct` — sum of profit_pct (cumulative, additive)
 *   - `win_rate` — wins / closed in this regime (0–100)
 *   - `sharpe` — annualized daily Sharpe computed on the regime's own
 *     daily-bucketed return series (reuses `computeTradeSharpe` so the
 *     numerical convention matches integrated Sharpe)
 *   - `avg_mae_pct` / `avg_mfe_pct` — mean of the MAE/MFE columns for
 *     closed trades; null when no trade in the regime had the field
 *   - `first_seen` / `last_seen` — ISO timestamps of the first and last
 *     closed trade in the regime (useful for freshness gates)
 *
 * Only closed trades contribute (unresolved `profit_ratio === null`
 * trades are ignored). Regimes with zero closed trades are omitted so
 * the output stays compact.
 */
export interface RegimeMetrics {
  n_trades: number;
  pnl_pct: number;
  win_rate: number;
  sharpe: number;
  avg_mae_pct: number | null;
  avg_mfe_pct: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

export type ByRegime = Record<string, RegimeMetrics>;

interface EnrichedTradeLike {
  profit_ratio?: number | null;
  profit_pct?: number | null;
  open_date?: string | null;
  close_date?: string | null;
  closed_at?: string | null;
  opened_at?: string | null;
  regime_at_entry?: string | null;
  mae_pct?: number | null;
  mfe_pct?: number | null;
  slippage_estimate_pct?: number | null;
  slippage_pct?: number | null;
  slippage_source?: 'measured' | 'estimate' | 'shortfall' | null;
}

export function computeByRegime(trades: EnrichedTradeLike[]): ByRegime {
  if (!trades || trades.length === 0) return {};

  const buckets = new Map<string, EnrichedTradeLike[]>();
  for (const t of trades) {
    // Only closed trades contribute — unresolved profit_ratio means the
    // trade is still open and has no attribution yet.
    if (t.profit_ratio == null) continue;
    const regime = t.regime_at_entry || 'UNKNOWN';
    const list = buckets.get(regime);
    if (list) list.push(t);
    else buckets.set(regime, [t]);
  }

  const result: ByRegime = {};
  for (const [regime, list] of buckets) {
    if (list.length === 0) continue;

    let pnlPct = 0;
    let wins = 0;
    let maeSum = 0;
    let maeN = 0;
    let mfeSum = 0;
    let mfeN = 0;
    let firstSeen: string | null = null;
    let lastSeen: string | null = null;

    // For Sharpe, reuse computeTradeSharpe on a synthetic trade list
    // with the minimum fields it needs (profit_ratio + a date).
    const sharpeInput: Array<{
      profit_ratio?: number;
      open_date?: string;
      close_date?: string | null;
    }> = [];

    for (const t of list) {
      const profitPct =
        typeof t.profit_pct === 'number'
          ? t.profit_pct
          : (t.profit_ratio ?? 0) * 100;
      pnlPct += profitPct;
      if ((t.profit_ratio ?? 0) > 0) wins += 1;

      if (typeof t.mae_pct === 'number') {
        maeSum += t.mae_pct;
        maeN += 1;
      }
      if (typeof t.mfe_pct === 'number') {
        mfeSum += t.mfe_pct;
        mfeN += 1;
      }

      const closeStr = t.close_date || t.closed_at || null;
      const openStr = t.open_date || t.opened_at || null;
      const stamp = closeStr || openStr;
      if (stamp) {
        if (!firstSeen || stamp < firstSeen) firstSeen = stamp;
        if (!lastSeen || stamp > lastSeen) lastSeen = stamp;
      }

      sharpeInput.push({
        profit_ratio: t.profit_ratio ?? 0,
        open_date: openStr ?? undefined,
        close_date: closeStr,
      });
    }

    const sharpe = computeTradeSharpe(sharpeInput);
    const winRate = (wins / list.length) * 100;

    result[regime] = {
      n_trades: list.length,
      pnl_pct: Number(pnlPct.toFixed(4)),
      win_rate: Number(winRate.toFixed(2)),
      sharpe: Number(sharpe.toFixed(4)),
      avg_mae_pct: maeN > 0 ? Number((maeSum / maeN).toFixed(4)) : null,
      avg_mfe_pct: mfeN > 0 ? Number((mfeSum / mfeN).toFixed(4)) : null,
      first_seen: firstSeen,
      last_seen: lastSeen,
    };
  }

  return result;
}

/**
 * Finding 12 — Execution drag rollup.
 *
 * Aggregates per-trade slippage estimates into a gate-ready metrics block
 * the monitor can read in O(1). Returns null when no trades carry slippage
 * estimates (legacy data, or deployment lacks volume_weight) so monitor
 * Steps 4 and 5 record the gate as `met: null` rather than blocking
 * spuriously.
 *
 * execution_quality:
 *   1.0 → slippage is negligible vs. trade P&L (ideal)
 *   0.0 → slippage eats the entire edge
 *   < 0 → clamped to 0; means avg_slippage > avg_abs_pnl
 *
 * Formula: 1 - (avg_slippage_per_trade / avg_abs_pnl_per_trade), clamped.
 *
 * v1 ships estimated slippage from volume_weight tier; when order-book
 * signal capture lands, only the estimator changes. This rollup and every
 * downstream gate stay the same.
 */
export interface ExecutionDrag {
  total_slippage_pct: number;
  avg_slippage_per_trade: number;
  slippage_as_pct_of_pnl: number;
  execution_quality: number;
  n_trades_with_slippage: number;
  n_measured: number;
  n_estimated: number;
  n_shortfall: number;
}

export function computeExecutionDrag(
  trades: EnrichedTradeLike[],
): ExecutionDrag | null {
  if (!trades || trades.length === 0) return null;

  // Read slippage_pct (new), fall back to slippage_estimate_pct (deprecated)
  const getSlip = (t: EnrichedTradeLike): number | null | undefined =>
    t.slippage_pct ?? t.slippage_estimate_pct;

  const tradesWithSlip = trades.filter(
    (t) =>
      typeof getSlip(t) === 'number' &&
      typeof t.profit_pct === 'number' &&
      t.profit_pct !== null,
  );
  if (tradesWithSlip.length === 0) return null;

  let nMeasured = 0;
  let nEstimated = 0;
  let nShortfall = 0;

  const totalSlip = tradesWithSlip.reduce((s, t) => {
    // Count sources
    const src = t.slippage_source;
    if (src === 'shortfall') nShortfall++;
    else if (src === 'measured') nMeasured++;
    else nEstimated++;
    return s + (getSlip(t) as number);
  }, 0);
  const avgSlip = totalSlip / tradesWithSlip.length;

  const totalAbsPnl = tradesWithSlip.reduce(
    (s, t) => s + Math.abs(t.profit_pct as number),
    0,
  );
  const avgAbsPnl = totalAbsPnl / tradesWithSlip.length;

  // slippage_as_pct_of_pnl: when there is no realized P&L at all, treat
  // it as worst-case (slippage is 100% of the (zero) edge).
  const slipAsPctOfPnl = totalAbsPnl > 0 ? totalSlip / totalAbsPnl : 1.0;

  // execution_quality: clamped to [0,1]. Negative would mean
  // avg_slippage > avg_abs_pnl, which is a complete edge collapse.
  const rawQuality = avgAbsPnl > 0 ? 1.0 - avgSlip / avgAbsPnl : 0.0;
  const executionQuality = Math.max(0.0, Math.min(1.0, rawQuality));

  return {
    total_slippage_pct: totalSlip,
    avg_slippage_per_trade: avgSlip,
    slippage_as_pct_of_pnl: slipAsPctOfPnl,
    execution_quality: executionQuality,
    n_trades_with_slippage: tradesWithSlip.length,
    n_measured: nMeasured,
    n_estimated: nEstimated,
    n_shortfall: nShortfall,
  };
}

/**
 * Build a daily cumulative equity curve from FreqTrade trade objects.
 *
 * Returns an array of {date, cumulative_pnl_pct} points, one per UTC day
 * from first to last trade day, where cumulative_pnl_pct is the running
 * sum of profit_ratio (in %) up to and including that day.
 *
 * Same additive convention as tradesToDailyReturns — fine for small
 * per-trade returns and matches how the kata builds equity curves.
 */
export function computeDailyEquityCurve(
  trades: Array<{
    profit_ratio?: number;
    open_date?: string;
    close_date?: string | null;
  }>,
): Array<{ date: string; cumulative_pnl_pct: number }> {
  const byDay = new Map<number, number>();
  for (const t of trades) {
    if (typeof t.profit_ratio !== 'number') continue;
    const dateStr = t.close_date || t.open_date;
    if (!dateStr) continue;
    const ts = Date.parse(dateStr);
    if (Number.isNaN(ts)) continue;
    const day = Math.floor(ts / 86_400_000);
    byDay.set(day, (byDay.get(day) ?? 0) + t.profit_ratio);
  }
  if (byDay.size === 0) return [];

  const days = Array.from(byDay.keys());
  const minDay = Math.min(...days);
  const maxDay = Math.max(...days);

  const series: Array<{ date: string; cumulative_pnl_pct: number }> = [];
  let cum = 0;
  for (let d = minDay; d <= maxDay; d++) {
    cum += byDay.get(d) ?? 0;
    const dateStr = new Date(d * 86_400_000).toISOString().slice(0, 10);
    series.push({ date: dateStr, cumulative_pnl_pct: cum * 100 });
  }
  return series;
}

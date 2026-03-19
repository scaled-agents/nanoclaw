import fs from 'fs';
import path from 'path';

/**
 * Parse a FreqTrade IStrategy Python file and extract key attributes
 * for creating a skeleton .sdna genome.
 *
 * Uses regex extraction — intentionally simple. Complex indicator logic
 * is captured as "custom" signal type with a reference back to the source.
 *
 * @param {string} pyContent - Python source code
 * @param {string} [fileName] - Original file name for reference
 * @returns {object} Extracted strategy attributes
 */
export function parseStrategyFile(pyContent, fileName = 'strategy.py') {
  const result = {
    className: null,
    timeframe: '4h',
    stoploss: -0.05,
    minimalRoi: { '0': 0.1 },
    trailingStop: false,
    trailingStopPositive: null,
    trailingStopPositiveOffset: 0,
    canShort: false,
    startupCandleCount: 30,
  };

  // Extract class name
  const classMatch = pyContent.match(/class\s+(\w+)\s*\(\s*IStrategy\s*\)/);
  if (classMatch) result.className = classMatch[1];

  // Extract timeframe
  const tfMatch = pyContent.match(/timeframe\s*=\s*["']([^"']+)["']/);
  if (tfMatch) result.timeframe = tfMatch[1];

  // Extract stoploss
  const slMatch = pyContent.match(/stoploss\s*=\s*(-?[\d.]+)/);
  if (slMatch) result.stoploss = parseFloat(slMatch[1]);

  // Extract minimal_roi (Python dict → JSON)
  const roiMatch = pyContent.match(/minimal_roi\s*=\s*(\{[^}]+\})/);
  if (roiMatch) {
    try {
      // Convert Python dict syntax to JSON (handle single quotes, True/False)
      const jsonStr = roiMatch[1]
        .replace(/'/g, '"')
        .replace(/True/g, 'true')
        .replace(/False/g, 'false');
      result.minimalRoi = JSON.parse(jsonStr);
    } catch {
      // Keep default if parsing fails
    }
  }

  // Extract trailing stop settings
  const tsMatch = pyContent.match(/trailing_stop\s*=\s*(True|False)/);
  if (tsMatch) result.trailingStop = tsMatch[1] === 'True';

  const tspMatch = pyContent.match(/trailing_stop_positive\s*=\s*([\d.]+)/);
  if (tspMatch) result.trailingStopPositive = parseFloat(tspMatch[1]);

  const tspoMatch = pyContent.match(
    /trailing_stop_positive_offset\s*=\s*([\d.]+)/,
  );
  if (tspoMatch)
    result.trailingStopPositiveOffset = parseFloat(tspoMatch[1]);

  // Extract can_short
  const shortMatch = pyContent.match(/can_short\s*=\s*(True|False)/);
  if (shortMatch) result.canShort = shortMatch[1] === 'True';

  // Extract startup_candle_count
  const sccMatch = pyContent.match(/startup_candle_count\s*=\s*(\d+)/);
  if (sccMatch) result.startupCandleCount = parseInt(sccMatch[1], 10);

  return result;
}

/**
 * Try to load a companion config JSON file next to the strategy .py file.
 * Looks for config_*.json or *.json in the same directory.
 *
 * @param {string} strategyPath - Path to the .py strategy file
 * @returns {object|null} Parsed config or null
 */
export function loadCompanionConfig(strategyPath) {
  const dir = path.dirname(strategyPath);
  const baseName = path.basename(strategyPath, '.py');

  // Try config_ClassName.json first, then any config_*.json
  const candidates = [
    path.join(dir, `config_${baseName}.json`),
    path.join(dir, `${baseName}_config.json`),
  ];

  // Also scan for any config*.json in the directory
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.startsWith('config') && f.endsWith('.json')) {
        candidates.push(path.join(dir, f));
      }
    }
  } catch {
    // Directory not readable
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return null;
}

/**
 * Build a skeleton .sdna genome body from parsed strategy attributes.
 *
 * @param {object} attrs - Output from parseStrategyFile()
 * @param {object|null} config - Companion config (from loadCompanionConfig)
 * @param {string} fileName - Original strategy filename for reference
 * @returns {object} Genome body (JSON section of .sdna file)
 */
export function buildSkeletonBody(attrs, config, fileName) {
  // Extract pairs from config if available
  let pairs = ['BTC/USDT'];
  let exchangeName = 'binance';
  let tradingMode = 'spot';
  let marginMode = '';

  if (config) {
    if (config.exchange?.pair_whitelist?.length) {
      pairs = config.exchange.pair_whitelist;
    }
    if (config.exchange?.name) {
      exchangeName = config.exchange.name;
    }
    if (config.trading_mode) {
      tradingMode = config.trading_mode;
    }
    if (config.margin_mode) {
      marginMode = config.margin_mode;
    }
  }

  // Compute take_profit from minimal_roi
  const roiKeys = Object.keys(attrs.minimalRoi || {}).sort(
    (a, b) => parseInt(a) - parseInt(b),
  );
  const takeProfit = roiKeys.length > 0 ? attrs.minimalRoi[roiKeys[0]] : 0.1;

  const body = {
    signals: {
      entry_long: {
        type: 'custom',
        expression: `# Imported from ${fileName} — review populate_entry_trend() for signal logic`,
      },
      exit_long: {
        type: 'custom',
        expression: `# Imported from ${fileName} — review populate_exit_trend() for signal logic`,
      },
    },
    regime_filter: {
      enabled: false,
      detector: 'sma_slope',
      params: {},
      allowed_regimes: [],
    },
    risk: {
      position_size: 100,
      stop_loss: Math.abs(attrs.stoploss),
      take_profit: takeProfit,
      max_drawdown: 0.25,
      max_open_trades: 3,
      trailing_stop: attrs.trailingStop,
    },
    pairs,
    timeframe: attrs.timeframe,
    informative_timeframes: [],
    exchange: {
      name: exchangeName,
      trading_mode: tradingMode,
      margin_mode: marginMode || undefined,
    },
  };

  // Add short signals if strategy supports shorting
  if (attrs.canShort) {
    body.signals.entry_short = {
      type: 'custom',
      expression: `# Imported from ${fileName} — review populate_entry_trend() for short signal logic`,
    };
    body.signals.exit_short = {
      type: 'custom',
      expression: `# Imported from ${fileName} — review populate_exit_trend() for short signal logic`,
    };
  }

  // Add trailing stop details to risk if enabled
  if (attrs.trailingStop && attrs.trailingStopPositive !== null) {
    body.risk.trailing_stop_positive = attrs.trailingStopPositive;
    body.risk.trailing_stop_positive_offset =
      attrs.trailingStopPositiveOffset;
  }

  return body;
}

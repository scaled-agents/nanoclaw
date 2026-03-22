/**
 * Compile a aphexDNA genome body into a FreqTrade IStrategy Python file.
 */

/**
 * Map indicator names to ta-lib/ta imports.
 */
const INDICATOR_MAP = {
  rsi: {
    import: 'ta.momentum.RSIIndicator',
    compute: (params) => `ta.momentum.RSIIndicator(close=dataframe['close'], window=${params.period || 14}).rsi()`,
    column: (params) => `rsi_${params.period || 14}`,
  },
  ema: {
    import: 'ta.trend.EMAIndicator',
    compute: (params) => `ta.trend.EMAIndicator(close=dataframe['close'], window=${params.period || 20}).ema_indicator()`,
    column: (params) => `ema_${params.period || 20}`,
  },
  sma: {
    import: 'ta.trend.SMAIndicator',
    compute: (params) => `ta.trend.SMAIndicator(close=dataframe['close'], window=${params.period || 20}).sma_indicator()`,
    column: (params) => `sma_${params.period || 20}`,
  },
  macd: {
    import: 'ta.trend.MACD',
    compute: (params) => `ta.trend.MACD(close=dataframe['close'], window_fast=${params.fast || 12}, window_slow=${params.slow || 26}, window_sign=${params.signal || 9})`,
    column: () => 'macd',
    multiColumn: true,
    columns: () => ({
      macd: '.macd()',
      macd_signal: '.macd_signal()',
      macd_hist: '.macd_diff()',
    }),
  },
  bbands: {
    import: 'ta.volatility.BollingerBands',
    compute: (params) => `ta.volatility.BollingerBands(close=dataframe['close'], window=${params.period || 20}, window_dev=${params.std || 2})`,
    multiColumn: true,
    columns: () => ({
      bb_upper: '.bollinger_hband()',
      bb_middle: '.bollinger_mavg()',
      bb_lower: '.bollinger_lband()',
    }),
  },
  atr: {
    import: 'ta.volatility.AverageTrueRange',
    compute: (params) => `ta.volatility.AverageTrueRange(high=dataframe['high'], low=dataframe['low'], close=dataframe['close'], window=${params.period || 14}).average_true_range()`,
    column: (params) => `atr_${params.period || 14}`,
  },
  adx: {
    import: 'ta.trend.ADXIndicator',
    compute: (params) => `ta.trend.ADXIndicator(high=dataframe['high'], low=dataframe['low'], close=dataframe['close'], window=${params.period || 14})`,
    multiColumn: true,
    columns: () => ({
      adx: '.adx()',
      plus_di: '.adx_pos()',
      minus_di: '.adx_neg()',
    }),
  },
  // --- TA-Lib indicators (added for drop-folder strategy coverage) ---
  willr: {
    import: 'ta.momentum.WilliamsRIndicator',
    compute: (params) => `ta.momentum.WilliamsRIndicator(high=dataframe['high'], low=dataframe['low'], close=dataframe['close'], lbp=${params.period || 14}).williams_r()`,
    column: () => 'willr',
  },
  tema: {
    extraImport: 'talib',
    compute: (params) => `talib.TEMA(dataframe['close'], timeperiod=${params.period || 21})`,
    column: (params) => `tema_${params.period || 21}`,
  },
  kama: {
    import: 'ta.momentum.KAMAIndicator',
    compute: (params) => `ta.momentum.KAMAIndicator(close=dataframe['close'], window=${params.period || 21}).kama()`,
    column: (params) => `kama_${params.period || 21}`,
  },
  cmo: {
    extraImport: 'talib',
    compute: (params) => `talib.CMO(dataframe['close'], timeperiod=${params.period || 14})`,
    column: () => 'cmo',
  },
  linearreg: {
    extraImport: 'talib',
    compute: (params) => `talib.LINEARREG(dataframe['close'], timeperiod=${params.period || 14})`,
    column: (params) => `linearreg_${params.period || 14}`,
  },
  plus_di: {
    import: 'ta.trend.ADXIndicator',
    compute: (params) => `ta.trend.ADXIndicator(high=dataframe['high'], low=dataframe['low'], close=dataframe['close'], window=${params.period || 14}).adx_pos()`,
    column: () => 'plus_di',
  },
  minus_di: {
    import: 'ta.trend.ADXIndicator',
    compute: (params) => `ta.trend.ADXIndicator(high=dataframe['high'], low=dataframe['low'], close=dataframe['close'], window=${params.period || 14}).adx_neg()`,
    column: () => 'minus_di',
  },
  stochf: {
    extraImport: 'talib',
    compute: (params) => `talib.STOCHF(dataframe['high'], dataframe['low'], dataframe['close'], fastk_period=${params.fastk_period || 14}, fastd_period=${params.fastd_period || 3})`,
    multiColumn: true,
    columns: () => ({ fastk: '[0]', fastd: '[1]' }),
  },
  stochrsi: {
    extraImport: 'talib',
    compute: (params) => `talib.STOCHRSI(dataframe['close'], timeperiod=${params.period || 14})`,
    multiColumn: true,
    columns: () => ({ stochrsi_k: '[0]', stochrsi_d: '[1]' }),
  },
  cci: {
    import: 'ta.trend.CCIIndicator',
    compute: (params) => `ta.trend.CCIIndicator(high=dataframe['high'], low=dataframe['low'], close=dataframe['close'], window=${params.period || 14}).cci()`,
    column: () => 'cci',
  },
  mfi: {
    import: 'ta.volume.MFIIndicator',
    compute: (params) => `ta.volume.MFIIndicator(high=dataframe['high'], low=dataframe['low'], close=dataframe['close'], volume=dataframe['volume'], window=${params.period || 14}).money_flow_index()`,
    column: () => 'mfi',
  },
  obv: {
    import: 'ta.volume.OnBalanceVolumeIndicator',
    compute: () => `ta.volume.OnBalanceVolumeIndicator(close=dataframe['close'], volume=dataframe['volume']).on_balance_volume()`,
    column: () => 'obv',
  },
  sar: {
    extraImport: 'talib',
    compute: () => `talib.SAR(dataframe['high'], dataframe['low'])`,
    column: () => 'sar',
  },
  // --- Non-TA-Lib indicators (pandas_ta, qtpylib, technical) ---
  cmf: {
    extraImport: 'pandas_ta',
    compute: (params) => `pta.cmf(dataframe['high'], dataframe['low'], dataframe['close'], dataframe['volume'], length=${params.length || 20})`,
    column: () => 'cmf',
  },
  vwap: {
    compute: () => `qtpylib.rolling_vwap(dataframe)`,
    column: () => 'vwap',
  },
  ao: {
    compute: () => `qtpylib.awesome_oscillator(dataframe)`,
    column: () => 'ao',
  },
  ichimoku: {
    extraImport: 'technical',
    compute: (params) => `ichimoku(dataframe, conversion_line_period=${params.conversion_line_period || 9}, base_line_periods=${params.base_line_periods || 26})`,
    multiColumn: true,
    columns: () => ({
      tenkan_sen: "['tenkan_sen']",
      kijun_sen: "['kijun_sen']",
      senkou_span_a: "['senkou_span_a']",
      senkou_span_b: "['senkou_span_b']",
    }),
  },
  rma: {
    extraImport: 'pandas_ta',
    compute: (params) => `pta.rma(dataframe['close'], length=${params.length || 13})`,
    column: (params) => `rma_${params.length || 13}`,
  },
};

/**
 * Convert a signal object to a Python condition string.
 * Also collects required indicators.
 */
function signalToCondition(signal, indicators) {
  if (!signal || signal === null) return null;

  switch (signal.type) {
    case 'threshold_cross': {
      const ind = signal.indicator;
      const params = signal.params || {};
      const col = INDICATOR_MAP[ind]?.column?.(params) || ind;
      indicators.add(JSON.stringify({ name: ind, params }));

      if (signal.condition === 'crosses_below') {
        return `(qtpylib.crossed_below(dataframe['${col}'], ${signal.value}))`;
      } else if (signal.condition === 'crosses_above') {
        return `(qtpylib.crossed_above(dataframe['${col}'], ${signal.value}))`;
      } else if (signal.condition === 'below') {
        return `(dataframe['${col}'] < ${signal.value})`;
      } else if (signal.condition === 'above') {
        return `(dataframe['${col}'] > ${signal.value})`;
      }
      return `(dataframe['${col}'] ${signal.condition || '<'} ${signal.value})`;
    }

    case 'indicator_cross': {
      const fastInd = signal.fast?.indicator || 'ema';
      const slowInd = signal.slow?.indicator || 'ema';
      const fastParams = signal.fast?.params || {};
      const slowParams = signal.slow?.params || {};
      const fastCol = INDICATOR_MAP[fastInd]?.column?.(fastParams) || fastInd;
      const slowCol = INDICATOR_MAP[slowInd]?.column?.(slowParams) || slowInd;

      indicators.add(JSON.stringify({ name: fastInd, params: fastParams }));
      indicators.add(JSON.stringify({ name: slowInd, params: slowParams }));

      if (signal.condition === 'crosses_above') {
        return `(qtpylib.crossed_above(dataframe['${fastCol}'], dataframe['${slowCol}']))`;
      } else if (signal.condition === 'crosses_below') {
        return `(qtpylib.crossed_below(dataframe['${fastCol}'], dataframe['${slowCol}']))`;
      }
      return `(dataframe['${fastCol}'] > dataframe['${slowCol}'])`;
    }

    case 'composite_and': {
      const conditions = (signal.conditions || [])
        .map(s => signalToCondition(s, indicators))
        .filter(Boolean);
      if (conditions.length === 0) return null;
      return `(${conditions.join(' &\n            ')})`;
    }

    case 'composite_or': {
      const conditions = (signal.conditions || [])
        .map(s => signalToCondition(s, indicators))
        .filter(Boolean);
      if (conditions.length === 0) return null;
      return `(${conditions.join(' |\n            ')})`;
    }

    case 'pattern': {
      return `(dataframe['${signal.pattern}'] > 0)`;
    }

    case 'custom': {
      return signal.expression || 'True';
    }

    default:
      return null;
  }
}

/**
 * Generate populate_indicators code and collect extra imports needed.
 */
function generateIndicators(indicatorSet) {
  const lines = [];
  const seen = new Set();
  const extraImports = new Set();

  for (const raw of indicatorSet) {
    const { name, params } = JSON.parse(raw);
    const mapping = INDICATOR_MAP[name];
    if (!mapping) continue;

    const key = `${name}_${JSON.stringify(params)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (mapping.extraImport) extraImports.add(mapping.extraImport);

    if (mapping.multiColumn) {
      const compute = mapping.compute(params);
      const columns = mapping.columns();
      const varName = `${name}_indicator`;
      lines.push(`        ${varName} = ${compute}`);
      for (const [col, accessor] of Object.entries(columns)) {
        lines.push(`        dataframe['${col}'] = ${varName}${accessor}`);
      }
    } else {
      const col = mapping.column(params);
      const compute = mapping.compute(params);
      lines.push(`        dataframe['${col}'] = ${compute}`);
    }
  }

  return { code: lines.join('\n'), extraImports };
}

/**
 * Convert a genome name to a valid Python class name.
 */
function toClassName(name) {
  return name
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Compile a genome into a FreqTrade IStrategy Python file.
 * @param {object} frontmatter - Parsed frontmatter
 * @param {object} body - Parsed JSON body
 * @returns {{ python: string, strategyName: string, config: object }}
 */
export function compileToFreqtrade(frontmatter, body) {
  const strategyName = toClassName(frontmatter.name || 'GeneratedStrategy');
  const indicators = new Set();

  // Build signal conditions
  const entryLong = signalToCondition(body.signals?.entry_long, indicators);
  const exitLong = signalToCondition(body.signals?.exit_long, indicators);
  const entryShort = signalToCondition(body.signals?.entry_short, indicators);
  const exitShort = signalToCondition(body.signals?.exit_short, indicators);

  // Regime filter
  let regimeCondition = null;
  if (body.regime_filter?.enabled && body.regime_filter?.detector) {
    const rf = body.regime_filter;
    const det = rf.detector;
    if (det === 'adx_regime') {
      const period = rf.params?.period || 14;
      const threshold = rf.params?.threshold || 25;
      indicators.add(JSON.stringify({ name: 'adx', params: { period } }));
      regimeCondition = `(dataframe['adx'] > ${threshold})`;
    }
    // Other regime types can be added here
  }

  // Generate indicators code
  const { code: indicatorsCode, extraImports } = generateIndicators(indicators);

  // Risk params
  const risk = body.risk || {};
  let stopLoss = 0.10;
  if (risk.stop_loss?.method === 'fixed_pct') {
    stopLoss = risk.stop_loss.params?.pct || 0.10;
  } else if (risk.stop_loss?.method === 'atr_multiple') {
    // ATR-based stop loss: use a reasonable default pct since ATR is dynamic
    stopLoss = 0.10;
    // Add ATR indicator for trailing stop
    const atrPeriod = risk.stop_loss.params?.period || 14;
    indicators.add(JSON.stringify({ name: 'atr', params: { period: atrPeriod } }));
  }
  let takeProfit = 0.20;
  if (risk.take_profit?.method === 'fixed_pct') {
    takeProfit = risk.take_profit.params?.pct || 0.20;
  } else if (risk.take_profit?.method === 'risk_reward') {
    takeProfit = stopLoss * (risk.take_profit.params?.ratio || 2.0);
  }
  const maxOpenTrades = risk.max_open_trades || 3;

  // Build entry conditions
  let entryLongCond = entryLong || 'False';
  if (regimeCondition) {
    entryLongCond = `${entryLongCond} &\n            ${regimeCondition}`;
  }

  let entryShortCond = entryShort || 'False';

  // Build conditional imports
  const extraImportLines = [];
  if (extraImports.has('talib')) extraImportLines.push('import talib');
  if (extraImports.has('pandas_ta')) extraImportLines.push('import pandas_ta as pta');
  if (extraImports.has('technical')) extraImportLines.push('from technical.indicators import ichimoku');
  const extraImportsBlock = extraImportLines.length > 0 ? '\n' + extraImportLines.join('\n') : '';

  const python = `# Auto-generated by sdna compile — do not edit manually
# Source genome: ${frontmatter.name || 'unknown'}
# Hash: ${frontmatter.hash || 'unknown'}
# Generated: ${new Date().toISOString()}

import numpy as np
import pandas as pd
import ta
from freqtrade.strategy import IStrategy, merge_informative_pair
from pandas import DataFrame
import freqtrade.vendor.qtpylib.indicators as qtpylib${extraImportsBlock}


class ${strategyName}(IStrategy):
    """
    ${frontmatter.description || 'Auto-generated strategy from aphexDNA genome.'}
    """

    INTERFACE_VERSION = 3

    # Timeframe
    timeframe = '${body.timeframe || '4h'}'

    # Risk parameters
    stoploss = -${stopLoss}
    minimal_roi = {
        "0": ${takeProfit}
    }

    # Trade limits
    max_open_trades = ${maxOpenTrades}

    # Trailing stop (disabled by default)
    trailing_stop = False

    # Startup candle count
    startup_candle_count = 50

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
${indicatorsCode || '        pass'}
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            ${entryLongCond},
            'enter_long'] = 1
${entryShortCond !== 'False' ? `
        dataframe.loc[
            ${entryShortCond},
            'enter_short'] = 1
` : ''}
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
${exitLong ? `        dataframe.loc[
            ${exitLong},
            'exit_long'] = 1
` : '        pass'}
${exitShort ? `
        dataframe.loc[
            ${exitShort},
            'exit_short'] = 1
` : ''}
        return dataframe
`;

  // Generate config.json
  const config = {
    trading_mode: body.exchange?.trading_mode || 'spot',
    margin_mode: body.exchange?.margin_mode || '',
    exchange: {
      name: body.exchange?.name || 'binance',
      pair_whitelist: body.pairs || ['BTC/USDT'],
    },
    stake_currency: 'USDT',
    stake_amount: risk.position_size?.amount_usdt || 100,
    max_open_trades: maxOpenTrades,
    dry_run: true,
  };

  return { python, strategyName, config };
}

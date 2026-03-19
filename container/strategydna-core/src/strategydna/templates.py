"""Built-in genome templates for `sdna init`.

Aligned with FreqHub template library: blank, rsi_basic, ema_crossover,
macd_regime, supertrend_filtered.
"""

from __future__ import annotations

from collections.abc import Callable

from strategydna.models import (
    CompositeAndSignal,
    CustomSignal,
    Exchange,
    Frontmatter,
    GenomeBody,
    GenomeDocument,
    IndicatorCrossSignal,
    PositionSize,
    RegimeFilter,
    RiskModel,
    SignalSet,
    StopLoss,
    TakeProfit,
    ThresholdCrossSignal,
)


def blank_template(name: str = "Untitled Strategy") -> GenomeDocument:
    """Minimal blank genome with no signals."""
    return GenomeDocument(
        frontmatter=Frontmatter(
            name=name,
            description="Blank strategy template",
            tags=["template"],
        ),
        body=GenomeBody(
            pairs=["BTC/USDT"],
            timeframe="4h",
        ),
    )


def rsi_basic_template() -> GenomeDocument:
    """RSI threshold strategy: buy when RSI oversold, sell when overbought."""
    return GenomeDocument(
        frontmatter=Frontmatter(
            name="rsi-basic",
            description="RSI threshold strategy with fixed risk management",
            tags=["rsi", "mean-reversion", "template"],
        ),
        body=GenomeBody(
            signals=SignalSet(
                entry_long=ThresholdCrossSignal(
                    indicator="rsi",
                    params={"period": 14},
                    condition="crosses_below",
                    value=30,
                ),
                exit_long=ThresholdCrossSignal(
                    indicator="rsi",
                    params={"period": 14},
                    condition="crosses_above",
                    value=70,
                ),
            ),
            regime_filter=RegimeFilter(),
            risk=RiskModel(
                position_size=PositionSize(method="fixed_stake", amount_usdt=100),
                stop_loss=StopLoss(method="fixed_pct", params={"pct": 0.05}),
                take_profit=TakeProfit(method="fixed_pct", params={"pct": 0.10}),
                max_drawdown=0.20,
                max_open_trades=3,
            ),
            pairs=["BTC/USDT"],
            timeframe="4h",
            exchange=Exchange(name="binance", trading_mode="spot"),
        ),
    )


def ema_crossover_template() -> GenomeDocument:
    """EMA crossover trend-following strategy."""
    return GenomeDocument(
        frontmatter=Frontmatter(
            name="ema-crossover",
            description="Exponential moving average crossover trend strategy",
            tags=["ema", "crossover", "trend-following", "template"],
        ),
        body=GenomeBody(
            signals=SignalSet(
                entry_long=IndicatorCrossSignal(
                    fast={"indicator": "ema", "params": {"period": 9}},
                    slow={"indicator": "ema", "params": {"period": 21}},
                    condition="crosses_above",
                ),
                exit_long=IndicatorCrossSignal(
                    fast={"indicator": "ema", "params": {"period": 9}},
                    slow={"indicator": "ema", "params": {"period": 21}},
                    condition="crosses_below",
                ),
            ),
            regime_filter=RegimeFilter(),
            risk=RiskModel(
                position_size=PositionSize(method="fixed_stake", amount_usdt=100),
                stop_loss=StopLoss(method="atr_multiple", params={"period": 14, "multiplier": 2.0}),
                take_profit=TakeProfit(method="risk_reward", params={"ratio": 2.0}),
                max_drawdown=0.15,
                max_open_trades=3,
            ),
            pairs=["BTC/USDT"],
            timeframe="4h",
            exchange=Exchange(name="binance", trading_mode="spot"),
        ),
    )


def macd_regime_template() -> GenomeDocument:
    """MACD momentum strategy with ADX regime filter."""
    return GenomeDocument(
        frontmatter=Frontmatter(
            name="macd-regime",
            description="MACD momentum strategy with ADX regime filter",
            tags=["macd", "momentum", "regime-filtered", "template"],
        ),
        body=GenomeBody(
            signals=SignalSet(
                entry_long=CompositeAndSignal(
                    conditions=[
                        ThresholdCrossSignal(
                            indicator="macd_hist",
                            params={"fast": 12, "slow": 26, "signal": 9},
                            condition="crosses_above",
                            value=0,
                        ),
                        ThresholdCrossSignal(
                            indicator="rsi",
                            params={"period": 14},
                            condition="below",
                            value=70,
                        ),
                    ],
                ),
                exit_long=ThresholdCrossSignal(
                    indicator="macd_hist",
                    params={"fast": 12, "slow": 26, "signal": 9},
                    condition="crosses_below",
                    value=0,
                ),
            ),
            regime_filter=RegimeFilter(
                enabled=True,
                detector="adx_regime",
                params={"period": 14, "threshold": 25},
                allowed_regimes=["trending"],
            ),
            risk=RiskModel(
                position_size=PositionSize(method="fixed_stake", amount_usdt=100),
                stop_loss=StopLoss(method="atr_multiple", params={"period": 14, "multiplier": 1.5}),
                take_profit=TakeProfit(method="risk_reward", params={"ratio": 2.5}),
                max_drawdown=0.15,
                max_open_trades=3,
            ),
            pairs=["BTC/USDT"],
            timeframe="4h",
            informative_timeframes=["1d"],
            exchange=Exchange(name="binance", trading_mode="spot"),
        ),
    )


def supertrend_filtered_template() -> GenomeDocument:
    """Supertrend trend-following with RSI confirmation."""
    return GenomeDocument(
        frontmatter=Frontmatter(
            name="supertrend-filtered",
            description="Supertrend trend-following with RSI confirmation",
            tags=["supertrend", "trend-following", "rsi-confirmation", "template"],
        ),
        body=GenomeBody(
            signals=SignalSet(
                entry_long=CompositeAndSignal(
                    conditions=[
                        CustomSignal(expression="dataframe['supertrend_direction'] == 1"),
                        ThresholdCrossSignal(
                            indicator="rsi",
                            params={"period": 14},
                            condition="below",
                            value=60,
                        ),
                    ],
                ),
                exit_long=CustomSignal(expression="dataframe['supertrend_direction'] == -1"),
                entry_short=CompositeAndSignal(
                    conditions=[
                        CustomSignal(expression="dataframe['supertrend_direction'] == -1"),
                        ThresholdCrossSignal(
                            indicator="rsi",
                            params={"period": 14},
                            condition="above",
                            value=40,
                        ),
                    ],
                ),
                exit_short=CustomSignal(expression="dataframe['supertrend_direction'] == 1"),
            ),
            regime_filter=RegimeFilter(),
            risk=RiskModel(
                position_size=PositionSize(method="fixed_stake", amount_usdt=100),
                stop_loss=StopLoss(method="atr_multiple", params={"period": 14, "multiplier": 3.0}),
                take_profit=TakeProfit(method="risk_reward", params={"ratio": 2.0}),
                max_drawdown=0.20,
                max_open_trades=3,
            ),
            pairs=["BTC/USDT"],
            timeframe="4h",
            exchange=Exchange(name="binance", trading_mode="futures", margin_mode="isolated"),
        ),
    )


TEMPLATES: dict[str, Callable[..., GenomeDocument]] = {
    "blank": blank_template,
    "rsi_basic": rsi_basic_template,
    "ema_crossover": ema_crossover_template,
    "macd_regime": macd_regime_template,
    "supertrend_filtered": supertrend_filtered_template,
}

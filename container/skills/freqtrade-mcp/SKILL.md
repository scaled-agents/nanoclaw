---
name: freqtrade-mcp
description: >
  Use this skill for anything related to Freqtrade: exploring the API, creating
  strategies, backtesting, hyperopt optimization, walk-forward analysis, data
  downloading, or controlling a live bot. Always use the freqtrade MCP tools
  rather than calling CLIs or APIs directly via Bash.
---

# Freqtrade — Complete Strategy Development Toolkit

50 tools covering the full **Discover → Create → Test → Optimize → Trade** lifecycle.

## Recommended Workflow

1. **Discover** — introspect methods, browse docs, understand the API
2. **Create** — generate strategies, write code, validate, detect issues
3. **Test** — download data, backtest, analyze results
4. **Optimize** — hyperopt parameters, walk-forward validation
5. **Trade** — monitor and control a live bot

## Introspection (10 tools)

| Tool | What it does |
|------|-------------|
| `freqtrade_list_strategy_methods` | List all IStrategy methods you can override |
| `freqtrade_get_method_signature` | Get signature, docstring, and return type for a method |
| `freqtrade_get_callback_info` | Understand callback parameters and lifecycle |
| `freqtrade_get_class_info` | Inspect any class in the freqtrade codebase |
| `freqtrade_list_enums` | List all enums in freqtrade.enums |
| `freqtrade_get_enum_values` | Get values for a specific enum |
| `freqtrade_search_codebase` | Search for classes/patterns in the codebase |
| `freqtrade_get_config_schema` | Get available config keys for a section |
| `freqtrade_get_dataframe_columns` | See what columns are in the DataFrame |
| `freqtrade_get_freqtrade_version` | Get installed freqtrade version |

## Documentation (3 tools)

| Tool | What it does |
|------|-------------|
| `freqtrade_list_docs` | List all available documentation pages |
| `freqtrade_search_docs` | Search docs for a keyword |
| `freqtrade_get_doc` | Read full content of a doc page |

## Strategy Management (9 tools)

| Tool | What it does |
|------|-------------|
| `freqtrade_create_strategy` | Generate strategy from template with indicators/conditions |
| `freqtrade_write_strategy_file` | Write full Python source as a strategy file |
| `freqtrade_read_strategy` | Read an existing strategy's source code |
| `freqtrade_list_strategy_files` | List all strategy files in the strategies dir |
| `freqtrade_validate_strategy` | Check syntax, required methods, attributes |
| `freqtrade_detect_strategy_issues` | Deep analysis: look-ahead bias, deprecated API, anti-patterns |
| `freqtrade_test_strategy_loads` | Verify strategy loads correctly in freqtrade |
| `freqtrade_delete_strategy` | Delete a strategy file |
| `freqtrade_create_config` | Generate a config file for backtesting |

## Data (6 tools)

| Tool | What it does |
|------|-------------|
| `freqtrade_download_data` | Download OHLCV historical data |
| `freqtrade_list_exchanges` | List supported exchanges |
| `freqtrade_list_timeframes` | List available timeframes for an exchange |
| `freqtrade_list_pairs` | List trading pairs on an exchange |
| `freqtrade_list_strategies` | List available strategies via CLI |
| `freqtrade_show_data_info` | Show info about downloaded data |

## Backtesting (4 tools)

| Tool | What it does |
|------|-------------|
| `freqtrade_run_backtest` | Run backtest with full parameter control |
| `freqtrade_show_backtest_results` | Display detailed backtest results |
| `freqtrade_backtest_analysis` | Analyze entry/exit reasons and timing |
| `freqtrade_compare_backtests` | Compare multiple backtest results side-by-side |

## Hyperopt (3 tools)

| Tool | What it does |
|------|-------------|
| `freqtrade_run_hyperopt` | Optimize parameters (ROI, stoploss, indicators) |
| `freqtrade_show_hyperopt_results` | Show best parameters found |
| `freqtrade_list_hyperopt_losses` | List available loss functions |

## Walk-Forward Analysis (2 tools)

| Tool | What it does |
|------|-------------|
| `freqtrade_plan_walk_forward` | Preview time window splits before running |
| `freqtrade_run_walk_forward` | Run full walk-forward (hyperopt + backtest per window) |

## Edge Analysis (1 tool)

| Tool | What it does |
|------|-------------|
| `freqtrade_run_edge` | Per-pair win rate, expectancy, risk/reward analysis |

## Live Trading (17 tools)

| Tool | What it does |
|------|-------------|
| `freqtrade_fetch_bot_status` | All open trades with unrealized P&L |
| `freqtrade_fetch_profit` | Cumulative P&L, win rate, trade count |
| `freqtrade_fetch_balance` | Wallet balances |
| `freqtrade_fetch_performance` | Per-pair profit stats |
| `freqtrade_fetch_market_data` | OHLCV candles for a pair |
| `freqtrade_fetch_trades` | Closed trade history |
| `freqtrade_fetch_config` | Running bot configuration |
| `freqtrade_fetch_whitelist` | Active trading pairs |
| `freqtrade_fetch_blacklist` | Excluded pairs |
| `freqtrade_fetch_locks` | Active pair locks |
| `freqtrade_place_trade` | Force-open a trade |
| `freqtrade_start_bot` | Resume trading |
| `freqtrade_stop_bot` | Pause new trades |
| `freqtrade_reload_config` | Reload config from disk |
| `freqtrade_add_blacklist` | Add pair to blacklist |
| `freqtrade_delete_blacklist` | Remove from blacklist |
| `freqtrade_delete_lock` | Delete a pair lock |

## Common Patterns

**Build a new strategy:**
1. `list_strategy_methods` → discover what you can override
2. `get_method_signature` on key methods → understand signatures
3. `create_strategy` or `write_strategy_file` → create the code
4. `validate_strategy` + `detect_strategy_issues` → catch bugs early
5. `download_data` → fetch historical data
6. `run_backtest` → test performance

**Optimize an existing strategy:**
1. `read_strategy` → read current code
2. `detect_strategy_issues` → find problems
3. `run_backtest` → baseline performance
4. `run_hyperopt` → optimize parameters
5. `run_walk_forward` → validate robustness

**File locations:**
- Strategies: `/workspace/group/user_data/strategies/`
- Downloaded data: `/workspace/group/user_data/data/`
- Configs: `/workspace/group/user_data/`
- These persist between container runs (per-group mount)

**Connection errors:**
- REST API tools need `FREQTRADE_API_URL`, `FREQTRADE_USERNAME`, `FREQTRADE_PASSWORD`
- CLI tools need `FREQTRADE_PATH` (default: `/usr/local/bin/freqtrade`)
- Doc tools need `FREQTRADE_DOCS_PATH` pointing to the freqtrade docs directory

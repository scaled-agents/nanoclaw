---
name: freqhub
description: >
  Use this skill to interact with the FreqHub published strategy registry: searching
  for community genomes, viewing leaderboards, exploring the lineage DAG frontier,
  and fetching genomes by ID. Also provides local genome operations (init, fork, diff,
  compile, verify, attest) via the `sdna` CLI. Use this for registry discovery — use
  the strategydna-mcp tools for the full attestation/registry lifecycle.
---

# FreqHub — Published Strategy Registry CLI

12 commands via the `sdna` CLI for the **Search → Fetch → Fork → Compile → Attest** workflow.

## When to Use FreqHub vs StrategyDNA MCP

| Task | Tool |
|------|------|
| Search the published community registry | `sdna search` (FreqHub) |
| Fetch a genome by ID from the registry | `sdna get` (FreqHub) |
| View the published leaderboard | `sdna leaderboard` (FreqHub) |
| Explore DAG frontier (best unexplored branches) | `sdna frontier` (FreqHub) |
| Create/fork/verify/compile genomes (full lifecycle) | strategydna MCP tools |
| Attest backtest results + register locally | strategydna MCP tools |

## Registry Discovery (4 commands)

These commands query the **published GitHub-hosted registry** (fetched from configured sources).

```bash
# Search genomes by text, tag, operator, timeframe, pair, or min Sharpe
sdna search "rsi" --tag momentum --min-sharpe 0.5 --json

# Fetch a genome by registry ID (returns .sdna content)
sdna get rsi-basic-btc --json   # JSON body only
sdna get rsi-basic-btc --full   # Full .sdna with attestation

# Leaderboard — ranked by walk-forward Sharpe
sdna leaderboard --top 20 --tier gold

# Frontier — most promising unexplored DAG branches to fork
sdna frontier --top 10
```

## Local Genome Operations (8 commands)

```bash
# List available templates
sdna templates

# Create a new genome from a template
sdna init -t rsi-basic -n "My RSI" -p "BTC/USDT:USDT" --timeframe 1h -o my_rsi.sdna

# Fork a genome with mutations (JSON dot-path keys)
sdna fork my_rsi.sdna -m '{"risk.stop_loss.params.pct": 0.03}' -n "Tight RSI" -o tight_rsi.sdna

# Semantic diff between two genomes (body-only)
sdna diff my_rsi.sdna tight_rsi.sdna --json

# Verify genome integrity (hash check)
sdna verify my_rsi.sdna --json

# Compile genome to FreqTrade IStrategy Python + config
sdna compile my_rsi.sdna -o strategies/

# Add attestation data to a genome
sdna attest my_rsi.sdna --sharpe 1.2 --win-rate 0.6 --max-drawdown 0.08

# Build registry.json from a content directory
sdna build content/ -o dist/
```

## .sdna Format

Genomes use YAML frontmatter + JSON body:

```
---
name: rsi-basic
description: RSI threshold strategy
tags: [rsi, mean-reversion]
hash: sha256:5f1259712eae5109
parent: null
operator: wolfclaw
---
{"signals":{"entry_long":{"type":"threshold_cross",...},...},"risk":{...},...}
```

- **Frontmatter** (YAML): metadata, hash, lineage — NOT included in hash
- **Body** (JSON): signals, risk, pairs, timeframe — this is what gets hashed
- **Hash**: `sha256:` + first 16 hex chars of SHA-256 of canonical JSON body

## Available Templates

| Template | Description |
|----------|-------------|
| `rsi-basic` | RSI threshold_cross with standard risk (default) |
| `ema-crossover` | EMA indicator_cross fast/slow crossover |
| `macd-regime` | MACD composite_and with ADX regime filter |
| `supertrend-filtered` | Supertrend custom signal with RSI confirmation |

## Configuration

Config lives at `~/.sdna/config.yaml`:

```yaml
sources:
  - name: community
    url: https://raw.githubusercontent.com/adaptiveX-gh/freqhub/main/dist
operator: wolfclaw
author: wolfclaw-agent-01
```

The CLI merges all configured sources when searching. Remote registries are cached locally at `~/.sdna/sources/<name>/registry.json`.

## Typical Agent Workflow

### Discover → Fork → Backtest

```
1. sdna search --tag momentum --min-sharpe 0.5   # Find good momentum strategies
2. sdna get <id> -o base.sdna                     # Fetch the best match
3. sdna fork base.sdna -m '{"risk.stop_loss.params.pct": 0.03}' -o child.sdna
4. sdna compile child.sdna -o strategies/          # Compile to FreqTrade
5. Use freqtrade tools to backtest the compiled strategy
6. Use strategydna MCP tools to attest and register results
```

### Explore Frontier

```
1. sdna frontier --top 5                          # Find unexplored high-potential branches
2. sdna get <frontier-id> -o frontier.sdna        # Fetch a frontier genome
3. sdna fork frontier.sdna -m '...' -o child.sdna # Fork with mutations
4. Compile, backtest, attest
```

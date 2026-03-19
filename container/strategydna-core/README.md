# StrategyDNA Core

A portable genome format for autonomous trading strategies.

*Fork a strategy. Verify its performance. Run it in sixty seconds.*

## What is this?

StrategyDNA defines a declarative, content-addressed JSON format (`.sdna`) for trading strategies. Strategies are described as data — not code — making them portable, diffable, and verifiable across any runtime.

## Install

```bash
pip install -e ".[dev]"
```

## CLI

```bash
# Create a new genome from a template
sdna init --template rsi_mean_reversion -o strategy.sdna

# Verify the content hash
sdna verify strategy.sdna

# Fork with mutations
sdna fork strategy.sdna -o child.sdna --set risk.stoploss=-0.08 --name "Tighter Stop"

# Compare two genomes
sdna diff strategy.sdna child.sdna
sdna diff strategy.sdna child.sdna --json-output
```

## Python API

```python
from strategydna import GenomeDocument, GenomeMeta, stamp, to_sdna, from_sdna, verify
from strategydna.models import StrategyArchetype

# Create a genome
doc = GenomeDocument(
    meta=GenomeMeta(
        name="My Strategy",
        archetype=StrategyArchetype.BREAKOUT,
    )
)

# Stamp (compute content hash) and serialize
content = to_sdna(doc)

# Parse and verify
restored = from_sdna(content)
assert verify(restored)
```

## License

MIT

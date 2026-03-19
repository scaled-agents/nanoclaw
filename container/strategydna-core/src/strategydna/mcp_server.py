"""FastMCP server exposing StrategyDNA operations as MCP tools."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from strategydna.canon import compute_hash, display_hash, from_sdna, stamp, to_sdna, verify
from strategydna.compiler import compile_config, compile_genome
from strategydna.diff import diff
from strategydna.lineage import set_parent
from strategydna.models import Frontmatter, GenomeBody, GenomeDocument
from strategydna.templates import TEMPLATES

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    FastMCP = None  # type: ignore[assignment,misc]

_ALLOWED_MUTATION_PREFIXES = (
    "risk.", "signals.", "regime_filter.", "pairs", "timeframe",
    "informative_timeframes", "exchange.",
)


def _validate_registry_path(path: str) -> Path:
    """Ensure registry path is relative and stays within cwd."""
    p = Path(path)
    if p.is_absolute():
        raise ValueError("Registry path must be relative")
    resolved = (Path.cwd() / p).resolve()
    if not str(resolved).startswith(str(Path.cwd().resolve())):
        raise ValueError("Registry path must not escape working directory")
    return p


def _create_server() -> Any:
    """Create and configure the FastMCP server with all tools."""
    if FastMCP is None:
        raise ImportError(
            "MCP support requires the 'mcp' package. "
            "Install with: pip install strategydna-core[mcp]"
        )

    mcp = FastMCP(
        "StrategyDNA",
        instructions=(
            "StrategyDNA MCP server for managing declarative trading strategy genomes. "
            "Genomes use the FreqHub .sdna format: YAML frontmatter + JSON body. "
            "Use these tools to create, verify, diff, fork, "
            "and compile genomes into executable FreqTrade strategies."
        ),
    )

    @mcp.tool()
    def sdna_init(template: str = "blank", name: str = "New Strategy") -> str:
        """Create a new .sdna genome from a template.

        Args:
            template: Template name (blank, rsi_basic, ema_crossover, etc.)
            name: Strategy name override
        """
        if template not in TEMPLATES:
            available = list(TEMPLATES.keys())
            return json.dumps({"error": f"Unknown template: {template}. Available: {available}"})

        template_fn = TEMPLATES[template]
        if template == "blank":
            doc = template_fn(name=name)
        else:
            doc = template_fn()
            if name != "New Strategy":
                new_fm = doc.frontmatter.model_copy(update={"name": name})
                doc = doc.model_copy(update={"frontmatter": new_fm})

        content = to_sdna(doc)
        stamped = stamp(doc)
        return json.dumps({
            "sdna": content,
            "hash": stamped.frontmatter.hash,
            "name": doc.frontmatter.name,
        })

    @mcp.tool()
    def sdna_verify(sdna_content: str) -> str:
        """Verify the content hash integrity of an .sdna genome.

        Args:
            sdna_content: The full content of the .sdna file (YAML frontmatter + JSON body)
        """
        try:
            doc = from_sdna(sdna_content)
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            return json.dumps({"valid": False, "error": f"Parse error: {e}"})

        if doc.frontmatter.hash is None:
            computed = display_hash(compute_hash(doc))
            return json.dumps({
                "valid": False, "error": "No hash present", "computed_hash": computed,
            })

        is_valid = verify(doc)
        result: dict[str, Any] = {"valid": is_valid, "hash": doc.frontmatter.hash}
        if not is_valid:
            result["computed_hash"] = display_hash(compute_hash(doc))
        return json.dumps(result)

    @mcp.tool()
    def sdna_diff(base_content: str, target_content: str) -> str:
        """Compute semantic diff between two .sdna genomes.

        Args:
            base_content: The full content of the base .sdna file
            target_content: The full content of the target .sdna file
        """
        try:
            base_doc = stamp(from_sdna(base_content))
            target_doc = stamp(from_sdna(target_content))
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            return json.dumps({"error": f"Parse error: {e}"})

        result = diff(base_doc, target_doc)
        return json.dumps(result.to_dict(), indent=2)

    @mcp.tool()
    def sdna_fork(
        sdna_content: str,
        name: str | None = None,
        mutations: dict[str, Any] | None = None,
    ) -> str:
        """Fork a genome with optional mutations, creating a new child genome.

        Args:
            sdna_content: The full content of the parent .sdna file
            name: Optional new name for the forked strategy
            mutations: Dict of dot-path mutations targeting body fields,
                       e.g. {"risk.stop_loss.params.pct": 0.08}
        """
        try:
            parent_doc = stamp(from_sdna(sdna_content))
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            return json.dumps({"error": f"Parse error: {e}"})

        # Build child from parent body + fresh frontmatter
        child_body_data = parent_doc.body.model_dump(mode="json")
        child_fm_data = parent_doc.frontmatter.model_dump(mode="json")
        child_fm_data["hash"] = None
        child_fm_data["parent"] = None

        if name:
            child_fm_data["name"] = name

        if mutations:
            for path_str, value in mutations.items():
                if not any(path_str.startswith(p) for p in _ALLOWED_MUTATION_PREFIXES):
                    return json.dumps({
                        "error": f"Mutation path {path_str!r} not allowed. "
                        f"Allowed prefixes: {list(_ALLOWED_MUTATION_PREFIXES)}",
                    })
                keys = path_str.split(".")
                current = child_body_data
                for key in keys[:-1]:
                    if key not in current:
                        current[key] = {}
                    current = current[key]
                current[keys[-1]] = value

        child_doc = GenomeDocument(
            frontmatter=Frontmatter.model_validate(child_fm_data),
            body=GenomeBody.model_validate(child_body_data),
        )
        child_doc = set_parent(child_doc, parent_doc)
        content = to_sdna(child_doc)

        return json.dumps({
            "sdna": content,
            "hash": child_doc.frontmatter.hash,
            "parent_hash": parent_doc.frontmatter.hash,
            "name": child_doc.frontmatter.name,
        })

    @mcp.tool()
    def sdna_compile(sdna_content: str) -> str:
        """Compile an .sdna genome to a FreqTrade IStrategy Python file.

        Args:
            sdna_content: The full content of the .sdna file
        """
        try:
            doc = stamp(from_sdna(sdna_content))
            source = compile_genome(doc)
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            return json.dumps({"error": f"Compilation error: {e}"})

        return json.dumps({
            "python_source": source,
            "genome_hash": doc.frontmatter.hash,
            "strategy_name": doc.frontmatter.name,
        })

    @mcp.tool()
    def sdna_compile_config(sdna_content: str) -> str:
        """Generate a FreqTrade config.json from an .sdna genome.

        Args:
            sdna_content: The full content of the .sdna file
        """
        try:
            doc = from_sdna(sdna_content)
            config = compile_config(doc)
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            return json.dumps({"error": f"Config generation error: {e}"})

        return json.dumps(config, indent=2)

    @mcp.tool()
    def sdna_inspect(sdna_content: str) -> str:
        """Parse and display genome metadata and structure summary.

        Args:
            sdna_content: The full content of the .sdna file
        """
        try:
            doc = from_sdna(sdna_content)
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            return json.dumps({"error": f"Parse error: {e}"})

        # Count signals
        signal_count = sum(
            1 for s in [
                doc.body.signals.entry_long,
                doc.body.signals.exit_long,
                doc.body.signals.entry_short,
                doc.body.signals.exit_short,
            ] if s is not None
        )

        return json.dumps({
            "name": doc.frontmatter.name,
            "description": doc.frontmatter.description,
            "tags": doc.frontmatter.tags,
            "hash": doc.frontmatter.hash,
            "parent": doc.frontmatter.parent,
            "timeframe": doc.body.timeframe,
            "exchange": doc.body.exchange.name,
            "trading_mode": doc.body.exchange.trading_mode,
            "pairs": doc.body.pairs,
            "signal_slots": signal_count,
            "has_regime_filter": doc.body.regime_filter.enabled,
            "risk_stop_loss": doc.body.risk.stop_loss.method,
            "risk_take_profit": doc.body.risk.take_profit.method,
            "attestation_status": doc.frontmatter.attestation.status,
        }, indent=2)

    @mcp.tool()
    def sdna_list_templates() -> str:
        """List available genome templates with descriptions."""
        templates_info = []
        for name, fn in TEMPLATES.items():
            doc = fn() if name != "blank" else fn(name="Example")
            templates_info.append({
                "name": name,
                "description": doc.frontmatter.description or "Minimal blank genome",
                "tags": doc.frontmatter.tags,
                "timeframe": doc.body.timeframe,
            })
        return json.dumps(templates_info, indent=2)

    @mcp.tool()
    def sdna_attest(
        sdna_content: str, backtest_result: str, attested_by: str = ""
    ) -> str:
        """Create an attestation from a genome and FreqTrade backtest result.

        Args:
            sdna_content: The full content of the .sdna genome file
            backtest_result: The full JSON content of a FreqTrade backtest-result
            attested_by: Agent/operator identifier (optional)
        """
        from strategydna.attestation import (
            create_attestation,
            to_attestation_json,
        )
        from strategydna.backtest_ingest import extract_environment, parse_freqtrade_result

        try:
            genome_doc = stamp(from_sdna(sdna_content))
            bt_data = json.loads(backtest_result)
            metrics, dataset = parse_freqtrade_result(bt_data)
            environment = extract_environment(bt_data)
            att = create_attestation(
                genome=genome_doc,
                metrics=metrics,
                dataset=dataset,
                environment=environment,
                attested_by=attested_by,
            )
        except (json.JSONDecodeError, ValueError, KeyError, TypeError) as e:
            return json.dumps({"error": f"Attestation error: {e}"})

        return json.dumps({
            "attestation": to_attestation_json(att).strip(),
            "hash": att.hash,
            "genome_hash": att.genome_hash,
            "verdict": att.verdict.value if att.verdict else None,
        })

    @mcp.tool()
    def sdna_verify_attestation(
        attestation_content: str, sdna_content: str | None = None
    ) -> str:
        """Verify the integrity of an attestation, optionally cross-checking a genome.

        Args:
            attestation_content: The full JSON of the attestation file
            sdna_content: Optional genome content to cross-check genome_hash
        """
        from strategydna.attestation import (
            from_attestation_json,
            verify_attestation_chain,
        )
        from strategydna.attestation import (
            verify_attestation as _verify_att,
        )

        try:
            att = from_attestation_json(attestation_content)
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            return json.dumps({"valid": False, "error": f"Parse error: {e}"})

        is_valid = _verify_att(att)
        result: dict[str, Any] = {"valid": is_valid, "hash": att.hash}

        if sdna_content:
            try:
                genome_doc = from_sdna(sdna_content)
                errors = verify_attestation_chain(att, genome_doc)
                result["chain_errors"] = errors
                if errors:
                    result["valid"] = False
            except (json.JSONDecodeError, ValueError, KeyError) as e:
                result["chain_errors"] = [str(e)]
                result["valid"] = False

        return json.dumps(result)

    @mcp.tool()
    def sdna_ingest_backtest(backtest_result: str) -> str:
        """Parse a FreqTrade backtest result and extract metrics and dataset.

        Args:
            backtest_result: The full JSON of a FreqTrade backtest-result file
        """
        from strategydna.backtest_ingest import extract_environment, parse_freqtrade_result

        try:
            bt_data = json.loads(backtest_result)
            metrics, dataset = parse_freqtrade_result(bt_data)
            environment = extract_environment(bt_data)
        except (json.JSONDecodeError, ValueError, KeyError, TypeError) as e:
            return json.dumps({"error": f"Ingest error: {e}"})

        return json.dumps({
            "metrics": metrics.model_dump(mode="json"),
            "dataset": dataset.model_dump(mode="json"),
            "environment": environment.model_dump(mode="json"),
        }, indent=2)

    @mcp.tool()
    def sdna_registry_add(
        sdna_content: str,
        attestation_content: str | None = None,
        registry_path: str = ".sdna-registry",
        registered_by: str = "",
    ) -> str:
        """Register a genome in the local registry, optionally with an attestation.

        Args:
            sdna_content: The full content of the .sdna genome file
            attestation_content: Optional attestation JSON to attach
            registry_path: Path to the registry directory
            registered_by: Operator identifier
        """
        from strategydna.attestation import from_attestation_json
        from strategydna.registry import Registry

        try:
            _validate_registry_path(registry_path)
            genome_doc = stamp(from_sdna(sdna_content))
            att = None
            if attestation_content:
                att = from_attestation_json(attestation_content)

            reg = Registry(registry_path)
            entry = reg.add(genome_doc, attestation=att, registered_by=registered_by)
        except (json.JSONDecodeError, ValueError, KeyError, FileNotFoundError) as e:
            return json.dumps({"error": str(e)})

        return json.dumps({
            "genome_hash": entry.genome_hash,
            "name": entry.name,
            "tier": entry.score.tier.value,
            "composite_score": entry.score.composite_score,
            "next_step": "Run `sdna build content/ -o dist/` to sync the CLI registry so tier/leaderboard reflect this registration.",
        })

    @mcp.tool()
    def sdna_registry_search(
        pairs: list[str] | None = None,
        timeframe: str | None = None,
        tier: str | None = None,
        tags: list[str] | None = None,
        limit: int = 50,
        registry_path: str = ".sdna-registry",
    ) -> str:
        """Search the registry for strategies matching filters.

        Args:
            pairs: Filter by trading pairs
            timeframe: Filter by timeframe (e.g. '4h')
            tier: Filter by tier ('poor', 'fair', 'good', 'excellent')
            tags: Filter by tags
            limit: Max results to return
            registry_path: Path to the registry directory
        """
        from strategydna.registry import Registry

        try:
            _validate_registry_path(registry_path)
            reg = Registry(registry_path)
            results = reg.search(
                pairs=pairs,
                timeframe=timeframe,
                tier=tier,
                tags=tags,
                limit=limit,
            )
        except (FileNotFoundError, ValueError) as e:
            return json.dumps({"error": str(e)})

        return json.dumps(
            [e.model_dump(mode="json") for e in results], indent=2,
        )

    @mcp.tool()
    def sdna_registry_leaderboard(
        sort_by: str = "composite_score",
        pair: str | None = None,
        timeframe: str | None = None,
        limit: int = 20,
        registry_path: str = ".sdna-registry",
    ) -> str:
        """Get the ranked strategy leaderboard.

        Args:
            sort_by: Score field to sort by
            pair: Filter by trading pair
            timeframe: Filter by timeframe
            limit: Max entries to return
            registry_path: Path to the registry directory
        """
        from strategydna.registry import Registry

        try:
            _validate_registry_path(registry_path)
            reg = Registry(registry_path)
            lb = reg.leaderboard(
                sort_by=sort_by, limit=limit, pair=pair, timeframe=timeframe,
            )
        except (FileNotFoundError, ValueError) as e:
            return json.dumps({"error": str(e)})

        return json.dumps(
            [e.model_dump(mode="json") for e in lb], indent=2,
        )

    @mcp.tool()
    def sdna_registry_show(
        genome_hash: str,
        registry_path: str = ".sdna-registry",
    ) -> str:
        """Look up a single registry entry by genome hash.

        Args:
            genome_hash: The display hash (sha256:xxxx) of the genome
            registry_path: Path to the registry directory
        """
        from strategydna.registry import Registry

        try:
            _validate_registry_path(registry_path)
            reg = Registry(registry_path)
            entry = reg.get(genome_hash)
        except (FileNotFoundError, ValueError) as e:
            return json.dumps({"error": str(e)})

        if entry is None:
            return json.dumps({"error": f"Not found: {genome_hash}"})

        return json.dumps(entry.model_dump(mode="json"), indent=2)

    @mcp.tool()
    def sdna_registry_export(
        registry_path: str = ".sdna-registry",
    ) -> str:
        """Export the full registry as a TradeV-importable snapshot.

        Args:
            registry_path: Path to the registry directory
        """
        from strategydna.registry import Registry

        try:
            _validate_registry_path(registry_path)
            reg = Registry(registry_path)
            snapshot = reg.export_snapshot()
        except (FileNotFoundError, ValueError) as e:
            return json.dumps({"error": str(e)})

        return json.dumps(snapshot.model_dump(mode="json"), indent=2)

    return mcp


def main() -> None:
    """Entry point for the MCP server."""
    server = _create_server()
    server.run(transport="stdio")


# Module-level server instance for `python -m strategydna`
if FastMCP is not None:
    mcp = _create_server()

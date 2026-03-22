"""Click CLI for aphexDNA: sdna init, diff, fork, verify, compile, attest, ingest, registry."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import click

from aphexdna.canon import compute_hash, display_hash, from_sdna, stamp, to_sdna, verify
from aphexdna.compiler import compile_config, compile_genome
from aphexdna.diff import diff
from aphexdna.lineage import set_parent
from aphexdna.models import Frontmatter, GenomeBody, GenomeDocument
from aphexdna.templates import TEMPLATES


@click.group()
@click.version_option(version="0.1.0", prog_name="sdna")
def cli() -> None:
    """aphexDNA -- declarative genome format for trading strategies."""


@cli.command()
@click.option("--name", "-n", default="Untitled Strategy", help="Strategy name")
@click.option(
    "--template",
    "-t",
    "template_name",
    type=click.Choice(list(TEMPLATES.keys())),
    default="blank",
    help="Template to use",
)
@click.option("--output", "-o", type=click.Path(), default=None, help="Output file path")
def init(name: str, template_name: str, output: str | None) -> None:
    """Create a new .sdna genome from a template."""
    template_fn = TEMPLATES[template_name]

    if template_name == "blank":
        doc = template_fn(name=name)
    else:
        doc = template_fn()
        if name != "Untitled Strategy":
            new_fm = doc.frontmatter.model_copy(update={"name": name})
            doc = doc.model_copy(update={"frontmatter": new_fm})

    content = to_sdna(doc)

    if output:
        out_path = Path(output)
        out_path.write_text(content, encoding="utf-8")
        stamped = stamp(doc)
        click.echo(f"Created {out_path}")
        click.echo(f"Hash: {stamped.frontmatter.hash}")
    else:
        click.echo(content)


@cli.command("diff")
@click.argument("base_file", type=click.Path(exists=True))
@click.argument("target_file", type=click.Path(exists=True))
@click.option("--json-output", "-j", is_flag=True, help="Output as JSON")
def diff_cmd(base_file: str, target_file: str, json_output: bool) -> None:
    """Compute semantic diff between two .sdna genomes."""
    base_content = Path(base_file).read_text(encoding="utf-8")
    target_content = Path(target_file).read_text(encoding="utf-8")

    base_doc = stamp(from_sdna(base_content))
    target_doc = stamp(from_sdna(target_content))

    result = diff(base_doc, target_doc)

    if json_output:
        click.echo(json.dumps(result.to_dict(), indent=2))
    else:
        click.echo(f"Base:   {result.base_hash}")
        click.echo(f"Target: {result.target_hash}")
        click.echo()
        click.echo(result.summary())


@cli.command()
@click.argument("parent_file", type=click.Path(exists=True))
@click.option("--output", "-o", type=click.Path(), required=True, help="Output file path")
@click.option("--name", "-n", default=None, help="Override strategy name")
@click.option(
    "--set",
    "mutations",
    multiple=True,
    help="Body field mutations as 'path=value' (e.g. --set risk.stop_loss.params.pct=0.08)",
)
def fork(parent_file: str, output: str, name: str | None, mutations: tuple[str, ...]) -> None:
    """Create a child genome forked from a parent, with optional mutations."""
    parent_content = Path(parent_file).read_text(encoding="utf-8")
    parent_doc = stamp(from_sdna(parent_content))

    # Build child from parent
    child_body_data = parent_doc.body.model_dump(mode="json")
    child_fm_data = parent_doc.frontmatter.model_dump(mode="json")
    child_fm_data["hash"] = None
    child_fm_data["parent"] = None

    if name:
        child_fm_data["name"] = name

    for mutation in mutations:
        if "=" not in mutation:
            click.echo(f"Error: mutation must be 'path=value', got '{mutation}'", err=True)
            sys.exit(1)
        path_str, value_str = mutation.split("=", 1)
        _apply_mutation(child_body_data, path_str, value_str)

    child_doc = GenomeDocument(
        frontmatter=Frontmatter.model_validate(child_fm_data),
        body=GenomeBody.model_validate(child_body_data),
    )
    child_doc = set_parent(child_doc, parent_doc)

    content = to_sdna(child_doc)
    out_path = Path(output)
    out_path.write_text(content, encoding="utf-8")

    click.echo(f"Forked from {parent_doc.frontmatter.hash}")
    click.echo(f"Child hash: {child_doc.frontmatter.hash}")
    click.echo(f"Written to {out_path}")


_ALLOWED_MUTATION_PREFIXES = (
    "risk.", "signals.", "regime_filter.", "pairs", "timeframe",
    "informative_timeframes", "exchange.",
)


def _apply_mutation(data: dict[str, Any], path: str, value_str: str) -> None:
    """Apply a dot-path mutation. Parses value as JSON, falls back to string."""
    if not any(path.startswith(p) for p in _ALLOWED_MUTATION_PREFIXES):
        raise click.ClickException(
            f"Mutation path {path!r} not allowed. "
            f"Allowed prefixes: {list(_ALLOWED_MUTATION_PREFIXES)}"
        )
    keys = path.split(".")
    current = data
    for key in keys[:-1]:
        if key not in current:
            current[key] = {}
        current = current[key]

    try:
        parsed = json.loads(value_str)
    except (json.JSONDecodeError, ValueError):
        parsed = value_str

    current[keys[-1]] = parsed


@cli.command("verify")
@click.argument("file", type=click.Path(exists=True))
def verify_cmd(file: str) -> None:
    """Verify the content hash of an .sdna file."""
    content = Path(file).read_text(encoding="utf-8")
    doc = from_sdna(content)

    if doc.frontmatter.hash is None:
        click.echo("UNSTAMPED: No hash present in document.")
        click.echo(f"Computed hash: {display_hash(compute_hash(doc))}")
        sys.exit(1)

    if verify(doc):
        click.echo(f"VALID: {doc.frontmatter.hash}")
    else:
        computed = display_hash(compute_hash(doc))
        click.echo(f"INVALID: stored={doc.frontmatter.hash}, computed={computed}")
        sys.exit(1)


@cli.command("compile")
@click.argument("file", type=click.Path(exists=True))
@click.option("--output", "-o", type=click.Path(), default=None, help="Output .py file path")
def compile_cmd(file: str, output: str | None) -> None:
    """Compile an .sdna genome to a FreqTrade IStrategy Python file."""
    content = Path(file).read_text(encoding="utf-8")
    doc = stamp(from_sdna(content))
    source = compile_genome(doc)

    if output is None:
        class_name = _sanitize_name_for_file(doc.frontmatter.name)
        output = f"{class_name}_strategy.py"

    out_path = Path(output)
    out_path.write_text(source, encoding="utf-8")
    click.echo(f"Compiled to {out_path}")
    click.echo(f"Genome hash: {doc.frontmatter.hash}")


@cli.command("compile-config")
@click.argument("file", type=click.Path(exists=True))
@click.option("--output", "-o", type=click.Path(), default=None, help="Output config.json path")
def compile_config_cmd(file: str, output: str | None) -> None:
    """Generate a FreqTrade config.json from an .sdna genome."""
    content = Path(file).read_text(encoding="utf-8")
    doc = from_sdna(content)
    config = compile_config(doc)

    if output is None:
        class_name = _sanitize_name_for_file(doc.frontmatter.name)
        output = f"config_{class_name}.json"

    out_path = Path(output)
    out_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    click.echo(f"Config written to {out_path}")


@cli.command("attest")
@click.argument("genome_file", type=click.Path(exists=True))
@click.argument("result_file", type=click.Path(exists=True))
@click.option("--output", "-o", type=click.Path(), default=None, help="Output attestation file")
@click.option("--attested-by", default="", help="Agent/operator identifier")
def attest_cmd(
    genome_file: str, result_file: str, output: str | None, attested_by: str
) -> None:
    """Create an attestation from a genome and FreqTrade backtest result."""
    from aphexdna.attestation import create_attestation, to_attestation_json
    from aphexdna.backtest_ingest import ingest_backtest_bundle

    genome_content = Path(genome_file).read_text(encoding="utf-8")
    genome_doc = stamp(from_sdna(genome_content))

    metrics, dataset, environment = ingest_backtest_bundle(result_file)
    att = create_attestation(
        genome=genome_doc,
        metrics=metrics,
        dataset=dataset,
        environment=environment,
        attested_by=attested_by,
    )
    content = to_attestation_json(att)

    if output:
        out_path = Path(output)
        out_path.write_text(content, encoding="utf-8")
        click.echo(f"Attestation written to {out_path}")
        click.echo(f"Hash: {att.hash}")
        click.echo(f"Genome: {att.genome_hash}")
    else:
        click.echo(content)


@cli.command("verify-attestation")
@click.argument("attestation_file", type=click.Path(exists=True))
@click.option(
    "--genome", "-g", type=click.Path(exists=True), default=None,
    help="Genome file to cross-check",
)
def verify_attestation_cmd(attestation_file: str, genome: str | None) -> None:
    """Verify the integrity of an attestation file."""
    from aphexdna.attestation import (
        compute_attestation_hash,
        from_attestation_json,
        verify_attestation,
        verify_attestation_chain,
    )

    content = Path(attestation_file).read_text(encoding="utf-8")
    att = from_attestation_json(content)

    if not verify_attestation(att):
        computed = compute_attestation_hash(att)
        click.echo(f"INVALID: stored={att.hash}, computed={computed}")
        sys.exit(1)

    click.echo(f"VALID: {att.hash}")

    if genome:
        genome_content = Path(genome).read_text(encoding="utf-8")
        genome_doc = from_sdna(genome_content)
        errors = verify_attestation_chain(att, genome_doc)
        if errors:
            for err in errors:
                click.echo(f"  ERROR: {err}")
            sys.exit(1)
        click.echo("  Genome cross-check: OK")


@cli.command("ingest")
@click.argument("result_file", type=click.Path(exists=True))
@click.option("--json-output", "-j", is_flag=True, help="Output as JSON")
def ingest_cmd(result_file: str, json_output: bool) -> None:
    """Parse a FreqTrade backtest result and display extracted metrics."""
    from aphexdna.backtest_ingest import ingest_backtest_bundle

    metrics, dataset, environment = ingest_backtest_bundle(result_file)

    if json_output:
        result = {
            "metrics": metrics.model_dump(mode="json"),
            "dataset": dataset.model_dump(mode="json"),
            "environment": environment.model_dump(mode="json"),
        }
        click.echo(json.dumps(result, indent=2))
    else:
        click.echo(f"Pairs: {', '.join(dataset.pairs)}")
        click.echo(f"Period: {dataset.start_date} to {dataset.end_date}")
        click.echo(f"Timeframe: {dataset.timeframe}")
        click.echo(f"Trades: {metrics.total_trades} | Win Rate: {metrics.win_rate:.1%}")
        if metrics.sharpe_ratio is not None:
            click.echo(f"Sharpe: {metrics.sharpe_ratio:.2f} | Max DD: {metrics.max_drawdown:.1%}")
        click.echo(f"Profit: {metrics.profit_total:.1%}")


def _sanitize_name_for_file(name: str) -> str:
    """Convert a genome name to a filesystem-safe lowercase string."""
    import re

    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
    return cleaned or "strategy"


# --- Registry command group ---


@cli.group()
def registry() -> None:
    """Manage the local strategy registry."""


@registry.command("init")
@click.option(
    "--path", "-p", default=".sdna-registry", help="Registry directory path",
)
def registry_init(path: str) -> None:
    """Create a new empty registry."""
    from aphexdna.registry import Registry

    reg = Registry(path)
    try:
        reg.init()
    except FileExistsError:
        click.echo(f"Registry already exists at {path}", err=True)
        sys.exit(1)
    click.echo(f"Registry initialized at {path}")


@registry.command("add")
@click.argument("genome_file", type=click.Path(exists=True))
@click.option(
    "--attestation", "-a", type=click.Path(exists=True), default=None,
    help="Attestation file to attach",
)
@click.option("--registered-by", default="", help="Operator identifier")
@click.option("--path", "-p", default=".sdna-registry", help="Registry path")
def registry_add(
    genome_file: str,
    attestation: str | None,
    registered_by: str,
    path: str,
) -> None:
    """Register a genome in the registry."""
    from aphexdna.attestation import from_attestation_json
    from aphexdna.registry import Registry

    genome_content = Path(genome_file).read_text(encoding="utf-8")
    genome_doc = stamp(from_sdna(genome_content))

    att = None
    if attestation:
        att_content = Path(attestation).read_text(encoding="utf-8")
        att = from_attestation_json(att_content)

    reg = Registry(path)
    try:
        entry = reg.add(genome_doc, attestation=att, registered_by=registered_by)
    except (ValueError, FileNotFoundError) as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    click.echo(f"Registered {entry.name}")
    click.echo(f"Hash: {entry.genome_hash}")
    click.echo(f"Tier: {entry.score.tier.value}")


@registry.command("attach")
@click.argument("genome_hash")
@click.argument("attestation_file", type=click.Path(exists=True))
@click.option("--path", "-p", default=".sdna-registry", help="Registry path")
def registry_attach(genome_hash: str, attestation_file: str, path: str) -> None:
    """Attach an attestation to an existing registry entry."""
    from aphexdna.attestation import from_attestation_json
    from aphexdna.registry import Registry

    att_content = Path(attestation_file).read_text(encoding="utf-8")
    att = from_attestation_json(att_content)

    reg = Registry(path)
    try:
        entry = reg.attach_attestation(genome_hash, att)
    except (KeyError, ValueError, FileNotFoundError) as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    click.echo(f"Attached attestation to {entry.name}")
    click.echo(f"Score: {entry.score.composite_score} ({entry.score.tier.value})")


@registry.command("show")
@click.argument("genome_hash")
@click.option("--path", "-p", default=".sdna-registry", help="Registry path")
@click.option("--json-output", "-j", is_flag=True, help="Output as JSON")
def registry_show(genome_hash: str, path: str, json_output: bool) -> None:
    """Show details of a registered genome."""
    from aphexdna.registry import Registry

    reg = Registry(path)
    try:
        entry = reg.get(genome_hash)
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if entry is None:
        click.echo(f"Not found: {genome_hash}", err=True)
        sys.exit(1)

    if json_output:
        click.echo(json.dumps(entry.model_dump(mode="json"), indent=2))
    else:
        click.echo(f"Name: {entry.name}")
        click.echo(f"Hash: {entry.genome_hash}")
        click.echo(f"Tags: {', '.join(entry.tags)}")
        click.echo(f"Author: {entry.author or '(none)'}")
        click.echo(f"Timeframe: {entry.timeframe}")
        click.echo(f"Score: {entry.score.composite_score} ({entry.score.tier.value})")
        click.echo(f"Attestations: {len(entry.attestation_hashes)}")


@registry.command("list")
@click.option("--pair", default=None, help="Filter by pair")
@click.option("--timeframe", default=None, help="Filter by timeframe")
@click.option("--tier", default=None, help="Filter by tier")
@click.option("--tag", "tags", multiple=True, help="Filter by tag (repeatable)")
@click.option("--sort-by", default="composite_score", help="Sort field")
@click.option("--limit", "-n", default=50, help="Max results")
@click.option("--path", "-p", default=".sdna-registry", help="Registry path")
@click.option("--json-output", "-j", is_flag=True, help="Output as JSON")
def registry_list(
    pair: str | None,
    timeframe: str | None,
    tier: str | None,
    tags: tuple[str, ...],
    sort_by: str,
    limit: int,
    path: str,
    json_output: bool,
) -> None:
    """Search and list registered strategies."""
    from aphexdna.registry import Registry

    reg = Registry(path)
    try:
        results = reg.search(
            pairs=[pair] if pair else None,
            timeframe=timeframe,
            tier=tier,
            tags=list(tags) if tags else None,
            limit=limit,
        )
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if json_output:
        data = [e.model_dump(mode="json") for e in results]
        click.echo(json.dumps(data, indent=2))
    else:
        if not results:
            click.echo("No entries found.")
            return
        for entry in results:
            click.echo(
                f"  {entry.genome_hash:<20s}  "
                f"{entry.name:<30s}  "
                f"{entry.score.composite_score:5.1f}  "
                f"{entry.score.tier.value}"
            )


@registry.command("leaderboard")
@click.option("--pair", default=None, help="Filter by pair")
@click.option("--timeframe", default=None, help="Filter by timeframe")
@click.option("--sort-by", default="composite_score", help="Sort field")
@click.option("--limit", "-n", default=20, help="Max entries")
@click.option("--path", "-p", default=".sdna-registry", help="Registry path")
@click.option("--json-output", "-j", is_flag=True, help="Output as JSON")
def registry_leaderboard(
    pair: str | None,
    timeframe: str | None,
    sort_by: str,
    limit: int,
    path: str,
    json_output: bool,
) -> None:
    """Display the strategy leaderboard."""
    from aphexdna.registry import Registry

    reg = Registry(path)
    try:
        lb = reg.leaderboard(
            sort_by=sort_by, limit=limit, pair=pair, timeframe=timeframe,
        )
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if json_output:
        data = [e.model_dump(mode="json") for e in lb]
        click.echo(json.dumps(data, indent=2))
    else:
        if not lb:
            click.echo("No entries.")
            return
        click.echo(f"{'#':>3}  {'Hash':<20}  {'Name':<25}  {'Score':>6}  {'Tier':<10}")
        click.echo("-" * 70)
        for entry in lb:
            click.echo(
                f"{entry.rank:>3}  "
                f"{entry.genome_hash:<20}  "
                f"{entry.name:<25}  "
                f"{entry.composite_score:>6.1f}  "
                f"{entry.tier.value}"
            )


@registry.command("export")
@click.option(
    "--output", "-o", type=click.Path(), default=None,
    help="Output file (default: stdout)",
)
@click.option("--path", "-p", default=".sdna-registry", help="Registry path")
def registry_export(output: str | None, path: str) -> None:
    """Export full registry snapshot as JSON."""
    from aphexdna.registry import Registry

    reg = Registry(path)
    try:
        snapshot = reg.export_snapshot()
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    content = json.dumps(snapshot.model_dump(mode="json"), indent=2) + "\n"

    if output:
        out_path = Path(output)
        out_path.write_text(content, encoding="utf-8")
        click.echo(f"Exported {snapshot.total_entries} entries to {out_path}")
    else:
        click.echo(content)

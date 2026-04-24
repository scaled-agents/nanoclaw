---
name: candidate-pipeline
description: >
  Competition-mode candidate queue manager. Keeps the candidate queue warm
  with pre-qualified strategy candidates for fast slot fill when bots are
  evicted. Only active when competition-state.json has active=true.
  Trigger on: "candidate pipeline", "refresh candidates", "fill queue",
  "competition candidates", "pipeline status".
---

# Candidate Pipeline — Competition Mode Queue Manager

Proactively generates and queues strategy candidates so monitor can fill
open slots in under 5 minutes instead of waiting 2-6 hours for a full
strategyzer cycle. Only runs when competition mode is active.

## DATA SOURCES

All paths under `/workspace/group/`.

| File | Purpose | Required |
|------|---------|----------|
| `auto-mode/competition-state.json` | Competition mode state + budget tracking | Yes |
| `auto-mode/candidate-queue.jsonl` | Current candidate queue | No (created if missing) |
| `auto-mode/campaigns.json` | Active campaigns per correlation group | Yes |
| `reports/gap-report.json` | Ranked gaps from latest scout scan | Yes |
| `reports/strategyzer-result.json` | Output from strategyzer runs | No (written during Step 3) |
| `scoring-config.json` | Optional overrides for queue thresholds | No |
| `/workspace/skills/archetype-taxonomy/archetypes.yaml` | Archetype → correlation_group mapping | Yes |

Read config defaults from `scoring-config.json` → `COMPETITION_MODE.candidate_queue`:
```
max_size = 5                          # max active entries in queue
max_age_hours = 48                    # expiration window
min_favorable_sharpe = -0.5           # floor for queue admission
max_strategyzer_runs_per_day = 10     # daily budget cap
gaps_per_run = 3                      # max gaps to process per pipeline run
```

## PROCEDURE

### Step 0: Competition Guard

```
state = read auto-mode/competition-state.json
  If missing: exit with "Competition mode not active."
  If state.active != true: exit with "Competition mode not active."

# Auto-disable safeguard
If now > state.end_date:
  state.active = false
  write auto-mode/competition-state.json
  exit with "Competition mode expired (end_date: {end_date}). Deactivated."

# Budget check — reset daily counter if date changed
If state.strategyzer_runs_date != today:
  state.strategyzer_runs_today = 0
  state.strategyzer_runs_date = today

If state.strategyzer_runs_today >= max_strategyzer_runs_per_day:
  exit with "Daily strategyzer run cap reached ({n}/{max}). Next reset at midnight."
```

### Step 1: Assess Deficit

```
queue_lines = read auto-mode/candidate-queue.jsonl
  (create empty if missing)

active_queue = [q for q in queue_lines
                if q.status == "active" and q.expires_at > now]
queue_size = len(active_queue)

# Count active bots per correlation group
campaigns = read auto-mode/campaigns.json
group_counts = {}
for c in campaigns:
  if c.state in ("paper_trading", "pending_deploy"):
    group = archetype_taxonomy[c.archetype].correlation_group
    group_counts[group] = group_counts.get(group, 0) + 1

# Also count queued candidates per group
for q in active_queue:
  group_counts[q.correlation_group] = group_counts.get(q.correlation_group, 0) + 1

# Check for group deficit (any group with 0 coverage including queue)
group_deficit = any(
  group_counts.get(g, 0) == 0
  for g in ["trend", "range", "vol", "carry"]
)

If queue_size >= max_size AND not group_deficit:
  exit with "Queue full ({queue_size}/{max_size}), no group deficit. Skipping."
```

### Step 2: Identify Targets

```
gap_report = read reports/gap-report.json

# Take top N gaps
targets = gap_report.top_gaps[:gaps_per_run]

# Filter out gaps already represented in active queue
queued_cells = set(
  (q.archetype, q.pair, q.timeframe) for q in active_queue
)
targets = [t for t in targets
           if (t.archetype, t.pair, t.timeframe) not in queued_cells]

If len(targets) == 0:
  exit with "All top gaps already have queued candidates. Skipping."
```

### Step 3: Generate Candidates

For each target gap (respecting daily budget):

```
For target in targets:
  If state.strategyzer_runs_today >= max_strategyzer_runs_per_day:
    log "Budget cap reached, stopping candidate generation."
    break

  # Trigger strategyzer for this gap
  # The agent runs the strategyzer skill targeting this cell:
  #   archetype = target.archetype
  #   pair = target.pair
  #   timeframe = target.timeframe
  # This produces reports/strategyzer-result.json

  result = read reports/strategyzer-result.json
  state.strategyzer_runs_today += 1

  If result.status == "candidates_found":
    for candidate in result.race_candidates:
      If candidate.favorable_sharpe >= min_favorable_sharpe:
        append to auto-mode/candidate-queue.jsonl:
        {
          "id": "cq_{today}_{8hex}",
          "strategy_path": candidate.file,
          "strategy_name": candidate.strategy,
          "archetype": target.archetype,
          "correlation_group": archetype_taxonomy[target.archetype].correlation_group,
          "pair": target.pair,
          "timeframe": target.timeframe,
          "favorable_sharpe": candidate.favorable_sharpe,
          "gap_score": target.gap_score,
          "source_path": candidate.path,
          "created_at": now,
          "expires_at": now + max_age_hours,
          "status": "active"
        }
```

### Step 4: Age Out Expired Entries

```
all_lines = read auto-mode/candidate-queue.jsonl
for entry in all_lines:
  if entry.status == "active" and entry.expires_at <= now:
    entry.status = "expired"

# Rewrite file (compact: drop expired entries older than 7 days)
retained = [e for e in all_lines
            if not (e.status == "expired"
                    and e.expires_at < now - 7_days)]
write auto-mode/candidate-queue.jsonl with retained
```

### Step 5: Log and Update State

```
# Update competition state
state.last_pipeline_run = now
write auto-mode/competition-state.json

# Record evolution event
aphexdata_record_event({
  event_id: "evo_{today}_{8hex}",
  resource_type: "candidate_pipeline",
  resource_id: "competition",
  operation: "assess",
  proposer: "candidate-pipeline",
  timestamp: now,
  metrics: {
    candidates_generated: n_generated,
    candidates_expired: n_expired,
    queue_size: len(active entries),
    queue_max: max_size,
    strategyzer_runs_today: state.strategyzer_runs_today,
    budget_remaining: max_strategyzer_runs_per_day - state.strategyzer_runs_today,
    group_deficit: group_deficit,
    targets_processed: len(targets_processed),
  }
})
```

## DISPLAY FORMAT

```
CANDIDATE PIPELINE — Competition Mode
======================================
Status: active (expires {end_date})
Budget: {runs_today}/{max_runs} strategyzer runs today

Queue: {active}/{max_size} active candidates
  - {strategy_name} | {archetype} | {pair} {tf} | sharpe {sharpe} | expires {expires}
  - ...

This run:
  Targets processed: {n}
  Candidates added: {n_added}
  Candidates expired: {n_expired}

Group coverage (bots + queue):
  trend: {n}  range: {n}  vol: {n}  carry: {n}
  Deficit: {yes/no}
```

## ALPHA-AWARE URGENCY

When the BTC benchmark shows negative alpha, the candidate pipeline
increases urgency to fill gaps that could restore positive performance.

```
# After Step 0 (Competition Guard), check benchmark alpha
if state.benchmark and state.benchmark.daily_snapshots:
  last_snapshot = state.benchmark.daily_snapshots[-1]
  alpha = last_snapshot.alpha_pct

  # Negative alpha for 3+ consecutive days → increase urgency
  recent = state.benchmark.daily_snapshots[-3:]
  consecutive_negative = all(s.alpha_pct < 0 for s in recent) if len(recent) >= 3 else False

  if consecutive_negative:
    # Increase gaps_per_run by urgency multiplier (from scoring-config)
    urgency = scoring_config.COMPETITION_MODE.daily_kata.negative_alpha_urgency_multiplier
    gaps_per_run = int(gaps_per_run * urgency)
    log "ALPHA URGENCY: negative alpha for 3+ days, gaps_per_run increased to {gaps_per_run}"

  # Bias target selection toward archetypes that counter current weakness
  # If portfolio is trend-heavy and losing, prefer range/vol candidates
  # If portfolio is range-heavy in trending market, prefer trend candidates
```

This does NOT lower quality gates — it increases the *rate* of candidate
generation to fill gaps faster when the portfolio is underperforming.

## GRACEFUL DEGRADATION

- `competition-state.json` missing → exit immediately, no error
- `candidate-queue.jsonl` missing → create empty, proceed
- `gap-report.json` missing → exit with "Run scout first"
- `campaigns.json` missing → treat as empty (all groups have deficit)
- Strategyzer failure on one target → log warning, continue to next
- Budget exhausted mid-run → stop cleanly, log partial results

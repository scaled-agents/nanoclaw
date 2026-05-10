---
name: ux-retrospective
description: >
  Daily retrospective that reads WhatsApp conversation history, identifies
  usability and functionality improvement opportunities, and ranks the top 3
  by estimated impact. Scheduled daily.
  Trigger on: "ux audit", "improvements", "retrospective", "what should we fix".
---

# UX Retrospective

Analyze the last N hours of WhatsApp conversation between Wolf and the human operator.
Identify usability, functionality, and ease-of-use improvement opportunities. Rank by
impact and present the top 3 with concrete fix suggestions.

## DATA COLLECTION

```
config = read scoring-config.json → UX_RETROSPECTIVE (or defaults below)
hours = config.lookback_hours          # default 24
min_messages = config.min_messages_for_analysis  # default 10
max_reported = config.max_improvements_reported  # default 3

messages = nanoclaw_chat_history(hours=hours, include_bot=true, limit=500)

if len(messages) < min_messages:
  post("Not enough messages ({n}) in the last {hours}h for analysis. Skipping retrospective.")
  STOP
```

## ANALYSIS FRAMEWORK

Read every message and classify friction into these categories:

| Category | Signal Indicators |
|----------|-------------------|
| **friction** | Human asks clarification questions, "what does X mean?", confusion about output format, requests to re-run or retry, misinterprets a report |
| **missing_context** | Wolf output lacks info for a decision, human asks follow-up, human has to cross-reference another source to understand output |
| **manual_workaround** | Human does something manually that should be automated, copy-pastes between messages, references external tools, manually triggers what should be scheduled |
| **error_pattern** | Repeated failures, same error across multiple ticks, retries without resolution, container crashes |
| **silent_gap** | Long periods with no output when output was expected, scheduled task didn't fire, missing tick logs |

For each identified opportunity, collect:
- Category (one of the five above)
- Evidence: 1-2 specific message quotes that demonstrate the friction
- Affected workflow: which skill or process is involved
- Who is impacted: human operator, the agent itself, or both

## SCORING

For each opportunity, estimate three dimensions:

| Dimension | Scale | Description |
|-----------|-------|-------------|
| `frequency` | 1-5 | How often does this friction appear in the window? (1=once, 5=every few messages) |
| `severity` | 1-5 | How much does it block or slow the human? (1=minor annoyance, 5=workflow-blocking) |
| `fixability` | 1-5 | How feasible is a fix within the existing architecture? (1=requires new infrastructure, 5=config change or small skill edit) |

```
impact = frequency * severity * fixability   # max 125
```

Rank all opportunities by `impact` descending. Report the top `max_reported` (default 3).

## CONSTRAINTS

- NEVER suggest removing safety gates or deployment verification
- NEVER suggest new trading strategies or parameter changes — those belong to kata/scout
- Focus on INFORMATION QUALITY (what Wolf says) and WORKFLOW EFFICIENCY (what humans have to do)
- Keep suggestions within existing architecture; don't propose new infrastructure
- Suggested fixes must reference a specific skill, file, or config key
- If no meaningful improvements are found, say so — do NOT manufacture problems

## OUTPUT FORMAT

Post to WhatsApp:

```
## UX Retrospective — {YYYY-MM-DD}
**Window:** last {hours}h | **Messages analyzed:** {n_total} ({n_bot} bot, {n_human} human)

### Top 3 Improvements

**1. {title}** (impact: {score}, category: {category})
> "{quoted message evidence}"
**Fix:** {specific actionable suggestion — reference skill/file/config}
**Effort:** {trivial / small / medium / large}

**2. {title}** (impact: {score}, category: {category})
> "{quoted message evidence}"
**Fix:** {specific actionable suggestion}
**Effort:** {effort}

**3. {title}** (impact: {score}, category: {category})
> "{quoted message evidence}"
**Fix:** {specific actionable suggestion}
**Effort:** {effort}

### Patterns Noted
- {additional observations that didn't make top 3, if any}
```

## PERSISTENCE

Write full analysis to `/workspace/group/reports/ux-retrospective.json`:

```json
{
  "generated_at": "<ISO-8601>",
  "lookback_hours": 24,
  "messages_analyzed": 142,
  "messages_bot": 98,
  "messages_human": 44,
  "improvements": [
    {
      "rank": 1,
      "title": "Monitor-health output too verbose for routine ticks",
      "category": "friction",
      "frequency": 4,
      "severity": 3,
      "fixability": 5,
      "impact": 60,
      "evidence": ["msg quote 1", "msg quote 2"],
      "affected_skill": "monitor-health",
      "fix": "Add a QUIET_MODE flag that suppresses step-by-step output when no actions are taken",
      "effort": "small"
    }
  ],
  "patterns_noted": ["pattern 1", "pattern 2"]
}
```

Append summary line to `/workspace/group/knowledge/ux-improvements.jsonl`:

```json
{"date": "2026-05-10", "top_improvement": "Monitor-health output too verbose", "impact": 60, "category": "friction", "status": "proposed"}
```

This JSONL accumulates over time so trend analysis can detect recurring themes across days.

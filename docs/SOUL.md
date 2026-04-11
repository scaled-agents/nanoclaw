# SOUL.md — Agent Personality Layer

`SOUL.md` gives a NanoClaw agent a consistent voice across channels — how it talks on WhatsApp, Telegram, X, and in internal logs. It is orthogonal to `CLAUDE.md`, which owns operational rules ("what the agent does").

**Rule of thumb:** `CLAUDE.md` = what. `SOUL.md` = how.

## File layout

```
groups/
  global/
    CLAUDE.md      ← operational rules, shared across non-main groups
    SOUL.md        ← default voice, inherited by all non-main groups
  main/
    CLAUDE.md      ← operational rules for admin/dev group
    SOUL.md        ← (optional) main-group voice override
  whatsapp_main/
    CLAUDE.md      ← per-group operational rules
    SOUL.md        ← (optional) per-group voice override
```

## Load order

The agent container assembles `systemPrompt.append` in this order:

1. `groups/global/CLAUDE.md` (non-main only)
2. `groups/global/SOUL.md` (non-main only)
3. `groups/{group}/SOUL.md` (always, if present)

Layers are joined with `\n\n---\n\n`. Later layers win on conflict, so a group-level soul can override any global voice rule simply by restating it.

Loading code lives in [container/agent-runner/src/index.ts](../container/agent-runner/src/index.ts) around the `readIfExists` + `systemAppend` block.

If no SOUL.md exists at any layer, the agent runs with the SDK's default voice — graceful degradation, no crash.

## Authoring a SOUL.md

The file is free-form markdown. The starter template at [groups/global/SOUL.md](../groups/global/SOUL.md) uses six sections — use them as a scaffold, not a straitjacket:

| Section | Purpose |
|---|---|
| `Voice & Tone` | Sentence length, formality, emoji policy, decimal precision |
| `Values & Priorities` | What to optimize for when goals conflict |
| `Channel Adaptation` | Per-channel formatting rules (WhatsApp vs X vs internal) |
| `Behavioral Rules` | Opening phrases to avoid, hedging policy, opinion policy |
| `Expertise Posture` | Where to be confident, where to defer, what to avoid |
| `Hard Boundaries` | Never-do rules (returns promises, leverage, off-topic posts) |

### Tips

- **Be concrete.** "Lead with the verdict" beats "Be direct."
- **Write like an instruction, not a description.** "Short sentences." not "The agent prefers short sentences."
- **Put channel rules in one place.** The agent is one personality speaking through many mouths — don't scatter formatting rules across multiple files.
- **Version the header.** A comment like `<!-- SOUL v1.0 — 2026-04-11 -->` at the top makes diffs obvious.

## Swapping personas

Right now, swapping is manual — edit the file and restart the container. Planned extensions (not yet implemented):

- `/soul-as <name>` slash command for hot-swapping
- `groups/global/souls/*.md` directory of alternates, active one selected via env var
- aphexDATA event emitted on soul change
- Per-user tone adaptation based on conversation history

## Verifying it's loaded

1. Add a distinctive marker phrase to `groups/global/SOUL.md`, e.g. "always sign off with 'WC out.'"
2. `./container/build.sh && npm run build && <restart nanoclaw>`
3. Send a WhatsApp message: "summarize the running bots"
4. Confirm the reply ends with "WC out."

If it doesn't, check the agent container logs for `Loaded SOUL.md layers: global=...`.

## What SOUL.md is NOT

- Not a place for tool instructions, API credentials, or operational procedures — those belong in `CLAUDE.md` or skill docs.
- Not a prompt injection defense layer — voice rules are soft guidance, not security.
- Not a kill switch — "Hard Boundaries" are tone instructions to the model, not enforcement. Real guardrails live in router/tool code.

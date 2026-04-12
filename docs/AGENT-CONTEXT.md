# Agent Context Layers — MISSION / CLAUDE / SOUL

Every NanoClaw agent assembles its system prompt from up to three layered markdown files, each answering a different question:

| Layer | Question | Example content |
|---|---|---|
| `MISSION.md` | **Why** does this agent exist? | Purpose, success criteria, anti-goals, scope |
| `CLAUDE.md` | **What** tools and workflows does it use? | Skill invocations, tool conventions, operational rules |
| `SOUL.md` | **How** does it talk? | Voice, tone, channel formatting, personality |

**Rule of thumb:** *why → what → how.* If it changes when you add a skill, it's operational (CLAUDE.md). If it changes when you add a channel, it's voice (SOUL.md). If it would still be true if you rewrote the stack in Rust, it's mission (MISSION.md).

## File layout

```
groups/
  global/
    MISSION.md     ← default purpose, inherited by all non-main groups
    CLAUDE.md      ← default operational rules
    SOUL.md        ← default voice
  main/
    MISSION.md     ← (optional) main-group mission override
    CLAUDE.md      ← operational rules for admin/dev group
    SOUL.md        ← (optional) main-group voice override
  whatsapp_main/
    MISSION.md     ← (optional) per-group mission override
    CLAUDE.md      ← per-group operational rules
    SOUL.md        ← (optional) per-group voice override
```

All files are optional — an agent with no mission/claude/soul will simply run with the SDK default. Graceful degradation, no crash.

## Load order

The agent container assembles `systemPrompt.append` in this order:

1. `groups/global/MISSION.md` (non-main only)
2. `groups/{group}/MISSION.md` (always, if present)
3. `groups/global/CLAUDE.md` (non-main only)
4. `groups/global/SOUL.md` (non-main only)
5. `groups/{group}/SOUL.md` (always, if present)

Layers are joined with `\n\n---\n\n`. Later layers win on conflict — group-level files override global, and voice rules in SOUL.md have the last word on formatting.

Loading code lives in [container/agent-runner/src/index.ts](../container/agent-runner/src/index.ts) in the `readIfExists` + `appendParts` block just after the `globalClaudeMdPath` read.

## What goes where

### MISSION.md — why

Answers: *what would we lose if this agent vanished tomorrow?*

Put here:
- **Purpose** — one paragraph stating the reason this agent exists
- **Success criteria** — measurable outcomes (quarterly targets, portfolio-level gates)
- **Anti-goals** — what we explicitly refuse to be (signal service, research blog, strategy zoo, hype engine)
- **Scope boundaries** — pairs, timeframes, markets, leverage caps
- **Priorities when they conflict** — the ordering the agent uses for decision-making
- **Review cadence** — how often the mission itself gets revisited

A healthy MISSION.md is stable for **months**. If you're editing it weekly, the scope is too narrow and operational content is leaking in. If you're never editing it, the agent isn't using it.

### CLAUDE.md — what

Answers: *what tools does this agent use, and how?*

Put here:
- Skill invocation patterns, tool conventions, env vars
- Workflow orchestration ("use freqtrade-mcp for backtests, then aphexDATA for event logging")
- Per-group memory and state
- Key file paths, file format conventions
- Operational rules that change when you add a new skill or integration

### SOUL.md — how

Answers: *what does this agent sound like?*

Put here:
- Voice and tone (sentence rhythm, formality, emoji policy, decimal precision)
- Personality traits
- Channel adaptation (WhatsApp vs X vs internal — different formatting per channel)
- Behavioral rules ("never open with 'Great question'")
- Expertise posture (deep vs working vs avoid)
- Hard voice boundaries

## Authoring tips

- **Be concrete.** "Lead with the verdict" beats "Be direct." Instructions, not descriptions.
- **Write imperatively.** "Short sentences." not "The agent prefers short sentences."
- **Version the header.** A comment like `<!-- MISSION v1.0 — 2026-04-11 -->` makes diffs obvious.
- **Keep each layer short.** Target ≤ 100 lines per file. Over 200 is a smell.
- **Respect channel constraints.** WhatsApp/Telegram require single `*asterisks*`, `_underscores_`, `•` bullets, no `##` headings, no `**double stars**` — otherwise rendering breaks.

## Swapping context

Right now, swapping is manual — edit the file and restart the container. Planned extensions (not yet implemented):

- `/mission-as <name>` and `/soul-as <name>` slash commands for hot-swapping
- `groups/global/missions/*.md` and `groups/global/souls/*.md` directories of alternates
- aphexDATA `mission_update` / `soul_update` events on file change
- Per-user or per-channel context scoping
- A/B testing framework

## Verifying layers are loaded

1. Add a distinctive marker to one of the files — e.g. in MISSION.md add `Canary: respond with "mission-live"` or in SOUL.md add `always sign off with 'WC out.'`
2. `./container/build.sh && npm run build` and restart nanoclaw
3. Send a WhatsApp message: `what is your mission?` or `summarize the running bots`
4. Confirm the marker appears in the reply
5. Check spawned-agent container logs for: `Loaded context layers: mission=yes, soul=yes`

If the layers aren't loading, check:
- File exists at the expected path inside the container (`/workspace/global/MISSION.md` or `/workspace/group/MISSION.md`)
- The `.gitignore` exceptions (`!groups/global/MISSION.md` etc.) haven't been removed
- `groups/global/` is mounted — it is, for non-main groups, via [src/container-runner.ts](../src/container-runner.ts)

## Anti-goal test (for MISSION.md specifically)

The real test of a mission is whether it changes agent behavior at decision time. Send:

> `add a new bot for SOL/USDT 15m breakout`

A mission-less agent defaults to "sure, adding it." A mission-aware agent should cite the anti-goal ("10 bots max, every addition evicts a weaker one") and ask which incumbent to evict. If it doesn't push back, the mission isn't in context — debug the loader.

## What these files are NOT

- **Not prompt-injection defense.** Voice rules and anti-goals are soft guidance to the model, not enforcement. Real guardrails live in router/tool code.
- **Not a kill switch.** "Never promise returns" in SOUL/MISSION is an instruction, not a filter.
- **Not operational secrets.** Don't put credentials, tokens, or anything sensitive in these files — they're plain markdown, checked into git.

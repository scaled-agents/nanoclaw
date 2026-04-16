---
name: health-check
description: >
  System diagnostic — probes all MCP tools, external APIs, workspace state,
  bot health, and browser automations. Non-destructive read-only checks.
  Produces structured JSON report with pass/warn/fail verdicts and fix actions.
  Trigger on: "health check", "system status", "what's broken", "diagnose",
  "check everything", "system health", "is everything working", "run diagnostics"
---

# Health Check — System Diagnostic

Non-destructive, read-only diagnostic that probes every component the pipeline
depends on. Produces a structured report with pass/warn/fail verdicts and
actionable fix suggestions. Takes ~60 seconds.

**This skill NEVER modifies state.** It only reads files, calls tools with
read-only operations, and writes one report file.

## Dependencies

| Skill / Tool | Purpose |
|--------------|---------|
| `freqtrade_get_freqtrade_version` | FreqTrade MCP connectivity |
| `aphexdata_health` | aphexDATA MCP connectivity |
| `orderflow_fetch_regime` | Orderflow MCP connectivity |
| `sync_state_to_supabase` | Push report to dashboard |

## Output

```
{WORKSPACE}/reports/health-check-latest.json
```

---

## Step 0 — Initialize

Record the start timestamp. Read the instance config for context:

```bash
cat /workspace/group/instance-config.json 2>/dev/null || echo "{}"
```

Initialize the results structure:

```
results = {
  timestamp: <now ISO>,
  tiers: {},
  fixes: []
}
```

Each check produces:

```
{ name: string, status: "pass"|"warn"|"fail", detail: string, latency_ms: number }
```

---

## Step 1 — Tier 1: Infrastructure (~10s)

Core MCP tool availability. Each check is a single lightweight tool call.
Record latency for each.

### Check 1: FreqTrade MCP

Call `freqtrade_get_freqtrade_version`.

| Result | Verdict |
|--------|---------|
| Returns version string | **pass** — detail: version string |
| Timeout or error | **fail** — fix: "FreqTrade MCP server unreachable. Check container is running and MCP stdio connection is active." |

### Check 2: aphexDATA MCP

Call `aphexdata_health`.

| Result | Verdict |
|--------|---------|
| Returns `{ status: "ok" }` | **pass** |
| Timeout or error | **fail** — fix: "aphexDATA MCP server unreachable. Check aphexDATA container/service is running." |

### Check 3: Orderflow MCP

Call `orderflow_fetch_regime` with symbol `BTCUSDT` and horizon `H3_MEDIUM`.

| Result | Verdict |
|--------|---------|
| Returns regime object with `regime` field | **pass** — detail: current BTC regime |
| Timeout or error | **fail** — fix: "Orderflow MCP server unreachable. Check orderflow.tradev.app API key and network connectivity." |

### Check 4: Workspace Mount

```bash
cat /workspace/group/instance-config.json 2>/dev/null
```

| Result | Verdict |
|--------|---------|
| File exists and parses as JSON | **pass** |
| Missing or empty | **warn** — fix: "instance-config.json missing. Using defaults (binance futures, 20 pairs). Run exchange-config to create." |

### Check 5: Skills Directory

```bash
ls /workspace/skills/ 2>/dev/null | head -5
```

| Result | Verdict |
|--------|---------|
| Lists skill directories | **pass** — detail: count of skills found |
| Missing or empty | **fail** — fix: "Skills directory not mounted. Check client workspace mapping." |

**Aggregate Tier 1:** If ALL checks fail, set `tier1_all_fail = true` (used to skip Tier 5).

---

## Step 2 — Tier 2: External Connectivity (~20s)

APIs that skills depend on but may have auth, rate-limit, or config issues.

### Check 6: chart-img.com API

```bash
CHART_IMG_KEY=$(printenv CHART_IMG_API_KEY 2>/dev/null)
if [ -z "$CHART_IMG_KEY" ]; then
  echo "NO_KEY"
else
  curl -s -o /tmp/hc-chart-test.png -w "%{http_code}" \
    "https://api.chart-img.com/v2/tradingview/mini-chart?symbol=BINANCE:BTCUSDT&interval=1h&key=${CHART_IMG_KEY}" \
    --max-time 15
  MAGIC=$(xxd -l 4 -p /tmp/hc-chart-test.png 2>/dev/null)
  echo "HTTP:$? MAGIC:$MAGIC"
fi
```

| Result | Verdict |
|--------|---------|
| `CHART_IMG_API_KEY` not set | **fail** — fix: "CHART_IMG_API_KEY env var not set. Chart-vision skill cannot capture snapshots." |
| HTTP 200 + magic bytes `89504e47` | **pass** |
| HTTP 200 but wrong magic bytes | **warn** — fix: "chart-img.com returned non-PNG response. API key may be rate-limited or expired. Check quota at chart-img.com dashboard." |
| HTTP error or timeout | **warn** — fix: "chart-img.com API unreachable or returned error. Check network and API key." |

### Check 7: Supabase TV Webhook

```bash
SUPABASE_URL=$(printenv SUPABASE_URL 2>/dev/null)
if [ -z "$SUPABASE_URL" ]; then
  echo "NO_URL"
else
  HTTP_CODE=$(curl -s -o /tmp/hc-webhook-test.json -w "%{http_code}" \
    -X POST "${SUPABASE_URL}/functions/v1/tv-webhook" \
    -H "Content-Type: application/json" \
    -d '{"test":true}' \
    --max-time 10)
  echo "HTTP:$HTTP_CODE"
  cat /tmp/hc-webhook-test.json 2>/dev/null
fi
```

| Result | Verdict |
|--------|---------|
| `SUPABASE_URL` not set | **warn** — fix: "SUPABASE_URL env var not set. TV signal pipeline cannot receive webhooks." |
| HTTP 200 with JSON response | **pass** |
| HTTP 401 | **fail** — fix: "TV webhook returned 401. Edge function needs verify_jwt=false. Redeploy with: supabase functions deploy tv-webhook --no-verify-jwt" |
| HTTP 500 or timeout | **warn** — fix: "TV webhook edge function returned error. Check Supabase function logs." |

### Check 8: sync_state_to_supabase Availability

Try calling `sync_state_to_supabase` with a known state key to test connectivity.
Use state_key `health_check` with a minimal test payload `{"test": true}`.

| Result | Verdict |
|--------|---------|
| Tool responds successfully | **pass** |
| Tool not found or timeout | **warn** — fix: "sync_state_to_supabase tool unavailable. Dashboard will not receive state updates." |

---

## Step 3 — Tier 3: Pipeline State Freshness (~15s)

Check that workspace state files exist, parse as valid JSON, and are not stale.

For each file, run:
```bash
# Check existence and parse
python3 -c "
import json, os, time, sys
path = sys.argv[1]
max_age_hours = float(sys.argv[2]) if len(sys.argv) > 2 else 0
required = sys.argv[3] == 'true' if len(sys.argv) > 3 else True

if not os.path.exists(path):
    print(f'MISSING:{\"required\" if required else \"optional\"}')
    sys.exit(0)

try:
    with open(path) as f:
        data = json.load(f)
except:
    print('INVALID_JSON')
    sys.exit(0)

if max_age_hours > 0:
    mtime = os.path.getmtime(path)
    age_hours = (time.time() - mtime) / 3600
    if age_hours > max_age_hours:
        print(f'STALE:{age_hours:.1f}h')
        sys.exit(0)

size = os.path.getsize(path)
print(f'OK:{size}')
" "$FILE" "$MAX_AGE" "$REQUIRED"
```

### Files to check:

| # | File | Max Age | Required | Fail/Warn |
|---|------|---------|----------|-----------|
| 9 | `reports/cell-grid-latest.json` | 24h | yes | fail if missing, warn if stale |
| 10 | `auto-mode/roster.json` | — | yes | fail if missing |
| 11 | `auto-mode/deployments.json` | — | yes | fail if missing |
| 12 | `auto-mode/triage-progress.json` | 24h | no | warn if missing/stale |
| 13 | `reports/sentiment-latest.json` | 12h | no | warn if missing/stale |
| 14 | `auto-mode/campaigns.json` | — | yes | fail if missing |
| 15 | `scoring-config.json` | — | no | warn if missing (uses defaults) |
| 16 | `instance-config.json` | — | no | warn if missing (uses defaults) |

Fix messages:

| Condition | Fix |
|-----------|-----|
| Required file missing | "Run monitor to initialize pipeline state. File {name} is required." |
| Optional file missing | "{name} not found. Using defaults. Run {skill} to create." |
| Invalid JSON | "{name} contains invalid JSON. Likely corrupted — delete and let the owning skill regenerate it." |
| Stale (age > threshold) | "{name} is {age}h old (max {threshold}h). Run {skill} to refresh." |

Owning skills for fix messages:
- `cell-grid-latest.json` → market-timing
- `roster.json`, `deployments.json`, `campaigns.json` → monitor
- `triage-progress.json` → strategyzer
- `sentiment-latest.json` → ct-sentiment / macro-sentiment
- `scoring-config.json` → setup/scoring-config-defaults.json (copy)
- `instance-config.json` → exchange-config

---

## Step 4 — Tier 4: Bot Health (~10s)

### Check 17: Bot Count

Read `auto-mode/deployments.json` and count entries where `state` is
`paper_trading` or `shadow`.

| Result | Verdict |
|--------|---------|
| 1-10 active bots | **pass** — detail: "{n} active bots" |
| 0 active bots | **warn** — fix: "No active paper trading bots. Run monitor to deploy from roster." |
| File missing / unreadable | Use Tier 3 result; don't double-count |

### Check 18: Slot Utilization

From `auto-mode/campaigns.json`, count campaigns where `slot_state == "trial"`
and total where `slot_state` is `trial` or `graduated`.

| Result | Verdict |
|--------|---------|
| ≤5 trials AND ≤10 total | **pass** |
| >5 trials | **warn** — fix: "Too many trial bots ({n}/5 max). Monitor should evict lowest-priority trials." |
| >10 total | **warn** — fix: "Exceeding 10-bot slot limit ({n}/10). Monitor should enforce evictions." |

### Check 19: Zombie Bots

From `auto-mode/campaigns.json`, find campaigns where:
- `slot_state == "trial"`
- `deployed_at` is more than 48 hours ago
- `paper_trading.trade_count == 0` (or `paper_pnl.trade_count == 0`)

| Result | Verdict |
|--------|---------|
| No zombies found | **pass** |
| 1+ zombies | **warn** — detail: list strategy names — fix: "Zombie bots detected (0 trades after 48h): {names}. Monitor Trigger I should evict these." |

### Check 20: Win Rate Floor

From `auto-mode/campaigns.json`, find campaigns where:
- `slot_state` is `trial` or `graduated`
- `paper_trading.trade_count >= 5`
- `paper_trading.win_rate < 25`

| Result | Verdict |
|--------|---------|
| None below floor | **pass** |
| 1+ below floor | **warn** — detail: list strategy names — fix: "Bots below 25% win rate floor: {names}. Monitor should retire these." |

---

## Step 4b — Tier 4b: Kata Runner Health (~5s)

Checks the container-native kata optimization pipeline. These checks use
the `kata_list` MCP tool and direct file reads of kata-runner state.

### Check 21: Kata Runner Reachable

Call `kata_list()`.

| Result | Verdict |
|--------|---------|
| Returns `{ races: [...], count: N }` | **pass** — detail: "{N} races tracked" |
| Tool not found | **warn** — fix: "kata_list MCP tool not available. Kata runner MCP server may not be registered. Check agent-runner kata server wiring." |
| Error / timeout | **warn** — fix: "Kata runner IPC directory unreachable. Is the kata-runner enabled on the host?" |

### Check 22: Stuck Races

From the `kata_list()` result, find races where:
- `status == "running"`
- `experiments == 0`
- `started_at` is more than 10 minutes ago

| Result | Verdict |
|--------|---------|
| No stuck races | **pass** |
| 1+ stuck races | **fail** — detail: list race_ids — fix: "Kata races stuck at 0 experiments: {race_ids}. Container likely crashed on startup. Check `docker logs nanoclaw-kata-{race_id}` on the host. Common causes: missing --entrypoint override, bad volume mounts, Python import errors." |

### Check 23: Failed Races

From the `kata_list()` result, find races where:
- `status == "failed"`

| Result | Verdict |
|--------|---------|
| No failed races | **pass** |
| 1+ failed | **warn** — detail: list race_ids with error messages — fix: "Failed kata races: {race_ids}. Check error field for details. Use `kata_stop(race_id, confirm=true)` to clean up." |

### Check 24: Long-Running Races

From the `kata_list()` result, find races where:
- `status == "running"`
- `started_at` is more than 12 hours ago

| Result | Verdict |
|--------|---------|
| No long-running races | **pass** |
| 1+ long-running | **warn** — detail: list race_ids with experiment counts — fix: "Kata races running >12h: {race_ids}. These may be stuck or processing very slowly. Check container logs." |

---

## Step 5 — Tier 5: Browser Automations (~5s)

**Skip this entire tier if `tier1_all_fail == true`** — if infrastructure is
down, browser config checks are irrelevant.

These checks validate environment configuration only. They do NOT launch
browsers or navigate pages.

### Check 25: CHROME_PATH

```bash
CHROME=$(printenv CHROME_PATH 2>/dev/null)
if [ -z "$CHROME" ]; then
  echo "NOT_SET"
elif [ -f "$CHROME" ]; then
  echo "OK:$CHROME"
else
  echo "NOT_FOUND:$CHROME"
fi
```

| Result | Verdict |
|--------|---------|
| Set and file exists | **pass** |
| Not set | **warn** — fix: "CHROME_PATH env var not set. LuxAlgo and X integrations require Chrome. Set to your Chrome executable path." |
| Set but file not found | **fail** — fix: "CHROME_PATH points to {path} but file does not exist. Update to correct Chrome installation path." |

### Check 26: LuxAlgo Auth State

```bash
AUTH_FILE="/workspace/data/luxalgo-auth.json"
if [ ! -f "$AUTH_FILE" ]; then
  echo "MISSING"
else
  AGE_DAYS=$(( ($(date +%s) - $(stat -c %Y "$AUTH_FILE" 2>/dev/null || echo 0)) / 86400 ))
  echo "OK:${AGE_DAYS}d"
fi
```

| Result | Verdict |
|--------|---------|
| Exists and < 7 days old | **pass** |
| Exists but ≥ 7 days old | **warn** — fix: "LuxAlgo auth is {age} days old. Re-run LuxAlgo setup to refresh session." |
| Missing | **warn** — fix: "LuxAlgo auth file missing. Run LuxAlgo setup to authenticate." |

### Check 27: X Auth State

Same pattern as Check 22 but for `data/x-auth.json`.

| Result | Verdict |
|--------|---------|
| Exists and < 7 days old | **pass** |
| Exists but ≥ 7 days old | **warn** — fix: "X auth is {age} days old. Run /x-integration setup to refresh session." |
| Missing | **warn** — fix: "X auth file missing. Run /x-integration setup to authenticate." |

### Check 28: TradingView Session

```bash
TV_SESSION=$(printenv TRADINGVIEW_SESSION_ID 2>/dev/null)
if [ -z "$TV_SESSION" ]; then
  echo "NOT_SET"
else
  echo "OK"
fi
```

| Result | Verdict |
|--------|---------|
| Set | **pass** |
| Not set | **warn** — fix: "TRADINGVIEW_SESSION_ID env var not set. Chart-vision Mode B (custom layouts) requires TradingView session cookies. Set TRADINGVIEW_SESSION_ID and TRADINGVIEW_SESSION_ID_SIGN from browser cookies." |

---

## Step 6 — Aggregate and Report

### 6a. Compute tier statuses

For each tier:
- All checks pass → tier status = `PASS`
- Any check is warn but none fail → tier status = `WARN`
- Any check is fail → tier status = `FAIL`

### 6b. Compute overall status

| Condition | Status |
|-----------|--------|
| All tiers PASS | `HEALTHY` |
| Any WARN but no FAIL | `DEGRADED` |
| Any FAIL | `UNHEALTHY` |

### 6c. Write JSON report

Write the report to `/workspace/group/reports/health-check-latest.json`:

```json
{
  "timestamp": "<ISO>",
  "duration_ms": <elapsed>,
  "summary": {
    "total": 28,
    "pass": <count>,
    "warn": <count>,
    "fail": <count>,
    "status": "HEALTHY|DEGRADED|UNHEALTHY"
  },
  "tiers": {
    "infrastructure": {
      "status": "PASS|WARN|FAIL",
      "checks": [
        { "name": "freqtrade_mcp", "status": "pass", "detail": "v2024.10", "latency_ms": 1200 },
        ...
      ]
    },
    "connectivity": { "status": "...", "checks": [...] },
    "pipeline_state": { "status": "...", "checks": [...] },
    "bot_health": { "status": "...", "checks": [...] },
    "kata_runner": { "status": "...", "checks": [...] },
    "automations": { "status": "...", "checks": [...] }
  },
  "fixes": [
    { "check": "<check_name>", "severity": "warn|fail", "action": "<fix instruction>" },
    ...
  ]
}
```

### 6d. Display console summary

Print a human-readable summary:

```
SYSTEM HEALTH CHECK — <date> <time> UTC
Status: <STATUS> (<pass> pass / <warn> warn / <fail> fail)

  Tier 1: Infrastructure .............. <STATUS>
  Tier 2: Connectivity ................ <STATUS>
  Tier 3: Pipeline State .............. <STATUS>
  Tier 4: Bot Health .................. <STATUS>
  Tier 4b: Kata Runner ................ <STATUS>
  Tier 5: Automations ................. <STATUS>
```

If there are any fixes:

```
  Fix Actions:
  [fail] <check>: <action>
  [warn] <check>: <action>
  ...
```

List fail fixes first, then warn fixes.

### 6e. Sync to dashboard

Call `sync_state_to_supabase` with:
- `state_key`: `health_check`
- `data`: the full JSON report object

This makes the health status visible on the console dashboard.

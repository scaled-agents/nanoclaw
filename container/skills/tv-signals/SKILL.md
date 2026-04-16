---
name: tv-signals
description: >
  Inbound TradingView signal processing. Receives TV webhook alerts, normalizes
  to internal signal schema, runs configurable validation rules (regime check,
  chart-vision, technical-analysis), and routes validated signals to a dedicated
  manual-trade FreqTrade bot. Tracks P&L per TV source.
  Trigger on: "tv signal", "tradingview", "tv webhook", "configure tv",
  "tv source", "external signal", "manual trade", "tv performance",
  "show tv signals", "inbound signal"
---

# TV Signals — Inbound TradingView Signal Processing

Receives TradingView webhook alerts, normalizes the freeform payload into the
internal signal schema, runs a configurable validation pipeline (regime check,
chart-vision, technical-analysis), and routes validated signals to a dedicated
manual-trade FreqTrade bot. Each TV source is tracked for P&L like any other
signal source.

```
TradingView Alert
       │
       ▼
┌─────────────────┐
│ Webhook Endpoint │  /api/webhooks/tv/{source_id}
│  IP + secret     │  validate sender, extract payload
└────────┬────────┘
         ▼
┌─────────────────┐
│  Normalization   │  TV freeform JSON → internal signal schema
│  Field mapping   │  pair, direction, price, SL, TP
└────────┬────────┘
         ▼
┌─────────────────┐
│  Signal Rules    │  composable pipeline per source
│  dedup           │  ✓ default ON
│  regime_check    │  ✓ default ON
│  rate_limit      │  ✓ default ON
│  portfolio_exp   │  ✓ default ON
│  chart_vision    │  ○ opt-in (~15s)
│  technical_anal  │  ○ opt-in (~10s)
└────────┬────────┘
         ▼
    ┌────┴────┐
    │ PASS?   │
    ├─YES─────┤────► freqtrade_place_trade (manual bot)
    │         │      order_tag: "tv_{source_id}_{signal_id}"
    ├─NO──────┤────► log rejection, notify user
    └─────────┘
         ▼
┌─────────────────┐
│   Track & Log    │  tv-signals.json stats, tv-signal-log.jsonl
│   Sync to dash   │  sync_state_to_supabase("tv_signals")
│   Audit trail    │  aphexdata_record_event
└─────────────────┘
```

**Key principle:** TV signals ALWAYS route through signal rules. The pipeline is
consistent regardless of signal origin. Users configure which rules to apply
per source, but cannot bypass the pipeline entirely.

**TV trades do NOT count against the 10-bot slot cap.** They run on a dedicated
manual-trade FreqTrade bot, separate from the autonomous pipeline.

## Prerequisites

| Requirement | Check | Required |
|------------|-------|----------|
| `TV_WEBHOOK_SECRET` | `echo $TV_WEBHOOK_SECRET` — must be non-empty | Yes |
| Manual-trade FreqTrade bot | `freqtrade_fetch_bot_status(bot_id="tv-manual")` — must respond | Yes |
| `market-prior.json` | For regime_check rule | For regime_check |
| `CHART_IMG_API_KEY` | For chart_vision rule | For chart_vision |
| `FINNHUB_API_KEY` | For technical_analysis rule | For technical_analysis |

The manual-trade bot is a dedicated FreqTrade instance running the `TVManualTrade`
no-op strategy. It accepts only forced trades via `freqtrade_place_trade`. It starts
in `dry_run: true` (paper mode) by default. See the `add-tv-signals` installer for
setup instructions.

## Tools

### tv_source_register(source_id, name, secret, allowed_pairs[], signal_rules[]?, rule_mode?, stake_pct?, allow_exit_signals?, dry_run?)

Register a new TradingView webhook source. Returns the source config with the
webhook URL to configure in TradingView.

**Parameters:**
- `source_id` (required) — unique identifier, used in webhook URL
- `name` (required) — human-readable name
- `secret` (required) — shared secret for payload verification
- `allowed_pairs` (required) — pairs this source can signal on (FreqTrade format)
- `signal_rules` (optional, default from scoring-config) — rules to run: `["dedup", "regime_check", "rate_limit", "portfolio_exposure", "chart_vision", "technical_analysis"]`
- `rule_mode` (optional, default `"all_pass"`) — `"all_pass"` requires all rules to pass
- `stake_pct` (optional, default 5.0) — stake percentage per trade
- `allow_exit_signals` (optional, default `false`) — accept TV exit/close alerts
- `dry_run` (optional, default `true`) — paper trade mode

**Returns:** source config with `webhook_url: "/api/webhooks/tv/{source_id}"`

### tv_source_list()

List all configured TV source connections with delivery stats.

### tv_source_update(source_id, ...)

Update an existing source's config (allowed_pairs, signal_rules, stake_pct, status, etc.).

### tv_source_delete(source_id, confirm=true)

Remove a TV source connection permanently.

### tv_signal_history(source_id?, pair?, direction?, passed?, since?, limit?)

Query the signal log with filters. Returns matching entries from `tv-signal-log.jsonl`.

## Signal Schema

### Normalized internal signal

After normalization, every TV signal becomes:

```json
{
  "signal_id": "tvs_<uuid>",
  "source_id": "carlos-tv-main",
  "signal_type": "entry",
  "pair": "BTC/USDT:USDT",
  "timeframe": "4h",
  "direction": "long",
  "price": 83150.0,
  "stop_loss": 80000.0,
  "take_profit": 87000.0,
  "source_strategy": "EMA Cross + RSI Filter",
  "received_at": "2026-04-12T14:30:00Z"
}
```

### Exit signal (when `allow_exit_signals: true`)

```json
{
  "signal_id": "tvs_<uuid>",
  "source_id": "carlos-tv-main",
  "signal_type": "exit",
  "pair": "BTC/USDT:USDT",
  "direction": "long",
  "price": 85200.0,
  "exit_reason": "take_profit",
  "received_at": "2026-04-12T18:45:00Z"
}
```

---

## Workflow

### Step 0: Load Context

```bash
cat {WORKSPACE}/auto-mode/tv-signals.json 2>/dev/null || echo '[]'
cat {WORKSPACE}/auto-mode/market-prior.json 2>/dev/null || echo '{"regimes":{}}'
cat {WORKSPACE}/scoring-config.json 2>/dev/null || echo '{}'
ls {WORKSPACE}/auto-mode/tv-inbox/*.json 2>/dev/null
```

Read `TV_SIGNALS` config from `scoring-config.json`, falling back to
`scoring-config-defaults.json` for missing keys.

### Step 0.5: Scan Inbox for Pending Signals

Signals arrive via the **Supabase relay** (TradingView → Edge Function →
Supabase → NanoClaw poller → local inbox files). The poller writes each
signal to `{WORKSPACE}/auto-mode/tv-inbox/{signal_id}.json`.

**When this skill is triggered** (by chat message, monitor tick, or any
trigger phrase), scan the inbox directory:

```bash
ls {WORKSPACE}/auto-mode/tv-inbox/*.json 2>/dev/null
```

For each `.json` file found:

1. Read the file. It contains:
   ```json
   {
     "signal_id": "tvs_abc123",
     "source_id": "buy-sell-signal",
     "received_at": "2026-04-12T14:30:00Z",
     "raw_payload": { "...original TV JSON..." },
     "source_config": {
       "source_id": "buy-sell-signal",
       "name": "Buy/Sell Signal",
       "signal_rules": ["dedup", "regime_check", "rate_limit", "portfolio_exposure", "chart_vision", "technical_analysis"],
       "rule_mode": "all_pass",
       "allowed_pairs": ["ETH/USDT:USDT", "BTC/USDT:USDT"],
       "stake_pct": 5.0,
       "allow_exit_signals": false,
       "dry_run": true
     }
   }
   ```

2. Use `source_config` from the inbox file (preferred — carries the latest
   dashboard config). Fall back to looking up `source_id` in `tv-signals.json`
   only if `source_config` is missing.

3. Verify `source.status == "active"` — if paused or disabled, skip the
   file and log `reason: "source_not_active"`.

4. **Immediately emit the `tv_signal_received` event** (Step 5d) so the
   dashboard shows the signal right away — before running rules.

5. Proceed to **Step 2 (Normalize)** with `raw_payload` as the TV payload.

6. After processing (pass or fail), **delete the inbox file** to prevent
   re-processing:
   ```bash
   rm {WORKSPACE}/auto-mode/tv-inbox/{signal_id}.json
   ```

**Important:** Sender validation (IP, secret, source existence) was already
performed by the Supabase edge function (`tv-webhook`). The inbox file is
pre-authenticated — skip Step 1 sender validation for inbox signals.

If no inbox files exist, the skill can still be invoked for source
management commands (list, register, update, delete, history).

### Step 1: Receive & Validate Sender (webhook mode)

> **Note:** This step applies only to direct webhook delivery. When
> processing signals from the inbox (Step 0.5), skip to Step 2.

The client provides an HTTP endpoint at `/api/webhooks/tv/{source_id}`. When a
TradingView alert fires, it POSTs JSON to this URL.

**Client-side validation (before skill sees the payload):**
1. Match `source_id` to a registered source in `tv-signals.json`
2. Verify sender IP against TradingView's known ranges (optional, configurable)
3. Verify `secret` field in payload body matches `source.secret_hash` (SHA-256)
4. Check `source.status == "active"` — reject if paused or disabled
5. Return HTTP 200 immediately (acknowledge receipt to prevent TV retries)
6. Forward raw payload to the skill for processing

If validation fails, return HTTP 401/403 and log the attempt.

### Step 2: Normalize

TradingView alerts are freeform JSON — the user defines the payload shape in the
Pine Script alert message. The skill normalizes common patterns:

| TV field (common patterns) | Internal field | Required |
|---|---|---|
| `ticker`, `symbol`, `pair` | `pair` | Yes |
| `interval`, `timeframe`, `resolution` | `timeframe` | No (default from source config) |
| `strategy.order.action`, `action`, `side` | `direction` | Yes |
| `close`, `price`, `entry`, `entry_price` | `price` | Yes |
| `stoploss`, `sl`, `stop`, `stop_loss` | `stop_loss` | No |
| `takeprofit`, `tp`, `target`, `take_profit` | `take_profit` | No |
| `strategy.order.comment`, `comment`, `strategy_name` | `source_strategy` | No |
| `time`, `timestamp`, `timenow` | `received_at` | No (use server time) |

**Pair conversion:** Convert to FreqTrade format using `instance-config.json`:
- `BTCUSDT` → `BTC/USDT:USDT` (futures, from `exchange.pair_suffix`)
- `BINANCE:BTCUSDT` → strip exchange prefix first
- `BTC/USDT` → append suffix from config

**Timeframe mapping:**
- `1` / `1m` → `1m`, `5` / `5m` → `5m`, `15` / `15m` → `15m`
- `60` / `1H` / `1h` → `1h`, `240` / `4H` / `4h` → `4h`
- `D` / `1D` → `1d`, `W` / `1W` → `1w`

**Direction mapping:**
- `buy`, `long`, `LONG`, `1` → `long`
- `sell`, `short`, `SHORT`, `-1` → `short`
- `close`, `exit`, `close_long`, `close_short` → `exit` (only if `allow_exit_signals`)

**Rejection:** If a required field (`pair`, `direction`) cannot be extracted after
trying all pattern variants, reject the signal with `reason: "normalization_failed"`
and log the raw payload for debugging.

**Generate signal_id:** `tvs_<8-char random hex>` — unique per signal.

### Step 3: Signal Rules Pipeline

The rules pipeline is composable. Each TV source configures which rules to run
via `source.signal_rules[]`. The default set comes from
`scoring-config.TV_SIGNALS.default_signal_rules`.

**Evaluation mode:** `all_pass` (default) — ALL enabled rules must pass.

Run rules in order (cheap rules first to fail fast):

---

#### Rule: `dedup`

Reject duplicate signals within a time window. TradingView occasionally sends
duplicate alerts from script re-evaluation or webhook retries.

**Check:** Search `tv-signal-log.jsonl` for a matching signal within
`dedup_window_seconds` (default 300s). Match key:
`{source_id, pair, direction, price_bucket}` where `price_bucket = round(price / (price * 0.001))`.

For exit signals, match key changes to: `{source_id, pair, "exit"}`.

**Pass:** No duplicate found in window.
**Fail:** `{ "passed": false, "reason": "duplicate_within_window", "original_signal_id": "tvs_..." }`

---

#### Rule: `regime_check`

Check current market regime for the signal's pair. Uses `market-prior.json`
(written by monitor Step 2).

**Map timeframe to horizon:**
- `5m`, `15m` → `H1_MICRO`
- `1h` → `H2_SHORT`
- `4h`, `1d` → `H3_MEDIUM`

**Read regime:** `market_prior.regimes[base_symbol][horizon]`

TV signals are discretionary (not tied to a specific archetype), so the regime
check uses a simplified compatibility matrix:

```
CHAOS + conviction >= block_chaos_min_conviction (60)  → BLOCK
CHAOS + conviction < 60                                → WARN (pass with sizing 0.7×)
Any regime + conviction < min_conviction (40)           → WARN (low conviction)
EFFICIENT_TREND, TRANQUIL, COMPRESSION                  → PASS
```

**Config keys (from `scoring-config.TV_SIGNALS.regime_check`):**
- `block_anti_regime` (default true) — enable blocking
- `block_chaos_min_conviction` (default 60) — CHAOS conviction threshold for blocking
- `min_conviction` (default 40) — minimum conviction for any regime

**Pass:** Regime is compatible.
**Fail:** `{ "passed": false, "reason": "chaos_regime_blocked", "regime": "CHAOS", "conviction": 85 }`

---

#### Rule: `rate_limit`

Prevent signal floods from misconfigured Pine Scripts or runaway alerts.

**Check:**
- Count signals from this source in the last hour (from `tv-signal-log.jsonl`)
- Count all TV signals globally in the last hour

**Pass:** Both counts below thresholds.
**Fail:** `{ "passed": false, "reason": "rate_limit_exceeded", "source_count": 6, "limit": 5 }`

**Config keys:**
- `rate_limit_per_hour` (default 10) — global cap
- `rate_limit_per_source_per_hour` (default 5) — per-source cap

---

#### Rule: `portfolio_exposure`

Prevent over-concentration in TV trades.

**Check:** Call `freqtrade_fetch_bot_status(bot_id="tv-manual")` to get open positions.
Count open TV trades, total exposure %, and per-pair trades.

**Pass:** All below limits.
**Fail:** `{ "passed": false, "reason": "max_open_tv_trades_exceeded", "open": 5, "limit": 5 }`

**Config keys (from `scoring-config.TV_SIGNALS.portfolio_exposure`):**
- `max_open_tv_trades` (default 5)
- `max_tv_capital_pct` (default 25)
- `max_per_pair_tv_trades` (default 2)

---

#### Rule: `chart_vision` (opt-in)

Run the chart-vision skill on the signal's pair and timeframe. This captures a
TradingView chart snapshot and performs visual analysis.

**Invoke:** Follow chart-vision Step 1-4 workflow for the signal's pair/timeframe.

**Chart mode selection:**
- If `source_config.rule_config.chart_vision.layout_id` exists → use **Mode B**
  (layout chart) with that layout ID. This captures the user's exact TradingView
  setup with all saved indicators and drawings.
- Otherwise → use **Mode A** (advanced chart) with default indicators.

**Custom analysis guidelines:**
- If `source_config.rule_config.chart_vision.custom_prompt` exists → append it
  to the chart analysis prompt as **"Additional Analysis Guidelines"**. The agent
  MUST consider these guidelines when interpreting the chart and forming a
  directional bias. Example: "Don't go long when ALTS BUY SIGNAL is red/pink."

Read `deployment_gate_input` from `{WORKSPACE}/reports/chart-analysis-latest.json`.

**Check:**
- `visual_confirmation` should be `true`
- If `require_directional_alignment`: `directional_bias` must match signal direction
  (or be `"neutral"` — neutral always passes)
- `confidence` must meet `min_confidence` threshold (`"low"` < `"medium"` < `"high"`)

**Pass:** Visual analysis confirms the signal direction.
**Fail:** `{ "passed": false, "reason": "chart_vision_directional_mismatch", "signal_direction": "long", "chart_bias": "short" }`

**Sizing modifier:** If passed, apply `deployment_gate_input.recommended_sizing_modifier`
to the trade sizing.

**Config keys (from `scoring-config.TV_SIGNALS.chart_vision`):**
- `require_directional_alignment` (default true)
- `min_confidence` (default `"medium"`)

---

#### Rule: `technical_analysis` (opt-in)

Run the technical-analysis skill on the signal's pair. This calls Finnhub's
4 premium TA endpoints for quantitative indicators.

**Invoke:** Follow technical-analysis Step 1-5 workflow for the signal's pair.
Read `deployment_gate_input` from `{WORKSPACE}/reports/technical-analysis-latest.json`.

**Check:**
- `data_confirmation` should be `true`
- If `require_directional_alignment`: `directional_bias` must match signal direction
  (or be `"neutral"`)
- `confluence_count` must meet `min_confluence_count` threshold

**Pass:** Quantitative analysis confirms the signal.
**Fail:** `{ "passed": false, "reason": "low_confluence", "confluence_count": 1, "required": 2 }`

**Sizing modifier:** If passed, apply `deployment_gate_input.recommended_sizing_modifier`
to the trade sizing.

**Config keys (from `scoring-config.TV_SIGNALS.technical_analysis`):**
- `require_directional_alignment` (default true)
- `min_confluence_count` (default 2)

---

### Step 4: Execute Trade

If all rules pass:

**Pre-flight: verify tv-manual bot is reachable.**
```
bot_status = freqtrade_fetch_bot_status(bot_id="tv-manual")
If bot_status fails or returns an error:
  Log: "tv-manual bot unreachable — cannot execute signal {signal_id}"
  Record signal as validated_but_not_executed, reason: "bot_unavailable"
  STOP (do not attempt place_trade)
```

**Compute final sizing:**
```
base_stake_pct = source.stake_pct (default 5.0, this is a PERCENTAGE)
sizing_modifier = 1.0

If chart_vision ran and passed:
  sizing_modifier *= chart_vision.recommended_sizing_modifier

If technical_analysis ran and passed:
  sizing_modifier *= technical_analysis.recommended_sizing_modifier

If regime_check warned (low conviction or CHAOS < threshold):
  sizing_modifier *= 0.7

final_stake_pct = clamp(base_stake_pct * sizing_modifier,
                        config.sizing.min_stake_pct,
                        config.sizing.max_stake_pct)

# Convert percentage to absolute stake currency (USDT)
wallet = freqtrade_fetch_balance(bot_id="tv-manual")
wallet_total = wallet.total (available balance in stake currency)
stake_amount = wallet_total * final_stake_pct / 100
```

**Entry signal:**
```
freqtrade_place_trade(
  bot_id: "tv-manual",
  pair: normalized.pair,
  side: normalized.direction,
  stake_amount: stake_amount,
  confirm: true,
  price: null,                           # market order
  stoploss: normalized.stop_loss || null,
  takeprofit: normalized.take_profit || null,
  order_tag: "tv_{source_id}_{signal_id}"
)
```

**Exit signal (when `allow_exit_signals: true` and `signal_type == "exit"`):**

Match open position by pair + direction on the manual trade bot:
```
freqtrade_force_exit(
  bot_id: "tv-manual",
  pair: normalized.pair,
  side: normalized.direction,
  order_tag: "tv_exit_{source_id}_{signal_id}"
)
```

If no matching open position exists, log `reason: "no_matching_position"` and skip.

### Step 5: Track & Log

**5a. Append to signal log:**

Write to `{WORKSPACE}/auto-mode/tv-signal-log.jsonl`:
```json
{
  "signal_id": "tvs_abc123",
  "source_id": "carlos-tv-main",
  "received_at": "2026-04-12T14:30:00Z",
  "signal_type": "entry",
  "raw_payload": { "...original TV JSON..." },
  "normalized": {
    "pair": "BTC/USDT:USDT",
    "timeframe": "4h",
    "direction": "long",
    "price": 83150.0,
    "stop_loss": 80000.0,
    "take_profit": 87000.0,
    "source_strategy": "EMA Cross + RSI Filter"
  },
  "validation": {
    "rules_executed": ["dedup", "regime_check", "chart_vision"],
    "results": {
      "dedup": { "passed": true, "reason": "no_duplicate_in_window" },
      "regime_check": { "passed": true, "regime": "EFFICIENT_TREND", "conviction": 72 },
      "chart_vision": { "passed": true, "bias": "long", "confidence": "high", "sizing_modifier": 1.0 }
    },
    "overall_passed": true,
    "final_sizing_modifier": 1.0
  },
  "execution": {
    "executed": true,
    "trade_id": "trade_xyz",
    "bot_id": "tv-manual",
    "stake_pct": 5.0,
    "execution_price": 83175.0,
    "slippage_pct": 0.03,
    "executed_at": "2026-04-12T14:30:05Z"
  },
  "outcome": {
    "closed": false,
    "exit_price": null,
    "profit_pct": null,
    "exit_reason": null,
    "closed_at": null
  }
}
```

**5b. Update source stats:**

In `{WORKSPACE}/auto-mode/tv-signals.json`, update the matching source entry:
```
source.stats.signals_received += 1
If validated:  source.stats.signals_validated += 1
If rejected:   source.stats.signals_rejected += 1
If executed:   source.stats.signals_executed += 1
source.stats.last_signal_at = now
```

P&L stats (`pnl_pct`, `win_rate`, `trade_count`) are updated by monitor Step 3
when trades close on the manual bot.

**5c. Agent feed:**

Post status updates at key moments:
```
agent_post_status(
  status: "TV SIGNAL received: long BTC/USDT from Carlos TV",
  tags: ["tv_signal", "received"]
)
```

Post at: signal received, validated, rejected (with reason), executed.

**5d. Audit trail — granular verb_ids:**

Log each stage with its own verb_id so the dashboard can filter and notify:

On signal arrival:
```
aphexdata_record_event(
  verb_id: "tv_signal_received",
  verb_category: "execution",
  object_type: "signal",
  object_id: signal_id,
  result_data: { source_id, pair, direction, price, timeframe }
)
```

After rule validation passes:
```
aphexdata_record_event(
  verb_id: "tv_signal_validated",
  verb_category: "execution",
  object_type: "signal",
  object_id: signal_id,
  result_data: { source_id, pair, direction, rules_passed, sizing_modifier }
)
```

After rule validation fails:
```
aphexdata_record_event(
  verb_id: "tv_signal_rejected",
  verb_category: "execution",
  object_type: "signal",
  object_id: signal_id,
  result_data: { source_id, pair, direction, failed_rules, reasons }
)
```

After trade execution on manual bot:
```
aphexdata_record_event(
  verb_id: "tv_signal_executed",
  verb_category: "execution",
  object_type: "trade",
  object_id: signal_id,
  result_data: { source_id, pair, direction, stake_pct, execution_price, trade_id }
)
```

**5e. Sync to dashboard:**
```
sync_state_to_supabase(state_key="tv_signals", file="tv-signals.json")
```

---

## Source Management

### Configure a new TV source

User says: "Add a TradingView source for my BTC and ETH alerts"

```
tv_source_register(
  source_id: "carlos-btc-eth",
  name: "Carlos BTC/ETH Alerts",
  secret: "my-secret-key-123",
  allowed_pairs: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  signal_rules: ["dedup", "regime_check", "chart_vision"],
  stake_pct: 5.0,
  allow_exit_signals: false,
  dry_run: true
)
```

Returns:
```json
{
  "source_id": "carlos-btc-eth",
  "webhook_url": "/api/webhooks/tv/carlos-btc-eth",
  "status": "active",
  "instructions": "In TradingView, create an alert with webhook URL: https://your-server.com/api/webhooks/tv/carlos-btc-eth"
}
```

### TradingView alert message template

Provide this to the user for their Pine Script alert configuration:

```json
{
  "secret": "my-secret-key-123",
  "ticker": "{{ticker}}",
  "interval": "{{interval}}",
  "action": "{{strategy.order.action}}",
  "price": {{close}},
  "comment": "{{strategy.order.comment}}"
}
```

For manual alerts (non-strategy):
```json
{
  "secret": "my-secret-key-123",
  "ticker": "{{ticker}}",
  "interval": "{{interval}}",
  "action": "buy",
  "price": {{close}},
  "stoploss": 80000,
  "takeprofit": 87000,
  "comment": "Manual alert - EMA crossover"
}
```

### View TV source performance

User says: "Show TV signal performance" or "TV stats"

```
tv_source_list()
```

Render as:
```
TV SIGNAL SOURCES
  carlos-btc-eth    active   42 received, 35 validated (83%), 33 executed
                             P&L: +2.1%, Win: 58%, Trades: 33
                             Last signal: 2h ago

  scalping-alerts   paused   18 received, 12 validated (67%), 10 executed
                             P&L: -0.4%, Win: 40%, Trades: 10
                             Paused: win_rate below 25% threshold
```

### View signal history

User says: "Show recent TV signals" or "TV signal log for BTC"

```
tv_signal_history(pair="BTC/USDT:USDT", limit=10)
```

---

## Edge Cases

### Duplicate alerts

TradingView can send duplicate alerts from:
- Script re-evaluation on the same bar
- Multiple alert conditions firing simultaneously
- Webhook retry on timeout (if endpoint didn't return 200 fast enough)

The `dedup` rule handles this with a configurable time window (default 5 minutes).
Price matching uses buckets (0.1% tolerance) to catch near-identical signals.

### Malformed payload

If the TV payload cannot be normalized (missing required fields), the signal is
logged with `overall_passed: false, reason: "normalization_failed"` and the raw
payload is preserved for debugging. The user is notified via agent feed.

### Manual-trade bot offline

If `freqtrade_fetch_bot_status(bot_id="tv-manual")` fails or returns no response:
- Log the signal as validated but not executed
- Post warning: "TV signal validated but manual-trade bot is offline. Signal logged but not executed."
- Do NOT retry — the signal is time-sensitive. Stale signals are worse than missed signals.

### Rule timeout

If chart_vision or technical_analysis takes > 60 seconds:
- Skip the slow rule and continue with remaining rules
- Log `{ "passed": null, "reason": "timeout" }` for the timed-out rule
- In `all_pass` mode, a `null` result is treated as a pass (fail-open for optional rules)

### Pair not in allowed list

If the normalized pair is not in `source.allowed_pairs`:
- Reject with `reason: "pair_not_allowed"`
- This prevents misconfigured TV alerts from trading unexpected pairs

---

## Rules

- TV signals ALWAYS route through the configured signal rules — no bypass
- The manual-trade bot runs in `dry_run: true` by default — switch to live manually
- TV trades are isolated from the 10-bot autonomous pipeline
- Exit signals require explicit opt-in via `allow_exit_signals: true` per source
- Secrets live in `.env` only, forwarded via `-e` flags, NEVER committed
- Signal log is append-only — never delete entries, only add outcomes
- P&L tracking is updated by monitor Step 3, not by this skill directly
- Rate limits protect against misconfigured Pine Scripts flooding the system

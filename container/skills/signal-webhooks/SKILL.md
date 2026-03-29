# Signal Webhooks — Outbound Signal Delivery

Push trading signals from your paper bots to external services in real-time.

## Tools

### webhook_create(name, url, deployment_ids?, format?, events?, headers?)
Create a webhook. Returns config with auto-generated signing secret.

### webhook_list()
Show all webhooks with delivery stats.

### webhook_test(webhook_id)
Send a test payload to verify the endpoint works.

### webhook_delete(webhook_id, confirm=true)
Remove a webhook permanently.

## Common Setups

### Katoshi (Hyperliquid execution)
```
webhook_create(
  name: "Katoshi Hyperliquid",
  url: "https://api.katoshi.ai/v1/signals/webhook",
  format: "katoshi",
  deployment_ids: ["wolfclaw-xrp-1h"],
  headers: { "X-Api-Key": "{{KATOSHI_API_KEY}}" }
)
```
Add KATOSHI_API_KEY to your .env file.

### Telegram Bot
```
webhook_create(
  name: "Trading Alerts Telegram",
  url: "https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage",
  format: "standard",
  deployment_ids: [],
  headers: {}
)
```
Note: You'll need a Telegram relay that converts the standard
payload into a sendMessage call. Or use a service like IFTTT.

### Google Sheets (via Apps Script)
```
webhook_create(
  name: "Signal Log Sheet",
  url: "https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec",
  format: "standard",
  events: { entry: true, exit: true }
)
```

### Another NanoClaw Instance
```
webhook_create(
  name: "Remote NanoClaw",
  url: "https://your-server.com/api/signals/inbound",
  format: "standard",
  headers: { "Authorization": "Bearer {{REMOTE_API_KEY}}" }
)
```

## Monitoring

Webhook stats are in webhook_list() output:
- deliveries_total / deliveries_ok / deliveries_failed
- consecutive_failures (auto-disables at 10)
- last_delivery_at / last_failure_reason

Auto-mode health checks report webhook status. If a webhook is
auto-disabled due to failures, you'll get a notification.

## Signature Verification

All payloads are signed with HMAC-SHA256. The signature is in
the X-Webhook-Signature header. Recipients should verify:

```python
import hmac, hashlib

def verify_signature(payload_body, signature_header, secret):
    expected = 'sha256=' + hmac.new(
        secret.encode(), payload_body.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header)
```

## Payload Format (Standard)

```json
{
  "event_id": "evt_...",
  "event_type": "signal.entry | signal.exit",
  "timestamp": "ISO 8601",
  "webhook_id": "wh_...",
  "signal": {
    "direction": "long | short",
    "pair": "XRP/USDT:USDT",
    "exchange": "binance",
    "timeframe": "1h",
    "strategy": "WolfClaw_XRP_1h_...",
    "entry_price": 0.58,
    "exit_price": 0.59,
    "profit_pct": 1.7,
    "exit_reason": "signal"
  },
  "context": {
    "regime": "EFFICIENT_TREND",
    "conviction": 72,
    "composite_score": 4.2,
    "direction": "BULLISH",
    "archetype": "TREND_MOMENTUM"
  },
  "performance": {
    "paper_profit_pct": 3.2,
    "paper_trade_count": 15,
    "paper_win_rate": 60,
    "wf_sharpe": 0.85
  },
  "source": {
    "agent": "wolf",
    "deployment_id": "wolfclaw-xrp-1h",
    "bot_container": "nanoclaw-bot-wolfclaw-xrp-1h",
    "dry_run": true
  }
}
```

## Rules

- Webhooks only fire on NEW trades (trade_count increase detected by bot-runner health check)
- Test with webhook_test before going live
- Keep API keys in .env, reference with {{VAR}} in headers
- Auto-disabled webhooks (10 consecutive failures) need URL fix + re-creation
- Signal delivery latency: 30-90 seconds from trade to delivery (bot-runner polls every 60s)
- Empty deployment_ids array = all bots trigger this webhook

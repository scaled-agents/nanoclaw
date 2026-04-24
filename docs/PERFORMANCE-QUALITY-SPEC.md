# NanoClaw Performance & Quality Specification

> Generated: 2026-03-20 | Audit scope: Full codebase (host, container, agent-runner, MCP, build)

## Overview

Comprehensive audit of NanoClaw's performance bottlenecks, reliability gaps, and quality improvement opportunities. Findings organized by category with severity, impact estimates, and file-level references.

---

## 1. Container Startup Speed

### 1.1 TypeScript Recompilation on Every Spawn — HIGH
- **File:** `container/Dockerfile:90` (entrypoint.sh)
- **Issue:** `npx tsc --outDir /tmp/dist` runs inside the entrypoint on every container startup, recompiling the agent-runner TypeScript source
- **Impact:** ~10 seconds added to every container spawn
- **Fix:** Pre-build TypeScript during `docker build` (line 81 already does this). Remove the entrypoint recompilation and mount the pre-built dist directly. Only recompile if agent-runner source has been customized per-group.

### 1.2 Skills Sync Blocking I/O — HIGH
- **File:** `src/container-runner.ts:150-173`
- **Issue:** `fs.cpSync()` synchronously copies ALL skills from `container/skills/` to each group's `.claude/skills/` on every container spawn. Also scans destination for stale skills to remove.
- **Impact:** 200ms+ blocking I/O per container spawn (scales with number of skills)
- **Fix:** Use content hashing or mtime comparison to skip unchanged skills. Cache last-sync state per group.

### 1.3 Agent-Runner Source Re-Sync — MEDIUM
- **File:** `src/container-runner.ts:196-210`
- **Issue:** `fs.cpSync()` copies entire `agent-runner/src/` to a per-group writable location on every spawn, even if unchanged
- **Impact:** 50-150ms per spawn
- **Fix:** Hash-based change detection. Only re-sync when source files change (compare directory mtime or content hash).

### 1.4 Settings.json Created Every Invocation — LOW
- **File:** `src/container-runner.ts:126-148`
- **Issue:** Settings file checked/created on every container spawn even when it already exists
- **Impact:** 5-10ms per spawn
- **Fix:** Check existence once at startup, only re-create on config change.

### 1.5 MCP Servers Always Spawned — HIGH
- **File:** `container/agent-runner/src/index.ts:330-365`
- **Issue:** Freqtrade MCP (Python) always initialized, even for non-trading queries. The Python process imports heavy dependencies (freqtrade, ta-lib).
- **Impact:** 5-10 seconds startup penalty per container
- **Fix:** Make MCP servers conditional on env flags (like aphexDATA already is). Or lazy-spawn Python MCPs on first tool call.

### 1.6 Volume Mount Path Construction — LOW
- **File:** `src/container-runner.ts:60-252`
- **Issue:** 20+ VolumeMount objects built per container with multiple `fs.existsSync()` and `mkdirSync()` calls
- **Impact:** Minor (~20ms) but compounds
- **Fix:** Memoize mount configuration per group. Invalidate on group config change.

---

## 2. Host-Side Efficiency

### 2.1 Missing Database Index on (chat_jid, timestamp) — MEDIUM
- **File:** `src/db.ts:26-37`
- **Issue:** Messages table has index on `timestamp` only, but `getMessagesSince()` filters by `chat_jid = ? AND timestamp > ?`. Without a composite index, SQLite scans the timestamp index and filters.
- **Impact:** Slow message queries as message table grows
- **Fix:** `CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp)`

### 2.2 getAllRegisteredGroups() JSON.parse on Every Call — MEDIUM
- **File:** `src/db.ts:601-635`
- **Issue:** Called from IPC processing and task scheduler on every cycle. Parses `container_config` JSON for every group row each time.
- **Impact:** 1000+ JSON.parse() calls per scheduler cycle with many tasks/groups
- **Fix:** Cache result at startup, update on group registration IPC events.

### 2.3 getAllChats() Full Table Scan — MEDIUM
- **File:** `src/db.ts:226-235`
- **Issue:** `SELECT * FROM chats ORDER BY last_message_time DESC` with no LIMIT. Called from `getAvailableGroups()` during every container execution.
- **Impact:** Full table materialization; slow with 1000+ chats
- **Fix:** Add `LIMIT 500` or implement pagination.

### 2.4 State Saved After Every Group Processing — MEDIUM
- **File:** `src/index.ts:187-189, 428-430`
- **Issue:** `saveState()` writes to DB after each group's message processing. With 10 concurrent groups, that's 10+ DB writes per poll cycle.
- **Impact:** Unnecessary DB write amplification
- **Fix:** Batch state saves — defer until end of each poll cycle.

### 2.5 IPC Watcher Uses fs.statSync() in Loop — MEDIUM
- **File:** `src/ipc.ts:43-46`
- **Issue:** `fs.readdirSync()` followed by `fs.statSync()` for every entry to check if it's a directory. Runs every 1 second.
- **Impact:** 150+ stat() calls/second with many groups
- **Fix:** `fs.readdirSync(dir, { withFileTypes: true })` eliminates stat calls.

### 2.6 No Re-entrancy Guard on IPC Processing — HIGH
- **File:** `src/ipc.ts:39-150`
- **Issue:** `processIpcFiles()` scheduled via `setTimeout()` on fixed interval. If processing takes longer than interval, next invocation starts before previous completes.
- **Impact:** Concurrent IPC processing, potential duplicate message sends
- **Fix:** Add `isProcessing` flag, skip if previous cycle still running.

### 2.7 getDueTasks() No LIMIT Clause — LOW
- **File:** `src/db.ts:455-465` (via `src/task-scheduler.ts:253`)
- **Issue:** `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ? ORDER BY next_run` with no LIMIT
- **Impact:** Orders entire result set even if only a few tasks are due
- **Fix:** Add `LIMIT 100`.

### 2.8 task_run_logs Unbounded Growth — MEDIUM
- **File:** `src/db.ts:56-66`
- **Issue:** No retention policy. Logs grow indefinitely (~2160 rows/task/month at 3x/hour).
- **Impact:** 100K+ rows accumulate, slowing queries over time
- **Fix:** Add cleanup: `DELETE FROM task_run_logs WHERE run_at < datetime('now', '-30 days')` on scheduler startup or daily.

### 2.9 Sequential Channel Connection at Startup — MEDIUM
- **File:** `src/index.ts:582-594`
- **Issue:** Channels connected sequentially with `await channel.connect()` in a for-loop
- **Impact:** Startup blocked by slowest channel (WhatsApp ~2-3s)
- **Fix:** `await Promise.all(channels.map(ch => ch.connect()))`.

### 2.10 Orphan Container Cleanup Blocking Startup — HIGH
- **File:** `src/container-runtime.ts:104-127`
- **Issue:** `execSync()` for docker ps + docker stop for each orphan. Blocking, synchronous.
- **Impact:** 10+ seconds if many orphans
- **Fix:** Use `execAsync()` or move to background. Non-blocking cleanup.

---

## 3. Reliability & Graceful Shutdown

### 3.1 Polling Loops Not Terminated on Shutdown — HIGH
- **File:** `src/index.ts:486-495`
- **Issue:** `shutdown()` calls `queue.shutdown()` and disconnects channels, but `startMessageLoop()` and `startSchedulerLoop()` (infinite loops via setTimeout) are never stopped.
- **Impact:** Loops may continue executing during shutdown, causing race conditions
- **Fix:** Add `isShuttingDown` flag checked by both loops. Clear pending timeouts.

### 3.2 WhatsApp Event Listeners Not Cleaned on Reconnect — MEDIUM
- **File:** `src/channels/whatsapp.ts:87, 175, 177`
- **Issue:** `.ev.on()` handlers registered on each `connectInternal()` call without removing old ones. New listeners stack on reconnect.
- **Impact:** Memory leak after multiple reconnections; duplicate message processing possible
- **Fix:** Store listener references, call `.ev.off()` before re-registering. Or use `.ev.once()` where appropriate.

### 3.3 WhatsApp setInterval Not Cleared on Reconnect — MEDIUM
- **File:** `src/channels/whatsapp.ts:160-164`
- **Issue:** Group sync `setInterval()` created on connect but never cleared. Guard flag prevents multi-start but old timers survive reconnects.
- **Impact:** Stale intervals after reconnection
- **Fix:** Store interval ID, `clearInterval()` on disconnect.

### 3.4 Container Spawn Errors Not Sent to User — HIGH
- **File:** `src/container-runner.ts:717-728`
- **Issue:** Container spawn errors logged but never sent as a message to the user. User sees silence when their message fails.
- **Impact:** User doesn't know their message wasn't processed
- **Fix:** In the error handler, call `sendMessage()` with a brief error notification.

### 3.5 Max Retries Silently Drops Messages — HIGH
- **File:** `src/group-queue.ts:263-284`
- **Issue:** After MAX_RETRIES (5), messages are silently dropped. No notification to user or admin.
- **Impact:** User's messages disappear without explanation
- **Fix:** Send user a message: "I'm having trouble processing your message. Please try again later."

### 3.6 Signal Handlers Not Debounced — LOW
- **File:** `src/index.ts:494-495`
- **Issue:** SIGTERM and SIGINT both call `shutdown()`. Rapid signals could invoke it twice.
- **Impact:** Double-shutdown (mitigated by queue.shutdown() idempotency)
- **Fix:** Add `let shuttingDown = false` guard.

### 3.7 No Database Close on Shutdown — LOW
- **File:** `src/index.ts:486-495`
- **Issue:** `db.close()` not called during shutdown
- **Impact:** Unlikely data loss (SQLite is crash-safe) but poor practice
- **Fix:** Add `db.close()` in shutdown handler.

---

## 4. IPC Architecture

### 4.1 Polling-Based IPC — MEDIUM
- **File:** `src/ipc.ts:39-150` (host), `container/agent-runner/src/index.ts:308-324` (container)
- **Issue:** Both host and container poll filesystem directories on fixed intervals (1s host, 500ms container). No event-driven notification.
- **Impact:** Host: 20+ fs scans/sec across groups. Container: 60 scans per 30s agent run.
- **Fix:** Use `fs.watch()` or inotify on Linux for event-driven IPC. Fall back to polling on unsupported systems.

### 4.2 IPC Error Files Accumulate Silently — MEDIUM
- **File:** `src/ipc.ts:96-107`
- **Issue:** Corrupted IPC files moved to `errors/` directory. Never cleaned, never alerted.
- **Impact:** Undetected data loss; errors directory grows indefinitely
- **Fix:** Log error count on each cycle. Alert if error count exceeds threshold. Add retention cleanup.

---

## 5. Database Improvements

### 5.1 Schema Migrations Without Version Tracking — LOW
- **File:** `src/db.ts:87-141`
- **Issue:** ALTER TABLE statements run on every startup, caught by try/catch when column already exists. No schema version table.
- **Impact:** Minor startup overhead; no way to know current schema version
- **Fix:** Add `schema_version` table. Only run migrations newer than current version.

### 5.2 lastAgentTimestamp Stored as Stringified JSON — LOW
- **File:** `src/index.ts:76-84`
- **Issue:** Per-group timestamp map stored as single JSON string in router_state. Parsed on every startup.
- **Impact:** Minor; but a proper table would be cleaner and allow per-group queries
- **Fix:** Create `agent_timestamps` table with (chat_jid, timestamp) columns.

---

## 6. Container Build Optimization

### 6.1 TA-Lib Built from Source Every Docker Build — MEDIUM
- **File:** `container/Dockerfile:33-38`
- **Issue:** Downloads and compiles TA-Lib C library from source on every full rebuild
- **Impact:** +2-3 minutes per container build
- **Fix:** Use multi-stage build — build TA-Lib in a builder stage, copy `.so` files to runtime stage. Or use a base image with TA-Lib pre-installed.

### 6.2 Entrypoint Recompiles TypeScript — HIGH (duplicate of 1.1)
- **File:** `container/Dockerfile:90`
- **Issue:** `npx tsc --outDir /tmp/dist` in entrypoint runs on every container start
- **Impact:** ~10s per container
- **Fix:** Pre-build in Dockerfile (already done at line 81). Use pre-built output directly, only recompile for per-group customizations.

### 6.3 Image Size (~1GB+) — LOW
- **File:** `container/Dockerfile`
- **Issue:** Chromium (~300MB), freqtrade + ta-lib (~300MB), node_modules. Single monolithic image.
- **Impact:** Slower pulls, more disk usage
- **Fix:** Multi-stage build. Strip build-essential after TA-Lib compilation. Consider splitting into base + trading extension images.

---

## 7. Testing Gaps

### 7.1 Main Orchestrator Untested — HIGH
- **File:** `src/index.ts`
- **Issue:** No direct tests for the core message loop, cursor advancement, state save/load, or shutdown flow
- **Impact:** Regressions in core logic go undetected
- **Fix:** Add integration tests for message loop, cursor management, and shutdown behavior.

### 7.2 IPC Processing Untested — MEDIUM
- **File:** `src/ipc.ts`
- **Issue:** No tests for file polling, authorization, task creation from IPC
- **Impact:** IPC bugs (like re-entrancy) go undetected
- **Fix:** Add unit tests with mock filesystem.

### 7.3 Router Channel Selection Untested — LOW
- **File:** `src/router.ts`
- **Issue:** Only formatting tested; actual channel routing logic not covered
- **Fix:** Add tests for channel selection and message routing.

### 7.4 Current Test Coverage Summary
- **15 test files**, 263 passing tests across:
  - GroupQueue (13 tests) — concurrency, retry, preemption
  - CredentialProxy (5 tests) — API-key, OAuth, headers
  - ContainerRunner (6 tests) — timeout, streaming, skills
  - TaskScheduler (4 tests) — drift, invalid folders
  - Database (23 tests) — messages, tasks, groups
  - IpcAuth (33 tests) — authorization, routing
  - WhatsApp (41 tests) — connection, messages, QR, media
  - SenderAllowlist (19 tests) — permissions, triggers
  - Formatting (33 tests) — XML, timezone, tags
- **1 failing test:** platform.test.ts (environmental issue on Windows)

---

## 8. Security Observations

### 8.1 No IPC JSON Schema Validation — MEDIUM
- **File:** `src/ipc.ts:75-76`
- **Issue:** IPC JSON parsed without schema validation. Malformed files could crash the processor.
- **Fix:** Add Zod schema validation for IPC message format.

### 8.2 No Rate Limiting on IPC — LOW
- **File:** `src/ipc.ts:39-150`
- **Issue:** IPC files processed without rate limit. A flood of IPC files could CPU-starve the host.
- **Fix:** Process max N files per cycle, defer remainder.

### 8.3 No Container Resource Limits — MEDIUM
- **File:** `src/container-runner.ts:256-343`
- **Issue:** Container spawn doesn't set `--memory` or `--cpus` limits. Runaway agent can consume all host resources.
- **Fix:** Add `--memory=2G --cpus=2` (or configurable) to container spawn args.

### 8.4 Existing Security Strengths
- **Mount security** (`src/mount-security.ts`): Allowlist stored outside project root, blocked patterns for `.ssh`, `.gnupg`, `.aws`, symlink resolution, read-write enforcement by group tier
- **Credential isolation** (`src/credential-proxy.ts`): Secrets never in env vars, injected at proxy boundary only
- **Sender allowlist** (`src/sender-allowlist.ts`): Drop/trigger modes, stored outside project root
- **IPC authorization** (`src/ipc.ts:72-92`): Main group can send to any JID; non-main restricted to own JID

---

## 9. Observability Gaps

### 9.1 No Request Tracing — MEDIUM
- **Issue:** No correlation ID linking a message through channel → queue → container → response
- **Fix:** Generate a `requestId` on message receipt, pass through entire pipeline, include in all logs.

### 9.2 No Performance Metrics — LOW
- **Issue:** No counters for queue depth, container run time, message processing latency, DB query time
- **Fix:** Add lightweight metrics (in-memory counters) exposed via health check endpoint.

### 9.3 No Health Check Endpoint — LOW
- **Issue:** No way to query system state externally (queue depth, active containers, channel status)
- **Fix:** Add `/health` endpoint on credential proxy port returning JSON status.

---

## 10. Concurrency & Race Conditions

### 10.1 Message Cursor Advancement Race — MEDIUM
- **File:** `src/index.ts:370-372`
- **Issue:** `lastTimestamp` advanced before `processGroupMessages()` is called. If processing fails after cursor advance, messages may be skipped.
- **Mitigation present:** Rollback on agent error (line 186-190), but only if `outputSentToUser` is false
- **Risk:** Partial output + crash = missed messages

### 10.2 WhatsApp Event Listener Stacking — MEDIUM
- **File:** `src/channels/whatsapp.ts:87, 175, 177`
- **Issue:** `.ev.on()` handlers accumulate on reconnect. See 3.2 above.

### 10.3 IPC File Window — LOW
- **File:** `src/group-queue.ts:166-178`
- **Issue:** Between `mkdirSync` and `writeFileSync`, another process could delete the directory
- **Mitigation:** Directory recreated each call, low probability

---

## Priority Matrix

| # | Issue | Severity | Category | Est. Effort |
|---|-------|----------|----------|-------------|
| 1.1/6.2 | Entrypoint recompiles TypeScript | HIGH | Container Speed | 1 hour |
| 1.5 | MCP servers always spawned | HIGH | Container Speed | 2 hours |
| 1.2 | Skills sync blocking I/O | HIGH | Container Speed | 1 hour |
| 2.6 | No IPC re-entrancy guard | HIGH | Host Efficiency | 30 min |
| 3.1 | Polling loops not stopped on shutdown | HIGH | Reliability | 1 hour |
| 3.4 | Container errors not sent to user | HIGH | Reliability | 30 min |
| 3.5 | Max retries silently drops messages | HIGH | Reliability | 30 min |
| 2.10 | Orphan cleanup blocking startup | HIGH | Host Efficiency | 30 min |
| 7.1 | Main orchestrator untested | HIGH | Testing | 4 hours |
| 2.1 | Missing (chat_jid, timestamp) index | MEDIUM | Host Efficiency | 10 min |
| 2.2 | getAllRegisteredGroups() caching | MEDIUM | Host Efficiency | 1 hour |
| 2.4 | State saves batching | MEDIUM | Host Efficiency | 30 min |
| 2.5 | IPC watcher withFileTypes | MEDIUM | Host Efficiency | 15 min |
| 2.9 | Parallel channel connect | MEDIUM | Host Efficiency | 15 min |
| 3.2 | WhatsApp listener cleanup | MEDIUM | Reliability | 1 hour |
| 8.3 | Container resource limits | MEDIUM | Security | 30 min |
| 8.1 | IPC JSON schema validation | MEDIUM | Security | 1 hour |
| 2.8 | task_run_logs retention | MEDIUM | Host Efficiency | 30 min |
| 4.1 | Polling-based IPC → fs.watch() | MEDIUM | Architecture | 2 hours |
| 4.2 | IPC error file accumulation | MEDIUM | Reliability | 30 min |
| 9.1 | Request tracing | MEDIUM | Observability | 2 hours |
| 6.1 | TA-Lib multi-stage build | MEDIUM | Build | 1 hour |
| 1.3 | Agent-runner source re-sync | MEDIUM | Container Speed | 1 hour |
| 5.1 | Schema version tracking | LOW | Database | 1 hour |
| 5.2 | lastAgentTimestamp table | LOW | Database | 30 min |
| 2.7 | getDueTasks() LIMIT | LOW | Host Efficiency | 10 min |
| 1.4 | Settings.json caching | LOW | Container Speed | 15 min |
| 3.6 | Signal handler debouncing | LOW | Reliability | 10 min |
| 3.7 | Database close on shutdown | LOW | Reliability | 5 min |
| 6.3 | Image size reduction | LOW | Build | 2 hours |
| 9.2 | Performance metrics | LOW | Observability | 2 hours |
| 9.3 | Health check endpoint | LOW | Observability | 1 hour |
| 7.2 | IPC tests | MEDIUM | Testing | 2 hours |
| 7.3 | Router tests | LOW | Testing | 1 hour |

**Total estimated effort:** ~30 hours across all items

---

## Recommended Implementation Order

### Phase 1: Quick Wins (< 2 hours total)
- 2.1 Add composite DB index
- 2.5 IPC withFileTypes
- 2.7 getDueTasks LIMIT
- 2.9 Parallel channel connect
- 3.6 Signal debouncing
- 3.7 DB close on shutdown

### Phase 2: High-Impact Performance (4-5 hours)
- 1.1/6.2 Eliminate entrypoint recompilation
- 1.2 Skills sync with change detection
- 2.10 Async orphan cleanup
- 2.6 IPC re-entrancy guard

### Phase 3: Reliability (3-4 hours)
- 3.1 Shutdown flag for polling loops
- 3.4 Container error notification to user
- 3.5 Max retry user notification
- 3.2 WhatsApp listener cleanup
- 3.3 WhatsApp interval cleanup

### Phase 4: Architectural (6-8 hours)
- 1.5 Conditional/lazy MCP servers
- 2.2 Group cache with invalidation
- 2.4 Batched state saves
- 4.1 Event-driven IPC
- 8.3 Container resource limits

### Phase 5: Testing & Observability (8-10 hours)
- 7.1 Orchestrator integration tests
- 7.2 IPC unit tests
- 8.1 IPC schema validation
- 9.1 Request tracing
- 2.8 Task log retention

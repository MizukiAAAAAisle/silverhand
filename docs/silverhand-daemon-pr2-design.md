# silverhand-daemon PR-2 — design lock

> Task: `#task:511` "Refactor: silverhand-daemon PR-2 (CM migration + runtime_* intents)".
> Owner: @Alice. Reviewer: @Cindy. Sign-off: @shiki.
> Status: **Step 0 — design only, no code yet.** Step 0 review must clear before any code lands.
> Prereq: PR-1 (`#task:510`, commits `a4c348f` + `8e76e14` + `fc92ff4`) — IPC skeleton (ping / status / echo, HostClient with reconnect, daemon lifecycle, capped restart spawn helper).
>
> **v3 changes** (post Cindy `aOgQJEvpcwvIQfvr` + nit `mU9KHwR9jUeN0hWI`):
> - §0 scope rewritten to match v2/v3 reality: no `runtime_inject_env`; migration is the **execution-plane supervisor**, not the whole CM file.
> - §3.1 `runtime_wake` made **batch-native**: `delivery_ids: number[]` (live single-delivery is batch size=1); result all-or-nothing; markDelivered applies to the whole batch.
> - §3.1 `runtime_start` accepts optional `startup_delivery: { delivery_ids, payload }` — the spawn-time drain replacement; daemon attempts the write per driver semantics.
> - §3.2 adds `runtime_startup_delivery_consumed` / `runtime_startup_delivery_failed` (both **non-droppable** control events). Consumed signal is **driver-specific**: step 2 audits each driver against current CM's existing markDelivered timing — design doc does not invent stronger/weaker acks (e.g. oneShot keeps whatever signal CM uses today).
> - §3.2 explicit startup/live exclusivity: daemon may not emit `runtime_ready_for_drain` until startup delivery (if any) settles via consumed/failed; backend may not call `runtime_wake` while a startup delivery is pending.
> - §3.2 explicit "on `runtime_startup_delivery_failed`, daemon does NOT auto-retry the same start; backend keeps inbox pending and decides via its own scheduling whether/when to re-start or re-wake".
> - §4.3 inbox drain bullet rewritten to match §3.3 / §4.1: single batched `runtime_wake` with all delivery_ids, all-or-nothing markDelivered, no per-row dispatch. (v2 wording was stale.)
> - §3.4 added: daemon logging contract — structured fields only, never payload bodies / stdin / stdout / inbox content. Locked into design freeze; Step 1 + Step 2 review against this.
>
> **v2 changes** (post Cindy `NdN_vhRdFlh-wrQa`):
> - §1.2.1 kill-and-reclaim guards narrowed: EPERM fails loudly, cmdline must include both `--socket-path` and `--pid-file` tokens, ping pid must agree with pid-file, half-dead reclaim path made explicit, "socket file exists" check dropped (didn't prove pid↔socket sameness).
> - §3.1 `runtime_wake` rewritten as pure runtime primitive: backend owns inbox, daemon never touches DB. Added `delivery_id` for precise ack; result enum'd. *(v3 supersedes single-delivery with batch.)*
> - §3.1 `runtime_inject_env` removed from v0 (host-control surface unrelated to CM migration).
> - §3.2 events partitioned into droppable (only `runtime_output`) vs non-droppable; added `runtime_ready_for_drain` event with strict driver-confirmed semantics.
> - §3.3 backend subscription updated to drive inbox drain from `runtime_ready_for_drain`.
> - §4.2 / §4.3 CM split rewritten: not a whole-file move. Execution-plane half (process, streams, parser, watchdog) → daemon; control-plane half (inbox, activity-log file, scheduler, DB) stays in backend.
> - §2.1 explicit "only `runtime_output` is droppable; control events must not participate in backpressure drops".

## 0. Scope reminder

PR-2 ships:

1. `runtime_start` (with optional `startup_delivery`) / `runtime_stop` / `runtime_wake` (batch) / `runtime_status` / `runtime_clear_session` / `runtime_stop_all` / `runtime_close_activity_log` intents. **No** `runtime_inject_env`.
2. Unsolicited events: `runtime_state`, `runtime_output` (droppable), `runtime_exit`, `runtime_ready_for_drain`, `runtime_startup_delivery_consumed`, `runtime_startup_delivery_failed`, `runtime_output_dropped`, `runtime_output_paused`, `runtime_output_resumed`, `shutting_down`.
3. Stale-daemon kill-and-reclaim flow (replaces PR-1's "refuse and fail" on pid conflict), with cmdline + ping identity guards.
4. Backpressure protocol scoped exclusively to `runtime_output` (pause/resume intents present but unused in v0; per-(conv, agent) 4 MiB hard cap always on).
5. Migration of the **execution-plane supervisor** out of `packages/backend/src/conversation-manager.ts` into `packages/host` — the child-process / stdin-stdout / driver-parser / init-watchdog / lifecycle-lock half. The inbox / activity-log JSONL writer / scheduler / DB-touching halves of CM stay in backend (renamed but not relocated). This is **not** a whole-file move.
6. `hostClient` becomes **required** in `startBackend`.

PR-2 does **not** ship:

- New product features. Behavior across all 820+ backend tests must stay identical end-to-end. The only contract change is *where the process supervisor physically runs*.
- Remote-host support. `RemoteHost` adapter is a follow-up; the protocol here is designed to absorb it without breaking.
- Bearer-token auth on the daemon socket. Filesystem permissions remain the only authz boundary (chmod 0o600); remote-host introduction is when token auth becomes mandatory.
- Any change to the inbox row format, the stream-json payload shape, or per-driver markDelivered timing. Step 2 of PR-2 audits each driver to confirm the daemon-side emit-points match today's CM markDelivered points exactly.

This doc covers §1-§4 below. The CM split plan (§5 in this doc's numbering) is the last subsection because every other choice constrains it.

---

## 1. Stale-daemon kill-and-reclaim protocol

### 1.1 Problem

PR-1's `claimPidFile()` refuses to start if the recorded pid is still alive. Today the entire `startBackend` path is optional — backend boots "without host plumbing" and surfaces a warn. In PR-2 `hostClient` is required, so this code path becomes a hard launch failure.

The driver scenario is unavoidable: Electron main crashes (segfault, OOM, force-quit, kernel panic, etc.) without running its shutdown handler. The daemon child outlives it because we have not bound the daemon's lifetime to the parent at the OS level. Next launch hits a live pid; PR-1 fails the launch.

### 1.2 Decision (locked by Cindy msg `5W8hZ0AefH5Cw3_V`)

**Strategy: kill-and-reclaim, narrow.** Strictly bounded: only reclaim a pid we can positively identify as a sibling `silverhand-daemon` of *this* user's *this* silverhand dir. Anything off → **fail loudly**.

#### 1.2.1 Reclaim prerequisites (ALL must hold)

Precondition on PR-1's daemon CLI: the daemon must be spawned with
**both** `--socket-path <p>` and `--pid-file <p>` explicit args (no
implicit derivation), so the cmdline carries the silverhand-dir
identity verbatim and `ps -ww` can match it precisely.

| # | check | how | why |
| --- | --- | --- | --- |
| a | pid alive under our uid | `process.kill(pid, 0)` returns successfully. **`EPERM` → fail loudly** (the pid belongs to another uid or to PID 1 — never reclaim). | basic liveness, but EPERM is a stop signal, not a "keep trying". |
| b | cmdline exactly identifies our daemon | `ps -ww -o command= -p <pid>` output must contain **both** the expected `--socket-path <our-path>` token AND the expected `--pid-file <our-path>` token as substrings. Plain `silverhand-daemon` is **not** enough — a sibling silverhand-dir's daemon would also match that. | proves the pid points at *this* silverhand-dir's daemon, not someone else's. |
| c | live daemon's self-reported pid agrees | open `SocketTransport`, send `ping`. **If ping succeeds**, `ping.daemon_pid` MUST equal the conflict pid from the pid-file. Mismatch → fail loudly (pid-file lies). | a pid that answers protocol but disagrees on its own pid means we are talking to the wrong process — most likely a stale file pointing at an unrelated daemon. |
| d | half-dead reclaim path | **If ping fails** (ECONNREFUSED / timeout) but checks (a) and (b) passed, accept as a "half-dead daemon" and proceed to SIGTERM. Any other ping failure mode (e.g. response shape invalid, wrong version) → fail loudly. | matches the realistic crash mode: child crashed mid-shutdown after closing the socket but before unlinking pid file. |

If any check fails: `startBackend` **does not boot**, exit with a structured error that surfaces the failing check + the pid we observed + the cmdline we saw + (if ping succeeded) the reported daemon_pid. The user can decide whether to manually kill it.

Note we explicitly dropped PR-1-draft's "socket path resolves to a real Unix socket file" check: file existence does not prove the pid we see owns that socket, so it adds no real evidence.

#### 1.2.2 Reclaim action

```
spawnDaemonChild() {
  result = claimPidFile(pidFilePath)
  if (result.status == 'wrote') {
    // fast path — same as PR-1
    spawnFresh()
    return
  }
  // status == 'conflict'
  recheckChecks()             // §1.2.1 — fail loudly if any fail
  sigterm(result.conflictingPid)
  awaitExit(timeout = 5_000)  // graceful budget
  if (!exited) {
    sigkill(result.conflictingPid)
    awaitExit(timeout = 2_000) // last-resort budget
  }
  if (!exited) {
    fail('daemon survived SIGKILL', pid=...)
  }
  // pid is gone; the daemon should have unlinked its pid file in its
  // shutdown handler. If SIGKILL skipped that, the file is stale —
  // re-claimPidFile will overwrite it via the existing kill(0) test.
  recheckResult = claimPidFile(pidFilePath)
  if (recheckResult.status == 'conflict') {
    fail('pid file still held after reclaim', pid=recheckResult.conflictingPid)
  }
  spawnFresh()
}
```

Logging: every step emits a structured line on the daemon JSONL log AND surfaces to the operator (Electron's logger). The reclaim is *not* silent — a one-time "reclaimed pid X from prior session" line is exactly the signal the operator wants to notice a crash pattern.

#### 1.2.3 What we explicitly do NOT do

- **Attach existing daemon.** Considered but rejected — the parent loses the kill lever, and a daemon running across parent restarts hides repeat-crash patterns (its restart budget never resets).
- **OS-level single-instance lock** (`flock` + child-polls-parent suicide). Cleanest semantically but adds 100+ lines and a polling cost we don't currently need; revisit if multi-parent topologies ever appear.
- **Auto-unlink the pid file on conflict without killing.** This was PR-1's behavior in the stale case (pid dead, file remains). PR-2 preserves it for the dead-pid path; the new behavior is only added for the LIVE-pid path.
- **Reclaim across silverhand-dirs.** Each silverhand-dir gets its own daemon; if the dir doesn't match, hard fail. No "I'll just take over that daemon too" behavior.

### 1.3 Open question for shiki

Default `gracefulMs` for SIGTERM during reclaim — 5s is our PR-1 launch-time kill graceful. Acceptable for the user-perceived "second launch latency" cost? If we want it lower (e.g. 2s) the trade-off is that a busy-but-shutting-down daemon gets escalated to SIGKILL faster, possibly losing the unlink step. **Recommendation: keep 5s; the reclaim path is rare and worth the wait.**

---

## 2. `runtime_output` backpressure protocol

### 2.1 Problem

`runtime_output` is the **raw stdout/stderr byte stream** from the agent CLI child process — observability / UI activity log only. Frequency is unbounded — a `claude` session in a heavy turn produces hundreds of bytes per second per chunk. Each one becomes a frame on the daemon → backend socket.

**Scope discipline (critical)**: `runtime_output` is the **only** droppable event in the protocol. Driver-parsed control signals — `session_init`, run-state transitions (`runtime_state`), compaction notices, child exit (`runtime_exit`), delivery acknowledgements baked into `runtime_wake`'s reply, and `runtime_ready_for_drain` — are **separate typed events** and **must not** participate in this backpressure scheme. A dropped raw-output chunk degrades log fidelity; a dropped control event breaks the state machine. Daemon enforces the split by sending control events on the same socket but never accounting them against the per-stream output cap below.

PR-1's `SocketTransport.write()` (review fix B1) deliberately ignores Node `Socket.write()`'s backpressure signal — that was the right call for the request/response intents (rare, small, must-not-be-treated-as-failure), but for a long-running event stream it means the daemon could OOM if the backend is slow to read.

### 2.2 Decision (recommended; awaiting shiki sign-off)

**Strategy: explicit `runtime_output_pause` / `runtime_output_resume` events from backend → daemon, with default-on flow control.**

#### 2.2.1 Wire shape

Add two intents (client → daemon):

| intent | params | purpose |
| --- | --- | --- |
| `runtime_output_pause` | `{ conversation_id, agent_id }` | daemon stops emitting `runtime_output` for this (conv, agent); buffers up to N chunks then drops with a `runtime_output_dropped` event. |
| `runtime_output_resume` | `{ conversation_id, agent_id }` | daemon resumes; emits `runtime_output_resumed` event acknowledging. |

Backend logic (PR-2 v0): never call pause. The protocol exists but the backend stays in always-flowing mode. We add real flow control in a follow-up only when measurements show pressure.

This satisfies the contract ("we have a primitive for back-pressure") without paying for it in the common case.

#### 2.2.2 Daemon-side guardrail (always on)

Independently of backend pause/resume, the daemon enforces a **per-(conv, agent) outgoing buffer cap** at the socket-write layer.

**Scope (critical, locked by shiki `kh7mQQIUi8WxFoPX`)**: this buffer counts **only un-flushed bytes** — chunks that are queued but the daemon has not yet been able to hand off to the kernel + Node socket buffer (i.e. the socket reported `writableNeedDrain` and the chunk is still in our in-process queue). Once a chunk is written and the socket's `drain` event fires (kernel + Node side both accepted it), the chunk is no longer counted. **It is NOT a session-cumulative byte counter.** Under normal flow (backend reading at line rate), pending stays near 0 and 4 MiB is never approached; the cap only matters when backend stalls and agent keeps producing output.

- If the socket's `writableNeedDrain` returns true AND the per-stream pending buffer crosses 4 MiB:
  - drop the oldest chunks until the buffer is back under 2 MiB;
  - emit one `runtime_output_dropped` event with `{ dropped_count, bytes_dropped }`;
  - log it.

This is a hard ceiling protecting the daemon from OOM regardless of backend behavior. 4 MiB is generous (~250 KB/s sustained for ~16s of total backend stall before drop kicks in) and easy to tune. As soon as backend resumes reading and `drain` fires, pending drops, dropping mechanism stops naturally.

#### 2.2.3 What we considered and rejected

- **Kernel-buffer-only.** Relies on TCP-like throttling. Doesn't apply cleanly to Unix sockets, and lets the daemon's Node-side writable buffer grow unbounded.
- **Length-prefixed framing instead of NDJSON.** Doesn't address backpressure — orthogonal. Stays NDJSON.
- **Throttle inside the agent runtime (drop CLI stdout chunks).** Would silently lose UI signal; backend would have no way to ask for it back.

### 2.3 Open question for shiki

The drop event surfaces visible to the user (we'll log it on the AgentSchedulesCard / activity log somehow), or silent backend internal? **Recommendation: visible, user-facing**, because dropped output explains gaps in the renderer's activity stream that would otherwise look like an agent bug.

---

## 3. `runtime_*` intent & event schemas

Wire format inherits PR-1's NDJSON + zod registry. Each new intent gets a `params` + `result` pair; each new event gets a `discriminatedUnion` arm.

### 3.1 Intents (client → daemon)

| intent | params | result | notes |
| --- | --- | --- | --- |
| `runtime_start` | `{ conversation_id, agent_id, options: StartOptions, startup_delivery?: { delivery_ids: number[], payload: StreamJsonPayload } }` | `{ pid: number, started_at: number, startup_delivery_accepted?: boolean }` | The full `StartOptions` shape (mock CLI override, init retry, etc.) is the same struct CM currently consumes; lift verbatim into `@silverhand/shared`. Idempotent on (conv, agent) — second start while running is a no-op (matches CM). **Daemon does not touch the inbox.** If `startup_delivery` is provided, daemon attempts the write per **driver-specific** semantics (claude-family: write the batch to stdin as the deferred-init trigger; oneShot: bake into the spawn-time input per current CM behavior). `startup_delivery_accepted` reports whether daemon accepted the payload for attempt — `true` does not mean "consumed", just "queued for the driver's startup path". Final ack is async via `runtime_startup_delivery_consumed` / `runtime_startup_delivery_failed` (§3.2). If `startup_delivery` is absent (e.g. `kickoffMode='requires_first_message'` with empty inbox), daemon performs no spawn-time stdin write; for claude-family drivers this means `session_init` won't fire until the first `runtime_wake` arrives, matching today's deferred-init contract. |
| `runtime_stop` | `{ conversation_id, agent_id, mode: 'soft' \| 'hard' }` | `{ stopped: boolean, exit_code: number \| null }` | Mode meanings match CM today: soft = write a directive user message, hard = SIGTERM/SIGKILL cascade. |
| `runtime_wake` | `{ conversation_id, agent_id, delivery_ids: number[], kind: 'message' \| 'schedule_fire', payload: StreamJsonPayload }` | `{ delivered: true, delivery_ids: number[] } \| { delivered: false, reason: 'not_running' \| 'not_initialized' \| 'startup_pending' \| 'draining' \| 'driver_refused', delivery_ids: number[] }` | **Batch-native pure runtime primitive — daemon never touches the inbox table.** Caller (backend) is responsible for `inboxes.ensureDelivery()` on every id in `delivery_ids` before calling, and for **all-or-nothing** `markDelivered(delivery_ids)` after a `{ delivered: true }` response. Live single-row delivery is just `delivery_ids: [id]`; the spawn-time multi-row drain (today's `drainInbox()` behavior) is preserved by sending the batch as ONE stream-json user message in `payload`. On `{ delivered: false }`, backend keeps **all** ids in pending — never partial markDelivered. Daemon emits `not_initialized` if pre-`session_init`, `startup_pending` if a `runtime_start.startup_delivery` is still settling, `draining` mid-shutdown, `driver_refused` for oneShot / pre-thread drivers that don't accept live wakes. |
| `runtime_status` | `{ conversation_id?: string, agent_id?: string }` | `{ runtimes: RuntimeStateDto[] }` | Snapshot read; backend uses for reconcile-on-boot replacement and admin / diagnostics. |
| `runtime_clear_session` | `{ conversation_id, agent_id }` | `{ cleared: boolean }` | Hard-stops live runtime + drops daemon-side `cli_session_id` cache. Session row in DB is backend's job — daemon emits no DB writes. |
| `runtime_stop_all` | `{}` | `{ stopped_count: number }` | Lift `stopAll()`. Called on backend shutdown. |
| `runtime_close_activity_log` | `{}` | `{ flushed: boolean }` | Flushes daemon-side outbound buffers for `runtime_output`; activity-log file is written by backend, so this is purely a "drain the socket" signal. Called on backend shutdown. |

**Removed from v0**: `runtime_inject_env`. It would have introduced a `Record<string, string>` env-patch surface, which is a new host-control plane attack surface unrelated to PR-2's CM-migration purpose. Defer until there is a concrete typed need (then design as an allowlist with explicit per-key respawn semantics + audit).

### 3.2 Events (daemon → client, unsolicited)

The protocol splits events into **droppable** (only `runtime_output`, scoped per §2) and **non-droppable** (everything else — state, lifecycle, drain readiness, startup delivery acks, output flow-control acks). Daemon must never sacrifice a non-droppable event to relieve backpressure.

| event | category | payload | purpose |
| --- | --- | --- | --- |
| `runtime_state` | non-droppable | `{ conversation_id, agent_id, state: AgentRunStateDto, ts: number }` | Replaces backend's in-process `agent_run_state` events. Backend re-publishes to renderers via the existing ScopeEventBus. |
| `runtime_output` | **droppable** | `{ conversation_id, agent_id, stream: 'stdout' \| 'stderr', chunk: string, ts: number }` | Raw stdout/stderr bytes. PR-2 daemon buffers + ships in 50ms windows or 4KB whichever first (TBD; default to per-chunk for v0, optimize later). |
| `runtime_exit` | non-droppable | `{ conversation_id, agent_id, code: number \| null, intentional: boolean }` | Process exited. Backend transitions `conversation_agents.status` accordingly. |
| `runtime_startup_delivery_consumed` | non-droppable | `{ conversation_id, agent_id, delivery_ids: number[], ts: number }` | Daemon's confirmation that a `runtime_start.startup_delivery` batch was consumed by the driver per **that driver's existing consumed signal**. The trigger condition is **driver-specific** — claude-family: emits after `session_init` successfully parses (proves the kickoff stdin write reached the model); other drivers: whatever current CM's `markDelivered` point is today. Step 2 of PR-2 audits each driver and pins the emit point against the existing markDelivered call site — the design doc does not invent new "stronger" or "weaker" ack semantics. On receipt, backend calls `markDelivered(delivery_ids)` all-or-nothing. |
| `runtime_startup_delivery_failed` | non-droppable | `{ conversation_id, agent_id, delivery_ids: number[], reason: 'child_exit' \| 'init_watchdog' \| 'write_failed' \| 'driver_refused' }` | The startup delivery did not reach the driver. Backend keeps all `delivery_ids` pending — **daemon does NOT auto-retry the same start**. The decision to re-start or re-wake is backend's existing scheduling logic; daemon does not loop on failure. |
| `runtime_ready_for_drain` | non-droppable | `{ conversation_id, agent_id, ts: number }` | Daemon emits **only** after the driver confirms it can safely accept live stdin AND any in-flight `runtime_start.startup_delivery` has settled via consumed/failed (startup/live exclusivity — see §3.2.1 below). Drivers that cannot live-drain (oneShot / pre-thread / batch-only) **never** emit this — backend keeps the inbox pending and routes deliveries through whatever start/kickoff path that driver requires. Backend's handler: call `inboxes.listPending(conv, agent)` then dispatch ONE batched `runtime_wake` (matches today's drainInbox behavior — one stream-json user message, not row-by-row). |
| `runtime_output_dropped` | non-droppable | `{ conversation_id, agent_id, dropped_count: number, bytes_dropped: number, since_ts: number }` | Backpressure guardrail (§2.2.2) fired. Signals to the operator that the *output* stream lost bytes — never that a control event was dropped. |
| `runtime_output_paused` | non-droppable | `{ conversation_id, agent_id }` | Ack for `runtime_output_pause` (§2.2.1). |
| `runtime_output_resumed` | non-droppable | `{ conversation_id, agent_id }` | Ack for `runtime_output_resume`. |
| `shutting_down` | non-droppable | (already in PR-1) | Daemon SIGTERM/SIGINT received. |

#### 3.2.1 Startup / live drain exclusivity

A single (conv, agent) runtime can have either a startup delivery in flight or a live drain in flight, never both:

- Between `runtime_start` ack and `runtime_startup_delivery_consumed | _failed`, daemon is in the **startup-pending** state. Backend must not call `runtime_wake` for that (conv, agent); if it does, daemon replies `{ delivered: false, reason: 'startup_pending' }`. Daemon must not emit `runtime_ready_for_drain` in this state.
- After `runtime_startup_delivery_consumed`, daemon may emit `runtime_ready_for_drain` (per its driver semantics). Backend reads any newly-pending inbox rows and issues one batched `runtime_wake`.
- After `runtime_startup_delivery_failed`, daemon emits **no** `runtime_ready_for_drain`. Backend keeps the inbox pending; the next start cycle (driven by backend, never daemon) gets a fresh chance.
- After `runtime_exit` (intentional or otherwise), any further `runtime_wake` for that (conv, agent) returns `{ delivered: false, reason: 'not_running' }` until the next successful `runtime_start`.

### 3.3 Backend subscription model

Backend's `HostClient` grows a `subscribe(handler)` method that:

- Receives every unsolicited event frame the transport produces.
- Routes by `event` field to the corresponding service:
  - `runtime_state` → `ConversationMessageService.publishRunState(...)` (or similar) → renderer SSE + DB persistence of run-state snapshot if applicable.
  - `runtime_output` → backend activity-log writer (JSONL persistence stays in backend per §4.3); also republished to renderers via SSE.
  - `runtime_exit` → `conversation_agents` state machine update.
  - `runtime_startup_delivery_consumed` → `inboxes.markDelivered(delivery_ids)` (all-or-nothing on the batch).
  - `runtime_startup_delivery_failed` → log + leave inbox rows pending; no auto-retry, no immediate re-start. Backend's existing scheduling logic decides whether/when to try again.
  - `runtime_ready_for_drain` → backend calls `inboxes.listPending(...)`. If pending is non-empty, hydrate one stream-json batch payload and emit ONE `runtime_wake` with all `delivery_ids`; on `{ delivered: true, delivery_ids }`, `markDelivered(delivery_ids)` atomically; on `{ delivered: false }`, leave all ids pending (no partial mark).
- Re-subscribes automatically on reconnect.

The existing backend `events: ScopeEventBus` is the publish surface to renderers; the daemon never speaks SSE / WebSocket — only to backend, only over the Unix socket. The daemon never holds a DB handle.

### 3.4 Daemon logging contract (locked by shiki `OZ8q7lDg9rgei4fy` + `02nX0D-JNcnmgfyJ`, scoped by Cindy `c8GvzR8Q5pcqp2QI`)

The daemon's JSONL log (written under the app's configured silverhand-dir / `logDir` parameter — **never** hardcoded to `~/.silverhand/logs/...`; PR-1's logger plumbing already takes the path by injection, keep it that way) records **structured fields only**. It is the operator's primary debug surface for protocol behavior and process lifecycle, but it MUST NOT leak conversation content.

**MUST be logged** (one JSONL line per event):

- intent lifecycle: `{ ts, level, kind: 'intent', intent, request_id, conv_id?, agent_id?, status: 'received'|'ok'|'error', error_code?, duration_ms }`
- emitted event: `{ ts, level, kind: 'event', event, conv_id?, agent_id?, pid?, delivery_ids?, dropped_count?, bytes_dropped? }`
- process lifecycle: `{ ts, level, kind: 'process', action: 'spawn'|'exit'|'sigterm'|'sigkill'|'reclaim', conv_id?, agent_id?, pid, exit_code?, cmdline_match? }`
- daemon lifecycle: `{ ts, level, kind: 'daemon', action: 'boot'|'shutting_down'|'pid_claim'|'pid_reclaim', pid, socket_path, pid_file_path, conflict_pid? }`
- backpressure: `{ ts, level, kind: 'backpressure', conv_id, agent_id, action: 'dropped'|'paused'|'resumed', dropped_count?, bytes_dropped?, buffer_bytes }`

**MUST NOT be logged**:

- stdin bytes written to any child process (including the hydrated `runtime_wake.payload` and `runtime_start.startup_delivery.payload`)
- stdout / stderr chunks emitted by any child process (the content of `runtime_output` events)
- inbox row content / message bodies / user text / agent text
- system prompts, MEMORY / CONSENSUS file content, env var values
- any field whose name suggests content (`payload`, `chunk`, `body`, `text`, `prompt`, `env_*`)

If a field is needed for debugging but borderline (e.g. a single-token "first 32 bytes"), it is borderline and the answer is **don't**. Use `byte_count` / `line_count` / `sha256_short` instead.

Backend's per-side log (`backend-<utc>.log`, `agent-<utc>.log`) follows the same rule — they already do, but the boundary is now contract.

---

## 4. CM migration plan

### 4.1 Inventory

Public surface of `packages/backend/src/conversation-manager.ts` today (8 methods, by plane):

**Execution-plane methods (move to daemon)**:

- `start(conversationId, agentId, opts)` — becomes `runtime_start` intent.
- `stop(conversationId, agentId, mode)` — becomes `runtime_stop`.
- `stopAll()` — becomes `runtime_stop_all`.
- live half of `clearSession` (hard-stop the child + drop session cache) — becomes `runtime_clear_session`.

**Control-plane methods (stay in backend, possibly renamed)**:

- `deliverMessage(conversationId, agentId, messageId)` — splits: backend `inboxes.ensureDelivery()` (already there) + backend dispatcher. Two physical call paths to daemon:
  - **live wake**: child already initialized → `runtime_wake { delivery_ids: [id], payload }`; on `{ delivered: true }` markDelivered.
  - **spawn-time drain**: child not running, message is the kickoff → backend issues `runtime_start { startup_delivery: { delivery_ids, payload } }`; markDelivered fires asynchronously on `runtime_startup_delivery_consumed`.
  - **post-init catchup**: queued while startup-pending or right before `runtime_ready_for_drain` → backend reacts to `runtime_ready_for_drain` by issuing ONE batched `runtime_wake` with all pending ids.
- `drainInbox()` (today's spawn-time batch) — same logic moves out of CM, lives in backend orchestrator; emits the batch through `runtime_start.startup_delivery` rather than directly writing stdin. The on-the-wire payload format does not change.
- DB half of `clearSession` (clear `cli_session_id` column, skip audit delivery) — stays in backend, sequenced after `runtime_clear_session` ack.
- `reconcileOnBoot()` — stays in backend; uses `runtime_status` snapshot from daemon to drive DB-side reconcile.
- `closeActivityLog()` — stays in backend (it owns the JSONL file); calls `runtime_close_activity_log` first to flush daemon outbound buffers.

Internal CM state, by plane:

- daemon-side: `handles` (process handles, streams), `runStates` (parse accumulator), `activitySnippetBuffers`, `lifecycleTails`, `initRetryStates`, in-memory `cli_session_id` cache.
- backend-side: `activityLogStream` (JSONL), `inboxes` repo references, `messages` repo references.

### 4.2 What moves to daemon

The daemon becomes the sole owner of **execution-plane** state — anything that touches the OS, the child process, or in-memory parse state:

- agent CLI child processes (spawn, signal, exit-watch)
- stdin/stdout streams + per-(conv, agent) write lock (`withLifecycleLock`)
- driver instance + parsed event accumulator (`AgentRunState`) — **transient daemon-side state**; the canonical copy is reconstituted by backend from `runtime_state` events
- init watchdog (PR-A three-tier) — fires `runtime_exit` / `runtime_state` on timeout, never writes DB
- per-(conv, agent) lifecycle coordination (`lifecycleTails`, `initRetryStates`)
- driver's `cli_session_id` cache (in-memory; canonical value still in backend DB)

What the daemon does **NOT** own (was tempting, but violates AgentHost boundary):

- Inbox state machine. Daemon never opens `ConversationInboxRepo`, never calls `ensureDelivery` / `listPending` / `markDelivered`. Drain is **backend-orchestrated**: backend pushes hydrated stream-json payloads via `runtime_wake`; daemon writes to live stdin and replies `{ delivered }`; backend updates the inbox row.
- Activity-log JSONL writer. Daemon emits `runtime_output` events; backend persists the JSONL file. Reason: same single-source rule as inbox — daemon stays stateless w.r.t. disk artifacts that survive its lifetime.
- DB. Period. Daemon holds no `Database` handle, no repos, no migrations.

### 4.3 What stays in backend

Everything in the **control plane** — anything that touches the DB, persists state, or speaks to renderers:

- All DB writes: inbox row creation, message persistence, notifications, `conversation_agents` status, run-state snapshots driven by daemon events.
- Inbox drain orchestration: on `runtime_ready_for_drain` event, backend calls `inboxes.listPending(conv, agent)`, hydrates **one** stream-json batch payload covering all pending rows, and issues a **single** `runtime_wake { delivery_ids: [...all], payload }`. On `{ delivered: true, delivery_ids }` reply, calls `markDelivered(delivery_ids)` **all-or-nothing**; on `{ delivered: false }`, leaves **all** ids pending (no partial mark). For spawn-time drain (kickoff), backend instead hands the batch via `runtime_start.startup_delivery` and waits for the async `runtime_startup_delivery_consumed | _failed` event before calling markDelivered. Same all-or-nothing rule.
- Activity-log JSONL writer: receives `runtime_output` events, writes file, also republishes to renderers via SSE.
- Auth / ACL / membership.
- HTTP routes.
- Event-bus republish to renderers (re-emits `runtime_state` / `runtime_output` / `runtime_exit` events from daemon onto SSE).
- Scheduler — instead of `CM.deliverMessage`, scheduler now writes the inbox row via the same backend service path a normal message takes, then triggers `runtime_wake` (live or via drain on next start).

### 4.4 Cutover strategy

**Atomic, no coexist period.** PR-1's optional `hostClient` made an in-place migration cheap — backend already runs in both shapes. PR-2 step 1 lands the wire protocol with a fake supervisor (daemon-side stubs that emit canned `runtime_state` / `runtime_ready_for_drain` / `runtime_exit`); PR-2 step 2 carves the execution-plane half out of `packages/backend/src/conversation-manager.ts` into `packages/host/src/supervisor/`, leaves the inbox / activity-log / scheduler call-site halves where they are (re-targeted at `hostClient.callRuntime*(...)` instead of CM method calls), and removes `BackendContext.conversationManager`.

Note this is **not** a whole-file move. The file splits: process / driver / watchdog half → daemon; inbox / persistence / orchestration half → backend services that today happen to live behind CM methods.

No feature flags, no parallel code paths. The 820+ backend tests run end-to-end through the new IPC; if they pass, the migration is correct.

### 4.5 Test strategy

- All existing backend tests that reach into `ctx.conversationManager` keep working because backend's call sites are renamed but the inputs/outputs at the test boundary are identical.
- The execution-plane tests (process lifecycle, init watchdog, driver parse) move with the daemon code into `packages/host/tests/supervisor/*`.
- The inbox / activity-log tests stay in `packages/backend/tests/` because that logic stays in backend.
- New tests: end-to-end pings through `runtime_start` from backend test → daemon → mock CLI; assert events come back via `runtime_state` / `runtime_ready_for_drain` / `runtime_exit`; assert backend drives drain via `runtime_wake` and updates inbox.

### 4.6 `hostClient` becomes required

`startBackend({ ..., hostClient })` — no longer optional. The boot smoke ping promoted from warn to error. Electron main fails to bootstrap if the daemon can't be spawned (with the kill-and-reclaim flow from §1 having had its chance first).

`dev:headless` likewise.

---

## 5. Risk list

1. **CM migration breaks one of the 820 tests in a way that hides a real regression.** Mitigation: do not change behavior in step 2; if a test fails, it's a porting bug, not a contract change.
2. **`runtime_output` stream really does need backpressure under load.** Mitigation: §2.2.2's per-stream cap is the failsafe; pause/resume protocol is the operator escape hatch.
3. **kill-and-reclaim races a normal-exit daemon mid-shutdown.** Edge case: parent crashes during normal shutdown; next launch sees a daemon in graceful drain. Our checks (pid alive + cmdline match) pass; we send SIGTERM to a process that was already exiting; 5s graceful wait succeeds. Harmless.
4. **Daemon's CM-equivalent introduces new bugs around stdin write race conditions.** Mitigation: per-(conv, agent) lifecycle lock (existing CM `withLifecycleLock`) moves verbatim — that's a load-bearing piece.
5. **PR-2 step 2 is large.** 80+ method signatures move; backend's call sites all need updating. Mitigation: review per-step (Cindy review boundary discipline locked in task body).

---

## 6. Sign-off requested

@shiki please tap one of:

- **Approve as-is** → I claim Step 1 task scope tomorrow, start protocol implementation against fake supervisor.
- **Defer §1 kill-and-reclaim default** (5s SIGTERM) → state preferred budget.
- **Defer §2 backpressure default** (pause/resume protocol present but unused) → state preferred shape.
- **Defer §4.4 atomic cutover** (want a coexist period) → state desired phasing.

Cindy: v3 folds the three blockers from `aOgQJEvpcwvIQfvr` (batch-native `runtime_wake`; spawn-time `startup_delivery` modeled via `runtime_start` params + async consumed/failed events; §0 scope reconciled with v2/v3 reality) plus the two refinements (driver-specific consumed signal — design doc pins emit point to "match current CM markDelivered per-driver", step 2 audits; `runtime_startup_delivery_failed` non-droppable, no daemon-side auto-retry). v2 folded the three blockers from `NdN_vhRdFlh-wrQa` + two refinements from `F6Rrf7L5nLarUj9S` (stable delivery_id; ready_for_drain driver-confirmed gating).

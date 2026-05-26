# Daemon outbound protocol — D2

Status: D2.c server command dispatch + correlation.

This document defines the WebSocket transport introduced in Stage D2 for the
desktop-local daemon. The orchestration boundary remains
`docs/orchestration-boundary-v1.md`: server owns DB/control-plane state, daemon
owns host-local filesystem/process execution. This protocol only carries typed
intent and events across that boundary.

## Endpoint and authentication

- Endpoint: `GET /api/hosts/connect` as a WebSocket upgrade.
- Authentication: `Authorization: Bearer <host_token>` on the upgrade request.
- Validation: server calls Stage B `verifyHostToken()`; missing, revoked,
  expired, rotated-past-grace, bootstrap, or host-revoked tokens are rejected
  before upgrade.
- Scope: V1 accepts only `hosts.kind = 'local'`. Headless remote hosts and
  sandbox hosts remain out of scope.
- On accepted upgrade, the server touches `hosts.last_seen_at`. Later D2 slices
  update it from heartbeat/pong cadence.

User session cookies are not accepted on this endpoint. `host_token` remains
daemon-only and must not be exposed to renderer or agent process credentials.

## Envelope

The schema source of truth is `packages/host/src/outbound-protocol.ts`.

Frames are JSON objects with three layers:

- `direction`: outer discriminator, `server_to_daemon` or `daemon_to_server`.
- `type`: `command`, `command_response`, `event`, or `heartbeat`.
- `kind`: scoped by `type`; server commands and daemon events are separate
  catalogues.

This avoids mixing command names and event names into one namespace while
keeping frames readable in logs.

## Connection lifecycle

The desktop main process starts the local daemon with
`--host-config ~/.silverhand/daemon-config.json`. The daemon polls that file
and opens one WebSocket to `/api/hosts/connect` when the file contains a valid
Stage B host token. Missing or invalid config closes the outbound connection
without affecting the local Unix socket.

Reconnect uses jittered exponential backoff capped at 60 seconds. Close-code
handling is explicit:

- `1000` (`normal`) from daemon shutdown does not reconnect; `1000` from the
  server while the daemon is still running reconnects after backoff.
- `1001` (`going_away`, including `server_shutdown`) reconnects after backoff,
  never as a tight loop.
- `1006` (`abnormal`) reconnects after backoff.
- Other close codes are logged as `other` and also reconnect after backoff
  while the daemon still has valid host config.

Reconnect starts a fresh WebSocket. It does not replay any frame that was in
the prior socket's process-local write buffer.

## Command dispatch and correlation

Server-issued commands are request/response frames over the currently-open
host WebSocket:

- Server sends `server_to_daemon / command` with a unique `id`, command
  `kind`, and typed `params`.
- Daemon dispatches the command through the same `IntentDispatcher` path used
  by the local Unix socket runtime API.
- Daemon replies with `daemon_to_server / command_response`, echoing the exact
  same `id` and `kind`, and carrying either typed `result` or typed `error`.

The server keeps an in-memory `Map<id, pending>` only for response correlation.
It is not durable and is cleared on timeout, disconnect, or server shutdown.
Multiple commands may be in flight concurrently; responses are demultiplexed by
`id`, not by arrival order.

Command transport failures are fail-fast:

- `transport_no_connection` when no daemon is connected for the target host.
- `transport_timeout` when no response arrives before the caller's timeout.
- `transport_disconnected` when the socket closes while a command is in flight.
- `transport_send_failed` / `transport_invalid_command` /
  `transport_response_mismatch` for local send/schema/correlation faults.

Before sending an agent-scoped runtime command, server-side callers must resolve
the agent through `RuntimeHostPlacementResolver`. Missing/revoked/mismatched
host placement fails before any frame is written to the wire.

Default command timeout is 30 seconds. Callers should override it by command
shape rather than treating the default as product policy:

| Command | Recommended timeout | Reason |
| --- | ---: | --- |
| `runtime_status` | 5s | read-only snapshot; used for reconnect hydrate |
| `runtime_wake` | 10s | stdin write / driver refusal should settle quickly |
| `runtime_stop` hard | 10s | signal dispatch ack, not full process-drain guarantee |
| `runtime_stop` soft | 15s | directive encode + stdin write |
| `runtime_start` without `startup_delivery` | 30s | spawn acceptance and pid report |
| `runtime_start` with `startup_delivery` | 60s | spawn plus first delivery acceptance; consumed ack is still async |
| `runtime_clear_session` | 15s | hard-stop + session reset ack |
| `runtime_stop_all` / `runtime_close_activity_log` | 30s | shutdown/drain control path |
| `runtime_output_pause` / `runtime_output_resume` | 5s | local daemon bookkeeping |
| `rotate_token` | 10s | daemon config atomic write |

## Heartbeat

Heartbeat is an app-level protocol frame, not only a WebSocket ping:

- Daemon sends `daemon_to_server / heartbeat / ping`; server answers
  `server_to_daemon / heartbeat / pong`.
- Server sends `server_to_daemon / heartbeat / ping`; daemon answers
  `daemon_to_server / heartbeat / pong`.
- Each side closes with `1008 heartbeat_timeout` when its own ping does not
  receive the matching pong before timeout. That close then follows the
  reconnect rules above unless it was part of daemon shutdown.

## Server commands

The D2 command catalogue reuses the current runtime schemas from
`packages/host/src/protocol.ts`:

- `runtime_start`
- `runtime_stop`
- `runtime_wake`
- `runtime_status`
- `runtime_clear_session`
- `runtime_stop_all`
- `runtime_close_activity_log`
- `runtime_output_pause`
- `runtime_output_resume`
- `rotate_token`

The `runtime_*` payloads are the accepted D2.0 request surface. `rotate_token`
is D2's transport-local host credential refresh command; the daemon must write
the new `daemon-config.json` atomically before acknowledging success.

## Daemon events

Daemon events mirror the existing daemon runtime event surface, with `event`
renamed to envelope `kind`:

- `ready`
- `shutting_down`
- `runtime_state`
- `runtime_output`
- `runtime_exit`
- `runtime_ready_for_drain`
- `runtime_startup_delivery_consumed`
- `runtime_startup_delivery_failed`
- `runtime_init_timeout`
- `runtime_init_retrying`
- `runtime_init_cooldown`
- `runtime_compaction_stale`
- `runtime_output_dropped`
- `runtime_output_paused`
- `runtime_output_resumed`
- `runtime_parsed_event`
- `runtime_parsed_event_dropped`

`runtime_output` is the only droppable runtime event. All lifecycle,
delivery-ack, parsed-event, and shutdown events are non-droppable from the
daemon's perspective.

## Event fanout

D2.d wires outbound daemon events into the same backend projection sink used by
the Unix-socket daemon path: `RuntimeEventHandler` plus `RunStateCache`,
`DbRuntimeStatusProjector`, inbox ack, SSE, and activity-log writer. The
outbound WebSocket is only a new ingress; it must not grow a parallel DB/SSE
projection.

In standalone server mode, `/api/hosts/connect` forwards authenticated
daemon-to-server event frames into that sink. In embedded mode the existing
Unix-socket `HostClient` subscription remains the event source, and outbound
frames are shape-gated but not projected. This prevents the daemon's current
dual broadcast (`server.broadcast(event); outboundClient?.sendEvent(event)`)
from applying the same event twice.

On a fresh outbound `ready`, the server issues `runtime_status` to the same
connected host and hydrates `RunStateCache` from the snapshot. This is the
recovery path for non-buffered events lost while disconnected: daemon does not
replay an event queue, and server reconciles current phase/run-state from the
snapshot. `runtime_parsed_event_dropped` remains metadata-only; backend does
not fabricate a parsed event payload and only projects a lossy diagnostic onto
the existing run-state shape when a run-state entry is present.

## Durability

The DB inbox plus `RuntimeDeliveryCoordinator` is the only durable delivery
queue. The WebSocket write buffer introduced in D2.b must be bounded and
non-durable.

On disconnect or backpressure:

- Delivery-backed `runtime_wake` and startup-delivery `runtime_start` leave
  their inbox rows pending on transport failure. D2.c still returns
  fail-fast transport errors; reconnect plus daemon `ready` /
  `runtime_ready_for_drain` replay through `RuntimeDeliveryCoordinator` is a
  D2.e integration, not an in-memory queue in this transport layer.
- Non-delivery controls (`runtime_status`, `runtime_stop`, `rotate_token`,
  delivery-less `runtime_start`, etc.) fail fast to the caller with an explicit
  transport reason. The server and daemon must not fabricate an off-DB pending
  queue for these commands.

## Bounded write buffer

The daemon outbound client has a process-local write buffer capped by both
frame count and total encoded bytes. The cap exists only to bound memory while
the OS/WebSocket writer is under pressure; it is not durable state.

Overflow behavior:

- `runtime_output` is droppable. The daemon drops it, logs
  `runtime_output_dropped`, and keeps the socket open.
- Every other daemon event is non-droppable. Overflow logs
  `non_droppable_overflow` plus `buffer_overflow_close` with event metadata
  (`event_kind`, `conversation_id`, `agent_id`, `ts`) and closes the socket
  with short reason `outbound_buffer_overflow`.

The close reason intentionally stays short because WebSocket close reason
payloads are limited. The structured daemon log is the durable diagnostic
record for the event that triggered fail-loud overflow.

## D2.c limit

D2.c authenticates/connects/reconnects the daemon client, handles app-level
heartbeat, enforces bounded non-durable writes, and dispatches server commands
with strict correlation. It still does not wire daemon event fanout into DB/UI
projection, add DB-inbox replay on reconnect, or rotate tokens over the live
connection. Those remain D2.d-D2.f.

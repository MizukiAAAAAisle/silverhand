# Daemon outbound protocol

This document defines the WebSocket transport for the daemon. The orchestration
boundary remains
`docs/orchestration-boundary-v1.md`: server owns DB/control-plane state, daemon
owns host-local filesystem/process execution. This protocol only carries typed
intent and events across that boundary.

## Endpoint and authentication

- Endpoint: `GET /api/hosts/connect` as a WebSocket upgrade.
- Authentication: `Authorization: Bearer <host_token>` on the upgrade request.
- Validation: server calls `verifyHostToken()`; missing, revoked,
  expired, rotated-past-grace, bootstrap, or host-revoked tokens are rejected
  before upgrade.
- Host acceptance: the endpoint accepts a `hosts.kind = 'local'` host, or a
  user-managed remote host — one with `kind = 'remote'`,
  `provisioning_source = 'user_invite'`, and a non-null `user_id`. Any other
  host (e.g. a remote host that is not user-managed) is rejected `403`. Sandbox
  hosts are not a distinct `HostKind` and are not accepted as one.
- On an accepted upgrade the server holds a transport slot only; it touches
  `hosts.last_seen_at` (with `activated_at`) when that daemon's `ready` is
  admitted, and refreshes it on each subsequent attachment.

User session cookies are not accepted on this endpoint. `host_token` remains
daemon-only and must not be exposed to renderer or agent process credentials.

### Local and remote hosts share one wire

`local` and `remote` Hosts are the same entity at the auth and wire layers
(`auth-and-host-model.md` §1.1): they share the credential schema, the
`verifyHostToken()` validator, this WebSocket endpoint, the rotation flow, and
the placement resolver. The host-acceptance guard above is the only kind-aware
branch on this endpoint — no wire schema, frame format, authentication code
path, or rotation flow differs by host kind. Sandboxing is orthogonal: a sandbox
daemon runs as a Host plus a capability layer, not as a new `HostKind` value.

## Envelope

The schema source of truth is `packages/host/src/outbound-protocol.ts`.

Frames are JSON objects with three layers:

- `direction`: outer discriminator, `server_to_daemon` or `daemon_to_server`.
- `type`: `command`, `command_response`, `event`, or `heartbeat`.
- `kind`: scoped by `type`; server commands and daemon events are separate
  catalogues.

This avoids mixing command names and event names into one namespace while
keeping frames readable in logs.

### One outbound frame adapter, not a fork

Both deployment shapes dispatch the **same** outbound frame schemas
(`OutboundServerToDaemonCommandFrame`,
`OutboundDaemonToServerCommandResponseFrame`,
`OutboundDaemonToServerEventFrame`) through one `OutboundFrameAdapter`
(`packages/backend/src/runtime/outbound-frame-adapter.ts`). Standalone reaches
the daemon over WSS via `HostWsServerController`; embedded reaches the local
daemon over the `daemon-outbound.sock` Unix socket via
`EmbeddedUnixOutboundFrameAdapter`. The transport underneath differs; the frame
envelope, command schemas, error taxonomy, and backend dispatch path do not.
**Backend handlers never branch on deployment mode.**

The same envelope carries the `runtime_*` control commands and
`agent_materialize` — there is no embedded-only `{ intent, params }` local-RPC
shape carrying those semantics. The backend enforces this by importing **zero**
`HostClient`: `packages/backend/src` speaks only through the adapter. The only
live `HostClient` call sites are `apps/desktop/src/main/**` (desktop-local
supervisor / host-control IPC — attach, detach, reload, revoke), which are not
the server↔daemon runtime data plane.

## Connection lifecycle

The desktop main process starts the local daemon with
`--host-config ~/.silverhand/daemon-config.json`. The daemon polls that file
and opens one WebSocket to `/api/hosts/connect` when the file contains a valid
host token. Missing or invalid config closes the outbound connection
without affecting the local Unix socket.

A raw socket open is not an attachment. The server treats an authenticated
upgrade as a private **transport slot** and creates the business attachment
— `host_connection_changed`, `connectedHostIds`, `connectionIdForHost`,
`getAttachment`, and command reachability — only when the daemon's `ready` frame
passes the protocol-version gate. A refused generation therefore publishes
nothing and can receive no runtime command; it is refused with close code `1002`
and reason `update_required`. The lifecycle stamp (`activated_at` /
`last_seen_at`) is part of that same admitted edge, not of the upgrade: the
`status` derived from `activated_at` is what the Add-computer flow reads as
"connected", so an unadmitted generation must not move it.

Reconnect uses jittered exponential backoff capped at 60 seconds. The budget is
reset by the daemon's own **pong**, not by the socket opening: a raw `open`
happens before the server has read `ready`, so resetting there let a refused
handshake retry forever at the ~1s floor. A pong proves the server accepted this
generation, because the daemon sends `ready` before its first `ping` and one
socket's frames are processed in order.

Close-code handling is explicit:

- `1000` (`normal`) from daemon shutdown does not reconnect; `1000` from the
  server while the daemon is still running reconnects after backoff.
- `1001` (`going_away`, including `server_shutdown`) reconnects after backoff,
  never as a tight loop.
- `1002` with reason `update_required` is **terminal for the current host
  config**: the daemon's wire protocol is not the one this server speaks, so no
  retry can succeed until the binary changes. Suppression is keyed on the config
  fingerprint and lifts when the config changes, exactly like
  `host_revoked` / `host_disconnected`. A `1002` for any other reason (a frame
  this server could not even read as `ready`) stays retryable — that is a corrupt
  dialer, not a version verdict.
- `1006` (`abnormal`) reconnects after backoff.
- Other close codes are logged as `other` and also reconnect after backoff
  while the daemon still has valid host config.

Version skew is a semantic break, not a range: the server accepts exactly
`OUTBOUND_PROTOCOL_VERSION` and does not dual-accept. The terminal close only
stops the *new* daemon's retry loop; already-deployed older daemons keep dialing
until upgraded, which is harmless to the server because a refused generation is
invisible to every business reader.

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
| `runtime_deliver` | 10s | spawn/admit/refuse custody decision; consumed ack is still async |
| `runtime_stop` hard | 10s | signal dispatch ack, not full process-drain guarantee |
| `runtime_stop` soft | 15s | directive encode + stdin write |
| `runtime_start` | 30s | pure lifecycle spawn acceptance and pid report (no batch) |
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

The command catalogue reuses the current runtime schemas from
`packages/host/src/protocol.ts`:

- `runtime_start`
- `runtime_stop`
- `runtime_deliver`
- `runtime_status`
- `runtime_clear_session`
- `runtime_stop_all`
- `runtime_close_activity_log`
- `runtime_output_pause`
- `runtime_output_resume`
- `rotate_token`

The `runtime_*` payloads are the accepted request surface. `rotate_token`
is the transport-local host credential refresh command; the daemon must write
the new `daemon-config.json` atomically before acknowledging success.

### `agent_materialize` command

`agent_materialize` is an additive outbound command (schemas in
`packages/host/src/protocol.ts`, re-exported onto the wire from
`packages/host/src/outbound-protocol.ts`). It reuses the existing
WS/correlation/auth/timeout machinery unchanged — it rides the same command
envelope, is correlated by `id`, authenticated by the same host token, and
returns per-command typed wire errors like any other command. It is the
canonical way the server asks the daemon-owning host to create an agent's L1
home (the DM workspace path, which coincides with L1).

Load-bearing invariants:

- **L1 template truth stays on the daemon.** The server sends metadata only
  (`agent_id`, `agent_home_workspace_id`, `name`, `runtime`, optional
  `model` / `description`, and `template_choice`) and performs no filesystem
  work; the daemon owns the templates and writes the L1 dir. The daemon returns
  `agent_dir` and `agent_home_workspace_path`, which the result schema's
  `superRefine` requires to be equal — the server treats both as opaque and
  uses the path verbatim for the `agent_home` workspace row.
- **Explicit materialization state, with a read-visibility rule.**
  `agents.materialization_status` is exactly
  `{ 'pending_materialization', 'active', 'failed' }`
  (`packages/shared/src/db/schema.ts`). New rows start
  `pending_materialization` and flip to `active` on daemon ack or `failed` on a
  typed error / timeout; pre-existing rows backfill to `active`.
  `pending_materialization` rows are hidden from reads; `failed` rows are hidden
  unless the caller passes `?include_failed=1`, and that widening is
  creator-scoped (it never crosses to another user's rows).
- **Two-layer idempotency.** The HTTP layer requires an `Idempotency-Key`
  header matching `/^[A-Za-z0-9_-]{1,64}$/`, backed by the creator-scoped unique
  index `idx_agents_idempotency_key_per_user` on
  `(created_by_user_id, idempotency_key)`. The wire `command_id` is a separate,
  server-allocated-per-send correlation id (`nextCommandId`) that is never
  reused. Re-dispatch on the same key with matching body echoes the prior
  outcome (active → success, pending → `materialization_in_progress`, failed →
  `materialization_previously_failed`); a mismatched body on a reused key is
  rejected `idempotency_metadata_mismatch` **before** dispatch.
- **Offline reserves no row.** The server checks that the target host has a live
  outbound connection **before** reserving the `pending_materialization` row; if
  the daemon is not attached it returns `host_attach_pending` with no row
  written. The captured connection id is re-confirmed before the write so a
  daemon reattach in the window fails closed rather than materializing on a dead
  generation.
- **Boot reconciler for stale pending rows.** At bootstrap, synchronously and
  before the server listens, a reconciler flips any `pending_materialization`
  row older than the threshold to `failed` with
  `backend_crash_during_materialize`; fresher pending rows and already
  `active` / `failed` rows are left untouched. There is no background sweep
  beyond boot.

## Host token rotation

Rotation is server-initiated only; daemon-initiated rotation is not supported.

Rotation is a two-phase handshake so the server never revokes the old token
before the daemon has durably learned the replacement:

```text
server                 daemon                 fs                  db
  | prepare token bytes  |                    |                   |
  | rotate_token -------->                    |                   |
  |                       | tmp write+rename --> daemon-config    |
  |                       | chmod 0600         |                   |
  |                       | update memory token                    |
  | <------ rotated:true |                    |                   |
  | insert new credential + mark old consumed_at=issued_at,       |
  | revoked_at=issued_at+60s ------------------------------------> |
```

If the daemon cannot write `daemon-config.json`, it replies
`{ rotated:false, reason:'write_failed' }`; the server leaves
`host_credentials` unchanged and the caller receives a rotation failure. The
server also leaves DB rows unchanged for daemon host mismatch or malformed
config rejection.

After a successful ack the existing WebSocket stays open. Host-token auth is a
handshake-time check, so the old authenticated connection continues until its
natural reconnect or heartbeat lifecycle. The daemon does not clear its bounded
write buffer on rotate; any already-buffered frames on the old connection may
finish sending. The daemon does, however, update both disk and in-memory config
before acking, so the next reconnect presents the new token immediately.

The old credential remains valid for a 60s grace window by setting
`host_credentials.revoked_at = issued_at + 60_000` and recording
`consumed_at = issued_at` as the rotation handoff timestamp.
`verifyHostToken()` accepts that credential only while `revoked_at` is in the
future; once the grace window passes, reconnect with the old token fails during
upgrade. Immediate host/credential revocation still has no grace window.

## Daemon events

Daemon events mirror the existing daemon runtime event surface, with `event`
renamed to envelope `kind`:

- `ready`
- `shutting_down`
- `runtime_state`
- `runtime_output`
- `runtime_exit`
- `runtime_ready_for_drain`
- `runtime_delivery_consumed`
- `runtime_delivery_failed`
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

Outbound daemon events wire into the same backend projection sink used by
the Unix-socket daemon path: `RuntimeEventHandler` plus `RunStateCache`,
`DbRuntimeStatusProjector`, inbox ack, renderer event projection, and the
activity-log writer. The outbound WebSocket is only a new ingress; it must not
grow a parallel DB / event-WebSocket projection.

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

## Delivery-backed replay

Delivery-backed replay connects the durable DB inbox to outbound WebSocket command dispatch. The
DB inbox remains the only durable queue; the host WS command `Map<id, pending>`
is still only a per-command correlation table and is cleared on disconnect.

Replay is triggered by daemon `runtime_ready_for_drain` for a specific
`(conversation_id, agent_id)`, not by the top-level daemon `ready` handshake.
This matters for stateful drivers such as Codex: the daemon must first know
that the driver can encode stdin before server sends delivery-backed wake.

For each ready-for-drain pair, server claims pending inbox rows FIFO by inbox
row id in a SQL transaction:

1. `pending -> in_flight`: rows with `delivered_at IS NULL`,
   `failed_at IS NULL`, and no `in_flight_owner` are claimed for the current
   host WebSocket connection id.
2. Server dispatches one `runtime_deliver` with the claimed `delivery_ids` in
   row order plus `spawn_options` (consulted only if the daemon must spawn).
3. The synchronous `runtime_deliver` disposition transfers or refuses **custody
   only** — it never acks the DB. `spawning`/`admitted` keep the rows in flight;
   the async `runtime_delivery_consumed{delivery_ids}` is the only ack that marks
   rows delivered.
4. A `refused{reason}` disposition, timeout, send failure, or disconnect rolls
   rows back to pending so the next ready-for-drain can retry.
   `runtime_delivery_failed{delivery_ids, reason}` likewise rolls the batch back.

Repeated ready-for-drain events while a row is in flight do not double-send
that row. When a host WebSocket disconnects or is replaced, server sweeps rows
owned by that connection id back to pending before the next connection can
claim them.

`runtime_deliver` is daemon-authoritative: the daemon inspects the REAL handle
and chooses spawn / admit / refuse itself, so server no longer forks command
shape by cached phase.

- No live handle (absent or `exited`): the daemon spawns with the batch as its
  startup delivery → `spawning`. This command carries no daemon-local absolute
  workspace or spawn-prep paths; the daemon resolves those host-local paths
  itself from its placement (see `orchestration-boundary-v1.md` §5.1).
- `ready` + driver ready to encode: the daemon writes stdin → `admitted`.
- `startup_pending`, `spawning`, a live oneShot, a batch already in flight, or a
  driver not yet ready to encode → `refused{startup_pending}`; a hard stop in
  flight → `refused{draining}`; the init-failure cooldown gate → `refused{cooldown}`.
  Rows stay pending until the daemon emits the next ready-for-drain (or, for a
  live oneShot, its next exit → respawn-with-batch).

Non-delivery controls remain fail-fast. A disconnected in-flight
`runtime_status`, `runtime_stop`, `rotate_token`, `runtime_clear_session`, or
lifecycle `runtime_start` is rejected to the caller and is not retried on
reconnect.

## Durability

The DB inbox plus `RuntimeDeliveryCoordinator` is the only durable delivery
queue. The WebSocket write buffer must be bounded and
non-durable.

On disconnect or backpressure:

- Delivery-backed `runtime_deliver` leaves its inbox rows pending on transport
  failure. Reconnect plus `runtime_ready_for_drain` replays through DB
  claim/rollback and `RuntimeDeliveryCoordinator`, not an in-memory transport
  queue.
- Non-delivery controls (`runtime_status`, `runtime_stop`, `rotate_token`,
  lifecycle `runtime_start`, etc.) fail fast to the caller with an explicit
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

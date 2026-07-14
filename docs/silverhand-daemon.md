# silverhand-daemon (AgentHost runtime boundary)

The daemon is **on the critical path**. It owns runtime spawn/supervision and the
`agent_materialize` flow, and the backend's **formal** server↔daemon
plane (runtime commands + materialize + runtime-event projection)
goes through the `OutboundFrameAdapter` port — embedded over the
local `daemon-outbound.sock`, standalone over WSS (see "Local
outbound frame socket" below and
`docs/daemon-outbound-protocol.md`).
`HostClient` over the control socket (`daemon.sock`) is scoped to
**desktop host-control IPC only** (ping / status / daemon-respawn
re-attach), not the formal data plane.

`silverhand-daemon` is a long-running child process that Electron main
(and `dev:headless`) spawns at startup. It owns a Unix-domain socket
under `~/.silverhand/run/daemon.sock` for desktop host-control IPC,
while the formal server↔daemon plane uses the separate
`daemon-outbound.sock` (below).

## Why a separate process

See `docs/architecture-principles.md`
§9 "AgentHost runtime boundary" for the long form. Short version:

- backend = IM/control plane (HTTP server, DB, ACL, routing).
- daemon = agent execution plane (process supervision, stdin/stdout,
  filesystem-anchored agent context).

These have different deployability stories. In the eventual remote
form, the backend can run on someone else's server while the daemon
runs on the user's machine (the only place that has the user's
filesystem, API keys, and a real `claude` binary). Encoding the
boundary in the local dev topology now means we never accidentally
write code that assumes "backend has direct access to spawn child
processes here".

## Where it runs

| context           | daemon launcher                                                   |
| ----------------- | ----------------------------------------------------------------- |
| `pnpm dev`        | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` + `packages/host/dist/daemon.js` |
| `pnpm dev:headless` | same as dev (Electron main spawns the daemon before backend boots) |
| packaged `.app`   | same Electron-as-Node trick, entry at `resourcesPath/silverhand-daemon/daemon.mjs` |

Mirror of the CLI launcher trick (`docs/build-release.md`) — same
reasoning, same shape, so we don't ship two runtimes.

## Files

- `packages/host/src/protocol.ts` — wire format + zod schemas (single
  source of truth for both sides).
- `packages/host/src/daemon/dispatcher.ts` — in-memory intent dispatch
  (no socket dependency; trivially unit-testable).
- `packages/host/src/daemon/server.ts` — Unix-socket server.
- `packages/host/src/daemon/lifecycle.ts` — pid file + signal handlers.
- `packages/host/src/daemon/run.ts` — composes the three into one
  `runDaemon()` primitive.
- `packages/host/src/daemon/entry.ts` — argv parser + process entry.
- `packages/host/src/client/index.ts` — `HostClient` (reconnect,
  pending-request table, typed errors).
- `packages/host/src/client/socket-transport.ts` — real Unix-socket
  transport.
- `packages/host/src/spawn.ts` — `spawnDaemonChild()` helper for
  Electron main / dev:headless launchers.

Outbound frame socket (see "Local outbound frame socket" below):

- `packages/host/src/daemon/local-outbound-frame-server.ts` — daemon
  server bound on a **separate** `daemon-outbound.sock` (0o600) that
  speaks the server↔daemon `OutboundFrame` envelope (NDJSON).
- `packages/host/src/daemon/outbound-frame-mapping.ts` — command /
  response / event mapping shared with the WSS outbound path.
- `packages/host/src/daemon/outbound-write-buffer.ts` —
  transport-neutral `OutboundFrameWriter` + 1024/4MiB backpressure
  policy (same for WSS and local socket; no unbounded daemon write
  queue).
- `packages/host/src/daemon/outbound-client.ts` /
  `packages/host/src/outbound-protocol.ts` — outbound frame schemas +
  helpers.

## Control-socket intent surface

| intent    | params               | result                                                                            |
| --------- | -------------------- | --------------------------------------------------------------------------------- |
| `ping`    | `{}`                 | `{ pong: true, daemon_pid, daemon_version, started_at }`                          |
| `status`  | `{}`                 | `{ daemon_pid, daemon_version, started_at, uptime_ms, intent_count, runtimes:[] }` |
| `echo`    | `{ message: string }` | `{ echoed: <message> }`                                                           |

Error codes (returned in `ResponseFrame.error.code`):

- `unknown_intent` — not in registry
- `invalid_params` — failed zod validation
- `internal_error` — handler threw
- `shutting_down` — daemon received SIGTERM/SIGINT
- `request_too_large` — frame > 1 MiB

## Lifecycle invariants

- One daemon per user host. Enforced by `~/.silverhand/run/daemon.pid`
  + `kill(pid, 0)` liveness probe. Stale pid files (process gone) are
  silently overwritten; live conflicts exit non-zero (code 2).
- Daemon socket file is `chmod 0o600` — only the spawning uid can
  connect. Filesystem permissions are the only authorization gate on the
  local control socket (no bearer token).
- Graceful shutdown drains in-flight intents, broadcasts a
  `shutting_down` event to every live connection, and unlinks the
  socket file.
- Stdout is reserved for the `ready` handshake event (one NDJSON line
  on successful bind). Stderr carries everything else.

## Backend integration

The embedded backend's formal server↔daemon path does not ride `HostClient` — it
dials the `OutboundFrameAdapter` (local `daemon-outbound.sock`).
`HostClient` survives only as desktop-main host-control IPC.

## Local outbound frame socket

The backend talks to the daemon's **formal**
server↔daemon plane (runtime commands + `agent_materialize` +
runtime-event projection) through one deployment-neutral
`OutboundFrameAdapter` port across both deployment modes; it does not reach the
embedded daemon through an in-process `HostClient`:

- **Standalone**: the daemon attaches to the backend over WSS; the
  adapter is `StandaloneOutboundFrameAdapter` wrapping
  `HostWsServerController`.
- **Embedded** (Electron main / `dev:headless`): the daemon binds an
  extra `LocalOutboundFrameServer` on `daemon-outbound.sock` (separate
  from the control socket above, 0o600), and the backend dials it
  via `EmbeddedUnixOutboundFrameAdapter`. The daemon is started with
  `--local-outbound-socket-path` (forwarded by `entry.ts` / `spawn.ts`;
  desktop derives it next to the control socket).

Both transports carry the **identical** `OutboundFrame` envelope and
share the command/response/event mapping
(`outbound-frame-mapping.ts`) and the 1024/4MiB write-backpressure
policy (`outbound-write-buffer.ts`). Liveness is socket-close only —
there is no durable transport queue or heartbeat; a dropped socket
rejects in-flight commands. `HostClient` survives **only** as
desktop-main host-control IPC (ping / status / daemon-respawn
re-attach), never for runtime/materialize data-plane business
commands. See `docs/daemon-outbound-protocol.md`.

## CLI surface

The daemon is intentionally **not** exposed through any
`silverhand` subcommand. The agent-facing CLI surface stays at
`message / task / channel / thread / workspace / file / schedule`;
daemon control (spawn / pid / version) belongs to the operator, not
the agent. See `docs/architecture-principles.md` §9.3 for the
rationale (host control plane vs. agent business plane).

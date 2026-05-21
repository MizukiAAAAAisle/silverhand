# silverhand-daemon (AgentHost runtime boundary — PR-1)

Status: PR-1 (IPC skeleton only). Not yet on the critical path.

## What it is

`silverhand-daemon` is a long-running child process that Electron main
(and `dev:headless`) spawns at startup. It owns a Unix-domain socket
under `~/.silverhand/run/daemon.sock`; the backend connects to that
socket through `HostClient` and speaks a tiny newline-delimited JSON
protocol.

PR-1 deliberately ships a minimum-viable surface — `ping`, `status`,
`echo` — so we can validate:

- process boundary works (real child process, real socket, real signal handling)
- IPC framing, schema validation, request/response correlation
- daemon crash + auto-restart semantics with a capped restart budget
- backend reconnect-with-backoff after disconnect
- packaging story (daemon bundle ships alongside the CLI bundle as
  `resourcesPath/silverhand-daemon/daemon.mjs`)

The daemon does **not** spawn agent CLIs yet — `ConversationManager`
still lives in `packages/backend`. PR-2 will migrate
spawn/inbox-drain/run-state into the daemon and the daemon will
become the only place those processes are owned.

## Why a separate process

See `#task:509` discussion (also captured in `docs/architecture-principles.md`)
for the long form. Short version:

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

## Intent surface (PR-1)

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
  connect. Filesystem permissions are the only authorization gate in
  PR-1 (no bearer token yet).
- Graceful shutdown drains in-flight intents, broadcasts a
  `shutting_down` event to every live connection, and unlinks the
  socket file.
- Stdout is reserved for the `ready` handshake event (one NDJSON line
  on successful bind). Stderr carries everything else.

## Backend integration

`startBackend({ ..., hostClient })` accepts an optional `HostClient`.
When present, backend pings the daemon at boot and logs the version.
Failure is logged as a warning, never fatal — PR-1 backend still works
without the daemon. PR-2 promotes this to required.

## CLI surface

The daemon is intentionally **not** exposed through any
`silverhand` subcommand. The agent-facing CLI surface stays at
`message / task / channel / thread / workspace / file / schedule`;
daemon control (spawn / pid / version) belongs to the operator, not
the agent. See `docs/architecture-principles.md` for the rationale
(host control plane vs. agent business plane).

## PR-2 hand-off

The follow-up PR will:

1. Move `ConversationManager` (spawn / inbox-drain / run-state) into
   the daemon.
2. Add `runtime_start` / `runtime_stop` / `runtime_wake` /
   `runtime_inject_env` intents.
3. Add runtime-event streaming (`runtime_state`, `runtime_output`)
   as unsolicited events the backend subscribes to.
4. Make `hostClient` required.

The wire format here is designed to absorb (2) and (3) without breaking
existing intents.

# @silverhand/backend

`@silverhand/backend` is the backend application core. It owns the HTTP app,
database wiring, repositories, services, auth/session logic, websocket servers,
runtime delivery fanout, and observability sinks.

The package exports `startBackend(...)` from `src/index.ts`. Callers choose the
deployment mode through `CreateBackendOptions`:

- `mode: 'embedded'` runs the backend inside the desktop app process. It uses a
  caller-provided `silverhandCliLauncher` and connects to the local daemon over
  the embedded outbound frame socket.
- `mode: 'standalone'` runs the same backend core as a remote-capable server.
  The standalone wrapper provides listen/data-dir/auth configuration before
  calling `startBackend(...)`.

This package should stay focused on backend behavior and shared server-side
contracts. It should not contain process-launch policy, environment variable
parsing for the standalone binary, or admin CLI argument handling; those belong
to `@silverhand/server`.

## Relationship to `@silverhand/server`

`@silverhand/server` depends on this package and turns it into runnable entry
points:

- desktop embedded boot calls `startEmbeddedSilverhandServer(...)`, which
  resolves desktop-specific paths/config and then calls `startBackend(...)` with
  `mode: 'embedded'`;
- the `silverhand-server` binary calls `startStandaloneSilverhandServer(...)`,
  which resolves standalone env/config/logging and then calls
  `startBackend(...)` with `mode: 'standalone'`;
- server admin commands reuse backend primitives such as repositories, password
  reset, database migration, and loggers.

In short: `backend` is the reusable application core; `server` is the Node
process and CLI wrapper around that core.

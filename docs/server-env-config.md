# Server Env Config

Stage D1.a introduces `@silverhand/server`, the standalone Node server
entrypoint used for remote control-plane deployments. Embedded desktop now uses
the same server package through `startEmbeddedSilverhandServer(...)`; the only
runtime difference is explicit config (`mode='embedded'` plus a daemon
`HostClient`) versus standalone config (`mode='standalone'`, no host runtime).

## Runtime Modes

- `embedded`: Electron main owns host-derived paths and the local
  `silverhand-daemon` connection, then calls `startEmbeddedSilverhandServer`.
  `/auth/embedded-bootstrap` is mounted only in this mode and still requires
  loopback, one-shot token, and `serverConfig.mode === 'embedded'`.
- `standalone`: `silverhand-server` owns data/control-plane state only. Agent
  runtime, spawn files, local workspace path materialization, and daemon
  outbound remain D2. Routes that would require a host runtime return
  `409 { code: "host_runtime_disabled" }` instead of silently dropping work.

## Variables

| Variable | Default | Validation | Source in Boot Log |
| --- | --- | --- | --- |
| `SILVERHAND_LISTEN` | `127.0.0.1:8080` | `host:port` or `[ipv6]:port`; port `0..65535` | `listen.source` |
| `SILVERHAND_DATA_DIR` | `/var/lib/silverhand` | absolute path | `dataDir.source` |
| `SILVERHAND_DISABLE_SIGNUP` | `0` | `0` or `1` | `disableSignup.source` |
| `SILVERHAND_LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` | `logLevel.source` |

`source` is `default` when the process used the default and `env` when the
variable was supplied. Invalid values fail before the HTTP listener starts.

## Data Layout

`SILVERHAND_DATA_DIR` is the persistent state root. D1.a uses the same layout
as embedded mode:

- `silverhand.db`
- `silverhand.db-wal` / `silverhand.db-shm` when SQLite WAL is active
- `blobs/`
- `workspaces/`
- `logs/`

Carrying an embedded-mode DB into standalone mode is unsupported in V1:
standalone control-plane mode does not reconcile embedded daemon runtime state,
and old schedules may target a disabled host runtime.

D1.b will add the Dockerfile, healthcheck wiring, and container volume
contract around this layout.

## Examples

Local standalone process:

```bash
SILVERHAND_LISTEN=127.0.0.1:8080 \
SILVERHAND_DATA_DIR=/var/lib/silverhand \
SILVERHAND_DISABLE_SIGNUP=1 \
SILVERHAND_LOG_LEVEL=info \
pnpm --filter @silverhand/server start
```

Ephemeral test boot:

```bash
SILVERHAND_LISTEN=127.0.0.1:0 \
SILVERHAND_DATA_DIR=/tmp/silverhand-server-test \
pnpm --filter @silverhand/server start
```

Standalone mode does not write `bootstrap_token_path` and does not mount
`/auth/embedded-bootstrap`; signup/login are the only human auth entrypoints.

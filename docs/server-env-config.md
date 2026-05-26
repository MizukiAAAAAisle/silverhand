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
  outbound remain D2. Routes that would require host work fail loudly with
  `code: "host_runtime_disabled"` instead of silently dropping work. Work-intent
  routes return `409`; read-only runtime availability probes return `503`.

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

`SILVERHAND_DATA_DIR` is the persistent state root. The default is
`/var/lib/silverhand`; systemd, pm2, and bare Node deployments should mount or
back up this directory as one state unit:

- `silverhand.db`
- `silverhand.db-wal` / `silverhand.db-shm` when SQLite WAL is active
- `blobs/`
- `workspaces/`
- `logs/`

`silverhand.db`, `silverhand.db-wal`, and `silverhand.db-shm` must live on the
same volume and filesystem. Do not split the SQLite sidecar files across
separate bind mounts; WAL mode relies on same-directory locking semantics.

`blobs/`, `workspaces/`, and `logs/` may be split in a future layout, but D1.b's
deployment contract treats the whole data root as one state unit. V1 standalone
is single-replica SQLite/WAL only.

Carrying an embedded-mode DB into standalone mode is unsupported in V1:
standalone control-plane mode does not reconcile embedded daemon runtime state,
and old schedules may target a disabled host runtime.

## Health And Readiness

- `GET /api/health`: liveness only. It keeps the existing public shape and
  returns 200 when the process can answer HTTP.
- `GET /readyz`: readiness. It returns 200 only after migrations have been
  applied, the listen socket is ready, and a DB write probe succeeds. Otherwise
  it returns 503 with per-check booleans.

Use `/readyz` for process supervisors that support readiness checks. Do not use
`/api/health` as a traffic-readiness signal.

## Native Dependencies

Route 1 V1 ships a Node server package, not an official server image. Operators
running it under systemd, pm2, or a bare Node process must install with Node 24
and ensure native dependencies such as `better-sqlite3` are built for that Node
ABI. If the deployment target differs from the build machine, rebuild native
dependencies on the target host before starting the service.

## Admin Recovery

Admin recovery is CLI-only; there are no `/admin/*` HTTP routes in V1.

Reset a registered user's password against the configured data dir:

```bash
SILVERHAND_DATA_DIR=/var/lib/silverhand \
silverhand-server admin reset-password --email shiki@example.com
```

By default the command reads the new password from a masked TTY prompt. For
non-interactive recovery, pass a one-shot owner-only file:

```bash
umask 177
read -r -s NEW_SILVERHAND_PASSWORD
printf '%s\n' "$NEW_SILVERHAND_PASSWORD" > /tmp/silverhand-new-password
unset NEW_SILVERHAND_PASSWORD
SILVERHAND_DATA_DIR=/var/lib/silverhand \
silverhand-server admin reset-password \
  --email shiki@example.com \
  --password-from-file /tmp/silverhand-new-password
```

`--password` is intentionally unsupported so shell history never captures the
secret. `--password-from-file` requires no group/other permissions and unlinks
the file after reading it. Successful reset updates the credential through the
normal password service, revokes every active session for that user, and writes
an audit line to `logs/cli-<utc>.log` with `admin_op`, `user_email`, `success`,
and `ts` fields. Unknown email fails with `user_not_found`; admin never creates
users.

Admin commands use the same SQLite database and acquire a write lock with
fail-fast semantics. If another process is writing the DB, the command exits
non-zero with `db_locked`; retry after the write lock is free.

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

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
| `SILVERHAND_MIGRATE` | standalone: `0`; embedded desktop: `1` | `0` or `1` | `migrate.source` |
| `SILVERHAND_EVENT_WS_ALLOWED_ORIGINS` | unset (empty) | comma-separated `http(s)` origins, each with no path/query/fragment; no wildcards | `eventWsAllowedOrigins.source` |

`source` is `default` when the process used the default and `env` when the
variable was supplied. Invalid values fail before the HTTP listener starts.

Set `SILVERHAND_EVENT_WS_ALLOWED_ORIGINS` to the public `Origin`(s) that
browsers/Electron use to reach this server when it sits behind a reverse proxy,
sandbox ingress, or any public URL. It is a **security allowlist** for the
authenticated event WebSocket — a legit desktop sends `Origin` = the origin it
reaches the backend at (pinned by the desktop main process), and a page from any
other origin is rejected. This is deliberately **not** derived from the server's
own bind URL, and it is **not** a topology hint: the server never advertises its
own reach origin, and connect commands are assembled desktop-side from the URL
the desktop is connected to (see `docs/orchestration-boundary-v1.md §4.3`).
Embedded desktop needs no value here — it seeds its loopback origin
automatically at bind time. Multiple origins are comma-separated:
`https://app.example.com,https://alt.example.com`.

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

## Schema Migrations

Fresh installs initialize the current schema without an opt-in. Existing
databases behave differently by deployment mode:

- If `silverhand.db` is already at the current code-supported schema version,
  startup is idempotent: no backup and no migration.
- Embedded desktop defaults to auto-upgrade because it is a single-user local DB.
  The same backup/lock/fail-loud migration runner still applies. Set
  `SILVERHAND_MIGRATE=0` only for debugging when you want startup to stop before
  applying pending migrations.
- Standalone server defaults to operator opt-in. If `silverhand.db` is older
  than the current code-supported schema version, startup fails by default with
  a message that includes the detected version, target version, sibling backup
  path pattern, and `SILVERHAND_MIGRATE=1`.
- When migration is allowed (`SILVERHAND_MIGRATE=1`, or embedded default),
  startup first checkpoints WAL, copies the entire
  data directory to a sibling backup directory named
  `<data_dir>-backup-<utc>/`, then applies pending migrations. Example:
  `/var/lib/silverhand` backs up to `/var/lib/silverhand-backup-20260526T140000Z/`.
  Runtime-only filesystem nodes such as Unix sockets, FIFOs, and device nodes
  are skipped because they are not restorable Silverhand state.
- If backup copy fails, migrations do not run and startup exits non-zero.
- If the DB schema is newer than this server binary supports, startup always
  fails, even with `SILVERHAND_MIGRATE=1`; restore a compatible backup instead
  of running an older binary against a newer DB.

Backup retention is operator-owned. Silverhand creates a new timestamped
sibling directory for every opted-in migration and does not prune older backups.
Startup and admin commands hold a sibling `<data_dir>.migration.lock` directory
only for the migration phase so concurrent upgrade attempts fail fast.
If startup fails with `migration_locked` after a crashed migration attempt,
manually remove the lock directory shown in the error message before retrying.

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
non-zero with `db_locked`; retry after the write lock is free. If another
startup or admin process is in the migration phase, the command exits
non-zero with `migration_locked`.

## Examples

Local standalone process:

```bash
SILVERHAND_LISTEN=127.0.0.1:8080 \
SILVERHAND_DATA_DIR=/var/lib/silverhand \
SILVERHAND_DISABLE_SIGNUP=1 \
SILVERHAND_LOG_LEVEL=info \
pnpm --filter @silverhand/server start
```

Standalone opt-in schema upgrade:

```bash
SILVERHAND_MIGRATE=1 \
SILVERHAND_DATA_DIR=/var/lib/silverhand \
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

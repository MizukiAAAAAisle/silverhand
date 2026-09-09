# Rust Server Environment Configuration

The executable is `silverhand-backend` (`rust/crates/backend-app`). Both Desktop
and standalone deployment launch this binary with explicit paths and a deployment
profile. The former Node `SILVERHAND_LISTEN`, `SILVERHAND_DATA_DIR`,
`SILVERHAND_EVENT_WS_ALLOWED_ORIGINS`, and `SILVERHAND_LOG_LEVEL` variables are
not Rust configuration aliases.

## Variables

| Variable                          | Contract                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SILVERHAND_DEPLOYMENT_PROFILE`   | Required: `embedded` or `remote-only`. The latter advertises deployment mode `standalone`.                                                                                                                      |
| `SILVERHAND_DATABASE_PATH`        | Required, nonempty path to the SQLite database file.                                                                                                                                                            |
| `SILVERHAND_BLOBS_ROOT`           | Required, nonempty blob directory path.                                                                                                                                                                         |
| `SILVERHAND_LOG_DIR`              | Required, writable diagnostic and categorized audit log directory.                                                                                                                                              |
| `SILVERHAND_LISTEN_ADDR`          | Required numeric IP socket address, e.g. `0.0.0.0:8080` or `[::1]:8080`.                                                                                                                                        |
| `SILVERHAND_ALLOWED_ORIGINS`      | Required, nonempty comma-separated event WebSocket origin allowlist. Use the actual client-facing HTTPS origin.                                                                                                 |
| `SILVERHAND_METRICS_LISTEN`       | Optional; unset or empty disables metrics. Numeric loopback IP socket only, e.g. `127.0.0.1:9464` or `[::1]:9464`. Wildcards, LAN addresses and DNS names are rejected. Port 0 is allowed for isolated callers. |
| `SILVERHAND_CONSOLE_TOKEN`        | Optional; enables the token-gated ECS Console on the product listener. Requires `remote-only` and 32–256 visible ASCII characters. Independent of metrics; expose through the existing HTTPS ingress.           |
| `SILVERHAND_DISABLE_SIGNUP`       | Remote-only: unset/empty or `0` enables signup; `1` disables it; other values fail. Embedded preserves the launcher contract: only exact `1` disables signup.                                                   |
| `SILVERHAND_MIGRATE`              | `0` or `1`; defaults to `0` for remote-only, `1` for embedded. Fresh databases initialize without an upgrade opt-in.                                                                                            |
| `SILVERHAND_DAEMON_NPM_SPEC`      | Optional explicit daemon package specification.                                                                                                                                                                 |
| `SILVERHAND_BOOTSTRAP_TOKEN_PATH` | Optional launcher-owned token file; armed only for embedded on actual loopback bind.                                                                                                                            |
| `SILVERHAND_STARTUP_GENERATION`   | Optional launcher correlation token. Emits one stdout `bound` frame containing the actual API address; not a readiness claim.                                                                                   |
| `RUST_LOG`                        | Tracing filter; defaults to the ERROR floor, with activity-retention INFO summaries and credential-free Console authorization rejection WARN events.                                                            |

Use absolute paths in service configuration. `SILVERHAND_ALLOWED_ORIGINS` is a
security allowlist, not the backend bind address or a topology advertisement.
Embedded composition also permits its actual bound loopback origin.

## Listener and readiness contract

`GET /api/health` is liveness. `/readyz` checks migrations, the bound API listener,
a real `BEGIN IMMEDIATE`/rollback write probe and, for standalone, outbound fanout
installation. A failed check returns 503.

Metrics has an independent listener. Only its `GET /metrics` exports Prometheus
text; `/metrics` on the API listener refuses every method with 403 even when
metrics is disabled. Never expose port 9464 through public ingress.

A configured metrics bind failure aborts startup before database preparation.
The executable owns the exporter and its upkeep; unexpected exporter termination
requests application shutdown and produces a failing process exit. SIGTERM and
SIGINT drain the existing application shutdown path and close both listeners.
See [Server Observability](server-observability.md).
See [ECS Console Dashboard](ecs-console.md) for the separate product-count read model.

## Data and upgrades

SQLite and its WAL/SHM files stay on the same filesystem. There is one server
owner of the data directory. Do not open a running user's database with an
external SQLite client for inspection or backup.

The shared migration plan (`packages/shared/src/backend-migration-plan.json`)
and `backend-sqlite/src/foundation/database_startup.rs` define Rust's upgrade
contract. Startup refuses unknown/newer, too-old or inconsistent ledgers. Existing
standalone databases require `SILVERHAND_MIGRATE=1` to advance. Preparation holds
SQLite exclusive locking across backup and step commits; it does not use the old
Node migration-lock directory. A pre-upgrade backup copies the database parent
and uses SQLite `VACUUM INTO` for a consistent database before migration. Blob
roots outside that parent need their own deployment backup coverage. Retention is
operator-owned; an older binary may require the matching pre-upgrade data backup.

Do not run the former Node admin recovery commands against a Rust-owned live
database. Rust's executable currently has no matching admin subcommand contract.

## Standalone example

Create and secure the directories before launch, then supply the deployment's
actual paths and origin:

```bash
SILVERHAND_DEPLOYMENT_PROFILE=remote-only \
SILVERHAND_DATABASE_PATH=/var/lib/silverhand/silverhand.db \
SILVERHAND_BLOBS_ROOT=/var/lib/silverhand/blobs \
SILVERHAND_LOG_DIR=/var/log/silverhand \
SILVERHAND_LISTEN_ADDR=127.0.0.1:8080 \
SILVERHAND_ALLOWED_ORIGINS=https://silverhand.example.com \
SILVERHAND_METRICS_LISTEN=127.0.0.1:9464 \
SILVERHAND_DISABLE_SIGNUP=1 \
/path/to/silverhand-backend
```

Build for the target CPU and Linux ABI; a macOS binary cannot run on ECS. Build,
staging, backup and the authorized service cutover are separate operations. The
[deployment checklist](rust-server-ecs-deployment-checklist.md) points to the ECS
operating manual. This configuration document is not a production deployment record.

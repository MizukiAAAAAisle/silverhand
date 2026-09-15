# Server Observability

Silverhand standalone exposes Prometheus metrics only when
`SILVERHAND_METRICS_LISTEN` is configured. The metrics listener is a separate
HTTP server from the public API and refuses non-loopback bind addresses.

```bash
SILVERHAND_METRICS_LISTEN=127.0.0.1:9464
```

The endpoint is `GET /metrics`. Do not add it to the public Nginx ingress.

## Current Rust coverage

- HTTP duration/count/status-class histograms, through response-body completion
  or cancellation, using router templates rather than request URLs;
- process CPU, resident/virtual memory, file descriptors, thread count and start
  time (platform-supported process collector fields);
- SQLite readiness write-probe duration/outcome;
- host WebSocket upgrade/ready/close, open connection count, protocol mismatch
  and compatible ready protocol distribution; socket lifetime owns gauge cleanup;
- server-to-daemon command duration/outcome at the actual command transport;
- explicitly named SQLite host lifecycle/list/detail/status/resource and
  credential statements, plus readiness BEGIN/rollback. This is not whole-database
  SQL coverage; uninstrumented query owners do not emit an `unknown` query name.

The `silverhand_*` application metric names, label keys and histogram bucket
boundaries retain the previous Prometheus contract. `deployment_mode` is
`embedded` or `standalone`. Route parameters use `:name` label spelling; an
unmatched route is `unmatched`, and nonstandard HTTP methods collapse to `OTHER`.
SQL outcomes are `ok`, `busy`, `locked`, `error`, using SQLite's primary numeric
error code (including extended BUSY/LOCKED codes). Query names are source-owned
static identifiers; internal queries that have changed shape receive descriptive
names instead of pretending to be the old statement.

The library crates emit through the `metrics` facade. Only the executable owns
and installs a Prometheus recorder, and without configured metrics the facade is
no-op. An upkeep loop drains histogram observations every five seconds even
when Prometheus is unavailable. Library events do not depend on `RUST_LOG` or on
parsing diagnostic log messages.

Node heap, GC and event-loop metrics are retired from the Rust dashboard and
rules. The process memory panel retains `process_resident_memory_bytes` and adds
virtual memory. `silverhand_tokio_scheduling_delay_seconds` measures the lateness
of a five-second Tokio timer; it is not a Node event-loop p99 or utilization
measurement. The corresponding Rust scheduling-delay alert uses its own name.

Metrics never use raw URL paths, host/user/agent/conversation ids, SQL text,
SQL parameters, daemon payloads or arbitrary close-reason strings as labels.
Protocol offers are bounded by the existing 0..100 admission envelope; close codes
and reasons use a fixed classification. A compatible-ready gauge means the wire
compatibility gate passed, not that all downstream hydration has completed.

## Diagnostic logging

The Rust production JSON sink preserves formatted tracing messages, `%Display`
errors and `?Debug` diagnostic context. Formatting alone must never cause an
event's message or error to be discarded: dependency events such as axum's
`accept error: {e}` must retain the actual OS error. This applies to both file
and stderr output and does not require a special wrapper at each call site.

Explicit content/environment and credential fields remain filtered; values whose
formatted representation is valid JSON receive the same recursive filtering.
Arbitrary prose and Rust Debug
structs are retained as text, not treated as reliably parseable secret containers.
Call sites must therefore keep credentials in secret types or explicit filtered
fields, never interpolate tokens into error messages or dump authentication
objects. The formatter does not promise to discover secrets embedded in text.
Normal causes, error codes and diagnostic coordinates must not be hidden behind
redaction counters. Existing log levels, retention and CLI request correlation
are unchanged.

## Named SQLite statements

Adapters wrap the actual SQLx execution future with
`foundation::statement_metrics::statement(stable_name, operation, future)`.
`get`, `all` and `run` preserve the old operation vocabulary. Duration includes
pool acquisition, SQLite lock wait and fetching, but not business-row decoding.
The wrapper returns the original result unchanged. Readiness instruments its
own BEGIN/rollback as statements as well as the complete probe, so the contention
alert can detect a writer lock even when user traffic is absent.

## Temporary single-ECS deployment

The checked-in starting configuration is under `ops/observability/`:

- `prometheus.yml` scrapes Silverhand and node_exporter on loopback;
- `silverhand-alerts.yml` contains the initial service alerts;
- `grafana/provisioning/` provisions the local Prometheus datasource and the
  Silverhand overview dashboard;
- `logrotate-silverhand` caps logs in the configured `SILVERHAND_LOG_DIR` without
  requiring the running server to reopen file descriptors.

For a temporary same-host deployment:

1. Run Prometheus, Grafana, and node_exporter as native/systemd services so
   `127.0.0.1` consistently means the ECS host. A container needs explicit
   host networking; do not change the app metrics bind to `0.0.0.0` merely to
   accommodate container networking.
2. Start Prometheus with both a time and size bound, for example
   `--storage.tsdb.retention.time=7d` and
   `--storage.tsdb.retention.size=5GB`.
3. Bind Prometheus and Grafana themselves to loopback. Reach Grafana through an
   SSH tunnel while this is an owner-only deployment; do not add an unauthenticated
   public proxy route.
4. Put Prometheus/Grafana data outside `SILVERHAND_DATA_DIR` and set systemd
   `MemoryMax`, `CPUQuota`, and log rotation. Monitoring must not compete with
   SQLite's data/WAL path for an unbounded disk budget.
5. Keep one external uptime probe against public `/readyz`. Same-ECS Prometheus
   cannot report an ECS-wide outage after the machine disappears.

The checked-in Prometheus rules are local evaluations only. Notifications still
require an Alertmanager receiver; do not call alerting complete until a real
owner channel and a test notification are configured.

This is incident-local visibility, not durable monitoring. When a remote sink
is available, keep the app's Prometheus/OTLP contracts and move retention off
the application host rather than redesigning instrumentation.

## Rust log retention

Diagnostics are `rust-backend.YYYY-MM-DD.log` under `SILVERHAND_LOG_DIR`; the
process appender rolls daily and retains at most 14 matching files. Categorized
CLI/agent audit logs share the directory and have separate retention needs.
The checked-in logrotate template is only a 100 MiB size fallback using
copytruncate. Replace its example path with the real log root and run the check
frequently enough for the intended disk budget; it is not a hard disk quota.
Do not carry the old seven-day cleanup into the Rust diagnostic directory
without explicitly reconciling it with the appender's retention. Rotated
compressed copies are retained by logrotate, not counted as the appender's daily
files. See [Rust server logging](rust-server-logging.md).

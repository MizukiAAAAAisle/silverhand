# Server Observability

Silverhand standalone exposes Prometheus metrics only when
`SILVERHAND_METRICS_LISTEN` is configured. The metrics listener is a separate
HTTP server from the public API and refuses non-loopback bind addresses.

```bash
SILVERHAND_METRICS_LISTEN=127.0.0.1:9464
```

The endpoint is `GET /metrics`. Do not add it to the public Nginx ingress.

## Current coverage

- normalized HTTP route duration/count/status-class histograms;
- Node process metrics, native event-loop-delay percentiles, and event-loop
  utilization;
- readiness `BEGIN IMMEDIATE` write-probe duration/outcome;
- host websocket upgrade/ready/close, current connection count, protocol
  mismatch, and ready connection protocol distribution;
- server-to-daemon command duration/outcome;
- named SQLite statement duration/outcome for migrated query owners. HostRepo,
  including the high-volume host list/status support queries, is the first
  fully named repository. Other repositories remain migration work and are not
  silently reported under an `unknown` query label.

Metrics never use raw URL paths, host/user/agent/conversation ids, SQL text, or
SQL parameters as labels. Those identifiers remain structured-log fields.

## Named SQLite statements

Query owners use the explicit prepare seam:

```ts
const statement = prepareObserved<[string], HostRow>(
  db,
  'hosts.get_by_id',
  'SELECT * FROM hosts WHERE id = ?',
);
```

Names are stable low-cardinality identities. `run`, `get`, `all`, and the
actual synchronous work performed by `iterate` are timed. Slow/failing logs
carry the query name, operation, duration, outcome, and current request id;
they never include SQL text or bound values. Chaining methods return the
explicit `ObservedStatement` surface so instrumentation cannot escape through
`pluck`, `raw`, `expand`, `safeIntegers`, or `bind`.

## Temporary single-ECS deployment

The checked-in starting configuration is under `ops/observability/`:

- `prometheus.yml` scrapes Silverhand and node_exporter on loopback;
- `silverhand-alerts.yml` contains the initial service alerts;
- `grafana/provisioning/` provisions the local Prometheus datasource and the
  Silverhand overview dashboard;
- `logrotate-silverhand` caps the existing boot-scoped JSONL logs without
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

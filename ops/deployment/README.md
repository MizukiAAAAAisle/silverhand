# Rust server process recovery

`silverhand-server.service` is a **user unit candidate**, not an installation or
production approval. Install only after the deployment task has resolved its
protocol, data and release gates. The production user already has lingering
configured; verify it again at cutover.

The unit starts the selected immutable release through
`~/.local/lib/silverhand/current/silverhand-backend`. Its required environment file
is `~/.config/silverhand-server/server.env` (directory 0700, file 0600). Resolve
Rust configuration explicitly using `docs/server-env-config.md`; never source or
print a production secret file or reuse Node variable names without translation.
The data directory must already exist. These locations are proposed deployment
paths, not claims about current production state.

The foreground process is systemd's MainPID. There is no detached launcher or
second PID-file authority. Stop the verified old Node process before starting
this unit. Do not enable both launch mechanisms. `Type=simple` means process
creation, not readiness: check health, readyz and private metrics separately.

An abnormal exit retries after five seconds, with at most three starts in five
minutes. Hitting the limit requires diagnosis and an explicit reset/start after
repair; there is no timer that silently defeats the limit. An administrative
`systemctl --user stop silverhand-server` does not trigger recovery.

Stopping sends SIGTERM to the service cgroup and allows 90 seconds for cleanup.
Automatic SIGKILL is disabled. A stop timeout is a deployment blocker: inspect
MainPID, cgroup and bound ports, and do not switch releases or restore data while
any old process survives. Do not force-kill production as an implicit fallback.
Core dumps are disabled to avoid capturing credentials or message contents.

Runtime JSONL retention and journald retention are independent. Confirm the
existing retention job's directory and PID assumptions before deploying this
unit; this template does not replace that job.

Before production, exercise this exact unit in isolated Linux with the frozen
binary and an empty private store: boot/readiness, crash and changed MainPID,
recovered metrics, stop without restart, and persistent startup failure reaching
the rate limit. Keep evidence of systemd version, binary hash and effective unit.
No production DB or secret is needed for these tests. In a fresh disposable
Linux environment with a working ordinary-user systemd manager, run:

```bash
bash scripts/test-rust-systemd-recovery.sh --isolated /path/to/silverhand-backend ops/deployment/silverhand-server.service
```

The script refuses existing target paths, uses loopback ports 18080/19464, and
leaves its isolated store for inspection. It stops its service on exit. Its
SIGKILL is intentional fault injection for that disposable service only.

The semantics are defined in systemd 239's upstream
[service manual](https://github.com/systemd/systemd/blob/v239/man/systemd.service.xml)
and [unit manual](https://github.com/systemd/systemd/blob/v239/man/systemd.unit.xml),
matching the production systemd major version. Production rollback still needs a
paired binary/environment/data snapshot; this unit alone cannot supply one.

## Console HTTPS ingress

This Console candidate uses the existing product listener, independently of the
private metrics listener. Enable it with `SILVERHAND_CONSOLE_TOKEN` in the
protected server environment file and the `remote-only` profile. See
[Console access and token lifecycle](../../docs/ecs-console.md#enable-and-access).
The operator entry is `/console` on the deployment's configured HTTPS origin.
Resolve the domain from the current deployment configuration; these files do not
change the live deployment.

For an Nginx ingress, include `silverhand-console-http.conf` inside `http {}` and
`silverhand-console-routes.conf` inside the existing HTTPS `server {}` for that
domain. Set the upstream to the actual product address (the reference uses
`127.0.0.1:8080` for a colocated edge), and use a writable, rotated access-log
path. Keep the domain's existing certificate, HTTP-to-HTTPS redirect, product API
and WebSocket locations. Reconcile any existing matching locations rather than
adding duplicates. Check the full effective configuration with `nginx -t` before
an authorized reload. This is a reference adapter, not evidence that production
uses Nginx or authorization to install it.

The route snippet forwards the path/query unchanged and explicitly preserves
Authorization. It disables inherited caching, response buffering and error
interception. Its access log records only timestamp, fixed route family, method,
status and elapsed time. Do not add URL tokens or header/request debug logging.
`/metrics` and `/metrics/*` are rejected at the edge; the backend also rejects
public `/metrics`. No route targets the private metrics listener.

The upstream Nginx documentation describes
[proxy URI and header handling](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)
and [HTTPS server configuration](https://nginx.org/en/docs/http/configuring_https_servers.html).
For another ingress, preserve the same routing, authentication-header, cache and
logging contract rather than installing another proxy layer.

Verify the exact snippets against a built candidate with Python 3, Nginx and
OpenSSL available:

```bash
python3 scripts/test-console-https.py --binary /absolute/path/to/silverhand-backend
```

The script creates an empty isolated store, an ephemeral token, a temporary TLS
certificate and three loopback listeners. It verifies the certificate against
its own test CA, runs `nginx -t`, exercises all Console API gates through HTTPS,
checks query forwarding, no-store and metrics isolation, and checks credential-
free rejection logs at the ERROR floor. It cleans up only its child processes and
prints the retained artifact directory. It does not install certificates, read
production secrets or modify existing services. Production ingress validation
and deployment remain a separate release step.

The browser credential lifecycle has a dependency-free regression check:

```bash
node scripts/test-console-token-memory.mjs
```

It executes the shipped inline script with fresh page contexts sharing origin
storage, checks legacy-key removal without token reads/writes, reload/disconnect/
pagehide clearing, and late responses that must not restore a previous session.

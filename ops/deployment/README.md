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

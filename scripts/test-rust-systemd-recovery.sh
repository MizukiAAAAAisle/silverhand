#!/usr/bin/env bash
# Run only in a disposable Linux VM, as its ordinary user, with no production data.
set -euo pipefail
[[ "${1:-}" == --isolated ]] && [[ $# == 3 ]] || {
  echo 'Usage: test-rust-systemd-recovery.sh --isolated BINARY UNIT' >&2
  exit 2
}

binary=$(realpath "$2")
unit=$(realpath "$3")
service=silverhand-server.service
root="$HOME/silverhand-data"
config="$HOME/.config/silverhand-server"
release="$HOME/.local/lib/silverhand/current"
[[ ! -e "$root" && ! -e "$config" && ! -e "$release" ]]
[[ ! -e "$HOME/.config/systemd/user/$service" ]]
[[ $(id -u) != 0 ]]

umask 077
mkdir -p "$root" "$config" "$release" "$HOME/.config/systemd/user"
install -m 755 "$binary" "$release/silverhand-backend"
install -m 644 "$unit" "$HOME/.config/systemd/user/$service"
cat > "$config/server.env" <<ENV
SILVERHAND_DIR=$root
SILVERHAND_DATABASE_PATH=$root/server.db
SILVERHAND_BLOBS_ROOT=$root/blobs
SILVERHAND_LOG_DIR=$root/logs
SILVERHAND_DEPLOYMENT_PROFILE=remote-only
SILVERHAND_LISTEN_ADDR=127.0.0.1:18080
SILVERHAND_METRICS_LISTEN=127.0.0.1:19464
SILVERHAND_ALLOWED_ORIGINS=http://127.0.0.1:18080
ENV

cleanup() {
  systemctl --user stop "$service" || true
}
trap cleanup EXIT
systemd-analyze --user verify "$HOME/.config/systemd/user/$service"
systemctl --user daemon-reload
systemctl --user start "$service"

ready() {
  for ((attempt=0; attempt<100; attempt++)); do
    if curl --max-time 1 -fsS http://127.0.0.1:18080/readyz > "$root/ready.json" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}
ready
old_pid=$(systemctl --user show "$service" -p MainPID --value)
[[ "$old_pid" -gt 1 ]]
curl -fsS http://127.0.0.1:19464/metrics > "$root/metrics.before"

# This signal is exclusively for the disposable test process owned by this unit.
systemctl --user kill --kill-who=main --signal=SIGKILL "$service"
for ((attempt=0; attempt<100; attempt++)); do
  new_pid=$(systemctl --user show "$service" -p MainPID --value)
  [[ "$new_pid" -gt 1 && "$new_pid" != "$old_pid" ]] && break
  sleep 0.2
done
[[ "$new_pid" -gt 1 && "$new_pid" != "$old_pid" ]]
ready
curl -fsS http://127.0.0.1:19464/metrics > "$root/metrics.after"
[[ $(curl -sS -o "$root/public-metrics" -w '%{http_code}' http://127.0.0.1:18080/metrics) == 403 ]]
echo "crash_recovery=PASS old_pid=$old_pid new_pid=$new_pid"

systemctl --user stop "$service"
sleep 6
[[ $(systemctl --user show "$service" -p ActiveState --value) == inactive ]]
[[ $(systemctl --user show "$service" -p MainPID --value) == 0 ]]
echo 'manual_stop_no_restart=PASS'

# Force a deterministic pre-DB configuration failure, then inspect the limit.
printf '\nSILVERHAND_METRICS_LISTEN=0.0.0.0:19464\n' >> "$config/server.env"
# A stopped, unreferenced unit may already have been garbage-collected, which
# also clears its counters. If still loaded, reset this unit only.
if systemctl --user list-units --all --plain --no-legend "$service" | grep -q "$service"; then
  systemctl --user reset-failed "$service"
fi
systemctl --user start "$service"
for ((attempt=0; attempt<150; attempt++)); do
  state=$(systemctl --user show "$service" -p ActiveState --value)
  restarts=$(systemctl --user show "$service" -p NRestarts --value)
  [[ "$state" == failed && "$restarts" == 3 ]] && break
  sleep 0.2
done
[[ "$state" == failed && "$restarts" == 3 ]]
sleep 6
[[ $(systemctl --user show "$service" -p ActiveState --value) == failed ]]
[[ $(systemctl --user show "$service" -p NRestarts --value) == 3 ]]
[[ $(systemctl --user show "$service" -p MainPID --value) == 0 ]]
echo 'persistent_failure_rate_limit=PASS'
systemctl --user show "$service" -p Restart -p RestartUSec -p StartLimitBurst -p StartLimitIntervalUSec -p Result
sha256sum "$release/silverhand-backend"
systemctl --version | head -1

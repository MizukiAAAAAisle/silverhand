#!/usr/bin/env bash
# Isolated standalone Rust server for local multi-client acceptance.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == --help ]]; then
  echo "Usage: $0 [bind-ip (default 127.0.0.1)] [port (default 18080)]"
  echo "Data persists only under <repo>/.cache/local-standalone-server. Ctrl-C stops the server."
  echo "For Desktop remote mode, use your Mac's LAN IPv4 address, not localhost."
  exit 0
fi
if [[ $# -gt 2 ]]; then
  echo "Too many arguments; use --help." >&2
  exit 2
fi

BIND_IP="${1:-127.0.0.1}"
SERVER_PORT="${2:-18080}"
python3 - "$BIND_IP" "$SERVER_PORT" <<'PY'
import ipaddress, sys
address = ipaddress.IPv4Address(sys.argv[1])
if address.is_unspecified or address.is_multicast:
    raise SystemExit('Use one explicit local IPv4 address, not 0.0.0.0 or multicast.')
if not sys.argv[2].isdigit() or not 1024 <= int(sys.argv[2]) <= 65535:
    raise SystemExit('Port must be an integer between 1024 and 65535.')
PY

DATA_DIR="$REPO_DIR/.cache/local-standalone-server"
SERVER_ORIGIN="http://$BIND_IP:$SERVER_PORT"
umask 077
mkdir -p "$DATA_DIR/blobs" "$DATA_DIR/logs"

cargo build --manifest-path "$REPO_DIR/rust/Cargo.toml" \
  -p silverhand-backend-app --bin silverhand-backend
TARGET_DIR="$(cargo metadata --manifest-path "$REPO_DIR/rust/Cargo.toml" \
  --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
SERVER_BINARY="$TARGET_DIR/debug/silverhand-backend"

printf 'Server: %s\nTest data: %s\nSignup: enabled (test accounts only)\n' "$SERVER_ORIGIN" "$DATA_DIR"
# An explicit clean environment prevents inherited production database, console,
# bootstrap, metrics or listener settings from leaking into this test process.
exec env -i PATH="$PATH" HOME="$HOME" \
  SILVERHAND_DIR="$DATA_DIR" \
  SILVERHAND_DEPLOYMENT_PROFILE=remote-only \
  SILVERHAND_DATABASE_PATH="$DATA_DIR/im.db" \
  SILVERHAND_BLOBS_ROOT="$DATA_DIR/blobs" \
  SILVERHAND_LOG_DIR="$DATA_DIR/logs" \
  SILVERHAND_LISTEN_ADDR="$BIND_IP:$SERVER_PORT" \
  SILVERHAND_ALLOWED_ORIGINS="$SERVER_ORIGIN,http://localhost:5173" \
  SILVERHAND_DISABLE_SIGNUP=0 \
  SILVERHAND_MIGRATE=1 \
  "$SERVER_BINARY"

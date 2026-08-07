#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=../_native.sh
source "$ROOT_DIR/scripts/_native.sh"

ELECTRON_VERSION="$(
  node -p "require('./apps/desktop/package.json').devDependencies.electron" |
    sed 's/^[\^~]//'
)"
ELECTRON_ABI="$(
  node -p "require('node-abi').getAbi('$ELECTRON_VERSION', 'electron')"
)"

if [[ -z "$ELECTRON_ABI" ]]; then
  echo "[client-perf] could not resolve Electron ABI for $ELECTRON_VERSION" >&2
  exit 1
fi

locate_binding
ensure_binding "$ELECTRON_ABI" \
  "pnpm --filter @silverhand/desktop exec electron-rebuild -f -w better-sqlite3" \
  "client-perf (electron $ELECTRON_VERSION)"

# The shared helper's hash+stamp catches normal external replacement. Probe with
# Electron's own Node runtime as the final authority for this launch; unlike a
# system-node require, this cannot crash merely because the target is Electron.
probe_electron_binding() {
  ELECTRON_RUN_AS_NODE=1 pnpm --filter @silverhand/desktop exec electron -e \
    "const Database = require('better-sqlite3'); new Database(':memory:').close()" \
    >/dev/null 2>&1
}

if ! probe_electron_binding; then
  echo "[client-perf] cached Electron ABI binding failed its runtime probe — rebuilding"
  pnpm --filter @silverhand/desktop exec electron-rebuild -f -w better-sqlite3
  cp "$BINDING" "$CACHE_DIR/$CACHE_KEY-abi-$ELECTRON_ABI.node"
  _record_active "$ELECTRON_ABI"
  probe_electron_binding
fi

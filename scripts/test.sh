#!/usr/bin/env bash
# Run the backend + server test suites under system node.
#
# better-sqlite3 carries a single native .node binding compiled for one
# specific NODE_MODULE_VERSION. dev.sh swaps it to electron's ABI for the
# UI; this script swaps to system node's ABI for vitest. The first build
# per ABI is real work; later switches just `cp` from a per-ABI cache —
# see scripts/_native.sh. The swap is on the shared workspace
# better-sqlite3 install, so it covers every package's vitest run.
#
# Usage: ./scripts/test.sh [vitest args]
#   - no args  → full gate: @silverhand/backend AND @silverhand/server.
#   - with args → pass-through to @silverhand/backend only (targeted runs,
#     e.g. `./scripts/test.sh packages/backend/src/foo.test.ts -t name`).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=./_native.sh
source "$ROOT_DIR/scripts/_native.sh"

NODE_VER="$(node -p 'process.versions.node')"
NODE_ABI="$(node -p 'process.versions.modules')"

locate_binding
ensure_binding "$NODE_ABI" \
  "( cd '$BSQ_DIR' && npx -y node-gyp@latest rebuild --release )" \
  "test (node $NODE_VER)" \
  1

if [ "$#" -eq 0 ]; then
  # Full gate run: both host-agnostic packages. Fail-fast (set -e) means
  # a backend failure stops before server runs — acceptable for a gate.
  pnpm --filter @silverhand/backend test
  exec pnpm --filter @silverhand/server test
fi

# Targeted pass-through stays backend-scoped (documented behavior). Run a
# specific server test directly with `pnpm --filter @silverhand/server test`.
exec pnpm --filter @silverhand/backend test "$@"

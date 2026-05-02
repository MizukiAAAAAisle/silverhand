#!/usr/bin/env bash
# Run backend test suites under system node.
#
# better-sqlite3 carries a single native .node binding compiled for one
# specific NODE_MODULE_VERSION. dev.sh swaps it to electron's ABI for the
# UI; this script swaps to system node's ABI for vitest. The first build
# per ABI is real work; later switches just `cp` from a per-ABI cache —
# see scripts/_native.sh.
#
# Usage: ./scripts/test.sh [vitest args]

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

exec pnpm --filter @silverhand/backend test "$@"

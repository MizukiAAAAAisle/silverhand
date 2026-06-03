#!/usr/bin/env bash
# Run the project test suites under system node.
#
# better-sqlite3 carries a single native .node binding compiled for one
# specific NODE_MODULE_VERSION. dev.sh swaps it to electron's ABI for the
# UI; this script swaps to system node's ABI for vitest. The first build
# per ABI is real work; later switches just `cp` from a per-ABI cache —
# see scripts/_native.sh. The swap is on the shared workspace
# better-sqlite3 install, so it covers every package's vitest run.
#
# Why this script wraps EVERY test entry (and root `pnpm test` does not
# delegate to `pnpm -r run test`):
#   The ABI swap is a workspace-level mutation. If anyone ever runs
#   `pnpm --filter @silverhand/<pkg> test` directly without going through
#   here first, the swap won't have happened and they'll either crash
#   (electron ABI under node) or silently load the wrong binding.
#   Keeping the swap pinned to `scripts/test.sh` and routing the root
#   `pnpm test` exclusively through it makes "ABI swap before any vitest"
#   an invariant that does not depend on caller habit.
#
# Default (no args): full gate across every workspace package that owns
# tests — shared, backend, server, host, cli, desktop. All packages share
# the workspace's single better-sqlite3 install, so we ensure_binding
# ONCE up top, then fan out. Order chosen for fail-fast value:
#   shared first  (if zod schemas / shared classifiers break, every
#                  downstream test would fail)
#   backend       (largest surface — most likely to surface the next
#                  regression)
#   server        (depends on shared + backend internal API)
#   host          (daemon-side — depends on shared)
#   cli           (small)
#   desktop       (renderer-side, fastest)
# `set -euo pipefail` means a failure in any one stops the rest.
#
# Usage:
#   ./scripts/test.sh                          # full gate (all packages)
#   ./scripts/test.sh --scope shared           # one package
#   ./scripts/test.sh --scope backend tests/foo.test.ts -t name
#   ./scripts/test.sh --scope all              # explicit full gate
#   ./scripts/test.sh tests/foo.test.ts        # legacy form (= --scope backend)
#
# The legacy bare-positional form is preserved because muscle memory and
# IDE plugins point a lot of paths at this script. It now emits a one-line
# nudge to use --scope explicitly so the implicit "backend default" goes
# away over time without breaking existing flows today.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=./_native.sh
source "$ROOT_DIR/scripts/_native.sh"

NODE_VER="$(node -p 'process.versions.node')"
NODE_ABI="$(node -p 'process.versions.modules')"

locate_binding
# node-gyp is pinned to a semver-compatible major to avoid silent
# breakage on a future major bump (the cold-rebuild path is the only
# place we shell to npx, so this is the only hop that ever pulls
# from the network — pin it).
ensure_binding "$NODE_ABI" \
  "( cd '$BSQ_DIR' && npx -y node-gyp@^12.3.0 rebuild --release )" \
  "test (node $NODE_VER)" \
  1

# Ordered package list — the gate's fail-fast contract. If you add a
# new test-owning package, append it here AND update docs/testing.md.
PACKAGES=(shared backend server host cli desktop)

scope=""
case "${1:-}" in
  --scope)
    scope="${2:-}"
    shift 2 || true
    if [ -z "$scope" ]; then
      echo "test.sh: --scope requires a name (one of: ${PACKAGES[*]} all)" >&2
      exit 2
    fi
    ;;
  --scope=*)
    scope="${1#--scope=}"
    shift
    ;;
esac

run_one() {
  local pkg="$1"; shift
  pnpm --filter "@silverhand/$pkg" test "$@"
}

# Explicit single-package scope.
if [ -n "$scope" ] && [ "$scope" != "all" ]; then
  for known in "${PACKAGES[@]}"; do
    if [ "$known" = "$scope" ]; then
      exec pnpm --filter "@silverhand/$scope" test "$@"
    fi
  done
  echo "test.sh: unknown --scope '$scope' (allowed: ${PACKAGES[*]} all)" >&2
  exit 2
fi

# Legacy bare-positional form: keep it working but nudge toward --scope.
if [ -z "$scope" ] && [ "$#" -gt 0 ]; then
  echo "test.sh: positional args without --scope — treating as backend (legacy form). Prefer './scripts/test.sh --scope backend $*'." >&2
  exec pnpm --filter @silverhand/backend test "$@"
fi

# Default / --scope all: full gate, fail-fast under set -e.
for pkg in "${PACKAGES[@]}"; do
  run_one "$pkg"
done

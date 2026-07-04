#!/usr/bin/env bash
# Standalone runner for the legacy isolated-thread fossil purge (#task:1303).
#
#   ./scripts/legacy-thread-purge.sh [--db <path>] [--apply]
#
# Default is a READ-ONLY dry run: prints the inventory + guard for the
# `conversations.kind='thread'` fossils (and everything that references them)
# and writes nothing. Add --apply to actually delete — it takes a `VACUUM INTO`
# backup first, then runs the whole purge inside one BEGIN IMMEDIATE transaction
# with a post-proof (aborts + rolls back on any failed guard/proof).
#
# Why a wrapper: better-sqlite3 ships ONE native .node binding compiled for a
# single ABI. `pnpm dev` swaps it to Electron's ABI; this script swaps it to
# system-node's ABI (same machinery as scripts/test.sh) so the CLI can open the
# DB under plain `node`. It also compiles the two self-contained maintenance
# TS files on the fly, so there is nothing to build first.
#
# Examples:
#   ./scripts/legacy-thread-purge.sh                       # dry-run, default DB
#   ./scripts/legacy-thread-purge.sh --db /path/to.db      # dry-run, explicit DB
#   ./scripts/legacy-thread-purge.sh --apply               # execute (default DB)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=./_native.sh
source "$ROOT_DIR/scripts/_native.sh"

NODE_VER="$(node -p 'process.versions.node')"
NODE_ABI="$(node -p 'process.versions.modules')"

locate_binding
ensure_binding "$NODE_ABI" \
  "( cd '$BSQ_DIR' && npx -y node-gyp@^12.3.0 rebuild --release )" \
  "legacy-thread-purge (node $NODE_VER)" \
  1

SRC_DIR="$ROOT_DIR/packages/backend/src/maintenance"
# Emit under packages/backend/dist so the output inherits that package's
# `"type": "module"` (the two files are ESM with explicit `.js` import specifiers).
OUT_DIR="$ROOT_DIR/packages/backend/dist/maintenance-standalone"
mkdir -p "$OUT_DIR"

# The two files import only better-sqlite3, node builtins, and each other —
# self-contained, so a targeted compile is enough (no full backend build).
"$ROOT_DIR/node_modules/.bin/tsc" \
  "$SRC_DIR/legacy-thread-purge.ts" \
  "$SRC_DIR/legacy-thread-purge-cli.ts" \
  --outDir "$OUT_DIR" \
  --module esnext --moduleResolution bundler \
  --target es2022 --lib es2022 --types node \
  --skipLibCheck --esModuleInterop

exec node "$OUT_DIR/legacy-thread-purge-cli.js" "$@"

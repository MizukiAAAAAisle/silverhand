#!/usr/bin/env bash
# One-shot release packager for Silverhand (macOS-only).
#
# Steps:
#   1. Build all workspace packages (`pnpm -r build`) — backend/shared need
#      their tsc output and `packages/cli` produces the esbuild bundle
#      (`dist/cli.js`) that electron-builder ships outside the asar;
#      apps/desktop needs `out/` populated.
#   2. Swap better-sqlite3's binding to the Electron ABI (cached, see
#      _native.sh). electron-builder won't rebuild it for us — we set
#      npmRebuild: false in the config because builder would otherwise
#      build the binding for *system* node ABI and the packaged app
#      would crash at startup.
#   3. Run electron-builder, which packages the .app bundle and dmg.
#
# Usage: ./scripts/package.sh [--dir]
#   --dir   skip dmg creation, only produce the .app (faster iteration)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=./_native.sh
source "$ROOT_DIR/scripts/_native.sh"

DIR_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dir) DIR_ONLY=1 ;;
    -h|--help)
      echo "Usage: $0 [--dir]"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[package] pnpm not found" >&2
  exit 1
fi

# electron-builder downloads the per-arch Electron zip from GitHub
# releases by default; from CN networks that connection EOFs partway
# through often enough to matter. The npmmirror mirror is a stable
# fallback. Honor an existing ELECTRON_MIRROR if the caller already
# set one.
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
echo "[package] ELECTRON_MIRROR=$ELECTRON_MIRROR"

echo "[package] building workspace packages"
pnpm -r build
pnpm --filter @silverhand/desktop build

ELECTRON_VERSION="$(node -p "require('./apps/desktop/package.json').devDependencies.electron" 2>/dev/null | sed 's/^[\^~]//' || true)"
ELECTRON_ABI="$(node -p "require('node-abi').getAbi('$ELECTRON_VERSION', 'electron')" 2>/dev/null || true)"
if [[ -z "$ELECTRON_ABI" ]]; then
  echo "[package] could not resolve electron ABI for $ELECTRON_VERSION" >&2
  exit 1
fi

locate_binding
ensure_binding "$ELECTRON_ABI" \
  "pnpm --filter @silverhand/desktop exec electron-rebuild -f -w better-sqlite3" \
  "package (electron $ELECTRON_VERSION)"

if [[ "$DIR_ONLY" == "1" ]]; then
  echo "[package] running electron-builder --dir"
  pnpm --filter @silverhand/desktop package:dir
else
  echo "[package] running electron-builder"
  pnpm --filter @silverhand/desktop package
fi

echo "[package] artifacts in apps/desktop/release/"

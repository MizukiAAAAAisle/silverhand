#!/usr/bin/env bash
# One-shot dev launcher for Silverhand.
# - installs deps if missing
# - swaps better-sqlite3 binding to electron's ABI (cached, see _native.sh)
# - starts electron-vite dev
#
# Usage: ./scripts/dev.sh [--clean] [--reinstall]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=./_native.sh
source "$ROOT_DIR/scripts/_native.sh"

CLEAN=0
REINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --clean)     CLEAN=1 ;;
    --reinstall) REINSTALL=1 ;;
    -h|--help)
      echo "Usage: $0 [--clean] [--reinstall]"
      echo "  --clean     remove dist/out caches before starting"
      echo "  --reinstall force a fresh pnpm install + native rebuild (clears the binding cache too)"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[dev] pnpm not found. install via: npm i -g pnpm" >&2
  exit 1
fi

if [[ "$REINSTALL" == "1" ]]; then
  echo "[dev] --reinstall: clearing node_modules and binding cache"
  rm -rf node_modules apps/*/node_modules packages/*/node_modules
fi

if [[ ! -d node_modules ]] || [[ ! -d apps/desktop/node_modules ]]; then
  echo "[dev] installing dependencies"
  pnpm install
fi

if [[ "$CLEAN" == "1" ]]; then
  echo "[dev] --clean: removing build outputs"
  rm -rf apps/desktop/out apps/desktop/dist
  pnpm -r exec rm -rf dist 2>/dev/null || true
fi

ELECTRON_VERSION="$(node -p "require('./apps/desktop/package.json').devDependencies.electron" 2>/dev/null | sed 's/^[\^~]//' || true)"
if [[ -z "$ELECTRON_VERSION" ]]; then
  echo "[dev] could not detect electron version from apps/desktop/package.json" >&2
  exit 1
fi
ELECTRON_ABI="$(node -p "require('node-abi').getAbi('$ELECTRON_VERSION', 'electron')" 2>/dev/null || true)"
if [[ -z "$ELECTRON_ABI" ]]; then
  echo "[dev] could not resolve electron ABI for version $ELECTRON_VERSION (node-abi missing?)" >&2
  exit 1
fi

locate_binding
ensure_binding "$ELECTRON_ABI" \
  "pnpm --filter @silverhand/desktop exec electron-rebuild -f -w better-sqlite3" \
  "dev (electron $ELECTRON_VERSION)"

# pnpm blocks postinstall scripts by default, so the Electron binary
# (downloaded by node_modules/electron/install.js) is missing on first install.
ELECTRON_PKG_DIR="$(node -p "require('path').dirname(require.resolve('electron/package.json', { paths: ['$ROOT_DIR/apps/desktop'] }))" 2>/dev/null || true)"
if [[ -n "$ELECTRON_PKG_DIR" ]] && [[ ! -e "$ELECTRON_PKG_DIR/dist/Electron.app" ]] \
   && [[ ! -e "$ELECTRON_PKG_DIR/dist/electron" ]] \
   && [[ ! -e "$ELECTRON_PKG_DIR/dist/electron.exe" ]]; then
  echo "[dev] downloading Electron binary (one-time)"
  ( cd "$ELECTRON_PKG_DIR" && node install.js )
fi

echo "[dev] starting electron-vite"
exec pnpm --filter @silverhand/desktop dev

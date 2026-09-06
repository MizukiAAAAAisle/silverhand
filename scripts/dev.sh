#!/usr/bin/env bash
# One-shot dev launcher for Silverhand.
# - installs deps if missing
# - starts electron-vite dev
#
# Usage: ./scripts/dev.sh [--clean] [--reinstall]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"


CLEAN=0
REINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --clean)     CLEAN=1 ;;
    --reinstall) REINSTALL=1 ;;
    -h|--help)
      echo "Usage: $0 [--clean] [--reinstall]"
      echo "  --clean     remove dist/out caches before starting"
      echo "  --reinstall force a fresh pnpm install"
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
  echo "[dev] --reinstall: clearing node_modules"
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
pnpm --filter @silverhand/cli build
pnpm --filter @silverhand/host build
# Desktop and user-managed computers use the same daemon package, including
# its sibling CLI bundle required by runtime_start.
# User-managed computer dogfood: backend-generated connection commands should
# run before the public npm package exists. In dev, point npx at the local file
# package; production keeps the default @silverhand-ai/daemon@latest spec.
pnpm --filter @silverhand-ai/daemon build
export SILVERHAND_DAEMON_NPM_SPEC="file:$ROOT_DIR/packages/silverhand-daemon"
# #task:2343 — the embedded arm spawns the PREBUILT Rust backend; build it + write the
# dev manifest the launcher (`resolveBackendSidecarManifestPath` dev path =
# `rust/target/release/silverhand-backend.manifest.json`) verifies. Cargo runs HERE, at
# dev-launch time — never at app runtime. Dev/headless use the SAME app version implicitly
# (there is no version compat gate; wire compat is api_epoch). A same-version local dirty
# build is the explicitly-accepted dev trade-off.
echo "[dev] building embedded Rust backend sidecar (cargo build --release, host target)"
# #task:2343 — dev builds+verifies ONLY the current host target (no cross-compile in this
# task). The manifest.target is the host desktop target derived from platform+arch (the
# SAME value verifySidecar requires); dev builds the host default (no --target).
case "$(node -p 'process.platform')-$(node -p 'process.arch')" in
  darwin-arm64) DEV_BACKEND_TARGET="aarch64-apple-darwin" ;;
  darwin-x64) DEV_BACKEND_TARGET="x86_64-apple-darwin" ;;
  linux-arm64) DEV_BACKEND_TARGET="aarch64-unknown-linux-gnu" ;;
  linux-x64) DEV_BACKEND_TARGET="x86_64-unknown-linux-gnu" ;;
  *) echo "[dev] no host-target mapping for $(node -p 'process.platform')-$(node -p 'process.arch')" >&2; exit 1 ;;
esac
node scripts/generate-rust-migrations.mjs --check
( cd "$ROOT_DIR/rust" && cargo build --release --bin silverhand-backend )
SIDECAR_STAGE="$ROOT_DIR/rust/target/release"
if [[ ! -x "$SIDECAR_STAGE/silverhand-backend" ]]; then
  echo "[dev] embedded Rust backend sidecar not found at $SIDECAR_STAGE/silverhand-backend" >&2
  exit 1
fi
DEV_SIDECAR_ARCH="$(node -p 'process.arch')"
DEV_SIDECAR_SHA256="$(shasum -a 256 "$SIDECAR_STAGE/silverhand-backend" | awk '{print $1}')"
cat > "$SIDECAR_STAGE/silverhand-backend.manifest.json" <<MANIFEST
{
  "executable": "silverhand-backend",
  "target": "$DEV_BACKEND_TARGET",
  "arch": "$DEV_SIDECAR_ARCH",
  "sha256": "$DEV_SIDECAR_SHA256"
}
MANIFEST
echo "[dev] embedded Rust backend sidecar target=$DEV_BACKEND_TARGET manifest written (sha256=${DEV_SIDECAR_SHA256:0:12})"
exec pnpm --filter @silverhand/desktop dev

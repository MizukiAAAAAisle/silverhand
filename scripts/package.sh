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

# electron-builder 26's dmg-builder fetches a self-contained `dmgbuild` bundle
# (Python + tooling) from electron-userland/electron-builder-binaries via
# @electron/get. @electron/get reads ELECTRON_MIRROR with *higher* precedence
# than the mirror dmg-builder passes (see @electron/get artifact-utils.js
# `mirrorVar`), so our ELECTRON_MIRROR above (the *electron* binaries path)
# hijacks the bundle URL to `.../mirrors/electron/dmg-builder@.../...` → 404.
# Rather than fight the precedence, pre-stage the bundle from the
# electron-builder-binaries mirror and point CUSTOM_DMGBUILD_PATH at it;
# dmg-builder checks that env first and skips the network entirely. Version /
# arch / checksum are read from the installed dmg-builder so this survives
# electron-builder upgrades. (--dir builds skip the dmg, so skip staging too.)
stage_dmgbuild_bundle() {
  # Pull releaseName / filename / sha256 straight out of the installed
  # dmg-builder source so this survives electron-builder upgrades. dmg-builder
  # is a transitive dep (pnpm strict layout), so resolve it *through*
  # electron-builder rather than from apps/desktop directly.
  local meta
  meta="$(cd "$ROOT_DIR/apps/desktop" && node -e '
    const { createRequire } = require("module");
    const path = require("path");
    let dmgutil;
    try {
      const reqDesktop = createRequire(path.join(process.cwd(), "package.json"));
      const reqEb = createRequire(reqDesktop.resolve("electron-builder/package.json"));
      dmgutil = reqEb.resolve("dmg-builder/out/dmgUtil.js");
    } catch (e) { process.exit(2); }
    const fs = require("fs");
    const t = fs.readFileSync(dmgutil, "utf8");
    const rel = (t.match(/releaseName:\s*"([^"]+)"/) || [])[1];
    const ver = (t.match(/releaseVersion\s*=\s*"([^"]+)"/) || [])[1];
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    if (!rel || !ver) process.exit(3);
    const file = `dmgbuild-bundle-${arch}-${ver}.tar.gz`;
    const sha = (t.match(new RegExp(`"${file.replace(/[.@]/g, "\\$&")}":\\s*"([0-9a-f]+)"`)) || [])[1] || "";
    process.stdout.write([rel, file, sha].join("\n"));
  ')" || { echo "[package] could not resolve/parse dmg-builder — skipping dmgbuild staging" >&2; return 0; }

  local release file sha
  release="$(printf '%s\n' "$meta" | sed -n 1p)"
  file="$(printf '%s\n' "$meta" | sed -n 2p)"
  sha="$(printf '%s\n' "$meta" | sed -n 3p)"

  local stage_root="$HOME/Library/Caches/silverhand-build/dmgbuild"
  local stage_dir="$stage_root/${file%.tar.gz}"
  local dmgbuild_path="$stage_dir/dmgbuild"

  if [[ -x "$dmgbuild_path" || -f "$dmgbuild_path" ]] && [[ -f "$stage_dir/.complete" ]]; then
    echo "[package] dmgbuild bundle cached: $dmgbuild_path"
    export CUSTOM_DMGBUILD_PATH="$dmgbuild_path"
    return 0
  fi

  local mirror_base="${ELECTRON_BUILDER_BINARIES_MIRROR%/}"
  local urls=(
    "$mirror_base/$release/$file"
    "https://github.com/electron-userland/electron-builder-binaries/releases/download/$release/$file"
  )

  local tmp="$stage_root/.dl-$file"
  rm -rf "$stage_dir" "$tmp"
  mkdir -p "$stage_root"

  local ok=0 url
  for url in "${urls[@]}"; do
    echo "[package] fetching dmgbuild bundle: $url"
    if curl -fsSL --max-time 180 -o "$tmp" "$url"; then ok=1; break; fi
    echo "[package] fetch failed, trying next source" >&2
  done
  if [[ "$ok" != "1" ]]; then
    echo "[package] could not download dmgbuild bundle from any source" >&2
    rm -f "$tmp"; return 1
  fi

  if [[ -n "$sha" ]]; then
    local got
    got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
    if [[ "$got" != "$sha" ]]; then
      echo "[package] dmgbuild bundle checksum mismatch (want $sha got $got)" >&2
      rm -f "$tmp"; return 1
    fi
  fi

  mkdir -p "$stage_dir"
  tar xzf "$tmp" -C "$stage_dir"
  rm -f "$tmp"
  if [[ ! -e "$dmgbuild_path" ]]; then
    echo "[package] extracted bundle missing 'dmgbuild' launcher" >&2
    return 1
  fi
  touch "$stage_dir/.complete"
  echo "[package] staged dmgbuild bundle → $dmgbuild_path"
  export CUSTOM_DMGBUILD_PATH="$dmgbuild_path"
}

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
  ( cd "$ROOT_DIR/apps/desktop" && pnpm exec electron-builder --mac --dir --config electron-builder.yml )
else
  stage_dmgbuild_bundle
  echo "[package] running electron-builder"
  ( cd "$ROOT_DIR/apps/desktop" && pnpm exec electron-builder --mac --config electron-builder.yml )
fi

echo "[package] artifacts in apps/desktop/release/"

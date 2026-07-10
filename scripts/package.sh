#!/usr/bin/env bash
# One-shot release packager for Silverhand (macOS-only).
#
# Steps:
#   1. Build all workspace packages (`pnpm -r build`) — backend/shared need
#      their tsc output; `packages/cli`, `packages/host`, and
#      `packages/server` produce esbuild bundles; apps/desktop needs `out/`
#      populated.
#   2. Swap better-sqlite3's binding to the Electron ABI (cached, see
#      _native.sh). electron-builder won't rebuild it for us — we set
#      npmRebuild: false in the config because builder would otherwise
#      build the binding for *system* node ABI and the packaged app
#      would crash at startup.
#   3. Run electron-builder, which packages the .app bundle and dmg.
#
# Usage: ./scripts/package.sh [--dir] [--remote-only --server-url <origin>] [--allow-insecure-remote] [--minify|--no-minify]
#   --dir                    skip dmg creation, only produce the .app (faster iteration)
#   --remote-only            package a Desktop build without embedded backend/server code
#   --server-url             bake a default backend origin into the app
#   --allow-insecure-remote  bake acceptance for non-loopback http:// remote URLs
#   --minify                 minify shipped JS bundles (default for release packages)
#   --no-minify              keep shipped JS readable (default with --dir)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=./_native.sh
source "$ROOT_DIR/scripts/_native.sh"

DIR_ONLY=0
REMOTE_ONLY=0
ALLOW_INSECURE_REMOTE="${SILVERHAND_ALLOW_INSECURE_REMOTE:-0}"
SERVER_URL=""

parse_minify_flag() {
  local raw="$1"
  case "$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) echo "true" ;;
    0|false|no|off) echo "false" ;;
    *)
      echo "[package] SILVERHAND_MINIFY must be true or false (got: $raw)" >&2
      exit 2
      ;;
  esac
}

MINIFY="${SILVERHAND_MINIFY:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      DIR_ONLY=1
      shift
      ;;
    --remote-only)
      REMOTE_ONLY=1
      shift
      ;;
    --allow-insecure-remote)
      ALLOW_INSECURE_REMOTE=1
      shift
      ;;
    --server-url)
      if [[ $# -lt 2 ]]; then
        echo "[package] --server-url requires a value" >&2
        exit 2
      fi
      SERVER_URL="$2"
      shift 2
      ;;
    --server-url=*)
      SERVER_URL="${1#--server-url=}"
      shift
      ;;
    --minify)
      MINIFY="true"
      shift
      ;;
    --no-minify)
      MINIFY="false"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--dir] [--remote-only --server-url <origin>] [--allow-insecure-remote] [--minify|--no-minify]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$MINIFY" ]]; then
  if [[ "$DIR_ONLY" == "1" ]]; then
    MINIFY="false"
  else
    MINIFY="true"
  fi
fi
MINIFY="$(parse_minify_flag "$MINIFY")"
if [[ "$ALLOW_INSECURE_REMOTE" != "1" ]]; then
  ALLOW_INSECURE_REMOTE=0
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[package] pnpm not found" >&2
  exit 1
fi

validate_server_url() {
  local raw="$1"
  local remote_only="$2"
  local allow_insecure_remote="$3"
  node - "$raw" "$remote_only" "$allow_insecure_remote" <<'NODE'
const raw = process.argv[2].trim();
const remoteOnly = process.argv[3] === '1';
const allowInsecureRemote = process.argv[4] === '1';

function fail(message) {
  console.error(`[package] invalid --server-url: ${message}`);
  process.exit(2);
}

function isLoopback(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

if (!raw) fail('value is empty');

let url;
try {
  url = new URL(raw);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

if (url.protocol !== 'https:' && url.protocol !== 'http:') {
  fail('only http:// and https:// origins are supported');
}
if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
  fail('value must be an origin, for example https://backend.example.com');
}

const loopback = isLoopback(url.hostname);
if (remoteOnly && loopback) {
  fail('remote-only packages require a non-loopback remote URL');
}
if (url.protocol === 'http:' && !loopback && !allowInsecureRemote) {
  fail('non-loopback http requires SILVERHAND_ALLOW_INSECURE_REMOTE=1');
}

process.stdout.write(url.origin);
NODE
}

if [[ -n "$SERVER_URL" ]]; then
  SERVER_URL="$(validate_server_url "$SERVER_URL" "$REMOTE_ONLY" "$ALLOW_INSECURE_REMOTE")"
fi
if [[ "$REMOTE_ONLY" == "1" && -z "$SERVER_URL" ]]; then
  echo "[package] --remote-only requires --server-url <origin>" >&2
  exit 2
fi

export SILVERHAND_DESKTOP_REMOTE_ONLY="$REMOTE_ONLY"
export SILVERHAND_DESKTOP_ALLOW_INSECURE_REMOTE="$ALLOW_INSECURE_REMOTE"
export SILVERHAND_DESKTOP_DEFAULT_SERVER_URL="$SERVER_URL"
export SILVERHAND_MINIFY="$MINIFY"

# electron-builder downloads the per-arch Electron zip from GitHub
# releases by default; from CN networks that connection EOFs partway
# through often enough to matter. The npmmirror mirror is a stable
# fallback. Honor an existing ELECTRON_MIRROR if the caller already
# set one.
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
echo "[package] ELECTRON_MIRROR=$ELECTRON_MIRROR"
echo "[package] minify JS bundles: $SILVERHAND_MINIFY"
if [[ "$REMOTE_ONLY" == "1" ]]; then
  echo "[package] remote-only Desktop enabled"
fi
if [[ "$ALLOW_INSECURE_REMOTE" == "1" ]]; then
  echo "[package] insecure remote HTTP enabled for packaged Desktop"
fi
if [[ -n "$SERVER_URL" ]]; then
  echo "[package] packaged default server URL: $SERVER_URL"
fi

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

if [[ "$REMOTE_ONLY" == "1" ]]; then
  echo "[package] remote-only: skipping better-sqlite3 Electron ABI swap"
else
  locate_binding
  ensure_binding "$ELECTRON_ABI" \
    "pnpm --filter @silverhand/desktop exec electron-rebuild -f -w better-sqlite3" \
    "package (electron $ELECTRON_VERSION)"

  # electron-builder may materialize pnpm dependencies from its own package
  # copy pipeline after our workspace-level swap. Keep a stable Electron-ABI
  # snapshot for afterPack to restore into app.asar.unpacked right before
  # signing, then verify the final app below.
  export SILVERHAND_ELECTRON_BETTER_SQLITE3_BINDING="$CACHE_DIR/package-abi-$ELECTRON_ABI.node"
  cp "$BINDING" "$SILVERHAND_ELECTRON_BETTER_SQLITE3_BINDING"
fi

BUILDER_CONFIG="electron-builder.yml"
ARTIFACT_OUTPUT_DIR="release"
if [[ "$REMOTE_ONLY" == "1" ]]; then
  BUILDER_CONFIG="electron-builder.remote-only.yml"
  ARTIFACT_OUTPUT_DIR="release-remote-server"
fi

if [[ "$DIR_ONLY" == "1" ]]; then
  echo "[package] running electron-builder --dir"
  ( cd "$ROOT_DIR/apps/desktop" && pnpm exec electron-builder --mac --dir --config "$BUILDER_CONFIG" )
else
  stage_dmgbuild_bundle
  echo "[package] running electron-builder"
  ( cd "$ROOT_DIR/apps/desktop" && pnpm exec electron-builder --mac --config "$BUILDER_CONFIG" )
fi

verify_packaged_better_sqlite3() {
  local app_path="$1"
  local expected_abi="$2"
  local electron_bin
  electron_bin="$(node -p "require('path').join(require('path').dirname(require.resolve('electron/package.json', { paths: ['./apps/desktop'] })), 'dist/Electron.app/Contents/MacOS/Electron')" 2>/dev/null || true)"
  if [[ -n "$electron_bin" && ! -x "$electron_bin" ]]; then
    echo "[package] Electron runtime missing from node_modules; materializing it for native smoke"
    ( cd "$ROOT_DIR/apps/desktop" && env -u ELECTRON_RUN_AS_NODE pnpm exec electron --version >/dev/null )
  fi
  if [[ -z "$electron_bin" || ! -x "$electron_bin" ]]; then
    echo "[package] could not resolve Electron binary for native smoke" >&2
    return 1
  fi
  if [[ ! -d "$app_path" ]]; then
    echo "[package] packaged app missing for native smoke: $app_path" >&2
    return 1
  fi

  local app_package_json="$app_path/Contents/Resources/app.asar/package.json"
  echo "[package] verifying packaged better-sqlite3 under Electron ABI $expected_abi"
  ELECTRON_RUN_AS_NODE=1 "$electron_bin" -e '
    const { createRequire } = require("node:module");
    const expectedAbi = process.argv[2];
    if (process.versions.modules !== expectedAbi) {
      throw new Error(`Electron ABI mismatch in smoke: expected ${expectedAbi}, got ${process.versions.modules}`);
    }
    const req = createRequire(process.argv[1]);
    const Database = req("better-sqlite3");
    new Database(":memory:").close();
    console.log(`[package] packaged better-sqlite3 ok for ABI ${process.versions.modules}`);
    process.exit(0);
  ' "$app_package_json" "$expected_abi"
}

verify_packaged_daemon() {
  local app_path="$1"
  local expected="$2"
  local expected_version="$3"
  local packaged="$app_path/Contents/Resources/silverhand-daemon/daemon.mjs"

  if [[ ! -f "$packaged" || ! -f "$expected" ]]; then
    echo "[package] packaged or release daemon bundle missing" >&2
    return 1
  fi
  if ! cmp -s "$packaged" "$expected"; then
    echo "[package] packaged daemon differs from the release daemon bundle" >&2
    return 1
  fi
  if ! grep -aFq "$expected_version" "$packaged"; then
    echo "[package] packaged daemon does not contain version $expected_version" >&2
    return 1
  fi
  echo "[package] packaged daemon matches @silverhand-ai/daemon@$expected_version"
}

PACKAGED_APP_NAME="Silverhand.app"
EXPECTED_DAEMON_BUNDLE="$ROOT_DIR/packages/host/dist/daemon.js"
EXPECTED_DAEMON_VERSION="0.0.0-dev"
if [[ "$REMOTE_ONLY" == "1" ]]; then
  PACKAGED_APP_NAME="Silverhand-remote-server.app"
  EXPECTED_DAEMON_BUNDLE="$ROOT_DIR/packages/silverhand-daemon/dist/daemon.js"
  EXPECTED_DAEMON_VERSION="$(node -p "require('./packages/silverhand-daemon/package.json').version")"
fi
PACKAGED_APP_PATH="$ROOT_DIR/apps/desktop/$ARTIFACT_OUTPUT_DIR/mac-arm64/$PACKAGED_APP_NAME"
verify_packaged_daemon \
  "$PACKAGED_APP_PATH" \
  "$EXPECTED_DAEMON_BUNDLE" \
  "$EXPECTED_DAEMON_VERSION"

if [[ "$REMOTE_ONLY" != "1" ]]; then
  verify_packaged_better_sqlite3 "$PACKAGED_APP_PATH" "$ELECTRON_ABI"
fi

echo "[package] artifacts in apps/desktop/$ARTIFACT_OUTPUT_DIR/"

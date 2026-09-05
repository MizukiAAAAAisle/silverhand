#!/usr/bin/env bash
# One-shot release packager for Silverhand (macOS-only).
#
# Builds only Desktop, CLI/daemon resources and the self-contained Rust sidecar.
# No TS server build or Electron SQLite ABI mutation is needed.
#
# Usage: ./scripts/package.sh [--dir] [--remote-only --server-url <origin>] [--allow-insecure-remote] [--minify|--no-minify]
#   --dir                    skip dmg creation, only produce the .app (faster iteration)
#   --remote-only            package a Desktop build without embedded backend/server code
#   --server-url             bake a default backend origin into the app
#   --allow-insecure-remote  bake acceptance for non-loopback http:// remote URLs
#   --minify                 minify shipped JS bundles (default for release packages)
#   --no-minify              keep shipped JS readable (default with --dir)
#   --output-dir <name>      separate artifact directory under apps/desktop

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"


DIR_ONLY=0
REMOTE_ONLY=0
ALLOW_INSECURE_REMOTE="${SILVERHAND_ALLOW_INSECURE_REMOTE:-0}"
SERVER_URL=""
OUTPUT_DIR=""

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
    --output-dir)
      if [[ $# -lt 2 || ! "$2" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
        echo "[package] --output-dir requires a simple directory name" >&2
        exit 2
      fi
      OUTPUT_DIR="$2"
      shift 2
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
      echo "Usage: $0 [--dir] [--output-dir <name>] [--remote-only --server-url <origin>] [--allow-insecure-remote] [--minify|--no-minify]"
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

if [[ "$(node -p 'process.platform + ":" + process.arch')" != "darwin:arm64" ]]; then
  echo "[package] this Desktop package requires a darwin arm64 host" >&2
  exit 2
fi
if [[ -n "${SILVERHAND_RUST_TARGET:-}" && "$SILVERHAND_RUST_TARGET" != "aarch64-apple-darwin" ]]; then
  echo "[package] SILVERHAND_RUST_TARGET must match the Desktop host aarch64-apple-darwin" >&2
  exit 2
fi

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

# #task:1530 — desktop release telemetry: single version SoT + build metadata.
# `apps/desktop/package.json.version` is the SOLE desktop release-version source.
# The remote-only variant ships a build-generated manifest (see the remote-only
# config block below) rather than a second hand-maintained version. The commit
# sha + dirty flag are exported BEFORE the build so the electron-vite `main`
# define bakes them into the bundle for the WS telemetry.
CANONICAL_VERSION="$(node -p "require('./apps/desktop/package.json').version")"
SILVERHAND_BUILD_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo dev)"
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain 2>/dev/null)" ]]; then
  SILVERHAND_BUILD_DIRTY=1
else
  SILVERHAND_BUILD_DIRTY=0
fi
export SILVERHAND_BUILD_COMMIT SILVERHAND_BUILD_DIRTY
echo "[package] desktop release $CANONICAL_VERSION @ ${SILVERHAND_BUILD_COMMIT:0:12} (dirty=$SILVERHAND_BUILD_DIRTY)"

node scripts/generate-rust-migrations.mjs --check
pnpm --filter @silverhand/shared --filter @silverhand/cli --filter @silverhand/host --filter @silverhand-ai/daemon build
pnpm --filter @silverhand/desktop build

BUILDER_CONFIG="electron-builder.yml"
ARTIFACT_OUTPUT_DIR="release"
if [[ "$REMOTE_ONLY" == "1" ]]; then
  BUILDER_CONFIG="electron-builder.remote-only.yml"
  ARTIFACT_OUTPUT_DIR="release-remote-server"

  # #task:2343 — a remote-only build ships NO embedded Rust backend sidecar. The
  # remote-only electron-builder config excludes it; we also skip building it here.
  echo "[package] remote-only: skipping embedded Rust backend sidecar build"
else
  # #task:2343 — build the PREBUILT Rust backend sidecar + its manifest for the embedded
  # build. Cargo is invoked HERE at package time only — NEVER at app runtime. The manifest
  # pins the executable + target + SHA-256 the launcher verifies before spawn (the
  # artifact-identity gate; the launcher matches manifest.target against the Electron
  # platform+arch, not merely arch). electron-builder ships the staged sidecar + manifest
  # to `resources/silverhand-backend/` via extraResources.
  #
  # This task builds+verifies ONLY the current Desktop HOST target (shiki: no cross-compile
  # / ECS in #2343 — a Linux/ECS target comes later, separately). The manifest.target is
  # the host desktop target derived from the Electron platform+arch (the SAME value the
  # launcher's verifySidecar requires), so the manifest is not a recomputed host triple but
  # the declared desktop target; the launcher rejects any other.
  DESKTOP_ARCH="$(node -p 'process.arch')"
  BACKEND_TARGET="aarch64-apple-darwin"
  echo "[package] building embedded Rust backend sidecar (cargo build --release, host target $BACKEND_TARGET)"
  ( cd "$ROOT_DIR/rust" && cargo build --release --bin silverhand-backend --target "$BACKEND_TARGET" )
  SIDECAR_SRC="${CARGO_TARGET_DIR:-$ROOT_DIR/rust/target}/$BACKEND_TARGET/release/silverhand-backend"
  if [[ ! -x "$SIDECAR_SRC" ]]; then
    echo "[package] embedded Rust backend sidecar not found at $SIDECAR_SRC" >&2
    exit 1
  fi
  SIDECAR_STAGE="${SILVERHAND_BACKEND_STAGE:-$ROOT_DIR/rust/target/release}"
  # electron-builder prefixes its project directory before expanding env macros.
  # Keep filesystem operations absolute and give its resource selector a relative path.
  export SILVERHAND_BACKEND_STAGE="$(node -e 'console.log(require("node:path").relative(process.argv[1], process.argv[2]))' "$ROOT_DIR/apps/desktop" "$SIDECAR_STAGE")"
  mkdir -p "$SIDECAR_STAGE"
  SIDECAR_BIN="$SIDECAR_STAGE/silverhand-backend"
  cp "$SIDECAR_SRC" "$SIDECAR_BIN"
  codesign --force --sign - "$SIDECAR_BIN"
  SIDECAR_SHA256="$(shasum -a 256 "$SIDECAR_BIN" | awk '{print $1}')"
  cat > "$SIDECAR_STAGE/silverhand-backend.manifest.json" <<MANIFEST
{
  "executable": "silverhand-backend",
  "target": "$BACKEND_TARGET",
  "arch": "$DESKTOP_ARCH",
  "sha256": "$SIDECAR_SHA256"
}
MANIFEST
  echo "[package] embedded Rust backend sidecar target=$BACKEND_TARGET sha256=${SIDECAR_SHA256:0:12} manifest written"

  # #task:2343 — real-process smoke against the just-built sidecar: let Rust prepare an
  # ISOLATED (workspace-local gitignored) SILVERHAND_DIR, spawn the binary, verify the
  # bound frame / readyz / server-info / a mounted route / event WS / clean shutdown, plus
  # the bad-config failure arm. Runs at PACKAGE time (not runtime) via the tsx in
  # packages/cli. Fails the package on any regression.
  echo "[package] embedded Rust backend real-process smoke"
  ( cd "$ROOT_DIR" && ./packages/cli/node_modules/.bin/tsx scripts/smoke-embedded-rust-backend.mts --sidecar-stage "$SIDECAR_STAGE" )
fi

if [[ "$REMOTE_ONLY" == "1" ]]; then
  # #task:1530 — the remote-only manifest ships via a `from: package.json` rename-
  # copy that electron-builder's extraMetadata does NOT rewrite (it only touches
  # the main apps/desktop/package.json). So the ONLY way the remote-only runtime
  # app.getVersion() reads the canonical release version is to inject it here, at
  # build time, into a generated manifest. The tracked template carries no version
  # (single SoT); the generated file is git-ignored.
  node -e '
    const fs = require("fs");
    const template = JSON.parse(fs.readFileSync("apps/desktop/package.remote-only.json", "utf8"));
    if ("version" in template) {
      console.error("[package] package.remote-only.json must NOT carry a version (single SoT)");
      process.exit(1);
    }
    const generated = { ...template, version: process.argv[1] };
    fs.writeFileSync(
      "apps/desktop/package.remote-only.generated.json",
      JSON.stringify(generated, null, 2) + "\n",
    );
  ' "$CANONICAL_VERSION"
  echo "[package] generated remote-only manifest @ version $CANONICAL_VERSION"
fi

if [[ -n "$OUTPUT_DIR" ]]; then
  ARTIFACT_OUTPUT_DIR="$OUTPUT_DIR"
fi

if [[ "$DIR_ONLY" == "1" ]]; then
  echo "[package] running electron-builder --dir"
  ( cd "$ROOT_DIR/apps/desktop" && pnpm exec electron-builder --mac --dir --config "$BUILDER_CONFIG" --config.directories.output="$ARTIFACT_OUTPUT_DIR" )
else
  stage_dmgbuild_bundle
  echo "[package] running electron-builder"
  ( cd "$ROOT_DIR/apps/desktop" && pnpm exec electron-builder --mac --config "$BUILDER_CONFIG" --config.directories.output="$ARTIFACT_OUTPUT_DIR" )
fi

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

# #task:1530 — prove the shipped artifact carries the canonical release version
# (embedded AND remote-only must agree, since each is asserted == CANONICAL) and
# that the build_commit was baked into the main bundle for WS telemetry. We check
# TWO independent version surfaces:
#   1. Info.plist CFBundleShortVersionString — the OS-facing app version.
#   2. app.asar/package.json version — what `app.getVersion()` reads at RUNTIME,
#      i.e. the exact value the client-info telemetry header reports. For the
#      remote-only variant this is the generated rename-copy, so it is the real
#      guard that the single-SoT injection reached the shipped app.
verify_packaged_app_version() {
  local app_path="$1"
  local expected="$2"
  local info_plist="$app_path/Contents/Info.plist"
  if [[ ! -f "$info_plist" ]]; then
    echo "[package] packaged Info.plist missing for version smoke: $info_plist" >&2
    return 1
  fi
  local packaged_version
  packaged_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist" 2>/dev/null || true)"
  if [[ "$packaged_version" != "$expected" ]]; then
    echo "[package] packaged Info.plist version '$packaged_version' != release SoT '$expected' (embedded/remote-only must not drift)" >&2
    return 1
  fi
  echo "[package] packaged Info.plist version matches release SoT $expected"

  # app.getVersion() reads app.asar/package.json.version at runtime — extract it
  # via @electron/asar (resolved through electron-builder, a transitive dep under
  # pnpm's strict layout) and assert it equals the canonical release version.
  local app_asar="$app_path/Contents/Resources/app.asar"
  if [[ ! -f "$app_asar" ]]; then
    echo "[package] packaged app.asar missing for runtime-version smoke: $app_asar" >&2
    return 1
  fi
  local asar_version
  asar_version="$(cd "$ROOT_DIR/apps/desktop" && node -e '
    const { createRequire } = require("module");
    const path = require("path");
    const reqDesktop = createRequire(path.join(process.cwd(), "package.json"));
    const reqEb = createRequire(reqDesktop.resolve("electron-builder/package.json"));
    const asar = reqEb("@electron/asar");
    const pkg = JSON.parse(asar.extractFile(process.argv[1], "package.json").toString("utf8"));
    process.stdout.write(String(pkg.version ?? ""));
  ' "$app_asar" 2>/dev/null || true)"
  if [[ "$asar_version" != "$expected" ]]; then
    echo "[package] packaged app.asar/package.json version '$asar_version' != release SoT '$expected' (app.getVersion drift → wrong telemetry)" >&2
    return 1
  fi
  echo "[package] packaged app.getVersion() source matches release SoT $expected"

  if [[ "$SILVERHAND_BUILD_COMMIT" != "dev" ]]; then
    if grep -aFq "$SILVERHAND_BUILD_COMMIT" "$app_asar"; then
      echo "[package] packaged main bundle carries build_commit ${SILVERHAND_BUILD_COMMIT:0:12}"
    else
      echo "[package] packaged main bundle missing build_commit $SILVERHAND_BUILD_COMMIT" >&2
      return 1
    fi
  fi
}

verify_packaged_code_signature() {
  local app_path="$1"
  if [[ ! -d "$app_path" ]]; then
    echo "[package] packaged app missing for code-signature smoke: $app_path" >&2
    return 1
  fi

  echo "[package] verifying final packaged app code signature"
  if ! codesign --verify --deep --strict --verbose=2 "$app_path"; then
    echo "[package] final packaged app code signature is invalid: $app_path" >&2
    return 1
  fi
  echo "[package] final packaged app code signature is valid"
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

verify_packaged_app_version "$PACKAGED_APP_PATH" "$CANONICAL_VERSION"

if [[ "$REMOTE_ONLY" != "1" ]]; then
  ./packages/cli/node_modules/.bin/tsx scripts/smoke-embedded-rust-backend.mts "$PACKAGED_APP_PATH/Contents/Resources"
fi

# This must remain the final package smoke. afterPack verifies the signature at
# signing time; this second gate proves no later builder or smoke step changed a
# sealed bundle byte before the artifact is handed off.
verify_packaged_code_signature "$PACKAGED_APP_PATH"

# #task:1761 — desktop↔server API epoch release reminder (shared helper,
# fail-loud on a dangling runbook path; also wired into the standalone server
# build). Correctness is owned by the admission gates and tests, not this line.
node "$ROOT_DIR/scripts/epoch-runbook-reminder.mjs"

echo "[package] artifacts in apps/desktop/$ARTIFACT_OUTPUT_DIR/"

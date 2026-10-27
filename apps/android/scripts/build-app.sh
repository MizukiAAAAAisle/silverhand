#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
: "${SILVERHAND_ANDROID_BUILD:?Set the core build directory used by build-core.py}"
: "${ANDROID_HOME:?Set Android SDK path}"
: "${JAVA_HOME:?Use JDK 21}"
export SKIP_BRIDGE_ANDROID_BUILD_DISABLED=1
export SKIP_BRIDGE_ROBOLECTRIC_BUILD_DISABLED=1
VARIANT="${1:-Debug}"
case "$VARIANT" in Debug|Acceptance|Release) ;; *) echo "Expected Debug, Acceptance or Release" >&2; exit 1;; esac
if [[ -n "${SILVERHAND_ANDROID_RUN_ROOT:-}" ]]; then
  "${PNPM_BIN:?Set pinned pnpm executable}" --dir "$APP_DIR" exec vite build --outDir "$SILVERHAND_ANDROID_RUN_ROOT/web" --emptyOutDir
else
  "${PNPM_BIN:-pnpm}" --dir "$APP_DIR" build
fi
node "$APP_DIR/scripts/prepare-web.mjs"
"${GRADLE_BIN:?Set pinned Gradle executable}" -p "$SILVERHAND_ANDROID_BUILD/gradle" ":app:assemble$VARIANT" --no-daemon

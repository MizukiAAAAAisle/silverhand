#!/usr/bin/env bash
# Shared helper for resolving + caching better-sqlite3 native bindings.
#
# Two consumers share one .node file:
#   - dev.sh runs Electron (its own Node.js ABI)
#   - test.sh runs system Node.js (different ABI)
#
# Naive rebuild-on-mismatch makes alternating between them rebuild every
# switch. We keep a per-ABI cache of built bindings under
# `node_modules/.native-binding-cache/`, plus a tiny stamp file that
# records which ABI is currently swapped in. First build per ABI is the
# only slow path; alternation is a `cp`.
#
# Why no in-process probe of the .node file: loading an electron-ABI
# binding under system node *crashes* the node process (SIGKILL, no JS
# exception), so a probe-based design corrupts test.sh. The stamp file
# is the single source of truth — both scripts coordinate through it.
#
# Source this file from another script — it sets:
#   BSQ_DIR     install dir of better-sqlite3 (inside .pnpm/...)
#   BINDING     absolute path to the active .node file
#   CACHE_DIR   <root>/node_modules/.native-binding-cache
# and exposes:
#   ensure_binding <target_abi> <build_cmd> <label> [auto_probe]
#     - auto_probe=1 means we may verify with `node -e require()`
#       (only safe when target_abi == current process abi)

# shellcheck disable=SC2155
locate_binding() {
  BSQ_DIR="$(node -e "console.log(require('path').dirname(require.resolve('better-sqlite3/package.json', { paths: ['$ROOT_DIR/packages/backend'] })))")"
  BINDING="$BSQ_DIR/build/Release/better_sqlite3.node"
  CACHE_DIR="$ROOT_DIR/node_modules/.native-binding-cache"
  mkdir -p "$CACHE_DIR"
}

# swap_in <source>: copy <source> over $BINDING and (on macOS) re-sign,
# because plain `cp` invalidates ad-hoc code signatures on Apple Silicon
# and the kernel will SIGKILL the loader at dlopen with "Code Signature
# Invalid". This is silent and looks identical to an ABI mismatch from
# the outside — burned an hour debugging the first time.
swap_in() {
  local src="$1"
  cp "$src" "$BINDING"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    codesign --sign - --force "$BINDING" >/dev/null 2>&1 || true
  fi
}

# ensure_binding <target_abi> <build_cmd> <label> [auto_probe]
ensure_binding() {
  local target="$1"
  local build_cmd="$2"
  local label="$3"
  local auto_probe="${4:-0}"

  local stamp_file="$CACHE_DIR/.active-abi"
  local current=""
  [[ -f "$stamp_file" ]] && current="$(cat "$stamp_file" 2>/dev/null || true)"
  local cached="$CACHE_DIR/abi-$target.node"

  # Stamp says we're already on target. Trust it (we'd have written it
  # ourselves last time we touched the binding). Backfill the cache if
  # we've never snapshotted this ABI yet.
  if [[ "$current" == "$target" ]] && [[ -f "$BINDING" ]]; then
    echo "[$label] better-sqlite3 binding already active for ABI $target — skip"
    [[ -f "$cached" ]] || cp "$BINDING" "$cached"
    return 0
  fi

  # Auto-probe path: only when our target equals the current process's
  # ABI (test.sh case). pnpm install ships a prebuilt binding compiled
  # for current node, so we may already be set without a stamp. require()
  # is safe here because we know loading won't crash for matching ABI.
  if [[ "$auto_probe" == "1" ]] && [[ -f "$BINDING" ]]; then
    if node -e "const D=require('better-sqlite3'); new D(':memory:').close()" >/dev/null 2>&1; then
      echo "[$label] probed: existing binding works for ABI $target — adopting"
      cp "$BINDING" "$cached"
      echo "$target" > "$stamp_file"
      return 0
    fi
  fi

  if [[ -f "$cached" ]]; then
    echo "[$label] swapping in cached binding for ABI $target (was: ${current:-none})"
    swap_in "$cached"
    echo "$target" > "$stamp_file"
    return 0
  fi

  echo "[$label] building better-sqlite3 for ABI $target (was: ${current:-none}) — first time, will be cached"
  eval "$build_cmd"
  if [[ ! -f "$BINDING" ]]; then
    echo "[$label] build did not produce $BINDING" >&2
    return 1
  fi
  cp "$BINDING" "$cached"
  echo "$target" > "$stamp_file"
}

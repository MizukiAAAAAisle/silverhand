#!/usr/bin/env bash
# Shared helper for resolving + caching better-sqlite3 native bindings.
#
# Two consumers share one .node file:
#   - dev.sh runs Electron (its own Node.js ABI)
#   - test.sh runs system Node.js (different ABI)
#
# Naive rebuild-on-mismatch makes alternating between them rebuild every
# switch. We keep a per-package-version/per-ABI cache of built bindings
# under `node_modules/.native-binding-cache/`, plus a tiny stamp file
# that records which ABI is currently swapped in. First build per ABI is
# the only slow path; alternation is a `cp`.
#
# Why no in-process probe of the .node file: loading an electron-ABI
# binding under system node *crashes* the node process (SIGKILL, no JS
# exception), so a probe-based design corrupts test.sh. The stamp file
# is the primary coordination signal — but we *also* record the
# binding's file hash at swap time so we can detect when something
# external (a fresh `pnpm install` re-extracting the Node-ABI prebuild,
# a manual `pnpm rebuild`, etc.) has overwritten the .node file behind
# our back. Without that check the stamp would lie and we'd happily
# package the wrong ABI binding — burned an afternoon discovering this.
#
# Source this file from another script — it sets:
#   BSQ_DIR     install dir of better-sqlite3 (inside .pnpm/...)
#   BINDING     absolute path to the active .node file
#   CACHE_DIR   <root>/node_modules/.native-binding-cache
#   CACHE_KEY   cache prefix for this package version / platform / arch
# and exposes:
#   ensure_binding <target_abi> <build_cmd> <label> [auto_probe]
#     - auto_probe=1 means we may verify with `node -e require()`
#       (only safe when target_abi == current process abi)

# shellcheck disable=SC2155
locate_binding() {
  BSQ_DIR="$(node -e "console.log(require('path').dirname(require.resolve('better-sqlite3/package.json', { paths: ['$ROOT_DIR/packages/backend'] })))")"
  BINDING="$BSQ_DIR/build/Release/better_sqlite3.node"
  CACHE_DIR="$ROOT_DIR/node_modules/.native-binding-cache"
  local bsq_version
  bsq_version="$(node -e "console.log(require(process.argv[1]).version)" "$BSQ_DIR/package.json")"
  CACHE_KEY="better-sqlite3-$bsq_version-$(uname -s)-$(uname -m)"
  mkdir -p "$CACHE_DIR"
}

binding_hash() {
  shasum -a 256 "$BINDING" | awk '{print $1}'
}

# _record_active <abi>: persist both the active ABI stamp and the
# post-swap binding hash. The hash sidecar is what protects us from
# stale stamps when an external `pnpm install` overwrites $BINDING.
_record_active() {
  local abi="$1"
  echo "$abi" > "$CACHE_DIR/.active-abi"
  binding_hash > "$CACHE_DIR/.active-sha256" 2>/dev/null || true
}

# swap_in <source>: copy <source> over $BINDING and (on macOS) re-sign,
# because plain `cp` invalidates ad-hoc code signatures on Apple Silicon
# and the kernel will SIGKILL the loader at dlopen with "Code Signature
# Invalid". This is silent and looks identical to an ABI mismatch from
# the outside — burned an hour debugging the first time.
#
# The mkdir is not defensive padding: build/Release/ only exists because
# pnpm extracted a prebuild into it, so any install that skips or prunes
# that extraction leaves us with a populated cache and no destination
# directory. Every other ensure_binding path is guarded by `-f $BINDING`
# (or lets node-gyp create the tree), which makes this the one place a
# missing directory can surface — as a `cp: ... No such file or
# directory` naming the *destination*, which reads like a missing source.
swap_in() {
  local src="$1"
  mkdir -p "$(dirname "$BINDING")"
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
  local hash_file="$CACHE_DIR/.active-sha256"
  local current=""
  [[ -f "$stamp_file" ]] && current="$(cat "$stamp_file" 2>/dev/null || true)"
  local cached="$CACHE_DIR/$CACHE_KEY-abi-$target.node"

  # Stamp says we're on target. Also verify the binding hasn't been
  # replaced behind our back (pnpm install re-extracting the prebuild
  # is the common culprit): the hash we recorded at swap time must
  # still match. Mismatch → treat the stamp as stale and fall through
  # to swap/build.
  local stamp_trustworthy=0
  if [[ "$current" == "$target" ]] && [[ -f "$BINDING" ]]; then
    local expected_hash actual_hash
    expected_hash="$(cat "$hash_file" 2>/dev/null || true)"
    actual_hash="$(binding_hash 2>/dev/null || true)"
    if [[ -n "$expected_hash" ]] && [[ "$expected_hash" == "$actual_hash" ]]; then
      stamp_trustworthy=1
    fi
  fi

  if [[ "$stamp_trustworthy" == "1" ]]; then
    echo "[$label] better-sqlite3 binding already active for ABI $target — skip"
    [[ -f "$cached" ]] || cp "$BINDING" "$cached"
    return 0
  fi

  # Stamp was stale or absent. If we *had* a stamp but the hash moved,
  # tell the user — silent re-swap was how this bug hid for an afternoon.
  if [[ "$current" == "$target" ]]; then
    echo "[$label] active binding hash changed since last swap (stamp says ABI $target but file was replaced — probably by pnpm install) — re-swapping"
    current=""
  fi

  # Auto-probe path: only when our target equals the current process's
  # ABI (test.sh case). pnpm install ships a prebuilt binding compiled
  # for current node, so we may already be set without a stamp. require()
  # is safe here because we know loading won't crash for matching ABI.
  if [[ "$auto_probe" == "1" ]] && [[ -f "$BINDING" ]]; then
    if node -e "const D=require('better-sqlite3'); new D(':memory:').close()" >/dev/null 2>&1; then
      echo "[$label] probed: existing binding works for ABI $target — adopting"
      cp "$BINDING" "$cached"
      _record_active "$target"
      return 0
    fi
  fi

  if [[ -f "$cached" ]]; then
    echo "[$label] swapping in cached binding for ABI $target (was: ${current:-none})"
    swap_in "$cached"
    _record_active "$target"
    return 0
  fi

  echo "[$label] building better-sqlite3 for ABI $target (was: ${current:-none}) — first time, will be cached"
  eval "$build_cmd"
  if [[ ! -f "$BINDING" ]]; then
    echo "[$label] build did not produce $BINDING" >&2
    return 1
  fi
  cp "$BINDING" "$cached"
  _record_active "$target"
}

#!/usr/bin/env bash
# Internal container half; invoked by build-rust-linux.sh, not on the host.
set -euo pipefail
[[ -d /cargo-target && -d /out && "$PWD" == /src/rust ]] || exit 2
TARGET=x86_64-unknown-linux-gnu
[[ "$(uname -m)" == x86_64 ]] || { echo 'Wrong container architecture' >&2; exit 1; }
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
rustc --version
getconf GNU_LIBC_VERSION
# /src/.cargo/config.toml supplies the production SQLite build policy.
cargo build --locked --release --target "$TARGET" --bin silverhand-backend
BIN="/cargo-target/$TARGET/release/silverhand-backend"
readelf -h "$BIN" > /out/elf-header.txt
readelf --version-info "$BIN" > /out/elf-versions.txt
readelf -d "$BIN" > /out/elf-dynamic.txt
grep -q 'Advanced Micro Devices X86-64' /out/elf-header.txt
GLIBC_MAX="$(grep -oE 'GLIBC_[0-9]+\.[0-9]+' /out/elf-versions.txt | sort -Vu | tail -1 | cut -d_ -f2)"
[[ -n "$GLIBC_MAX" ]]
[[ "$(printf '%s\n' "$GLIBC_MAX" 2.32 | sort -V | tail -1)" == 2.32 ]] || {
  echo "Requires glibc $GLIBC_MAX, above ECS 2.32" >&2; exit 1;
}
ldd "$BIN" > /out/ldd.txt
if grep -q 'not found' /out/ldd.txt; then cat /out/ldd.txt; exit 1; fi
install -m 755 "$BIN" /out/silverhand-backend
(cd /out && sha256sum silverhand-backend > SHA256SUMS)

# Real native startup with an isolated empty store. No Node, TS migrator or
# Cargo on the child's PATH, no host port published, no deployment/data access.
mkdir /out/smoke
CHILD=''
cleanup() {
  if [[ -n "$CHILD" ]] && kill -0 "$CHILD" 2>/dev/null; then
    kill -TERM "$CHILD" 2>/dev/null || true
    for ((i=0; i<50; i++)); do
      kill -0 "$CHILD" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
}
trap cleanup EXIT
env -i PATH=/usr/bin:/bin HOME=/out/smoke TMPDIR=/out/smoke \
  SILVERHAND_DIR=/out/smoke \
  SILVERHAND_DATABASE_PATH=/out/smoke/silverhand.db \
  SILVERHAND_BLOBS_ROOT=/out/smoke/blobs \
  SILVERHAND_LOG_DIR=/out/smoke/logs \
  SILVERHAND_DEPLOYMENT_PROFILE=remote-only \
  SILVERHAND_LISTEN_ADDR=127.0.0.1:18080 \
  SILVERHAND_ALLOWED_ORIGINS=http://127.0.0.1:18080 \
  SILVERHAND_STARTUP_GENERATION=linux-build-smoke \
  /out/silverhand-backend > /out/smoke/stdout.jsonl 2> /out/smoke/stderr.log &
CHILD=$!
READY=0
for ((i=0; i<300; i++)); do
  kill -0 "$CHILD" 2>/dev/null || break
  if curl --max-time 1 -fsS http://127.0.0.1:18080/readyz > /out/smoke/ready.json 2>/dev/null; then
    READY=1; break
  fi
  sleep 0.1
done
if [[ "$READY" != 1 ]]; then cat /out/smoke/stderr.log; exit 1; fi
curl --max-time 5 -fsS http://127.0.0.1:18080/api/server/info > /out/smoke/server-info.json
for kind in preparing prepared bound; do grep -q "\"kind\":\"$kind\"" /out/smoke/stdout.jsonl; done
kill -TERM "$CHILD"
for ((i=0; i<100; i++)); do
  kill -0 "$CHILD" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$CHILD" 2>/dev/null; then echo 'Graceful shutdown timed out' >&2; exit 1; fi
wait "$CHILD"
CHILD=''
HASH="$(cut -d' ' -f1 /out/SHA256SUMS)"
LOCK_HASH="$(sha256sum /src/rust/Cargo.lock | cut -d' ' -f1)"
printf '{"target":"%s","sha256":"%s","commit":"%s","tracked_dirty":%s,"image":"%s","toolchain":"%s","cargo_lock_sha256":"%s","glibc_required":"%s","smoke":"ready200/info200/SIGTERM-exit0"}\n' \
  "$TARGET" "$HASH" "$BUILD_COMMIT" "$BUILD_DIRTY" "$BUILD_IMAGE" "$(rustc --version)" "$LOCK_HASH" "$GLIBC_MAX" > /out/build.json
echo '[linux-server] ELF/ABI and real-process smoke PASS'

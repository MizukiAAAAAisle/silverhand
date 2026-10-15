#!/usr/bin/env bash
# Build only the standalone Rust server, through Docker/OrbStack on macOS.
set -euo pipefail

if [[ "${1:-}" == --help ]]; then
  echo 'Usage: ./scripts/build-rust-linux.sh'
  echo 'Output: .cache/linux-server/<UTC timestamp>-<commit>/ (never clears old builds)'
  echo 'Optional: CARGO_BUILD_JOBS (default 4), DOCKER_CONTEXT (Docker CLI convention).'
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unexpected argument; use --help' >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
for tool in docker git; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
docker info >/dev/null

# The image supplies only the Debian 11 glibc 2.31 floor (below ECS 2.32) and
# rustup; do not move to bookworm/trixie without rechecking that floor. The
# compiler is RUST_TOOLCHAIN, installed by rustup into its own volume.
IMAGE='rust:1.94.0-bullseye@sha256:16950191527a4cb9e0762d9d48b705a6315158e4035e64f7a93ce8656a1b053c'
RUST_TOOLCHAIN='1.99.0'
JOBS="${CARGO_BUILD_JOBS:-4}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo 'CARGO_BUILD_JOBS must be positive' >&2; exit 2; }
COMMIT="$(git rev-parse HEAD)"
DIRTY=0
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || DIRTY=1
OUTPUT="$ROOT/.cache/linux-server/$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:12}"
mkdir -p "$ROOT/.cache/linux-server"
mkdir "$OUTPUT" # Refuse a name collision instead of overwriting an earlier build.
printf '[linux-server] source=%s tracked_dirty=%s\n' "$COMMIT" "$DIRTY"
printf '[linux-server] output=%s\n' "$OUTPUT"

docker run --rm --init --platform linux/amd64 \
  --mount "type=bind,source=$ROOT,target=/src,readonly" \
  --mount "type=bind,source=$OUTPUT,target=/out" \
  --mount type=volume,source=silverhand-rust-linux-registry,target=/usr/local/cargo/registry \
  --mount type=volume,source=silverhand-rust-linux-rustup,target=/rustup \
  --mount "type=volume,source=silverhand-rust-linux-target-${RUST_TOOLCHAIN//./-},target=/cargo-target" \
  --env RUSTUP_HOME=/rustup \
  --env "RUSTUP_TOOLCHAIN=$RUST_TOOLCHAIN" \
  --workdir /src/rust \
  --env CARGO_TARGET_DIR=/cargo-target \
  --env "CARGO_BUILD_JOBS=$JOBS" \
  --env CARGO_HTTP_MULTIPLEXING=false \
  --env CARGO_HTTP_TIMEOUT=120 \
  --env CARGO_NET_RETRY=5 \
  --env 'RUSTFLAGS=--remap-path-prefix=/src/=source/ --remap-path-prefix=/usr/local/cargo/registry/src/=cargo/ --remap-path-prefix=/rustup/toolchains/=rustup/' \
  --env "BUILD_COMMIT=$COMMIT" --env "BUILD_DIRTY=$DIRTY" --env "BUILD_IMAGE=$IMAGE" \
  "$IMAGE" bash /src/scripts/build-rust-linux-container.sh

printf '[linux-server] PASS: %s/silverhand-backend\n' "$OUTPUT"
echo '[linux-server] No files uploaded and no ECS process changed.'

#!/usr/bin/env bash
set -euo pipefail

RUST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$RUST_DIR/.." && pwd)"
CODEGEN_DIR="$RUST_DIR/tools/wire-codegen"

"$RUST_DIR/tools/generate-wire.sh"
pnpm --dir "$CODEGEN_DIR" run build
pnpm --dir "$CODEGEN_DIR" run verify
git -C "$REPO_DIR" diff --exit-code -- \
  packages/shared/src/generated/rust-backend

echo "Rust/TypeScript/Zod drift gate passed"

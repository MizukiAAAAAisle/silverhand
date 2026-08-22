#!/usr/bin/env bash
set -euo pipefail

RUST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$RUST_DIR/.." && pwd)"
GENERATED_DIR="$REPO_DIR/packages/shared/src/generated/rust-backend"
CODEGEN_DIR="$RUST_DIR/tools/wire-codegen"

cd "$RUST_DIR"
cargo run --locked -p silverhand-backend-server --example export_wire -- \
  "$GENERATED_DIR"
rm -f "$GENERATED_DIR/wire.zod.ts"
pnpm --dir "$CODEGEN_DIR" install \
  --frozen-lockfile --ignore-workspace --ignore-scripts
pnpm --dir "$CODEGEN_DIR" run generate:zod

for artifact in wire.ts wire.zod.ts contract.json; do
  if [[ ! -s "$GENERATED_DIR/$artifact" ]]; then
    echo "wire generation did not produce $artifact" >&2
    exit 1
  fi
done

if rg -n '(^|[^[:alnum:]_])(any|unknown)([^[:alnum:]_]|$)' \
  "$GENERATED_DIR/wire.ts" "$GENERATED_DIR/wire.zod.ts"; then
  echo "generated wire artifacts contain any/unknown" >&2
  exit 1
fi
if rg -n -- '--skipValidation|skipValidation' "$CODEGEN_DIR"; then
  echo "wire codegen must not skip ts-to-zod validation" >&2
  exit 1
fi

echo "Rust aggregate wire + Zod artifacts generated"

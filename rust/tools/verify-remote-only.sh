#!/usr/bin/env bash
set -euo pipefail

RUST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$RUST_DIR/.." && pwd)"
CODEGEN_DIR="$RUST_DIR/tools/wire-codegen"
OUTPUT_ROOT="$RUST_DIR/target/contract-compositions"
EMBEDDED_DIR="$OUTPUT_ROOT/embedded"
REMOTE_DIR="$OUTPUT_ROOT/remote-only"
NODE_BIN="$(command -v node)"
PNPM_BIN="$(command -v pnpm)"
NODE_ONLY_BIN="$(mktemp -d)"

cleanup() {
  rm -rf "$NODE_ONLY_BIN"
}
trap cleanup EXIT

ln -s "$NODE_BIN" "$NODE_ONLY_BIN/node"
NODE_ONLY_PATH="$NODE_ONLY_BIN:/usr/bin:/bin"

node "$RUST_DIR/tools/compose-contract.mjs" embedded "$EMBEDDED_DIR"

# Everything below consumes checked-in artifacts with Cargo absent. This is the
# remote-only build contract, not the dev/CI regeneration path.
env PATH="$NODE_ONLY_PATH" "$PNPM_BIN" --dir "$CODEGEN_DIR" install \
  --frozen-lockfile --ignore-workspace --ignore-scripts
env PATH="$NODE_ONLY_PATH" "$PNPM_BIN" --dir "$CODEGEN_DIR" run build
env PATH="$NODE_ONLY_PATH" "$PNPM_BIN" --dir "$CODEGEN_DIR" run verify
env PATH="$NODE_ONLY_PATH" "$NODE_BIN" \
  "$RUST_DIR/tools/compose-contract.mjs" remote-only "$REMOTE_DIR"
env PATH="$NODE_ONLY_PATH" "$NODE_BIN" \
  "$RUST_DIR/tools/audit-remote-only.mjs" "$REMOTE_DIR"

cmp "$EMBEDDED_DIR/contract.json" "$REMOTE_DIR/contract.json"
cmp "$EMBEDDED_DIR/wire.ts" "$REMOTE_DIR/wire.ts"
cmp "$EMBEDDED_DIR/wire.zod.ts" "$REMOTE_DIR/wire.zod.ts"
"$NODE_BIN" -e '
  const fs = require("node:fs");
  const [embeddedPath, remotePath] = process.argv.slice(1);
  const embedded = JSON.parse(fs.readFileSync(embeddedPath, "utf8"));
  const remote = JSON.parse(fs.readFileSync(remotePath, "utf8"));
  if (embedded.generatedContractSha256 !== remote.generatedContractSha256) {
    throw new Error("embedded and remote-only contract hashes differ");
  }
' "$EMBEDDED_DIR/composition.json" "$REMOTE_DIR/composition.json"

git -C "$REPO_DIR" diff --exit-code -- \
  packages/shared/src/generated/rust-backend

echo "embedded + Cargo-free remote-only contract gate passed"

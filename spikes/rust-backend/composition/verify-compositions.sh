#!/usr/bin/env bash
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$CRATE_DIR/../.." && pwd)"
NODE_BIN="$(command -v node)"
CARGO_BIN="$(command -v cargo)"
NODE_ONLY_PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin"
TSC_JS="$REPO_DIR/node_modules/typescript/bin/tsc"
COMPOSITIONS_DIR="$CRATE_DIR/target/compositions"
EMBEDDED_DIR="$COMPOSITIONS_DIR/embedded"
REMOTE_DIR="$COMPOSITIONS_DIR/remote-only"

if [[ ! -f "$TSC_JS" ]]; then
  echo "TypeScript compiler missing: $TSC_JS" >&2
  exit 1
fi

cd "$CRATE_DIR"
"$CARGO_BIN" build --locked --release
"$NODE_BIN" composition/compose.mjs \
  embedded \
  "$EMBEDDED_DIR" \
  "$CRATE_DIR/target/release/silverhand-rust-backend-spike"

# From this line through the remote client execution, PATH contains Node plus
# base OS tools only. The audit asserts that `cargo` is genuinely unreachable.
env PATH="$NODE_ONLY_PATH" "$NODE_BIN" "$TSC_JS" \
  --project "$CRATE_DIR/composition/tsconfig.json"
env PATH="$NODE_ONLY_PATH" "$NODE_BIN" composition/compose.mjs \
  remote-only \
  "$REMOTE_DIR"
env PATH="$NODE_ONLY_PATH" "$NODE_BIN" composition/audit-remote-only.mjs \
  "$REMOTE_DIR"

cmp "$EMBEDDED_DIR/client/client.mjs" "$REMOTE_DIR/client/client.mjs"
cmp "$EMBEDDED_DIR/client/contract.json" "$REMOTE_DIR/client/contract.json"
"$NODE_BIN" -e '
  const fs = require("node:fs");
  const [embeddedPath, remotePath] = process.argv.slice(1);
  const embedded = JSON.parse(fs.readFileSync(embeddedPath, "utf8"));
  const remote = JSON.parse(fs.readFileSync(remotePath, "utf8"));
  if (embedded.contract.sha256 !== remote.contract.sha256) {
    throw new Error("embedded and remote-only contract hashes differ");
  }
' "$EMBEDDED_DIR/composition.json" "$REMOTE_DIR/composition.json"

PROOF_TMP="$(mktemp -d)"
BACKEND_PID=''
cleanup() {
  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  rm -rf "$PROOF_TMP"
}
trap cleanup EXIT

PORT="$($NODE_BIN -e '
  const net = require("node:net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    console.log(server.address().port);
    server.close();
  });
')"
ORIGIN="http://127.0.0.1:$PORT"
SPIKE_BIND="127.0.0.1:$PORT" \
SPIKE_DB_PATH="$PROOF_TMP/spike.db" \
"$EMBEDDED_DIR/backend/silverhand-rust-backend-spike" \
  >"$PROOF_TMP/backend.log" 2>&1 &
BACKEND_PID="$!"

READY=0
for _ in $(seq 1 50); do
  if env PATH="$NODE_ONLY_PATH" "$NODE_BIN" -e \
    'fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' \
    "$ORIGIN/healthz"; then
    READY=1
    break
  fi
  sleep 0.05
done
if [[ "$READY" != '1' ]]; then
  cat "$PROOF_TMP/backend.log" >&2
  exit 1
fi

env PATH="$NODE_ONLY_PATH" "$NODE_BIN" \
  "$EMBEDDED_DIR/client/client.mjs" "$ORIGIN" 'embedded composition'
env PATH="$NODE_ONLY_PATH" "$NODE_BIN" \
  "$REMOTE_DIR/client/client.mjs" "$ORIGIN" 'remote-only composition'

echo "embedded + remote-only composition proof passed"

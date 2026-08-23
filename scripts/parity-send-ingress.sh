#!/usr/bin/env bash
# The send-ingress parity gate, in the one order that proves anything.
#
# The reference oracle runs FIRST: it asserts every case in
# `packages/backend/tests/send-ingress/contract.json` against the real production schemas and
# cap helpers, so the artifact's expectations are the rule's answers. Only if that passes does
# the Rust consumer run against the same file through the real product router.
#
# Running either side alone proves one implementation. Nothing inside a test can establish this
# order — that is why it lives in a checked-in, fail-fast command rather than in an assertion.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/2] reference oracle (TypeScript)"
cd "$root/packages/backend"
pnpm exec vitest run tests/send-ingress-contract.test.ts

echo "[2/2] consumer (Rust)"
cd "$root/rust"
cargo test --locked --offline -p silverhand-backend-server --test send_ingress_contract

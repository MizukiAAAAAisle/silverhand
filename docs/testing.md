# Testing

The production server is Rust. The retired TypeScript backend/server packages and their test runners no longer exist.

## Commands

```bash
pnpm test
./scripts/test.sh --scope shared
./scripts/test.sh --scope host tests/supervisor.test.ts
pnpm typecheck
node rust/tools/verify-scaffold.mjs
cd rust
cargo test --workspace
```

The JavaScript gate runs shared → host → cli → desktop. There is no SQLite native-module ABI swap. Tests must use isolated data roots and must not start a user's existing runtime or connect to a live database.

## Ownership

- `packages/shared/tests`: schemas, protocol projections, and cross-language contracts.
- `packages/host/tests`: runtime drivers, supervisor, daemon transport, filesystem isolation and subprocess oracles.
- `packages/cli/tests`: command binding, HTTP requests and subprocess behavior.
- `apps/desktop/src`: renderer and main-process tests alongside their implementation.
- `rust/crates/backend-core`: pure domain rules.
- `rust/crates/backend-sqlite`: real SQLite persistence, migrations and authority tests.
- `rust/crates/backend-server`: routing, authentication, WebSocket and delivery tests.
- `rust/crates/backend-app`: fully composed production application tests.

## Test audits

Inventory by package/crate, then production-owned folder or module, then test file. Include inline Rust tests, subprocess scenarios, fixtures and executable gates; assign cross-package proofs to their canonical owner. Record exclusions explicitly. Track review decisions separately from test execution: a passing suite is not an audited suite.

For each reviewed test, record **retain**, **repair**, **consolidate** or **delete**, with the behavior it protects and the remaining owner of any moved assertion. Preserve independent protocol, security, migration and packaging contracts even when they use static checks. Before removing a test-only production export, verify it has no real callers and move meaningful assertions to the observable boundary.

Keep each edit batch within a coherent owner boundary. Capture its baseline, then verify the replacement with a deliberate isolated fault: a timeout mock must respond to the production abort signal, and a parser fixture must actually exercise the token-consumption branch it names. Restore the control checkout after testing. Never delete a failing baseline test merely to make the suite green.

## Independent regression data

`rust/test-fixtures` contains frozen SQL/JSON oracles previously captured during the TypeScript-to-Rust migration. Their bytes are retained independently of the deleted implementation. Rust tests consume these directly; they do not invoke the old server.

`packages/shared/src/db` remains the append-only migration source. `node scripts/generate-rust-migrations.mjs --check` checks its generated Rust projection. The Rust startup tests replay that projection and compare the resulting schema with the independent normalized schema oracle. Historical migration semantics must not follow current product validators.

The shared `cli-route-contract.json` is checked against CLI discovery and internal paths; Rust checks its audit identities against that contract and the production perimeter, and composition tests probe actual mounted routes. Updating only a static list cannot satisfy the real HTTP/WS gates.

## Runtime and packaging boundaries

Driver-oracle regressions live in `packages/host/tests/driver-oracle-regression.test.ts`; new incidents should add a minimal raw-frame fixture there before broadening driver tests. Lifecycle/settlement is covered separately by supervisor and Rust delivery integration tests.

`pnpm dev` still builds and launches the Rust embedded sidecar. `pnpm dev:headless` is an Electron main-process mode, not a legacy TypeScript server. Use an isolated `SILVERHAND_DIR` for manual testing.

Both embedded and remote-only Desktop builds must pass the module-graph guard. Remote-only additionally excludes the Rust launcher and sidecar resources. Its final package must contain neither embedded binary nor manifest; the daemon/CLI remain required.

Release packaging contracts belong to the executable package gate, not source-string assertions over shell variables or function names. On an arm64 macOS builder, run `./scripts/package.sh --dir --output-dir <isolated-name>` and the corresponding `--remote-only --server-url https://example.invalid` invocation with a second output directory and an explicit isolated `SILVERHAND_DIR`. These commands build and verify artifacts without launching the App: the final signature, canonical version, daemon identity and signed sidecar manifest must pass. Fast unit tests cover rejected CLI arguments, dependency/config boundaries, binary UUID bytes and startup-side artifact validation.

# Silverhand Rust Server

The Rust server is Silverhand's control plane: identities, workspaces, conversations, tasks, persistence and agent orchestration. The same `silverhand-backend` binary runs as an embedded Desktop sidecar or a standalone server. Agent processes run on computers through the TypeScript host/daemon, not inside the server.

## Architecture

| Crate                   | Responsibility                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `backend-app`           | Composition root: configuration, dependency wiring, startup, background work and shutdown.     |
| `backend-core`          | Domain rules, application operations and ports; no Axum, SQLx or wire DTO dependencies.        |
| `backend-server`        | HTTP/WS authentication, request validation, transport lifecycle and response/event projection. |
| `backend-sqlite`        | Core port implementations: SQL, transactions, migrations and read models.                      |
| `backend-filesystem`    | Host-local adapters for server-owned blobs and runtime discovery.                              |
| `backend-observability` | Caller-owned operation timing and tracing helpers.                                             |

`backend-app` assembles the adapters. Transport and persistence depend on core contracts; core must not depend on them. Keep business policy out of handlers and engine-specific types out of core and wire contracts. Modules are organized by capability (identity, messaging, runtime, read models, etc.), not a second domain model for each transport.

## Development invariants

- **One actor model.** Humans and agents share domain operations through authenticated principals. Actor differences belong in explicit policies, not parallel implementations. Enforce ownership, membership and capabilities on the server; UI visibility is not authorization.
- **Respect process boundaries.** Embedded and standalone use the same contracts. Never assume the server owns a remote computer's filesystem or agent processes; route execution through its daemon.
- **Keep writes atomic and short.** Preserve transaction, idempotency and connection-generation guards. Do not hold database transactions across network or runtime waits. Commit durable facts before announcing their success or dispatching dependent effects.
- **Migrations are append-only.** `packages/shared/src/db` is the migration source; Rust consumes its generated projection. Do not edit shipped migrations or generated output by hand. Preserve startup locking, foreign-key checks and the bundled SQLite policy in `.cargo/config.toml`.
- **Change contracts together.** Audit shared schemas, CLI/Desktop consumers and daemon protocol boundaries when changing HTTP/WS payloads. Package versions are not protocol compatibility gates; follow the existing admission contracts.
- **Measure operation boundaries.** Use standard async instrumentation, never an entered-span guard across `.await`. Record success/error/cancellation explicitly; span clones must not delay completion. Separate pool wait, transaction acquisition and query time. Keep diagnostic error context, but never log credentials or message bodies.
- **Test observable behavior in isolation.** Put rules in core tests, persistence in real SQLite tests, HTTP/WS behavior in server tests and composed flows in app tests. Use isolated data roots; never attach tests to a live user database or runtime. SQLx tracing integration tests use the production global subscriber in a separate process.

## Local checks

From the repository root (Rust 1.94+):

```bash
node scripts/generate-rust-migrations.mjs --check
node rust/tools/verify-scaffold.mjs
cd rust
cargo fmt --all -- --check
cargo check --workspace --locked
cargo test --workspace --locked
```

For local server startup, follow the [root README](../readme.md). See [BUILDING.md](BUILDING.md) for build and database-startup policy, [Testing](../docs/testing.md) for test ownership, and [Server logging](../docs/rust-server-logging.md) for diagnostics.

## License

Licensed under [Apache-2.0](../LICENSE). Third-party components retain their own licenses.

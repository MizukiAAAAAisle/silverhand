# #2165 Rust backend dependency and vertical-slice decision

- Date: 2026-08-23
- Prototype path: `spikes/rust-backend/`
- Prototype commits: `97dc6711` (initial ecosystem proof), `083a5970`
  (deployment and persistence boundaries), `3960a420` (application fact and
  corrected proof claims), `73fc2de5` (root-only immediate isolation proof)
- Branch: `task-2165-rust-backend-spike`

## Decision

Use the following pinned foundation for the first Rust backend slice:

| Concern | Selected version | Decision |
| --- | --- | --- |
| Async runtime / HTTP / WebSocket | Tokio `1.53.1`, Axum `0.8.9` | One Tokio/Tower service model; Axum owns HTTP and WebSocket upgrade. |
| SQLite / pool / migrations | SQLx `0.9.0` with Tokio, SQLite, macros and migrations only | Bundled SQLite, explicit WAL/foreign-key/synchronous/busy-timeout configuration, bounded pool and transactional migrations. `NORMAL` is an experiment, not the selected foundation durability policy. |
| HTTP middleware / observability | tower-http `0.7.0`, tracing `0.1.44`, tracing-subscriber `0.3.23` | Shared structured spans, JSON logs and runtime filtering. |
| Rust-to-TypeScript wire types | ts-rs `12.0.1` | Narrow explicit export manifest and checked-in deterministic generated artifacts. |
| WebSocket test client | tokio-tungstenite `0.30.0` | Protocol test dependency only; no second server stack. |

The prototype is a decision artifact, not a business migration or the final
domain layout. Actix Web, `rusqlite` + a separate pool/migrator, Specta 2 RC,
and a standalone WebSocket server remain unselected for the reasons recorded in
`spikes/rust-backend/README.md`.

Primary references:

- Axum 0.8.9: <https://docs.rs/axum/0.8.9/axum/>
- SQLx SQLite 0.9.0: <https://docs.rs/sqlx/0.9.0/sqlx/sqlite/>
- SQLx 0.9.0 `Pool::begin_with`: <https://docs.rs/sqlx/0.9.0/sqlx/struct.Pool.html#method.begin_with>
- SQLite WAL: <https://www.sqlite.org/wal.html>
- ts-rs 12.0.1: <https://docs.rs/ts-rs/12.0.1/ts_rs/>
- tower-http trace: <https://docs.rs/tower-http/0.7.0/tower_http/trace/>

## Verified vertical slice

The executable proves this concrete path:

```text
POST /api/messages
  -> application validation
  -> SQLite adapter transaction: message row + durable event row
  -> COMMIT
  -> bounded process-local broadcast
  -> /api/ws/events
  -> generated TypeScript wire shape
```

The event is published live only after commit. A forced second-insert failure
rolls back the message. Broadcast capacity is bounded at 64; lag closes the
client with code `1013` and a resync reason instead of silently dropping or
growing without limit.

## Verification matrix

| Claim | Automated proof | Result |
| --- | --- | --- |
| HTTP write, committed event and WebSocket payload agree | `tests/vertical_slice.rs` starts a real TCP server and client | Passed |
| Message and durable event are atomic | SQLite trigger forces event failure; row count remains zero | Passed |
| SQLite runtime configuration is effective on every pooled connection | Adapter test holds four connections and reads PRAGMAs | `foreign_keys=1`, `journal_mode=wal`, `synchronous=1`, `busy_timeout=5000` |
| Root write reserves the writer before its first write | tx1 executes `BEGIN IMMEDIATE` with zero writes; tx2 uses a 25 ms busy timeout | tx2 fails at begin with `SQLITE_BUSY` |
| Nested root immediate cannot silently become a savepoint | call SQLx `begin_with("BEGIN IMMEDIATE")` at non-zero transaction depth | explicit `InvalidSavePointStatement` |
| Fanout is bounded and lag visible | Broadcast capacity-one test | `Lagged(1)` and close code `1013` |
| Rust wire export is explicit and deterministic | `tests/export_bindings.rs`, checked-in `bindings/`, clean-diff gate | Passed |
| Tagged enum / null / optional / `i64` parity is understood | ts-rs shape probes | Passed; raw `i64` maps to `bigint`, so IDs/time are decimal strings on JSON wire |
| SQLite does not visibly leak inward in the current spike | `tests/persistence_text_fence.rs` | Text fence passed for current `application`, `contracts`, and `http` source roots; this is not a module dependency-closure proof |
| Event semantics do not reuse wire/storage shapes | application fact plus HTTP and SQLite projection tests | `MessageCreatedFact` is the single semantic fact; wire `ServerEvent` and versioned durable JSON are independent boundary projections |
| Embedded composition packages the same backend executable | `composition/verify-compositions.sh` | Passed |
| Remote-only requires no Cargo and carries no backend/native/SQLite artifact | Same script runs typecheck, compose, audit and client under Node-only `PATH` | Passed; exact artifact allowlist is three files |
| Embedded and remote-only have no contract fork | Same script compares client bytes, descriptor bytes and full binding hash, then runs both clients against one backend | Passed |

## Remote-only and embedded composition contract

`embedded` may package and start the prebuilt backend executable as a sidecar.
`remote-only` contains only:

```text
client/client.mjs
client/contract.json
composition.json
```

The remote-only audit rejects backend/migration directories, Cargo manifests,
Rust sources/metadata, SQLx/SQLite/database files and native Node modules, and
also proves `cargo` is unavailable. TypeScript consumes pre-generated Rust wire
artifacts; ordinary remote-only builds do not invoke Rust tooling.

Embedded desktop and ECS/server deployments share the same executable and
HTTP/WebSocket contract. There is no embedded-only API. The existing real
desktop `electron-builder.remote-only.yml` / `scripts/package.sh --remote-only`
seam must preserve this invariant. The prototype does not yet build or unpack a
final Electron `.app`; that is a production packaging gate.

## SQLite convergence boundary

SQLite is one adapter, not a cross-layer driver abstraction:

```text
                    application::MessageCreatedFact
                       ^                         |
                       |                         v
adapters::sqlite (storage projection)      http (wire projection)
                       ^                         |
                       |                         v
                  composition                 contracts
```

The application port names a semantic atomic operation and returns
`MessageCreatedFact`, not a transport event. It exposes no SQL executor,
connection, query, row, transaction, placeholder, migration, PRAGMA,
SQLx/SQLite type or driver error. The SQLite adapter owns the pool, SQL,
migration runner, transaction, generated IDs, configuration, error mapping and
its versioned durable-payload projection. HTTP separately projects the same fact
to `ServerEvent`. There is one event meaning and two boundary representations;
neither adapter invents a second business fact. The composition root only binds
the concrete adapter to HTTP.

`tests/persistence_text_fence.rs` is intentionally a lexical regression fence,
not proof of the Rust module dependency closure. It catches obvious markers in
the current source layout, but aliases, indirect re-exports and new module
shapes can evade it. Production should strengthen the same direction through
crate dependencies and visibility; that graph is outside this spike.

The create-message use case is specifically a **root-only write UoW**. Its
SQLite adapter calls `Pool::begin_with("BEGIN IMMEDIATE")`, reserving the single
writer before reads or business work while keeping the statement/transaction
invisible to application code. A zero-write tx1 blocks tx2's immediate begin
until a controlled 25 ms timeout returns `SQLITE_BUSY`. Requesting another
custom root begin at non-zero SQLx transaction depth returns
`InvalidSavePointStatement`, so it cannot silently degrade to a savepoint. This
proves SQLx can express the current root-only immediate isolation seam. It does
not claim that read/deferred or explicit savepoint UoWs should use immediate
semantics.

No PostgreSQL implementation, dual-database contract test or generic
`SqlDriver` is part of this decision. A generic driver would guess at and leak
incompatible dialect, locking, transaction, placeholder and error semantics.
Future persistence work should implement the same semantic application ports;
its ability to do so without changing wire/use-case/domain code is a future
falsifier of the current boundary.

## Authority and recovery boundaries

The SQLite `message_events` row is durable authority for this demonstrated
stream. The in-memory broadcast is only live fanout. Production recovery should
add cursor replay from that existing log and a no-gap replay-to-live handoff;
it should not duplicate the same fact into an outbox.

Rebuildable invalidation/liveness streams may use bounded fanout plus
snapshot/resync. Host/runtime commands and settlement are a separate delivery
protocol and inherit no reliability claim from this UI WebSocket proof. An
outbox is justified only when a domain write and a mandatory-delivery event
need the same transaction and no durable event authority already exists.

## Known failure boundaries and unproved work

1. Cursor replay and the concurrent replay-to-live handoff are not implemented;
   a crash after commit and before broadcast creates a live-delivery gap that
   the durable row can later repair.
2. SQLx SQLite migration locking is a no-op. Concurrent process migration
   startup is unsupported until one named owner or an external serialization
   protocol is proved.
3. SQLite remains single-writer. Four pooled connections bound resources and
   improve reads; they do not create parallel write capacity. The five-second
   busy timeout is a visible failure boundary, not a retry policy.
4. `synchronous=NORMAL` is only an experimental value proving SQLx configuration
   and observation. It can lose a recently acknowledged transaction on power
   loss/hard reset. The foundation must not inherit it; shiki must explicitly
   choose the product durability/acknowledgement policy before migration.
5. ts-rs proves static TypeScript shape only. Runtime validation remains
   provisional: retain existing Zod and add accepted/rejected fixture parity,
   or separately prove a generated validator chain before deleting it.
6. Auth, origin policy, rate limits, request IDs, payload budgets, per-send
   timeout, multi-process fanout and production shutdown order are not proved.
7. Cross-platform native builds and final Electron artifact audits are not
   proved. Remote-only must stay free of the backend executable, SQLite runtime,
   migrations and Rust native artifacts.
8. The current source-text fence is not a module dependency proof. A production
   foundation should enforce the same direction with crate dependencies and
   visibility without changing the semantic ports.

## Reproduction

From the repository root at commit `73fc2de5` or later:

```bash
pnpm install --frozen-lockfile
cd spikes/rust-backend
cargo fmt --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked
git diff --exit-code -- bindings
./composition/verify-compositions.sh
git diff --check
```

The composition script builds the release executable, creates both profiles,
removes Cargo from the remote-only execution environment, audits contents,
compares the generated contract identity and runs both clients end to end.

# Rust backend ecosystem spike

This directory is an intentionally isolated proof for #task:2165. It proves one
small path end to end:

```text
POST /api/messages
  -> validated application command
  -> one SQLite transaction (message + stored projection of application fact)
  -> COMMIT
  -> bounded in-memory fanout
  -> /api/ws/events WebSocket
  -> wire projection + generated TypeScript event interface
```

It does **not** migrate current business behavior, replace `packages/backend`,
or define the future domain/module layout.

## Recommendation

Use this combination for the first real Rust backend foundation:

| Concern | Choice and pinned spike version | Why |
| --- | --- | --- |
| Runtime / HTTP | Tokio `1.53.1` + Axum `0.8.9` | One Tokio/Tower/Hyper service model, macro-free routing, built-in WebSocket upgrade, and reusable Tower middleware. |
| SQLite / pool / migrations | SQLx `0.9.0` with only Tokio + SQLite + migration/macro features | One adapter owns async connection scheduling, a bounded pool, transactions, and embedded migrations. The slice explicitly configures and observes WAL, foreign keys, `synchronous=FULL` (shiki's durability decision in #task:2166, replacing the `NORMAL` first experimented with here), a 5 s busy timeout, and four connections. |
| WebSocket | Axum's `ws` server; `tokio-tungstenite 0.30.0` as test client | No second server framework. The server fanout is bounded; lag becomes a visible close (`1013`) instead of unbounded memory growth. |
| Tracing | `tracing 0.1.44`, `tracing-subscriber 0.3.23`, `tower-http 0.7.0` | Contextual spans, JSON output, runtime `RUST_LOG` filtering, and HTTP middleware use the same instrumentation model. |
| Rust -> TypeScript | `ts-rs 12.0.1` | Stable, focused derivation with Serde-name compatibility and deterministic checked-in output. |

The exact versions and `Cargo.lock` are committed because this is a reproducible
decision artifact. SQLx 0.9 requires Rust `1.94`; `Cargo.toml` makes that floor
explicit.

Primary references checked on 2026-08-23:

- [Axum crate and Tower compatibility](https://docs.rs/axum/0.8.9/axum/) and
  [Axum WebSocket handling](https://docs.rs/axum/0.8.9/axum/extract/ws/)
- [SQLx SQLite driver and linking model](https://docs.rs/sqlx/0.9.0/sqlx/sqlite/),
  [SQLite connection options](https://docs.rs/sqlx/0.9.0/sqlx/sqlite/struct.SqliteConnectOptions.html),
  [`Pool::begin_with`](https://docs.rs/sqlx/0.9.0/sqlx/struct.Pool.html#method.begin_with),
  [embedded migrations](https://docs.rs/sqlx/0.9.0/sqlx/macro.migrate.html), and
  [SQLx 0.9's SQLite migration source](https://github.com/transact-rs/sqlx/blob/v0.9.0/sqlx-sqlite/src/migrate.rs#L149-L155)
- [SQLite WAL concurrency and durability](https://www.sqlite.org/wal.html#concurrency),
  [foreign-key enablement](https://www.sqlite.org/foreignkeys.html#fk_enable), and
  [`busy_timeout`](https://www.sqlite.org/pragma.html#pragma_busy_timeout)
- [`tower-http` tracing](https://docs.rs/tower-http/0.7.0/tower_http/trace/),
  [`tracing-subscriber` JSON formatting](https://docs.rs/tracing-subscriber/0.3.23/tracing_subscriber/fmt/),
  and [`EnvFilter`](https://docs.rs/tracing-subscriber/0.3.23/tracing_subscriber/filter/struct.EnvFilter.html)
- [`ts-rs` exports and Serde compatibility](https://docs.rs/ts-rs/12.0.1/ts_rs/)
- [`tokio-tungstenite 0.30.0`](https://docs.rs/tokio-tungstenite/0.30.0/tokio_tungstenite/),
  [`Actix Web 4.15.0`](https://docs.rs/actix-web/4.15.0/actix_web/),
  [`rusqlite 0.40.2`](https://docs.rs/rusqlite/0.40.2/rusqlite/),
  [`refinery 0.9.2`](https://docs.rs/refinery/0.9.2/refinery/), and
  [`Specta 2.0.0-rc.25`](https://docs.rs/specta/2.0.0-rc.25/specta/)

## Candidates not selected

### Actix Web `4.15.0`

Actix Web is mature and fast, but it creates a second service/middleware model
where the selected stack already needs Tokio for SQLx and daemon/network work.
Axum's direct Tower compatibility is the cleaner long-term seam for shared HTTP,
gRPC, timeout, auth, tracing, and load-shed middleware. Performance is not a
proven bottleneck, so it does not justify the additional framework boundary.

### `rusqlite 0.40.2` + pool + `refinery 0.9.2`

`rusqlite` exposes SQLite's synchronous semantics more directly and remains the
best fallback if profiling proves SQLx scheduling or pool behavior unsuitable.
Selecting it now would also require us to design a blocking executor/single-writer
actor, choose and integrate a pool, and add a separate migration system. SQLx
proves the required slice with fewer independent lifecycle owners.

This is not permission to hide concurrency semantics behind the pool: SQLite is
still a single-writer database. A four-connection pool improves concurrent reads;
it does not increase write parallelism.

### Specta `2.0.0-rc.25`

Specta has a broader type-export ecosystem, but its current 2.x line is still a
release candidate. The backend needs stable Rust-to-TypeScript declarations, not
an RPC framework. `ts-rs` is the smaller stable choice. Revisit Specta only if a
real requirement appears for multi-language export or an integrated typed-RPC
surface.

### Standalone WebSocket framework or direct Tungstenite server

Rejected. Axum already performs the HTTP upgrade and exposes a split-capable
WebSocket stream. A separate listener would duplicate admission, auth, tracing,
shutdown, and origin-policy plumbing. `tokio-tungstenite` remains useful as a
portable client and protocol test dependency.

## Run and verify

The full automated proof is:

```bash
cd spikes/rust-backend
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
git diff --exit-code -- bindings
./composition/verify-compositions.sh
```

`cargo test` covers:

- an actual ephemeral TCP server;
- a real WebSocket client connecting before the HTTP write;
- the HTTP -> SQLite transaction -> committed event -> WebSocket path;
- rollback of the message insert when the event insert fails mid-transaction;
- bounded broadcast lag detection;
- regeneration of the explicit TypeScript wire-contract manifest;
- exact `ts-rs` behavior for tagged enums, optional/null, `i64`, and time/ID
  wire strings;
- the effective WAL, foreign-key, synchronous, busy-timeout, and bundled SQLite
  version on every pooled connection.
- the root-only write UoW's `BEGIN IMMEDIATE` reservation before its first
  insert, plus explicit nested-root rejection instead of a savepoint;
- the application fact's independent wire and versioned durable-payload
  projections;
- a source-text regression fence that currently keeps SQLx, SQLite types,
  PRAGMAs, migrations, transactions, dialect SQL, and driver errors in the
  SQLite persistence adapter. It is not a module dependency-closure proof.

`composition/verify-compositions.sh` additionally proves both supported
deployment compositions:

| Composition | Contents | Backend lifecycle |
| --- | --- | --- |
| `embedded` | Pre-generated wire descriptor + client + the prebuilt `silverhand-rust-backend-spike` executable | A desktop packager may install and start the executable as a sidecar. |
| `remote-only` | The identical wire descriptor + identical client only | Connects to a remote origin using HTTP/WebSocket; Cargo is deliberately absent from `PATH`, and the artifact audit rejects backend, migration, SQLite, SQLx, Rust, native-module, and database files. |

Both clients run against the same packaged backend and compare the same
contract hash. There is no embedded-only transport or endpoint. ECS/server and
desktop deployments must compose this same executable and HTTP/WebSocket
contract; deployment mode changes lifecycle ownership, not application APIs.

The checked-in generated contract is a packaging input, so a remote-only build
does not execute Rust tooling. In the real desktop pipeline,
`electron-builder.remote-only.yml` and `scripts/package.sh --remote-only` must
continue to omit every backend/native artifact and never invoke Cargo. A future
embedded Electron profile may add the prebuilt executable through an explicit
`extraResources`-style allowlist. The spike validates the composition rule and
artifact shape; it does not yet build or inspect a final Electron `.app`.

To inspect the runnable server and JSON logs manually:

```bash
cd spikes/rust-backend
spike_data_dir="$(mktemp -d)"
RUST_LOG=info SPIKE_DB_PATH="$spike_data_dir/spike.db" cargo run
```

Then, in another terminal:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/messages \
  -H 'content-type: application/json' \
  -d '{"body":"hello from curl"}'
```

The WebSocket endpoint is `ws://127.0.0.1:8787/api/ws/events`. Connect before
posting; this spike intentionally has no replay handshake yet.

## Behavior and invariants proved

- The HTTP response and WebSocket event use the same Rust contract types.
- Application facts carry integer IDs and timestamps. They cross the
  JSON/TypeScript boundary as decimal strings, avoiding JavaScript safe-integer
  loss and the invalid `bigint`-inside-JSON mismatch.
- A message row and its event row commit atomically. Fanout occurs only after
  commit, so clients are never told about rolled-back state.
- The broadcast ring is bounded at 64 events. A consumer that falls behind is
  closed with `1013` and an explicit resync reason.
- Migrations are embedded in the executable, while `build.rs` makes stable Cargo
  rebuild when migration files change.
- SQLite is bundled by SQLx for reproducible desktop/server builds instead of
  depending on the host's SQLite version.
- Logs are structured JSON and include request and database spans. The log level
  is controlled with `RUST_LOG`.
- Generated `.ts` files are ordinary reviewable artifacts. CI must run the
  export tests and reject a dirty `bindings/` diff.

## Persistence boundary

SQLite is one concrete persistence adapter, not an application-wide database
abstraction. The dependency direction is deliberately narrow:

```text
                    application::MessageCreatedFact
                       ^                         |
                       |                         v
adapters::sqlite (storage projection)      http (wire projection)
                       ^                         |
                       |                         v
                  composition                 contracts
```

`application::MessageUnitOfWork` names the one business operation this slice
needs: atomically create a message and its event. It returns the application
fact `MessageCreatedFact`, not an HTTP/WS DTO. It exposes no connection, query,
row, transaction, placeholder, migration, PRAGMA, SQLx, SQLite type, or driver
error. `adapters::sqlite` owns the pool, concrete transaction, dialect SQL,
migrations, configuration, generated identifiers, error mapping, and a
versioned stored-payload projection from that fact. `http` independently
projects the same fact into `ServerEvent`. Event semantics therefore have one
application source; storage and wire representations are boundary concerns.
The composition root is the only module that binds the adapter to HTTP.

`tests/persistence_text_fence.rs` is deliberately only a source-text regression
fence. It scans the current application/contracts/http roots for adapter
markers, verifies that the concrete and stored-payload details remain in
`adapters::sqlite`, and prevents the composition root from acquiring obvious
SQL or transaction mechanics. Aliases, indirect re-exports, or unconventional
module layouts could bypass a lexical test, so this does **not** prove the Rust
module dependency closure. A production foundation should enforce direction
with crate dependencies and visibility. This spike intentionally does not
implement PostgreSQL, promise a two-driver contract test, or introduce a generic
`SqlDriver` abstraction. A generic driver would prematurely flatten
incompatible query, locking, transaction, placeholder, and error semantics. A
future adapter should implement semantic application ports without changing
wire/use-case/domain code; that future work is a falsifier of this boundary, not
current scope.

This create-message use case is specifically a **root-only write UoW**, so
`adapters::sqlite` starts it with `Pool::begin_with("BEGIN IMMEDIATE")`.
Application code sees neither that statement nor a transaction handle. This is
the isolation seam needed by the current Silverhand root write flows, not a
claim that every UoW must be immediate: read/deferred transactions and explicit
savepoint-based nesting remain valid, separately named semantics.

## Four audited boundaries

### 1. SQLite configuration and write concurrency

The pool test holds all four connections simultaneously and reads their actual
PRAGMAs. Each has `foreign_keys=1`, `journal_mode=wal`, `synchronous=2` (`FULL`),
and `busy_timeout=5000`. The bundled runtime is at least SQLite `3.51.3`, which
contains the 2026 WAL-reset race fix called out by SQLite's WAL documentation.

WAL allows readers and one writer to overlap; it still permits only one writer
at a time and requires every process to be on the same host. The adapter runs
`synchronous=FULL`. That is shiki's durability decision (#task:2166), replacing
the `NORMAL` this spike originally experimented with: `NORMAL` skips an fsync at
commit, so a power loss or hard reset can roll back a recently acknowledged
transaction. The TypeScript backend never sets this pragma and therefore already
runs on SQLite's `FULL` default, so inheriting `NORMAL` would have been a
durability regression rather than a neutral default. After 5 seconds of writer
contention the operation fails; no handler may turn that into an unbounded
retry loop.

The root-write tests establish timing and nesting, not only final atomicity.
Transaction one executes `BEGIN IMMEDIATE` without any write; a second pooled
connection then fails its own `BEGIN IMMEDIATE` with `SQLITE_BUSY` after a
controlled 25 ms timeout. Writer reservation therefore happens before the first
insert. Separately, calling `begin_with` again at non-zero SQLx transaction
depth returns `InvalidSavePointStatement`; it does not silently become a
savepoint. These results prove SQLx can express the current root-only immediate
seam. They do not outlaw deferred or savepoint UoWs.

### 2. Migration startup ownership

Each ordinary SQLx migration and its history row run in one SQLite transaction,
so a failed script rolls back. However, SQLx 0.9's SQLite `Migrate::lock()` and
`unlock()` implementations are no-ops. Therefore **concurrent process startup is
not a supported migration contract in this spike**. `SqliteDatabase::open` is
only a convenient proof composition.

The real runtime must choose one named migration owner (desktop/server process
before serving) or implement and test an external serialization/retry protocol.
Other instances must not race `Migrator::run`. Separate `connect` from
`migrate-to-required-version` before multi-instance deployment.

### 3. Rust/TypeScript parity and source of truth

`src/contracts.rs` contains only transport DTOs; no SQL row, repository, domain,
or application-service type is exported. `tests/export_bindings.rs` is the
single export manifest. Merely deriving `TS` does not publish a type. This is a
deliberate cross-lane gate: `packages/shared` must never be mechanically mirrored
into a Rust `shared` crate.

For a real migration, use a narrow Rust wire-contract crate/module as the source
of truth and emit into an explicit generated subtree such as
`packages/shared/src/generated/rust-wire/`. `@silverhand/shared` may keep carrying
contracts to TS consumers and re-export those files; the forbidden move is
mirroring all of `packages/shared` into a Rust `shared` crate. CI runs the
manifest, requires a clean generated diff, and the generated header forbids hand
edits. Contract changes are reviewed as Rust wire change + generated diff in one
commit.

Generation is strictly one-way: the Rust contract build reads no TypeScript,
and ordinary TypeScript builds read checked-in artifacts without invoking Cargo.
The exporter is a developer/CI drift check, not a runtime build dependency, so
there is no Rust <-> TypeScript build cycle.

The tests pin these `ts-rs 12.0.1` facts:

- the Serde-tagged enum is a TypeScript discriminated union;
- `Option<T>` is `T | null` when present;
- an explicitly optional field is `field?: T`;
- `#[serde(default, skip_serializing_if = "Option::is_none")]` is
  `field?: T | null`;
- raw Rust `i64` becomes TypeScript `bigint`, which is **not JSON-compatible**.

Consequently, this spike's SQLite IDs and millisecond timestamps are decimal
strings on the wire. A future RFC3339 time type is also acceptable, but raw
`i64` plus a `TS_RS_LARGE_INT=number` override is rejected because it can lose
precision. The checked-in `bindings/` files prove the actual output.

`ts-rs` generates static types, not runtime validators. Data crossing a trust
boundary still needs validation. This spike does **not** prove a validator
generation chain, so runtime validation remains provisional: keep the existing
Zod validator until either (a) Rust/TS accepted-and-rejected fixture parity gates
prove the independently maintained Zod shape, or (b) a small same-Rust-DTO schema
generation/compiled-validator chain is separately run end to end. Do not delete
Zod merely because the generated interface type-checks, and do not present an
untested JSON Schema path as selected architecture.

### 4. WebSocket lag and recovery classes

The bounded broadcast behavior has different authority semantics by stream:

| Stream class | Authority | What this spike proves | Required recovery |
| --- | --- | --- | --- |
| Durable event/log row | SQLite event log | `message_events` commits atomically before live fanout; lag is bounded and visible | Cursor replay from the existing log, then an atomic replay-to-live handoff. Duplicates must be idempotent; no second outbox copy. |
| Rebuildable invalidation/liveness | Snapshot/read model | The same bounded ring and `1013` close mechanism is suitable | Reconnect and snapshot/resync; no durable event log required. |
| Host/runtime command + settlement | Separate delivery protocol | Nothing; this lane is outside the slice | Its own admission, retry, idempotency, settlement, and reconnect contract. It cannot inherit UI fanout guarantees. |

The current endpoint lacks a cursor handshake, so class-one recovery is not yet
complete. On lag it closes with code `1013` and the stable reason `event consumer
lagged; reconnect and resync`; it never drops silently or grows without bound.

## Failure modes and missing production work

The slice deliberately makes the unsafe shortcuts visible:

1. **Commit-to-live-publish crash gap.** The durable `message_events` row remains
   authoritative, but there is no cursor dispatcher. A crash after commit and
   before broadcast loses only immediate live delivery. Recovery must replay the
   existing log; adding a duplicate outbox would create two authorities.
2. **No replay/resume protocol.** Disconnects and `1013` require a full resync.
   Production WebSocket admission needs an authenticated cursor/epoch and a
   bounded replay window before switching to live delivery.
3. **One-process fanout only.** `tokio::broadcast` is a process-local live
   delivery adapter, never durable authority. It can remain the correct adapter
   for rebuildable invalidations; durable streams additionally need cursor
   replay from their existing authority.
4. **SQLite writer contention.** WAL permits concurrent readers, not concurrent
   writers. Long transactions and external writers can exhaust the 5 s busy
   timeout. Production needs named transaction timing, busy/locked metrics, and
   explicit short write units of work.
5. **Pool sizing is a budget, not a default truth.** Four connections are enough
   to prove concurrency and bound resources. Packaging/load tests must set the
   real budget per deployment mode.
6. **No auth, origin policy, rate limits, payload budget at the transport, or
   request IDs.** These belong in Tower admission layers, not handlers.
7. **WebSocket send timeout is absent.** The bounded ring eventually detects a
   lagged subscriber, but production must also time-bound an individual network
   write and count close reasons.
8. **Runtime validation is absent.** The explicit export manifest prevents
   accidental type publication and CI catches drift, but TypeScript declarations
   do not validate untrusted JSON. Runtime schema generation is a separate gate.
9. **Dynamic SQL is used in the slice.** If the project adopts SQLx compile-time
   query checking, CI must own offline metadata and its regeneration workflow;
   builds must not depend on a live developer database.
10. **Native compilation exists.** Bundled SQLite runs a C compiler. macOS,
    Linux (glibc and musl), Windows, and Electron packaging targets need CI
    proofs before migration starts.
11. **Final desktop artifacts are not yet audited.** The composition proof
    audits an intentionally minimal directory. A production gate must unpack
    remote-only Electron artifacts and reject the Rust executable, migrations,
    SQLite runtime, Cargo metadata, and native backend modules by name/content.

## Seams the real foundation should expose

Do not grow business modules directly around this spike's `AppState`. Extract
these ownership boundaries first:

- Business repository / unit-of-work ports: application-owned, semantic atomic
  operations with no SQL executor or driver type. Each persistence adapter owns
  its connection lifetime, migrations, transaction mode, dialect, and statement
  instrumentation.
- `EventLog`: append inside the domain transaction and read by monotonic cursor.
  It is the authority when such a durable row already exists; do not copy it
  into an outbox.
- `EventPublisher`: publish committed events; the local bounded broadcast is one
  adapter, not authority.
- `WebSocketSession`: admission, authorization, resume cursor, replay-to-live
  handoff, per-client budgets, and shutdown.
- `WireContracts`: the only Rust types exported to TypeScript, with an explicit
  manifest, generated-package boundary, runtime schema, and compatibility policy.
- `Observability`: request/transaction/socket spans, metrics, redaction, and
  trace context; libraries emit events but do not install the global subscriber.
- `RuntimeConfig` and `Shutdown`: deployment-mode configuration, cancellation,
  HTTP drain, socket close, pool close, and dispatcher stop order.

The first proof point after this spike should be the existing durable event
log's **cursor replay-to-live handoff under concurrent writes**. It must show no
gap, idempotent duplicates, authorization at replay and live admission, and
recovery across crash/reconnect. Build an outbox only for a mandatory-delivery
event that cannot already be appended to a durable authority in the domain
transaction. If the cursor proof fails, fix the delivery model before domain
code moves.

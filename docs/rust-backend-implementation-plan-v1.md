# Rust backend implementation plan v1

## Baseline

All approved research is integrated linearly on the independent worktree
`/Users/shiki/workspace/silverhand-rust-foundation`, branch
`rust-backend-foundation`. `main` is not modified.

The baseline contains four independently reviewed inputs:

- ecosystem and runnable vertical-slice proof;
- infra contracts and SQLite boundary proofs;
- bounded-context map and reproducible dependency analysis;
- Rust → TypeScript → Zod contract-generation proof.

The spike remains evidence. Moving it under `rust/` must not silently promote
the illustrative `/api/messages` endpoint or its toy schema into a production
API.

## Target dependency direction

The first implementation increment establishes three mechanically separated
crates:

```text
backend-server  ───────▶  backend-core  ◀───────  backend-sqlite
     │                       ▲
     └─ wire projection      └─ application facts + semantic UoW ports
```

- `backend-core` owns application facts, use cases, errors, and semantic ports.
  It cannot depend on Axum, SQLx, SQLite, HTTP status, or generated wire types.
- `backend-sqlite` implements semantic ports. SQL, migrations, PRAGMAs, driver
  errors, root-write and deferred-read transaction modes remain private here.
- `backend-server` owns Axum, process composition, HTTP/WS rendering, and the
  Rust wire DTO authority. It projects application facts to wire DTOs.
- the foundation increment additionally carried a Rust→TS→Zod contract-generation
  proof (an aggregate wire manifest exported to checked-in TypeScript/Zod
  artifacts, built offline with Cargo never invoked at runtime or in remote-only
  builds). That proof, its `rust/tools/**` codegen/composition scripts, and the
  generated `packages/shared/src/generated/rust-backend/**` artifacts were
  **retired by #2209** and must not be rebuilt.

Only two Rust traits are currently justified and implemented:
`MessageUnitOfWork` and `MessageReadUnitOfWork`. New ports are added only when a
real slice crosses a proven boundary. There is no generic repository,
`SqlDriver`, or `atomically(TxScope)` abstraction.

## Fastest implementation path

### Checkpoint A — workspace seam

The composition owner first lands a small scaffold-only commit containing the
root Cargo workspace, crate manifests, dependency direction, and verification
entrypoints. It contains no business behavior. This is the only blocking
checkpoint; all three implementation branches rebase onto it.

### Checkpoint B — parallel crate implementation

After the scaffold commit:

| Lane | Exclusive ownership | Deliverable |
|---|---|---|
| Core | `rust/crates/backend-core/**` | Extract the two proven semantic UoW ports, application facts/errors/use cases, and driver-free contract tests. |
| SQLite | `rust/crates/backend-sqlite/**` | Implement the semantic UoWs with SQLx; retain `FULL`, WAL/FK, root `BEGIN IMMEDIATE`, deferred snapshot reads, durable-payload projection, and source chains. |
| Server | `rust/Cargo.toml`, `rust/Cargo.lock`, `rust/crates/backend-server/**` | Axum composition and application-fact → wire projection for the real product server and its adapters. **The foundation-only wire/codegen/composition proof — `rust/tools/**`, `packages/shared/src/generated/rust-backend/**`, aggregate Rust→TS generation, the Zod generation/drift gate, and the embedded/remote-only artifact audit — was retired by #2209 and must not be rebuilt.** |

The Core owner publishes an early interface checkpoint as soon as the two port
signatures and fact/error types compile. SQLite and Server rebase on that
checkpoint and then continue in parallel. No lane edits another lane's owned
paths.

### Checkpoint C — integration

Cindy integrates in this order:

1. workspace scaffold;
2. core interface and behavior;
3. SQLite and server/wire commits in either order once both consume the same
   core commit;
4. full gates from the integration worktree.

The increment is accepted only if crate dependencies mechanically enforce the
direction above, all prior proofs still pass, remote-only construction uses no
Cargo and contains no Rust/backend/SQLite artifacts, and `main` remains
untouched.

### Checkpoint D — first production parity slice

The foundation increment does not route traffic. The next increment selects one
real, converged endpoint and freezes its request, response, error, persistence,
and event bytes before implementation. The current recommendation is a narrow
create-message path because it exercises the already proven semantic UoW and
wire seam. It must be specified from the existing TS route/service/schema—not
from the illustrative spike endpoint—before any cutover or shadow comparison.

## Explicit non-goals for this increment

- no production traffic cutover or removal of the TypeScript backend;
- no PostgreSQL adapter or cross-database abstraction;
- no complete error-map, cancellation, backpressure, config, metrics, or shared
  package cleanup;
- no new global trait catalog;
- no change to ECS stop-the-world migration ownership;
- no push or history rewrite of `main` by implementation owners.

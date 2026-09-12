# DB Boundary: converging SQLite effects into a replaceable seam

> TS backend 退役说明：文中的 `packages/backend` / `packages/server` 源码与测试坐标属于迁移期历史，已从当前仓库删除；现行控制面位于 `rust/crates`。迁移权威仍在 `packages/shared/src/db`，独立回归数据在 `rust/test-fixtures`，现行构建与验证见 [testing.md](testing.md)。

Status: active contract. Gates live in `packages/backend/tests/db-boundary/`
and run with the normal backend test suite (`./scripts/test.sh --scope backend`).

## Goal

Stop new SQLite migration debt from growing and converge touched areas toward
a boundary a future PostgreSQL adapter can slot into. This is **debt control
and semantics locking, not migration proof**: no second driver, no ORM, no
second schema, no dual writes.

Two of the scopes below are ledgers (shrink-only debt with a visible diff); the
**capability scope is a hard wall with no debt zone at all** (#task:1983). The
difference is deliberate: how much SQLite-specific SQL the app has written is a
quantity to pay down, but _who may hold the database_ is a yes/no question, and
a ledger with an empty debt zone is an invitation to the next "just this once".
Where a zone emptied, its variant was **deleted from the TypeScript type**, so
re-adding a row is a compile error rather than a review conversation.

The boundary has five scopes:

1. **Persistence scope** — native driver types, SQL text, `RunResult` /
   `lastInsertRowid` stay inside the adapter (`backend/src/db.ts`,
   `observability/observed-statement.ts`), the repository layer
   (`backend/src/repos/`, `backend/src/read-model/`) and the schema modules
   (`packages/shared/src/db/`). Use-cases and services do not gain new direct
   SQL; their existing usage is pinned, per file, shrink-only.
2. **Atomic scope** — every `db.transaction(` site is a ledgered atomic
   boundary keyed by file + enclosing function + mode. Repositories default to
   plain data operations; a repository-internal transaction is a named
   exception whose ledger reason must explain why the invariant cannot live
   with the calling owner (e.g. `MessageRepo.insertForConversationIfFresh`
   _requires_ savepoint semantics for its CAS rollback).
3. **External-effect scope** — transaction callbacks stay synchronous and free
   of directly-invoked effects (publish/broadcast/dispatch/notify, fetch,
   timers, fs). Effects follow the post-commit idiom: collect closures inside
   the transaction, drain after it returns (`application/post-commit.ts`), so
   a rollback leaves no phantom side effects.
4. **Test scope** — business behavior is tested through semantic builders and
   repository/service contracts (`tests/utils/test-context.ts`); native SQL in
   tests is either white-box by nature (schema/migration/query-plan/oracle,
   named with reasons) or pinned debt. New test files carry zero native SQL.
5. **Capability scope (hard wall)** — the raw driver handle, the driver's
   _non-SQL powers_, and the driver's _dialect_ are capabilities, not
   conveniences. The handle has one entry point (`openDatabase` in `db.ts`), one
   lifetime owner (boot: open → migrate → hand over → close), and one spender
   (`persistence/root.ts`, which returns driver-free ports). It is **not on
   `BackendContext`**, so a service or route that wants to issue a statement
   does not have a handle to reach for — that is a compile error, not a ledger
   row. Of the driver's other capabilities, eight are absent from the tree
   outright and `close()` is confined to the scopes that opened a handle.
   SQLite error codes, constraint text and trigger text are decoded only where
   the schema defines them or where a rejection becomes a domain outcome.
   Everything else states its decision in domain terms.

## The handle's whole life, in one place

Worth stating plainly, because it is the thing the gates add up to:

| Step                    | Who                                                                                        | Fenced by                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| construct               | `db.ts` (`openDatabase`) — the only file that may import the driver as a **value**         | Gate 1                                                                      |
| open failure            | `db.ts` closes the half-built handle it just made                                          | Gate 2b-B                                                                   |
| own the lifetime        | `src/index.ts` — opens, migrates, closes on shutdown; composes no persistence              | Gate 1 (`lifecycle`, cardinality 1), Gate 5 (boot is fenced from `repos/*`) |
| spend it                | `persistence/root.ts` — turns the handle into driver-free repos / UoW ports / read models  | Gate 1 (`composition`, cardinality 1)                                       |
| issue SQL               | `repos/*`, `read-model/*`, the schema modules                                              | Gates 2, 3                                                                  |
| reach it from a service | **nobody** — the context carries no handle                                                 | Gate 6 (availability + zero readers)                                        |
| reach it from a test    | one labelled seam, `testHooks.onDatabaseOpened`, consumed by `tests/utils/test-backend.ts` | Gate 6 (no production file supplies the hook or imports `tests/`)           |

An end-to-end test that needs the running server's SQL takes the server's **own**
connection through that seam rather than opening a second one. That is not
convenience: a second connection to the same file would put a live extra
reader/writer into exactly the scenarios those suites exercise (restart, crash
recovery, hard stop, WAL contention), and the app has already been bitten by a
stray connection into a live WAL.

## The gates and their ledgers

All ledgers live in `tests/db-boundary/inventory.ts` and share one contract:
gates enforce **exact equality** with the current tree, every entry is keyed
per file (× function / hazard / mode) so debt cannot move between files
silently, and debt-zone entries are **shrink-only** — counts go down, entries
disappear. A failing gate prints the current tree state as copy-pasteable
ledger lines; making it green again is always a conscious, reviewable edit.

### Zones are locations, not labels

Exact equality refuses a _silent_ change but not a _declared_ one. Every row
carries a `zone` (or, for transactions, an `owner`) naming the legitimate role
its file plays — and while that label was self-declared, the wall had a door: a
new `src/services/foo.ts` calling `db.prepare()` and adding itself as
`zone: 'repository'` matched its own row, and every gate stayed green. Deleting
the `debt` variants removed the place to _park_ a violation; it did not stop one
from being _relabelled_.

Since #task:1983 W8, `tests/db-boundary/zones.ts` binds each zone to the module
surface that actually owns that responsibility, and `zone-surface.test.ts`
checks the rules as well as the rows:

- **Surfaces are module boundaries** (`src/repos/`, `src/read-model/`,
  `packages/shared/src/db/`, ...) or named singleton roles, not per-file
  permissions. A new repository under `src/repos/` needs no edit there; admitting
  a new _module_ as a repository is an explicit boundary edit that reads as one.
- **No surface may intersect the consumer layer** — routes, use cases, services,
  runtime, ws, auth, permissions and their collaborators — asserted over the real
  source tree. That check is about the _rules_, so widening a surface to cover
  `src/services/` reddens on its own: the wall cannot be moved by the same kind
  of edit that moves a row.
- **Overlaps have a declared winner.** Where two zones of one ledger can match
  the same file, `ZONE_OVERLAP_RULES` says which is right and claiming the
  broader one is a violation, so "which label do I pick" never returns to the
  row author.
- **A surface that matches no real module fails.** A dead rule reads as
  strictness but only invites deleting the check.
- **Some zones must earn the claim.** `adapter-internal` (a SQLite repository
  translating a constraint it owns) is checked against the SQL-sink ledger — a
  file that queries nothing is translating someone else's constraint.

`transaction-boundary.test.ts` judges `(mode, owner, surface)` jointly: a
**native** transaction (every mode but `uow`) is refused outside the persistence
surface no matter which owner it claims, and the owner label must match the layer
it names. The business layers state the atomicity they need by calling a
UnitOfWork port; persistence implements it.

| Gate                           | Enforces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zone-surface.test.ts`         | (#task:1983 W8) The zone/owner labels themselves: every ledger row sits on the surface its zone names, surfaces are non-vacuous, pairwise disjoint within a ledger unless a rule names the winner, and **disjoint from the consumer layer**. Committed falsifiers cover the exact shape a reviewer waves through — an illegal file _plus_ its forged ledger row, appended to the real ledger, on every capability axis (SQL sink, driver import, native transaction, dialect decoding) and every consumer layer — while the sanctioned shapes (a service on `mode: 'uow'`, a repository on native modes) stay green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `import-ratchet.test.ts`       | The runtime driver import stays locked to `db.ts` (all packages, desktop included); every file naming `better-sqlite3` (any binding form, type or value) matches the ledger. Zones are `adapter` / `repository` / `composition` / `lifecycle`, each legal only on its owner surface (see above) — **there is no `debt` variant** (#task:1983 W6): a driver import in a business file is the thing the gate exists to refuse, not something to classify and schedule. `composition` and `lifecycle` hold **exactly one file each**, asserted, and each must state what it owns the handle for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sql-hazards.test.ts`          | Per-file × per-hazard counts of SQLite-specific constructs (JSON1, PRAGMA, `COLLATE NOCASE`, `INSERT OR ...`, `IS ?`, `BEGIN IMMEDIATE/EXCLUSIVE`, triggers, `RAISE`, date functions, `rowid`, catalog queries, `GLOB`, ...) as **baseline + reviewed expansions**: growth's sanctioned path is a `SQL_HAZARD_EXPANSIONS` entry whose reason and semantic-test path the gate validates (the test file must exist). The gate cannot mechanically distinguish a baseline bump from an expansion — it guarantees a visible `inventory.ts` diff; keeping the baseline shrink-only is the review contract. Also: SQL sink call counts per file, `lastInsertRowid` / `.immediate()` / `.exclusive()` API sites, and the dynamic-SQL ledger. Every sink row's zone (`adapter` / `repository` / `schema`) must sit on that zone's owner surface, so issuing SQL from a consumer layer cannot be settled by describing the file as a repository.                                                                                                                                                                                                                                                                                                        |
| `driver-capability.test.ts`    | (#task:1983 W6) The driver's non-SQL powers. **2b-A:** `loadExtension`, `function`, `aggregate`, `table`, `serialize`, `backup`, `unsafeMode`, `defaultSafeIntegers` appear **nowhere** in the production tree — receiver-independent name match, no ledger, zero. **2b-B:** `close()` is narrowed to receivers holding a driver handle and pinned to an exact file × function ledger, plus the rule **close only what you opened** (every closing file also calls `openDatabase`), checked mechanically. **Catalogue pin:** the method set the installed `@types/better-sqlite3` declares must equal the set assigned to gates in `DRIVER_METHOD_GATES`, so a driver upgrade that _adds_ a capability reddens here instead of arriving unfenced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `transaction-boundary.test.ts` | Transaction site ledger, repo-internal reasons present, callback hygiene (sync-only, no direct effect calls, import-alias-insensitive), exemptions keyed per site and auto-staled. `(mode, owner, surface)` is judged **jointly** (#task:1983 W8): a native `db.transaction` outside the persistence surface is refused under every owner label — the absolute route-layer assertion is now the special case of a rule that covers services, use cases, runtime, ws and auth as well — the owner must match the layer it names, and conversely a persistence module does not take an application-level boundary from a port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test-native-sql.test.ts`      | Per-test-file native statement counts — white-box files are **count-pinned too** (named reasons, no unbounded escape hatch); new files are zero-native.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `port-contract.test.ts`        | (#task:1978, widened by #1980 / #1981) Every application port module stays driver-free across its whole relative import closure — and **every port module in the tree must be listed**, so a new one cannot be born unfenced; concrete SQLite persistence is imported only by named composition roots — application/service code depends on ports. A converged domain (channel / conversation-message, human identity, mention cc, runtime fanout, host domain, membership cascade) additionally names **no** `repos/*` module at all, and its files stay fenced from driver error dialects (`SQLITE_*`, `SqliteError`, constraint-message parsing). Since #task:1983 this also carries the complement of the singleton claims: `src/index.ts` is fenced from `repos/*` and `adapters/*` and is off the concrete-import allowlist, which is what keeps the lifetime owner from also composing persistence out of the handle it holds.                                                                                                                                                                                                                                                                                                          |
| `composition-handle.test.ts`   | (#task:1983 W5/W6, replacing #1982's reader ledger) The context carries **no handle**, in two independently checkable halves: **availability** — `BackendContext` declares no `db` member, asserted against `src/context.ts` itself, which catches a re-added driver-free `db: unknown` that Gate 1 would not see; and **zero readers** — a tree-wide scan finds none, and a `.db` read whose base type the scan cannot decide is a **failure too** (an undecidable annotation is how an alias bypass would ride through). The old `CONTEXT_DB_READER_INVENTORY` is deleted, not emptied. Also fences the test seam: no production file imports anything under `tests/`, and `onDatabaseOpened` is boot-declared and boot-invoked only (a production caller _supplying_ the hook would take the handle through the test door while naming no driver type and issuing no SQL). Detection covers direct property access, element access, destructuring on either side, contexts held as a member or class field, local/type aliases, `interface extends`, `class implements`, type-parameter constraints, re-exported renames, and `require` / dynamic-import-introduced context types.                                                          |
| `private-port.test.ts`         | (#task:1983 W6) `authorizationReads` — a port private to **one** consumer. Every access predicate in the process reads its facts in `src/permissions.ts` and nowhere else; `context.ts` and `persistence/root.ts` declare it, boot forwards it once into the context literal. Uses are matched **by name, receiver-independent**, because the port hangs off both the context and the persistence bag that every route receives — fencing only `ctx.authorizationReads` would leave `persistence.authorizationReads` as an equally effective bypass naming no context at all. A `read` in a non-`consumer` zone fails on the zone rule, not merely on the count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `driver-dialect.test.ts`       | (#task:1982, narrowed by #1983 W4/W6/W8) Decoding SQLite dialect — `SQLITE_*` codes, the driver's `... constraint failed: ...` message shape, schema trigger text — is confined to an **exact file set** (`DIALECT_DECODING_INVENTORY`). Three zones, each bound to its surface: `schema`, which _defines_ the text; `error-translation`, the two dedicated modules whose whole job is turning a driver rejection into a domain outcome (a named file pair, **not** a `repos/` directory permission); and `adapter-internal`, a SQLite repository translating a constraint it owns — checked against the SQL-sink ledger, so a file that queries nothing cannot claim it. The `adapter` and `debt` zones were **deleted from the type**: the readiness probe and the statement chokepoint stopped matching codes themselves and ask `db-errors.ts` instead, so "turns a failure into a metric label" is no longer a dialect-holding job. No directory waivers. The trigger-message authority is **harvested** from the schema modules' `RAISE(ABORT, '...')` literals, so a message the schema adds tomorrow is fenced without anyone listing it; trigger matching is on a run of five consecutive words, so quoting a fragment is caught too. |

UnitOfWork transaction points (`atomically(tx => ...)`, the application-facing
atomic boundary from #task:1978) enter the same transaction ledger as
`db.transaction` sites (mode `uow`) with the same callback hygiene rules, so
converging services onto the UoW contract never blinds the ledger.

Sink recognition is alias-insensitive where an import edge exists:
`prepareObserved` is recognized by its **imported** name (aliased and
namespace forms included), and effect calls inside transactions match the
imported name, so `import { publishX as emit }` cannot dodge the pattern.
`.exec(...)` is a SQL sink unless the receiver is a **direct regex literal**
— the one receiver provable without real binding resolution. SQL-verb
allowlists (miss `REPLACE`/`END`/`VALUES`) and file-level "regex const" sets
(shadowable by an inner binding) were both bypassed by review probes and are
deliberately not used; the accepted cost is that non-DB receivers like
`cp.exec(...)` enter the ledgers explicitly. Unresolvable arguments are
recorded loudly in the dynamic ledger.

SQL corpus rules: hazard patterns run over every string/template literal of
the SQL scope, attributed to the **definition** site (so consts, helper
parameters and cross-file exports are counted exactly once); `.pragma()` API
calls synthesize a PRAGMA occurrence; sink arguments that do not resolve to a
literal/template/static const are **never skipped silently** — they live in
`DYNAMIC_SQL_INVENTORY` keyed by file + function + sink + expression kind +
count, each with a reason saying where its literals are harvested.

Every gate in this directory carries **fence self-tests**: probes asserting that
each detection form fires and that named non-targets stay silent. Two of them go
further and prove the _division of labour_ rather than asserting it — a
structurally forged context and a handle forwarded across files are both shown to
be invisible to the availability side and caught by the usage side, at the seam,
instead of in a postmortem. Each gate added by #task:1983 was additionally
verified to redden under an injected violation before it was committed.

## What these gates deliberately do NOT prove

- **No PostgreSQL compatibility proof.** The ledgers pin where SQLite-specific
  behavior lives; they cannot show the SQL means the same thing elsewhere.
  Migration correctness is proven only when a PostgreSQL adapter exists and
  the same repository/use-case contract suites run against both engines.
- **Static, single-file analysis.** The effect scan sees calls made directly
  in a transaction callback's own scope, matching property names and imported
  names (alias-insensitive across import edges). Two things it does NOT see,
  by design: an effect hidden one helper deeper, and a **purely local
  rebinding** (`const send = obj.publish.bind(obj)`, destructured aliases) —
  those carry no import edge and are outside the guarantee. Both residuals
  are review concerns, not proven properties.
- **No expression-identity locking.** Swapping one unresolvable SQL expression
  for another of the same AST kind inside the same function keeps the dynamic
  ledger equal. The replacement's literals are still hazard-counted at their
  definitions, so the SQL content itself does not escape.
- **Shrink-only is a review contract**, mechanically assisted: the gate forces
  every change through a visible `inventory.ts` diff; direction is enforced by
  the reviewer reading that diff.
- **The context gate narrows reachability, not usage.** Gate 6 is single-file
  syntax plus corpus-wide type-name relations: it decides a `.db` read from the
  base's _annotation_ (and every aliasing relation into it), so a value that
  receives a context purely by inference is invisible to it. The load-bearing
  gate against "some file issues SQL" is the **usage** side — `scanSqlSinks`
  matches `prepare` / `exec` / `pragma` by property name regardless of where the
  receiver came from, and `sql-hazards.test.ts` freezes the per-file counts.
- **`close()` narrowing is local.** Gate 2b-B traces bindings back to
  `openDatabase()` or a driver type annotation _within one file_, following local
  alias chains. A handle handed to a function in **another** file, or reached
  through `as unknown as`, is outside its reach — what keeps that file honest is
  Gate 1 (it may not name the driver type) and Gate 5 (it may not be a repo).
  The gate's own self-test pins this limit so the statement cannot go stale.
- **Name-matched ports pay for their strength.** Gate 8 and Gate 2b-A match
  member names on any receiver. That is what closes the persistence-bag bypass,
  and it means an unrelated member that happens to be called
  `authorizationReads`, `backup` or `serialize` must be renamed or appear in the
  ledger. Accepted deliberately: for names that are supposed to be private or
  absent, that is the right direction of pressure.
- **Dialect decoding is caught at literals, not at intent.** Gate 7 inspects
  string / template / regex literals only: a comment quoting the driver's
  message is documentation, not decoding, and a message reassembled from
  fragments at runtime is outside the guarantee.
- **Owner surfaces are path-shaped, and a legitimate new persistence module
  still needs an edit.** The zone contract says _where_ a capability may live,
  not that the file uses it well: a repository under `src/repos/` is trusted to
  hold statements, and what keeps it honest is the per-file hazard, sink and
  transaction ledgers. Two named consequences: a genuinely new persistence
  directory cannot be added without an explicit `zones.ts` edit (that is the
  point — it reads as a boundary change, but it _is_ friction), and a consumer
  layer that wants persisted state must go through a repository rather than
  argue about a label. The one thing a `zones.ts` edit cannot do is re-admit a
  consumer layer, because the surfaces are asserted disjoint from it.

## The PostgreSQL seam: what exists, what is missing

What the capability wall buys is **not** engine independence — it is the
precondition for it. Today:

- Call sites no longer name concretes. Application and service code depends on
  ports; `createApiRouter` receives an assembled persistence bag instead of
  reaching for a handle. One file turns a connection into ports.
- The engine's _powers_ are enumerated and assigned. Adding a second engine
  cannot silently inherit "and also whatever else the driver could do", because
  the catalogue pin forces every driver method to have a fenced answer.
- Dialect has two named authorities (`db-errors.ts` for result codes; the schema
  plus its two translation modules for constraint/trigger text), so the set of
  places a second engine's error shapes would have to be taught is finite and
  listed.

What still has to happen first, stated so nobody reads more into these gates
than they earn:

- `BackendRepos` **names concrete SQLite classes**, and `hostTokens` is a
  concrete bundle. A PostgreSQL adapter needs those turned into ports — the
  domain-by-domain work #task:1978 → #1990 has been doing — before
  `composePersistence` is an engine seam rather than a composition root.
- `conversation-repo` / `message-repo` are deliberately **not** on Gate 5's
  concrete-importer allowlist, so application-side statements about them are
  the only ones available; that is a review boundary, not a mechanical one.
- Semantics are pinned, not proven portable. The first real proof point is the
  same repository/use-case contract suites running green against both engines.

## Working with a red gate

- New code wants `db.prepare(...)` outside adapter/repos → put the query in a
  repository (or `read-model/`), not in the service; the ledger stays clean.
- New SQLite construct (e.g. a trigger in a migration) → ledger edit with
  justification **plus a semantic test** pinning the behavior you rely on.
- Effect inside a transaction → move it after commit via the post-commit
  idiom. If the flagged call is genuinely a pure DB write with an effect-like
  name, add a per-site exemption with the symbol-level truth in its reason.
- New test needs data → extend `tests/utils/test-context.ts` with a semantic
  builder (repository-contract based; impossible states get purpose-named
  `force*` seams). Native SQL in the test file itself will stay red.
- New code wants a raw handle → it cannot have one, and there is no row to add:
  take the repo or persistence port the file actually needs in its own deps (the
  membership-cascade pattern: the capability is handed to one factory, not to
  every route). If the wiring genuinely belongs in composition, fold it into
  `persistence/root.ts` — a second handle-spending file would be two
  authorities over the same connection.
- A **test** needs the running server's handle → `startTestBackend` +
  `TestBackendContext` from `tests/utils/`. Do not open a second connection to a
  database the server under test is using.
- New code wants one of the eight absent driver capabilities → it belongs behind
  a named persistence port with its own contract test, decided in review. The
  gate is a hard zero on purpose: extension loading, user-defined
  functions/aggregates/virtual tables, whole-database serialize/backup,
  `unsafeMode` and `defaultSafeIntegers` are engine-level powers no port can
  express, and `defaultSafeIntegers` in particular would silently change the
  type of every integer the app reads.
- New code wants an authorization fact → add the predicate to
  `src/permissions.ts`, which is where the whole access surface is auditable.
  Reading `authorizationReads` from a second file makes that surface two files
  and nobody can see it happened.
- New code wants to branch on a driver error → translate it at the persistence
  boundary into a domain outcome (`repos/sqlite-user-conflicts.ts` is the
  reference: driver text in, `name` / `email` / `user_id` out; anything
  unrecognized passes through) and let the caller decide on that outcome.

Proof point for the test scope: `tests/services/membership-service.test.ts`
runs entirely on the context (order pinning, DTO shape, empty case, orphan
robustness — zero native statements in the file).

# DB Boundary: converging SQLite effects into a replaceable seam

Status: active contract. Gates live in `packages/backend/tests/db-boundary/`
and run with the normal backend test suite (`./scripts/test.sh --scope backend`).

## Goal

Stop new SQLite migration debt from growing and converge touched areas toward
a boundary a future PostgreSQL adapter can slot into. This is **debt control
and semantics locking, not migration proof**: no second driver, no ORM, no
second schema, no dual writes.

The boundary has four scopes:

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
   *requires* savepoint semantics for its CAS rollback).
3. **External-effect scope** — transaction callbacks stay synchronous and free
   of directly-invoked effects (publish/broadcast/dispatch/notify, fetch,
   timers, fs). Effects follow the post-commit idiom: collect closures inside
   the transaction, drain after it returns (`application/post-commit.ts`), so
   a rollback leaves no phantom side effects.
4. **Test scope** — business behavior is tested through semantic builders and
   repository/service contracts (`tests/utils/test-context.ts`); native SQL in
   tests is either white-box by nature (schema/migration/query-plan/oracle,
   named with reasons) or pinned debt. New test files carry zero native SQL.

## The gates and their ledgers

All ledgers live in `tests/db-boundary/inventory.ts` and share one contract:
gates enforce **exact equality** with the current tree, every entry is keyed
per file (× function / hazard / mode) so debt cannot move between files
silently, and debt-zone entries are **shrink-only** — counts go down, entries
disappear. A failing gate prints the current tree state as copy-pasteable
ledger lines; making it green again is always a conscious, reviewable edit.

| Gate | Enforces |
| --- | --- |
| `import-ratchet.test.ts` | The runtime driver import stays locked to `db.ts` (all packages, desktop included); every file naming `better-sqlite3` (any binding form, type or value) matches the ledger; every debt entry states its deletion direction (typed-required). |
| `sql-hazards.test.ts` | Per-file × per-hazard counts of SQLite-specific constructs (JSON1, PRAGMA, `COLLATE NOCASE`, `INSERT OR ...`, `IS ?`, `BEGIN IMMEDIATE/EXCLUSIVE`, triggers, `RAISE`, date functions, `rowid`, catalog queries, `GLOB`, ...) as **baseline + reviewed expansions**: growth's sanctioned path is a `SQL_HAZARD_EXPANSIONS` entry whose reason and semantic-test path the gate validates (the test file must exist). The gate cannot mechanically distinguish a baseline bump from an expansion — it guarantees a visible `inventory.ts` diff; keeping the baseline shrink-only is the review contract. Also: SQL sink call counts per file, `lastInsertRowid` / `.immediate()` / `.exclusive()` API sites, and the dynamic-SQL ledger. |
| `transaction-boundary.test.ts` | Transaction site ledger (owner-classified), repo-internal reasons present, callback hygiene (sync-only, no direct effect calls, import-alias-insensitive), exemptions keyed per site and auto-staled. |
| `test-native-sql.test.ts` | Per-test-file native statement counts — white-box files are **count-pinned too** (named reasons, no unbounded escape hatch); new files are zero-native. |

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

Proof point for the test scope: `tests/services/membership-service.test.ts`
runs entirely on the context (order pinning, DTO shape, empty case, orphan
robustness — zero native statements in the file).

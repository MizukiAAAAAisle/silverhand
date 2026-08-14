/**
 * DB boundary ledgers — the auditable baseline the gates in this directory
 * compare against (see docs/db-boundary.md).
 *
 * Contract:
 * - The gates enforce EXACT equality with the current tree, so any change —
 *   up or down — is a conscious, reviewable edit of this file.
 * - Direction is shrink-only for every `debt` entry, for
 *   DYNAMIC_SQL_INVENTORY and for TEST_NATIVE_SQL_DEBT: counts go down and
 *   entries disappear. Raising a count or adding a debt entry needs a
 *   reviewed justification; hazard growth additionally needs a semantic test
 *   for the new SQL.
 * - Everything is keyed per file (× function / hazard / mode), never by
 *   totals, so debt cannot be shuffled between files without a visible diff.
 * - A `zone` / `owner` label is NOT self-certifying (#task:1983 W8): every one
 *   is checked against the module surface that owns that responsibility, in
 *   `zones.ts`. A file that is not on the surface cannot buy the capability by
 *   describing itself as a repository.
 */
import type { DialectSignal, HazardFinding, ImportKind, TxMode } from './scan.js';

export type ImportInventoryEntry =
  | { file: string; kinds: ImportKind[]; zone: 'adapter' | 'repository' }
  | {
      file: string;
      kinds: ImportKind[];
      /**
       * #task:1983 W1 — the persistence composition root. Distinct from
       * `adapter`/`repository` (which each own SQL for one concern) and from
       * `debt`: this file's WHOLE JOB is to receive the handle and hand back
       * driver-free ports, so naming the driver type in its signature is the
       * point, not a leak. Kept a separate zone so the gate can assert the
       * cardinality — see the `composition` row's reason.
       */
      zone: 'composition';
      reason: string;
    }
  | {
      file: string;
      kinds: ImportKind[];
      /**
       * #task:1983 W5 — the process's handle-LIFETIME owner. Boot opens the
       * database, migrates it, hands it to `composePersistence` as a parameter,
       * and closes it on shutdown. That role can never shrink away (someone has
       * to own the lifetime), so it is not `debt`; it composes no persistence
       * and owns no SQL, so it is neither `composition` nor `adapter`.
       *
       * The row exists because a `Db` has ALWAYS flowed through boot —
       * `openDatabase()`'s inferred return type never produced an import, so the
       * coupling was real but invisible to this gate. W5's test seam names the
       * type explicitly, which is what makes it auditable. Singleton, asserted.
       */
      zone: 'lifecycle';
      reason: string;
    };
/*
 * There is no `debt` variant (#task:1983 W6). Its last row was `context.ts`'s
 * `db: Db` field typing, deleted by W5 along with the field. Adding a driver
 * import back in a business file is not something to classify and schedule — it
 * is the thing this gate exists to refuse, so the type no longer offers a place
 * to park it.
 */

export const BETTER_SQLITE3_IMPORT_INVENTORY: ImportInventoryEntry[] = [
  {file: 'packages/backend/src/db.ts',kinds: ['type','value'],zone: 'adapter'},
  {file: 'packages/backend/src/observability/observed-statement.ts',kinds: ['type'],zone: 'adapter'},
  {file: 'packages/backend/src/observability/db-write-probe.ts',kinds: ['type'],zone: 'adapter'},
  {file: 'packages/backend/src/index.ts',kinds: ['type'],zone: 'lifecycle',reason: 'BOOT owns the handle lifetime (#task:1983 W5): it opens + migrates the database, passes it to composePersistence as a parameter, and closes it on shutdown. It names the driver type for exactly one signature — the labelled testHooks.onDatabaseOpened seam that replaced BackendContext.db, so an end-to-end test can seed/inspect rows on the SERVER OWN connection instead of opening a second one into a restart / crash-recovery scenario. Deleting this row means boot stopped owning the handle, not that the debt was paid'},
  {file: 'packages/backend/src/adapters/runtime-fanout.ts',kinds: ['type'],zone: 'adapter'},
  {file: 'packages/backend/src/adapters/unread-publish.ts',kinds: ['type'],zone: 'adapter'},
  {file: 'packages/backend/src/persistence/root.ts',kinds: ['type'],zone: 'composition',reason: 'THE persistence composition root (#task:1983 W1): the one function that takes the raw handle and returns only driver-free repos / unit-of-work ports / read models / persistence adapters. Growth INSIDE this file is legal wiring; a second driver-IMPORTING composition file is not, which is what the cardinality assertion in import-ratchet.test.ts refuses — and note that gate is import-based, so the file that keeps BOOT from assembling persistence out of its own handle is the fence in port-contract.test.ts, not this row. It is not yet an engine seam either: BackendRepos still names concrete SQLite classes, so a PostgreSQL adapter needs those turned into ports first'},
  {file: 'packages/backend/src/read-model/index.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/read-model/activity.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/read-model/agent-read.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/read-model/favorites.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/read-model/message-reactions.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-capability-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-provisioning-persistence.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-credentials-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-sessions-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-uow.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/host-credentials-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/host-uow.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-persistence.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/task-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/task-board-read-model.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/task-persistence.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/attachment-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/attention-badge-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/channel-attention-preference-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-event-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-name-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-read-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/host-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/membership-persistence.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/message-author.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/message-reaction-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/message-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/notification-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/observation-persistence.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/saved-message-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/schedule-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/search-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/sort-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/thread-follower-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/user-persistence.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/user-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/workspace-attention-preference-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/workspace-repo.ts',kinds: ['type'],zone: 'repository'},
];

/**
 * Who may CALL a SQL sink (Gate 2). Three legal zones, no `debt` zone: W6
 * removed it because it had held no rows since #1968 and a permanently empty
 * debt zone is not a ledger, it is a standing offer. A file that issues SQL is
 * an adapter, a repository/read-model, or the schema — and W8 made that a
 * question of LOCATION: each zone is legal only on its owner surface
 * (`zones.ts`), so a service cannot issue SQL by labelling itself a repository.
 */
export interface SqlCallerEntry {
  file: string;
  zone: 'adapter' | 'repository' | 'schema';
  /** Exact sink-call count; pinned for schema files. */
  count?: number;
}

export const SQL_CALLER_INVENTORY: SqlCallerEntry[] = [
  {file: 'packages/backend/src/db.ts',zone: 'adapter'},
  {file: 'packages/backend/src/observability/observed-statement.ts',zone: 'adapter'},
  {file: 'packages/backend/src/observability/db-write-probe.ts',zone: 'adapter'},
  // Schema zone, pinned: every sink here belongs to a `precondition` hook (the
  // `up` strings are not sink CALLS). v53 and v64 contribute one `prepare` each;
  // v71 contributes three — `exec` for the TEMP staging table plus a `prepare`
  // for the row scan and one for the insert — because the inbox ids it backfills
  // must come from the SAME `randomBytes` generator the fresh path uses, and a
  // static `up` literal cannot mint them. v72 contributes the same three shapes
  // for the same reason: a conversation NAME is a slug of the title, and SQL
  // cannot slugify, so the names are minted by the production deriver and staged
  // for `up` to join.
  {file: 'packages/shared/src/db/migrations.ts',zone: 'schema',count: 8},
  {file: 'packages/backend/src/repos/task-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/task-board-read-model.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/task-persistence.ts',zone: 'repository'},
  {file: 'packages/backend/src/read-model/activity.ts',zone: 'repository'},
  {file: 'packages/backend/src/read-model/agent-read.ts',zone: 'repository'},
  {file: 'packages/backend/src/read-model/favorites.ts',zone: 'repository'},
  {file: 'packages/backend/src/read-model/message-reactions.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-capability-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-credentials-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-sessions-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/host-credentials-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/attachment-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/attention-badge-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/channel-attention-preference-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-event-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-name-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-read-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/host-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/message-author.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/message-reaction-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/message-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/notification-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/saved-message-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/schedule-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/search-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/sort-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/thread-follower-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/user-persistence.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/user-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/workspace-attention-preference-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/workspace-repo.ts',zone: 'repository'},
];

/**
 * Historical baseline, shrink-only BY REVIEW CONTRACT: counts here should
 * only decrease (delete/decrement when SQLite-specific SQL is removed).
 * Growth belongs in SQL_HAZARD_EXPANSIONS below, where the gate validates a
 * reason and an existing semantic test. The gate itself cannot tell a
 * baseline edit from an expansion — it guarantees every change is a visible
 * diff of this file; rejecting baseline growth is the reviewer's job.
 */
export const SQL_HAZARD_INVENTORY: HazardFinding[] = [
  {file: 'packages/backend/src/repos/auth-credentials-repo.ts',hazard: 'collate_nocase',count: 1},
  {file: 'packages/backend/src/db.ts',hazard: 'pragma_statement',count: 10},
  {file: 'packages/backend/src/db.ts',hazard: 'sqlite_catalog',count: 2},
  {file: 'packages/backend/src/read-model/activity.ts',hazard: 'json1_function',count: 1},
  {file: 'packages/backend/src/repos/agent-capability-repo.ts',hazard: 'insert_or_action',count: 1},
  {file: 'packages/backend/src/repos/attachment-repo.ts',hazard: 'json1_function',count: 13},
  {file: 'packages/backend/src/repos/channel-attention-preference-repo.ts',hazard: 'insert_or_action',count: 1},
  {file: 'packages/backend/src/repos/conversation-read-repo.ts',hazard: 'is_parameter',count: 5},
  {file: 'packages/backend/src/repos/conversation-repo.ts',hazard: 'insert_or_action',count: 2},
  {file: 'packages/backend/src/repos/message-author.ts',hazard: 'json1_function',count: 2},
  {file: 'packages/backend/src/repos/message-repo.ts',hazard: 'is_parameter',count: 5},
  {file: 'packages/backend/src/repos/message-repo.ts',hazard: 'json1_function',count: 1},
  {file: 'packages/backend/src/repos/notification-repo.ts',hazard: 'is_parameter',count: 1},
  {file: 'packages/backend/src/repos/saved-message-repo.ts',hazard: 'insert_or_action',count: 1},
  {file: 'packages/backend/src/repos/user-repo.ts',hazard: 'collate_nocase',count: 1},
  {file: 'packages/backend/src/repos/workspace-repo.ts',hazard: 'collate_nocase',count: 1},
  {file: 'packages/backend/src/repos/workspace-repo.ts',hazard: 'insert_or_action',count: 2},
  {file: 'packages/backend/src/repos/workspace-repo.ts',hazard: 'json1_function',count: 2},
  {file: 'packages/shared/src/db/baseline-schema.ts',hazard: 'collate_nocase',count: 1},
  {file: 'packages/shared/src/db/baseline-schema.ts',hazard: 'create_trigger',count: 16},
  {file: 'packages/shared/src/db/baseline-schema.ts',hazard: 'json1_function',count: 1},
  {file: 'packages/shared/src/db/baseline-schema.ts',hazard: 'raise_function',count: 33},
  {file: 'packages/shared/src/db/migrations.ts',hazard: 'create_trigger',count: 10},
  {file: 'packages/shared/src/db/migrations.ts',hazard: 'json1_function',count: 6},
  {file: 'packages/shared/src/db/migrations.ts',hazard: 'raise_function',count: 14},
];

export interface HazardExpansion {
  file: string;
  hazard: string;
  /** How many occurrences this reviewed expansion adds on top of the baseline. */
  added: number;
  reason: string;
  /** Repo-relative path of the semantic test pinning the new SQL's behavior; the gate checks it exists. */
  semanticTest: string;
}

/**
 * Reviewed hazard growth. The gate expects actual = baseline + Σ added per
 * (file × hazard); every entry must name a reason and an existing semantic
 * test, so "just bump the count" cannot go green.
 */
export const SQL_HAZARD_EXPANSIONS: HazardExpansion[] = [
  {file: 'packages/backend/src/observability/db-write-probe.ts',hazard: 'begin_immediate_exclusive',added: 1,reason: '#task:1982 W4 relocation, not new capability: the readiness write probe moved out of routes.ts (whose baseline row is deleted in the same diff) so the HTTP layer stops holding transaction-control SQL. BEGIN IMMEDIATE is load-bearing — the probe must fail AT BEGIN when another writer holds the lock, which a deferred BEGIN does not do',semanticTest: 'packages/backend/tests/observability/db-write-probe.test.ts'},
  {file: 'packages/shared/src/db/migrations.ts',hazard: 'create_trigger',added: 4,reason: '#task:2016 (v72 conversation_names): the four triggers ARE the model. A conversation name is an allocation that may never be reused, and PRIMARY KEY(workspace_id, name) only refuses a conflicting INSERT — rewriting a coordinate, deleting a row or resetting retired_at to NULL each release an allocated name. The birth guard is also the only structural check left after the FK was dropped (a retired allocation must outlive its conversation), and it is what refuses an inbox target and a cross-workspace one. The fourth (born-current, added in @Cindy\'s review) closes the one door the others do not watch: an INSERT that arrives already retired is invisible to the partial UNIQUE (current rows only) and to the immutability trigger (UPDATE only), and it permanently occupies a name that was never held. Application code cannot hold these: the point is that no future repo can release a name',semanticTest: 'packages/backend/tests/conversation-names-migration.test.ts'},
  {file: 'packages/shared/src/db/migrations.ts',hazard: 'raise_function',added: 4,reason: '#task:2016 (v72 conversation_names): one RAISE(ABORT) per trigger above — the guards fail LOUD rather than silently ignoring an illegal write, and each message names which invariant refused (born valid / born current / immutable / permanent) so a caller can tell them apart',semanticTest: 'packages/backend/tests/conversation-names-migration.test.ts'},
  {file: 'packages/shared/src/db/migrations.ts',hazard: 'create_trigger',added: 6,reason: '#task:2017 (v73 direct_pair endpoints): an endpoint is a HISTORICAL principal coordinate with no FK, so the four guards express what no FK and no CHECK can. Birth existence is a CONDITIONAL reference — the sibling endpoint_*_kind column decides which principal table must contain the id — and the other three keep the coordinate meaningful for as long as the transcript lives: born alive (a row may not arrive pre-tombstoned), immutable (rewriting a coordinate would retroactively re-attribute a DM), and stamp-once (a tombstone may not be unwritten or moved). The remaining two are the writers of that stamp, one per principal table: BEFORE DELETE on agents / users, because the deletion of a principal is the only moment the fact exists and the app clock is not reachable on a cascade path. The stamp is deliberately NOT load-bearing — the ACL ORs it with a lookup — so these two triggers are an optimization the schema owns, not a rule it depends on',semanticTest: 'packages/backend/tests/direct-pair-endpoint-migration.test.ts'},
  {file: 'packages/shared/src/db/migrations.ts',hazard: 'raise_function',added: 4,reason: '#task:2017 (v73 direct_pair endpoints): one RAISE(ABORT) per GUARD trigger (birth existence / born alive / immutable / stamp-once); the two stamping triggers carry none because they refuse nothing. Each message names the invariant that refused, which is what lets the migration suite tell the guard apart from the arc CHECK that covers the same shape from the other side',semanticTest: 'packages/backend/tests/direct-pair-endpoint-migration.test.ts'},
  {file: 'packages/shared/src/db/migrations.ts',hazard: 'sqlite_datetime_function',added: 4,reason: '#task:2017 (v73 direct_pair endpoints): the FIRST DB clock in the schema zone, and it is scoped to exactly one fact — CAST(unixepoch(\'subsec\') * 1000 AS INTEGER) in the four UPDATEs of the two stamping triggers (two endpoint sides x two principal tables), matching the app-side Date.now() milliseconds the rest of the schema stores. Justified by reachability: the stamp is written from inside a DELETE that may arrive through a cascade, where no application code runs and there is no request clock to thread through. It is safe to write because nothing depends on its VALUE — the stamp records WHEN a principal went away, while the ACL derives WHETHER by lookup, so clock skew between the DB and the app cannot change an authorization answer',semanticTest: 'packages/backend/tests/direct-pair-endpoint-migration.test.ts'},
];

export interface DynamicSqlEntry {
  file: string;
  fn: string;
  sink: string;
  /** AST kind of the unresolvable argument — narrows same-function swaps. */
  exprKind: string;
  count: number;
  reason: string;
}

export const DYNAMIC_SQL_INVENTORY: DynamicSqlEntry[] = [
  {file: 'packages/backend/src/db.ts',fn: 'applySingleMigration',sink: 'exec',exprKind: 'PropertyAccessExpression',count: 1,reason: 'm.up comes from the shared migration array; the SQL literals are harvested at their definition in packages/shared/src/db/migrations.ts'},
  {file: 'packages/backend/src/observability/observed-statement.ts',fn: 'prepareObserved',sink: 'prepare',exprKind: 'Identifier',count: 1,reason: 'the adapter chokepoint forwards caller-provided source; every caller is scanned at its own site'},
  {file: 'packages/backend/src/read-model/agent-read.ts',fn: 'listHistoryAfter',sink: 'prepare',exprKind: 'CallExpression',count: 1,reason: 'SQL assembled by a local query-builder function; the builder literals are harvested at definition'},
  {file: 'packages/backend/src/read-model/agent-read.ts',fn: 'getHistoryRowById',sink: 'prepare',exprKind: 'CallExpression',count: 1,reason: 'SQL assembled by a local query-builder function; the builder literals are harvested at definition'},
  {file: 'packages/backend/src/repos/attention-badge-repo.ts',fn: 'AttentionBadgeRepo.badgeCountsByWorkspace',sink: 'prepareObserved',exprKind: 'CallExpression',count: 1,reason: 'SQL from a local population-query builder; builder literals harvested at definition'},
  {file: 'packages/backend/src/repos/attention-badge-repo.ts',fn: 'AttentionBadgeRepo.badgeCountForWorkspace',sink: 'prepareObserved',exprKind: 'CallExpression',count: 1,reason: 'SQL from a local population-query builder; builder literals harvested at definition'},
  {file: 'packages/backend/src/repos/message-author.ts',fn: 'fetchLiveActors',sink: 'prepareObserved',exprKind: 'Identifier',count: 1,reason: 'shared helper receives LIVE_AGENTS_SQL/LIVE_USERS_SQL as a parameter; both consts are harvested at definition'},
  {file: 'packages/backend/src/repos/message-repo.ts',fn: 'MessageRepo.existsWithSeq',sink: 'prepareObserved',exprKind: 'Identifier',count: 1,reason: 'SQL branches on a comparator parameter; the branch literals are harvested at definition'},
  {file: 'packages/backend/src/repos/task-board-read-model.ts',fn: 'SqliteTaskBoardReadModel.column',sink: 'prepareObserved',exprKind: 'PropertyAccessExpression',count: 1,reason: 'SQL from the taskBoardColumnQuery builder; builder literals harvested at definition'},
  {file: 'packages/backend/src/repos/task-repo.ts',fn: 'SqliteTaskRepo.list',sink: 'prepareObserved',exprKind: 'Identifier',count: 1,reason: 'WHERE clauses assembled from typed filters; clause literals harvested at definition'},
];

export interface ApiHazardEntry {
  file: string;
  fn: string;
  api: string;
}

export const API_HAZARD_INVENTORY: ApiHazardEntry[] = [
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',fn: 'begin',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',fn: 'complete',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',fn: 'atomicallyForAgent',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',fn: 'atomicallyForComputer',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/auth-uow.ts',fn: 'atomically',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/conversation-persistence.ts',fn: 'atomicallyForChannel',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/conversation-persistence.ts',fn: 'atomicallyInWorkspace',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/host-uow.ts',fn: 'atomically',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/membership-persistence.ts',fn: 'atomically',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/membership-persistence.ts',fn: 'atomicallyForWorkspace',api: 'transaction_immediate'},
  {file: 'packages/backend/src/repos/user-persistence.ts',fn: 'atomically',api: 'transaction_immediate'},
  {file: 'packages/backend/src/db.ts',fn: 'applySingleMigration',api: 'transaction_exclusive'},
  {file: 'packages/backend/src/db.ts',fn: 'runMigrations',api: 'transaction_exclusive'},
  {file: 'packages/backend/src/repos/conversation-event-repo.ts',fn: 'ConversationEventRepo.insert',api: 'lastInsertRowid'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.claimPending',api: 'transaction_exclusive'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlight',api: 'transaction_exclusive'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlightAnyOwner',api: 'transaction_exclusive'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlightForAgent',api: 'transaction_exclusive'},
];

export interface TxInventoryEntry {
  file: string;
  fn: string;
  mode: TxMode;
  count: number;
  /**
   * `route-debt` is deliberately ABSENT: #task:1982 W4/W5 took the last
   * route-layer transaction (readiness probe → observability adapter, hosts
   * finalize and the membership cascade → use cases with a UnitOfWork). A route
   * opening a transaction again cannot be reclassified back into the ledger —
   * it has to move into a use case.
   *
   * And since W8 the label is not a way in either: `owner` is checked against
   * the layer it names, and a NATIVE mode (anything but `uow`) is refused
   * outside the persistence surface whatever the owner says. Deleting
   * `route-debt` restricted a word; the joint (mode, owner, surface) rule in
   * `zones.ts` restricts the location.
   */
  owner: 'use-case' | 'service' | 'auth' | 'repo-internal' | 'infra';
  /** repo-internal entries MUST explain outer atomicity ownership. */
  reason?: string;
}

export const TX_INVENTORY: TxInventoryEntry[] = [
  {file: 'packages/backend/src/auth/host-token.ts',fn: 'HostTokenService.completePreparedHostTokenRotation',mode: 'uow',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/auth/host-token.ts',fn: 'HostTokenService.issueHostToken',mode: 'uow',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/auth/host-token.ts',fn: 'HostTokenService.rotateHostTokenImmediate',mode: 'uow',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/auth/user-auth-service.ts',fn: 'UserAuthService.resetPassword',mode: 'uow',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/auth/user-auth-service.ts',fn: 'UserAuthService.signup',mode: 'uow',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/db.ts',fn: 'applySingleMigration',mode: 'exclusive',count: 1,owner: 'infra',reason: 'migration application requires exclusive lock escalation by design'},
  {file: 'packages/backend/src/repos/auth-uow.ts',fn: 'atomically',mode: 'default',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: the persistence half of the application atomically() contract (deferred policy)'},
  {file: 'packages/backend/src/repos/auth-uow.ts',fn: 'atomically',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: immediate policy for the offline admin composition (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/repos/host-uow.ts',fn: 'atomically',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: the host domain takes the write lock at BEGIN because BOTH its flows decide from an authoritative read that PRECEDES their writes (credential eligibility, setup/finalize facts) — a deferred BEGIN would lock only at the first write, after the fact it protects (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/db.ts',fn: 'runMigrations',mode: 'exclusive',count: 1,owner: 'infra',reason: 'no-op migration phase takes an exclusive lock probe so concurrent boots fail fast'},
  {file: 'packages/backend/src/repos/agent-capability-repo.ts',fn: 'AgentCapabilityRepo.replaceSet',mode: 'default',count: 1,owner: 'repo-internal',reason: 'delete+reinsert of one capability set is a self-contained invariant; no caller composes it with other writes, savepoint under an outer tx is acceptable'},
  {file: 'packages/backend/src/repos/agent-provisioning-persistence.ts',fn: 'atomically',mode: 'default',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: the persistence half of AgentProvisioningUnitOfWork (deferred policy — atomicity only; the pending-only conditional transition inside the scope IS the single-winner gate, so no isolation claim and no write lock)'},
  {file: 'packages/backend/src/repos/agent-provisioning-persistence.ts',fn: 'reserveAgentAggregate',mode: 'default',count: 1,owner: 'repo-internal',reason: 'v71 §4.2 aggregate factory: an Agent IS the `agents` row PLUS its inbox placement, so the pair is one invariant of these rows and a half-committed aggregate must be unreachable (a reserved row without an inbox would abort a human send that mentions the handle). It cannot move to the calling use case: L1 reserve is deliberately OUTSIDE the L3a UnitOfWork because its commit is the durability boundary the L2 materialize dispatch depends on, and the inbox must not be re-inserted on `?retry=true`'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',fn: 'begin',mode: 'immediate',count: 1,owner: 'infra',reason: 'Deletion lifecycle persistence: BEGIN IMMEDIATE serializes the conditional active/unmarked gate with computer teardown and runtime-transition admission before publishing the durable deletion intent'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',fn: 'complete',mode: 'immediate',count: 1,owner: 'infra',reason: 'Deletion lifecycle persistence: BEGIN IMMEDIATE revalidates the CAS-keyed host/timestamp attempt and captures the post-purge teardown facts in the same commit that deletes the agent row'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',fn: 'atomicallyForAgent',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation, agent-keyed axis: the teardown takes the write lock at BEGIN because it re-reads delete eligibility (materialization_status) INSIDE the scope and the whole sequence is decided from it — a deferred BEGIN would lock only at the DELETE, after the read it protects (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/repos/agent-teardown-persistence.ts',fn: 'atomicallyForComputer',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation, second coordination axis: the computer cascade tears down EVERY agent placed on one host in one commit, so it coordinates on the computer and its per-agent faces are bound to that key (an agent on another computer aborts the whole scope) — same BEGIN IMMEDIATE, which is file-wide here and therefore already excludes the agent-keyed axis (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.claimPending',mode: 'exclusive',count: 1,owner: 'repo-internal',reason: 'inbox delivery state machine owns claim atomicity; exclusive mode arbitrates cross-connection delivery contention — no outer service tx exists on this path'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.markDelivered',mode: 'stored',count: 1,owner: 'repo-internal',reason: 'delivery cursor + in-flight clear must move together; owned by the inbox state machine'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlight',mode: 'stored',count: 1,owner: 'repo-internal',reason: 'in-flight rollback is inbox-internal recovery; no outer owner'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlightAnyOwner',mode: 'stored',count: 1,owner: 'repo-internal',reason: 'in-flight rollback is inbox-internal recovery; no outer owner'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlightForAgent',mode: 'exclusive',count: 1,owner: 'repo-internal',reason: 'in-flight rollback under cross-connection contention; exclusive by design'},
  {file: 'packages/backend/src/repos/message-repo.ts',fn: 'MessageRepo.insertForConversation',mode: 'default',count: 1,owner: 'repo-internal',reason: 'seq allocation + stream-head bump is one invariant owned here; DESIGNED to run as a savepoint under service txs (conversation-message-service, task broadcaster, channel-service)'},
  {file: 'packages/backend/src/repos/message-repo.ts',fn: 'MessageRepo.insertForConversationIfFresh',mode: 'default',count: 1,owner: 'repo-internal',reason: 'freshness CAS throws StreamCasMiss to roll back the seq allocation — REQUIRES savepoint semantics; do not flatten into the outer tx'},
  {file: 'packages/backend/src/repos/sort-repo.ts',fn: 'SortRepo.reorder',mode: 'stored',count: 1,owner: 'repo-internal',reason: 'multi-row rank rewrite is one self-contained invariant; no outer owner'},
  {file: 'packages/backend/src/repos/workspace-repo.ts',fn: 'WorkspaceRepo.setOwnerUserId',mode: 'default',count: 1,owner: 'repo-internal',reason: 'owner column and owner-role membership row must flip together; callers do not compose it with other writes'},
  {file: 'packages/backend/src/runtime/outbound-event-fanout.ts',fn: 'OutboundRuntimeEventFanout.clearSession',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/adapters/runtime-fanout.ts',fn: 'atomically',mode: 'default',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: the persistence half of RuntimeSessionUnitOfWork (deferred policy — atomicity only, no isolation claim)'},
  {file: 'packages/backend/src/services/channel-service.ts',fn: 'ChannelService.createAgentHomeDmChannel',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/channel-service.ts',fn: 'ChannelService.createChannel',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/channel-service.ts',fn: 'ChannelService.renameChannel',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/channel-service.ts',fn: 'ChannelService.setChannelName',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/conversation-message-service.ts',fn: 'ConversationMessageService.materializeAndDispatchThreadWindow',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/conversation-message-service.ts',fn: 'ConversationMessageService.sendMessage',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/conversation-message/thread-follow.ts',fn: 'ThreadFollowManager.followThread',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.applyTaskEdit',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.claimTaskAgent',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.claimTaskUser',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.createTasks',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.unclaimTaskAgent',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.unclaimTaskUser',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.updateStatusAgent',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.updateStatusUser',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/repos/task-persistence.ts',fn: 'atomically',mode: 'default',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: the persistence half of the task atomically() contract (deferred only)'},
  {file: 'packages/backend/src/repos/conversation-repo.ts',fn: 'ConversationRepo.delete',mode: 'default',count: 1,owner: 'infra',reason: '#task:2016 — repo-internal BECAUSE the invariant is the aggregate\u2019s, not any caller\u2019s: conversation_names.conversation_id carries no FK (a retired allocation must outlive the row it points at), so deleting the row without retiring its current name leaks an address no operation can ever free. There is no owning use case to host it \u2014 no production path deletes a single conversation today (workspace deletion frees the namespace by CASCADE on workspace_id), and a future delete owner must inherit the pair rather than re-derive it. Deferred: two statements on one row set, no read-then-write gate, so it states atomicity only'},
  {file: 'packages/backend/src/repos/conversation-persistence.ts',fn: 'atomicallyForChannel',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation, conversation-keyed axis: the channel domain takes the write lock at BEGIN because getChannelLikeForUpdate states an isolation obligation its callback depends on, and the entry-point KEY is what its scope faces address (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/repos/conversation-persistence.ts',fn: 'atomically',mode: 'default',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: lock-window policy for the conversation-message domain — deferred so the thread-window reads are not held under the write lock. NOT a race-free claim: only the stream-head race is closed by a mechanism (insertForConversationIfFresh CAS); the other pre-write reads carry no declared cross-connection isolation obligation'},
  {file: 'packages/backend/src/repos/conversation-persistence.ts',fn: 'atomicallyInWorkspace',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation, second coordination axis: channel creation writes the channel row plus one membership row per founding member plus the seed messages, all belonging to ONE workspace, so it coordinates on the workspace and its scope faces are bound to that key — same BEGIN IMMEDIATE as the conversation-keyed axis, which is file-wide here and therefore already excludes it (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/services/user-service.ts',fn: 'UserService.register',mode: 'uow',count: 1,owner: 'service'},
  {file: 'packages/backend/src/repos/membership-persistence.ts',fn: 'atomically',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: the write lock is taken at BEGIN because the UoW itself reads the coordination anchor before the callback, and the whole cascade is decided from it — SQLite has no row lock to offer, and the anchor row may not even exist (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/repos/membership-persistence.ts',fn: 'atomicallyForWorkspace',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation, second coordination axis: the roster scope writes membership rows for MORE THAN ONE subject in one commit, so it coordinates on the workspace and reads no anchor — same BEGIN IMMEDIATE, which is file-wide here and therefore already excludes the per-member axis (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/repos/user-persistence.ts',fn: 'atomically',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: the registration domain takes the write lock at BEGIN because the single-viewer gate is a read-then-write invariant over an EMPTY set — no locking read can serialize it (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/application/add-workspace-agent-member.ts',fn: 'addWorkspaceAgentMember',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/add-workspace-human-member.ts',fn: 'addWorkspaceHumanMember',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'addConversationMember',mode: 'uow',count: 2,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'joinPublicChannel',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'leaveChannel',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'removeConversationHumanMember',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'removeConversationMember',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/create-agent.ts',fn: 'insertProvisioningDependents',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/create-workspace.ts',fn: 'createWorkspace',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/delete-agent.ts',fn: 'commitAgentTeardown',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/delete-computer.ts',fn: 'deleteComputer',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/observe.ts',fn: 'observe',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/repos/observation-persistence.ts',fn: 'atomicallyForViewer',mode: 'default',count: 1,owner: 'infra',reason: 'UnitOfWork implementation, viewer-keyed axis: the observation batch takes NO write lock at BEGIN. A pre-write read does exist (the cursor face reads the current cursor) but no invariant rests on it — the cursor upsert is monotone (max(existing,new)) so a stale read costs at most a redundant upsert or a stale changed-boolean, and both clears are conditional on the row still being unread and report only what they themselves flipped, so a concurrent observer can neither be clobbered nor have its dismissal stolen; a read-only re-observe then never touches the write lock at all. Nesting is not refused: a deferred scope degrading to a savepoint loses no claim this port makes'},
  {file: 'packages/backend/src/application/create-host-invite.ts',fn: 'createHostInvite',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/remove-workspace-member.ts',fn: 'purgeDanglingWorkspaceAgentMembership',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/remove-workspace-member.ts',fn: 'removeWorkspaceMember',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/revoke-host.ts',fn: 'revokeHost',mode: 'uow',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/update-host.ts',fn: 'updateHost',mode: 'uow',count: 1,owner: 'use-case'},
];

export interface TxEffectExemption {
  file: string;
  fn: string;
  violation: string;
  reason: string;
}

export const TX_CALLBACK_EXEMPTIONS: TxEffectExemption[] = [
  {
    file: 'packages/backend/src/services/task-service.ts',
    fn: 'TaskService.claimTaskUser',
    violation: 'effect call .dispatchToAgent() inside transaction callback',
    reason:
      'SqliteTaskRepo.dispatchToAgent is a pure UPDATE (assignee handoff + todo→in_progress), not an external effect; rename candidate when the task domain is next touched',
  },
];

export interface WhiteboxTestEntry {
  file: string;
  /** Pinned exact native-statement count — whitebox is NOT an unbounded escape hatch. */
  count: number;
  reason: string;
}

export const TEST_WHITEBOX_INVENTORY: WhiteboxTestEntry[] = [
  {file: 'packages/backend/tests/db-migrations.test.ts',count: 191,reason: 'migration semantics are the test subject; native DDL/DML is the point'},
  {file: 'packages/backend/tests/migration-baseline.test.ts',count: 1,reason: 'baseline drift guard reads schema catalog directly'},
  {file: 'packages/backend/tests/migration-baseline-gen.test.ts',count: 14,reason: 'baseline generator diffs live schema against the frozen snapshot'},
  {file: 'packages/backend/tests/conversation-visibility-migration.test.ts',count: 19,reason: 'exercises one historical migration against hand-built legacy rows'},
  {file: 'packages/backend/tests/conversation-placement-migration.test.ts',count: 43,reason: 'exercises the v69 conversations table rebuild: hand-built v68 rows carried across, schema catalog + PRAGMA table_xinfo reads that prove the generated column and every index survived, EXPLAIN over the generated column, and DDL-level write gates (parse-time refusal, CHECK fail-closed) that no repository API can express'},
  {file: 'packages/backend/tests/agent-inbox-migration.test.ts',count: 49,reason: 'exercises the v71 conversations rebuild (#task:2014): the fixture is a hand-built v69 database, so it CANNOT go through repositories — today\'s repos write today\'s columns. The assertions are raw for the same reason the v69 file\'s are: a full-row differential proving no legacy `Mentions` row was converted (a repo read would project it into a DTO and hide the columns under test), the exhaustive placement-arc CHECK probes, the partial-UNIQUE conflict on cc_source_message_id, and PRAGMA foreign_key_check / cascade reads that must see orphans a joined repo read would report as absent. Two of the calls resolve the backfilled inbox ids by owner: since the ids are minted by the production generator inside the migration\'s `precondition`, no literal can name them and the id-domain assertion has to read them back'},
  {file: 'packages/backend/tests/tasks-aggregate-migration.test.ts',count: 15,reason: 'exercises one historical migration against hand-built legacy rows'},
  {file: 'packages/backend/tests/conversation-names-migration.test.ts',count: 42,reason: 'exercises v72 conversation_names (#task:2016), and the SQL is the subject twice over. The fixture is a hand-built v71 database (no repo writes v71-shaped rows once v72 exists), and the invariants under test are DDL-level guards no repository API can express: the claim is that the DATABASE refuses to release an allocated name, so every illegal write — coordinate UPDATE, resurrection, plain DELETE, reused retired name, second current name, an allocation born already retired — is executed as a direct statement. Routing them through a repo would prove only that today\'s repo does not write them, which is precisely what the triggers exist to stop mattering. Two guards are additionally shown to be load-bearing rather than decorative: the born-current trigger is DROPped and the same INSERTs then land phantom retired rows the permanence trigger cannot remove, and the name CHECK is probed with a parameterized savepoint battery (an inadmissible name refused as direct SQL, plus an equivalence corpus asserting the GLOB transcription classifies exactly what ConversationNameSchema does) — a domain claim that only exists below the writer. The backfill assertions are raw for the same reason the v69/v71 files\' are: a full-row differential proving no pre-existing conversations row changed, and a totality query that the schema deliberately cannot state'},
  {file: 'packages/backend/tests/direct-pair-endpoint-migration.test.ts',count: 44,reason: 'exercises v73 direct_pair endpoints (#task:2017) against a hand-built v72 database, and every raw call is load-bearing: no repository writes a direct_pair row at all (get-or-create is P3), and the claims under test live only below the writer. Birth validity is proved INDEPENDENT — the existence trigger is DROPped and the arc/domain CHECKs are shown to refuse the same shapes on their own — immutability is probed per endpoint column, the tombstone is probed for monotonicity, and the stamp is shown to be written BY THE DELETE per side and per principal table. Two falsifiers need statements no API has: dropping the stamping trigger (the delete still succeeds and the endpoint is still gone by lookup, proving the tombstone is not load-bearing) and a synthetic parent/child/log triple probing the ENGINE claim that a BEFORE DELETE trigger fires under ON DELETE CASCADE. The rebuild assertions are raw for the same reason the v69/v71/v72 files\' are: a full-row differential over the carried rows and PRAGMA table_xinfo / sqlite_master reads proving the generated column and all four indexes survived byte-identically'},
  {file: 'packages/backend/tests/direct-pair-endpoint-acl.test.ts',count: 4,reason: 'the ACL half of v73 (#task:2017). Three of the four calls exist because the SUBJECT has no production constructor yet: v73 gives direct_pair its columns and rules while P3 gives it get-or-create and a wire face, so the fixture inserts the row the way the schema defines it, and the two fault injections state what no API may — DROP the stamping trigger (a principal deleted with NO tombstone must still read as gone, the falsifier that stops the gate from trusting the stamp alone) and stamp an endpoint whose principal is alive (the stamp must still be believed). The fourth reads the two tombstone columns back, which the wire DTO deliberately does not carry. Everything else in the file goes through permissions.ts and the repositories'},
  {file: 'packages/backend/tests/workspace-delete-cascade-index.test.ts',count: 22,reason: 'asserts index structure and query plans (EXPLAIN) — engine white-box by nature'},
  {file: 'packages/backend/tests/read-model/unread-stream-queries.test.ts',count: 6,reason: 'differential oracle: frozen legacy SQL compared against the live read model'},
  {file: 'packages/backend/tests/repos/conversation-member-refs.test.ts',count: 5,reason: 'the membership cascade read shape (#task:1987): EXPLAIN QUERY PLAN over the exported production SQL plus the sqlite_master catalog read that proves no NEW index is needed, and UPDATEs that set `updated_at` to chosen values, because that column IS the ordering contract and no repo write can express a specific instant'},
  {file: 'packages/backend/tests/repos/conversation-names.test.ts',count: 1,reason: 'fault injection (#task:2016): ONE direct INSERT creates a workspace conversation holding no name allocation. No production face can produce it — `name` is a required argument of both insert faces and the allocation commits in the same transaction as the row — but the consistency query `listWorkspacePlacementsWithoutCurrentName` exists to NAME that half-state, and a detector never shown detecting is not evidence. Totality is a property of the write paths rather than a DB constraint (SQLite has no deferred constraints), so this is the only way to fault it'},
  {file: 'packages/backend/tests/utils/db.ts',count: 3,reason: 'shared fixture infrastructure; the semantic builders wrap THIS file so business tests do not touch SQL'},
  {file: 'packages/backend/tests/utils/test-context.ts',count: 8,reason: 'the semantic fixture layer itself: repository-contract builders plus purpose-named impossible-state seams; native SQL concentrates here so business tests carry none'},
  {file: 'packages/server/tests/config.test.ts',count: 4,reason: 'simulates EXCLUSIVE lock contention on the raw file DB — engine behavior test'},
  {file: 'packages/backend/tests/repos/auth-uow.test.ts',count: 3,reason: 'UnitOfWork adapter test: simulates a second-connection BEGIN IMMEDIATE writer and asserts rollback visibility — engine white-box by nature'},
  {file: 'packages/backend/tests/repos/conversation-persistence.test.ts',count: 9,reason: 'UnitOfWork adapter test: a second connection contends for the channel write lock (BEGIN IMMEDIATE / rival UPDATE / ROLLBACK) to prove the getChannelLikeForUpdate isolation obligation holds on SQLite, and the same contention is repeated for the workspace-keyed axis (#task:1987) because "two axes, ONE mechanism" is a claim about the engine — engine white-box by nature. +2 for the v72 name race (#task:2016): the rival must HOLD the address uncommitted while the checking transaction runs, which takes an explicit BEGIN IMMEDIATE / COMMIT on the other connection — the point is that isNameAllocated cannot be raced because check and insert share one lock, and a repo call on our own connection would prove nothing'},
  {file: 'packages/backend/tests/repos/host-uow.test.ts',count: 17,reason: 'UnitOfWork adapter test: forces impossible credential/host states (expiry, consumed, kind, unbound, revoked) to pin every predicate of the semantic active-credential query, plus createHostInvite host-row/credential rollback visibility — engine white-box by nature. +3 for the second-connection isolation tests: a rival BEGIN IMMEDIATE / ROLLBACK and a rival UPDATE are the only way to show the write lock is the mechanism (a repo call would run on OUR connection and prove nothing)'},
  {file: 'packages/backend/tests/application/remove-workspace-member.test.ts',count: 2,reason: 'UnitOfWork adapter test: a second connection holds the membership write lock (BEGIN IMMEDIATE / ROLLBACK) to prove the cascade callback does not run at all when the anchor is not ownable — engine white-box by nature'},
  {file: 'packages/backend/tests/repos/user-persistence.test.ts',count: 10,reason: 'UnitOfWork adapter test: a second connection contends for the registration write lock (rival user INSERT / BEGIN IMMEDIATE / ROLLBACK) to prove the single-viewer gate is closed by a mechanism, plus archived-row and unowned-workspace states the semantic builders cannot express — engine white-box by nature'},
  {file: 'packages/backend/tests/repos/agent-provisioning-persistence.test.ts',count: 12,reason: 'UnitOfWork adapter test: asserts the pending-only conditional transition fails closed for failed/active rows and that a mid-transaction throw rolls back every dependent row — engine white-box by nature. The v71 §4.2 aggregate-factory block reads raw for the same reason: it pins the inbox placement row COLUMN BY COLUMN (placement_kind/workspace_id/roster_policy/created_at/updated_at, plus the absence of a conversation_agents row), and it faults the pair with a BEFORE INSERT trigger to prove one transaction wraps two repo calls — a DTO read cannot see either'},
  {file: 'packages/backend/tests/repos/agent-teardown-persistence.test.ts',count: 9,reason: 'UnitOfWork adapter test: the FK CASCADE is the persistence CONTRACT here (one DELETE FROM agents clears memberships, capability grants via the composite FK, conversation participation, inbox rows, schedules and the owned agent_home subtree while the shared workspace and its history survive), so every assertion must read RAW tables — a repo read joins agents and would report an orphan row as absent, passing whether or not the cascade fired. Includes the foreign_keys=OFF falsifier and the surviving-author snapshot read; engine white-box by nature. 5→9 in v73 (#task:2017): the same production delete is run on an agent that is a direct_pair ENDPOINT, and the claim is about what the cascade does NOT reach — the DM has no workspace and its endpoint columns carry no FK, so the row is inserted natively (no production constructor until P3) and the outcome is read natively: the conversation and its message survive, the endpoint is stamped on the correct side only, and PRAGMA foreign_key_check stays empty even though the coordinate now names a deleted agent'},
  {file: 'packages/backend/tests/application/create-agent-provisioning.test.ts',count: 14,reason: 'application integration test: real DB + fake daemon proving L3b state-machine compensation on rollback and that lost eligibility never compensates the winner — engine white-box by nature'},
  {file: 'packages/backend/tests/repos/sqlite-user-conflicts.test.ts',count: 1,reason: 'error-translation test: one native INSERT produces a REAL non-uniqueness rejection (avatar CHECK) to prove an unrecognized driver error passes through untranslated'},
  {file: 'packages/backend/tests/observability/db-write-probe.test.ts',count: 5,reason: 'readiness-probe adapter test: a second connection holds the write lock (BEGIN IMMEDIATE / CREATE TABLE / ROLLBACK) so the probe fails the way production fails, and a deferred BEGIN on the probed connection is the falsifier proving BEGIN IMMEDIATE is load-bearing — engine white-box by nature'},
  {file: 'packages/backend/tests/drivers/platform-prompt.test.ts',count: 1,reason: 'NOT SQL: RegExp.exec on an identifier receiver — ruled false positive of the exec sink boundary (only regex literals are exempt)'},
  {file: 'packages/backend/tests/observability/cli-route-map.test.ts',count: 1,reason: 'NOT SQL: RegExp.exec on an identifier receiver — ruled false positive of the exec sink boundary (only regex literals are exempt)'},
];

/*
 * `ContextDbReaderEntry` / `CONTEXT_DB_READER_INVENTORY` are GONE (#task:1983 W6).
 *
 * They froze who may read `BackendContext.db`, per file and by exact count, while
 * that field existed. W3 emptied the ledger and W5 deleted the field, so there is
 * nothing left to freeze: `ctx.db` in a production file no longer typechecks.
 * Keeping a permanently empty table would have been an invitation to add the
 * next row "just this once" — the deletion is what makes the wall unattractive to
 * reopen. Gate 6 (`composition-handle.test.ts`) still runs, now asserting the two
 * facts directly: `BackendContext` declares no `db` member, and the tree-wide
 * scan finds zero readers.
 */

export interface DialectDecodingEntry {
  file: string;
  signal: DialectSignal;
  count: number;
  /**
   * #task:1983 W8 split `error-translation` in two, because one label was
   * covering two different responsibilities and the broader reading of it was
   * "any file under repos/ may decode dialect" — a directory waiver by another
   * name. `error-translation` is now exactly the modules whose WHOLE job is
   * translation (and there are two); `adapter-internal` is a repository
   * translating a constraint IT owns, which the gate checks against the SQL-sink
   * ledger rather than believing from the reason.
   */
  zone: 'schema' | 'error-translation' | 'adapter-internal';
  reason: string;
}

/**
 * Where SQLite dialect (error codes, constraint text, trigger text) may be
 * decoded (Gate 7). An EXACT file set — there is no directory waiver. The two
 * legal zones are narrow on purpose: `schema` DEFINES the text,
 * `error-translation` turns a driver rejection into a domain outcome. Anything
 * else deciding on dialect has made the engine part of its contract.
 *
 * TWO AUTHORITIES since #task:1983 W4, and every row names one: `db-errors.ts`
 * owns driver RESULT CODES, the schema (plus the two modules that translate its
 * text) owns CONSTRAINT / TRIGGER TEXT.
 *
 * W6 deleted the `adapter` and `debt` zones from the type, not just their rows.
 * `adapter` meant "turns a driver failure into a metric label" — the readiness
 * probe and the statement chokepoint stopped matching codes themselves and ask
 * `db-errors.ts` instead, so that is no longer a dialect-holding job and a row
 * claiming it would be wrong rather than merely stale. Re-adding either zone is
 * now a type error, which is the point: a debt zone with no rows is an invitation.
 *
 * W8's `adapter-internal` is NOT that zone coming back: it is narrower than the
 * label it split off from (`error-translation`), it is bound to the repository
 * surface, and it additionally has to own the SQL it translates. The deleted
 * `adapter` zone let an instrumentation module decode codes for a metric label;
 * nothing here can.
 */
export const DIALECT_DECODING_INVENTORY: DialectDecodingEntry[] = [
  {file: 'packages/backend/src/db-errors.ts',signal: 'sqlite_error_code',count: 2,zone: 'error-translation',reason: 'THE driver-error-code decoder (#task:1983 W4): the SQLITE_BUSY* / SQLITE_LOCKED* families become a contention verdict, and nothing else in the process names a result code. It replaced three independent answers to "is this contention?" that had already drifted — admin.ts compared for equality against SQLITE_BUSY alone, so SQLITE_BUSY_SNAPSHOT and every SQLITE_LOCKED* variant reached the operator as a raw driver error instead of db_locked. Callers keep their own mapping (probe verdict / metric label / db_locked), which is not dialect'},
  {file: 'packages/backend/src/repos/sqlite-user-conflicts.ts',signal: 'constraint_failed_text',count: 3,zone: 'error-translation',reason: 'THE user-conflict translation module: UNIQUE constraint failed on users.id/name/email becomes a domain conflict reason. Unrecognized driver errors pass through untranslated (pinned by sqlite-user-conflicts.test.ts)'},
  {file: 'packages/backend/src/repos/sqlite-user-conflicts.ts',signal: 'trigger_text',count: 1,zone: 'error-translation',reason: 'same module: the cross-table name-collision TRIGGER message is the only signal SQLite gives for agents/users name uniqueness, so it is decoded here and nowhere else'},
  {file: 'packages/backend/src/repos/task-repo.ts',signal: 'sqlite_error_code',count: 1,zone: 'adapter-internal',reason: 'the SQLite task adapter translating a constraint it owns: SQLITE_CONSTRAINT_UNIQUE on source_message_id becomes the source_conflict domain outcome. Legal because this file owns the SQL for that table (checked against the sink ledger, not taken on trust); a second engine would move it behind a per-engine translation module like sqlite-user-conflicts.ts'},
  {file: 'packages/shared/src/db/baseline-schema.ts',signal: 'trigger_text',count: 1,zone: 'schema',reason: 'the schema DEFINES trigger text — this is the harvest authority Gate 7 fences everyone else against, not a decoding site'},
  {file: 'packages/shared/src/db/migrations.ts',signal: 'constraint_failed_text',count: 1,zone: 'schema',reason: 'a SQL comment inside a migration literal explaining why a CHECK is expressed the way it is; prose that happens to live inside a literal, in the schema zone'},
  {file: 'packages/shared/src/db/migrations.ts',signal: 'trigger_text',count: 6,zone: 'schema',reason: 'migrations define trigger text (the second half of the harvest authority); one finding per literal that carries RAISE messages, so v72\'s three conversation_names guards — all inside a single `up` template — add one, and v73\'s four direct_pair endpoint guards (birth / born-alive / immutable / stamp-once, likewise one template) add one more'},
];

export interface TestDebtEntry {
  file: string;
  count: number;
  /**
   * Carried only by counts that were RAISED under review (the default direction
   * is down): what the added statement expresses and why no semantic builder can.
   * The file stays in this shrink-only zone rather than moving to
   * TEST_WHITEBOX_INVENTORY, because whitebox pins the WHOLE file and would stop
   * the pre-existing statements here from being pushed down.
   */
  reason?: string;
}

export const TEST_NATIVE_SQL_DEBT: TestDebtEntry[] = [
  {file: 'packages/backend/tests/admin.test.ts',count: 3},
  {file: 'packages/backend/tests/application/cross-computer-membership.test.ts',count: 5},
  {file: 'packages/backend/tests/application/delete-agent.test.ts',count: 3,reason: '+1 under review (#task:1987 D): one UPDATE agents SET host_id, the placement interleave the teardown port promises to refuse under its write lock. Production has NO placement writer, so no repo or route can express it — and adding a production mutation capability so a test could reach it would put the hazard in the product'},
  {file: 'packages/backend/tests/application/delete-computer.test.ts',count: 3},
  {file: 'packages/backend/tests/application/membership-use-cases.test.ts',count: 17},
  {file: 'packages/backend/tests/application/react-message.test.ts',count: 6},
  {file: 'packages/backend/tests/application/revoke-host.test.ts',count: 1},
  {file: 'packages/backend/tests/auth/host-token.test.ts',count: 7},
  {file: 'packages/backend/tests/auth/password.test.ts',count: 2},
  {file: 'packages/backend/tests/auth/session.test.ts',count: 4},
  {file: 'packages/backend/tests/auth/user-auth-service.test.ts',count: 4},
  {file: 'packages/backend/tests/boot/standalone-placement-wired.test.ts',count: 2},
  {file: 'packages/backend/tests/e2e/embedded-outbound-boot-shutdown.test.ts',count: 7},
  {file: 'packages/backend/tests/e2e/g2-harness.ts',count: 1},
  {file: 'packages/backend/tests/e2e/parity/connection-staleness.test.ts',count: 1},
  {file: 'packages/backend/tests/e2e/parity/embedded-parity.test.ts',count: 1},
  {file: 'packages/backend/tests/e2e/parity/outbound-parity-contract.ts',count: 12},
  {file: 'packages/backend/tests/e2e/standalone-d4-d6-materialize-wire.test.ts',count: 3},
  {file: 'packages/backend/tests/e2e/standalone-g2-backend-restart.test.ts',count: 16},
  {file: 'packages/backend/tests/e2e/standalone-g2-crash-recovery.test.ts',count: 10},
  {file: 'packages/backend/tests/e2e/standalone-g2-daemon-recovery.test.ts',count: 13},
  {file: 'packages/backend/tests/e2e/standalone-g2-hard-stop.test.ts',count: 10},
  {file: 'packages/backend/tests/e2e/standalone-g2-live-wake.test.ts',count: 12},
  {file: 'packages/backend/tests/e2e/standalone-g2-runtime-start.test.ts',count: 9},
  {file: 'packages/backend/tests/e2e/standalone-g3-signup-toggle.test.ts',count: 2},
  {file: 'packages/backend/tests/e2e/standalone-route-runtime.test.ts',count: 10},
  {file: 'packages/backend/tests/observability/observed-statement.test.ts',count: 8},
  {file: 'packages/backend/tests/permissions.test.ts',count: 11},
  {file: 'packages/backend/tests/repos/agent-repo.test.ts',count: 1},
  {file: 'packages/backend/tests/repos/attachment-repo.test.ts',count: 7},
  {file: 'packages/backend/tests/repos/conversation-read-repo.test.ts',count: 3},
  {file: 'packages/backend/tests/repos/conversation-repo.test.ts',count: 2},
  {file: 'packages/backend/tests/repos/host-repo.test.ts',count: 1},
  {file: 'packages/backend/tests/repos/message-author-surfaces.test.ts',count: 3},
  {file: 'packages/backend/tests/repos/message-repo-threads.test.ts',count: 6},
  {file: 'packages/backend/tests/repos/message-repo.test.ts',count: 7},
  {file: 'packages/backend/tests/repos/workspace-repo.test.ts',count: 1},
  {file: 'packages/backend/tests/routes/activity-lifecycle-conformance.test.ts',count: 5},
  {file: 'packages/backend/tests/routes/activity.test.ts',count: 23},
  {file: 'packages/backend/tests/routes/agent-capabilities.test.ts',count: 1},
  {file: 'packages/backend/tests/routes/agent-create-characterization.test.ts',count: 10},
  {file: 'packages/backend/tests/routes/agent-create-structural-invariants.test.ts',count: 22},
  {file: 'packages/backend/tests/routes/agent-delete-files-purge.test.ts',count: 2},
  {file: 'packages/backend/tests/routes/agent-failed-recovery.test.ts',count: 4},
  {file: 'packages/backend/tests/routes/agent-home-dm-channel-characterization.test.ts',count: 16},
  {file: 'packages/backend/tests/routes/agent-peer-profile.test.ts',count: 1},
  {file: 'packages/backend/tests/routes/agent-schedules.test.ts',count: 8},
  {file: 'packages/backend/tests/routes/agent-self-service-membership.test.ts',count: 7},
  {file: 'packages/backend/tests/routes/agents-no-host-typed-fail.test.ts',count: 4},
  {file: 'packages/backend/tests/routes/agents.test.ts',count: 32},
  {file: 'packages/backend/tests/routes/attachments.test.ts',count: 7},
  {file: 'packages/backend/tests/routes/attention-badge.test.ts',count: 8},
  {file: 'packages/backend/tests/routes/attention.test.ts',count: 4},
  {file: 'packages/backend/tests/routes/auth-routes.test.ts',count: 9},
  {file: 'packages/backend/tests/routes/capability-enforcement.test.ts',count: 4},
  {file: 'packages/backend/tests/routes/channel-threads.test.ts',count: 2},
  {file: 'packages/backend/tests/routes/channels.test.ts',count: 33},
  {file: 'packages/backend/tests/routes/conversation-members.test.ts',count: 31},
  {file: 'packages/backend/tests/routes/conversation-ref.test.ts',count: 5},
  {file: 'packages/backend/tests/routes/conversation-unread.test.ts',count: 1},
  {file: 'packages/backend/tests/routes/embedded-bootstrap.test.ts',count: 16},
  {file: 'packages/backend/tests/routes/favorites.test.ts',count: 20},
  {file: 'packages/backend/tests/routes/follow-thread.test.ts',count: 2},
  {file: 'packages/backend/tests/routes/hosts.test.ts',count: 27},
  {file: 'packages/backend/tests/routes/identity-created-event.test.ts',count: 3},
  {file: 'packages/backend/tests/routes/list-workspaces.test.ts',count: 5},
  {file: 'packages/backend/tests/routes/message-reactions.test.ts',count: 1},
  {file: 'packages/backend/tests/routes/name-availability.test.ts',count: 1},
  {file: 'packages/backend/tests/routes/notifications.test.ts',count: 3},
  {file: 'packages/backend/tests/routes/pre-register-gate.test.ts',count: 2},
  {file: 'packages/backend/tests/routes/read-history.test.ts',count: 3},
  {file: 'packages/backend/tests/routes/schedules.test.ts',count: 2},
  {file: 'packages/backend/tests/routes/search-messages.test.ts',count: 1},
  {file: 'packages/backend/tests/routes/search.test.ts',count: 3},
  {file: 'packages/backend/tests/routes/sessions.test.ts',count: 3},
  {file: 'packages/backend/tests/routes/sort.test.ts',count: 2},
  {file: 'packages/backend/tests/routes/standalone-g1-happy-path.test.ts',count: 10},
  {file: 'packages/backend/tests/routes/task-board.test.ts',count: 4},
  {file: 'packages/backend/tests/routes/tasks.test.ts',count: 8},
  {file: 'packages/backend/tests/routes/thread-followers.test.ts',count: 2},
  {file: 'packages/backend/tests/routes/workspace-agent-enrollment.test.ts',count: 9},
  {file: 'packages/backend/tests/routes/workspace-conversation-routes.test.ts',count: 11},
  {file: 'packages/backend/tests/routes/workspace-create-characterization.test.ts',count: 9},
  {file: 'packages/backend/tests/routes/workspace-delete.test.ts',count: 17},
  {file: 'packages/backend/tests/routes/workspace-member-add-pure-db.test.ts',count: 4},
  {file: 'packages/backend/tests/routes/workspace-placement-preflight.test.ts',count: 18},
  {file: 'packages/backend/tests/routes/workspace-provision-wiring.test.ts',count: 12},
  {file: 'packages/backend/tests/routes/workspace-self-leave.test.ts',count: 8},
  {file: 'packages/backend/tests/runtime/materialize-reconciler.test.ts',count: 4},
  {file: 'packages/backend/tests/runtime/outbound-event-fanout.test.ts',count: 4},
  {file: 'packages/backend/tests/services/channel-service.test.ts',count: 9},
  {file: 'packages/backend/tests/services/conversation-message-service.test.ts',count: 2},
  {file: 'packages/backend/tests/services/mention-cc.test.ts',count: 3},
  {file: 'packages/backend/tests/services/task-service.test.ts',count: 19},
  {file: 'packages/backend/tests/smoke.test.ts',count: 2},
  {file: 'packages/backend/tests/ws/host-token-rotation.test.ts',count: 3},
  {file: 'packages/backend/tests/ws/ws-server.test.ts',count: 1},
];

export interface PrivatePortEntry {
  file: string;
  reads: number;
  installs: number;
  declares: number;
  /**
   * `consumer` — the ONE module the port exists for; the only legal reader.
   * `declaration` — states the member's type and nothing else.
   * `composition` — supplies the implementation, or forwards it once at boot.
   */
  zone: 'consumer' | 'declaration' | 'composition';
  reason: string;
}

/**
 * `authorizationReads` — a port that is private to a single consumer (Gate 8).
 *
 * The other gates in this file fence a CAPABILITY (who may name the driver, who
 * may issue SQL). This one fences an AUDIENCE: `authorizationReads` is a
 * narrow read-only view of exactly the facts `permissions.ts` needs to decide
 * access, and its value is that every predicate answering "may this principal
 * do X" reads its facts from one auditable surface. A second consumer would not
 * break a type; it would quietly turn a decision port into a general query
 * shortcut, and the next reviewer would have no way to see that it happened.
 *
 * The scan matches the member BY NAME, receiver-independent, because the port
 * hangs off two objects: the context AND the persistence bag that routes are
 * handed. Fencing only `ctx.authorizationReads` would leave
 * `persistence.authorizationReads` as an equally effective bypass that names no
 * context at all. Cost of name matching, accepted deliberately: an unrelated
 * member that happens to share this name must be renamed or appear here — the
 * right direction of pressure for a name that is supposed to be private.
 *
 * Counts are per file and per kind, so moving a read between zones is a visible
 * diff. `reads` in a non-`consumer` zone is what the gate treats as the
 * violation; a `declaration` or `composition` row with reads > 0 must say why
 * (boot's single forward is the only such row today).
 */
export const AUTHORIZATION_PORT_INVENTORY: PrivatePortEntry[] = [
  {file: 'packages/backend/src/permissions.ts',reads: 18,installs: 0,declares: 0,zone: 'consumer',reason: 'THE consumer: every access predicate in the process reads its facts here and nowhere else, which is what makes the authorization surface auditable in one file. Count moves with the number of predicates that need a fact — it is not shrink-only, but a read appearing in ANY OTHER file is. 15→16 in v71 (#task:2014): canGovernConversationWorkspace reads the conversation to resolve the workspace a conversation-level mutation is governed by, because conversations.workspace_id is nullable since v69 and passing it straight into canGovernWorkspace denied by accident of a failed lookup instead of by a stated rule. 16→18 in v73 (#task:2017): canPostToConversation re-reads the conversation because the WRITE gate asks one question the read gate does not (are both direct_pair endpoints still live), and isEndpointGone asks endpointPrincipalExists — the lookup that makes the tombstone a shortcut rather than the authority'},
  {file: 'packages/backend/src/context.ts',reads: 0,installs: 0,declares: 1,zone: 'declaration',reason: 'declares the member on BackendContext — the type-level statement that the capability bag carries a fact port, not a database handle'},
  {file: 'packages/backend/src/persistence/root.ts',reads: 0,installs: 1,declares: 1,zone: 'composition',reason: 'the persistence composition root declares the member on its own bag and supplies the SQLite implementation. Deleting this row means authorization facts stopped coming from persistence'},
  {file: 'packages/backend/src/index.ts',reads: 1,installs: 1,declares: 0,zone: 'composition',reason: 'boot forwards the port from the persistence bag onto the context, once, in the context literal. This is the ONLY legal read outside the consumer: it moves the port, it does not ask it a question — a read here that fed a decision would be an authorization rule living in boot'},
];

export interface DriverCloseEntry {
  file: string;
  fn: string;
  reason: string;
}

/**
 * Who may end a driver handle's life (Gate 2b-B).
 *
 * `close()` is the driver capability that is neither SQL nor a transaction, and
 * closing a handle another part of the process is still using is the failure this
 * app has already been bitten by from the other direction (a stray connection
 * into a live WAL). The rule every row here obeys — and which
 * `driver-capability.test.ts` asserts mechanically, not just by reading these
 * reasons — is CLOSE ONLY WHAT YOU OPENED: each of these files also calls
 * `openDatabase`, and closes in the same scope that owns it. A file that closes a
 * handle it received is the shape that produces "closed under the writer".
 *
 * Keyed by file × enclosing function so that moving the call inside a file is
 * still a visible diff.
 */
export const DRIVER_CLOSE_INVENTORY: DriverCloseEntry[] = [
  {file: 'packages/backend/src/db.ts',fn: 'openDatabase',reason: 'failed-open rollback: when migration throws, the opener closes the half-built handle it just created rather than leaking a connection into a process that is about to report boot failure. The most local ownership there is — open and close in one function'},
  {file: 'packages/backend/src/index.ts',fn: 'close',reason: 'server shutdown phase 4: the handle boot opened is closed after the HTTP/WS listeners are down and connections have been terminated. The other half of the `lifecycle` row in BETTER_SQLITE3_IMPORT_INVENTORY — that row is why boot names the driver type, this one is why it may end the lifetime'},
  {file: 'packages/backend/src/admin.ts',fn: 'resetAdminPassword',reason: 'the offline admin command opens its own handle in a process where the server is not running, and closes it in the same function\'s `finally`. Deleting this row means the admin tool stopped owning a connection'},
];

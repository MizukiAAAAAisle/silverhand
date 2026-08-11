/**
 * DB boundary ledgers — the auditable baseline the four gates in this
 * directory compare against (see docs/db-boundary.md).
 *
 * Contract:
 * - The gates enforce EXACT equality with the current tree, so any change —
 *   up or down — is a conscious, reviewable edit of this file.
 * - Direction is shrink-only for every `debt`/`route-debt` entry, for
 *   DYNAMIC_SQL_INVENTORY and for TEST_NATIVE_SQL_DEBT: counts go down and
 *   entries disappear. Raising a count or adding a debt entry needs a
 *   reviewed justification; hazard growth additionally needs a semantic test
 *   for the new SQL.
 * - Everything is keyed per file (× function / hazard / mode), never by
 *   totals, so debt cannot be shuffled between files without a visible diff.
 */
import type { HazardFinding, ImportKind, TxMode } from './scan.js';

export type ImportInventoryEntry =
  | { file: string; kinds: ImportKind[]; zone: 'adapter' | 'repository' }
  | {
      file: string;
      kinds: ImportKind[];
      zone: 'debt';
      /** Required: what owns this coupling and the deletion direction. */
      reason: string;
    };

export const BETTER_SQLITE3_IMPORT_INVENTORY: ImportInventoryEntry[] = [
  {file: 'packages/backend/src/db.ts',kinds: ['type','value'],zone: 'adapter'},
  {file: 'packages/backend/src/observability/observed-statement.ts',kinds: ['type'],zone: 'adapter'},
  {file: 'packages/backend/src/auth/host-token.ts',kinds: ['type'],zone: 'debt',reason: 'auth service holds raw Db and prepares directly; extract an auth repo when next touched'},
  {file: 'packages/backend/src/context.ts',kinds: ['type'],zone: 'debt',reason: 'AppContext.db field typing — the composition root hands the handle to repos/services; shrinks when construction moves behind a persistence facade'},
  {file: 'packages/backend/src/mention-cc.ts',kinds: ['type'],zone: 'debt',reason: 'standalone helper prepares directly; fold into a repo when the mention/cc flow is next touched'},
  {file: 'packages/backend/src/runtime/outbound-event-fanout.ts',kinds: ['type'],zone: 'debt',reason: 'runtime fanout prepares directly and owns one tx; extract queries into repos when next touched'},
  {file: 'packages/backend/src/services/channel-service.ts',kinds: ['type'],zone: 'debt',reason: 'service types the raw Db for its tx owner role; move remaining direct queries behind repos when touched'},
  {file: 'packages/backend/src/services/conversation-message-service.ts',kinds: ['type'],zone: 'debt',reason: 'service types the raw Db for its tx owner role; move remaining direct queries behind repos when touched'},
  {file: 'packages/backend/src/services/conversation-message/contracts.ts',kinds: ['type'],zone: 'debt',reason: 'deps interface types the raw Db; narrows to repo contracts when the message domain is next touched'},
  {file: 'packages/backend/src/services/conversation-message/delivery.ts',kinds: ['type'],zone: 'debt',reason: 'delivery pipeline types the raw Db; narrows to repo contracts when next touched'},
  {file: 'packages/backend/src/services/conversation-message/thread-follow.ts',kinds: ['type'],zone: 'debt',reason: 'service types the raw Db for its tx owner role; narrows to repo contracts when next touched'},
  {file: 'packages/backend/src/services/task-service.ts',kinds: ['type'],zone: 'debt',reason: 'task facade types the raw Db for its tx owner role; queries live in TaskStore'},
  {file: 'packages/backend/src/services/task/board.ts',kinds: ['type'],zone: 'debt',reason: 'board reader prepares directly; task-domain read model — fold into read-model/ when next touched'},
  {file: 'packages/backend/src/services/task/broadcaster.ts',kinds: ['type'],zone: 'debt',reason: 'broadcaster shares the task-service db handle for same-tx inserts; shrinks with the task domain'},
  {file: 'packages/backend/src/services/task/contracts.ts',kinds: ['type'],zone: 'debt',reason: 'deps interface types the raw Db; narrows to repo contracts when the task domain is next touched'},
  {file: 'packages/backend/src/services/task/store.ts',kinds: ['type'],zone: 'debt',reason: 'TaskStore is a de-facto repository living under services/; move to repos/ when next touched'},
  {file: 'packages/backend/src/services/user-service.ts',kinds: ['type'],zone: 'debt',reason: 'service prepares directly; extract a users repo surface when next touched'},
  {file: 'packages/backend/src/repos/agent-capability-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-credentials-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-sessions-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-uow.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/attachment-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/attention-badge-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/channel-attention-preference-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-event-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-read-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/host-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/message-author.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/message-reaction-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/message-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/notification-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/saved-message-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/schedule-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/search-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/sort-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/thread-follower-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/user-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/workspace-attention-preference-repo.ts',kinds: ['type'],zone: 'repository'},
  {file: 'packages/backend/src/repos/workspace-repo.ts',kinds: ['type'],zone: 'repository'},
];

export interface SqlCallerEntry {
  file: string;
  zone: 'adapter' | 'repository' | 'schema' | 'debt';
  /** Exact sink-call count; pinned for debt and schema files. */
  count?: number;
}

export const SQL_CALLER_INVENTORY: SqlCallerEntry[] = [
  {file: 'packages/backend/src/db.ts',zone: 'adapter'},
  {file: 'packages/backend/src/observability/observed-statement.ts',zone: 'adapter'},
  {file: 'packages/shared/src/db/migrations.ts',zone: 'schema',count: 2},
  {file: 'packages/backend/src/auth/host-token.ts',zone: 'debt',count: 9},
  {file: 'packages/backend/src/mention-cc.ts',zone: 'debt',count: 2},
  {file: 'packages/backend/src/routes.ts',zone: 'debt',count: 3},
  {file: 'packages/backend/src/runtime/outbound-event-fanout.ts',zone: 'debt',count: 1},
  {file: 'packages/backend/src/services/task/board.ts',zone: 'debt',count: 5},
  {file: 'packages/backend/src/services/task/contracts.ts',zone: 'debt',count: 1},
  {file: 'packages/backend/src/services/task/store.ts',zone: 'debt',count: 19},
  {file: 'packages/backend/src/services/user-service.ts',zone: 'debt',count: 5},
  {file: 'packages/backend/src/read-model/activity.ts',zone: 'repository'},
  {file: 'packages/backend/src/read-model/agent-delete-impact.ts',zone: 'repository'},
  {file: 'packages/backend/src/read-model/agent-read.ts',zone: 'repository'},
  {file: 'packages/backend/src/read-model/favorites.ts',zone: 'repository'},
  {file: 'packages/backend/src/read-model/message-reactions.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-capability-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-credentials-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/auth-sessions-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/agent-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/attachment-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/attention-badge-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/channel-attention-preference-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-event-repo.ts',zone: 'repository'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',zone: 'repository'},
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
  {file: 'packages/backend/src/mention-cc.ts',hazard: 'insert_or_action',count: 1},
  {file: 'packages/backend/src/mention-cc.ts',hazard: 'is_parameter',count: 1},
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
  {file: 'packages/backend/src/routes.ts',hazard: 'begin_immediate_exclusive',count: 1},
  {file: 'packages/backend/src/services/user-service.ts',hazard: 'insert_or_action',count: 2},
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
  {file: 'packages/backend/src/services/task/board.ts',fn: 'TaskBoardReader.column',sink: 'prepareObserved',exprKind: 'PropertyAccessExpression',count: 1,reason: 'SQL from the taskBoardColumnQuery builder; builder literals harvested at definition'},
  {file: 'packages/backend/src/services/task/store.ts',fn: 'TaskStore.list',sink: 'prepareObserved',exprKind: 'Identifier',count: 1,reason: 'WHERE clauses assembled from typed filters; clause literals harvested at definition'},
];

export interface ApiHazardEntry {
  file: string;
  fn: string;
  api: string;
}

export const API_HAZARD_INVENTORY: ApiHazardEntry[] = [
  {file: 'packages/backend/src/repos/auth-uow.ts',fn: 'atomically',api: 'transaction_immediate'},
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
  owner: 'use-case' | 'service' | 'auth' | 'repo-internal' | 'route-debt' | 'infra';
  /** repo-internal entries MUST explain outer atomicity ownership. */
  reason?: string;
}

export const TX_INVENTORY: TxInventoryEntry[] = [
  {file: 'packages/backend/src/auth/host-token.ts',fn: 'HostTokenService.completePreparedHostTokenRotation',mode: 'default',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/auth/host-token.ts',fn: 'HostTokenService.rotateHostTokenImmediate',mode: 'default',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/auth/user-auth-service.ts',fn: 'UserAuthService.resetPassword',mode: 'uow',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/auth/user-auth-service.ts',fn: 'UserAuthService.signup',mode: 'uow',count: 1,owner: 'auth'},
  {file: 'packages/backend/src/db.ts',fn: 'applySingleMigration',mode: 'exclusive',count: 1,owner: 'infra',reason: 'migration application requires exclusive lock escalation by design'},
  {file: 'packages/backend/src/repos/auth-uow.ts',fn: 'atomically',mode: 'default',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: the persistence half of the application atomically() contract (deferred policy)'},
  {file: 'packages/backend/src/repos/auth-uow.ts',fn: 'atomically',mode: 'immediate',count: 1,owner: 'infra',reason: 'UnitOfWork implementation: immediate policy for the offline admin composition (root-only, fail-loud when nested)'},
  {file: 'packages/backend/src/db.ts',fn: 'runMigrations',mode: 'exclusive',count: 1,owner: 'infra',reason: 'no-op migration phase takes an exclusive lock probe so concurrent boots fail fast'},
  {file: 'packages/backend/src/repos/agent-capability-repo.ts',fn: 'AgentCapabilityRepo.replaceSet',mode: 'default',count: 1,owner: 'repo-internal',reason: 'delete+reinsert of one capability set is a self-contained invariant; no caller composes it with other writes, savepoint under an outer tx is acceptable'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.claimPending',mode: 'exclusive',count: 1,owner: 'repo-internal',reason: 'inbox delivery state machine owns claim atomicity; exclusive mode arbitrates cross-connection delivery contention — no outer service tx exists on this path'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.markDelivered',mode: 'stored',count: 1,owner: 'repo-internal',reason: 'delivery cursor + in-flight clear must move together; owned by the inbox state machine'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlight',mode: 'stored',count: 1,owner: 'repo-internal',reason: 'in-flight rollback is inbox-internal recovery; no outer owner'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlightAnyOwner',mode: 'stored',count: 1,owner: 'repo-internal',reason: 'in-flight rollback is inbox-internal recovery; no outer owner'},
  {file: 'packages/backend/src/repos/conversation-inbox-repo.ts',fn: 'ConversationInboxRepo.rollbackInFlightForAgent',mode: 'exclusive',count: 1,owner: 'repo-internal',reason: 'in-flight rollback under cross-connection contention; exclusive by design'},
  {file: 'packages/backend/src/repos/message-repo.ts',fn: 'MessageRepo.insertForConversation',mode: 'default',count: 1,owner: 'repo-internal',reason: 'seq allocation + stream-head bump is one invariant owned here; DESIGNED to run as a savepoint under service txs (conversation-message-service, task broadcaster, channel-service)'},
  {file: 'packages/backend/src/repos/message-repo.ts',fn: 'MessageRepo.insertForConversationIfFresh',mode: 'default',count: 1,owner: 'repo-internal',reason: 'freshness CAS throws StreamCasMiss to roll back the seq allocation — REQUIRES savepoint semantics; do not flatten into the outer tx'},
  {file: 'packages/backend/src/repos/sort-repo.ts',fn: 'SortRepo.reorder',mode: 'stored',count: 1,owner: 'repo-internal',reason: 'multi-row rank rewrite is one self-contained invariant; no outer owner'},
  {file: 'packages/backend/src/repos/workspace-repo.ts',fn: 'WorkspaceRepo.setOwnerUserId',mode: 'default',count: 1,owner: 'repo-internal',reason: 'owner column and owner-role membership row must flip together; callers do not compose it with other writes'},
  {file: 'packages/backend/src/routes/hosts.ts',fn: 'createHostApp',mode: 'default',count: 2,owner: 'route-debt',reason: 'route-layer tx predates the use-case layer; move into application/* when next touched'},
  {file: 'packages/backend/src/routes/membership.ts',fn: 'removeWorkspaceMemberAndConversationRows',mode: 'default',count: 1,owner: 'route-debt',reason: 'route-layer tx predates the use-case layer; move into application/* when next touched'},
  {file: 'packages/backend/src/runtime/outbound-event-fanout.ts',fn: 'OutboundRuntimeEventFanout.clearSession',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/channel-service.ts',fn: 'ChannelService.createAgentHomeDmChannel',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/channel-service.ts',fn: 'ChannelService.createChannel',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/channel-service.ts',fn: 'ChannelService.renameChannel',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/conversation-message-service.ts',fn: 'ConversationMessageService.materializeAndDispatchThreadWindow',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/conversation-message-service.ts',fn: 'ConversationMessageService.sendMessage',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/conversation-message/thread-follow.ts',fn: 'ThreadFollowManager.followThread',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.applyTaskEdit',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.claimTaskAgent',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.claimTaskUser',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.createTasks',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.unclaimTaskAgent',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.unclaimTaskUser',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.updateStatusAgent',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task-service.ts',fn: 'TaskService.updateStatusUser',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/task/broadcaster.ts',fn: 'TaskBroadcaster.broadcast',mode: 'default',count: 1,owner: 'service'},
  {file: 'packages/backend/src/services/user-service.ts',fn: 'UserService.register',mode: 'stored',count: 1,owner: 'service'},
  {file: 'packages/backend/src/application/add-workspace-agent-member.ts',fn: 'addWorkspaceAgentMember',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'addConversationMember',mode: 'default',count: 2,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'joinPublicChannel',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'leaveChannel',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'removeConversationHumanMember',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/conversation-member.ts',fn: 'removeConversationMember',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/create-agent.ts',fn: 'insertProvisioningDependents',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/create-workspace.ts',fn: 'createWorkspace',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/delete-computer.ts',fn: 'deleteComputer',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/observe.ts',fn: 'observe',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/react-message.ts',fn: 'addReaction',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/react-message.ts',fn: 'removeReaction',mode: 'default',count: 1,owner: 'use-case'},
  {file: 'packages/backend/src/application/revoke-host.ts',fn: 'revokeHost',mode: 'default',count: 1,owner: 'use-case'},
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
      'TaskStore.dispatchToAgent is a pure UPDATE (assignee handoff + todo→in_progress), not an external effect; rename candidate when the task domain is next touched',
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
  {file: 'packages/backend/tests/tasks-aggregate-migration.test.ts',count: 15,reason: 'exercises one historical migration against hand-built legacy rows'},
  {file: 'packages/backend/tests/workspace-delete-cascade-index.test.ts',count: 22,reason: 'asserts index structure and query plans (EXPLAIN) — engine white-box by nature'},
  {file: 'packages/backend/tests/read-model/unread-stream-queries.test.ts',count: 6,reason: 'differential oracle: frozen legacy SQL compared against the live read model'},
  {file: 'packages/backend/tests/utils/db.ts',count: 3,reason: 'shared fixture infrastructure; the semantic builders wrap THIS file so business tests do not touch SQL'},
  {file: 'packages/backend/tests/utils/test-context.ts',count: 8,reason: 'the semantic fixture layer itself: repository-contract builders plus purpose-named impossible-state seams; native SQL concentrates here so business tests carry none'},
  {file: 'packages/server/tests/config.test.ts',count: 4,reason: 'simulates EXCLUSIVE lock contention on the raw file DB — engine behavior test'},
  {file: 'packages/backend/tests/repos/auth-uow.test.ts',count: 3,reason: 'UnitOfWork adapter test: simulates a second-connection BEGIN IMMEDIATE writer and asserts rollback visibility — engine white-box by nature'},
  {file: 'packages/backend/tests/drivers/platform-prompt.test.ts',count: 1,reason: 'NOT SQL: RegExp.exec on an identifier receiver — ruled false positive of the exec sink boundary (only regex literals are exempt)'},
  {file: 'packages/backend/tests/observability/cli-route-map.test.ts',count: 1,reason: 'NOT SQL: RegExp.exec on an identifier receiver — ruled false positive of the exec sink boundary (only regex literals are exempt)'},
];

export interface TestDebtEntry {
  file: string;
  count: number;
}

export const TEST_NATIVE_SQL_DEBT: TestDebtEntry[] = [
  {file: 'packages/backend/tests/admin.test.ts',count: 3},
  {file: 'packages/backend/tests/application/cross-computer-membership.test.ts',count: 5},
  {file: 'packages/backend/tests/application/delete-agent.test.ts',count: 2},
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
  {file: 'packages/backend/tests/services/mention-cc.test.ts',count: 9},
  {file: 'packages/backend/tests/services/task-service.test.ts',count: 19},
  {file: 'packages/backend/tests/smoke.test.ts',count: 2},
  {file: 'packages/backend/tests/ws/host-token-rotation.test.ts',count: 3},
  {file: 'packages/backend/tests/ws/ws-server.test.ts',count: 1},
];

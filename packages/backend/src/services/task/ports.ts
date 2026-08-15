/**
 * Task-domain application ports — the driver-free contract between task
 * orchestration (create / claim / unclaim / status / edit / read / board) and
 * persistence. Same discipline as auth/ports.ts and host-ports.ts: no
 * driver types, no SQL; gated by the db-boundary port-contract suite.
 *
 * Capability separation (#task:1980 design contract):
 *  - `TaskRepoReadPort` is the ONLY tasks capability the service holds outside
 *    a transaction;
 *  - write capability exists ONLY on `TaskTxScope.tasks` — the service cannot
 *    bypass the UnitOfWork to write;
 *  - the board is an independent read-model;
 *  - the conversation access is a named narrow port, never a concrete repo.
 */
import type {
  ConversationAgentDto,
  ConversationDto,
  ConversationUserMemberDto,
  MessageDto,
  TaskAssigneeDto,
  TaskBoardColumnDto,
  TaskBoardCountsDto,
  TaskBoardFacetsDto,
  TaskDetailDto,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import type {
  ListTasksFilters,
  MessageRef,
  ResolvedTaskRow,
} from './contracts.js';
import type { TaskBoardColumnRequest, TaskBoardPopulationFilters } from './board.js';

/** The task actor faces. Structurally IDENTICAL to the request principals
 *  (`auth/principal.ts`) but defined HERE so this port module's relative
 *  import closure stays driver-free — `principal.ts` transitively types raw
 *  repos, and no port surface may reach a driver through any hop.
 *
 *  `runtimeScope` is the task domain's REQUIRED projection of the P1
 *  RuntimePrincipal kind (#task:2018 / #task:2015): 'agent' unlocks the
 *  cross-board global-id lane and the union list (§4.5/§7.2.2);
 *  'conversation' is the frozen conversation-frame contract. There is NO
 *  default and NO optional form — an agent actor without a declared scope
 *  cannot be constructed, so "the caller never said which principal kind"
 *  is a compile error at the construction site (or a fail-loud boundary
 *  rejection), never a silent reinterpretation inside the domain. */
export type TaskActor =
  | { kind: 'user'; userId: string }
  | {
      kind: 'agent';
      agentId: string;
      conversationId: string;
      runtimeScope: 'conversation';
    }
  | {
      kind: 'agent';
      agentId: string;
      conversationId: null;
      runtimeScope: 'agent';
    };
export type UserActor = Extract<TaskActor, { kind: 'user' }>;
export type AgentActor = Extract<TaskActor, { kind: 'agent' }>;

/** Read face — the only tasks capability the service holds outside a
 *  transaction. */
export interface TaskRepoReadPort {
  list(filters: ListTasksFilters): TaskSummaryDto[];
  getById(
    taskId: string,
    actor: TaskActor,
    authorizedBoardKey?: string,
  ): TaskSummaryDto | null;
  getByNumber(
    workspaceId: string,
    taskNumber: number,
    actor: UserActor,
  ): TaskSummaryDto | null;
  fetchTaskDetail(
    taskId: string,
    actor: TaskActor,
    authorizedBoardKey?: string,
  ): TaskDetailDto | null;
  fetchTaskByNumber(boardKey: string, taskNumber: number): ResolvedTaskRow | null;
  fetchTaskById(taskId: string): ResolvedTaskRow | null;
  /** The board a conversation's placement yields ('ws:…' | 'pair:…'), or null
   *  when it has none (agent_inbox / unknown / missing). Read-side twin of the
   *  v76 derivation trigger — the trigger stays the write authority. */
  boardOfConversation(
    conversationId: string,
  ): { boardKey: string; workspaceId: string | null } | null;
  /** Every DirectPair board this agent is an endpoint of — the pair half of
   *  the agent-slot union list (§7.2.2; participation IS the read authority
   *  on a pair board). */
  listAgentDirectPairBoardKeys(agentId: string): string[];
  fetchMessageRef(messageId: string): MessageRef | null;
  fetchTaskBySourceMessageId(sourceMessageId: string): {
    task_number: number;
    id: string;
    status: TaskStatus;
  } | null;
  readAssignment(taskId: string): {
    assignee_agent_id: string | null;
    assignee_user_id: string | null;
    status: TaskStatus;
  } | null;
  refetchTaskSnapshot(taskId: string): {
    title: string;
    status: TaskStatus;
    closed_at: number | null;
    assignee: TaskAssigneeDto | null;
  } | null;
}

/** Write face — EXISTS ONLY inside `TaskTxScope`. Number allocation is an
 *  adapter-internal implementation detail of `createTaskRow` (it atomically
 *  returns `{id, taskNumber}`); no allocator primitive is exposed. */
export interface TaskRepoWritePort {
  createTaskRow(args: {
    conversationId: string;
    threadRootId: string | null;
    title: string;
    content: string;
    creatorKind: 'agent' | 'user';
    creatorAgentId: string | null;
    creatorUserId: string | null;
    sourceMessageId: string | null;
    claimByAgentId: string | null;
    createdAt: number;
  }): { id: string; taskNumber: number };
  backfillCreatedEvent(taskId: string, messageId: string): void;
  applyTaskEdit(args: {
    taskId: string;
    title: string | null;
    content: string | null;
    editorKind: 'agent' | 'user';
    editorId: string;
    editedAt: number;
  }): boolean;
  assignSelf(taskId: string, agentId: string): number;
  dispatchToAgent(taskId: string, agentId: string): void;
  clearAssignee(taskId: string): void;
  releaseToTodo(taskId: string): void;
  setStatus(taskId: string, status: TaskStatus, closedAt: number | null): void;
}

/** Board read-model — three bounded human read faces. SQL assembly lives in
 *  the persistence adapter; cursor codec is a pure wire contract in
 *  `task/board.ts`. */
export interface TaskBoardReadModelPort {
  column(req: TaskBoardColumnRequest): TaskBoardColumnDto;
  counts(filters: TaskBoardPopulationFilters): TaskBoardCountsDto;
  facets(viewerUserId: string): TaskBoardFacetsDto;
}

/** Named narrow conversation face the task domain needs — deliberately NOT the
 *  whole ConversationRepo. `userCanAccessConversation` is the human membership
 *  check; agent membership uses `getAgent`; the broadcaster's post-commit
 *  fanout uses `listAgents`/`listUsers`. `isAgentParticipant` is the
 *  placement-aware participation authority (§4.2: roster edge OR own inbox
 *  placement) — the per-task ACL (§4.4: ACL derives from the task's own
 *  conversation, never its board) reads THIS, not the roster-shaped
 *  `getAgent`. */
export interface TaskConversationAccessPort {
  get(conversationId: string): ConversationDto | null;
  getAgent(conversationId: string, agentId: string): ConversationAgentDto | null;
  isAgentParticipant(conversationId: string, agentId: string): boolean;
  userCanAccessConversation(userId: string, conversationId: string): boolean;
  listAgents(conversationId: string): ConversationAgentDto[];
  listUsers(conversationId: string): ConversationUserMemberDto[];
}

/** Canonical conversation WRITE decision injected by the authorization
 * layer. This is deliberately a decision port, not another endpoint/tombstone
 * fact reader: `canPostToConversation` remains the one rule that combines
 * placement-aware participation with P0-e survivor-readonly semantics. */
export interface TaskWriteAuthorityPort {
  canPostToConversation(actor: TaskActor, conversationId: string): boolean;
}

/** Insert a task system-event message INSIDE the caller's transaction scope.
 *  The adapter binds to the current transaction (single-connection engines:
 *  same connection, savepoint nesting; a future pooled adapter inserts on the
 *  tx client WITHOUT opening a new transaction). */
export interface TaskSystemEventPort {
  insert(args: {
    conversationId: string;
    threadRootId: string | null;
    content: string;
    metadata: Record<string, unknown>;
  }): MessageDto;
}

/** The transaction-scoped capability bundle. ALL persistence inside an
 *  `atomically` callback MUST come from this scope — never a captured factory
 *  repo (a future pooled adapter would read/write on the wrong connection). */
export interface TaskTxScope {
  tasks: TaskRepoWritePort & TaskRepoReadPort;
  systemEvents: TaskSystemEventPort;
  conversationAccess: TaskConversationAccessPort;
  /** Bound by the caller at transaction entry and invoked inside the same
   * synchronous SQLite transaction as the task/event writes. */
  writeAuthority: TaskWriteAuthorityPort;
}

/** Atomic write boundary. Guarantees atomicity only; isolation/locking
 *  obligations (if any) are expressed on the scope's methods. Deferred policy
 *  — this domain has no cross-process writer contention (#task:1980). */
export interface TaskUnitOfWork {
  atomically<T>(
    writeAuthority: TaskWriteAuthorityPort,
    fn: (tx: TaskTxScope) => T,
  ): T;
}

/** Driver-free sentinel raised by the persistence adapter when a create
 *  collides with a permanent 1:1 provenance key (`source_message_id` unique
 *  index). The adapter translates the driver's uniqueness violation into this
 *  application-facing signal; service code NEVER parses driver error codes or
 *  uniqueness messages (#task:1980 P1-1). */
export class TaskSourceConflictError extends Error {
  constructor(readonly sourceMessageId: string) {
    super(`task source conflict: ${sourceMessageId}`);
    this.name = 'TaskSourceConflictError';
  }
}

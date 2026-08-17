import {
  requireWorkspacePlacement,
  type ClaimErrorCode,
  type ClaimResultEntry,
  type CreateTasksResult,
  type MessageDto,
  type TaskAssigneeDto,
  type TaskBoardColumnDto,
  type TaskBoardContainer,
  type TaskBoardCountsDto,
  type TaskBoardFacetsDto,
  type TaskDetailDto,
  type TaskEditResult,
  type TaskMutationResult,
  type TaskStatus,
  type TaskSummaryDto,
  type TaskSystemActor,
  taskSystemSubtype,
} from '@silverhand/shared';
import type {
  TaskBoardReadModelPort,
  TaskConversationAccessPort,
  TaskRepoReadPort,
  TaskTxScope,
  TaskUnitOfWork,
  TaskWriteAuthorityPort,
} from './task/ports.js';
import { TaskSourceConflictError } from './task/ports.js';
import type { TaskBoardColumnRequest } from './task/board.js';
import { TaskAccessControl } from './task/access.js';
import { TaskAccessPolicy } from './task/access-policy.js';
import { TaskBroadcaster, type TaskEventArgs, type TaskWorkflowKind } from './task/broadcaster.js';
import type { TaskBoardPopulationFilters } from './task/board.js';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import {
  failClaim,
  mutationFailure,
  VALID_TRANSITIONS,
  type AgentActor,
  type AgentCapabilityChecker,
  type AgentTaskRef,
  type ClaimTaskInput,
  type CreateTasksInput,
  type EditTaskInput,
  type ListTasksFilters,
  type TaskActor,
  type UnclaimTaskInput,
  type UpdateStatusInput,
  type UserActor,
  type UserTaskRef,
  type WorkspaceSelector,
} from './task/contracts.js';

/** Composition options for TaskService (#task:1980). The service holds NO raw
 *  DB capability: reads through the injected read port, board through the
 *  read-model port, mutations through the UnitOfWork; concrete repos (agents /
 *  workspaces) arrive injected for pure orchestration reads (never inside a
 *  transaction callback). */
export interface TaskServiceOptions {
  /** Driver-free task read face — the only tasks capability outside a tx. */
  read: TaskRepoReadPort;
  /** Board read-model (human bounded faces). */
  board: TaskBoardReadModelPort;
  /** Named narrow conversation access (agent + human membership). */
  conversations: TaskConversationAccessPort;
  /** Atomic write boundary; mutations go through `uow.atomically`. */
  uow: TaskUnitOfWork;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
  /**
   * Agent-capability gate (graded-permissions cut 2). Injected — not
   * re-implemented here — so the agent_home exemption and table lookup
   * have a SINGLE source (`canAgentUseCapability`). Evaluated on the
   * task's RESOLVED workspace, which only the service knows (message-id
   * claims land in the message's workspace, not the principal's).
   */
  canUseCapability: AgentCapabilityChecker;
  /** The canonical conversation WRITE decision. It is passed into every task
   * UoW and evaluated there against the task owner's conversation, so a peer
   * deleted after route/precheck but before the transaction still closes the
   * write. Never replace this with a task-local endpoint/tombstone predicate. */
  canPostToConversation: (
    actor:
      | { kind: 'user'; userId: string }
      | { kind: 'agent'; agentId: string; conversationId: string },
    conversationId: string,
  ) => boolean;
}

// Public contract surface re-exported so external importers keep resolving
// these from `services/task-service.js` unchanged (they now live in the
// contracts module split out of this file).
export type {
  AgentCapabilityChecker,
  ClaimTaskInput,
  CreateTasksInput,
  EditTaskInput,
  ListTasksFilters,
  TaskActor,
  UnclaimTaskInput,
  UpdateStatusInput,
  WorkspaceSelector,
} from './task/contracts.js';

/** Failure envelope from the agent detail-workspace resolver. */
/** In-tx sentinel for the P0-e survivor-readonly refusal on create (review
 *  B2): thrown inside the UnitOfWork so the whole batch rolls back, mapped to
 *  the typed `conversation_readonly` op error at the boundary. */
class TaskDestinationReadonlyError extends Error {
  constructor() {
    super('destination conversation is read-only (gone direct-pair endpoint)');
  }
}

export type AgentDetailWorkspaceFailure = {
  code:
    | 'conversation_not_found'
    | 'unknown_workspace'
    | 'ambiguous_workspace'
    | 'workspace_membership_required';
  reason: string;
  candidates?: string[];
};

/** A committed task snapshot built inside a mutation transaction, BEFORE the
 *  owner conversation is resolved. The post-commit broadcast injects
 *  `conversation`; the transaction never fabricates one. */
type PendingTaskEvent = Omit<TaskEventArgs, 'conversation'>;

/** The workflow subset (claim/unclaim/status) — the only kinds `publish`
 *  accepts. Narrowing here keeps the post-commit publish call type-safe: an
 *  edit can never be routed through the all-member deliver loop. */
type PendingWorkflowEvent = Omit<PendingTaskEvent, 'kind'> & { kind: TaskWorkflowKind };

/**
 * TaskService is the single owner of task create / claim / unclaim / status /
 * edit side effects over the first-class `tasks` aggregate (v60). Routes
 * translate auth + input shape and call one method per op, parameterized by
 * `actor`. Bulk fan-out (claim of multiple task numbers) lives in the agent
 * route, not here — the service is single-target.
 *
 * Identity model (H3): the canonical task key is `tasks.id`. HUMAN routes key
 * by `taskId` (the REST path param, from the board DTO); the AGENT CLI keys by
 * `task_number` (+ an optional workspace selector), the human/agent-facing
 * resolver. A message id NEVER selects a task — it may only name a source /
 * navigation ref.
 *
 * Contract (#task:1980):
 * - The service holds NO raw DB capability: reads go through the injected
 *   `TaskRepoReadPort`, and every mutating op runs validate + write inside ONE
 *   `uow.atomically` scope. Write capability exists only on `TaskTxScope`.
 * - task mutation + system-event insert are in the SAME atomic scope and roll
 *   back together (no half-success: a failed event insert leaves the task
 *   unchanged and emits no external effect). publish/deliver/cross-op audit
 *   are strictly post-commit via `TaskBroadcaster`.
 * - For agent claim/unclaim/status/edit/detail, a task number resolves through
 *   an explicit workspace selector or a ConversationSlot's placement-derived
 *   board. AgentSlot has no ambient board and must provide the selector.
 * - `create` is the EXCEPTION: its target workspace is the one owning the
 *   required absolute destination address. The
 *   route authorizes that destination directly (workspace access + destination
 *   membership) and gates `create_tasks` / `write_tasks` on ITS workspace, NOT
 *   the origin's. Do not re-add an origin-conversation gate here on that basis.
 *
 * This class is the task-lifecycle aggregate root. Peripheral concerns are
 * delegated to `TaskAccessControl` (pre-tx actor / workspace authorization),
 * the injected read/board ports, and `TaskBroadcaster` (post-commit
 * `task_changed`, delivery, cross-op audit).
 */
export class TaskService {
  private readonly read: TaskRepoReadPort;
  private readonly board: TaskBoardReadModelPort;
  private readonly conversations: TaskConversationAccessPort;
  private readonly uow: TaskUnitOfWork;
  private readonly agents: TaskServiceOptions['agents'];
  private readonly workspaces: TaskServiceOptions['workspaces'];
  private readonly canUseCapability: AgentCapabilityChecker;
  private readonly writeAuthority: TaskWriteAuthorityPort;
  private readonly access: TaskAccessControl;
  private readonly accessPolicy: TaskAccessPolicy;
  private readonly broadcaster: TaskBroadcaster;

  constructor(opts: TaskServiceOptions) {
    this.read = opts.read;
    this.board = opts.board;
    this.conversations = opts.conversations;
    this.uow = opts.uow;
    this.agents = opts.agents;
    this.workspaces = opts.workspaces;
    this.canUseCapability = opts.canUseCapability;
    this.writeAuthority = {
      canPostToConversation: (actor, conversationId) =>
        opts.canPostToConversation(
          // The task UoW has already re-proved that this agent participates in
          // the task OWNER conversation. Bind the canonical conversation write
          // decision to that owner rather than to the CLI frame: the latter is
          // only a route coordinate for AgentSlot and for the legacy explicit
          // cross-conversation create lane. This does not copy the DirectPair
          // tombstone rule — `canPostToConversation` remains its sole owner.
          actor.kind === 'agent'
            ? { kind: 'agent', agentId: actor.agentId, conversationId }
            : actor,
          conversationId,
        ),
    };
    this.access = new TaskAccessControl({
      agents: opts.agents,
      conversations: opts.conversations,
      workspaces: opts.workspaces,
      taskBoards: opts.read,
    });
    this.accessPolicy = new TaskAccessPolicy(opts.conversations, opts.canUseCapability);
    this.broadcaster = new TaskBroadcaster({
      conversations: opts.conversations,
      runtimeHost: opts.runtimeHost,
      events: opts.events,
      logger: opts.logger,
    });
  }

  // ── Read ─────────────────────────────────────────────────────────

  list(filters: ListTasksFilters): TaskSummaryDto[] {
    // The agent arm reads BOARDS (P0-f): the service is the one place that
    // turns an actor + optional (route-validated) workspace filter into the
    // board-key set the repo consumes.
    if (filters.actor.kind === 'agent') {
      const actor = filters.actor;
      let boardKeys: string[];
      if (filters.workspaceId !== undefined) {
        // Explicit selector: the route already validated existence +
        // membership + read_tasks. Only WorkspaceBoards are selectable — a
        // pair board has no name to select (§7.2.1).
        boardKeys = [`ws:${filters.workspaceId}`];
      } else if (actor.runtimeScope === 'agent') {
        // §7.2.2: the agent-slot default is the UNION of every board the
        // actor can read — workspace boards (listForAgent membership ∧
        // per-board read_tasks, with the agent_home implicit-owner arm) plus
        // every DirectPair board the agent is an endpoint of (participation
        // IS the read authority on a pair board, P0-f).
        boardKeys = [
          ...this.workspaces
            .listForAgent(actor.agentId)
            .filter(ws => this.canUseCapability(actor, ws.id, 'read_tasks'))
            .map(ws => `ws:${ws.id}`),
          ...this.read.listAgentDirectPairBoardKeys(actor.agentId),
        ];
      } else {
        // Conversation frame: the ambient board is the frame conversation's
        // placement-derived board (a DM frame reads its own pair board). A
        // frame with no board — inbox — derives null; the route's typed
        // refusal fires first, so this arm reads as zero rows defensively.
        const board = this.read.boardOfConversation(actor.conversationId);
        boardKeys = board ? [board.boardKey] : [];
      }
      return this.read.list({ ...filters, boardKeys });
    }
    return this.read.list(filters);
  }

  getById(taskId: string, actor: TaskActor): TaskSummaryDto | null {
    return this.read.getById(taskId, actor);
  }

  /** The board a conversation's placement yields, or null when it has none
   *  (P0-f §4.4). Exposed for the route layer's destination gate. */
  boardOfConversation(
    conversationId: string,
  ): { boardKey: string; workspaceId: string | null } | null {
    return this.read.boardOfConversation(conversationId);
  }

  // ── Human board reads (#task:1884, #task:2037) ──────────────────
  //
  // Three bounded faces replacing the board's fetch-all. They are HUMAN-only,
  // and their viewer gate is the ONE placement-participation authority
  // (`conversation-placement-sql.ts`): a task is visible to a human exactly
  // when they participate in its conversation's placement — a workspace-member
  // arm AND a direct-pair-endpoint arm, so a rosterless human↔agent DM resolves
  // too (never a bare `conversation_users` semi-join, which was blind to the
  // pair). They carry no lifecycle policy — hence a straight delegation to the
  // injected read-model port.

  boardColumn(req: TaskBoardColumnRequest): TaskBoardColumnDto {
    return this.board.column(req);
  }

  boardCounts(filters: TaskBoardPopulationFilters): TaskBoardCountsDto {
    return this.board.counts(filters);
  }

  boardFacets(
    viewerUserId: string,
    container?: TaskBoardContainer | undefined,
  ): TaskBoardFacetsDto {
    return this.board.facets(viewerUserId, container);
  }

  // ── Create ──────────────────────────────────────────────────────

  async createTasks(input: CreateTasksInput): Promise<CreateTasksResult> {
    // NOTE: `input.conversationId` is the DESTINATION conversation, which the
    // agent route resolves from the required `target` address (#task:2021 P4-4)
    // and the human route takes from its explicit selector. C″ deliberately
    // permits established cross-stream task create, so it need not equal a
    // ConversationSlot actor's coordinate. The
    // membership floor below (agent :getAgent / human :userCanAccessConversation,
    // both against the destination) is the authorization boundary; the route has
    // already run a create-specific narrow check against the destination.
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) return { error: 'conversation_not_found' };
    if (conversation.closed_at !== null) return { error: 'conversation_closed' };
    // Same write-invariant the ordinary message path enforces
    // (conversation-message-service): a task create writes a `task_create`
    // system event into the conversation, so an ARCHIVED (read-only) target is
    // refused for BOTH actors here — not in a human-only route layer — or the
    // agent path would keep landing rows + events in an archived conversation.
    if (conversation.archived_at !== null) return { error: 'conversation_archived' };
    if (input.actor.kind === 'agent') {
      if (!this.agents.get(input.actor.agentId)) {
        return { error: 'agent_not_found' };
      }
      // Placement-aware participation (P0-f): a DirectPair endpoint has no
      // roster row, so the roster-shaped getAgent would wrongly refuse the
      // pair's own endpoints — the canonical port carries all arms.
      if (!this.conversations.isAgentParticipant(input.conversationId, input.actor.agentId)) {
        return { error: 'not_conversation_member' };
      }
      // P0-e survivor-readonly (review B2), pre-tx SHAPE only — the write
      // authority is the same predicate re-proven inside the transaction.
      if (!this.writeAuthority.canPostToConversation(input.actor, input.conversationId)) {
        return { error: 'conversation_readonly' };
      }
    } else {
      // Human actor: the SAME conversation-membership floor the agent branch
      // enforces (defense-in-depth behind the route's `canPostToConversation`
      // gate). Creating a task writes a `task_create` system event into the
      // conversation, so it follows the post/membership boundary — a non-member,
      // INCLUDING a public-channel viewer, is refused fail-closed rather than
      // relying on the route alone. Symmetric branch, not a parallel flow.
      if (!this.conversations.userCanAccessConversation(input.actor.userId, input.conversationId)) {
        return { error: 'not_conversation_member' };
      }
    }
    // Where the notices land inside the destination. The agent door resolved it
    // out of the same address as `conversationId` (a cluster ROOT of THAT
    // conversation, never a mid-cluster reply widened to one); the human door
    // files on the main line. Re-fetching the message to re-decide that would be a
    // second opinion on a question this aggregate does not own — and the two would
    // then be able to disagree. What the DB still guarantees underneath is
    // existence alone (`messages.thread_root_id` is a self-FK, so an id that names
    // no message aborts the write); belonging-to-this-conversation and
    // being-a-root are the resolver's, and it is the only caller that can supply a
    // non-null value here (#task:2021 P4-4).
    const threadRootId: string | null = input.threadRootId ?? null;

    // The BOARD is placement-derived (P0-f §4.4): a workspace conversation
    // files onto its WorkspaceBoard, a DirectPair onto its own board, and the
    // agent inbox has none — the route folds inbox destinations before this
    // service runs, and the persistence write re-derives the board with the
    // v76 trigger as the proof, so a boardless destination cannot slip
    // through to a row.
    const taskWorkspaceId = conversation.workspace_id;

    // Pre-txn source validation. `source_message_id` is a permanent 1:1
    // provenance identity: the source must exist, live in the SAME conversation
    // as the task (v1 contract — so the `linked_task` chip on the source row and
    // the task's own conversation events converge in one place), be readable by
    // the actor, and not already back another task. The UNIQUE index is the race
    // backstop below — it also covers one batch naming the same source twice (the
    // 2nd INSERT collides and rolls the whole batch back), so no separate typed
    // pre-check for it.
    for (const t of input.tasks) {
      if (!t.sourceMessageId) continue;
      const srcErr = this.validateTaskSource(input.actor, t.sourceMessageId, input.conversationId);
      if (srcErr) return srcErr;
    }

    // Atomic self-claim only when an agent explicitly asked for it. Humans
    // create unassigned; a user actor's `claim` is meaningless and ignored.
    const claimByAgentId =
      input.claim && input.actor.kind === 'agent' ? input.actor.agentId : null;
    const status: TaskStatus = claimByAgentId ? 'in_progress' : 'todo';
    const assignee = claimByAgentId ? this.assigneeDtoForAgent(claimByAgentId) : null;
    const actorLabel = this.actorLabel(input.actor);
    const creatorKind = input.actor.kind;
    const creatorAgentId = input.actor.kind === 'agent' ? input.actor.agentId : null;
    const creatorUserId = input.actor.kind === 'user' ? input.actor.userId : null;
    // Cross-conversation create: a ConversationSlot (an actor ANCHORED to an
    // origin stream) filed against a different stream. The bit is DEFINED ONLY
    // for `runtimeScope === 'conversation'` — it compares that anchor with the
    // destination. An AgentSlot has NO origin stream (`conversationId` is null),
    // so the comparison is undefined for it, and its correct rendering is
    // ABSENT: a plain `created` narration, never "from another conversation"
    // (an AgentSlot filing on its own DM has no other conversation to have come
    // from — writing "from another conversation" would state a falsehood).
    // Humans likewise have no origin. This drives the single-source
    // `cross_conversation` metadata bit AND the agent-facing narration below;
    // it carries no origin id/title (privacy invariant). A cross-conversation
    // create can never be claimed (the route rejects `--claim` + cross with
    // `cross_conversation_claim`), so it has no "and claimed it" variant.
    const crossConversation =
      input.actor.kind === 'agent' &&
      input.actor.runtimeScope === 'conversation' &&
      input.actor.conversationId !== input.conversationId;
    const now = Date.now();
    // Event actor resolution is DB-backed (agents lookup) — precomputed as a
    // PURE VALUE before the transaction; the callback never captures a repo.
    const systemActor = this.taskSystemActorFor(input.actor);

    // H4: task row + task_create event + created_event backfill in ONE txn (the
    // whole batch is atomic, so a source-uniqueness collision rolls it all
    // back). Delivery/publish fire only after commit.
    type Created = {
      out: { id: string; task_number: number; title: string };
      sysMsg: MessageDto;
      eventArgs: TaskEventArgs & { kind: 'create' };
    };
    let created: Created[];
    try {
      created = this.uow.atomically(this.writeAuthority, tx => {
        // P0-e survivor-readonly, proven INSIDE the tx (review B2): a peer
        // hard-deleted between the pre-tx shape check and this write must
        // still abort — nothing writes a task row or its system event into a
        // read-only pair.
        if (!tx.writeAuthority.canPostToConversation(input.actor, input.conversationId)) {
          throw new TaskDestinationReadonlyError();
        }
        const rows: Created[] = [];
        for (const t of input.tasks) {
          const content = t.body && t.body.length > 0 ? t.body : '';
          const { id, taskNumber } = tx.tasks.createTaskRow({
            conversationId: input.conversationId,
            threadRootId,
            title: t.title,
            content,
            creatorKind,
            creatorAgentId,
            creatorUserId,
            sourceMessageId: t.sourceMessageId ?? null,
            claimByAgentId,
            createdAt: now,
          });
          const eventArgs: TaskEventArgs & { kind: 'create' } = {
            conversation,
            kind: 'create',
            taskId: id,
            taskNumber,
            title: t.title,
            status,
            assignee,
            closedAt: null,
            sourceMessageId: t.sourceMessageId ?? null,
            threadRootId,
          };
          const sysMsg = tx.systemEvents.insert({
            conversationId: input.conversationId,
            threadRootId,
            content: crossConversation
              ? `${actorLabel} filed task #${taskNumber} "${t.title}" here from another conversation`
              : claimByAgentId
                ? `${actorLabel} created task #${taskNumber} "${t.title}" and claimed it`
                : `${actorLabel} created task #${taskNumber} "${t.title}"`,
            metadata: this.taskSystemEventMetadata(
              'create',
              eventArgs,
              systemActor,
              crossConversation ? { cross_conversation: true } : undefined,
            ),
          });
          tx.tasks.backfillCreatedEvent(id, sysMsg.id);
          rows.push({ out: { id, task_number: taskNumber, title: t.title }, sysMsg, eventArgs });
        }
        return rows;
      });
    } catch (e) {
      if (e instanceof TaskDestinationReadonlyError) {
        return { error: 'conversation_readonly' };
      }
      // The persistence adapter translates a UNIQUE(source_message_id)
      // collision into the driver-free `TaskSourceConflictError` — the
      // service never parses driver error codes or uniqueness messages. Map
      // to the typed conflict pointing at the winner (the concurrent create
      // that bound the same source between our pre-check and this txn)
      // instead of leaking a driver error.
      if (e instanceof TaskSourceConflictError) {
        const existing = this.read.fetchTaskBySourceMessageId(e.sourceMessageId);
        return existing
          ? { error: 'source_conflict', existing_task: existing }
          : { error: 'source_conflict' };
      }
      throw e;
    }

    for (const c of created) {
      this.broadcaster.publish(c.eventArgs, c.sysMsg);
    }

    // Cross-conversation create audit. When an agent creates task(s) in a
    // DIFFERENT conversation than the one it is running in (explicit target),
    // leave one audit line per task recording origin
    // (source = the agent's own conversation) → owner (the destination). Human
    // actors have no origin conversation, so no cross-op audit — mirroring
    // claim/unclaim/status. Same-conversation default creates emit nothing:
    // auditCrossOp early-returns when sourceConv.id === ownerConv.id.
    if (
      input.actor.kind === 'agent'
      && input.actor.runtimeScope === 'conversation'
    ) {
      const sourceConv = this.conversations.get(input.actor.conversationId);
      if (sourceConv) {
        for (const c of created) {
          this.broadcaster.auditCrossOp({
            op: 'create',
            actor: input.actor,
            sourceConv,
            ownerConv: conversation,
            taskNumber: c.out.task_number,
            taskBoardKey: this.read.boardOfConversation(conversation.id)?.boardKey ?? 'unknown',
          });
        }
      }
    }

    return { tasks: created.map(c => c.out) };
  }

  /** Pre-txn validation of a `source_message_id`. Returns a typed failure to
   *  short-circuit `createTasks`, or null when the source is usable. */
  private validateTaskSource(
    actor: TaskActor,
    sourceMessageId: string,
    taskConversationId: string,
  ): CreateTasksResult | null {
    const src = this.read.fetchMessageRef(sourceMessageId);
    if (!src) return { error: 'source_message_not_found' };
    // v1 contract: the source lives in the SAME conversation as the task, so the
    // `linked_task` chip on the source row and the task's own conversation
    // events converge in one place (a sibling-conversation source could never
    // receive the task's live projection). Same-conversation subsumes the old
    // same-workspace check.
    if (src.conversation_id !== taskConversationId) {
      return { error: 'source_conversation_mismatch' };
    }
    const accessible =
      actor.kind === 'agent'
        ? // Placement-aware participation (review B3): a DirectPair endpoint
          // has no roster row, so the roster-shaped getAgent would refuse a
          // DM's own message as a task source.
          this.conversations.isAgentParticipant(src.conversation_id, actor.agentId)
        : this.conversations.userCanAccessConversation(actor.userId, src.conversation_id);
    if (!accessible) return { error: 'source_not_accessible' };
    const existing = this.read.fetchTaskBySourceMessageId(sourceMessageId);
    if (existing) {
      return { error: 'source_conflict', existing_task: existing };
    }
    return null;
  }

  // ── Claim ───────────────────────────────────────────────────────

  async claimTask(input: ClaimTaskInput): Promise<ClaimResultEntry> {
    if (input.actor.kind === 'agent') {
      return this.claimTaskAgent(
        input.actor,
        input.by as AgentTaskRef,
        input.assignee,
        (input as Extract<ClaimTaskInput, { actor: AgentActor }>).workspaceSelector,
      );
    }
    const userInput = input as Extract<ClaimTaskInput, { actor: UserActor }>;
    return this.claimTaskUser(userInput.actor, userInput.by, userInput.assignee);
  }

  private async claimTaskAgent(
    actor: AgentActor,
    by: AgentTaskRef,
    assignee: { agentId: string } | undefined,
    workspaceSelector: WorkspaceSelector | undefined,
  ): Promise<ClaimResultEntry> {
    // P0-g (#task:2018): a conversation-frame principal has NO by-id mutation
    // surface — that lane belongs to the agent-slot principal (P1). The
    // rejection is the UNIFORM indistinguishable envelope: unknown id,
    // unauthorized id, and this closed surface all answer identically, so the
    // selector never becomes an existence oracle. `id` echoes the caller's
    // own input (batch correlation, no disclosure).
    if ('taskId' in by && actor.runtimeScope !== 'agent') {
      return failClaim({ code: 'task_not_found', reason: 'task not found', id: by.taskId });
    }
    if (assignee && assignee.agentId !== actor.agentId) {
      return failClaim({
        code: 'not_self_assignment',
        reason: 'agent can only claim tasks for itself',
      });
    }
    const sourceConv = actor.conversationId === null
      ? null
      : this.conversations.get(actor.conversationId);
    if (actor.runtimeScope === 'conversation' && !sourceConv) {
      return failClaim({ code: 'conversation_not_found', reason: 'conversation not found' });
    }
    const actorErr = this.access.validateAgentActorForClaim(actor);
    if (actorErr) return actorErr;

    // The number arm's board coordinate (resolved + authorized pre-tx). The id
    // arm carries NO coordinates out of its precheck — the transaction below
    // re-resolves by the canonical id itself (B5): flattening the id into
    // (workspace, number) here would let a precheck-to-tx race retarget the
    // write onto a reallocated number.
    let numberArmBoardKey: string | null = null;
    if ('taskId' in by) {
      // Agent-slot global-id arm (§4.5): resolve by identity, gate through the
      // ONE TaskAccessPolicy (participation in the task's own conversation ∧
      // write_tasks on its board). EVERY failure — unknown id, non-participant,
      // missing capability — is the same envelope as above; post-gate workflow
      // failures below stay typed (the caller is already authorized to see the
      // task).
      const row = this.read.fetchTaskById(by.taskId);
      if (!row || !this.accessPolicy.canAgentSeeTask(actor, row, 'write_tasks')) {
        return failClaim({ code: 'task_not_found', reason: 'task not found', id: by.taskId });
      }
    } else {
      const resolved = this.access.resolveAgentTaskBoard(
        actor,
        sourceConv,
        workspaceSelector,
        args =>
          failClaim({ code: args.code, reason: args.reason, workspaceCandidates: args.candidates }),
      );
      if ('failure' in resolved) return resolved.failure;
      numberArmBoardKey = resolved.boardKey;

      // Claim is pure mutation (it never creates a task), so it needs
      // `write_tasks` only. Typed denial, never downgraded to task_not_found —
      // this addresses the board the CALLER itself named (§4.5 asymmetry).
      if (
        resolved.kind === 'workspace' &&
        !this.canUseCapability(actor, resolved.workspace.id, 'write_tasks')
      ) {
        return failClaim({
          code: 'capability_denied',
          capability: 'write_tasks',
          reason: 'agent lacks the write_tasks capability in the target workspace',
        });
      }
    }

    // DB-backed event inputs, precomputed as PURE VALUES before the transaction
    // (#task:1980 P1-2 — callbacks never capture a repo).
    const actorLabel = this.actorLabel(actor);
    const assigneeDto = this.assigneeDtoForAgent(actor.agentId);
    const systemActor = this.taskSystemActorFor(actor);

    type ClaimTxOut =
      | { failure: ClaimResultEntry }
      | { success: true; args: PendingWorkflowEvent; sysMsg: MessageDto; conversationId: string };

    const txOut = this.uow.atomically(this.writeAuthority, (tx): ClaimTxOut => {
      // B5: the write authority is the ORIGINAL selector. The id arm re-reads
      // by canonical `tasks.id` inside the transaction — never a flattened
      // (workspace, number) that a reallocated number could retarget.
      const row = 'taskId' in by
        ? tx.tasks.fetchTaskById(by.taskId)
        : tx.tasks.fetchTaskByNumber(numberArmBoardKey!, by.taskNumber);
      if (!row) {
        return { failure: 'taskId' in by
          ? failClaim({ code: 'task_not_found', reason: 'task not found', id: by.taskId })
          : failClaim({
              code: 'task_not_found',
              reason: 'task not found',
              taskNumber: by.taskNumber,
            }) };
      }
      // Per-task ACL on the WRITE face (#task:2018 B2, §4.4): board
      // coordinate + capability are not an ACL. Participation in the task's
      // own conversation is judged BEFORE any workflow fact (status/assignee)
      // can leak, and non-participation folds into the SAME envelope as a
      // miss — a guessed number discloses nothing.
      if (!tx.conversationAccess.isAgentParticipant(row.conversation_id, actor.agentId)) {
        return { failure: 'taskId' in by
          ? failClaim({ code: 'task_not_found', reason: 'task not found', id: by.taskId })
          : failClaim({
              code: 'task_not_found',
              reason: 'task not found',
              taskNumber: by.taskNumber,
            }) };
      }
      // P0-e survivor-readonly (review B2), proven INSIDE the write tx: a
      // gone endpoint makes the pair read-only for everyone — the claim would
      // write a system event into it. Typed (the caller already sees the
      // task); pre-tx checks only shape errors, never authorize the write.
      if (!tx.writeAuthority.canPostToConversation(actor, row.conversation_id)) {
        return { failure: failClaim({
          code: 'conversation_readonly',
          reason: 'the conversation is read-only: a direct-pair endpoint is gone',
          taskNumber: row.task_number,
        }) };
      }
      if (row.status === 'done' || row.status === 'closed') {
        return { failure: failClaim({
          code: row.status === 'closed' ? 'task_closed' : 'task_done',
          reason: row.status === 'closed' ? 'task is closed' : 'task is already done',
          taskNumber: row.task_number,
        }) };
      }
      const changes = tx.tasks.assignSelf(row.id, actor.agentId);
      if (changes === 0) {
        const cur = tx.tasks.readAssignment(row.id);
        // Either assignee column makes the task taken. A user assignee only
        // exists on migrated rows, and its identity is not this agent's
        // business — report the generic "already assigned" fact.
        const takenByAgent = cur?.assignee_agent_id ?? null;
        const taken = Boolean(takenByAgent) || Boolean(cur?.assignee_user_id);
        const code: ClaimErrorCode = taken
          ? 'already_claimed'
          : cur?.status === 'closed'
            ? 'task_closed'
            : 'task_done';
        return { failure: failClaim({
          code,
          reason: takenByAgent
            ? `already claimed by ${takenByAgent}`
            : taken
              ? 'task is already assigned'
              : `task is ${cur?.status ?? 'unknown'}`,
          taskNumber: row.task_number,
        }) };
      }
      const nextStatus: TaskStatus = row.status === 'todo' ? 'in_progress' : row.status;
      const pending: PendingWorkflowEvent = {
        kind: 'claim',
        taskId: row.id,
        taskNumber: row.task_number,
        title: row.title,
        status: nextStatus,
        assignee: assigneeDto,
        closedAt: row.closed_at,
        sourceMessageId: row.source_message_id,
        threadRootId: row.thread_root_id,
      };
      return this.finishWorkflowTx(tx, pending, actor, systemActor,
        `${actorLabel} claimed task #${row.task_number}`, row.conversation_id);
    });

    if ('failure' in txOut) return txOut.failure;

    const ownerConv =
      sourceConv !== null && txOut.conversationId === sourceConv.id
        ? sourceConv
        : this.conversations.get(txOut.conversationId);
    if (!ownerConv) {
      return failClaim({
        code: 'conversation_not_found',
        reason: 'task owner conversation vanished after commit',
      });
    }
    if (sourceConv !== null) {
      this.broadcaster.auditCrossOp({
        op: 'claim',
        actor,
        sourceConv,
        ownerConv,
        taskNumber: txOut.args.taskNumber,
        // The task's board coordinate, post-commit truth: derived from its owner
        // conversation's placement (total over workspace AND pair boards).
        taskBoardKey: this.read.boardOfConversation(ownerConv.id)?.boardKey ?? 'unknown',
      });
    }
    this.broadcaster.publish({ ...txOut.args, conversation: ownerConv }, txOut.sysMsg);

    return { success: true, task_number: txOut.args.taskNumber, id: txOut.args.taskId };
  }

  private async claimTaskUser(
    actor: UserActor,
    by: UserTaskRef,
    assignee: { agentId: string },
  ): Promise<ClaimResultEntry> {
    // Assignee existence is DB-backed; precomputed BEFORE the transaction.
    if (!this.agents.get(assignee.agentId)) {
      return failClaim({
        code: 'assignee_not_conversation_member',
        reason: 'agent not found',
      });
    }
    const agentLabel = this.agentName(assignee.agentId);
    const assigneeDto = this.assigneeDtoForAgent(assignee.agentId);
    const systemActor = this.taskSystemActorFor(actor);

    type UserClaimTxOut =
      | { failure: ClaimResultEntry }
      | { success: true; args: PendingWorkflowEvent; sysMsg: MessageDto; conversationId: string };

    const txOut = this.uow.atomically(this.writeAuthority, (tx): UserClaimTxOut => {
      const row = tx.tasks.fetchTaskById(by.taskId);
      if (!row || !tx.conversationAccess.userCanAccessConversation(actor.userId, row.conversation_id)) {
        return { failure: failClaim({ code: 'task_not_found', reason: 'task not found' }) };
      }
      // P0-e survivor-readonly (review B2): in-tx, typed — no writer, human
      // included, may add a system event to a read-only pair.
      if (!tx.writeAuthority.canPostToConversation(actor, row.conversation_id)) {
        return { failure: failClaim({ code: 'conversation_readonly', reason: 'the conversation is read-only: a direct-pair endpoint is gone' }) };
      }
      if (row.status === 'done' || row.status === 'closed') {
        return { failure: failClaim({
          code: row.status === 'closed' ? 'task_closed' : 'task_done',
          reason: row.status === 'closed' ? 'task is closed' : 'task is done',
          taskNumber: row.task_number,
        }) };
      }
      if (!tx.conversationAccess.getAgent(row.conversation_id, assignee.agentId)) {
        return { failure: failClaim({
          code: 'assignee_not_conversation_member',
          reason: "agent is not a member of this task's conversation",
        }) };
      }
      // Human dispatch: handing a `todo` task to an agent starts it, in the same
      // transaction as the assignment — `todo + assignee` has no legal exit.
      // A task already running or in review only changes hands.
      const nextStatus: TaskStatus = row.status === 'todo' ? 'in_progress' : row.status;
      tx.tasks.dispatchToAgent(row.id, assignee.agentId);
      const pending: PendingWorkflowEvent = {
        kind: 'claim',
        taskId: row.id,
        taskNumber: row.task_number,
        title: row.title,
        status: nextStatus,
        assignee: assigneeDto,
        closedAt: row.closed_at,
        sourceMessageId: row.source_message_id,
        threadRootId: row.thread_root_id,
      };
      return this.finishWorkflowTx(tx, pending, actor, systemActor,
        `task #${row.task_number} assigned to @${agentLabel} (by user)`, row.conversation_id);
    });

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      this.broadcaster.publish({ ...txOut.args, conversation }, txOut.sysMsg);
    }

    return { success: true, task_number: txOut.args.taskNumber, id: txOut.args.taskId };
  }

  // ── Unclaim ─────────────────────────────────────────────────────

  async unclaimTask(input: UnclaimTaskInput): Promise<TaskMutationResult> {
    if (input.actor.kind === 'agent') {
      return this.unclaimTaskAgent(
        input.actor,
        input.by as AgentTaskRef,
        (input as Extract<UnclaimTaskInput, { actor: AgentActor }>).workspaceSelector,
      );
    }
    return this.unclaimTaskUser(input.actor, input.by as UserTaskRef);
  }

  private async unclaimTaskAgent(
    actor: AgentActor,
    by: AgentTaskRef,
    workspaceSelector: WorkspaceSelector | undefined,
  ): Promise<TaskMutationResult> {
    // P0-g (#task:2018): no by-id mutation surface for a conversation-frame
    // principal — uniform indistinguishable rejection (see claimTaskAgent).
    if ('taskId' in by && actor.runtimeScope !== 'agent') {
      return { success: false, code: 'task_not_found', reason: 'task not found' };
    }
    const sourceConv = actor.conversationId === null
      ? null
      : this.conversations.get(actor.conversationId);
    if (actor.runtimeScope === 'conversation' && !sourceConv) {
      return { success: false, code: 'conversation_not_found', reason: 'conversation not found' };
    }
    const actorErr = this.access.validateAgentActorForMutation(actor);
    if (actorErr) return actorErr;

    let numberArmBoardKey: string | null = null;
    if ('taskId' in by) {
      // Agent-slot global-id arm (§4.5) — see claimTaskAgent. No coordinates
      // leave this precheck (B5): the tx below re-reads by the canonical id.
      const row = this.read.fetchTaskById(by.taskId);
      if (!row || !this.accessPolicy.canAgentSeeTask(actor, row, 'write_tasks')) {
        return { success: false, code: 'task_not_found', reason: 'task not found' };
      }
    } else {
      const resolved = this.access.resolveAgentTaskBoard(
        actor,
        sourceConv,
        workspaceSelector,
        args => mutationFailure(args),
      );
      if ('failure' in resolved) return resolved.failure;
      numberArmBoardKey = resolved.boardKey;

      if (
        resolved.kind === 'workspace' &&
        !this.canUseCapability(actor, resolved.workspace.id, 'write_tasks')
      ) {
        return mutationFailure({
          code: 'capability_denied',
          capability: 'write_tasks',
          reason: 'agent lacks the write_tasks capability in the target workspace',
        });
      }
    }

    const agentLabel = this.agentName(actor.agentId);
    const systemActor = this.taskSystemActorFor(actor);

    type UnclaimAgentTxOut =
      | { failure: TaskMutationResult }
      | { success: true; args: PendingWorkflowEvent; sysMsg: MessageDto; conversationId: string };

    const txOut = this.uow.atomically(this.writeAuthority, (tx): UnclaimAgentTxOut => {
      // B5: write authority = the ORIGINAL selector (id arm by canonical id).
      const row = 'taskId' in by
        ? tx.tasks.fetchTaskById(by.taskId)
        : tx.tasks.fetchTaskByNumber(numberArmBoardKey!, by.taskNumber);
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      // Per-task ACL on the WRITE face (#task:2018 B2) — before the assignee
      // check can leak workflow state; same envelope as a miss.
      if (!tx.conversationAccess.isAgentParticipant(row.conversation_id, actor.agentId)) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      // P0-e survivor-readonly (review B2): in-tx, typed — see claim.
      if (!tx.writeAuthority.canPostToConversation(actor, row.conversation_id)) {
        return { failure: { success: false, code: 'conversation_readonly', reason: 'the conversation is read-only: a direct-pair endpoint is gone' } };
      }
      if (row.assignee_agent_id !== actor.agentId) {
        return { failure: { success: false, code: 'not_assignee', reason: 'not the assignee' } };
      }
      if (row.status === 'done' || row.status === 'closed') {
        return { failure: {
          success: false,
          code: row.status === 'closed' ? 'task_closed' : 'task_done',
          reason: row.status === 'closed' ? 'task is closed' : 'task is done',
        } };
      }
      tx.tasks.releaseToTodo(row.id);
      const pending: PendingWorkflowEvent = {
        kind: 'unclaim',
        taskId: row.id,
        taskNumber: row.task_number,
        title: row.title,
        status: 'todo',
        assignee: null,
        closedAt: null,
        sourceMessageId: row.source_message_id,
        threadRootId: row.thread_root_id,
      };
      return this.finishWorkflowTx(tx, pending, actor, systemActor,
        `task #${row.task_number} unclaimed (was @${agentLabel})`, row.conversation_id);
    });

    if ('failure' in txOut) return txOut.failure;

    const ownerConv =
      sourceConv !== null && txOut.conversationId === sourceConv.id
        ? sourceConv
        : this.conversations.get(txOut.conversationId);
    if (!ownerConv) {
      return { success: false, code: 'conversation_not_found', reason: 'task owner conversation vanished after commit' };
    }
    if (sourceConv !== null) {
      this.broadcaster.auditCrossOp({
        op: 'unclaim',
        actor,
        sourceConv,
        ownerConv,
        taskNumber: txOut.args.taskNumber,
        // The task's board coordinate, post-commit truth: derived from its owner
        // conversation's placement (total over workspace AND pair boards).
        taskBoardKey: this.read.boardOfConversation(ownerConv.id)?.boardKey ?? 'unknown',
      });
    }
    this.broadcaster.publish({ ...txOut.args, conversation: ownerConv }, txOut.sysMsg);

    return { success: true };
  }

  private async unclaimTaskUser(
    actor: UserActor,
    by: UserTaskRef,
  ): Promise<TaskMutationResult> {
    const systemActor = this.taskSystemActorFor(actor);

    type UnclaimUserTxOut =
      | { failure: TaskMutationResult }
      | { success: true; args: PendingWorkflowEvent; sysMsg: MessageDto; conversationId: string };

    const txOut = this.uow.atomically(this.writeAuthority, (tx): UnclaimUserTxOut => {
      const row = tx.tasks.fetchTaskById(by.taskId);
      if (!row || !tx.conversationAccess.userCanAccessConversation(actor.userId, row.conversation_id)) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      // P0-e survivor-readonly (review B2): in-tx, typed.
      if (!tx.writeAuthority.canPostToConversation(actor, row.conversation_id)) {
        return { failure: { success: false, code: 'conversation_readonly', reason: 'the conversation is read-only: a direct-pair endpoint is gone' } };
      }
      // A terminal task's assignment is frozen for every actor: human `claim`
      // and agent `unclaim` already refuse `done`/`closed`, and the renderer's
      // read-only gate cannot be the guard (the task can reach `done` remotely
      // between render and click). Move the status out of terminal first.
      if (row.status === 'done' || row.status === 'closed') {
        return { failure: {
          success: false,
          code: row.status === 'closed' ? 'task_closed' : 'task_done',
          reason: row.status === 'closed' ? 'task is closed' : 'task is done',
        } };
      }
      // Unassign is ownership-only: `status` / `closed_at` are deliberately left
      // untouched (a dispatched task does not rewind), so the event payload
      // echoes the row as it stands.
      tx.tasks.clearAssignee(row.id);
      const pending: PendingWorkflowEvent = {
        kind: 'unclaim',
        taskId: row.id,
        taskNumber: row.task_number,
        title: row.title,
        status: row.status,
        assignee: null,
        closedAt: row.closed_at,
        sourceMessageId: row.source_message_id,
        threadRootId: row.thread_root_id,
      };
      return this.finishWorkflowTx(tx, pending, actor, systemActor,
        `task #${row.task_number} unassigned (by user)`, row.conversation_id);
    });

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      this.broadcaster.publish({ ...txOut.args, conversation }, txOut.sysMsg);
    }

    return { success: true };
  }

  // ── Update status ──────────────────────────────────────────────

  async updateStatus(input: UpdateStatusInput): Promise<TaskMutationResult> {
    if (input.actor.kind === 'agent') {
      return this.updateStatusAgent(
        input.actor,
        input.by as AgentTaskRef,
        input.status,
        (input as Extract<UpdateStatusInput, { actor: AgentActor }>).workspaceSelector,
      );
    }
    return this.updateStatusUser(input.actor, input.by as UserTaskRef, input.status);
  }

  private async updateStatusAgent(
    actor: AgentActor,
    by: AgentTaskRef,
    status: TaskStatus,
    workspaceSelector: WorkspaceSelector | undefined,
  ): Promise<TaskMutationResult> {
    // P0-g (#task:2018): no by-id mutation surface for a conversation-frame
    // principal — uniform indistinguishable rejection (see claimTaskAgent).
    if ('taskId' in by && actor.runtimeScope !== 'agent') {
      return { success: false, code: 'task_not_found', reason: 'task not found' };
    }
    const sourceConv = actor.conversationId === null
      ? null
      : this.conversations.get(actor.conversationId);
    if (actor.runtimeScope === 'conversation' && !sourceConv) {
      return { success: false, code: 'conversation_not_found', reason: 'conversation not found' };
    }
    const actorErr = this.access.validateAgentActorForMutation(actor);
    if (actorErr) return actorErr;

    let numberArmBoardKey: string | null = null;
    if ('taskId' in by) {
      // Agent-slot global-id arm (§4.5) — see claimTaskAgent. No coordinates
      // leave this precheck (B5): the tx below re-reads by the canonical id.
      const row = this.read.fetchTaskById(by.taskId);
      if (!row || !this.accessPolicy.canAgentSeeTask(actor, row, 'write_tasks')) {
        return { success: false, code: 'task_not_found', reason: 'task not found' };
      }
    } else {
      const resolved = this.access.resolveAgentTaskBoard(
        actor,
        sourceConv,
        workspaceSelector,
        args => mutationFailure(args),
      );
      if ('failure' in resolved) return resolved.failure;
      numberArmBoardKey = resolved.boardKey;

      if (
        resolved.kind === 'workspace' &&
        !this.canUseCapability(actor, resolved.workspace.id, 'write_tasks')
      ) {
        return mutationFailure({
          code: 'capability_denied',
          capability: 'write_tasks',
          reason: 'agent lacks the write_tasks capability in the target workspace',
        });
      }
    }

    const agentLabel = this.agentName(actor.agentId);
    const systemActor = this.taskSystemActorFor(actor);

    type StatusAgentTxOut =
      | { failure: TaskMutationResult }
      | { success: true; args: PendingWorkflowEvent; sysMsg: MessageDto; conversationId: string };

    const txOut = this.uow.atomically(this.writeAuthority, (tx): StatusAgentTxOut => {
      // B5: write authority = the ORIGINAL selector (id arm by canonical id).
      const row = 'taskId' in by
        ? tx.tasks.fetchTaskById(by.taskId)
        : tx.tasks.fetchTaskByNumber(numberArmBoardKey!, by.taskNumber);
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      // Per-task ACL on the WRITE face (#task:2018 B2) — before any
      // assignee/creator fact can leak; same envelope as a miss.
      if (!tx.conversationAccess.isAgentParticipant(row.conversation_id, actor.agentId)) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      // P0-e survivor-readonly (review B2): in-tx, typed — see claim.
      if (!tx.writeAuthority.canPostToConversation(actor, row.conversation_id)) {
        return { failure: { success: false, code: 'conversation_readonly', reason: 'the conversation is read-only: a direct-pair endpoint is gone' } };
      }
      // Permission: assignee==self OR (unassigned AND creator==self AND
      // creator is an agent). The creator-self branch lets an agent
      // complete/advance its own stale unassigned task without re-claiming; it
      // never matches human-created rows (Cindy `S-RgXd_GWAHu4f0E`).
      // "Unassigned" is BOTH assignee columns null — a migrated row holding an
      // `assignee_user_id` has an owner, and the fallback must not reach past a
      // human assignee just because the creator happens to be this agent.
      const isAssigneeSelf = row.assignee_agent_id === actor.agentId;
      const isCreatorSelfStale =
        row.assignee_agent_id === null &&
        row.assignee_user_id === null &&
        row.creator_kind === 'agent' &&
        row.creator_agent_id === actor.agentId;
      if (!isAssigneeSelf && !isCreatorSelfStale) {
        return { failure: {
          success: false,
          code: 'not_assignee',
          reason: 'only the assignee can update status (creator may update own unassigned task)',
        } };
      }
      if (!VALID_TRANSITIONS[row.status].includes(status)) {
        return { failure: {
          success: false,
          code: 'invalid_transition',
          reason: `invalid transition ${row.status} → ${status}`,
        } };
      }
      const nextClosedAt = status === 'closed' ? (row.closed_at ?? Date.now()) : null;
      tx.tasks.setStatus(row.id, status, nextClosedAt);
      // Post-write snapshot comes from the SQL join (tx scope) — the assignee
      // DTO name never requires a repo lookup inside the callback.
      const fresh = tx.tasks.refetchTaskSnapshot(row.id);
      if (!fresh) {
        throw new Error(`task_status invariant: snapshot missing for just-updated task ${row.id}`);
      }
      const pending: PendingWorkflowEvent = {
        kind: 'status',
        taskId: row.id,
        taskNumber: row.task_number,
        title: fresh.title,
        status,
        assignee: fresh.assignee,
        closedAt: nextClosedAt,
        sourceMessageId: row.source_message_id,
        threadRootId: row.thread_root_id,
      };
      return this.finishWorkflowTx(tx, pending, actor, systemActor,
        `task #${row.task_number} → ${status} (by @${agentLabel})`, row.conversation_id);
    });

    if ('failure' in txOut) return txOut.failure;

    const ownerConv =
      sourceConv !== null && txOut.conversationId === sourceConv.id
        ? sourceConv
        : this.conversations.get(txOut.conversationId);
    if (!ownerConv) {
      return { success: false, code: 'conversation_not_found', reason: 'task owner conversation vanished after commit' };
    }
    if (sourceConv !== null) {
      this.broadcaster.auditCrossOp({
        op: 'status',
        actor,
        sourceConv,
        ownerConv,
        taskNumber: txOut.args.taskNumber,
        // The task's board coordinate, post-commit truth: derived from its owner
        // conversation's placement (total over workspace AND pair boards).
        taskBoardKey: this.read.boardOfConversation(ownerConv.id)?.boardKey ?? 'unknown',
        status,
      });
    }
    this.broadcaster.publish({ ...txOut.args, conversation: ownerConv }, txOut.sysMsg);

    return { success: true };
  }

  private async updateStatusUser(
    actor: UserActor,
    by: UserTaskRef,
    status: TaskStatus,
  ): Promise<TaskMutationResult> {
    const systemActor = this.taskSystemActorFor(actor);

    type StatusUserTxOut =
      | { failure: TaskMutationResult }
      | { success: true; args: PendingWorkflowEvent; sysMsg: MessageDto; conversationId: string };

    const txOut = this.uow.atomically(this.writeAuthority, (tx): StatusUserTxOut => {
      const row = tx.tasks.fetchTaskById(by.taskId);
      if (!row || !tx.conversationAccess.userCanAccessConversation(actor.userId, row.conversation_id)) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      // P0-e survivor-readonly (review B2): in-tx, typed.
      if (!tx.writeAuthority.canPostToConversation(actor, row.conversation_id)) {
        return { failure: { success: false, code: 'conversation_readonly', reason: 'the conversation is read-only: a direct-pair endpoint is gone' } };
      }
      if (row.status === status) {
        return { failure: {
          success: false,
          code: 'already_at_status',
          reason: 'task already has that status',
        } };
      }
      const nextClosedAt = status === 'closed' ? (row.closed_at ?? Date.now()) : null;
      tx.tasks.setStatus(row.id, status, nextClosedAt);
      const fresh = tx.tasks.refetchTaskSnapshot(row.id);
      if (!fresh) {
        throw new Error(`task_status invariant: snapshot missing for just-updated task ${row.id}`);
      }
      const pending: PendingWorkflowEvent = {
        kind: 'status',
        taskId: row.id,
        taskNumber: row.task_number,
        title: fresh.title,
        status,
        assignee: fresh.assignee,
        closedAt: nextClosedAt,
        sourceMessageId: row.source_message_id,
        threadRootId: row.thread_root_id,
      };
      return this.finishWorkflowTx(tx, pending, actor, systemActor,
        `task #${row.task_number} → ${status} (by user)`, row.conversation_id);
    });

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      this.broadcaster.publish({ ...txOut.args, conversation }, txOut.sysMsg);
    }

    return { success: true };
  }

  // ── Edit (title / content) ─────────────────────────────────────

  async editTask(input: EditTaskInput): Promise<TaskEditResult> {
    if (input.actor.kind === 'agent') {
      return this.editTaskAgent(
        input.actor,
        input.by as AgentTaskRef,
        input.title,
        input.body,
        (input as Extract<EditTaskInput, { actor: AgentActor }>).workspaceSelector,
      );
    }
    return this.editTaskUser(
      input.actor,
      input.by as UserTaskRef,
      input.title,
      input.body,
    );
  }

  private async editTaskAgent(
    actor: AgentActor,
    by: AgentTaskRef,
    title: string | null,
    body: string | null,
    workspaceSelector: WorkspaceSelector | undefined,
  ): Promise<TaskEditResult> {
    // P0-g (#task:2018): no by-id mutation surface for a conversation-frame
    // principal — uniform indistinguishable rejection (see claimTaskAgent).
    if ('taskId' in by && actor.runtimeScope !== 'agent') {
      return { success: false, code: 'task_not_found', reason: 'task not found' };
    }
    const sourceConv = actor.conversationId === null
      ? null
      : this.conversations.get(actor.conversationId);
    if (actor.runtimeScope === 'conversation' && !sourceConv) {
      return { success: false, code: 'conversation_not_found', reason: 'conversation not found' };
    }
    if (!this.agents.get(actor.agentId)) {
      return { success: false, code: 'agent_not_found', reason: 'agent not found' };
    }
    if (
      actor.runtimeScope === 'conversation'
      && !this.conversations.isAgentParticipant(actor.conversationId, actor.agentId)
    ) {
      return {
        success: false,
        code: 'not_conversation_member',
        reason: 'agent is not a member of this conversation',
      };
    }

    if ('taskId' in by) {
      // Agent-slot global-id arm (§4.5). Edit is BOTH a mutation and a read
      // (it returns the full detail), so the gate requires write_tasks AND
      // read_tasks — either missing folds into the same envelope; naming the
      // missing capability would disclose that the id exists.
      const row = this.read.fetchTaskById(by.taskId);
      if (
        !row ||
        !this.accessPolicy.canAgentSeeTask(actor, row, 'write_tasks') ||
        !this.accessPolicy.canAgentSeeTask(actor, row, 'read_tasks')
      ) {
        return { success: false, code: 'task_not_found', reason: 'task not found' };
      }
      return this.applyTaskEdit(actor, by, title, body, row.board_key);
    }

    const resolved = this.access.resolveAgentTaskBoard(
      actor,
      sourceConv,
      workspaceSelector,
      (args): TaskEditResult => ({
        success: false,
        code: args.code,
        reason: args.reason,
        ...(args.candidates && args.candidates.length > 0
          ? { workspace_candidates: args.candidates }
          : {}),
      }),
    );
    if ('failure' in resolved) return resolved.failure;
    const taskBoardKey = resolved.boardKey;

    // Edit is BOTH a mutation and a read: on success it returns the full
    // viewer-resolved TaskDetailDto. So the response exercises `read_tasks` in
    // addition to `write_tasks` — an agent with write but not read could
    // otherwise exfiltrate task content through the edit response. Require BOTH;
    // report whichever is missing.
    if (
      resolved.kind === 'workspace' &&
      !this.canUseCapability(actor, resolved.workspace.id, 'write_tasks')
    ) {
      return {
        success: false,
        code: 'capability_denied',
        capability: 'write_tasks',
        reason: 'agent lacks the write_tasks capability in the target workspace',
      };
    }
    if (
      resolved.kind === 'workspace' &&
      !this.canUseCapability(actor, resolved.workspace.id, 'read_tasks')
    ) {
      return {
        success: false,
        code: 'capability_denied',
        capability: 'read_tasks',
        reason:
          'agent lacks the read_tasks capability in the target workspace ' +
          '(task edit returns the full definition, which read_tasks gates)',
      };
    }

    return this.applyTaskEdit(actor, by, title, body, taskBoardKey);
  }

  private async editTaskUser(
    actor: UserActor,
    by: UserTaskRef,
    title: string | null,
    body: string | null,
  ): Promise<TaskEditResult> {
    const peek = this.read.fetchTaskById(by.taskId);
    if (!peek || !this.conversations.userCanAccessConversation(actor.userId, peek.conversation_id)) {
      return { success: false, code: 'task_not_found', reason: 'task not found' };
    }
    return this.applyTaskEdit(actor, by, title, body, peek.board_key);
  }

  /** Shared edit apply: a plain last-write-wins UPDATE (no revision/CAS), gated
   *  by a canonical no-op guard, then — only on a real change — a `task_edit`
   *  system event emitted in the SAME transaction (atomic with the UPDATE) and,
   *  after commit, published to the conversation + delivered to every channel
   *  agent except the editor (publishEdit owns the two-axis split). The full
   *  viewer-resolved detail is returned so an open view refreshes in place. A
   *  same-value save is a full no-op: no UPDATE, no last_editor stamp, no event,
   *  no wake — it still returns
   *  the current detail (idempotent). */
  private async applyTaskEdit(
    actor: TaskActor,
    by: AgentTaskRef | UserTaskRef,
    title: string | null,
    body: string | null,
    taskBoardKey: string,
  ): Promise<TaskEditResult> {
    const editorKind = actor.kind;
    const editorId = actor.kind === 'agent' ? actor.agentId : actor.userId;
    const editedAt = Date.now();
    const actorLabel = this.actorLabel(actor);
    const systemActor = this.taskSystemActorFor(actor);

    type EditTxOut =
      | { kind: 'failure'; failure: TaskEditResult }
      | { kind: 'noop'; taskId: string }
      | {
          kind: 'changed';
          taskId: string;
          eventArgs: TaskEventArgs & { kind: 'edit' };
          sysMsg: MessageDto;
        };

    const txOut = this.uow.atomically(this.writeAuthority, (tx): EditTxOut => {
      const row =
        'taskId' in by
          ? tx.tasks.fetchTaskById(by.taskId)
          : tx.tasks.fetchTaskByNumber(taskBoardKey, by.taskNumber);
      if (!row) {
        return {
          kind: 'failure',
          failure: { success: false, code: 'task_not_found', reason: 'task not found' },
        };
      }
      // Per-task ACL on the WRITE face (#task:2018 B2): an agent actor must
      // participate in the task's own conversation — regardless of which
      // selector arm got here (the by-id arm re-verifies its pre-tx policy,
      // closing the TOCTOU window). Same envelope as a miss. The user lane
      // keeps its own conversation-access gating at its entry points.
      if (
        actor.kind === 'agent' &&
        !tx.conversationAccess.isAgentParticipant(row.conversation_id, actor.agentId)
      ) {
        return {
          kind: 'failure',
          failure: { success: false, code: 'task_not_found', reason: 'task not found' },
        };
      }
      // P0-e survivor-readonly (review B2): EVERY actor kind — the edit
      // writes a task_edit system event into the pair, and a read-only pair
      // admits no writer, system included. In-tx, typed.
      if (!tx.writeAuthority.canPostToConversation(actor, row.conversation_id)) {
        return {
          kind: 'failure',
          failure: { success: false, code: 'conversation_readonly', reason: 'the conversation is read-only: a direct-pair endpoint is gone' },
        };
      }

      // Resolve the owner conversation BEFORE any write. It's a pure read with no
      // dependency on the edit, so doing it here means a missing owner returns a
      // typed failure while NOTHING has been written — there is no path that
      // commits the UPDATE without its `task_edit` anchor (the atomicity contract).
      // Comes from the tx scope so a pooled adapter never reads on the wrong
      // connection (#task:1980 P1-2).
      const ownerConv = tx.conversationAccess.get(row.conversation_id);
      if (!ownerConv) {
        return {
          kind: 'failure',
          failure: { success: false, code: 'task_not_found', reason: 'task not found' },
        };
      }

      // Canonical no-op guard: fire an edit event ONLY when a canonical
      // title/content value actually changes. `title` arrives already normalized
      // (TaskTitleSchema at the API boundary) and stored titles are normalized
      // too, so `!==` is a valid canonical comparison; a null field means "leave
      // unchanged". A same-value save (onBlur re-save, idempotent CLI edit) writes
      // NOTHING — no UPDATE, no last_editor stamp, no event, no wake — so it
      // cannot manufacture attention cost.
      const titleChanges = title !== null && title !== row.title;
      const contentChanges = body !== null && body !== row.content;
      if (!titleChanges && !contentChanges) {
        return { kind: 'noop', taskId: row.id };
      }

      const updated = tx.tasks.applyTaskEdit({
        taskId: row.id,
        title,
        content: body,
        editorKind,
        editorId,
        editedAt,
      });
      if (!updated) {
        // The row vanished between fetch and update within the txn — the UPDATE
        // matched 0 rows, so NOTHING was written; a typed not-found is safe here
        // (no orphaned write to roll back).
        return {
          kind: 'failure',
          failure: { success: false, code: 'task_not_found', reason: 'task not found' },
        };
      }

      // Post-UPDATE, any invariant failure MUST throw (→ rollback), never return
      // normally — a normal return would COMMIT the edit without its notice. The
      // row was just updated in THIS txn, so a null snapshot is a hard invariant
      // violation, not a degrade: we do NOT fall back to `row`'s pre-edit title
      // (that would emit an event carrying the stale title).
      const snap = tx.tasks.refetchTaskSnapshot(row.id);
      if (!snap) {
        throw new Error(
          `task_edit invariant: snapshot missing for just-updated task ${row.id}`,
        );
      }
      // AFTER snapshot: an edit never moves status/assignee, but the title may
      // have changed. The system-event insert runs in THIS txn (through the
      // scope's TaskSystemEventPort) so UPDATE + notice INSERT commit atomically.
      const eventArgs: TaskEventArgs & { kind: 'edit' } = {
        conversation: ownerConv,
        kind: 'edit',
        taskId: row.id,
        taskNumber: row.task_number,
        title: snap.title,
        status: snap.status,
        assignee: snap.assignee,
        closedAt: snap.closed_at,
        sourceMessageId: row.source_message_id,
        threadRootId: row.thread_root_id,
      };
      const sysMsg = tx.systemEvents.insert({
        conversationId: row.conversation_id,
        threadRootId: row.thread_root_id,
        content: `${actorLabel} edited task #${row.task_number} "${eventArgs.title}"`,
        metadata: this.taskSystemEventMetadata('edit', eventArgs, systemActor),
      });
      return { kind: 'changed', taskId: row.id, eventArgs, sysMsg };
    });

    if (txOut.kind === 'failure') return txOut.failure;
    if (txOut.kind === 'changed') {
      // Post-commit: conversation-visible publish + board patch + all-member
      // wake (every channel agent except the editor). Never before commit — the
      // event must reflect durable state.
      this.broadcaster.publishEdit(txOut.eventArgs, txOut.sysMsg, actor);
    }

    // Both changed and no-op return the full viewer-resolved detail (edit's
    // response contract), resolved against the ALREADY-authorized task workspace
    // (not the actor's current conversation) so a cross-workspace edit still
    // returns its `task`.
    const detail = this.read.fetchTaskDetail(txOut.taskId, actor, taskBoardKey);
    if (!detail) {
      return { success: false, code: 'task_not_found', reason: 'task not found' };
    }
    return { success: true, task: detail };
  }

  // ── Detail read ────────────────────────────────────────────────

  /**
   * Resolve the BOARD an AGENT is authorized to read a task in, from the
   * optional `--workspace-id` / `--workspace` selector (default: the frame
   * conversation's placement-derived board — a DM frame reads its own pair
   * board). The route gates `read_tasks` on the returned workspace only for
   * the workspace arm; a pair board has no capability table (participation is
   * the authority, P0-f §4.4) and `workspaceId` is null there.
   */
  resolveAgentDetailWorkspace(
    actor: AgentActor,
    selector: WorkspaceSelector | undefined,
  ): { boardKey: string; workspaceId: string | null } | AgentDetailWorkspaceFailure {
    const sourceConv = actor.conversationId === null
      ? null
      : this.conversations.get(actor.conversationId);
    if (actor.runtimeScope === 'conversation' && !sourceConv) {
      return { code: 'conversation_not_found', reason: 'conversation not found' };
    }
    const resolved = this.access.resolveAgentTaskBoard(
      actor,
      sourceConv,
      selector,
      (args): AgentDetailWorkspaceFailure => ({
        code: args.code,
        reason: args.reason,
        ...(args.candidates ? { candidates: args.candidates } : {}),
      }),
    );
    if ('failure' in resolved) return resolved.failure;
    return {
      boardKey: resolved.boardKey,
      workspaceId: resolved.kind === 'workspace' ? resolved.workspace.id : null,
    };
  }

  /** Human detail read, keyed by task id (the REST path param). */
  getTaskDetail(
    taskId: string,
    actor: TaskActor,
    authorizedWorkspaceId?: string,
  ): TaskDetailDto | null {
    return this.read.fetchTaskDetail(taskId, actor, authorizedWorkspaceId);
  }

  /** Agent detail read, keyed by task number in an already-authorized
   *  workspace (the CLI resolver). Returns null when no such task exists. */
  getTaskDetailByNumber(
    taskNumber: number,
    actor: TaskActor,
    authorizedWorkspaceId: string,
  ): TaskDetailDto | null {
    const row = this.read.fetchTaskByNumber(authorizedWorkspaceId, taskNumber);
    if (!row) return null;
    return this.read.fetchTaskDetail(row.id, actor, authorizedWorkspaceId);
  }

  /**
   * Agent detail read by GLOBAL identity (`tasks.id`) — P0-g (#task:2018,
   * agent-scoped-session-v1 §4.5).
   *
   * Scope-branched by the P1 principal projection:
   *  - agent slot: the canonical id dereferences across EVERY board, gated by
   *    the TaskAccessPolicy alone (participation in the task's own
   *    conversation ∧ `read_tasks`, with the agent_home owner arm);
   *  - conversation frame: the id dereferences ONLY inside the caller's
   *    ambient WorkspaceBoard, so a conversation-scoped principal cannot pull
   *    another workspace's content into its session by id.
   *
   * EVERY failure returns the same `null` — unknown id, foreign-board id,
   * non-participant, and missing capability are indistinguishable by
   * construction (§4.5: ACL before existence disclosure; a typed error here
   * would be an id-probing oracle).
   */
  getTaskDetailByGlobalId(taskId: string, actor: AgentActor): TaskDetailDto | null {
    const row = this.read.fetchTaskById(taskId);
    if (!row) return null;
    if (actor.runtimeScope !== 'agent') {
      // Ambient-board rule, board-keyed (P0-f): the frame conversation's
      // placement-derived board must be the task's own — a DM frame
      // dereferences its own pair board, a channel frame its workspace board,
      // an inbox frame nothing.
      const frameBoard = this.read.boardOfConversation(actor.conversationId);
      if (!frameBoard || row.board_key !== frameBoard.boardKey) return null;
    }
    if (!this.accessPolicy.canAgentSeeTask(actor, row, 'read_tasks')) return null;
    // The repo detail read re-applies the participation gate (same authority)
    // and the board coordinate via `authorizedBoardKey`.
    return this.read.fetchTaskDetail(row.id, actor, row.board_key);
  }

  /**
   * Human point lookup by the board-scoped BUSINESS key `(board, task_number)`
   * — the identity an inline `#task:<n>` sigil carries. The board is named
   * indirectly by a `conversation_id` on it: we derive the board from the
   * conversation's placement, then read `(board_key, task_number)`. Returns null
   * when the conversation has no board, when no such task exists on it, OR when
   * the viewer cannot see the task's conversation.
   *
   * `conversationId` is the LOOKUP key, never an authorization claim: it is not
   * passed on as an authorized scope, so the gate is the store's per-viewer
   * conversation visibility of the TASK's own conversation. A caller naming a
   * conversation it has no part in therefore gets the SAME null as a caller
   * naming a task number that was never allocated — the two are
   * indistinguishable by construction, not by a remembered convention at the
   * route. Deriving the board (not equating on `workspace_id`) is what lets a
   * workspace-less DirectPair task — `workspace_id` NULL, board `pair:…` —
   * resolve here at all.
   */
  getTaskSummaryByNumber(
    conversationId: string,
    taskNumber: number,
    actor: UserActor,
  ): TaskSummaryDto | null {
    const board = this.read.boardOfConversation(conversationId);
    if (!board) return null;
    return this.read.getByNumber(board.boardKey, taskNumber, actor);
  }

  // ── Workflow tx finishing (shared) ─────────────────────────────

  /** Finish a workflow mutation inside its UnitOfWork scope: freshen the event
   *  args from the just-written row (SQL join), insert the system event in the
   *  SAME scope, and return the durable payload for post-commit publish. The
   *  mutation + event insert commit or roll back together (#task:1980 P1-1). */
  private finishWorkflowTx(
    tx: TaskTxScope,
    pending: PendingWorkflowEvent,
    actor: TaskActor,
    systemActor: TaskSystemActor,
    sysMessage: string,
    conversationId: string,
  ): { success: true; args: PendingWorkflowEvent; sysMsg: MessageDto; conversationId: string } {
    const fresh = tx.tasks.refetchTaskSnapshot(pending.taskId);
    const args: PendingWorkflowEvent = {
      ...pending,
      title: fresh?.title ?? pending.title,
      status: fresh?.status ?? pending.status,
      assignee: fresh?.assignee ?? pending.assignee,
      closedAt: fresh?.closed_at ?? pending.closedAt,
    };
    const sysMsg = tx.systemEvents.insert({
      conversationId,
      threadRootId: args.threadRootId,
      content: sysMessage,
      metadata: this.taskSystemEventMetadata(args.kind, args as TaskEventArgs, systemActor),
    });
    return { success: true, args, sysMsg, conversationId };
  }

  /** Build the system-event metadata. Pure — all inputs are precomputed values
   *  (event args + the pre-tx-resolved actor), so the tx callback never touches
   *  a repo for the event payload. */
  private taskSystemEventMetadata(
    kind: TaskEventArgs['kind'],
    args: TaskEventArgs,
    actor: TaskSystemActor,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      subtype: taskSystemSubtype(kind),
      task_number: args.taskNumber,
      task_status: args.status,
      task_id: args.taskId,
      task_title: args.title,
      task_assignee: args.assignee,
      actor,
      ...(extra ?? {}),
    };
  }

  // ── Actor formatting ───────────────────────────────────────────

  private actorLabel(actor: TaskActor): string {
    if (actor.kind === 'user') return 'user';
    const agent = this.agents.get(actor.agentId);
    return agent ? `@${agent.name}` : 'agent';
  }

  private agentName(agentId: string): string {
    const agent = this.agents.get(agentId);
    return agent?.name ?? agentId;
  }

  private assigneeDtoForAgent(agentId: string): TaskAssigneeDto {
    const agent = this.agents.get(agentId);
    return {
      type: 'agent',
      id: agentId,
      name: agent?.display_name ?? agent?.name ?? agentId,
    };
  }

  /** Resolve the structured `TaskSystemActor` (renderers draw an actor pill
   *  without parsing content). DB-backed (agents lookup) — must be called
   *  BEFORE opening a transaction and passed into the callback as a pure value. */
  private taskSystemActorFor(actor: TaskActor): TaskSystemActor {
    if (actor.kind === 'user') {
      return { kind: 'user', id: actor.userId, name: 'user' };
    }
    const agent = this.agents.get(actor.agentId);
    return {
      kind: 'agent',
      id: actor.agentId,
      name: agent?.display_name ?? agent?.name ?? actor.agentId,
    };
  }
}

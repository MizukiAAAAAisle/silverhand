import type { Database as Db } from 'better-sqlite3';
import {
  type ClaimErrorCode,
  type ClaimResultEntry,
  type CreateTasksResult,
  type MessageDto,
  type TaskAssigneeDto,
  type TaskDetailDto,
  type TaskEditResult,
  type TaskMutationResult,
  type TaskStatus,
  type TaskSummaryDto,
} from '@silverhand/shared';
import { assertActorConversationMatch } from '../auth/principal.js';
import { TaskStore } from './task/store.js';
import { TaskAccessControl } from './task/access.js';
import { TaskBroadcaster, type TaskEventArgs } from './task/broadcaster.js';
import {
  failClaim,
  mutationFailure,
  userCanAccessConversation,
  VALID_TRANSITIONS,
  type AgentActor,
  type AgentCapabilityChecker,
  type AgentTaskRef,
  type ClaimTaskInput,
  type CreateTasksInput,
  type EditTaskInput,
  type ListTasksFilters,
  type TaskActor,
  type TaskServiceOptions,
  type UnclaimTaskInput,
  type UpdateStatusInput,
  type UserActor,
  type UserTaskRef,
  type WorkspaceSelector,
} from './task/contracts.js';

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
  TaskServiceOptions,
  UnclaimTaskInput,
  UpdateStatusInput,
  WorkspaceSelector,
} from './task/contracts.js';

/** Failure envelope from the agent detail-workspace resolver. */
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
 * Contract:
 * - Each mutating op runs validate + write inside ONE db.transaction().
 * - `task create` is one txn: insert the `tasks` row, emit the `task_create`
 *   system event, and backfill `created_event_message_id` — then publish +
 *   deliver AFTER commit. It creates NO ordinary anchor message. Every task
 *   action's conversational footprint is a system event, never a body message.
 * - claim/unclaim/status commit the mutation, then broadcast the system event.
 * - For agent ops, the target workspace resolves from the optional
 *   `workspace_id` / `workspace_name` selector or defaults to the actor's
 *   current conversation's workspace; the agent must be a member.
 *
 * This class is the task-lifecycle aggregate root. Peripheral concerns are
 * delegated to `TaskStore` (all `tasks` SQL + reads + nav resolution),
 * `TaskAccessControl` (pre-tx actor / workspace authorization), and
 * `TaskBroadcaster` (system event, `task_changed`, delivery, cross-op audit).
 */
export class TaskService {
  private readonly db: Db;
  private readonly conversations: TaskServiceOptions['conversations'];
  private readonly agents: TaskServiceOptions['agents'];
  private readonly canUseCapability: AgentCapabilityChecker;
  private readonly store: TaskStore;
  private readonly access: TaskAccessControl;
  private readonly broadcaster: TaskBroadcaster;

  constructor(opts: TaskServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.agents = opts.agents;
    this.canUseCapability = opts.canUseCapability;
    this.store = new TaskStore({
      db: opts.db,
      conversations: opts.conversations,
    });
    this.access = new TaskAccessControl({
      agents: opts.agents,
      conversations: opts.conversations,
      workspaces: opts.workspaces,
    });
    this.broadcaster = new TaskBroadcaster({
      db: opts.db,
      store: this.store,
      messages: opts.messages,
      agents: opts.agents,
      conversations: opts.conversations,
      runtimeHost: opts.runtimeHost,
      events: opts.events,
      logger: opts.logger,
    });
  }

  // ── Read ─────────────────────────────────────────────────────────

  list(filters: ListTasksFilters): TaskSummaryDto[] {
    return this.store.list(filters);
  }

  getById(taskId: string, actor: TaskActor): TaskSummaryDto | null {
    return this.store.getById(taskId, actor);
  }

  // ── Create ──────────────────────────────────────────────────────

  async createTasks(input: CreateTasksInput): Promise<CreateTasksResult> {
    assertActorConversationMatch(input.actor, input.conversationId);
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) return { error: 'conversation_not_found' };
    if (conversation.closed_at !== null) return { error: 'conversation_closed' };
    if (input.actor.kind === 'agent') {
      if (!this.agents.get(input.actor.agentId)) {
        return { error: 'agent_not_found' };
      }
      if (!this.conversations.getAgent(input.conversationId, input.actor.agentId)) {
        return { error: 'not_conversation_member' };
      }
    }
    let threadRootId: string | null = null;
    const targetMessageId = this.taskThreadTargetMessageId(input);
    if (targetMessageId) {
      const target = this.store.fetchMessageRef(targetMessageId);
      if (!target || target.conversation_id !== input.conversationId) {
        return { error: 'reply_target_not_found' };
      }
      threadRootId = target.thread_root_id ?? target.id;
    }

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
    const now = Date.now();

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
      created = this.db.transaction(() => {
        const rows: Created[] = [];
        for (const t of input.tasks) {
          const content = t.body && t.body.length > 0 ? t.body : '';
          const { id, taskNumber } = this.store.createTaskRow({
            workspaceId: taskWorkspaceId,
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
          const sysMsg = this.broadcaster.emitSystemMessage({
            ...eventArgs,
            kind: 'create',
            actor: input.actor,
            sysMessage: claimByAgentId
              ? `${actorLabel} created task #${taskNumber} "${t.title}" and claimed it`
              : `${actorLabel} created task #${taskNumber} "${t.title}"`,
          });
          this.store.backfillCreatedEvent(id, sysMsg.id);
          rows.push({ out: { id, task_number: taskNumber, title: t.title }, sysMsg, eventArgs });
        }
        return rows;
      })();
    } catch (e) {
      // UNIQUE(source_message_id) race backstop: a concurrent create bound the
      // same source between our pre-check and this txn. Map to the typed
      // conflict pointing at the winner instead of leaking a SqliteError.
      const conflict = this.sourceConflictFromError(e, input.tasks);
      if (conflict) return conflict;
      throw e;
    }

    for (const c of created) {
      this.broadcaster.publish(c.eventArgs, c.sysMsg);
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
    const src = this.store.fetchMessageRef(sourceMessageId);
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
        ? this.conversations.getAgent(src.conversation_id, actor.agentId) != null
        : userCanAccessConversation(this.db, actor.userId, src.conversation_id);
    if (!accessible) return { error: 'source_not_accessible' };
    const existing = this.store.fetchTaskBySourceMessageId(sourceMessageId);
    if (existing) {
      return { error: 'source_conflict', existing_task: existing };
    }
    return null;
  }

  /** Translate a UNIQUE(source_message_id) violation thrown mid-txn into the
   *  typed `source_conflict` pointing at the task that won the race. Returns
   *  null if the error is unrelated (caller rethrows). */
  private sourceConflictFromError(
    e: unknown,
    tasks: CreateTasksInput['tasks'],
  ): CreateTasksResult | null {
    const code = (e as { code?: string })?.code;
    const message = e instanceof Error ? e.message : '';
    const isSourceUnique =
      code === 'SQLITE_CONSTRAINT_UNIQUE' && message.includes('source_message_id');
    if (!isSourceUnique) return null;
    for (const t of tasks) {
      if (!t.sourceMessageId) continue;
      const existing = this.store.fetchTaskBySourceMessageId(t.sourceMessageId);
      if (existing) return { error: 'source_conflict', existing_task: existing };
    }
    return { error: 'source_conflict' };
  }

  private taskThreadTargetMessageId(input: CreateTasksInput): string | undefined {
    return input.legacyReplyToMessageId
      ?? (input.target?.kind === 'thread' ? input.target.message_id : undefined);
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
    if (assignee && assignee.agentId !== actor.agentId) {
      return failClaim({
        code: 'not_self_assignment',
        reason: 'agent can only claim tasks for itself',
      });
    }
    const sourceConv = this.conversations.get(actor.conversationId);
    if (!sourceConv) {
      return failClaim({ code: 'conversation_not_found', reason: 'conversation not found' });
    }
    const actorErr = this.access.validateAgentActorForClaim(actor);
    if (actorErr) return actorErr;

    const resolved = this.access.resolveAgentTaskWorkspace(
      actor,
      sourceConv,
      workspaceSelector,
      args =>
        failClaim({ code: args.code, reason: args.reason, workspaceCandidates: args.candidates }),
    );
    if ('failure' in resolved) return resolved.failure;
    const taskWorkspaceId = resolved.workspace.id;

    // Claim is pure mutation (it never creates a task), so it needs
    // `write_tasks` only. Typed denial, never downgraded to task_not_found.
    if (!this.canUseCapability(actor, taskWorkspaceId, 'write_tasks')) {
      return failClaim({
        code: 'capability_denied',
        capability: 'write_tasks',
        reason: 'agent lacks the write_tasks capability in the target workspace',
      });
    }

    type ClaimTxOut =
      | { failure: ClaimResultEntry }
      | { success: true; args: PendingTaskEvent; ownerConversationId: string };

    const txOut = this.db.transaction((): ClaimTxOut => {
      const row = this.store.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      if (!row) {
        return { failure: failClaim({
          code: 'task_not_found',
          reason: 'task not found',
          taskNumber: by.taskNumber,
        }) };
      }
      if (row.status === 'done' || row.status === 'closed') {
        return { failure: failClaim({
          code: row.status === 'closed' ? 'task_closed' : 'task_done',
          reason: row.status === 'closed' ? 'task is closed' : 'task is already done',
          taskNumber: row.task_number,
        }) };
      }
      const changes = this.store.assignSelf(row.id, actor.agentId);
      if (changes === 0) {
        const cur = this.store.readAssignment(row.id);
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
      return {
        success: true,
        ownerConversationId: row.conversation_id,
        args: {
          kind: 'claim',
          taskId: row.id,
          taskNumber: row.task_number,
          title: row.title,
          status: nextStatus,
          assignee: this.assigneeDtoForAgent(actor.agentId),
          closedAt: row.closed_at,
          sourceMessageId: row.source_message_id,
          threadRootId: row.thread_root_id,
        },
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const ownerConv =
      txOut.ownerConversationId === sourceConv.id
        ? sourceConv
        : this.conversations.get(txOut.ownerConversationId);
    if (!ownerConv) {
      return failClaim({
        code: 'conversation_not_found',
        reason: 'task owner conversation vanished after commit',
      });
    }
    this.broadcaster.auditCrossOp({
      op: 'claim',
      actor,
      sourceConv,
      ownerConv,
      taskNumber: txOut.args.taskNumber,
      taskWorkspaceId,
    });

    await this.broadcastFresh(ownerConv, txOut.args, actor,
      `${this.actorLabel(actor)} claimed task #${txOut.args.taskNumber}`);

    return { success: true, task_number: txOut.args.taskNumber, id: txOut.args.taskId };
  }

  private async claimTaskUser(
    actor: UserActor,
    by: UserTaskRef,
    assignee: { agentId: string },
  ): Promise<ClaimResultEntry> {
    type UserClaimTxOut =
      | { failure: ClaimResultEntry }
      | { success: true; args: PendingTaskEvent; conversationId: string };

    const txOut = this.db.transaction((): UserClaimTxOut => {
      const row = this.store.fetchTaskById(by.taskId);
      if (!row || !userCanAccessConversation(this.db, actor.userId, row.conversation_id)) {
        return { failure: failClaim({ code: 'task_not_found', reason: 'task not found' }) };
      }
      if (row.status === 'done' || row.status === 'closed') {
        return { failure: failClaim({
          code: row.status === 'closed' ? 'task_closed' : 'task_done',
          reason: row.status === 'closed' ? 'task is closed' : 'task is done',
          taskNumber: row.task_number,
        }) };
      }
      if (!this.agents.get(assignee.agentId)) {
        return { failure: failClaim({
          code: 'assignee_not_conversation_member',
          reason: 'agent not found',
        }) };
      }
      if (!this.conversations.getAgent(row.conversation_id, assignee.agentId)) {
        return { failure: failClaim({
          code: 'assignee_not_conversation_member',
          reason: "agent is not a member of this task's conversation",
        }) };
      }
      this.store.setAssignee(row.id, assignee.agentId);
      return {
        success: true,
        conversationId: row.conversation_id,
        args: {
          kind: 'claim',
          taskId: row.id,
          taskNumber: row.task_number,
          title: row.title,
          // Assignment-only write: the human board edits Assignee and Status as
          // two orthogonal fields, so assigning never advances the workflow.
          status: row.status,
          assignee: this.assigneeDtoForAgent(assignee.agentId),
          closedAt: row.closed_at,
          sourceMessageId: row.source_message_id,
          threadRootId: row.thread_root_id,
        },
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      await this.broadcastFresh(
        conversation,
        txOut.args,
        actor,
        `task #${txOut.args.taskNumber} assigned to @${this.agentName(assignee.agentId)} (by user)`,
      );
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
    const sourceConv = this.conversations.get(actor.conversationId);
    if (!sourceConv) {
      return { success: false, code: 'conversation_not_found', reason: 'conversation not found' };
    }
    const actorErr = this.access.validateAgentActorForMutation(actor);
    if (actorErr) return actorErr;

    const resolved = this.access.resolveAgentTaskWorkspace(
      actor,
      sourceConv,
      workspaceSelector,
      args => mutationFailure(args),
    );
    if ('failure' in resolved) return resolved.failure;
    const taskWorkspaceId = resolved.workspace.id;

    if (!this.canUseCapability(actor, taskWorkspaceId, 'write_tasks')) {
      return mutationFailure({
        code: 'capability_denied',
        capability: 'write_tasks',
        reason: 'agent lacks the write_tasks capability in the target workspace',
      });
    }

    type UnclaimAgentTxOut =
      | { failure: TaskMutationResult }
      | { success: true; args: PendingTaskEvent; ownerConversationId: string };

    const txOut = this.db.transaction((): UnclaimAgentTxOut => {
      const row = this.store.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
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
      this.store.releaseToTodo(row.id);
      return {
        success: true,
        ownerConversationId: row.conversation_id,
        args: {
          kind: 'unclaim',
          taskId: row.id,
          taskNumber: row.task_number,
          title: row.title,
          status: 'todo',
          assignee: null,
          closedAt: null,
          sourceMessageId: row.source_message_id,
          threadRootId: row.thread_root_id,
        },
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const ownerConv =
      txOut.ownerConversationId === sourceConv.id
        ? sourceConv
        : this.conversations.get(txOut.ownerConversationId);
    if (!ownerConv) {
      return { success: false, code: 'conversation_not_found', reason: 'task owner conversation vanished after commit' };
    }
    this.broadcaster.auditCrossOp({
      op: 'unclaim',
      actor,
      sourceConv,
      ownerConv,
      taskNumber: txOut.args.taskNumber,
      taskWorkspaceId,
    });

    await this.broadcastFresh(ownerConv, txOut.args, actor,
      `task #${txOut.args.taskNumber} unclaimed (was @${this.agentName(actor.agentId)})`);

    return { success: true };
  }

  private async unclaimTaskUser(
    actor: UserActor,
    by: UserTaskRef,
  ): Promise<TaskMutationResult> {
    type UnclaimUserTxOut =
      | { failure: TaskMutationResult }
      | { success: true; args: PendingTaskEvent; conversationId: string };

    const txOut = this.db.transaction((): UnclaimUserTxOut => {
      const row = this.store.fetchTaskById(by.taskId);
      if (!row || !userCanAccessConversation(this.db, actor.userId, row.conversation_id)) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
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
      // Assignment-only write: `status` / `closed_at` are deliberately left
      // untouched, so the event payload echoes the row as it stands.
      this.store.setAssignee(row.id, null);
      return {
        success: true,
        conversationId: row.conversation_id,
        args: {
          kind: 'unclaim',
          taskId: row.id,
          taskNumber: row.task_number,
          title: row.title,
          status: row.status,
          assignee: null,
          closedAt: row.closed_at,
          sourceMessageId: row.source_message_id,
          threadRootId: row.thread_root_id,
        },
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      await this.broadcastFresh(conversation, txOut.args, actor,
        `task #${txOut.args.taskNumber} unassigned (by user)`);
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
    const sourceConv = this.conversations.get(actor.conversationId);
    if (!sourceConv) {
      return { success: false, code: 'conversation_not_found', reason: 'conversation not found' };
    }
    const actorErr = this.access.validateAgentActorForMutation(actor);
    if (actorErr) return actorErr;

    const resolved = this.access.resolveAgentTaskWorkspace(
      actor,
      sourceConv,
      workspaceSelector,
      args => mutationFailure(args),
    );
    if ('failure' in resolved) return resolved.failure;
    const taskWorkspaceId = resolved.workspace.id;

    if (!this.canUseCapability(actor, taskWorkspaceId, 'write_tasks')) {
      return mutationFailure({
        code: 'capability_denied',
        capability: 'write_tasks',
        reason: 'agent lacks the write_tasks capability in the target workspace',
      });
    }

    type StatusAgentTxOut =
      | { failure: TaskMutationResult }
      | { success: true; args: PendingTaskEvent; ownerConversationId: string };

    const txOut = this.db.transaction((): StatusAgentTxOut => {
      const row = this.store.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
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
      this.store.setStatus(row.id, status, nextClosedAt);
      return {
        success: true,
        ownerConversationId: row.conversation_id,
        args: {
          kind: 'status',
          taskId: row.id,
          taskNumber: row.task_number,
          title: row.title,
          status,
          assignee: row.assignee_agent_id
            ? this.assigneeDtoForAgent(row.assignee_agent_id)
            : null,
          closedAt: nextClosedAt,
          sourceMessageId: row.source_message_id,
          threadRootId: row.thread_root_id,
        },
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const ownerConv =
      txOut.ownerConversationId === sourceConv.id
        ? sourceConv
        : this.conversations.get(txOut.ownerConversationId);
    if (!ownerConv) {
      return { success: false, code: 'conversation_not_found', reason: 'task owner conversation vanished after commit' };
    }
    this.broadcaster.auditCrossOp({
      op: 'status',
      actor,
      sourceConv,
      ownerConv,
      taskNumber: txOut.args.taskNumber,
      taskWorkspaceId,
      status,
    });

    await this.broadcastFresh(ownerConv, txOut.args, actor,
      `task #${txOut.args.taskNumber} → ${status} (by @${this.agentName(actor.agentId)})`);

    return { success: true };
  }

  private async updateStatusUser(
    actor: UserActor,
    by: UserTaskRef,
    status: TaskStatus,
  ): Promise<TaskMutationResult> {
    type StatusUserTxOut =
      | { failure: TaskMutationResult }
      | { success: true; args: PendingTaskEvent; conversationId: string };

    const txOut = this.db.transaction((): StatusUserTxOut => {
      const row = this.store.fetchTaskById(by.taskId);
      if (!row || !userCanAccessConversation(this.db, actor.userId, row.conversation_id)) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      if (row.status === status) {
        return { failure: {
          success: false,
          code: 'already_at_status',
          reason: 'task already has that status',
        } };
      }
      const nextClosedAt = status === 'closed' ? (row.closed_at ?? Date.now()) : null;
      this.store.setStatus(row.id, status, nextClosedAt);
      return {
        success: true,
        conversationId: row.conversation_id,
        args: {
          kind: 'status',
          taskId: row.id,
          taskNumber: row.task_number,
          title: row.title,
          status,
          assignee: row.assignee_agent_id
            ? this.assigneeDtoForAgent(row.assignee_agent_id)
            : null,
          closedAt: nextClosedAt,
          sourceMessageId: row.source_message_id,
          threadRootId: row.thread_root_id,
        },
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      await this.broadcastFresh(conversation, txOut.args, actor,
        `task #${txOut.args.taskNumber} → ${status} (by user)`);
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
    const sourceConv = this.conversations.get(actor.conversationId);
    if (!sourceConv) {
      return { success: false, code: 'conversation_not_found', reason: 'conversation not found' };
    }
    if (!this.agents.get(actor.agentId)) {
      return { success: false, code: 'agent_not_found', reason: 'agent not found' };
    }
    if (!this.conversations.getAgent(actor.conversationId, actor.agentId)) {
      return {
        success: false,
        code: 'not_conversation_member',
        reason: 'agent is not a member of this conversation',
      };
    }

    const resolved = this.access.resolveAgentTaskWorkspace(
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
    const taskWorkspaceId = resolved.workspace.id;

    // Edit is BOTH a mutation and a read: on success it returns the full
    // viewer-resolved TaskDetailDto. So the response exercises `read_tasks` in
    // addition to `write_tasks` — an agent with write but not read could
    // otherwise exfiltrate task content through the edit response. Require BOTH;
    // report whichever is missing.
    if (!this.canUseCapability(actor, taskWorkspaceId, 'write_tasks')) {
      return {
        success: false,
        code: 'capability_denied',
        capability: 'write_tasks',
        reason: 'agent lacks the write_tasks capability in the target workspace',
      };
    }
    if (!this.canUseCapability(actor, taskWorkspaceId, 'read_tasks')) {
      return {
        success: false,
        code: 'capability_denied',
        capability: 'read_tasks',
        reason:
          'agent lacks the read_tasks capability in the target workspace ' +
          '(task edit returns the full definition, which read_tasks gates)',
      };
    }

    return this.applyTaskEdit(actor, by, title, body, taskWorkspaceId);
  }

  private async editTaskUser(
    actor: UserActor,
    by: UserTaskRef,
    title: string | null,
    body: string | null,
  ): Promise<TaskEditResult> {
    const peek = this.store.fetchTaskById(by.taskId);
    if (!peek || !userCanAccessConversation(this.db, actor.userId, peek.conversation_id)) {
      return { success: false, code: 'task_not_found', reason: 'task not found' };
    }
    return this.applyTaskEdit(actor, by, title, body, peek.workspace_id);
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
    taskWorkspaceId: string,
  ): Promise<TaskEditResult> {
    const editorKind = actor.kind;
    const editorId = actor.kind === 'agent' ? actor.agentId : actor.userId;
    const editedAt = Date.now();

    type EditTxOut =
      | { kind: 'failure'; failure: TaskEditResult }
      | { kind: 'noop'; taskId: string }
      | {
          kind: 'changed';
          taskId: string;
          eventArgs: TaskEventArgs & { kind: 'edit' };
          sysMsg: MessageDto;
        };

    const txOut = this.db.transaction((): EditTxOut => {
      const row =
        'taskId' in by
          ? this.store.fetchTaskById(by.taskId)
          : this.store.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      if (!row) {
        return {
          kind: 'failure',
          failure: { success: false, code: 'task_not_found', reason: 'task not found' },
        };
      }

      // Resolve the owner conversation BEFORE any write. It's a pure read with no
      // dependency on the edit, so doing it here means a missing owner returns a
      // typed failure while NOTHING has been written — there is no path that
      // commits the UPDATE without its `task_edit` anchor (the atomicity contract).
      const ownerConv = this.conversations.get(row.conversation_id);
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

      const updated = this.store.applyTaskEdit({
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
      const snap = this.store.refetchTaskSnapshot(row.id);
      if (!snap) {
        throw new Error(
          `task_edit invariant: snapshot missing for just-updated task ${row.id}`,
        );
      }
      // AFTER snapshot: an edit never moves status/assignee, but the title may
      // have changed. emitSystemMessage runs in THIS txn (its no-own-wrapper
      // contract) so UPDATE + notice INSERT commit atomically.
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
      const sysMsg = this.broadcaster.emitSystemMessage({
        ...eventArgs,
        kind: 'edit',
        actor,
        sysMessage: `${this.actorLabel(actor)} edited task #${row.task_number} "${eventArgs.title}"`,
      });
      return { kind: 'changed', taskId: row.id, eventArgs, sysMsg };
    })();

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
    const detail = this.store.fetchTaskDetail(txOut.taskId, actor, taskWorkspaceId);
    if (!detail) {
      return { success: false, code: 'task_not_found', reason: 'task not found' };
    }
    return { success: true, task: detail };
  }

  // ── Detail read ────────────────────────────────────────────────

  /**
   * Resolve the workspace an AGENT is authorized to read a task in, from the
   * optional `--workspace-id` / `--workspace` selector (defaults to the actor's
   * current conversation's workspace). The route gates `read_tasks` on the
   * returned workspace before fetching by task number.
   */
  resolveAgentDetailWorkspace(
    actor: AgentActor,
    selector: WorkspaceSelector | undefined,
  ): { workspaceId: string } | AgentDetailWorkspaceFailure {
    const sourceConv = this.conversations.get(actor.conversationId);
    if (!sourceConv) {
      return { code: 'conversation_not_found', reason: 'conversation not found' };
    }
    const resolved = this.access.resolveAgentTaskWorkspace(
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
    return { workspaceId: resolved.workspace.id };
  }

  /** Human detail read, keyed by task id (the REST path param). */
  getTaskDetail(
    taskId: string,
    actor: TaskActor,
    authorizedWorkspaceId?: string,
  ): TaskDetailDto | null {
    return this.store.fetchTaskDetail(taskId, actor, authorizedWorkspaceId);
  }

  /** Agent detail read, keyed by task number in an already-authorized
   *  workspace (the CLI resolver). Returns null when no such task exists. */
  getTaskDetailByNumber(
    taskNumber: number,
    actor: TaskActor,
    authorizedWorkspaceId: string,
  ): TaskDetailDto | null {
    const row = this.store.fetchTaskByNumber(authorizedWorkspaceId, taskNumber);
    if (!row) return null;
    return this.store.fetchTaskDetail(row.id, actor, authorizedWorkspaceId);
  }

  // ── Broadcast helper ───────────────────────────────────────────

  /** Refetch the post-mutation snapshot and broadcast the system event +
   *  `task_changed`. Shared by every mutation path so the wire payload always
   *  reflects committed state. */
  private async broadcastFresh(
    ownerConv: TaskEventArgs['conversation'],
    args: PendingTaskEvent,
    actor: TaskActor,
    sysMessage: string,
  ): Promise<void> {
    const { kind } = args;
    // broadcastFresh serves only the workflow paths (claim/unclaim/status).
    // `create` publishes directly and `edit` uses publishEdit, so neither is a
    // legal kind here. Asserting it both guards at runtime and narrows `kind` to
    // the workflow union `broadcast` accepts — the type now forbids an edit from
    // reaching the all-member deliver loop.
    if (kind === 'create' || kind === 'edit') {
      throw new Error(`broadcastFresh received non-workflow kind: ${kind}`);
    }
    const fresh = this.store.refetchTaskSnapshot(args.taskId);
    await this.broadcaster.broadcast({
      ...args,
      conversation: ownerConv,
      kind,
      title: fresh?.title ?? args.title,
      status: fresh?.status ?? args.status,
      assignee: fresh?.assignee ?? args.assignee,
      closedAt: fresh?.closed_at ?? args.closedAt,
      actor,
      sysMessage,
    });
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
}

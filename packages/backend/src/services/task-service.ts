import type { Database as Db } from 'better-sqlite3';
import {
  type ClaimErrorCode,
  type ClaimResultEntry,
  type ConversationDto,
  type CreateTasksResult,
  type TaskAssigneeDto,
  type TaskMutationResult,
  type TaskStatus,
  type TaskSummaryDto,
} from '@silverhand/shared';
import { assertActorConversationMatch } from '../auth/principal.js';
import { TaskStore } from './task/store.js';
import { TaskAccessControl } from './task/access.js';
import { TaskBroadcaster } from './task/broadcaster.js';
import {
  failClaim,
  firstLine,
  isThreadAnchor,
  mutationFailure,
  userCanAccessConversation,
  VALID_TRANSITIONS,
  type AgentActor,
  type AgentCapabilityChecker,
  type AgentTaskRef,
  type ClaimTaskInput,
  type CreateTasksInput,
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
  ListTasksFilters,
  TaskActor,
  TaskServiceOptions,
  UnclaimTaskInput,
  UpdateStatusInput,
  WorkspaceSelector,
} from './task/contracts.js';

/**
 * TaskService is the single owner of task create / claim / unclaim /
 * status side effects. Routes translate auth + input shape and call
 * one method per op, parameterized by `actor`. Bulk fan-out (claim
 * with mixed task_numbers + message_ids) lives in the agent route,
 * not here — service is single-target.
 *
 * Contract:
 * - Each mutating op runs validate + write inside ONE db.transaction().
 * - After commit, side effects fire in this exact order:
 *     1. insert system narrative message (own small txn)
 *     2. publish 'message' event for the system narrative
 *     3. publish 'task_changed' on conversation scope
 *     4. publishToScope('workspace:<wid>', 'task_changed')
 *     5. best-effort, fire-and-forget per-recipient deliverMessage
 *   Today's tasks.ts awaits deliver before publishing — PR-5 inverts
 *   that to match PR-1/PR-2/PR-3.
 * - For agent ops, target workspace is resolved from the optional
 *   `workspace_id` / `workspace_name` selector or defaults to the
 *   actor's current conversation's workspace. The agent must be a
 *   member of the resolved workspace. Cross-channel within the same
 *   workspace is permitted; the legacy `wrong_conversation` gate is
 *   only retained on the message-id promotion path (a regular
 *   message can only become a task in its own conversation).
 * - Number scope (`task_workspace_id`) is the physical
 *   `conversation.workspace_id`. PR-6 makes agent_home workspaces real,
 *   so task DTO workspace_id is the natural physical scope for regular
 *   and DM alike.
 * - Return shape stays `{success:false, reason, code}` (preserves the
 *   MCP claim_tasks tool contract); typed `code` is additive.
 *
 * This class is the task-lifecycle aggregate root: it owns the mutation
 * transactions and their invariants directly. Peripheral concerns are
 * delegated to collaborators constructed here — `TaskStore` (all task-row
 * SQL + the read queries), `TaskAccessControl` (pre-tx actor / workspace /
 * message-id authorization), and `TaskBroadcaster` (post-commit system
 * narrative, `task_changed` events, delivery, and cross-op audit).
 */
export class TaskService {
  private readonly db: Db;
  private readonly conversations: TaskServiceOptions['conversations'];
  private readonly messages: TaskServiceOptions['messages'];
  private readonly agents: TaskServiceOptions['agents'];
  private readonly canUseCapability: AgentCapabilityChecker;
  private readonly store: TaskStore;
  private readonly access: TaskAccessControl;
  private readonly broadcaster: TaskBroadcaster;

  constructor(opts: TaskServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.messages = opts.messages;
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

  getByMessageId(messageId: string, actor: TaskActor): TaskSummaryDto | null {
    return this.store.getByMessageId(messageId, actor);
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
      const target = this.store.fetchMessage(targetMessageId);
      if (!target || target.conversation_id !== input.conversationId) {
        return { error: 'reply_target_not_found' };
      }
      threadRootId = target.thread_root_id ?? target.id;
    }

    const taskWorkspaceId = conversation.workspace_id;
    const created: { message_id: string; task_number: number; title: string }[] =
      this.db.transaction(() => {
        const out: { message_id: string; task_number: number; title: string }[] = [];
        for (const t of input.tasks) {
          const msg = this.messages.insertForConversation({
            conversationId: input.conversationId,
            fromKind: input.actor.kind,
            fromAgentId: input.actor.kind === 'agent' ? input.actor.agentId : null,
            fromUserId: input.actor.kind === 'user' ? input.actor.userId : null,
            content: t.body && t.body.length > 0 ? t.body : t.title,
            threadRootId,
          });
          const nextNumber = this.store.writeOpenTaskRow(msg.id, taskWorkspaceId, t.title);
          out.push({ message_id: msg.id, task_number: nextNumber, title: t.title });
        }
        return out;
      })();

    const actorLabel = this.actorLabel(input.actor);
    for (const t of created) {
      await this.broadcaster.broadcast({
        conversation,
        kind: 'create',
        messageId: t.message_id,
        taskNumber: t.task_number,
        title: t.title,
        status: 'todo',
        assignee: null,
        closedAt: null,
        actor: input.actor,
        sysMessage: `${actorLabel} created task #${t.task_number} "${t.title}"`,
      });
    }

    return { tasks: created };
  }

  private taskThreadTargetMessageId(input: CreateTasksInput): string | undefined {
    return input.legacyReplyToMessageId
      ?? (input.target?.kind === 'thread' ? input.target.message_id : undefined);
  }

  // ── Send-as-task (human composer) ────────────────────────────────
  // `Send as task` promotes the just-sent message into an open todo task
  // in the SAME transaction as the send, so message + task anchor are
  // atomic. This is the human/agent-isomorphic create-from-message
  // operation: it reuses `writeOpenTaskRow` (the one open-task writer,
  // shared with `createTasks`) and the promotion title rule
  // (`firstLine(content)`), and never sets an assignee or touches status
  // beyond `todo`. It deliberately does NOT go through the claim-promote
  // path (which would force `in_progress` + assignee = claimer).

  /**
   * Mark an already-inserted message row as an open todo task. MUST be
   * called inside the caller's transaction (e.g. the send transaction) —
   * it opens no transaction of its own. Title is derived from the
   * message body via the same `firstLine` rule as agent promotion.
   * Throws if the message is missing, is a system row, or is already a
   * task (callers should only invoke it on a freshly-inserted send).
   */
  createOpenTaskFromMessageInTxn(args: {
    messageId: string;
    taskWorkspaceId: string;
  }): { taskNumber: number; title: string } {
    const msg = this.store.fetchMessage(args.messageId);
    if (!msg) {
      throw new Error(`createOpenTaskFromMessage: message ${args.messageId} not found`);
    }
    if (msg.from_kind === 'system') {
      throw new Error('createOpenTaskFromMessage: system message cannot be a task');
    }
    if (msg.task_number !== null) {
      throw new Error('createOpenTaskFromMessage: message is already a task');
    }
    const title = firstLine(msg.content);
    const taskNumber = this.store.writeOpenTaskRow(args.messageId, args.taskWorkspaceId, title);
    return { taskNumber, title };
  }

  /**
   * Post-commit announcement for a send-as-task creation: publishes the
   * `task_changed` (create) event so the task board / caches surface the
   * new open task live. It does NOT insert a "created task #N" system
   * message — for send-as-task the canonical message row IS the task
   * announcement (contract: one row, no duplicate). The board is a
   * projection of that row, not a second copy.
   */
  announceOpenTaskCreated(args: {
    conversation: ConversationDto;
    messageId: string;
    taskNumber: number;
    title: string;
  }): void {
    this.broadcaster.publishTaskChanged({
      conversation: args.conversation,
      kind: 'create',
      messageId: args.messageId,
      taskNumber: args.taskNumber,
      title: args.title,
      status: 'todo',
      assignee: null,
      closedAt: null,
    });
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
    return this.claimTaskUser(input.actor, input.by as UserTaskRef, input.assignee);
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
      return failClaim({
        code: 'conversation_not_found',
        reason: 'conversation not found',
      });
    }
    const actorErr = this.access.validateAgentActorForClaim(actor);
    if (actorErr) return actorErr;

    // #task:530 Round 2 + Round 3 (Cindy `CZ7Un3P5YATZ1GTq` Blocker 1
    // + `zJ4xdGu3uEo68_k7` Blocker 4):
    //  - PROMOTION (message-id of non-task in current conv) → use
    //    `sourceConv.workspace_id`, skip selector entirely.
    //  - MESSAGE-ID-PINNED (message-id of already-numbered task) →
    //    use `msg.task_workspace_id` (the row's own workspace); the
    //    selector, if any, only validates intent (mismatch ⇒
    //    `task_not_found`). Membership of `msg.task_workspace_id` is
    //    ALWAYS required, even without a selector, so a leaked
    //    message id from another workspace can't bypass access.
    //  - TASK-NUMBER lookup → resolve selector → workspace, membership
    //    check via `resolveAgentTaskWorkspace`.
    // Peek is informational only; the txn re-fetches msg + uses
    // `UPDATE ... WHERE id = ?` for atomic correctness.
    let taskWorkspaceId: string | undefined;
    let skipSelector = false;
    // Promotion = message-id of a not-yet-task message in the actor's own
    // conversation (the one path that CREATES a new task). Determined from
    // the peek so the capability gate below can require `create_tasks`
    // before the txn. Over-approximating is fail-SAFE: if a concurrent
    // promote numbers the row between peek and txn, we'd have required
    // `create_tasks` for what becomes a plain claim — stricter, never
    // looser. `task_number` only goes null→number, never back, so the
    // reverse (peek numbered, txn null) cannot happen.
    let isPromotion = false;
    if ('messageId' in by) {
      const peek = this.store.fetchMessage(by.messageId);
      if (peek) {
        if (peek.task_number === null && peek.conversation_id === actor.conversationId) {
          taskWorkspaceId = sourceConv.workspace_id;
          skipSelector = true;
          isPromotion = true;
        } else if (peek.task_number !== null) {
          const access = this.access.validateMessageIdAccess(actor, peek, workspaceSelector);
          if ('failure' in access) {
            return failClaim({
              code: access.failure,
              reason: access.reason,
              messageId: by.messageId,
            });
          }
          taskWorkspaceId = access.workspaceId;
          skipSelector = true;
        }
      }
    }
    if (!skipSelector) {
      const resolved = this.access.resolveAgentTaskWorkspace(
        actor,
        sourceConv,
        workspaceSelector,
        args =>
          failClaim({
            code: args.code,
            reason: args.reason,
            workspaceCandidates: args.candidates,
          }),
      );
      if ('failure' in resolved) return resolved.failure;
      taskWorkspaceId = resolved.workspace.id;
    }
    // taskWorkspaceId is definitely assigned in both branches above.
    const resolvedTaskWorkspaceId = taskWorkspaceId!;

    // Capability gate on the RESOLVED target workspace (doc §3 — for a
    // message-id claim this is the message's own workspace, not the
    // principal's). Typed denial, never downgraded to task_not_found.
    //
    // Two axes, checked in dependency order so the denial names the right
    // bucket:
    //   - Promotion CREATES a new task (same axis as
    //     agentCreateConversationTasks → `create_tasks`) AND lands it
    //     in_progress + self-assigned (a claim → `write_tasks`). It needs
    //     BOTH. Missing create → `capability_denied/create_tasks`; has
    //     create but missing write → `capability_denied/write_tasks`.
    //   - A numbered-task claim is pure mutation → `write_tasks` only
    //     (NOT tightened to also require create_tasks).
    // (Cindy `AVTaRcXa3vuAd0W3` — write-only promotion was a create_tasks
    // bypass.)
    if (
      isPromotion &&
      !this.canUseCapability(actor, resolvedTaskWorkspaceId, 'create_tasks')
    ) {
      return failClaim({
        code: 'capability_denied',
        capability: 'create_tasks',
        reason:
          'agent lacks the create_tasks capability required to promote a message into a new task',
      });
    }
    if (!this.canUseCapability(actor, resolvedTaskWorkspaceId, 'write_tasks')) {
      return failClaim({
        code: 'capability_denied',
        capability: 'write_tasks',
        reason: 'agent lacks the write_tasks capability in the target workspace',
      });
    }

    type ClaimTxOut =
      | { failure: ClaimResultEntry }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          title: string;
          status: TaskStatus;
          ownerConversationId: string;
        };

    const txOut = this.db.transaction((): ClaimTxOut => {
      let row: ReturnType<TaskStore['fetchTaskByMessageId']>;

      if ('messageId' in by) {
        const msg = this.store.fetchMessage(by.messageId);
        if (!msg) {
          return { failure: failClaim({
            code: 'message_not_found',
            reason: 'message not found',
            messageId: by.messageId,
          }) };
        }
        // Promotion (turning a regular message into a task) is the one
        // place where the message MUST live in the actor's current
        // conversation — you can't reach across into another channel
        // and conjure a task from a message there. Cross-workspace
        // task ops only apply once the row already has a task_number.
        if (msg.conversation_id !== actor.conversationId) {
          return { failure: failClaim({
            code: 'wrong_conversation',
            reason: 'message belongs to another conversation; promotion requires the message be in your current conversation',
            messageId: by.messageId,
          }) };
        }
        if (msg.from_kind === 'system') {
          return { failure: failClaim({
            code: 'cannot_promote_system_message',
            reason: 'system messages cannot become tasks',
            messageId: by.messageId,
          }) };
        }
        if (isThreadAnchor(msg.metadata)) {
          return { failure: failClaim({
            code: 'cannot_promote_anchor',
            reason: 'thread anchor messages cannot become tasks',
            messageId: by.messageId,
          }) };
        }
        if (msg.task_number === null) {
          // Promote + claim atomically inside this txn. Promotion uses
          // the actor's conversation's workspace (the source conv's),
          // not the selector — the selector only routes lookups of
          // already-numbered tasks.
          const promoteWorkspaceId = sourceConv.workspace_id;
          const nextNumber = this.store.allocateTaskNumber(promoteWorkspaceId);
          this.db
            .prepare(
              `UPDATE messages
               SET task_number = ?,
                   task_status = 'in_progress',
                   task_title = ?,
                   task_workspace_id = ?,
                   task_assignee_agent_id = ?
               WHERE id = ? AND task_number IS NULL`,
            )
            .run(nextNumber, firstLine(msg.content), promoteWorkspaceId, actor.agentId, msg.id);
          return {
            success: true,
            messageId: msg.id,
            taskNumber: nextNumber,
            title: firstLine(msg.content),
            status: 'in_progress',
            ownerConversationId: msg.conversation_id,
          };
        }
        // Message already a task: row identity is the message id, NOT
        // (selector-workspace, msg.task_number). Pre-txn we already
        // ran validateMessageIdAccess; fetch by id so a different
        // workspace's same-numbered task can never be touched
        // (Round 3 blocker `zJ4xdGu3uEo68_k7`).
        row = this.store.fetchTaskByMessageId(msg.id);
      } else {
        row = this.store.fetchTaskByNumber(resolvedTaskWorkspaceId, by.taskNumber);
      }
      if (!row) {
        return { failure: failClaim({
          code: 'task_not_found',
          reason: 'task not found',
          taskNumber: 'taskNumber' in by ? by.taskNumber : undefined,
        }) };
      }
      if (row.task_status === 'done' || row.task_status === 'closed') {
        return { failure: failClaim({
          code: row.task_status === 'closed' ? 'task_closed' : 'task_done',
          reason: row.task_status === 'closed' ? 'task is closed' : 'task is already done',
          taskNumber: row.task_number,
        }) };
      }
      const update = this.db
        .prepare(
          `UPDATE messages
           SET task_assignee_agent_id = ?,
               task_status = CASE WHEN task_status = 'todo' THEN 'in_progress' ELSE task_status END
           WHERE id = ?
             AND task_assignee_agent_id IS NULL
             AND task_status NOT IN ('done', 'closed')`,
        )
        .run(actor.agentId, row.id);
      if (update.changes === 0) {
        const cur = this.db
          .prepare<[string], { task_assignee_agent_id: string | null; task_status: TaskStatus }>(
            `SELECT task_assignee_agent_id, task_status FROM messages WHERE id = ?`,
          )
          .get(row.id);
        const code: ClaimErrorCode = cur?.task_assignee_agent_id
          ? 'already_claimed'
          : cur?.task_status === 'closed'
            ? 'task_closed'
            : 'task_done';
        return { failure: failClaim({
          code,
          reason: cur?.task_assignee_agent_id
            ? `already claimed by ${cur.task_assignee_agent_id}`
            : `task is ${cur?.task_status ?? 'unknown'}`,
          taskNumber: row.task_number,
        }) };
      }
      const nextStatus: TaskStatus = row.task_status === 'todo' ? 'in_progress' : row.task_status;
      return {
        success: true,
        messageId: row.id,
        taskNumber: row.task_number,
        title: row.task_title ?? firstLine(row.content),
        status: nextStatus,
        ownerConversationId: row.conversation_id,
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const ownerConv =
      txOut.ownerConversationId === sourceConv.id
        ? sourceConv
        : this.conversations.get(txOut.ownerConversationId);
    if (!ownerConv) {
      // Should never happen — we just read the row inside the txn.
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
      taskNumber: txOut.taskNumber,
      taskWorkspaceId: resolvedTaskWorkspaceId,
    });

    const fresh = this.store.refetchTaskSnapshot(txOut.messageId);
    await this.broadcaster.broadcast({
      conversation: ownerConv,
      kind: 'claim',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: fresh?.title ?? txOut.title,
      status: fresh?.task_status ?? txOut.status,
      assignee: fresh?.assignee ?? this.assigneeDtoForAgent(actor.agentId),
      closedAt: fresh?.closed_at ?? null,
      actor,
      sysMessage: `${this.actorLabel(actor)} claimed task #${txOut.taskNumber}`,
    });

    return {
      success: true,
      task_number: txOut.taskNumber,
      message_id: txOut.messageId,
    };
  }

  private async claimTaskUser(
    actor: UserActor,
    by: UserTaskRef,
    assignee: { agentId: string } | undefined,
  ): Promise<ClaimResultEntry> {
    type UserClaimTxOut =
      | { failure: ClaimResultEntry }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          conversationId: string;
          content: string;
        };

    const txOut = this.db.transaction((): UserClaimTxOut => {
      const msg = this.store.fetchMessage(by.messageId);
      if (!msg || msg.task_number === null || !msg.task_workspace_id) {
        return { failure: failClaim({
          code: 'not_a_task',
          reason: 'not a task',
          messageId: by.messageId,
        }) };
      }
      if (!userCanAccessConversation(this.db, actor.userId, msg.conversation_id)) {
        return { failure: failClaim({
          code: 'not_a_task',
          reason: 'not a task',
          messageId: by.messageId,
        }) };
      }
      if (msg.task_status === 'done' || msg.task_status === 'closed') {
        return { failure: failClaim({
          code: msg.task_status === 'closed' ? 'task_closed' : 'task_done',
          reason: msg.task_status === 'closed' ? 'task is closed' : 'task is done',
          taskNumber: msg.task_number,
          messageId: by.messageId,
        }) };
      }
      if (assignee) {
        if (!this.agents.get(assignee.agentId)) {
          return { failure: failClaim({
            code: 'assignee_not_conversation_member',
            reason: 'agent not found',
            messageId: by.messageId,
          }) };
        }
        if (!this.conversations.getAgent(msg.conversation_id, assignee.agentId)) {
          return { failure: failClaim({
            code: 'assignee_not_conversation_member',
            reason: "agent is not a member of this task's conversation",
            messageId: by.messageId,
          }) };
        }
      }
      this.db
        .prepare(
          `UPDATE messages
           SET task_assignee_agent_id = ?,
               task_status = CASE WHEN task_status = 'todo' THEN 'in_progress' ELSE task_status END
           WHERE id = ?`,
        )
        .run(assignee?.agentId ?? null, msg.id);
      return {
        success: true,
        messageId: msg.id,
        taskNumber: msg.task_number,
        conversationId: msg.conversation_id,
        content: msg.content,
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      const fresh = this.store.refetchTaskSnapshot(txOut.messageId);
      const sysMessage = assignee
        ? `task #${txOut.taskNumber} assigned to @${this.agentName(assignee.agentId)} (by user)`
        : `task #${txOut.taskNumber} unassigned (by user)`;
      await this.broadcaster.broadcast({
        conversation,
        kind: 'claim',
        messageId: txOut.messageId,
        taskNumber: txOut.taskNumber,
        title: fresh?.title ?? firstLine(txOut.content),
        status: fresh?.task_status ?? 'in_progress',
        assignee: fresh?.assignee ?? null,
        closedAt: fresh?.closed_at ?? null,
        actor,
        sysMessage,
      });
    }

    return {
      success: true,
      task_number: txOut.taskNumber,
      message_id: txOut.messageId,
    };
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

    // #task:530 Round 3 (Cindy `zJ4xdGu3uEo68_k7` + `YreWED1qOBStvZxG`):
    // for the message-id form of unclaim, the row identity is the
    // message id — selector cannot retarget onto a same-numbered task
    // in another workspace. Membership of `msg.task_workspace_id` is
    // always required even without an explicit selector. Task-number
    // lookups still flow through the selector resolution.
    let taskWorkspaceId: string | undefined;
    let skipSelector = false;
    if ('messageId' in by) {
      const peek = this.store.fetchMessage(by.messageId);
      if (peek && peek.task_number !== null) {
        const access = this.access.validateMessageIdAccess(actor, peek, workspaceSelector);
        if ('failure' in access) {
          return { success: false, code: access.failure, reason: access.reason };
        }
        taskWorkspaceId = access.workspaceId;
        skipSelector = true;
      }
    }
    if (!skipSelector) {
      const resolved = this.access.resolveAgentTaskWorkspace(
        actor,
        sourceConv,
        workspaceSelector,
        args => mutationFailure(args),
      );
      if ('failure' in resolved) return resolved.failure;
      taskWorkspaceId = resolved.workspace.id;
    }
    const resolvedTaskWorkspaceId = taskWorkspaceId!;

    if (!this.canUseCapability(actor, resolvedTaskWorkspaceId, 'write_tasks')) {
      return mutationFailure({
        code: 'capability_denied',
        capability: 'write_tasks',
        reason: 'agent lacks the write_tasks capability in the target workspace',
      });
    }

    type UnclaimAgentTxOut =
      | { failure: TaskMutationResult }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          title: string;
          ownerConversationId: string;
        };

    const txOut = this.db.transaction((): UnclaimAgentTxOut => {
      let row: ReturnType<TaskStore['fetchTaskByMessageId']>;
      if ('messageId' in by) {
        const msg = this.store.fetchMessage(by.messageId);
        if (!msg || msg.task_number === null) {
          return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
        }
        // Message-id form: row identity is the message id itself.
        // validateMessageIdAccess (pre-txn) already authorized this
        // and pinned the workspace; use msg.id so a selector cannot
        // retarget the mutation onto a same-numbered task in another
        // workspace (Round 3 blocker `zJ4xdGu3uEo68_k7`).
        row = this.store.fetchTaskByMessageId(msg.id);
      } else {
        row = this.store.fetchTaskByNumber(resolvedTaskWorkspaceId, by.taskNumber);
      }
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      if (row.task_assignee_agent_id !== actor.agentId) {
        return { failure: { success: false, code: 'not_assignee', reason: 'not the assignee' } };
      }
      if (row.task_status === 'done' || row.task_status === 'closed') {
        return { failure: {
          success: false,
          code: row.task_status === 'closed' ? 'task_closed' : 'task_done',
          reason: row.task_status === 'closed' ? 'task is closed' : 'task is done',
        } };
      }
      this.db
        .prepare(
          `UPDATE messages
           SET task_assignee_agent_id = NULL,
               task_status = 'todo',
               task_closed_at = NULL
           WHERE id = ?`,
        )
        .run(row.id);
      return {
        success: true,
        messageId: row.id,
        taskNumber: row.task_number,
        title: row.task_title ?? firstLine(row.content),
        ownerConversationId: row.conversation_id,
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
      taskNumber: txOut.taskNumber,
      taskWorkspaceId: resolvedTaskWorkspaceId,
    });

    const fresh = this.store.refetchTaskSnapshot(txOut.messageId);
    await this.broadcaster.broadcast({
      conversation: ownerConv,
      kind: 'unclaim',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: fresh?.title ?? txOut.title,
      status: fresh?.task_status ?? 'todo',
      assignee: fresh?.assignee ?? null,
      closedAt: fresh?.closed_at ?? null,
      actor,
      sysMessage: `task #${txOut.taskNumber} unclaimed (was @${this.agentName(actor.agentId)})`,
    });

    return { success: true };
  }

  private async unclaimTaskUser(
    actor: UserActor,
    by: UserTaskRef,
  ): Promise<TaskMutationResult> {
    type UnclaimUserTxOut =
      | { failure: TaskMutationResult }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          conversationId: string;
          content: string;
        };

    const txOut = this.db.transaction((): UnclaimUserTxOut => {
      const msg = this.store.fetchMessage(by.messageId);
      if (!msg || msg.task_number === null) {
        return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
      }
      if (!userCanAccessConversation(this.db, actor.userId, msg.conversation_id)) {
        return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
      }
      if (msg.task_status === 'closed') {
        return { failure: { success: false, code: 'task_closed', reason: 'task is closed' } };
      }
      this.db
        .prepare(
          `UPDATE messages
           SET task_assignee_agent_id = NULL,
               task_status = 'todo',
               task_closed_at = NULL
           WHERE id = ?`,
        )
        .run(msg.id);
      return {
        success: true,
        messageId: msg.id,
        taskNumber: msg.task_number,
        conversationId: msg.conversation_id,
        content: msg.content,
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      const fresh = this.store.refetchTaskSnapshot(txOut.messageId);
      await this.broadcaster.broadcast({
        conversation,
        kind: 'unclaim',
        messageId: txOut.messageId,
        taskNumber: txOut.taskNumber,
        title: fresh?.title ?? firstLine(txOut.content),
        status: 'todo',
        assignee: null,
        closedAt: fresh?.closed_at ?? null,
        actor,
        sysMessage: `task #${txOut.taskNumber} unclaimed (by user)`,
      });
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

    // #task:530 Round 3 mirror of unclaim — message-id form pins the
    // row by message id and always checks `msg.task_workspace_id`
    // membership (Cindy `zJ4xdGu3uEo68_k7` + `YreWED1qOBStvZxG`).
    let taskWorkspaceId: string | undefined;
    let skipSelector = false;
    if ('messageId' in by) {
      const peek = this.store.fetchMessage(by.messageId);
      if (peek && peek.task_number !== null) {
        const access = this.access.validateMessageIdAccess(actor, peek, workspaceSelector);
        if ('failure' in access) {
          return { success: false, code: access.failure, reason: access.reason };
        }
        taskWorkspaceId = access.workspaceId;
        skipSelector = true;
      }
    }
    if (!skipSelector) {
      const resolved = this.access.resolveAgentTaskWorkspace(
        actor,
        sourceConv,
        workspaceSelector,
        args => mutationFailure(args),
      );
      if ('failure' in resolved) return resolved.failure;
      taskWorkspaceId = resolved.workspace.id;
    }
    const resolvedTaskWorkspaceId = taskWorkspaceId!;

    if (!this.canUseCapability(actor, resolvedTaskWorkspaceId, 'write_tasks')) {
      return mutationFailure({
        code: 'capability_denied',
        capability: 'write_tasks',
        reason: 'agent lacks the write_tasks capability in the target workspace',
      });
    }

    type StatusAgentTxOut =
      | { failure: TaskMutationResult }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          title: string;
          assigneeAgentId: string | null;
          ownerConversationId: string;
        };

    const txOut = this.db.transaction((): StatusAgentTxOut => {
      let row: ReturnType<TaskStore['fetchTaskByMessageId']>;
      if ('messageId' in by) {
        const msg = this.store.fetchMessage(by.messageId);
        if (!msg || msg.task_number === null) {
          return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
        }
        // Pin to message id — see unclaim path for rationale.
        row = this.store.fetchTaskByMessageId(msg.id);
      } else {
        row = this.store.fetchTaskByNumber(resolvedTaskWorkspaceId, by.taskNumber);
      }
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      // Permission: assignee==self OR (assignee==null AND creator==self
      // AND creator is an agent). The creator-self branch lets an
      // agent complete/advance its own stale unassigned task without
      // re-claiming; it intentionally never matches human-created rows (Cindy
      // `S-RgXd_GWAHu4f0E`).
      const isAssigneeSelf = row.task_assignee_agent_id === actor.agentId;
      const isCreatorSelfStale =
        row.task_assignee_agent_id === null &&
        row.from_kind === 'agent' &&
        row.from_agent_id === actor.agentId;
      if (!isAssigneeSelf && !isCreatorSelfStale) {
        return { failure: {
          success: false,
          code: 'not_assignee',
          reason:
            'only the assignee can update status (creator may update own unassigned task)',
        } };
      }
      if (!VALID_TRANSITIONS[row.task_status].includes(status)) {
        return { failure: {
          success: false,
          code: 'invalid_transition',
          reason: `invalid transition ${row.task_status} → ${status}`,
        } };
      }
      const nextClosedAt = status === 'closed'
        ? (row.task_closed_at ?? Date.now())
        : null;
      this.db
        .prepare(`UPDATE messages SET task_status = ?, task_closed_at = ? WHERE id = ?`)
        .run(status, nextClosedAt, row.id);
      return {
        success: true,
        messageId: row.id,
        taskNumber: row.task_number,
        title: row.task_title ?? firstLine(row.content),
        assigneeAgentId: row.task_assignee_agent_id,
        ownerConversationId: row.conversation_id,
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
      taskNumber: txOut.taskNumber,
      taskWorkspaceId: resolvedTaskWorkspaceId,
      status,
    });

    const fresh = this.store.refetchTaskSnapshot(txOut.messageId);
    await this.broadcaster.broadcast({
      conversation: ownerConv,
      kind: 'status',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: fresh?.title ?? txOut.title,
      status: fresh?.task_status ?? status,
      assignee: fresh?.assignee ?? (txOut.assigneeAgentId
        ? this.assigneeDtoForAgent(txOut.assigneeAgentId)
        : null),
      closedAt: fresh?.closed_at ?? null,
      actor,
      sysMessage: `task #${txOut.taskNumber} → ${status} (by @${this.agentName(actor.agentId)})`,
    });

    return { success: true };
  }

  private async updateStatusUser(
    actor: UserActor,
    by: UserTaskRef,
    status: TaskStatus,
  ): Promise<TaskMutationResult> {
    type StatusUserTxOut =
      | { failure: TaskMutationResult }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          conversationId: string;
          content: string;
        };

    const txOut = this.db.transaction((): StatusUserTxOut => {
      const msg = this.store.fetchMessage(by.messageId);
      if (!msg || msg.task_number === null) {
        return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
      }
      if (!userCanAccessConversation(this.db, actor.userId, msg.conversation_id)) {
        return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
      }
      if (msg.task_status === status) {
        return { failure: {
          success: false,
          code: 'already_at_status',
          reason: 'task already has that status',
        } };
      }
      const nextClosedAt = status === 'closed'
        ? (msg.task_closed_at ?? Date.now())
        : null;
      this.db
        .prepare(`UPDATE messages SET task_status = ?, task_closed_at = ? WHERE id = ?`)
        .run(status, nextClosedAt, msg.id);
      return {
        success: true,
        messageId: msg.id,
        taskNumber: msg.task_number,
        conversationId: msg.conversation_id,
        content: msg.content,
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    const conversation = this.conversations.get(txOut.conversationId);
    if (conversation) {
      const fresh = this.store.refetchTaskSnapshot(txOut.messageId);
      await this.broadcaster.broadcast({
        conversation,
        kind: 'status',
        messageId: txOut.messageId,
        taskNumber: txOut.taskNumber,
        title: fresh?.title ?? firstLine(txOut.content),
        status,
        assignee: fresh?.assignee ?? null,
        closedAt: fresh?.closed_at ?? null,
        actor,
        sysMessage: `task #${txOut.taskNumber} → ${status} (by user)`,
      });
    }

    return { success: true };
  }

  // ── Actor formatting ───────────────────────────────────────────
  // Small `AgentRepo`-backed label helpers used by the mutation methods to
  // build system-message text and assignee DTOs. Kept on the facade (not the
  // broadcaster) because their callers are the mutation bodies here.

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

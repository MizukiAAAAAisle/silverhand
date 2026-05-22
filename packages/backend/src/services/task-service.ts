import type { Database as Db } from 'better-sqlite3';
import {
  type ClaimErrorCode,
  type ClaimResultEntry,
  type ConversationDto,
  type CreateTasksOpError,
  type CreateTasksResult,
  type MessageRow,
  type TaskAssigneeDto,
  type TaskChangedEvent,
  type TaskMutationErrorCode,
  type TaskMutationResult,
  type TaskStatus,
  type TaskSummaryDto,
  type TaskSystemActor,
  type WorkspaceDto,
  taskSystemSubtype,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import {
  assertActorConversationMatch,
  type AgentPrincipal,
  type UserPrincipal,
} from '../auth/principal.js';

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
 */

export type TaskActor =
  | UserPrincipal
  | AgentPrincipal;

type UserActor = Extract<TaskActor, { kind: 'user' }>;
type AgentActor = Extract<TaskActor, { kind: 'agent' }>;

type AgentTaskRef = { messageId: string } | { taskNumber: number };
type UserTaskRef = { messageId: string };

export interface CreateTasksInput {
  conversationId: string;
  actor: TaskActor;
  tasks: { title: string; body?: string }[];
}

export type ClaimTaskInput =
  | {
      actor: UserActor;
      by: UserTaskRef;
      assignee?: { agentId: string };
    }
  | {
      actor: AgentActor;
      by: AgentTaskRef;
      assignee?: { agentId: string };
      workspaceSelector?: WorkspaceSelector;
    };

export type UnclaimTaskInput =
  | { actor: UserActor; by: UserTaskRef }
  | { actor: AgentActor; by: AgentTaskRef; workspaceSelector?: WorkspaceSelector };

export type UpdateStatusInput =
  | { actor: UserActor; by: UserTaskRef; status: TaskStatus }
  | {
      actor: AgentActor;
      by: AgentTaskRef;
      status: TaskStatus;
      workspaceSelector?: WorkspaceSelector;
    };

/** Optional `--workspace-id` / `--workspace <name>` selector wired
 *  through from the CLI. Empty / undefined means "use the actor's
 *  current conversation's workspace" (the legacy default). The
 *  service validates exclusivity (id XOR name) defensively, even
 *  though the wire schema also enforces it. */
export interface WorkspaceSelector {
  workspaceId?: string;
  workspaceName?: string;
}

export interface ListTasksFilters {
  actor: TaskActor;
  /** user actor: optional filter; agent actor: ignored (service derives
   *  physical workspace from actor.conversationId). */
  workspaceId?: string;
  conversationId?: string;
  /** OR-ed status filter. Empty array or undefined = no filter.
   *  Single-element array is the legacy single-value form. */
  status?: readonly TaskStatus[];
  /** OR-ed task-number filter. Empty array or undefined = no filter. */
  taskNumbers?: readonly number[];
  /** Filter by assignee agent id. Single-valued. */
  assigneeAgentId?: string;
  /** Cap the number of rows returned. */
  limit?: number;
}

export interface TaskServiceOptions {
  db: Db;
  conversations: ConversationRepo;
  messages: MessageRepo;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
}

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: [],
  in_progress: ['in_review', 'done'],
  in_review: ['in_progress', 'done'],
  done: [],
};

interface TaskJoinedRow {
  id: string;
  conversation_id: string;
  from_kind: MessageRow['from_kind'];
  from_agent_id: string | null;
  from_user_id: string | null;
  content: string;
  task_number: number;
  task_status: TaskStatus;
  task_title: string | null;
  workspace_id: string;
  workspace_name: string;
  channel_id: string;
  channel_name: string;
  thread_id: string | null;
  task_assignee_agent_id: string | null;
  task_assignee_user_id: string | null;
  created_at: number;
  conversation_title: string;
  assignee_agent_name: string | null;
  creator_agent_name: string | null;
}

const SELECT_TASK_JOINED = `
  SELECT
    m.id                       AS id,
    m.conversation_id          AS conversation_id,
    m.from_kind                AS from_kind,
    m.from_agent_id            AS from_agent_id,
    m.from_user_id             AS from_user_id,
    m.content                  AS content,
    m.task_number              AS task_number,
    m.task_status              AS task_status,
    m.task_title               AS task_title,
    COALESCE(m.task_workspace_id, conv.workspace_id)
                               AS workspace_id,
    CASE
      WHEN root.kind = 'thread' THEN root.parent_conversation_id
      ELSE root.id
    END                        AS channel_id,
    root.title                 AS channel_name,
    CASE
      WHEN conv.kind = 'thread' THEN conv.id
      ELSE NULL
    END                        AS thread_id,
    m.task_assignee_agent_id   AS task_assignee_agent_id,
    m.task_assignee_user_id    AS task_assignee_user_id,
    m.created_at               AS created_at,
    conv.title                 AS conversation_title,
    w.name                     AS workspace_name,
    aa.display_name            AS assignee_agent_name,
    ca.display_name            AS creator_agent_name
  FROM messages m
  JOIN conversations conv ON conv.id = m.conversation_id
  JOIN workspaces w ON w.id = conv.workspace_id
  JOIN conversations root ON root.id = CASE
    WHEN conv.kind = 'thread' THEN conv.parent_conversation_id
    ELSE conv.id
  END
  LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
  LEFT JOIN agents ca ON ca.id = m.from_agent_id
`;

interface ResolvedTaskRow {
  id: string;
  conversation_id: string;
  task_number: number;
  task_workspace_id: string;
  task_status: TaskStatus;
  task_assignee_agent_id: string | null;
  task_title: string | null;
  content: string;
  owner_conversation_title: string;
  /** Creator origin — used for the "creator may close own stale
   *  unassigned task" exception in `updateStatusAgent`. */
  from_kind: MessageRow['from_kind'];
  from_agent_id: string | null;
}

interface ResolvedMessageRow {
  id: string;
  conversation_id: string;
  from_kind: MessageRow['from_kind'];
  metadata: string | null;
  content: string;
  task_number: number | null;
  task_workspace_id: string | null;
  task_status: TaskStatus | null;
  task_assignee_agent_id: string | null;
  task_title: string | null;
}

export class TaskService {
  private readonly db: Db;
  private readonly conversations: ConversationRepo;
  private readonly messages: MessageRepo;
  private readonly agents: AgentRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;

  constructor(opts: TaskServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.messages = opts.messages;
    this.agents = opts.agents;
    this.workspaces = opts.workspaces;
    this.runtimeHost = opts.runtimeHost;
    this.events = opts.events;
    this.logger = opts.logger;
  }

  // ── Read ─────────────────────────────────────────────────────────

  list(filters: ListTasksFilters): TaskSummaryDto[] {
    const clauses: string[] = ['m.task_number IS NOT NULL'];
    const args: (string | number)[] = [];

    if (filters.actor.kind === 'agent') {
      // The agent path defaults to the actor's current workspace. The
      // route layer is responsible for validating that any explicit
      // `filters.workspaceId` (from the agent's `--workspace-id` flag)
      // exists AND that the agent is a member — see the agent task list
      // route in routes.ts (#task:530). Once validated, we honor the
      // explicit value here so the agent can read a sister workspace's
      // board.
      const conv = this.conversations.get(filters.actor.conversationId);
      if (!conv) return [];
      const effectiveWs = filters.workspaceId ?? conv.workspace_id;
      clauses.push('m.task_workspace_id = ?');
      args.push(effectiveWs);
    } else if (filters.workspaceId) {
      clauses.push('m.task_workspace_id = ?');
      args.push(filters.workspaceId);
    }

    if (filters.conversationId) {
      clauses.push('m.conversation_id = ?');
      args.push(filters.conversationId);
    }
    if (filters.status && filters.status.length > 0) {
      const placeholders = filters.status.map(() => '?').join(',');
      clauses.push(`m.task_status IN (${placeholders})`);
      args.push(...filters.status);
    }
    if (filters.taskNumbers && filters.taskNumbers.length > 0) {
      const placeholders = filters.taskNumbers.map(() => '?').join(',');
      clauses.push(`m.task_number IN (${placeholders})`);
      args.push(...filters.taskNumbers);
    }
    if (filters.assigneeAgentId) {
      clauses.push('m.task_assignee_agent_id = ?');
      args.push(filters.assigneeAgentId);
    }

    let sql = `${SELECT_TASK_JOINED} WHERE ${clauses.join(' AND ')} ORDER BY m.task_number ASC`;
    if (filters.limit && filters.limit > 0) {
      sql += ' LIMIT ?';
      args.push(filters.limit);
    }
    const rows = this.db.prepare<typeof args, TaskJoinedRow>(sql).all(...args);
    return rows.map(r => this.joinedToSummary(r));
  }

  getByMessageId(messageId: string, actor: TaskActor): TaskSummaryDto | null {
    const row = this.db
      .prepare<[string], TaskJoinedRow>(
        `${SELECT_TASK_JOINED} WHERE m.id = ? AND m.task_number IS NOT NULL`,
      )
      .get(messageId);
    if (!row) return null;
    if (actor.kind === 'agent') {
      const conv = this.conversations.get(actor.conversationId);
      if (!conv) return null;
      const physicalRow = this.db
        .prepare<[string], { task_workspace_id: string | null }>(
          `SELECT task_workspace_id FROM messages WHERE id = ?`,
        )
        .get(messageId);
      if (physicalRow?.task_workspace_id !== conv.workspace_id) return null;
    }
    return this.joinedToSummary(row);
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
          });
          const nextNumber = this.allocateTaskNumber(taskWorkspaceId);
          this.db
            .prepare(
              `UPDATE messages
               SET task_number = ?,
                   task_status = 'todo',
                   task_title = ?,
                   task_workspace_id = ?
               WHERE id = ?`,
            )
            .run(nextNumber, t.title, taskWorkspaceId, msg.id);
          out.push({ message_id: msg.id, task_number: nextNumber, title: t.title });
        }
        return out;
      })();

    const actorLabel = this.actorLabel(input.actor);
    for (const t of created) {
      await this.broadcast({
        conversation,
        kind: 'create',
        messageId: t.message_id,
        taskNumber: t.task_number,
        title: t.title,
        status: 'todo',
        assignee: null,
        actor: input.actor,
        sysMessage: `${actorLabel} created task #${t.task_number} "${t.title}"`,
      });
    }

    return { tasks: created };
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
    const actorErr = this.validateAgentActorForClaim(actor);
    if (actorErr) return actorErr;

    // Blocker 1 (#task:530, Cindy `CZ7Un3P5YATZ1GTq`): for a message-id
    // claim of a not-yet-numbered message in the actor's current
    // conversation, the call is a PROMOTION and must target the source
    // conversation's workspace regardless of any --workspace-id /
    // --workspace selector. The selector only routes lookups of
    // already-numbered tasks; running selector resolution first would
    // wrongly reject a valid promotion when the agent accidentally
    // passed a selector. Peek the message here (informational only —
    // the txn below re-validates atomically) to pick the path.
    let promotionWorkspaceId: string | null = null;
    if ('messageId' in by) {
      const peek = this.fetchMessage(by.messageId);
      if (
        peek &&
        peek.task_number === null &&
        peek.conversation_id === actor.conversationId
      ) {
        promotionWorkspaceId = sourceConv.workspace_id;
      }
    }
    let taskWorkspaceId: string;
    if (promotionWorkspaceId !== null) {
      taskWorkspaceId = promotionWorkspaceId;
    } else {
      const resolved = this.resolveAgentTaskWorkspace(
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
      let row: ResolvedTaskRow | null;

      if ('messageId' in by) {
        const msg = this.fetchMessage(by.messageId);
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
          const nextNumber = this.allocateTaskNumber(promoteWorkspaceId);
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
        // Message already a task: route through the selector-resolved
        // workspace (the message's task_workspace_id should match
        // taskWorkspaceId when selector defaults; for explicit selector
        // the lookup may fail naturally).
        row = this.fetchTaskByNumber(taskWorkspaceId, msg.task_number);
      } else {
        row = this.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      }
      if (!row) {
        return { failure: failClaim({
          code: 'task_not_found',
          reason: 'task not found',
          taskNumber: 'taskNumber' in by ? by.taskNumber : undefined,
        }) };
      }
      if (row.task_status === 'done') {
        return { failure: failClaim({
          code: 'task_done',
          reason: 'task is already done',
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
             AND task_status != 'done'`,
        )
        .run(actor.agentId, row.id);
      if (update.changes === 0) {
        const cur = this.db
          .prepare<[string], { task_assignee_agent_id: string | null; task_status: TaskStatus }>(
            `SELECT task_assignee_agent_id, task_status FROM messages WHERE id = ?`,
          )
          .get(row.id);
        const code: ClaimErrorCode = cur?.task_assignee_agent_id ? 'already_claimed' : 'task_done';
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
    this.auditCrossOp({
      op: 'claim',
      actor,
      sourceConv,
      ownerConv,
      taskNumber: txOut.taskNumber,
      taskWorkspaceId,
    });

    await this.broadcast({
      conversation: ownerConv,
      kind: 'claim',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: txOut.title,
      status: txOut.status,
      assignee: this.assigneeDtoForAgent(actor.agentId),
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
      const msg = this.fetchMessage(by.messageId);
      if (!msg || msg.task_number === null || !msg.task_workspace_id) {
        return { failure: failClaim({
          code: 'not_a_task',
          reason: 'not a task',
          messageId: by.messageId,
        }) };
      }
      if (msg.task_status === 'done') {
        return { failure: failClaim({
          code: 'task_done',
          reason: 'task is done',
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
      const fresh = this.refetchTaskSnapshot(txOut.messageId);
      const sysMessage = assignee
        ? `task #${txOut.taskNumber} assigned to @${this.agentName(assignee.agentId)} (by user)`
        : `task #${txOut.taskNumber} unassigned (by user)`;
      await this.broadcast({
        conversation,
        kind: 'claim',
        messageId: txOut.messageId,
        taskNumber: txOut.taskNumber,
        title: fresh?.title ?? firstLine(txOut.content),
        status: fresh?.task_status ?? 'in_progress',
        assignee: fresh?.assignee ?? null,
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
    const actorErr = this.validateAgentActorForMutation(actor);
    if (actorErr) return actorErr;

    const resolved = this.resolveAgentTaskWorkspace(
      actor,
      sourceConv,
      workspaceSelector,
      args => mutationFailure(args),
    );
    if ('failure' in resolved) return resolved.failure;
    const taskWorkspaceId = resolved.workspace.id;

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
      let row: ResolvedTaskRow | null;
      if ('messageId' in by) {
        const msg = this.fetchMessage(by.messageId);
        if (!msg || msg.task_number === null) {
          return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
        }
        // For a numbered task we can look it up anywhere in the
        // resolved workspace — the message-id form is just an
        // alternate key. The promotion-vs-numbered-task split that
        // claim cares about doesn't apply here: unclaim by definition
        // requires the row to already carry a task_number, so we
        // never widen across conversations beyond what the selector
        // already authorized.
        row = this.fetchTaskByNumber(taskWorkspaceId, msg.task_number);
      } else {
        row = this.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      }
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      if (row.task_assignee_agent_id !== actor.agentId) {
        return { failure: { success: false, code: 'not_assignee', reason: 'not the assignee' } };
      }
      if (row.task_status === 'done') {
        return { failure: { success: false, code: 'task_done', reason: 'task is done' } };
      }
      this.db
        .prepare(
          `UPDATE messages
           SET task_assignee_agent_id = NULL,
               task_status = 'todo'
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
    this.auditCrossOp({
      op: 'unclaim',
      actor,
      sourceConv,
      ownerConv,
      taskNumber: txOut.taskNumber,
      taskWorkspaceId,
    });

    await this.broadcast({
      conversation: ownerConv,
      kind: 'unclaim',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: txOut.title,
      status: 'todo',
      assignee: null,
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
      const msg = this.fetchMessage(by.messageId);
      if (!msg || msg.task_number === null) {
        return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
      }
      this.db
        .prepare(
          `UPDATE messages
           SET task_assignee_agent_id = NULL,
               task_status = 'todo'
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
      const fresh = this.refetchTaskSnapshot(txOut.messageId);
      await this.broadcast({
        conversation,
        kind: 'unclaim',
        messageId: txOut.messageId,
        taskNumber: txOut.taskNumber,
        title: fresh?.title ?? firstLine(txOut.content),
        status: 'todo',
        assignee: null,
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
    const actorErr = this.validateAgentActorForMutation(actor);
    if (actorErr) return actorErr;

    const resolved = this.resolveAgentTaskWorkspace(
      actor,
      sourceConv,
      workspaceSelector,
      args => mutationFailure(args),
    );
    if ('failure' in resolved) return resolved.failure;
    const taskWorkspaceId = resolved.workspace.id;

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
      let row: ResolvedTaskRow | null;
      if ('messageId' in by) {
        const msg = this.fetchMessage(by.messageId);
        if (!msg || msg.task_number === null) {
          return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
        }
        row = this.fetchTaskByNumber(taskWorkspaceId, msg.task_number);
      } else {
        row = this.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      }
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      // Permission: assignee==self OR (assignee==null AND creator==self
      // AND creator is an agent). The creator-self branch lets an
      // agent close its own stale unassigned task without re-claiming;
      // it intentionally never matches human-created rows (Cindy
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
          reason: 'only the assignee can update status (creator may close own unassigned task)',
        } };
      }
      if (!VALID_TRANSITIONS[row.task_status].includes(status)) {
        return { failure: {
          success: false,
          code: 'invalid_transition',
          reason: `invalid transition ${row.task_status} → ${status}`,
        } };
      }
      this.db
        .prepare(`UPDATE messages SET task_status = ? WHERE id = ?`)
        .run(status, row.id);
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
    this.auditCrossOp({
      op: 'status',
      actor,
      sourceConv,
      ownerConv,
      taskNumber: txOut.taskNumber,
      taskWorkspaceId,
      status,
    });

    await this.broadcast({
      conversation: ownerConv,
      kind: 'status',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: txOut.title,
      status,
      assignee: txOut.assigneeAgentId
        ? this.assigneeDtoForAgent(txOut.assigneeAgentId)
        : null,
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
      const msg = this.fetchMessage(by.messageId);
      if (!msg || msg.task_number === null) {
        return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
      }
      if (msg.task_status === status) {
        return { failure: {
          success: false,
          code: 'already_at_status',
          reason: 'task already has that status',
        } };
      }
      this.db
        .prepare(`UPDATE messages SET task_status = ? WHERE id = ?`)
        .run(status, msg.id);
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
      const fresh = this.refetchTaskSnapshot(txOut.messageId);
      await this.broadcast({
        conversation,
        kind: 'status',
        messageId: txOut.messageId,
        taskNumber: txOut.taskNumber,
        title: fresh?.title ?? firstLine(txOut.content),
        status,
        assignee: fresh?.assignee ?? null,
        actor,
        sysMessage: `task #${txOut.taskNumber} → ${status} (by user)`,
      });
    }

    return { success: true };
  }

  // ── Internals ──────────────────────────────────────────────────

  private validateAgentActorForClaim(actor: AgentActor): ClaimResultEntry | undefined {
    if (!this.agents.get(actor.agentId)) {
      return failClaim({ code: 'agent_not_found', reason: 'agent not found' });
    }
    if (!this.conversations.getAgent(actor.conversationId, actor.agentId)) {
      return failClaim({
        code: 'not_conversation_member',
        reason: 'agent is not a member of this conversation',
      });
    }
    return undefined;
  }

  private validateAgentActorForMutation(
    actor: AgentActor,
  ): TaskMutationResult | undefined {
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
    return undefined;
  }

  /** True iff the agent counts as a member of the workspace for the
   *  purposes of task ops. `agent_home` workspaces have an implicit
   *  membership (owner_agent_id === agent.id); every other kind goes
   *  through the `workspace_members` table. Mirrors the union in
   *  `WorkspaceRepo.listForAgent`. */
  private isAgentWorkspaceMember(ws: WorkspaceDto, agentId: string): boolean {
    if (ws.workspace_kind === 'agent_home') {
      return ws.owner_agent_id === agentId;
    }
    return this.workspaces.isMember(ws.id, agentId);
  }

  /** Resolve the workspace whose `task_number` namespace the agent op
   *  should target. Returns:
   *  - `{ workspace }` on success
   *  - `{ failure }` envelope using the supplied builder when the
   *    selector is ambiguous / missing / unauthorized
   *
   *  Callers pass a `fail` builder so the same logic can produce either
   *  `ClaimResultEntry` (claim) or `TaskMutationResult` (unclaim /
   *  status) shapes without leaking shape knowledge here. */
  private resolveAgentTaskWorkspace<F>(
    actor: AgentActor,
    sourceConv: ConversationDto,
    selector: WorkspaceSelector | undefined,
    fail: (args: {
      code: 'unknown_workspace' | 'ambiguous_workspace' | 'workspace_membership_required';
      reason: string;
      candidates?: string[];
    }) => F,
  ): { workspace: WorkspaceDto } | { failure: F } {
    // Schema enforces XOR but defend against an out-of-band call.
    if (selector?.workspaceId && selector?.workspaceName) {
      return {
        failure: fail({
          code: 'unknown_workspace',
          reason: 'workspace_id and workspace_name are mutually exclusive',
        }),
      };
    }

    let ws: WorkspaceDto | null = null;
    if (selector?.workspaceId) {
      ws = this.workspaces.get(selector.workspaceId);
      if (!ws) {
        return {
          failure: fail({
            code: 'unknown_workspace',
            reason: `workspace ${selector.workspaceId} not found`,
          }),
        };
      }
    } else if (selector?.workspaceName) {
      const matches = this.workspaces.findAllByName(selector.workspaceName);
      if (matches.length === 0) {
        return {
          failure: fail({
            code: 'unknown_workspace',
            reason: `no workspace named "${selector.workspaceName}"`,
          }),
        };
      }
      if (matches.length > 1) {
        return {
          failure: fail({
            code: 'ambiguous_workspace',
            reason:
              `${matches.length} workspaces named "${selector.workspaceName}"; ` +
              'disambiguate with --workspace-id',
            candidates: matches.map(m => m.id),
          }),
        };
      }
      ws = matches[0]!;
    } else {
      ws = this.workspaces.get(sourceConv.workspace_id);
      if (!ws) {
        // Source conversation exists but its workspace was deleted —
        // should be impossible given FK, but fail clean instead of
        // crashing.
        return {
          failure: fail({
            code: 'unknown_workspace',
            reason: 'current conversation workspace not found',
          }),
        };
      }
    }

    if (!this.isAgentWorkspaceMember(ws, actor.agentId)) {
      return {
        failure: fail({
          code: 'workspace_membership_required',
          reason: `agent is not a member of workspace ${ws.id}`,
        }),
      };
    }
    return { workspace: ws };
  }

  private allocateTaskNumber(workspaceId: string): number {
    const row = this.db
      .prepare<[string], { next: number }>(
        `SELECT COALESCE(MAX(task_number), 0) + 1 AS next
         FROM messages WHERE task_workspace_id = ?`,
      )
      .get(workspaceId);
    return row?.next ?? 1;
  }

  private fetchTaskByNumber(
    taskWorkspaceId: string,
    taskNumber: number,
  ): ResolvedTaskRow | null {
    const row = this.db
      .prepare<[string, number], ResolvedTaskRow>(
        `SELECT m.id,
                m.conversation_id AS conversation_id,
                m.task_number,
                m.task_workspace_id,
                m.task_status,
                m.task_assignee_agent_id,
                m.task_title,
                m.content,
                m.from_kind,
                m.from_agent_id,
                c.title AS owner_conversation_title
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.task_workspace_id = ? AND m.task_number = ?`,
      )
      .get(taskWorkspaceId, taskNumber);
    return row ?? null;
  }

  private fetchMessage(messageId: string): ResolvedMessageRow | null {
    const row = this.db
      .prepare<[string], ResolvedMessageRow>(
        `SELECT id, conversation_id AS conversation_id,
                from_kind, metadata, content,
                task_number, task_workspace_id, task_status,
                task_assignee_agent_id, task_title
         FROM messages WHERE id = ?`,
      )
      .get(messageId);
    return row ?? null;
  }

  private refetchTaskSnapshot(messageId: string): {
    title: string;
    task_status: TaskStatus | null;
    assignee: TaskAssigneeDto | null;
  } | null {
    const row = this.db
      .prepare<[string], {
        content: string;
        task_status: TaskStatus | null;
        task_title: string | null;
        task_assignee_agent_id: string | null;
        task_assignee_user_id: string | null;
        assignee_agent_name: string | null;
      }>(
        `SELECT m.content,
                m.task_status,
                m.task_title,
                m.task_assignee_agent_id,
                m.task_assignee_user_id,
                aa.display_name AS assignee_agent_name
         FROM messages m
         LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
         WHERE m.id = ?`,
      )
      .get(messageId);
    if (!row) return null;
    let assignee: TaskAssigneeDto | null = null;
    if (row.task_assignee_agent_id) {
      assignee = {
        type: 'agent',
        id: row.task_assignee_agent_id,
        name: row.assignee_agent_name ?? row.task_assignee_agent_id,
      };
    } else if (row.task_assignee_user_id) {
      assignee = {
        type: 'user',
        id: row.task_assignee_user_id,
        name: row.task_assignee_user_id,
      };
    }
    return {
      title: row.task_title ?? firstLine(row.content),
      task_status: row.task_status,
      assignee,
    };
  }

  private joinedToSummary(row: TaskJoinedRow): TaskSummaryDto {
    let assignee: TaskAssigneeDto | null = null;
    if (row.task_assignee_agent_id) {
      assignee = {
        type: 'agent',
        id: row.task_assignee_agent_id,
        name: row.assignee_agent_name ?? row.task_assignee_agent_id,
      };
    } else if (row.task_assignee_user_id) {
      assignee = {
        type: 'user',
        id: row.task_assignee_user_id,
        name: row.task_assignee_user_id,
      };
    }
    return {
      message_id: row.id,
      task_number: row.task_number,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      channel_id: row.channel_id,
      channel_name: row.channel_name,
      thread_id: row.thread_id,
      conversation: { id: row.conversation_id, title: row.conversation_title },
      status: row.task_status,
      title: row.task_title ?? firstLine(row.content),
      assignee,
      creator:
        row.from_kind === 'agent' && row.from_agent_id
          ? {
              type: 'agent',
              id: row.from_agent_id,
              name: row.creator_agent_name ?? row.from_agent_id,
            }
          : row.from_kind === 'user'
            ? {
                type: 'user',
                id: row.from_user_id,
                name: row.from_user_id ?? 'user',
              }
            : { type: 'system', id: null, name: 'system' },
      created_at: row.created_at,
    };
  }

  private actorLabel(actor: TaskActor): string {
    if (actor.kind === 'user') return 'user';
    const agent = this.agents.get(actor.agentId);
    return agent ? `@${agent.name}` : 'agent';
  }

  /** Render a `TaskActor` (UserPrincipal | AgentPrincipal) into the
   *  structured `TaskSystemActor` we embed in task system metadata.
   *  Renderers read this to draw an actor pill without parsing
   *  `message.content`. */
  private taskSystemActor(actor: TaskActor): TaskSystemActor {
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

  /** Log a single line per agent task op whenever the call crossed a
   *  conversation/workspace boundary (the actor's running conversation
   *  ≠ the task's owner conversation). Lightweight audit trail per
   *  shiki / Cindy decision — no visible system message hook. */
  private auditCrossOp(args: {
    op: 'claim' | 'unclaim' | 'status';
    actor: AgentActor;
    sourceConv: ConversationDto;
    ownerConv: ConversationDto;
    taskNumber: number;
    taskWorkspaceId: string;
    status?: TaskStatus;
  }): void {
    if (args.sourceConv.id === args.ownerConv.id) return;
    const crossWorkspace = args.sourceConv.workspace_id !== args.ownerConv.workspace_id;
    // warn-level (not info) per Cindy `JLdi59K-TD11CAWy`: backend
    // default log level since #523 is `warn`, so info lines never make
    // it to disk. The message text is intentionally framed as an
    // audit log line, not an exception, so on-call reading
    // `backend-<utc>.log` recognizes it as routine cross-conv activity
    // rather than a fault.
    this.logger.warn(
      {
        op: 'task_cross_op',
        action: args.op,
        agent_id: args.actor.agentId,
        source_conversation_id: args.sourceConv.id,
        source_workspace_id: args.sourceConv.workspace_id,
        owner_conversation_id: args.ownerConv.id,
        owner_workspace_id: args.ownerConv.workspace_id,
        task_workspace_id: args.taskWorkspaceId,
        task_number: args.taskNumber,
        cross_workspace: crossWorkspace,
        ...(args.status ? { status: args.status } : {}),
      },
      'task-service: audit cross-conversation task op',
    );
  }

  private async broadcast(args: {
    conversation: ConversationDto;
    kind: TaskChangedEvent['kind'];
    /** Canonical task body message id — same value for every mutation
     *  on a given task (the row created by `task_create`). Used to
     *  anchor cross-thread / cross-workspace task lookups without
     *  relying on the workspace-scoped `task_number`. */
    messageId: string;
    taskNumber: number;
    title: string;
    /** Status snapshot AFTER this mutation. */
    status: TaskStatus;
    assignee: TaskAssigneeDto | null;
    /** Who triggered the mutation. Rendered as an actor pill on the
     *  task event row instead of being parsed back out of `sysMessage`. */
    actor: TaskActor;
    sysMessage: string;
  }): Promise<void> {
    const conversationId = args.conversation.id;
    const workspaceId = args.conversation.workspace_id;
    const channelId = args.conversation.parent_conversation_id ?? args.conversation.id;
    const threadId = args.conversation.parent_conversation_id ? args.conversation.id : null;

    const systemActor: TaskSystemActor = this.taskSystemActor(args.actor);
    const sysMsg = this.db.transaction(() =>
      this.messages.insertForConversation({
        conversationId,
        fromKind: 'system',
        content: args.sysMessage,
        metadata: {
          subtype: taskSystemSubtype(args.kind),
          task_number: args.taskNumber,
          task_status: args.status,
          task_message_id: args.messageId,
          task_title: args.title,
          task_assignee: args.assignee,
          actor: systemActor,
        },
      }),
    )();

    // Publish FIRST (matches PR-1/PR-2/PR-3 invariant; today's tasks.ts
    // awaits deliver before publish, this inverts that drift).
    this.events.publish(conversationId, {
      kind: 'message',
      payload: { message: sysMsg },
    });
    const event: TaskChangedEvent = {
      kind: args.kind,
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_id: threadId,
      conversation_id: conversationId,
      task_number: args.taskNumber,
      message_id: args.messageId,
      status: args.status,
      assignee: args.assignee,
      title: args.title,
    };
    this.events.publish(conversationId, { kind: 'task_changed', payload: event });
    this.events.publishToScope(`workspace:${workspaceId}`, 'task_changed', event);

    // Best-effort, fire-and-forget delivery to recipients.
    const recipients = this.conversations.listAgents(conversationId);
    for (const ca of recipients) {
      void this.runtimeHost
        .deliverMessage(conversationId, ca.agent_id, sysMsg.id)
        .catch(err => {
          this.logger.warn(
            { err, conversationId, agentId: ca.agent_id, messageId: sysMsg.id },
            'task-service: deliverMessage failed',
          );
        });
    }
  }
}

interface ClaimFailureArgs {
  code: ClaimErrorCode;
  reason: string;
  taskNumber?: number;
  messageId?: string;
  ownerConversation?: { id: string; title: string };
  workspaceCandidates?: string[];
}

function failClaim(args: ClaimFailureArgs): ClaimResultEntry {
  const entry: ClaimResultEntry = {
    success: false,
    code: args.code,
    reason: args.reason,
  };
  if (args.taskNumber !== undefined) entry.task_number = args.taskNumber;
  if (args.messageId !== undefined) entry.message_id = args.messageId;
  if (args.ownerConversation) entry.owner_conversation = args.ownerConversation;
  if (args.workspaceCandidates && args.workspaceCandidates.length > 0) {
    entry.workspace_candidates = args.workspaceCandidates;
  }
  return entry;
}

/** Mirror of `failClaim` for the `TaskMutationResult` shape; used by
 *  the shared workspace resolver to emit unclaim/status failures
 *  without duplicating the envelope-build logic. */
function mutationFailure(args: {
  code: TaskMutationErrorCode;
  reason: string;
  candidates?: string[];
}): TaskMutationResult {
  const out: TaskMutationResult = {
    success: false,
    code: args.code,
    reason: args.reason,
  };
  if (args.candidates && args.candidates.length > 0) {
    out.workspace_candidates = args.candidates;
  }
  return out;
}

function isThreadAnchor(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const md = JSON.parse(metadata) as Record<string, unknown>;
    return typeof md['subtype'] === 'string' && md['subtype'] === 'thread_anchor';
  } catch {
    return false;
  }
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0]!.trim();
  return line.length > 120 ? line.slice(0, 120) + '…' : line || '(empty)';
}

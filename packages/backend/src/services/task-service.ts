import type { Database as Db } from 'better-sqlite3';
import type {
  ClaimErrorCode,
  ClaimResultEntry,
  ConversationDto,
  CreateTasksOpError,
  CreateTasksResult,
  MessageRow,
  TaskAssigneeDto,
  TaskChangedEvent,
  TaskMutationErrorCode,
  TaskMutationResult,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { ConversationManager } from '../conversation-manager.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';

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
 * - For agent ops, `task.conversation_id === actor.conversationId` is
 *   binding (returns wrong_conversation), not informational.
 * - Number scope (`task_workspace_id`) is the physical
 *   `conversation.workspace_id`. PR-6 makes agent_home workspaces real,
 *   so task DTO workspace_id is the natural physical scope for regular
 *   and DM alike.
 * - Return shape stays `{success:false, reason, code}` (preserves the
 *   MCP claim_tasks tool contract); typed `code` is additive.
 */

export type TaskActor =
  | { kind: 'user'; userId: string | null }
  | { kind: 'agent'; agentId: string; conversationId: string };

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
  | { actor: UserActor; by: UserTaskRef; assignee?: { agentId: string } }
  | { actor: AgentActor; by: AgentTaskRef; assignee?: { agentId: string } };

export type UnclaimTaskInput =
  | { actor: UserActor; by: UserTaskRef }
  | { actor: AgentActor; by: AgentTaskRef };

export type UpdateStatusInput =
  | { actor: UserActor; by: UserTaskRef; status: TaskStatus }
  | { actor: AgentActor; by: AgentTaskRef; status: TaskStatus };

export interface ListTasksFilters {
  actor: TaskActor;
  /** user actor: optional filter; agent actor: ignored (service derives
   *  physical workspace from actor.conversationId). */
  workspaceId?: string;
  conversationId?: string;
  status?: TaskStatus | 'all';
}

export interface TaskServiceOptions {
  db: Db;
  conversations: ConversationRepo;
  messages: MessageRepo;
  agents: AgentRepo;
  conversationManager: ConversationManager;
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
  private readonly conversationManager: ConversationManager;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;

  constructor(opts: TaskServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.messages = opts.messages;
    this.agents = opts.agents;
    this.conversationManager = opts.conversationManager;
    this.events = opts.events;
    this.logger = opts.logger;
  }

  // ── Read ─────────────────────────────────────────────────────────

  list(filters: ListTasksFilters): TaskSummaryDto[] {
    const clauses: string[] = ['m.task_number IS NOT NULL'];
    const args: (string | number)[] = [];

    if (filters.actor.kind === 'agent') {
      const conv = this.conversations.get(filters.actor.conversationId);
      if (!conv) return [];
      clauses.push('m.task_workspace_id = ?');
      args.push(conv.workspace_id);
    } else if (filters.workspaceId) {
      clauses.push('m.task_workspace_id = ?');
      args.push(filters.workspaceId);
    }

    if (filters.conversationId) {
      clauses.push('m.conversation_id = ?');
      args.push(filters.conversationId);
    }
    if (filters.status && filters.status !== 'all') {
      clauses.push('m.task_status = ?');
      args.push(filters.status);
    }

    const sql = `${SELECT_TASK_JOINED} WHERE ${clauses.join(' AND ')} ORDER BY m.task_number ASC`;
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
    if (
      input.actor.kind === 'agent' &&
      input.actor.conversationId !== input.conversationId
    ) {
      return { error: 'actor_conversation_mismatch' };
    }
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
        sysMessage: `${actorLabel} created task #${t.task_number} "${t.title}"`,
      });
    }

    return { tasks: created };
  }

  // ── Claim ───────────────────────────────────────────────────────

  async claimTask(input: ClaimTaskInput): Promise<ClaimResultEntry> {
    if (input.actor.kind === 'agent') {
      return this.claimTaskAgent(input.actor, input.by as AgentTaskRef, input.assignee);
    }
    return this.claimTaskUser(input.by as UserTaskRef, input.assignee);
  }

  private async claimTaskAgent(
    actor: AgentActor,
    by: AgentTaskRef,
    assignee: { agentId: string } | undefined,
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
    const taskWorkspaceId = sourceConv.workspace_id;

    type ClaimTxOut =
      | { failure: ClaimResultEntry }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          title: string;
          status: TaskStatus;
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
        if (msg.conversation_id !== actor.conversationId) {
          return { failure: failClaim({
            code: 'wrong_conversation',
            reason: 'message belongs to another conversation',
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
          // Promote + claim atomically inside this txn.
          const nextNumber = this.allocateTaskNumber(taskWorkspaceId);
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
            .run(nextNumber, firstLine(msg.content), taskWorkspaceId, actor.agentId, msg.id);
          return {
            success: true,
            messageId: msg.id,
            taskNumber: nextNumber,
            title: firstLine(msg.content),
            status: 'in_progress',
          };
        }
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
      if (row.conversation_id !== actor.conversationId) {
        return { failure: failClaim({
          code: 'wrong_conversation',
          reason: 'task belongs to another conversation; you cannot claim across conversations',
          taskNumber: row.task_number,
          ownerConversation: {
            id: row.conversation_id,
            title: row.owner_conversation_title,
          },
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
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    await this.broadcast({
      conversation: sourceConv,
      kind: 'claim',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: txOut.title,
      status: txOut.status,
      assignee: this.assigneeDtoForAgent(actor.agentId),
      sysMessage: `${this.actorLabel(actor)} claimed task #${txOut.taskNumber}`,
    });

    return {
      success: true,
      task_number: txOut.taskNumber,
      message_id: txOut.messageId,
    };
  }

  private async claimTaskUser(
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
      return this.unclaimTaskAgent(input.actor, input.by as AgentTaskRef);
    }
    return this.unclaimTaskUser(input.by as UserTaskRef);
  }

  private async unclaimTaskAgent(
    actor: AgentActor,
    by: AgentTaskRef,
  ): Promise<TaskMutationResult> {
    const sourceConv = this.conversations.get(actor.conversationId);
    if (!sourceConv) {
      return { success: false, code: 'conversation_not_found', reason: 'conversation not found' };
    }
    const actorErr = this.validateAgentActorForMutation(actor);
    if (actorErr) return actorErr;
    const taskWorkspaceId = sourceConv.workspace_id;

    type UnclaimAgentTxOut =
      | { failure: TaskMutationResult }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          title: string;
        };

    const txOut = this.db.transaction((): UnclaimAgentTxOut => {
      let row: ResolvedTaskRow | null;
      if ('messageId' in by) {
        const msg = this.fetchMessage(by.messageId);
        if (!msg || msg.task_number === null) {
          return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
        }
        if (msg.conversation_id !== actor.conversationId) {
          return { failure: {
            success: false,
            code: 'wrong_conversation',
            reason: 'message belongs to another conversation',
          } };
        }
        row = this.fetchTaskByNumber(taskWorkspaceId, msg.task_number);
      } else {
        row = this.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      }
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      if (row.conversation_id !== actor.conversationId) {
        return { failure: {
          success: false,
          code: 'wrong_conversation',
          reason: 'task belongs to another conversation',
        } };
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
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    await this.broadcast({
      conversation: sourceConv,
      kind: 'unclaim',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: txOut.title,
      status: 'todo',
      assignee: null,
      sysMessage: `task #${txOut.taskNumber} unclaimed (was @${this.agentName(actor.agentId)})`,
    });

    return { success: true };
  }

  private async unclaimTaskUser(by: UserTaskRef): Promise<TaskMutationResult> {
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
        sysMessage: `task #${txOut.taskNumber} unclaimed (by user)`,
      });
    }

    return { success: true };
  }

  // ── Update status ──────────────────────────────────────────────

  async updateStatus(input: UpdateStatusInput): Promise<TaskMutationResult> {
    if (input.actor.kind === 'agent') {
      return this.updateStatusAgent(input.actor, input.by as AgentTaskRef, input.status);
    }
    return this.updateStatusUser(input.by as UserTaskRef, input.status);
  }

  private async updateStatusAgent(
    actor: AgentActor,
    by: AgentTaskRef,
    status: TaskStatus,
  ): Promise<TaskMutationResult> {
    const sourceConv = this.conversations.get(actor.conversationId);
    if (!sourceConv) {
      return { success: false, code: 'conversation_not_found', reason: 'conversation not found' };
    }
    const actorErr = this.validateAgentActorForMutation(actor);
    if (actorErr) return actorErr;
    const taskWorkspaceId = sourceConv.workspace_id;

    type StatusAgentTxOut =
      | { failure: TaskMutationResult }
      | {
          success: true;
          messageId: string;
          taskNumber: number;
          title: string;
          assigneeAgentId: string | null;
        };

    const txOut = this.db.transaction((): StatusAgentTxOut => {
      let row: ResolvedTaskRow | null;
      if ('messageId' in by) {
        const msg = this.fetchMessage(by.messageId);
        if (!msg || msg.task_number === null) {
          return { failure: { success: false, code: 'not_a_task', reason: 'not a task' } };
        }
        if (msg.conversation_id !== actor.conversationId) {
          return { failure: {
            success: false,
            code: 'wrong_conversation',
            reason: 'message belongs to another conversation',
          } };
        }
        row = this.fetchTaskByNumber(taskWorkspaceId, msg.task_number);
      } else {
        row = this.fetchTaskByNumber(taskWorkspaceId, by.taskNumber);
      }
      if (!row) {
        return { failure: { success: false, code: 'task_not_found', reason: 'task not found' } };
      }
      if (row.conversation_id !== actor.conversationId) {
        return { failure: {
          success: false,
          code: 'wrong_conversation',
          reason: 'task belongs to another conversation',
        } };
      }
      if (row.task_assignee_agent_id !== actor.agentId) {
        return { failure: {
          success: false,
          code: 'not_assignee',
          reason: 'only the assignee can update status',
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
      };
    })();

    if ('failure' in txOut) return txOut.failure;

    await this.broadcast({
      conversation: sourceConv,
      kind: 'status',
      messageId: txOut.messageId,
      taskNumber: txOut.taskNumber,
      title: txOut.title,
      status,
      assignee: txOut.assigneeAgentId
        ? this.assigneeDtoForAgent(txOut.assigneeAgentId)
        : null,
      sysMessage: `task #${txOut.taskNumber} → ${status} (by @${this.agentName(actor.agentId)})`,
    });

    return { success: true };
  }

  private async updateStatusUser(
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

  private async broadcast(args: {
    conversation: ConversationDto;
    kind: TaskChangedEvent['kind'];
    messageId: string;
    taskNumber: number;
    title: string;
    status: TaskStatus;
    assignee: TaskAssigneeDto | null;
    sysMessage: string;
  }): Promise<void> {
    const conversationId = args.conversation.id;
    const workspaceId = args.conversation.workspace_id;
    const channelId = args.conversation.parent_conversation_id ?? args.conversation.id;
    const threadId = args.conversation.parent_conversation_id ? args.conversation.id : null;

    const sysMsg = this.db.transaction(() =>
      this.messages.insertForConversation({
        conversationId,
        fromKind: 'system',
        content: args.sysMessage,
        metadata: {
          subtype: `task_${args.kind}`,
          task_number: args.taskNumber,
          task_status: args.status,
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
      void this.conversationManager
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
  return entry;
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

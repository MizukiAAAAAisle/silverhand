// Task-row persistence gateway: every SQL read and write over the task
// columns of the `messages` table, plus the joined-row → DTO projection. The
// facade delegates its public reads (`list` / `getByMessageId`) here and calls
// the low-level fetch / allocate / stamp helpers inside its own transactions
// (same `db` handle ⇒ same transaction). No task-lifecycle policy lives here —
// only row access and the read-side membership gate.
import type { Database as Db } from 'better-sqlite3';
import type {
  MessageRow,
  TaskAssigneeDto,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import type { ConversationRepo } from '../../repos/conversation-repo.js';
import {
  firstLine,
  userCanAccessConversation,
  type ListTasksFilters,
  type ResolvedMessageRow,
  type ResolvedTaskRow,
  type TaskActor,
} from './contracts.js';

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
  task_closed_at: number | null;
  workspace_id: string;
  workspace_name: string;
  channel_id: string;
  channel_name: string;
  thread_root_id: string | null;
  thread_id: string | null;
  task_assignee_agent_id: string | null;
  task_assignee_user_id: string | null;
  created_at: number;
  conversation_title: string;
  assignee_agent_name: string | null;
  assignee_user_name: string | null;
  creator_agent_name: string | null;
  creator_user_name: string | null;
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
    m.task_closed_at           AS task_closed_at,
    COALESCE(m.task_workspace_id, conv.workspace_id)
                               AS workspace_id,
    conv.id                    AS channel_id,
    conv.title                 AS channel_name,
    m.thread_root_id           AS thread_root_id,
    -- Isolated-thread conversations were retired (#task:1303); thread_id
    -- is a vestigial wire field, always null now.
    NULL                       AS thread_id,
    m.task_assignee_agent_id   AS task_assignee_agent_id,
    m.task_assignee_user_id    AS task_assignee_user_id,
    m.created_at               AS created_at,
    conv.title                 AS conversation_title,
    w.name                     AS workspace_name,
    aa.display_name            AS assignee_agent_name,
    au.display_name            AS assignee_user_name,
    ca.display_name            AS creator_agent_name,
    cu.display_name            AS creator_user_name
  FROM messages m
  JOIN conversations conv ON conv.id = m.conversation_id
  JOIN workspaces w ON w.id = conv.workspace_id
  LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
  LEFT JOIN users au ON au.id = m.task_assignee_user_id
  LEFT JOIN agents ca ON ca.id = m.from_agent_id
  LEFT JOIN users cu ON cu.id = m.from_user_id
`;

export interface TaskStoreDeps {
  db: Db;
  conversations: ConversationRepo;
}

export class TaskStore {
  private readonly db: Db;
  private readonly conversations: ConversationRepo;

  constructor(deps: TaskStoreDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
  }

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
    } else {
      clauses.push(
        `EXISTS (
          SELECT 1
            FROM conversation_users cu
           WHERE cu.conversation_id = m.conversation_id
             AND cu.user_id = ?
        )`,
      );
      args.push(filters.actor.userId);
      if (filters.workspaceId) {
        clauses.push('m.task_workspace_id = ?');
        args.push(filters.workspaceId);
      }
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
    // Newest-first: task_number is a monotonic per-workspace sequence, so
    // DESC surfaces the most recently created tasks at the top — the useful
    // default for both the desktop kanban columns and the CLI `task list`
    // (a `limit` then caps to the newest N). Routes that need a specific task
    // filter by number, so the ordering is purely a list-presentation choice.
    let sql = `${SELECT_TASK_JOINED} WHERE ${clauses.join(' AND ')} ORDER BY m.task_number DESC`;
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
    } else if (!userCanAccessConversation(this.db, actor.userId, row.conversation_id)) {
      return null;
    }
    return this.joinedToSummary(row);
  }

  allocateTaskNumber(workspaceId: string): number {
    const row = this.db
      .prepare<[string], { next: number }>(
        `SELECT COALESCE(MAX(task_number), 0) + 1 AS next
         FROM messages WHERE task_workspace_id = ?`,
      )
      .get(workspaceId);
    return row?.next ?? 1;
  }

  /**
   * The single open-task writer: allocate the next workspace-scoped task
   * number and stamp an existing message row as an open (`todo`) task
   * with the given title and NO assignee. Transaction-agnostic — runs
   * inside the caller's transaction. Shared by `createTasks` and
   * `createOpenTaskFromMessageInTxn` so there is exactly one place that
   * defines what "open task" means on the row.
   */
  writeOpenTaskRow(
    messageId: string,
    taskWorkspaceId: string,
    title: string,
  ): number {
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
      .run(nextNumber, title, taskWorkspaceId, messageId);
    return nextNumber;
  }

  fetchTaskByNumber(
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
                m.task_closed_at,
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

  /** Fetch a task row keyed by message id. The message-id form of
   *  claim/unclaim/status uses this so the row identity stays pinned
   *  to the message — Cindy `zJ4xdGu3uEo68_k7` Round 2 blocker:
   *  reaching the row via `fetchTaskByNumber(selectorWs, msg.task_number)`
   *  would let a `--workspace-id` selector silently retarget the
   *  mutation onto a same-numbered task in another workspace. The
   *  message id is the canonical key. */
  fetchTaskByMessageId(messageId: string): ResolvedTaskRow | null {
    const row = this.db
      .prepare<[string], ResolvedTaskRow>(
        `SELECT m.id,
                m.conversation_id AS conversation_id,
                m.task_number,
                m.task_workspace_id,
                m.task_status,
                m.task_closed_at,
                m.task_assignee_agent_id,
                m.task_title,
                m.content,
                m.from_kind,
                m.from_agent_id,
                c.title AS owner_conversation_title
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND m.task_number IS NOT NULL`,
      )
      .get(messageId);
    return row ?? null;
  }

  fetchMessage(messageId: string): ResolvedMessageRow | null {
    const row = this.db
      .prepare<[string], ResolvedMessageRow>(
        `SELECT id, conversation_id AS conversation_id,
                thread_root_id,
                from_kind, metadata, content,
                task_number, task_workspace_id, task_status, task_closed_at,
                task_assignee_agent_id, task_title
         FROM messages WHERE id = ?`,
      )
      .get(messageId);
    return row ?? null;
  }

  refetchTaskSnapshot(messageId: string): {
    title: string;
    task_status: TaskStatus | null;
    closed_at: number | null;
    assignee: TaskAssigneeDto | null;
  } | null {
    const row = this.db
      .prepare<[string], {
        content: string;
        task_status: TaskStatus | null;
        task_closed_at: number | null;
        task_title: string | null;
        task_assignee_agent_id: string | null;
        task_assignee_user_id: string | null;
        assignee_agent_name: string | null;
        assignee_user_name: string | null;
      }>(
        `SELECT m.content,
                m.task_status,
                m.task_closed_at,
                m.task_title,
                m.task_assignee_agent_id,
                m.task_assignee_user_id,
                aa.display_name AS assignee_agent_name,
                au.display_name AS assignee_user_name
         FROM messages m
         LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
         LEFT JOIN users au ON au.id = m.task_assignee_user_id
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
        name: row.assignee_user_name ?? row.task_assignee_user_id,
      };
    }
    return {
      title: row.task_title ?? firstLine(row.content),
      task_status: row.task_status,
      closed_at: row.task_closed_at,
      assignee,
    };
  }

  joinedToSummary(row: TaskJoinedRow): TaskSummaryDto {
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
        name: row.assignee_user_name ?? row.task_assignee_user_id,
      };
    }
    return {
      message_id: row.id,
      task_number: row.task_number,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      channel_id: row.channel_id,
      channel_name: row.channel_name,
      thread_root_id: row.thread_root_id,
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
                name: row.creator_user_name ?? row.from_user_id ?? 'user',
            }
          : { type: 'system', id: null, name: 'system' },
      created_at: row.created_at,
      closed_at: row.task_closed_at,
    };
  }
}

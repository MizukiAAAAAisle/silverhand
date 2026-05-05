/**
 * Tasks — per docs/tasks-design.md.
 *
 * A task is a `messages` row with task_* metadata populated. Numbering
 * space is per-workspace (monotonic #1..N across all conversations in the
 * workspace), operation scope is per-conversation (only agents in the task's
 * conversation may claim/unclaim/update). Human UI bypasses the
 * conversation-scope check.
 *
 * This module hosts:
 *   - Pure DB atomics (claim UPDATE-with-WHERE, next-number allocation)
 *   - Fan-out: system-message broadcast + SSE `task_changed` event
 *
 * It does NOT handle HTTP; routes.ts wires the endpoints to these
 * functions. Keeps transaction boundaries + side-effects in one place,
 * mirroring provision.ts's "operations over multiple repos" shape.
 */

import type { Database as Db } from 'better-sqlite3';
import type {
  ClaimResultEntry,
  ClaimTasksResult,
  ConversationDto,
  CreateTasksResult,
  MessageRow,
  TaskAssigneeDto,
  TaskChangedEvent,
  TaskMutationResult,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import type { BackendContext } from './context.js';
import type { AgentRepo } from './repos/agent-repo.js';
import type { ConversationRepo } from './repos/conversation-repo.js';
import type { MessageRepo } from './repos/message-repo.js';

export type TaskOpError =
  | 'conversation_not_found'
  | 'conversation_closed'
  | 'message_not_found'
  | 'message_not_in_conversation'
  | 'not_a_task'
  | 'wrong_conversation'
  | 'already_task'
  | 'already_claimed'
  | 'already_done'
  | 'invalid_transition'
  | 'not_assignee'
  | 'not_conversation_member'
  | 'system_message_not_allowed'
  | 'thread_message_not_allowed';

export interface TaskDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
}

// ── Row shapes used locally ─────────────────────────────────────────

interface TaskJoinedRow {
  // messages
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
  // denormalized names
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
    CASE
      WHEN root.kind = 'dm_channel' THEN root.id
      ELSE COALESCE(m.task_workspace_id, conv.workspace_id)
    END                        AS workspace_id,
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
    CASE
      WHEN root.kind = 'dm_channel' THEN root.title
      ELSE w.name
    END                        AS workspace_name,
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

function joinedToSummary(row: TaskJoinedRow): TaskSummaryDto {
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
              name: userDisplayName(row.from_user_id),
            }
          : { type: 'system', id: null, name: 'system' },
    created_at: row.created_at,
  };
}

function userDisplayName(userId: string | null | undefined): string {
  return userId ?? 'user';
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0]!.trim();
  return line.length > 120 ? line.slice(0, 120) + '…' : line || '(empty)';
}

// ── List ────────────────────────────────────────────────────────────

export function listTasks(
  deps: TaskDeps,
  filters: {
    workspace_id?: string;
    conversation_id?: string;
    status?: TaskStatus | 'all';
  },
): TaskSummaryDto[] {
  const clauses: string[] = ['m.task_number IS NOT NULL'];
  const args: (string | number)[] = [];
  if (filters.workspace_id) {
    clauses.push(
      `(m.task_workspace_id = ? OR root.id = ?)`,
    );
    args.push(filters.workspace_id, filters.workspace_id);
  }
  if (filters.conversation_id) {
    clauses.push('m.conversation_id = ?');
    args.push(filters.conversation_id);
  }
  if (filters.status && filters.status !== 'all') {
    clauses.push('m.task_status = ?');
    args.push(filters.status);
  }
  const sql = `${SELECT_TASK_JOINED} WHERE ${clauses.join(' AND ')} ORDER BY m.task_number ASC`;
  const rows = deps.ctx.db.prepare<typeof args, TaskJoinedRow>(sql).all(...args);
  return rows.map(joinedToSummary);
}

export function getTaskByMessageId(
  deps: TaskDeps,
  messageId: string,
): TaskSummaryDto | null {
  const row = deps.ctx.db
    .prepare<[string], TaskJoinedRow>(
      `${SELECT_TASK_JOINED} WHERE m.id = ? AND m.task_number IS NOT NULL`,
    )
    .get(messageId);
  return row ? joinedToSummary(row) : null;
}

// ── Create ──────────────────────────────────────────────────────────

export async function createTasksByAgent(
  deps: TaskDeps,
  args: {
    conversationId: string;
    agentId: string;
    tasks: { title: string; body?: string }[];
  },
): Promise<CreateTasksResult | { error: TaskOpError }> {
  const conversation = deps.conversations.get(args.conversationId);
  if (!conversation) return { error: 'conversation_not_found' };
  if (conversation.closed_at !== null) return { error: 'conversation_closed' };
  if (!isConversationMember(deps, args.conversationId, args.agentId)) {
    return { error: 'not_conversation_member' };
  }

  const taskWorkspaceId = conversation.workspace_id;
  const db = deps.ctx.db;
  const created: { message_id: string; task_number: number; title: string }[] = [];

  // Single transaction so concurrent create_tasks calls don't collide
  // on task_number allocation.
  const tx = db.transaction(() => {
    for (const t of args.tasks) {
      const msg = deps.messages.insertForConversation({
        conversationId: args.conversationId,
        fromKind: 'agent',
        fromAgentId: args.agentId,
        content: t.body && t.body.length > 0 ? t.body : t.title,
      });
      const nextNumber = allocateTaskNumber(db, taskWorkspaceId);
      db.prepare(
        `UPDATE messages
         SET task_number = ?,
             task_status = 'todo',
             task_title = ?,
             task_workspace_id = ?
         WHERE id = ?`,
      ).run(nextNumber, t.title, taskWorkspaceId, msg.id);
      created.push({ message_id: msg.id, task_number: nextNumber, title: t.title });
    }
  });
  tx();

  // Post-transaction: system messages + SSE. Keep these out of the TX
  // so publish doesn't happen on rollback.
  const agent = deps.agents.get(args.agentId);
  const actorLabel = agent ? `@${agent.name}` : 'agent';
  for (const t of created) {
    await broadcast(deps, {
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

function allocateTaskNumber(db: Db, workspaceId: string): number {
  const row = db
    .prepare<[string], { next: number }>(
      `SELECT COALESCE(MAX(task_number), 0) + 1 AS next
       FROM messages WHERE task_workspace_id = ?`,
    )
    .get(workspaceId);
  return row?.next ?? 1;
}

// ── Claim ───────────────────────────────────────────────────────────

export async function claimTasksByAgent(
  deps: TaskDeps,
  args: {
    conversationId: string;
    agentId: string;
    task_numbers?: number[];
    message_ids?: string[];
  },
): Promise<ClaimTasksResult | { error: TaskOpError }> {
  const conversation = deps.conversations.get(args.conversationId);
  if (!conversation) return { error: 'conversation_not_found' };
  if (!isConversationMember(deps, args.conversationId, args.agentId)) {
    return { error: 'not_conversation_member' };
  }
  const taskWorkspaceId = conversation.workspace_id;
  const results: ClaimResultEntry[] = [];
  const agent = deps.agents.get(args.agentId);
  const assigneeName = agent?.display_name ?? agent?.name ?? args.agentId;
  const actorLabel = agent ? `@${agent.name}` : 'agent';

  for (const taskNumber of args.task_numbers ?? []) {
    const out = claimByNumber(deps, {
      workspaceId: taskWorkspaceId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      taskNumber,
    });
    results.push(out.entry);
    if (out.entry.success && out.sysMessage) {
      await broadcast(deps, {
        conversation,
        kind: 'claim',
        messageId: out.messageId!,
        taskNumber,
        title: out.title!,
        status: out.status!,
        assignee: { type: 'agent', id: args.agentId, name: assigneeName },
        sysMessage: `${actorLabel} claimed task #${taskNumber}`,
      });
    }
  }

  for (const messageId of args.message_ids ?? []) {
    const out = claimByMessageId(deps, {
      workspaceId: taskWorkspaceId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      messageId,
    });
    results.push(out.entry);
    if (out.entry.success && out.sysMessage) {
      await broadcast(deps, {
        conversation,
        kind: 'claim',
        messageId,
        taskNumber: out.entry.task_number!,
        title: out.title!,
        status: out.status!,
        assignee: { type: 'agent', id: args.agentId, name: assigneeName },
        sysMessage: `${actorLabel} claimed task #${out.entry.task_number!}`,
      });
    }
  }

  return { results };
}

interface ClaimOutcome {
  entry: ClaimResultEntry;
  sysMessage?: boolean;
  messageId?: string;
  title?: string;
  status?: TaskStatus;
}

function claimByNumber(
  deps: TaskDeps,
  args: {
    workspaceId: string;
    conversationId: string;
    agentId: string;
    taskNumber: number;
  },
): ClaimOutcome {
  const db = deps.ctx.db;
  const row = db
    .prepare<[string, number], {
      id: string;
      conversation_id: string;
      task_status: TaskStatus;
      task_assignee_agent_id: string | null;
      task_title: string | null;
      content: string;
      owner_conversation_title: string;
    }>(
      `SELECT m.id,
              m.conversation_id AS conversation_id,
              m.task_status,
              m.task_assignee_agent_id,
              m.task_title,
              m.content,
              c.title AS owner_conversation_title
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.task_workspace_id = ? AND m.task_number = ?`,
    )
    .get(args.workspaceId, args.taskNumber);
  if (!row) {
    return {
      entry: {
        success: false,
        task_number: args.taskNumber,
        reason: 'task not found',
      },
    };
  }
  if (row.conversation_id !== args.conversationId) {
    return {
      entry: {
        success: false,
        task_number: args.taskNumber,
        reason: 'task belongs to another conversation; you cannot claim across conversations',
        owner_conversation: {
          id: row.conversation_id,
          title: row.owner_conversation_title,
        },
      },
    };
  }
  if (row.task_status === 'done') {
    return {
      entry: {
        success: false,
        task_number: args.taskNumber,
        reason: 'task is already done',
      },
    };
  }

  const update = db
    .prepare(
      `UPDATE messages
       SET task_assignee_agent_id = ?,
           task_status = CASE WHEN task_status = 'todo' THEN 'in_progress' ELSE task_status END
       WHERE id = ?
         AND task_assignee_agent_id IS NULL
         AND task_status != 'done'`,
    )
    .run(args.agentId, row.id);

  if (update.changes === 0) {
    // Re-read to produce a specific reason.
    const cur = db
      .prepare<[string], { task_assignee_agent_id: string | null; task_status: TaskStatus }>(
        `SELECT task_assignee_agent_id, task_status FROM messages WHERE id = ?`,
      )
      .get(row.id);
    return {
      entry: {
        success: false,
        task_number: args.taskNumber,
        reason:
          cur?.task_assignee_agent_id
            ? `already claimed by ${cur.task_assignee_agent_id}`
            : `task is ${cur?.task_status ?? 'unknown'}`,
      },
    };
  }

  return {
    entry: { success: true, task_number: args.taskNumber, message_id: row.id },
    sysMessage: true,
    messageId: row.id,
    title: row.task_title ?? firstLine(row.content),
    status: row.task_status === 'todo' ? 'in_progress' : row.task_status,
  };
}

function claimByMessageId(
  deps: TaskDeps,
  args: {
    workspaceId: string;
    conversationId: string;
    agentId: string;
    messageId: string;
  },
): ClaimOutcome {
  const db = deps.ctx.db;
  const msg = db
    .prepare<[string], {
      id: string;
      conversation_id: string;
      from_kind: MessageRow['from_kind'];
      metadata: string | null;
      content: string;
      task_number: number | null;
      task_assignee_agent_id: string | null;
      task_status: TaskStatus | null;
      task_title: string | null;
    }>(
      `SELECT id, conversation_id AS conversation_id,
              from_kind, metadata, content,
              task_number, task_assignee_agent_id, task_status, task_title
       FROM messages WHERE id = ?`,
    )
    .get(args.messageId);
  if (!msg) {
    return {
      entry: { success: false, message_id: args.messageId, reason: 'message not found' },
    };
  }
  if (msg.conversation_id !== args.conversationId) {
    return {
      entry: {
        success: false,
        message_id: args.messageId,
        reason: 'message belongs to another conversation',
      },
    };
  }
  if (msg.from_kind === 'system') {
    return {
      entry: {
        success: false,
        message_id: args.messageId,
        reason: 'system messages cannot become tasks',
      },
    };
  }
  // Thread messages are identified via metadata.thread_anchor or
  // subtype. v1 uses child sessions (not inline threads), but we still
  // reject any message whose metadata flags it as thread-internal —
  // the whole-conversation-as-child model already covers sub-conversation
  // task ownership.
  const md = msg.metadata ? (JSON.parse(msg.metadata) as Record<string, unknown>) : null;
  if (md && typeof md['subtype'] === 'string' && md['subtype'] === 'thread_anchor') {
    return {
      entry: {
        success: false,
        message_id: args.messageId,
        reason: 'thread anchor messages cannot become tasks',
      },
    };
  }

  // Already a task → fall through to numbered-claim semantics on its
  // existing task_number. Treat as a normal claim attempt.
  if (msg.task_number !== null) {
    return claimByNumber(deps, {
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      taskNumber: msg.task_number,
    });
  }

  // Promote + claim atomically.
  const tx = db.transaction(() => {
    const conversation = deps.conversations.get(args.conversationId);
    if (!conversation) throw new Error('conversation not found');
    const nextNumber = allocateTaskNumber(db, args.workspaceId);
    db.prepare(
      `UPDATE messages
       SET task_number = ?,
           task_status = 'in_progress',
           task_title = ?,
           task_workspace_id = ?,
           task_assignee_agent_id = ?
       WHERE id = ? AND task_number IS NULL`,
    ).run(
      nextNumber,
      firstLine(msg.content),
      args.workspaceId,
      args.agentId,
      msg.id,
    );
    return nextNumber;
  });
  const newNumber = tx();

  return {
    entry: {
      success: true,
      task_number: newNumber,
      message_id: msg.id,
    },
    sysMessage: true,
    messageId: msg.id,
    title: firstLine(msg.content),
    status: 'in_progress',
  };
}

// ── Unclaim ─────────────────────────────────────────────────────────

export async function unclaimTaskByAgent(
  deps: TaskDeps,
  args: { conversationId: string; agentId: string; taskNumber: number },
): Promise<TaskMutationResult | { error: TaskOpError }> {
  const conversation = deps.conversations.get(args.conversationId);
  if (!conversation) return { error: 'conversation_not_found' };
  if (!isConversationMember(deps, args.conversationId, args.agentId)) {
    return { error: 'not_conversation_member' };
  }

  const db = deps.ctx.db;
  const row = db
    .prepare<[string, number], {
      id: string;
      conversation_id: string;
      task_status: TaskStatus;
      task_assignee_agent_id: string | null;
      task_title: string | null;
      content: string;
    }>(
      `SELECT id, conversation_id AS conversation_id,
              task_status, task_assignee_agent_id,
              task_title, content
       FROM messages
       WHERE task_workspace_id = ? AND task_number = ?`,
    )
    .get(conversation.workspace_id, args.taskNumber);
  if (!row) return { success: false, reason: 'task not found' };
  if (row.conversation_id !== args.conversationId) {
    return { success: false, reason: 'task belongs to another conversation' };
  }
  if (row.task_assignee_agent_id !== args.agentId) {
    return { success: false, reason: 'not the assignee' };
  }
  if (row.task_status === 'done') {
    return { success: false, reason: 'task is done' };
  }

  db.prepare(
    `UPDATE messages
     SET task_assignee_agent_id = NULL,
         task_status = 'todo'
     WHERE id = ?`,
  ).run(row.id);

  const agent = deps.agents.get(args.agentId);
  await broadcast(deps, {
    conversation,
    kind: 'unclaim',
    messageId: row.id,
    taskNumber: args.taskNumber,
    title: row.task_title ?? firstLine(row.content),
    status: 'todo',
    assignee: null,
    sysMessage: `task #${args.taskNumber} unclaimed (was @${agent?.name ?? args.agentId})`,
  });

  return { success: true };
}

// ── Update status ───────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: [], // claim is the only way out of todo — reject direct updates
  in_progress: ['in_review', 'done'],
  in_review: ['in_progress', 'done'],
  done: [],
};

export async function updateTaskStatusByAgent(
  deps: TaskDeps,
  args: {
    conversationId: string;
    agentId: string;
    taskNumber: number;
    status: TaskStatus;
  },
): Promise<TaskMutationResult | { error: TaskOpError }> {
  const conversation = deps.conversations.get(args.conversationId);
  if (!conversation) return { error: 'conversation_not_found' };
  if (!isConversationMember(deps, args.conversationId, args.agentId)) {
    return { error: 'not_conversation_member' };
  }

  const db = deps.ctx.db;
  const row = db
    .prepare<[string, number], {
      id: string;
      conversation_id: string;
      task_status: TaskStatus;
      task_assignee_agent_id: string | null;
      task_title: string | null;
      content: string;
    }>(
      `SELECT id, conversation_id AS conversation_id,
              task_status, task_assignee_agent_id,
              task_title, content
       FROM messages
       WHERE task_workspace_id = ? AND task_number = ?`,
    )
    .get(conversation.workspace_id, args.taskNumber);
  if (!row) return { success: false, reason: 'task not found' };
  if (row.conversation_id !== args.conversationId) {
    return { success: false, reason: 'task belongs to another conversation' };
  }
  if (row.task_assignee_agent_id !== args.agentId) {
    return { success: false, reason: 'only the assignee can update status' };
  }
  if (!VALID_TRANSITIONS[row.task_status].includes(args.status)) {
    return {
      success: false,
      reason: `invalid transition ${row.task_status} → ${args.status}`,
    };
  }

  db.prepare(`UPDATE messages SET task_status = ? WHERE id = ?`).run(
    args.status,
    row.id,
  );

  const agent = deps.agents.get(args.agentId);
  await broadcast(deps, {
    conversation,
    kind: 'status',
    messageId: row.id,
    taskNumber: args.taskNumber,
    title: row.task_title ?? firstLine(row.content),
    status: args.status,
    assignee:
      row.task_assignee_agent_id
        ? {
            type: 'agent',
            id: row.task_assignee_agent_id,
            name: agent?.display_name ?? agent?.name ?? row.task_assignee_agent_id,
          }
        : null,
    sysMessage: `task #${args.taskNumber} → ${args.status} (by @${agent?.name ?? args.agentId})`,
  });

  return { success: true };
}

// ── Human-triggered mutations ──────────────────────────────────────

export async function humanClaim(
  deps: TaskDeps,
  args: { messageId: string; agentId?: string },
): Promise<TaskMutationResult> {
  const db = deps.ctx.db;
  const row = db
    .prepare<[string], {
      id: string;
      conversation_id: string;
      task_number: number | null;
      task_workspace_id: string | null;
      task_status: TaskStatus | null;
      task_assignee_agent_id: string | null;
    }>(
      `SELECT id,
              conversation_id AS conversation_id,
              task_number,
              task_workspace_id,
              task_status,
              task_assignee_agent_id
       FROM messages WHERE id = ?`,
    )
    .get(args.messageId);
  if (!row || row.task_number === null || !row.task_workspace_id) {
    return { success: false, reason: 'not a task' };
  }
  if (row.task_status === 'done') {
    return { success: false, reason: 'task is done' };
  }
  if (args.agentId) {
    // Assignee must be a member of the task's conversation — prevent
    // cross-conversation assignment from the human side too.
    if (!isConversationMember(deps, row.conversation_id, args.agentId)) {
      return { success: false, reason: 'agent is not a member of this task\'s conversation' };
    }
  }
  db.prepare(
    `UPDATE messages
     SET task_assignee_agent_id = ?,
         task_status = CASE WHEN task_status = 'todo' THEN 'in_progress' ELSE task_status END
     WHERE id = ?`,
  ).run(args.agentId ?? null, row.id);

  const fresh = refetchTaskForBroadcast(deps, row.id);
  if (fresh) {
    await broadcast(deps, {
      conversationId: fresh.conversation_id,
      workspaceId: fresh.workspace_id,
      channelId: fresh.channel_id,
      threadId: fresh.thread_id,
      kind: 'claim',
      messageId: fresh.id,
      taskNumber: fresh.task_number!,
      title: fresh.title,
      status: fresh.task_status!,
      assignee: fresh.assignee,
      sysMessage: args.agentId
        ? `task #${fresh.task_number} assigned to @${fresh.assignee?.name ?? args.agentId} (by user)`
        : `task #${fresh.task_number} unassigned (by user)`,
    });
  }
  return { success: true };
}

export async function humanUnclaim(
  deps: TaskDeps,
  args: { messageId: string },
): Promise<TaskMutationResult> {
  const db = deps.ctx.db;
  const row = db
    .prepare<[string], {
      id: string;
      task_number: number | null;
      task_assignee_agent_id: string | null;
    }>(
      `SELECT id, task_number, task_assignee_agent_id
       FROM messages WHERE id = ?`,
    )
    .get(args.messageId);
  if (!row || row.task_number === null) return { success: false, reason: 'not a task' };

  db.prepare(
    `UPDATE messages
     SET task_assignee_agent_id = NULL,
         task_status = 'todo'
     WHERE id = ?`,
  ).run(row.id);

  const fresh = refetchTaskForBroadcast(deps, row.id);
  if (fresh) {
    await broadcast(deps, {
      conversationId: fresh.conversation_id,
      workspaceId: fresh.workspace_id,
      channelId: fresh.channel_id,
      threadId: fresh.thread_id,
      kind: 'unclaim',
      messageId: fresh.id,
      taskNumber: fresh.task_number!,
      title: fresh.title,
      status: 'todo',
      assignee: null,
      sysMessage: `task #${fresh.task_number} unclaimed (by user)`,
    });
  }
  return { success: true };
}

export async function humanUpdateStatus(
  deps: TaskDeps,
  args: { messageId: string; status: TaskStatus },
): Promise<TaskMutationResult> {
  const db = deps.ctx.db;
  const row = db
    .prepare<[string], {
      id: string;
      task_number: number | null;
      task_status: TaskStatus | null;
    }>(
      `SELECT id, task_number, task_status
       FROM messages WHERE id = ?`,
    )
    .get(args.messageId);
  if (!row || row.task_number === null) return { success: false, reason: 'not a task' };
  // Human may override: allow any status other than the current one.
  if (row.task_status === args.status) {
    return { success: false, reason: 'task already has that status' };
  }

  db.prepare(`UPDATE messages SET task_status = ? WHERE id = ?`).run(
    args.status,
    row.id,
  );

  const fresh = refetchTaskForBroadcast(deps, row.id);
  if (fresh) {
    await broadcast(deps, {
      conversationId: fresh.conversation_id,
      workspaceId: fresh.workspace_id,
      channelId: fresh.channel_id,
      threadId: fresh.thread_id,
      kind: 'status',
      messageId: fresh.id,
      taskNumber: fresh.task_number!,
      title: fresh.title,
      status: args.status,
      assignee: fresh.assignee,
      sysMessage: `task #${fresh.task_number} → ${args.status} (by user)`,
    });
  }
  return { success: true };
}

// ── helpers ────────────────────────────────────────────────────────

function isConversationMember(
  deps: TaskDeps,
  conversationId: string,
  agentId: string,
): boolean {
  return deps.conversations
    .listAgents(conversationId)
    .some(ca => ca.agent_id === agentId);
}

interface TaskSnapshotForBroadcast {
  id: string;
  conversation_id: string;
  workspace_id: string;
  channel_id: string;
  thread_id: string | null;
  task_number: number | null;
  task_status: TaskStatus | null;
  title: string;
  assignee: TaskAssigneeDto | null;
}

function refetchTaskForBroadcast(
  deps: TaskDeps,
  messageId: string,
): TaskSnapshotForBroadcast | null {
  const row = deps.ctx.db
    .prepare<[string], {
      id: string;
      conversation_id: string;
      content: string;
      task_number: number | null;
      workspace_id: string;
      channel_id: string;
      thread_id: string | null;
      task_workspace_id: string | null;
      task_status: TaskStatus | null;
      task_title: string | null;
      task_assignee_agent_id: string | null;
      task_assignee_user_id: string | null;
      assignee_agent_name: string | null;
    }>(
      `SELECT m.id,
              m.conversation_id AS conversation_id,
              m.content,
              m.task_number,
              CASE
                WHEN root.kind = 'dm_channel' THEN root.id
                ELSE COALESCE(m.task_workspace_id, conv.workspace_id)
              END AS workspace_id,
              CASE
                WHEN conv.kind = 'thread' THEN conv.parent_conversation_id
                ELSE conv.id
              END AS channel_id,
              CASE
                WHEN conv.kind = 'thread' THEN conv.id
                ELSE NULL
              END AS thread_id,
              m.task_workspace_id,
              m.task_status,
              m.task_title,
              m.task_assignee_agent_id, m.task_assignee_user_id,
              aa.display_name AS assignee_agent_name
       FROM messages m
       JOIN conversations conv ON conv.id = m.conversation_id
       JOIN conversations root ON root.id = CASE
         WHEN conv.kind = 'thread' THEN conv.parent_conversation_id
         ELSE conv.id
       END
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
    id: row.id,
    conversation_id: row.conversation_id,
    workspace_id: row.workspace_id,
    channel_id: row.channel_id,
    thread_id: row.thread_id,
    task_number: row.task_number,
    task_status: row.task_status,
    title: row.task_title ?? firstLine(row.content),
    assignee,
  };
}

async function broadcast(
  deps: TaskDeps,
  args: {
    conversation?: ConversationDto;
    conversationId?: string;
    workspaceId?: string;
    channelId?: string;
    threadId?: string | null;
    kind: TaskChangedEvent['kind'];
    messageId: string;
    taskNumber: number;
    title: string;
    status: TaskStatus;
    assignee: TaskAssigneeDto | null;
    sysMessage: string;
  },
): Promise<void> {
  const conversationId = args.conversation?.id ?? args.conversationId;
  const workspaceId = args.conversation
    ? taskWorkspaceScopeId(args.conversation)
    : args.workspaceId;
  const channelId = args.conversation
    ? taskChannelId(args.conversation)
    : args.channelId;
  const threadId = args.conversation
    ? taskThreadId(args.conversation)
    : args.threadId ?? null;
  if (!conversationId || !workspaceId || !channelId) {
    throw new Error('task broadcast missing conversation scope');
  }
  // 1. Write the system message. Follows the same pattern as
  //    workspace membership announces — so the inbox drain picks
  //    it up for any idle agent on next spawn.
  const sysMsg = deps.messages.insertForConversation({
    conversationId,
    fromKind: 'system',
    content: args.sysMessage,
    metadata: {
      subtype: `task_${args.kind}`,
      task_number: args.taskNumber,
      task_status: args.status,
    },
  });
  const recipients = deps.conversations.listAgents(conversationId);
  for (const ca of recipients) {
    await deps.ctx.conversationManager.deliverMessage(conversationId, ca.agent_id, sysMsg.id);
  }
  deps.ctx.events.publish(conversationId, {
    kind: 'message',
    payload: { message: sysMsg },
  });

  // 2. Emit the typed task_changed event (independent of the chat
  //    message). Consumers: renderer task drawers, NavRail task badge,
  //    global task list.
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
  deps.ctx.events.publish(conversationId, { kind: 'task_changed', payload: event });
}

function taskWorkspaceScopeId(conversation: ConversationDto): string {
  if (conversation.kind === 'dm_channel') return conversation.id;
  return conversation.workspace_id;
}

function taskChannelId(conversation: ConversationDto): string {
  return conversation.parent_conversation_id ?? conversation.id;
}

function taskThreadId(conversation: ConversationDto): string | null {
  return conversation.parent_conversation_id ? conversation.id : null;
}

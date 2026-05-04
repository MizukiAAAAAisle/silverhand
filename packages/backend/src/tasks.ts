/**
 * Tasks — per docs/tasks-design.md.
 *
 * A task is a `messages` row with task_* metadata populated. Numbering
 * space is per-channel (monotonic #1..N across all sessions of the
 * channel), operation scope is per-session (only agents in the task's
 * session may claim/unclaim/update). Human UI bypasses the
 * session-scope check.
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
import type { ChannelRepo } from './repos/channel-repo.js';
import type { MessageRepo } from './repos/message-repo.js';
import type { SessionRepo } from './repos/session-repo.js';

export type TaskOpError =
  | 'session_not_found'
  | 'session_closed'
  | 'message_not_found'
  | 'message_not_in_session'
  | 'not_a_task'
  | 'wrong_session'
  | 'already_task'
  | 'already_claimed'
  | 'already_done'
  | 'invalid_transition'
  | 'not_assignee'
  | 'not_session_member'
  | 'system_message_not_allowed'
  | 'thread_message_not_allowed';

export interface TaskDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  channels: ChannelRepo;
  sessions: SessionRepo;
  messages: MessageRepo;
}

// ── Row shapes used locally ─────────────────────────────────────────

interface TaskJoinedRow {
  // messages
  id: string;
  session_id: string;
  from_kind: MessageRow['from_kind'];
  from_agent_id: string | null;
  from_user_id: string | null;
  content: string;
  task_number: number;
  task_status: TaskStatus;
  task_title: string | null;
  task_channel_id: string;
  task_assignee_agent_id: string | null;
  task_assignee_user_id: string | null;
  created_at: number;
  // sessions
  session_title: string;
  // channels
  channel_name: string;
  // denormalized names
  assignee_agent_name: string | null;
  creator_agent_name: string | null;
}

const SELECT_TASK_JOINED = `
  SELECT
    m.id                       AS id,
    m.session_id               AS session_id,
    m.from_kind                AS from_kind,
    m.from_agent_id            AS from_agent_id,
    m.from_user_id             AS from_user_id,
    m.content                  AS content,
    m.task_number              AS task_number,
    m.task_status              AS task_status,
    m.task_title               AS task_title,
    m.task_channel_id          AS task_channel_id,
    m.task_assignee_agent_id   AS task_assignee_agent_id,
    m.task_assignee_user_id    AS task_assignee_user_id,
    m.created_at               AS created_at,
    s.title                    AS session_title,
    c.name                     AS channel_name,
    aa.display_name            AS assignee_agent_name,
    ca.display_name            AS creator_agent_name
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  JOIN channels c ON c.id = m.task_channel_id
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
    channel_id: row.task_channel_id,
    channel_name: row.channel_name,
    session: { id: row.session_id, title: row.session_title },
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
    channel_id?: string;
    session_id?: string;
    status?: TaskStatus | 'all';
  },
): TaskSummaryDto[] {
  const clauses: string[] = ['m.task_number IS NOT NULL'];
  const args: (string | number)[] = [];
  if (filters.channel_id) {
    clauses.push('m.task_channel_id = ?');
    args.push(filters.channel_id);
  }
  if (filters.session_id) {
    clauses.push('m.session_id = ?');
    args.push(filters.session_id);
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
    sessionId: string;
    agentId: string;
    tasks: { title: string; body?: string }[];
  },
): Promise<CreateTasksResult | { error: TaskOpError }> {
  const session = deps.sessions.get(args.sessionId);
  if (!session) return { error: 'session_not_found' };
  if (session.closed_at !== null) return { error: 'session_closed' };
  if (!isSessionMember(deps, args.sessionId, args.agentId)) {
    return { error: 'not_session_member' };
  }

  const channelId = session.channel_id;
  const db = deps.ctx.db;
  const created: { message_id: string; task_number: number; title: string }[] = [];

  // Single transaction so concurrent create_tasks calls don't collide
  // on task_number allocation.
  const tx = db.transaction(() => {
    for (const t of args.tasks) {
      const msg = deps.messages.insert({
        sessionId: args.sessionId,
        fromKind: 'agent',
        fromAgentId: args.agentId,
        content: t.body && t.body.length > 0 ? t.body : t.title,
      });
      const nextNumber = allocateTaskNumber(db, channelId);
      db.prepare(
        `UPDATE messages
         SET task_number = ?,
             task_status = 'todo',
             task_title = ?,
             task_channel_id = ?
         WHERE id = ?`,
      ).run(nextNumber, t.title, channelId, msg.id);
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
      sessionId: args.sessionId,
      channelId,
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

function allocateTaskNumber(db: Db, channelId: string): number {
  const row = db
    .prepare<[string], { next: number }>(
      `SELECT COALESCE(MAX(task_number), 0) + 1 AS next
       FROM messages WHERE task_channel_id = ?`,
    )
    .get(channelId);
  return row?.next ?? 1;
}

// ── Claim ───────────────────────────────────────────────────────────

export async function claimTasksByAgent(
  deps: TaskDeps,
  args: {
    sessionId: string;
    agentId: string;
    task_numbers?: number[];
    message_ids?: string[];
  },
): Promise<ClaimTasksResult | { error: TaskOpError }> {
  const session = deps.sessions.get(args.sessionId);
  if (!session) return { error: 'session_not_found' };
  if (!isSessionMember(deps, args.sessionId, args.agentId)) {
    return { error: 'not_session_member' };
  }

  const results: ClaimResultEntry[] = [];
  const agent = deps.agents.get(args.agentId);
  const assigneeName = agent?.display_name ?? agent?.name ?? args.agentId;
  const actorLabel = agent ? `@${agent.name}` : 'agent';

  for (const taskNumber of args.task_numbers ?? []) {
    const out = claimByNumber(deps, {
      channelId: session.channel_id,
      sessionId: args.sessionId,
      agentId: args.agentId,
      taskNumber,
    });
    results.push(out.entry);
    if (out.entry.success && out.sysMessage) {
      await broadcast(deps, {
        sessionId: args.sessionId,
        channelId: session.channel_id,
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
      channelId: session.channel_id,
      sessionId: args.sessionId,
      agentId: args.agentId,
      messageId,
    });
    results.push(out.entry);
    if (out.entry.success && out.sysMessage) {
      await broadcast(deps, {
        sessionId: args.sessionId,
        channelId: session.channel_id,
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
    channelId: string;
    sessionId: string;
    agentId: string;
    taskNumber: number;
  },
): ClaimOutcome {
  const db = deps.ctx.db;
  const row = db
    .prepare<[string, number], {
      id: string;
      session_id: string;
      task_status: TaskStatus;
      task_assignee_agent_id: string | null;
      task_title: string | null;
      content: string;
      owner_session_title: string;
    }>(
      `SELECT m.id, m.session_id, m.task_status, m.task_assignee_agent_id,
              m.task_title, m.content, s.title AS owner_session_title
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE m.task_channel_id = ? AND m.task_number = ?`,
    )
    .get(args.channelId, args.taskNumber);
  if (!row) {
    return {
      entry: {
        success: false,
        task_number: args.taskNumber,
        reason: 'task not found',
      },
    };
  }
  if (row.session_id !== args.sessionId) {
    return {
      entry: {
        success: false,
        task_number: args.taskNumber,
        reason: 'task belongs to another session; you cannot claim across sessions',
        owner_session: { id: row.session_id, title: row.owner_session_title },
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
    channelId: string;
    sessionId: string;
    agentId: string;
    messageId: string;
  },
): ClaimOutcome {
  const db = deps.ctx.db;
  const msg = db
    .prepare<[string], {
      id: string;
      session_id: string;
      from_kind: MessageRow['from_kind'];
      metadata: string | null;
      content: string;
      task_number: number | null;
      task_assignee_agent_id: string | null;
      task_status: TaskStatus | null;
      task_title: string | null;
    }>(
      `SELECT id, session_id, from_kind, metadata, content,
              task_number, task_assignee_agent_id, task_status, task_title
       FROM messages WHERE id = ?`,
    )
    .get(args.messageId);
  if (!msg) {
    return {
      entry: { success: false, message_id: args.messageId, reason: 'message not found' },
    };
  }
  if (msg.session_id !== args.sessionId) {
    return {
      entry: {
        success: false,
        message_id: args.messageId,
        reason: 'message belongs to another session',
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
  // the whole-session-as-child model already covers sub-conversation
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
      channelId: args.channelId,
      sessionId: args.sessionId,
      agentId: args.agentId,
      taskNumber: msg.task_number,
    });
  }

  // Promote + claim atomically.
  const tx = db.transaction(() => {
    const nextNumber = allocateTaskNumber(db, args.channelId);
    db.prepare(
      `UPDATE messages
       SET task_number = ?,
           task_status = 'in_progress',
           task_title = ?,
           task_channel_id = ?,
           task_assignee_agent_id = ?
       WHERE id = ? AND task_number IS NULL`,
    ).run(nextNumber, firstLine(msg.content), args.channelId, args.agentId, msg.id);
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
  args: { sessionId: string; agentId: string; taskNumber: number },
): Promise<TaskMutationResult | { error: TaskOpError }> {
  const session = deps.sessions.get(args.sessionId);
  if (!session) return { error: 'session_not_found' };
  if (!isSessionMember(deps, args.sessionId, args.agentId)) {
    return { error: 'not_session_member' };
  }

  const db = deps.ctx.db;
  const row = db
    .prepare<[string, number], {
      id: string;
      session_id: string;
      task_status: TaskStatus;
      task_assignee_agent_id: string | null;
      task_title: string | null;
      content: string;
    }>(
      `SELECT id, session_id, task_status, task_assignee_agent_id,
              task_title, content
       FROM messages
       WHERE task_channel_id = ? AND task_number = ?`,
    )
    .get(session.channel_id, args.taskNumber);
  if (!row) return { success: false, reason: 'task not found' };
  if (row.session_id !== args.sessionId) {
    return { success: false, reason: 'task belongs to another session' };
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
    sessionId: args.sessionId,
    channelId: session.channel_id,
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
    sessionId: string;
    agentId: string;
    taskNumber: number;
    status: TaskStatus;
  },
): Promise<TaskMutationResult | { error: TaskOpError }> {
  const session = deps.sessions.get(args.sessionId);
  if (!session) return { error: 'session_not_found' };
  if (!isSessionMember(deps, args.sessionId, args.agentId)) {
    return { error: 'not_session_member' };
  }

  const db = deps.ctx.db;
  const row = db
    .prepare<[string, number], {
      id: string;
      session_id: string;
      task_status: TaskStatus;
      task_assignee_agent_id: string | null;
      task_title: string | null;
      content: string;
    }>(
      `SELECT id, session_id, task_status, task_assignee_agent_id,
              task_title, content
       FROM messages
       WHERE task_channel_id = ? AND task_number = ?`,
    )
    .get(session.channel_id, args.taskNumber);
  if (!row) return { success: false, reason: 'task not found' };
  if (row.session_id !== args.sessionId) {
    return { success: false, reason: 'task belongs to another session' };
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
    sessionId: args.sessionId,
    channelId: session.channel_id,
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
      session_id: string;
      task_number: number | null;
      task_channel_id: string | null;
      task_status: TaskStatus | null;
      task_assignee_agent_id: string | null;
    }>(
      `SELECT id, session_id, task_number, task_channel_id, task_status,
              task_assignee_agent_id
       FROM messages WHERE id = ?`,
    )
    .get(args.messageId);
  if (!row || row.task_number === null || !row.task_channel_id) {
    return { success: false, reason: 'not a task' };
  }
  if (row.task_status === 'done') {
    return { success: false, reason: 'task is done' };
  }
  if (args.agentId) {
    // Assignee must be a member of the task's session — prevent
    // "cross-session assignment" from the human side too.
    if (!isSessionMember(deps, row.session_id, args.agentId)) {
      return { success: false, reason: 'agent is not a member of this task\'s session' };
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
      sessionId: fresh.session_id,
      channelId: fresh.task_channel_id!,
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
      sessionId: fresh.session_id,
      channelId: fresh.task_channel_id!,
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
      sessionId: fresh.session_id,
      channelId: fresh.task_channel_id!,
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

function isSessionMember(
  deps: TaskDeps,
  sessionId: string,
  agentId: string,
): boolean {
  return deps.sessions.listAgents(sessionId).some(sa => sa.agent_id === agentId);
}

interface TaskSnapshotForBroadcast {
  id: string;
  session_id: string;
  task_number: number | null;
  task_channel_id: string | null;
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
      session_id: string;
      content: string;
      task_number: number | null;
      task_channel_id: string | null;
      task_status: TaskStatus | null;
      task_title: string | null;
      task_assignee_agent_id: string | null;
      task_assignee_user_id: string | null;
      assignee_agent_name: string | null;
    }>(
      `SELECT m.id, m.session_id, m.content,
              m.task_number, m.task_channel_id, m.task_status, m.task_title,
              m.task_assignee_agent_id, m.task_assignee_user_id,
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
    id: row.id,
    session_id: row.session_id,
    task_number: row.task_number,
    task_channel_id: row.task_channel_id,
    task_status: row.task_status,
    title: row.task_title ?? firstLine(row.content),
    assignee,
  };
}

async function broadcast(
  deps: TaskDeps,
  args: {
    sessionId: string;
    channelId: string;
    kind: TaskChangedEvent['kind'];
    messageId: string;
    taskNumber: number;
    title: string;
    status: TaskStatus;
    assignee: TaskAssigneeDto | null;
    sysMessage: string;
  },
): Promise<void> {
  // 1. Write the system message. Follows the same pattern as
  //    provision.ts's join/leave announces — so the inbox drain picks
  //    it up for any idle agent on next spawn.
  const sysMsg = deps.messages.insert({
    sessionId: args.sessionId,
    fromKind: 'system',
    content: args.sysMessage,
    metadata: {
      subtype: `task_${args.kind}`,
      task_number: args.taskNumber,
      task_status: args.status,
    },
  });
  const recipients = deps.sessions.listAgents(args.sessionId);
  for (const sa of recipients) {
    await deps.ctx.sessionManager.deliverMessage(args.sessionId, sa.agent_id, sysMsg.id);
  }
  deps.ctx.events.publish(args.sessionId, {
    kind: 'message',
    payload: { message: sysMsg },
  });

  // 2. Emit the typed task_changed event (independent of the chat
  //    message). Consumers: renderer task drawers, NavRail task badge,
  //    global task list.
  const event: TaskChangedEvent = {
    kind: args.kind,
    channel_id: args.channelId,
    session_id: args.sessionId,
    task_number: args.taskNumber,
    message_id: args.messageId,
    status: args.status,
    assignee: args.assignee,
    title: args.title,
  };
  deps.ctx.events.publish(args.sessionId, { kind: 'task_changed', payload: event });
}

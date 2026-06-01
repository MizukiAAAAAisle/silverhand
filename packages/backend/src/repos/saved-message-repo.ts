import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  MessageRow,
  SavedMessageRow,
  SavedMessageDto,
  TaskAssigneeDto,
  TaskStatus,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

interface JoinedRow extends SavedMessageRow {
  // Message columns (prefixed in SELECT alias)
  m_id: string;
  m_conversation_id: string;
  m_from_kind: MessageRow['from_kind'];
  m_from_agent_id: string | null;
  m_from_user_id: string | null;
  m_content: string;
  m_metadata: string | null;
  m_seq: number;
  m_created_at: number;
  m_task_number: number | null;
  m_task_status: TaskStatus | null;
  m_task_title: string | null;
  m_task_workspace_id: string | null;
  m_task_closed_at: number | null;
  m_task_assignee_agent_id: string | null;
  m_task_assignee_user_id: string | null;
  m_task_assignee_name: string | null;
  workspace_name: string;
  conversation_title: string;
  channel_id: string;
  thread_id: string | null;
  agent_name: string | null;
}

function rowToDto(row: JoinedRow): SavedMessageDto {
  let assignee: TaskAssigneeDto | null = null;
  if (row.m_task_assignee_agent_id) {
    assignee = {
      type: 'agent',
      id: row.m_task_assignee_agent_id,
      name: row.m_task_assignee_name ?? row.m_task_assignee_agent_id,
    };
  } else if (row.m_task_assignee_user_id) {
    assignee = {
      type: 'user',
      id: row.m_task_assignee_user_id,
      name: row.m_task_assignee_user_id,
    };
  }
  return {
    id: row.id,
    saved_at: row.saved_at,
    workspace_id: row.workspace_id!,
    workspace_name: row.workspace_name,
    conversation_id: row.conversation_id!,
    conversation_title: row.conversation_title,
    channel_id: row.channel_id,
    thread_id: row.thread_id,
    agent_name: row.agent_name,
    message: {
      id: row.m_id,
      conversation_id: row.m_conversation_id,
      from_kind: row.m_from_kind,
      from_agent_id: row.m_from_agent_id,
      from_user_id: row.m_from_user_id,
      content: row.m_content,
      metadata: row.m_metadata
        ? (JSON.parse(row.m_metadata) as Record<string, unknown>)
        : null,
      attachments: extractAttachmentSnapshots(row.m_metadata),
      seq: row.m_seq,
      created_at: row.m_created_at,
      task_number: row.m_task_number,
      task_status: row.m_task_status,
      task_title: row.m_task_title,
      task_workspace_id: row.m_task_workspace_id,
      task_closed_at: row.m_task_closed_at,
      task_assignee: assignee,
    },
  };
}

function extractAttachmentSnapshots(
  rawMetadata: string | null,
): SavedMessageDto['message']['attachments'] {
  if (!rawMetadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const list = (parsed as { attachments?: unknown }).attachments;
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: NonNullable<SavedMessageDto['message']['attachments']> = [];
  for (const item of list) {
    if (
      item
      && typeof item === 'object'
      && typeof (item as { id?: unknown }).id === 'string'
      && typeof (item as { filename?: unknown }).filename === 'string'
      && typeof (item as { size?: unknown }).size === 'number'
      && typeof (item as { content_type?: unknown }).content_type === 'string'
    ) {
      const a = item as { id: string; filename: string; size: number; content_type: string };
      out.push({
        id: a.id,
        filename: a.filename,
        size: a.size,
        content_type: a.content_type,
      });
    }
  }
  return out.length > 0 ? out : null;
}

const SELECT_JOINED = `
  SELECT
    sm.id              AS id,
    sm.message_id      AS message_id,
    sm.conversation_id AS conversation_id,
    sm.workspace_id    AS workspace_id,
    sm.saved_at        AS saved_at,
    m.id               AS m_id,
    m.conversation_id  AS m_conversation_id,
    m.from_kind        AS m_from_kind,
    m.from_agent_id    AS m_from_agent_id,
    m.from_user_id     AS m_from_user_id,
    m.content          AS m_content,
    m.metadata         AS m_metadata,
    m.seq              AS m_seq,
    m.created_at       AS m_created_at,
    m.task_number             AS m_task_number,
    m.task_status             AS m_task_status,
    m.task_title              AS m_task_title,
    m.task_workspace_id       AS m_task_workspace_id,
    m.task_closed_at          AS m_task_closed_at,
    m.task_assignee_agent_id  AS m_task_assignee_agent_id,
    m.task_assignee_user_id   AS m_task_assignee_user_id,
    ta.display_name           AS m_task_assignee_name,
    w.name             AS workspace_name,
    conv.title         AS conversation_title,
    root.id            AS channel_id,
    CASE
      WHEN conv.kind = 'thread' THEN conv.id
      ELSE NULL
    END                AS thread_id,
    a.name             AS agent_name
  FROM saved_messages sm
  JOIN messages m ON m.id = sm.message_id
  JOIN conversations conv ON conv.id = sm.conversation_id
  JOIN workspaces w ON w.id = conv.workspace_id
  JOIN conversations root ON root.id = CASE
    WHEN conv.kind = 'thread' THEN conv.parent_conversation_id
    ELSE conv.id
  END
  LEFT JOIN agents a  ON a.id  = m.from_agent_id
  LEFT JOIN agents ta ON ta.id = m.task_assignee_agent_id
`;

export class SavedMessageRepo {
  constructor(private readonly db: Db) {}

  list(limit = 200): SavedMessageDto[] {
    const rows = this.db
      .prepare<[number], JoinedRow>(
        `${SELECT_JOINED}
         ORDER BY sm.saved_at DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map(rowToDto);
  }

  listForUser(userId: string, limit = 200): SavedMessageDto[] {
    const rows = this.db
      .prepare<[string, number], JoinedRow>(
        `${SELECT_JOINED}
         WHERE EXISTS (
           SELECT 1
             FROM conversation_users cu
            WHERE cu.conversation_id = sm.conversation_id
              AND cu.user_id = ?
         )
         ORDER BY sm.saved_at DESC
         LIMIT ?`,
      )
      .all(userId, limit);
    return rows.map(rowToDto);
  }

  /** Returns the existing row when the message was already saved
   *  (UNIQUE(message_id) makes this idempotent on the client). */
  save(messageId: string): SavedMessageDto | null {
    // Resolve canonical conversation/workspace from the message; INSERT OR
    // IGNORE makes save() idempotent (returns the existing row on duplicate).
    const ctx = this.db
      .prepare<
        [string],
        {
          conversation_id: string;
          workspace_id: string;
        }
      >(
        `SELECT
           m.conversation_id AS conversation_id,
           conv.workspace_id AS workspace_id
         FROM messages m
         JOIN conversations conv ON conv.id = m.conversation_id
         WHERE m.id = ?`,
      )
      .get(messageId);
    if (!ctx) return null;
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO saved_messages
         (id, message_id, conversation_id, workspace_id, saved_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        messageId,
        ctx.conversation_id,
        ctx.workspace_id,
        now,
      );
    return this.getByMessageId(messageId);
  }

  getByMessageId(messageId: string): SavedMessageDto | null {
    const row = this.db
      .prepare<[string], JoinedRow>(
        `${SELECT_JOINED} WHERE sm.message_id = ?`,
      )
      .get(messageId);
    return row ? rowToDto(row) : null;
  }

  /** Returns true when a row was deleted; false when nothing to unsave. */
  remove(messageId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM saved_messages WHERE message_id = ?')
      .run(messageId);
    return result.changes > 0;
  }

  /** Bulk lookup so MessageList can mark which messages are saved
   *  without one round-trip per row. Returns the set of saved message_ids
   *  among the input. */
  filterSaved(messageIds: string[]): Set<string> {
    if (messageIds.length === 0) return new Set();
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<string[], { message_id: string }>(
        `SELECT message_id FROM saved_messages WHERE message_id IN (${placeholders})`,
      )
      .all(...messageIds);
    return new Set(rows.map(r => r.message_id));
  }
}

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
  m_session_id: string;
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
  m_task_channel_id: string | null;
  m_task_assignee_agent_id: string | null;
  m_task_assignee_user_id: string | null;
  m_task_assignee_name: string | null;
  // Channel + session + agent
  channel_name: string;
  session_title: string;
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
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    session_id: row.session_id,
    session_title: row.session_title,
    agent_name: row.agent_name,
    message: {
      id: row.m_id,
      session_id: row.m_session_id,
      from_kind: row.m_from_kind,
      from_agent_id: row.m_from_agent_id,
      from_user_id: row.m_from_user_id,
      content: row.m_content,
      metadata: row.m_metadata
        ? (JSON.parse(row.m_metadata) as Record<string, unknown>)
        : null,
      seq: row.m_seq,
      created_at: row.m_created_at,
      task_number: row.m_task_number,
      task_status: row.m_task_status,
      task_title: row.m_task_title,
      task_channel_id: row.m_task_channel_id,
      task_assignee: assignee,
    },
  };
}

const SELECT_JOINED = `
  SELECT
    sm.id              AS id,
    sm.message_id      AS message_id,
    sm.session_id      AS session_id,
    sm.channel_id      AS channel_id,
    sm.saved_at        AS saved_at,
    m.id               AS m_id,
    m.session_id       AS m_session_id,
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
    m.task_channel_id         AS m_task_channel_id,
    m.task_assignee_agent_id  AS m_task_assignee_agent_id,
    m.task_assignee_user_id   AS m_task_assignee_user_id,
    ta.display_name           AS m_task_assignee_name,
    c.name             AS channel_name,
    s.title            AS session_title,
    a.name             AS agent_name
  FROM saved_messages sm
  JOIN messages m ON m.id = sm.message_id
  JOIN channels c ON c.id = sm.channel_id
  JOIN sessions s ON s.id = sm.session_id
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

  /** Returns the existing row when the message was already saved
   *  (UNIQUE(message_id) makes this idempotent on the client). */
  save(messageId: string): SavedMessageDto | null {
    // Resolve session_id + channel_id from the message; INSERT OR IGNORE
    // makes save() idempotent (returns the existing row on duplicate).
    const ctx = this.db
      .prepare<[string], { session_id: string; channel_id: string }>(
        `SELECT m.session_id AS session_id, s.channel_id AS channel_id
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE m.id = ?`,
      )
      .get(messageId);
    if (!ctx) return null;
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO saved_messages
         (id, message_id, session_id, channel_id, saved_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, messageId, ctx.session_id, ctx.channel_id, now);
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

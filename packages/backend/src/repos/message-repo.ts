import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  FromKind,
  MessageDto,
  MessageRow,
  TaskAssigneeDto,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

export interface MessageWindow {
  messages: MessageDto[];
  has_more_before: boolean;
}

export function messageRowToDto(
  row: MessageRow,
  opts?: { assigneeName?: string | null },
): MessageDto {
  let assignee: TaskAssigneeDto | null = null;
  if (row.task_assignee_agent_id) {
    assignee = {
      type: 'agent',
      id: row.task_assignee_agent_id,
      name: opts?.assigneeName ?? row.task_assignee_agent_id,
    };
  } else if (row.task_assignee_user_id) {
    assignee = {
      type: 'user',
      id: row.task_assignee_user_id,
      name: opts?.assigneeName ?? row.task_assignee_user_id,
    };
  }
  return {
    id: row.id,
    session_id: row.session_id,
    from_kind: row.from_kind,
    from_agent_id: row.from_agent_id,
    from_user_id: row.from_user_id,
    content: row.content,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    seq: row.seq,
    created_at: row.created_at,
    task_number: row.task_number,
    task_status: row.task_status,
    task_title: row.task_title,
    task_channel_id: row.task_channel_id,
    task_assignee: assignee,
  };
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  listForSession(sessionId: string, limit = 200): MessageDto[] {
    return this.listWindowForSession(sessionId, { limit }).messages;
  }

  listWindowForSession(
    sessionId: string,
    opts: { limit?: number; beforeSeq?: number | null } = {},
  ): MessageWindow {
    const limit = opts.limit ?? 200;
    const beforeSeq = opts.beforeSeq ?? null;
    const rows = this.db
      .prepare<[string, number | null, number | null, number], MessageRow>(
        `SELECT *
           FROM (
             SELECT *
               FROM messages
              WHERE session_id = ?
                AND (? IS NULL OR seq < ?)
              ORDER BY seq DESC
              LIMIT ?
           )
          ORDER BY seq ASC`,
      )
      .all(sessionId, beforeSeq, beforeSeq, limit);

    const minSeq = rows[0]?.seq ?? null;
    const hasMoreBefore =
      minSeq === null
        ? false
        : this.db
            .prepare<[string, number], { found: 1 }>(
              `SELECT 1 AS found
                 FROM messages
                WHERE session_id = ?
                  AND seq < ?
                LIMIT 1`,
            )
            .get(sessionId, minSeq) !== undefined;

    return {
      messages: rows.map(r => messageRowToDto(r)),
      has_more_before: hasMoreBefore,
    };
  }

  getById(id: string): MessageDto | null {
    const row = this.db
      .prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?')
      .get(id);
    return row ? messageRowToDto(row) : null;
  }

  insert(params: {
    sessionId: string;
    fromKind: FromKind;
    fromAgentId?: string | null;
    fromUserId?: string | null;
    content: string;
    metadata?: Record<string, unknown> | null;
  }): MessageDto {
    const id = newId();
    const now = Date.now();
    const seqRow = this.db
      .prepare<[string], { next_seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE session_id = ?`,
      )
      .get(params.sessionId);
    const seq = seqRow?.next_seq ?? 1;
    this.db
      .prepare(
        `INSERT INTO messages
         (id, session_id, from_kind, from_agent_id, from_user_id,
          content, metadata, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.sessionId,
        params.fromKind,
        params.fromAgentId ?? null,
        params.fromUserId ?? null,
        params.content,
        params.metadata ? JSON.stringify(params.metadata) : null,
        seq,
        now,
      );
    const row = this.db
      .prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?')
      .get(id);
    if (!row) throw new Error('message insert failed');
    return messageRowToDto(row);
  }
}

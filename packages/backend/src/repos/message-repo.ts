import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { FromKind, MessageDto, MessageRow } from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function rowToDto(row: MessageRow): MessageDto {
  return {
    ...row,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  };
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  listForSession(sessionId: string, limit = 200): MessageDto[] {
    const rows = this.db
      .prepare<[string, number], MessageRow>(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, limit);
    return rows.map(rowToDto);
  }

  getById(id: string): MessageDto | null {
    const row = this.db
      .prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
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
    return rowToDto(row);
  }
}

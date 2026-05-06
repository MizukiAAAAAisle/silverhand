import type { Database as Db } from 'better-sqlite3';
import type { ConversationReadRow } from '@silverhand/shared';

export interface MessageUnreadByConversation {
  by_conversation: Record<string, number>;
  total: number;
}

export class ConversationReadRepo {
  constructor(private readonly db: Db) {}

  markRead(params: {
    viewerUserId: string;
    conversationId: string;
    seq?: number | null;
  }): ConversationReadRow {
    const targetSeq = params.seq ?? this.latestSeq(params.conversationId);
    const now = Date.now();
    this.db
      .prepare<[string, string, number, number]>(
        `INSERT INTO conversation_reads
         (user_id, conversation_id, last_read_seq, read_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, conversation_id) DO UPDATE SET
           last_read_seq = max(conversation_reads.last_read_seq, excluded.last_read_seq),
           read_at = excluded.read_at`,
      )
      .run(params.viewerUserId, params.conversationId, targetSeq, now);

    const row = this.db
      .prepare<[string, string], ConversationReadRow>(
        `SELECT * FROM conversation_reads
         WHERE user_id = ? AND conversation_id = ?`,
      )
      .get(params.viewerUserId, params.conversationId);
    if (!row) throw new Error('conversation read upsert failed');
    return row;
  }

  unreadCountsByConversationForWorkspace(
    workspaceId: string,
    viewerUserId: string,
  ): MessageUnreadByConversation {
    const rows = this.db
      .prepare<[string, string, string], { conversation_id: string; c: number }>(
        `SELECT c.id AS conversation_id, COUNT(m.id) AS c
           FROM conversations c
           JOIN messages m
             ON m.conversation_id = c.id
            AND m.seq > COALESCE(
              (
                SELECT cr.last_read_seq
                  FROM conversation_reads cr
                 WHERE cr.user_id = ?
                   AND cr.conversation_id = c.id
              ),
              0
            )
            AND m.from_kind != 'system'
            AND NOT (
              m.from_kind = 'user'
              AND (m.from_user_id = ? OR m.from_user_id IS NULL)
            )
          WHERE c.workspace_id = ?
          GROUP BY c.id`,
      )
      .all(viewerUserId, viewerUserId, workspaceId);

    const byConversation: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byConversation[row.conversation_id] = row.c;
      total += row.c;
    }
    return { by_conversation: byConversation, total };
  }

  unreadCountForConversation(conversationId: string, viewerUserId: string): number {
    const row = this.db
      .prepare<[string, string, string], { c: number }>(
        `SELECT COUNT(m.id) AS c
           FROM messages m
          WHERE m.conversation_id = ?
            AND m.seq > COALESCE(
              (
                SELECT cr.last_read_seq
                  FROM conversation_reads cr
                 WHERE cr.user_id = ?
                   AND cr.conversation_id = m.conversation_id
              ),
              0
            )
            AND m.from_kind != 'system'
            AND NOT (
              m.from_kind = 'user'
              AND (m.from_user_id = ? OR m.from_user_id IS NULL)
            )`,
      )
      .get(conversationId, viewerUserId, viewerUserId);
    return row?.c ?? 0;
  }

  unreadCountsByWorkspace(viewerUserId: string): Record<string, number> {
    const rows = this.db
      .prepare<[string, string], { workspace_id: string; c: number }>(
        `SELECT c.workspace_id AS workspace_id, COUNT(m.id) AS c
           FROM conversations c
           JOIN messages m
             ON m.conversation_id = c.id
            AND m.seq > COALESCE(
              (
                SELECT cr.last_read_seq
                  FROM conversation_reads cr
                 WHERE cr.user_id = ?
                   AND cr.conversation_id = c.id
              ),
              0
            )
            AND m.from_kind != 'system'
            AND NOT (
              m.from_kind = 'user'
              AND (m.from_user_id = ? OR m.from_user_id IS NULL)
            )
          GROUP BY c.workspace_id`,
      )
      .all(viewerUserId, viewerUserId);

    const byWorkspace: Record<string, number> = {};
    for (const row of rows) byWorkspace[row.workspace_id] = row.c;
    return byWorkspace;
  }

  unreadCountsByWorkspaceSidebar(viewerUserId: string): Record<string, number> {
    const rows = this.db
      .prepare<[string, string], { scope_id: string; c: number }>(
        `SELECT
            c.workspace_id AS scope_id,
            COUNT(m.id) AS c
           FROM conversations c
           JOIN messages m
             ON m.conversation_id = c.id
            AND m.seq > COALESCE(
              (
                SELECT cr.last_read_seq
                  FROM conversation_reads cr
                 WHERE cr.user_id = ?
                   AND cr.conversation_id = c.id
              ),
              0
            )
            AND m.from_kind != 'system'
            AND NOT (
              m.from_kind = 'user'
              AND (m.from_user_id = ? OR m.from_user_id IS NULL)
            )
          GROUP BY c.workspace_id`,
      )
      .all(viewerUserId, viewerUserId);

    const byScope: Record<string, number> = {};
    for (const row of rows) byScope[row.scope_id] = row.c;
    return byScope;
  }

  private latestSeq(conversationId: string): number {
    const row = this.db
      .prepare<[string], { seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq
         FROM messages
         WHERE conversation_id = ?`,
      )
      .get(conversationId);
    return row?.seq ?? 0;
  }
}

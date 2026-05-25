import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { NotificationDto, NotificationKind, NotificationRow } from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function rowToDto(row: NotificationRow): NotificationDto {
  return {
    ...row,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
  };
}

export interface InsertNotificationParams {
  kind: NotificationKind;
  /** v1 single-user app passes NULL. Migration to multi-user backfills 'local'. */
  userId?: string | null;
  agentId?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  sourceWorkspaceId?: string | null;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  payload?: Record<string, unknown> | null;
}

export class NotificationRepo {
  constructor(private readonly db: Db) {}

  insert(params: InsertNotificationParams): NotificationDto {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO notifications
         (id, kind, user_id, agent_id, workspace_id, conversation_id, message_id,
          source_workspace_id, source_conversation_id, source_message_id,
          payload, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        params.kind,
        params.userId ?? null,
        params.agentId ?? null,
        params.workspaceId ?? null,
        params.conversationId ?? null,
        params.messageId ?? null,
        params.sourceWorkspaceId ?? null,
        params.sourceConversationId ?? null,
        params.sourceMessageId ?? null,
        params.payload ? JSON.stringify(params.payload) : null,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): NotificationDto | null {
    const row = this.db
      .prepare<[string], NotificationRow>(
        `SELECT * FROM notifications WHERE id = ?`,
      )
      .get(id);
    return row ? rowToDto(row) : null;
  }

  /**
   * List notifications for `userId` (NULL for v1 single-user). When
   * `unread` is true, only rows with `read_at IS NULL` come back.
   * Always sorted newest-first; cap with `limit` (default 100).
   */
  list(opts: { userId?: string | null; unread?: boolean; limit?: number } = {}): NotificationDto[] {
    const limit = opts.limit ?? 100;
    const whereParts: string[] = [];
    const args: (string | number | null)[] = [];
    // user_id IS NULL vs user_id = ? — explicit branch since SQL `=`
    // never matches NULL.
    if (opts.userId === undefined || opts.userId === null) {
      whereParts.push('user_id IS NULL');
    } else {
      whereParts.push('user_id = ?');
      args.push(opts.userId);
    }
    if (opts.unread) whereParts.push('read_at IS NULL');
    args.push(limit);
    const rows = this.db
      .prepare<typeof args, NotificationRow>(
        `SELECT * FROM notifications
         WHERE ${whereParts.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args);
    return rows.map(rowToDto);
  }

  /** Aggregate unread counts by natural workspace/sidebar scope. */
  unreadCountsByWorkspace(userId?: string | null): Map<string, number> {
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [] : [userId];
    const rows = this.db
      .prepare<typeof args, { scope_id: string; c: number }>(
        `SELECT
           COALESCE(n.workspace_id, c.workspace_id) AS scope_id,
           COUNT(*) AS c
         FROM notifications n
         LEFT JOIN conversations c ON c.id = n.conversation_id
         WHERE ${userPredicate}
           AND n.read_at IS NULL
           AND scope_id IS NOT NULL
         GROUP BY scope_id`,
      )
      .all(...args);
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.scope_id, r.c);
    return out;
  }

  /**
   * Per-sidebar-scope pointer to the most recent unread notification.
   * Skips rows missing conversation/message ids.
   */
  latestUnreadByWorkspace(
    userId?: string | null,
  ): Map<string, { conversation_id: string; message_id: string }> {
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [] : [userId];
    const rows = this.db
      .prepare<
        typeof args,
        { scope_id: string; conversation_id: string; message_id: string }
      >(
        `SELECT
           COALESCE(n.workspace_id, c.workspace_id) AS scope_id,
           n.conversation_id,
           n.message_id
         FROM notifications n
         JOIN conversations c ON c.id = n.conversation_id
         JOIN (
           SELECT
             COALESCE(n2.workspace_id, c2.workspace_id) AS scope_id,
             MAX(n2.created_at) AS mx
           FROM notifications n2
           JOIN conversations c2 ON c2.id = n2.conversation_id
           WHERE ${userPredicate}
             AND n2.read_at IS NULL
             AND n2.conversation_id IS NOT NULL
             AND n2.message_id IS NOT NULL
           GROUP BY scope_id
         ) latest
           ON latest.scope_id = COALESCE(n.workspace_id, c.workspace_id)
          AND latest.mx = n.created_at
         WHERE ${userPredicate}
           AND n.read_at IS NULL`,
      )
      .all(...args, ...args);
    const out = new Map<string, { conversation_id: string; message_id: string }>();
    for (const r of rows) {
      out.set(r.scope_id, {
        conversation_id: r.conversation_id,
        message_id: r.message_id,
      });
    }
    return out;
  }

  /** Mark all unread notifications for a conversation as read. */
  markConversationRead(conversationId: string, userId?: string | null): number {
    const now = Date.now();
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args =
      userId == null ? [now, conversationId] : [now, userId, conversationId];
    const r = this.db
      .prepare(
        `UPDATE notifications
         SET read_at = ?
         WHERE ${userPredicate} AND conversation_id = ? AND read_at IS NULL`,
      )
      .run(...args);
    return r.changes;
  }

  unreadCount(userId?: string | null): number {
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [] : [userId];
    const row = this.db
      .prepare<typeof args, { c: number }>(
        `SELECT COUNT(*) AS c FROM notifications
         WHERE ${userPredicate} AND read_at IS NULL`,
      )
      .get(...args);
    return row?.c ?? 0;
  }

  markRead(id: string, userId?: string | null): boolean {
    const now = Date.now();
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [now, id] : [now, userId, id];
    const r = this.db
      .prepare(
        `UPDATE notifications
            SET read_at = ?
          WHERE ${userPredicate}
            AND id = ?
            AND read_at IS NULL`,
      )
      .run(...args);
    return r.changes > 0;
  }

  markWorkspaceRead(workspaceId: string, userId?: string | null): number {
    const now = Date.now();
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args =
      userId == null ? [now, workspaceId] : [now, userId, workspaceId];
    const r = this.db
      .prepare(
        `UPDATE notifications
         SET read_at = ?
         WHERE ${userPredicate} AND workspace_id = ? AND read_at IS NULL`,
      )
      .run(...args);
    return r.changes;
  }

  markAllRead(userId?: string | null): number {
    const now = Date.now();
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [now] : [now, userId];
    const r = this.db
      .prepare(
        `UPDATE notifications SET read_at = ?
         WHERE ${userPredicate} AND read_at IS NULL`,
      )
      .run(...args);
    return r.changes;
  }
}

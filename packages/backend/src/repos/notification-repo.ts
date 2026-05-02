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
  channelId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  sourceChannelId?: string | null;
  sourceSessionId?: string | null;
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
         (id, kind, user_id, agent_id, channel_id, session_id, message_id,
          source_channel_id, source_session_id, source_message_id,
          payload, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        params.kind,
        params.userId ?? null,
        params.agentId ?? null,
        params.channelId ?? null,
        params.sessionId ?? null,
        params.messageId ?? null,
        params.sourceChannelId ?? null,
        params.sourceSessionId ?? null,
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

  /**
   * Aggregate unread counts grouped by `channel_id` so the sidebar
   * can render per-DM badges in a single round-trip. NULL channel_id
   * (none currently emitted, but possible) is dropped.
   */
  unreadCountsByChannel(userId?: string | null): Map<string, number> {
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [] : [userId];
    const rows = this.db
      .prepare<typeof args, { channel_id: string; c: number }>(
        `SELECT channel_id, COUNT(*) AS c
         FROM notifications
         WHERE ${userPredicate}
           AND read_at IS NULL
           AND channel_id IS NOT NULL
         GROUP BY channel_id`,
      )
      .all(...args);
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.channel_id, r.c);
    return out;
  }

  /**
   * Per-channel pointer to the most recent unread notification, so
   * the renderer can jump straight to it when the user clicks a DM
   * with the unread badge. Skips rows missing session/message ids.
   */
  latestUnreadByChannel(
    userId?: string | null,
  ): Map<string, { session_id: string; message_id: string }> {
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [] : [userId];
    const rows = this.db
      .prepare<
        typeof args,
        { channel_id: string; session_id: string; message_id: string }
      >(
        `SELECT n.channel_id, n.session_id, n.message_id
         FROM notifications n
         JOIN (
           SELECT channel_id, MAX(created_at) AS mx
           FROM notifications
           WHERE ${userPredicate}
             AND read_at IS NULL
             AND channel_id IS NOT NULL
             AND session_id IS NOT NULL
             AND message_id IS NOT NULL
           GROUP BY channel_id
         ) latest
           ON latest.channel_id = n.channel_id
          AND latest.mx = n.created_at
         WHERE ${userPredicate}
           AND n.read_at IS NULL`,
      )
      .all(...args, ...args);
    const out = new Map<string, { session_id: string; message_id: string }>();
    for (const r of rows) {
      out.set(r.channel_id, { session_id: r.session_id, message_id: r.message_id });
    }
    return out;
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

  markRead(id: string): boolean {
    const now = Date.now();
    const r = this.db
      .prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`)
      .run(now, id);
    return r.changes > 0;
  }

  markChannelRead(channelId: string, userId?: string | null): number {
    const now = Date.now();
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args =
      userId == null ? [now, channelId] : [now, userId, channelId];
    const r = this.db
      .prepare(
        `UPDATE notifications
         SET read_at = ?
         WHERE ${userPredicate} AND channel_id = ? AND read_at IS NULL`,
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

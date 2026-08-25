import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { NotificationDto, NotificationKind, NotificationRow } from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';
import { LIVE_CONVERSATION_PREDICATE } from './conversation-liveness.js';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

type NotificationJoinedRow = NotificationRow & {
  thread_root_id?: string | null;
};

function rowToDto(row: NotificationJoinedRow): NotificationDto {
  return {
    ...row,
    thread_root_id: row.thread_root_id ?? null,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
  };
}

export interface InsertNotificationParams {
  kind: NotificationKind;
  /** Target registered viewer. NULL is legacy/unclaimed and is ignored by routes. */
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
    prepareObserved(
        this.db,
        'notifications.insert_row',
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
    const row = prepareObserved<[string], NotificationJoinedRow>(
        this.db,
        'notifications.get_by_id',
        `SELECT
            n.*,
            m.thread_root_id AS thread_root_id
           FROM notifications n
           LEFT JOIN messages m ON m.id = n.message_id
           LEFT JOIN conversations conv ON conv.id = n.conversation_id
          WHERE n.id = ?`,
      )
      .get(id);
    return row ? rowToDto(row) : null;
  }

  /** List notifications for `userId`. Passing NULL/undefined is retained only
   * for legacy repo tests and returns unclaimed legacy rows. */
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
    const rows = prepareObserved<typeof args, NotificationJoinedRow>(
        this.db,
        'notifications.list_for_user',
        `SELECT
            n.*,
            m.thread_root_id AS thread_root_id
           FROM notifications n
           LEFT JOIN messages m ON m.id = n.message_id
           LEFT JOIN conversations conv ON conv.id = n.conversation_id
         WHERE ${whereParts.join(' AND ')}
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT ?`,
      )
      .all(...args);
    return rows.map(rowToDto);
  }

  /**
   * Aggregate unread counts by natural workspace/sidebar scope.
   *
   * Deliberately NOT gated on conversation liveness (#task:1839 review): what
   * this count means — "every unread notification" vs "live attention with a
   * navigable anchor" — is unadjudicated public API behavior with no consumer
   * today, and it cannot be made to agree with
   * {@link latestUnreadByWorkspace} by a liveness filter anyway (an anchorless
   * `agent_start_failed` in a live conversation counts here and can never be
   * pointed at). Deciding it belongs with the notifications panel, together
   * with the anchorless / list / mark-all semantics.
   */
  unreadCountsByWorkspace(userId?: string | null): Map<string, number> {
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [] : [userId];
    const rows = prepareObserved<typeof args, { scope_id: string; c: number }>(
        this.db,
        'notifications.unread_counts_by_workspace',
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
   * Per-sidebar-scope pointer to the most recent unread notification — the
   * renderer's jump target when a workspace is selected.
   *
   * Two invariants, both #task:1839:
   *  - Liveness ({@link LIVE_CONVERSATION_PREDICATE}): never point at a
   *    conversation whose lifecycle has ended. Archiving a channel does not
   *    delete its notifications, so without this an archived channel keeps
   *    hijacking plain workspace clicks. Orphans (conversation deleted →
   *    `conversation_id` NULL) fail closed: an unknowable destination is not a
   *    destination. This gate is scoped to the POINTER — the counts above keep
   *    their existing meaning.
   *  - Determinism: `created_at` is not unique, so the winner is picked by
   *    `(created_at, id)` in ONE pass with ROW_NUMBER. The previous shape
   *    joined the aggregate MAX back onto the table, which returned every row
   *    sharing that millisecond — letting an anchorless notification win and
   *    hand back a `message_id` typed non-null but actually NULL.
   *
   * Rows missing conversation/message ids stay excluded: this pointer's whole
   * contract is a navigable anchor.
   */
  latestUnreadByWorkspace(
    userId?: string | null,
  ): Map<
    string,
    {
      conversation_id: string;
      message_id: string;
      thread_root_id: string | null;
    }
  > {
    const userPredicate =
      userId === undefined || userId === null ? 'n.user_id IS NULL' : 'n.user_id = ?';
    const args = userId == null ? [] : [userId];
    const rows = prepareObserved<
        typeof args,
        {
          scope_id: string;
          conversation_id: string;
          message_id: string;
          thread_root_id: string | null;
        }
      >(
        this.db,
        'notifications.latest_unread_by_workspace',
        `SELECT scope_id, conversation_id, message_id, thread_root_id
         FROM (
           SELECT
             COALESCE(n.workspace_id, c.workspace_id) AS scope_id,
             n.conversation_id AS conversation_id,
             n.message_id AS message_id,
             m.thread_root_id AS thread_root_id,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(n.workspace_id, c.workspace_id)
               ORDER BY n.created_at DESC, n.id DESC
             ) AS rn
           FROM notifications n
           JOIN conversations c ON c.id = n.conversation_id
           LEFT JOIN messages m ON m.id = n.message_id
           WHERE ${userPredicate}
             AND n.read_at IS NULL
             AND n.conversation_id IS NOT NULL
             AND n.message_id IS NOT NULL
             AND ${LIVE_CONVERSATION_PREDICATE}
         )
         WHERE rn = 1`,
      )
      .all(...args);
    const out = new Map<
      string,
      {
        conversation_id: string;
        message_id: string;
        thread_root_id: string | null;
      }
    >();
    for (const r of rows) {
      out.set(r.scope_id, {
        conversation_id: r.conversation_id,
        message_id: r.message_id,
        thread_root_id: r.thread_root_id ?? null,
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
    const r = prepareObserved(
        this.db,
        'notifications.mark_conversation_read',
        `UPDATE notifications
         SET read_at = ?
         WHERE ${userPredicate} AND conversation_id = ? AND read_at IS NULL`,
      )
      .run(...args);
    return r.changes;
  }

  /**
   * Overlap double-clear (#task:1231 §3): when a positional `observe(stream)`
   * advances a stream's cursor to `uptoSeq`, mark the viewer's unread
   * `mention_self` notifications in THAT SAME stream (conversation + thread)
   * read, up to and including `uptoSeq` — in the same transaction as the cursor
   * advance. Without this, the cursor-derived Activity dedup would drop the
   * mention but the non-derived `/n/unread` badge (which reads `read_at IS NULL`
   * directly) would linger as a second source of truth.
   *
   * Anchored by the notification's message seq (a `mention_self` always carries
   * a `message_id`), so anchorless kinds (`agent_start_failed`) are NEVER
   * touched — they clear only via their own by-id notification observe or the
   * conversation-level notification surface. The stream is matched by the anchor
   * message's `thread_root_id` (NULL = mainline), keeping the clear precise to
   * `(conversation, stream, seq <= uptoSeq)` — not a conversation-level bulk.
   *
   * Returns the ids of the notifications it flipped unread→read (via `RETURNING`,
   * surfaced by better-sqlite3 `.all()`). Callers need the ids — not just a
   * count — to fan the "notification read" fact out to consumers that act on the
   * specific rows, e.g. dismissing the matching OS notification (#task:1431).
   */
  markStreamMentionsRead(params: {
    userId: string;
    conversationId: string;
    threadRootId: string | null;
    uptoSeq: number;
  }): string[] {
    const now = Date.now();
    const rows = prepareObserved<
        {
          now: number;
          viewer: string;
          conv: string;
          root: string | null;
          upto: number;
        },
        { id: string }
      >(
        this.db,
        'notifications.mark_stream_mentions_read',
        `UPDATE notifications
            SET read_at = @now
          WHERE user_id = @viewer
            AND kind = 'mention_self'
            AND read_at IS NULL
            AND conversation_id = @conv
            AND message_id IN (
              SELECT m.id FROM messages m
               WHERE m.conversation_id = @conv
                 AND m.thread_root_id IS @root
                 AND m.seq <= @upto
            )
          RETURNING id`,
      )
      .all({
        now,
        viewer: params.userId,
        conv: params.conversationId,
        root: params.threadRootId,
        upto: params.uptoSeq,
      });
    return rows.map(r => r.id);
  }

  /** Total unread for the viewer. Same open question as
   *  {@link unreadCountsByWorkspace}: not gated on conversation liveness. */
  unreadCount(userId?: string | null): number {
    const userPredicate =
      userId === undefined || userId === null ? 'user_id IS NULL' : 'user_id = ?';
    const args = userId == null ? [] : [userId];
    const row = prepareObserved<typeof args, { c: number }>(
        this.db,
        'notifications.unread_count',
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
    const r = prepareObserved(
        this.db,
        'notifications.mark_read',
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
    const r = prepareObserved(
        this.db,
        'notifications.mark_workspace_read',
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
    const r = prepareObserved(
        this.db,
        'notifications.mark_all_read',
        `UPDATE notifications SET read_at = ?
         WHERE ${userPredicate} AND read_at IS NULL`,
      )
      .run(...args);
    return r.changes;
  }
}

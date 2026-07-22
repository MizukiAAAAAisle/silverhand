import type { Database as Db } from 'better-sqlite3';
import { decodeMessageSeq } from '@silverhand/shared';
import type {
  ConversationReadRow,
  ConversationStreamUnreadDto,
  MessageSeq,
  StreamUnreadDto,
} from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';

export interface MessageUnreadByConversation {
  by_conversation: Record<string, number>;
  latest_by_conversation: Record<string, MessageUnreadPointer>;
  total: number;
}

export interface MessageUnreadPointer {
  conversation_id: string;
  message_id: string;
  seq: MessageSeq;
  thread_root_id: string | null;
}

/** Raw SQLite shape for an unread pointer, before the DB-read decode boundary
 *  brands `seq` into a {@link MessageSeq} (docs/brand-typed-seq-v1.md §4.1).
 *  better-sqlite3 returns plain numbers, so the `prepareObserved<>` RowType must
 *  stay unbranded — branding it there would be a hidden trust-cast, not a decode. */
type MessageUnreadPointerRow = Omit<MessageUnreadPointer, 'seq'> & { seq: number };

export interface StreamFirstUnread {
  message_id: string;
  seq: number;
}

/**
 * Per-stream read cursor (#task:1226). `conversation_reads` carries one cursor
 * per STREAM — mainline (thread_root_id IS NULL) and each reply-cluster
 * (thread_root_id = root id) — mirroring the per-stream `conversation_stream_heads`
 * freshness model. Two partial-unique indexes enforce uniqueness, so a given
 * (user, conversation) has MANY rows, not one.
 *
 * IMPLEMENTATION INVARIANT (#task:1226 §4.1): every cursor read/write MUST be
 * stream-qualified (`thread_root_id IS NULL` or `= ?`). The ONLY exception is
 * the roll-up unread predicate below, which deliberately spans the mainline +
 * followed threads and qualifies each message against ITS OWN stream cursor.
 */
export class ConversationReadRepo {
  constructor(private readonly db: Db) {}

  /**
   * Advance a single stream's read cursor to an already-resolved seq. The route
   * resolves the open-time snapshot / fallback / validation (it owns the stream
   * head + friendly 400s); this method only persists, monotonically — `max()`
   * never moves a cursor backward. `threadRootId` NULL = mainline.
   *
   * The two partial-unique indexes need two distinct ON CONFLICT targets
   * (a NULL `thread_root_id` can't share a conflict target with a non-NULL one).
   */
  markRead(params: {
    viewerUserId: string;
    conversationId: string;
    threadRootId: string | null;
    seq: number;
  }): ConversationReadRow {
    const { viewerUserId, conversationId, threadRootId, seq } = params;
    const now = Date.now();
    if (threadRootId === null) {
      prepareObserved(
          this.db,
          'reads.mark_read_mainline',
          `INSERT INTO conversation_reads
             (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
           VALUES (@viewer, @conv, NULL, @seq, @now)
           ON CONFLICT (user_id, conversation_id) WHERE thread_root_id IS NULL
           DO UPDATE SET
             last_read_seq = max(conversation_reads.last_read_seq, excluded.last_read_seq),
             read_at = excluded.read_at`,
        )
        .run({ viewer: viewerUserId, conv: conversationId, seq, now });
    } else {
      prepareObserved(
          this.db,
          'reads.mark_read_thread',
          `INSERT INTO conversation_reads
             (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
           VALUES (@viewer, @conv, @root, @seq, @now)
           ON CONFLICT (user_id, conversation_id, thread_root_id)
             WHERE thread_root_id IS NOT NULL
           DO UPDATE SET
             last_read_seq = max(conversation_reads.last_read_seq, excluded.last_read_seq),
             read_at = excluded.read_at`,
        )
        .run({ viewer: viewerUserId, conv: conversationId, root: threadRootId, seq, now });
    }

    const row = this.getCursorRow(viewerUserId, conversationId, threadRootId);
    if (!row) throw new Error('conversation read upsert failed');
    return row;
  }

  private getCursorRow(
    viewerUserId: string,
    conversationId: string,
    threadRootId: string | null,
  ): ConversationReadRow | undefined {
    return prepareObserved<[string, string, string | null], ConversationReadRow>(
        this.db,
        'reads.get_cursor_row',
        `SELECT * FROM conversation_reads
          WHERE user_id = ? AND conversation_id = ? AND thread_root_id IS ?`,
      )
      .get(viewerUserId, conversationId, threadRootId);
  }

  /** Current cursor seq for ONE stream (0 if no cursor row yet). The observe()
   *  use case (#task:1231) reads this to decide whether a `markRead` would
   *  actually advance the cursor (it is monotonic `max()`, so re-marking an
   *  already-read stream is a no-op) — driving the single coalesced
   *  `unread_updated` event without a heavier unread recount. */
  getLastReadSeq(
    viewerUserId: string,
    conversationId: string,
    threadRootId: string | null,
  ): number {
    return this.getCursorRow(viewerUserId, conversationId, threadRootId)
      ?.last_read_seq ?? 0;
  }

  /** Unread count for ONE stream (mainline or a single thread). `@root` NULL =
   *  mainline; the `IS @root` comparison handles both NULL and a value. */
  unreadCountForStream(
    conversationId: string,
    threadRootId: string | null,
    viewerUserId: string,
  ): number {
    const row = prepareObserved<{ conv: string; root: string | null; viewer: string }, { c: number }>(
        this.db,
        'reads.unread_count_for_stream',
        `SELECT COUNT(m.id) AS c
           FROM messages m
          WHERE m.conversation_id = @conv
            AND m.thread_root_id IS @root
            AND m.seq > COALESCE(
              (SELECT cr.last_read_seq FROM conversation_reads cr
                WHERE cr.user_id = @viewer AND cr.conversation_id = @conv
                  AND cr.thread_root_id IS @root),
              0
            )
            AND m.from_kind != 'system'
            AND NOT (m.from_kind = 'user' AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))`,
      )
      .get({ conv: conversationId, root: threadRootId, viewer: viewerUserId });
    return row?.c ?? 0;
  }

  /** First (lowest-seq) unread message in ONE stream — for "jump to first
   *  unread". Returns both message id and seq (the contract Norman's reply-chip
   *  / thread-open jump consumes). */
  firstUnreadForStream(
    conversationId: string,
    threadRootId: string | null,
    viewerUserId: string,
  ): StreamFirstUnread | null {
    const row = prepareObserved<
        { conv: string; root: string | null; viewer: string },
        { message_id: string; seq: number }
      >(
        this.db,
        'reads.first_unread_for_stream',
        `SELECT m.id AS message_id, m.seq AS seq
           FROM messages m
          WHERE m.conversation_id = @conv
            AND m.thread_root_id IS @root
            AND m.seq > COALESCE(
              (SELECT cr.last_read_seq FROM conversation_reads cr
                WHERE cr.user_id = @viewer AND cr.conversation_id = @conv
                  AND cr.thread_root_id IS @root),
              0
            )
            AND m.from_kind != 'system'
            AND NOT (m.from_kind = 'user' AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))
          ORDER BY m.seq ASC
          LIMIT 1`,
      )
      .get({ conv: conversationId, root: threadRootId, viewer: viewerUserId });
    return row ?? null;
  }

  /** Per-conversation per-viewer stream-unread (#task:1226) — the SINGLE
   *  read-model source for the reply chip + Threads list "N new" / first-unread,
   *  so the same server-scored fact never lives in two client caches that drift.
   *  ONE query computes, per stream (mainline = thread_root_id NULL, each thread
   *  = its root id), the unread count + the first (lowest-seq) unread message,
   *  each scored against THAT stream's own cursor — identical WHERE to
   *  `unreadCountForStream` / `firstUnreadForStream`, just batched across every
   *  stream via window functions (PARTITION BY thread_root_id; SQLite groups the
   *  NULL = mainline partition on its own). Follow-AGNOSTIC: a thread's unread is
   *  independent of whether the viewer follows it (follow only gates the sidebar
   *  roll-up / Activity, never per-thread display). `threads` is sparse — a root
   *  appears only if it has >= 1 unread message; an absent root means 0. */
  streamUnreadForConversation(
    conversationId: string,
    viewerUserId: string,
  ): ConversationStreamUnreadDto {
    const rows = prepareObserved<
        { conv: string; viewer: string },
        {
          root: string | null;
          first_unread_message_id: string;
          first_unread_seq: number;
          unread_count: number;
        }
      >(
        this.db,
        'reads.stream_unread_for_conversation',
        `WITH unread AS (
           SELECT m.id   AS message_id,
                  m.seq  AS seq,
                  m.thread_root_id AS root,
                  ROW_NUMBER() OVER (
                    PARTITION BY m.thread_root_id ORDER BY m.seq ASC
                  ) AS rn,
                  COUNT(*) OVER (PARTITION BY m.thread_root_id) AS cnt
             FROM messages m
            WHERE m.conversation_id = @conv
              AND m.from_kind != 'system'
              AND NOT (m.from_kind = 'user'
                       AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))
              AND m.seq > COALESCE(
                (SELECT cr.last_read_seq FROM conversation_reads cr
                  WHERE cr.user_id = @viewer
                    AND cr.conversation_id = @conv
                    AND cr.thread_root_id IS m.thread_root_id),
                0
              )
         )
         SELECT root,
                message_id AS first_unread_message_id,
                seq        AS first_unread_seq,
                cnt        AS unread_count
           FROM unread
          WHERE rn = 1`,
      )
      .all({ conv: conversationId, viewer: viewerUserId });

    let mainline: StreamUnreadDto = {
      unread_count: 0,
      first_unread_message_id: null,
      first_unread_seq: null,
    };
    const threads: Record<string, StreamUnreadDto> = {};
    for (const row of rows) {
      const entry: StreamUnreadDto = {
        unread_count: row.unread_count,
        first_unread_message_id: row.first_unread_message_id,
        first_unread_seq:
          row.first_unread_seq === null
            ? null
            : decodeMessageSeq(row.first_unread_seq),
      };
      if (row.root === null) {
        mainline = entry;
      } else {
        threads[row.root] = entry;
      }
    }
    return { mainline, threads };
  }

  unreadCountsByConversationForWorkspace(
    workspaceId: string,
    viewerUserId: string,
  ): MessageUnreadByConversation {
    const rows = prepareObserved<
        { viewer: string; workspace: string },
        { conversation_id: string; c: number }
      >(
        this.db,
        'reads.unread_counts_by_conversation_for_workspace',
        `SELECT c.id AS conversation_id, COUNT(m.id) AS c
           FROM conversations c
           JOIN conversation_users cu
             ON cu.conversation_id = c.id AND cu.user_id = @viewer
           JOIN messages m
             ON m.conversation_id = c.id AND ${ROLLUP_UNREAD}
          WHERE c.workspace_id = @workspace
          GROUP BY c.id`,
      )
      .all({ viewer: viewerUserId, workspace: workspaceId });

    const byConversation: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byConversation[row.conversation_id] = row.c;
      total += row.c;
    }
    return {
      by_conversation: byConversation,
      latest_by_conversation: this.latestUnreadByConversationForWorkspace(
        workspaceId,
        viewerUserId,
      ),
      total,
    };
  }

  /** Channel-level unread = §3.5 roll-up: mainline unread + Σ(followed-thread
   *  unread). Non-followed threads' unread is deliberately excluded (de-noising)
   *  — it surfaces only as a weak dot in the Threads list, never in this count. */
  unreadCountForConversation(conversationId: string, viewerUserId: string): number {
    const row = prepareObserved<{ conv: string; viewer: string }, { c: number }>(
        this.db,
        'reads.unread_count_for_conversation',
        `SELECT COUNT(m.id) AS c
           FROM messages m
          WHERE m.conversation_id = @conv AND ${ROLLUP_UNREAD}`,
      )
      .get({ conv: conversationId, viewer: viewerUserId });
    return row?.c ?? 0;
  }

  /** Latest unread message pointer for a conversation, roll-up consistent with
   *  the count (mainline + followed threads), so `count > 0 ⟺ pointer != null`.
   *  Powers the close-watermark; `.seq` is a valid monotonic cursor regardless
   *  of which stream the latest unread lives in. */
  latestUnreadForConversation(
    conversationId: string,
    viewerUserId: string,
  ): MessageUnreadPointer | null {
    const row = prepareObserved<{ conv: string; viewer: string }, MessageUnreadPointerRow>(
        this.db,
        'reads.latest_unread_for_conversation',
        `SELECT m.conversation_id, m.id AS message_id, m.seq, m.thread_root_id
           FROM messages m
          WHERE m.conversation_id = @conv AND ${ROLLUP_UNREAD}
          ORDER BY m.seq DESC
          LIMIT 1`,
      )
      .get({ conv: conversationId, viewer: viewerUserId });
    return row ? { ...row, seq: decodeMessageSeq(row.seq) } : null;
  }

  latestUnreadByConversationForWorkspace(
    workspaceId: string,
    viewerUserId: string,
  ): Record<string, MessageUnreadPointer> {
    const rows = prepareObserved<{ viewer: string; workspace: string }, MessageUnreadPointerRow>(
        this.db,
        'reads.latest_unread_by_conversation_for_workspace',
        `WITH unread AS (
           SELECT c.id AS conversation_id,
                  m.id AS message_id,
                  m.seq,
                  m.thread_root_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY c.id ORDER BY m.seq DESC
                  ) AS rn
             FROM conversations c
             JOIN conversation_users cu
               ON cu.conversation_id = c.id AND cu.user_id = @viewer
             JOIN messages m
               ON m.conversation_id = c.id AND ${ROLLUP_UNREAD}
            WHERE c.workspace_id = @workspace
          )
          SELECT conversation_id, message_id, seq, thread_root_id
            FROM unread
           WHERE rn = 1`,
      )
      .all({ viewer: viewerUserId, workspace: workspaceId });

    const latest: Record<string, MessageUnreadPointer> = {};
    for (const row of rows) {
      latest[row.conversation_id] = { ...row, seq: decodeMessageSeq(row.seq) };
    }
    return latest;
  }

  /** Single-workspace unread rollup for one viewer (#task:1283 B4). The hot-path
   *  source for the `unread_updated` frame's `workspace_unread_count` — a per-row
   *  body identical to {@link unreadCountsByWorkspace} / {@link
   *  unreadCountsByWorkspaceSidebar} but scoped to ONE workspace (no all-ws
   *  GROUP-BY scan; arrival fans to K viewers, so an all-ws scan per viewer would
   *  let backend amplification cancel the client refetch win). An equivalence
   *  test locks `unreadCountForWorkspace == unreadCountsByWorkspace[ws] ==
   *  unreadCountsByWorkspaceSidebar[ws]` so the emitted value is provably the same
   *  authoritative rollup the summary route and favorites row serve. */
  unreadCountForWorkspace(workspaceId: string, viewerUserId: string): number {
    const row = prepareObserved<{ viewer: string; workspace: string }, { c: number }>(
        this.db,
        'reads.unread_count_for_workspace',
        `SELECT COUNT(m.id) AS c
           FROM conversations c
           JOIN conversation_users cu
             ON cu.conversation_id = c.id AND cu.user_id = @viewer
           JOIN messages m
             ON m.conversation_id = c.id AND ${ROLLUP_UNREAD}
          WHERE c.workspace_id = @workspace`,
      )
      .get({ viewer: viewerUserId, workspace: workspaceId });
    return row?.c ?? 0;
  }

  unreadCountsByWorkspace(viewerUserId: string): Record<string, number> {
    const rows = prepareObserved<{ viewer: string }, { workspace_id: string; c: number }>(
        this.db,
        'reads.unread_counts_by_workspace',
        `SELECT c.workspace_id AS workspace_id, COUNT(m.id) AS c
           FROM conversations c
           JOIN conversation_users cu
             ON cu.conversation_id = c.id AND cu.user_id = @viewer
           JOIN messages m
             ON m.conversation_id = c.id AND ${ROLLUP_UNREAD}
          GROUP BY c.workspace_id`,
      )
      .all({ viewer: viewerUserId });

    const byWorkspace: Record<string, number> = {};
    for (const row of rows) byWorkspace[row.workspace_id] = row.c;
    return byWorkspace;
  }

  unreadCountsByWorkspaceSidebar(viewerUserId: string): Record<string, number> {
    const rows = prepareObserved<{ viewer: string }, { scope_id: string; c: number }>(
        this.db,
        'reads.unread_counts_by_workspace_sidebar',
        `SELECT c.workspace_id AS scope_id, COUNT(m.id) AS c
           FROM conversations c
           JOIN conversation_users cu
             ON cu.conversation_id = c.id AND cu.user_id = @viewer
           JOIN messages m
             ON m.conversation_id = c.id AND ${ROLLUP_UNREAD}
          GROUP BY c.workspace_id`,
      )
      .all({ viewer: viewerUserId });

    const byScope: Record<string, number> = {};
    for (const row of rows) byScope[row.scope_id] = row.c;
    return byScope;
  }
}

/**
 * Roll-up unread predicate (#task:1226 §3.5). A message `m` is unread for
 * `@viewer` when it is neither a system message nor the viewer's own, AND its
 * conversation is not ARCHIVED, AND either:
 *   - it is a MAINLINE message past the viewer's mainline cursor, OR
 *   - it is a reply in a thread the viewer FOLLOWS (`thread_followers`,
 *     principal_kind='human'), past that thread's own cursor.
 *
 * Each branch qualifies the cursor lookup by its own stream — there is no single
 * per-conversation cursor any more. References `m.conversation_id` and `@viewer`,
 * so every caller must alias the messages table `m` and bind `@viewer`.
 *
 * ARCHIVED EXCLUSION (#task:1403): archiving a channel ends its lifecycle — it is
 * no longer visible, so its unread must not count toward ANY badge (sidebar /
 * workspace / global). Baked into the predicate itself (not each caller) so all
 * consumers — the workspace-scoped aggregates, the per-conversation counts, and
 * the favorites row — agree by construction that "unread" excludes archived
 * conversations; there is no second place to keep in sync. `setArchived` emits a
 * viewer-scoped `unread_updated` so already-cached badges drop in place without a
 * refetch (both archive AND unarchive — the predicate re-includes on restore).
 *
 * NOTE: `thread_followers` is the DELIVERY / agent-wake subscription contract
 * (#task:1226 invariant 4). It is only READ here to derive the followed/all
 * distinction; this module never writes it.
 */
const ROLLUP_UNREAD = `
  NOT EXISTS (
    SELECT 1 FROM conversations arch
     WHERE arch.id = m.conversation_id AND arch.archived_at IS NOT NULL
  )
  AND m.from_kind != 'system'
  AND NOT (m.from_kind = 'user' AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))
  AND (
    (
      m.thread_root_id IS NULL
      AND m.seq > COALESCE(
        (SELECT cr.last_read_seq FROM conversation_reads cr
          WHERE cr.user_id = @viewer AND cr.conversation_id = m.conversation_id
            AND cr.thread_root_id IS NULL),
        0
      )
    )
    OR
    (
      m.thread_root_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM thread_followers tf
         WHERE tf.thread_root_id = m.thread_root_id
           AND tf.principal_kind = 'human'
           AND tf.principal_id = @viewer
      )
      AND m.seq > COALESCE(
        (SELECT cr.last_read_seq FROM conversation_reads cr
          WHERE cr.user_id = @viewer AND cr.conversation_id = m.conversation_id
            AND cr.thread_root_id = m.thread_root_id),
        0
      )
    )
  )`;

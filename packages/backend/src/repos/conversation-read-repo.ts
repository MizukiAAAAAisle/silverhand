import type { Database as Db } from 'better-sqlite3';
import { decodeMessageSeq } from '@silverhand/shared';
import type {
  ConversationReadRow,
  ConversationStreamUnreadDto,
  MessageSeq,
  StreamUnreadDto,
} from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';
import { FOLLOWED_THREAD_UNREAD, ROLLUP_UNREAD } from './unread-predicates.js';

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
 * Per-stream unread for ONE conversation (#task:1226, rewritten #task:1967).
 *
 * Assembled in ONE exported constant so the query-plan contract test can
 * EXPLAIN exactly what {@link ConversationReadRepo.streamUnreadForConversation}
 * executes — an access-path assertion over a hand-rewritten copy of the query
 * would prove nothing.
 *
 * Shape (the #1967 target model): the query is driven by the conversation's
 * STREAMS, not by its message history.
 *
 *  1. `stream_cursor` enumerates the conversation's streams from
 *     `conversation_stream_heads` (mainline row + one row per thread that has
 *     messages) and resolves each one's cursor with a single indexed probe into
 *     `conversation_reads` (idx_conversation_reads_user_conversation_stream).
 *     `latest_seq` is deliberately NOT read: it is a FRESHNESS head, and
 *     freshness-exempt rows (§5.2) advance `messages.seq` without it, so a
 *     cursor can legitimately sit ABOVE the head. Only the cursor bounds unread.
 *  2. `unread_tail` range-seeks each stream's unread tail on
 *     idx_messages_thread_root (conversation_id, thread_root_id, seq > cursor),
 *     so the rows touched are proportional to what is UNREAD, not to the
 *     conversation's history.
 *  3. `per_stream` aggregates that tail; the anchor row is fetched back by
 *     (conversation_id, seq), a point lookup on the uniq_messages_conversation_seq
 *     unique index. `seq` is unique per conversation, so the joined row is
 *     necessarily the min-seq unread row of that stream — no window functions and
 *     no reliance on SQLite's bare-column min()/max() special case.
 *
 * Stream ENUMERATION completeness (the equivalence-critical step, since the
 * pre-#1967 query derived streams from `messages` itself): every non-exempt
 * insert advances its stream's head, and the only exempt writer inserts
 * `from_kind = 'system'` rows (schedule_fire), which this query excludes anyway.
 * A stream holding an unread-eligible message therefore always has a head row.
 *
 * The WHERE on `m` is the same pair of guards as `unreadCountForStream` /
 * `firstUnreadForStream`; archival is deliberately NOT filtered here (this is
 * the per-conversation face, its caller already resolved the conversation).
 *
 * The join order is PINNED with `CROSS JOIN` (in SQLite that is an inner join
 * that the planner may not reorder). Free to choose, the planner inverts the
 * loop — drive from `messages` by `conversation_id` and test each row against the
 * stream list — which is precisely the full-history scan this rewrite exists to
 * remove. Streams-outer / tail-inner is the whole point, so it is stated, not
 * hoped for.
 */
export const STREAM_UNREAD_FOR_CONVERSATION_SQL = `
  WITH stream_cursor AS (
    SELECT sh.thread_root_id            AS root,
           COALESCE(cr.last_read_seq, 0) AS cursor_seq
      FROM conversation_stream_heads sh
      LEFT JOIN conversation_reads cr
        ON cr.user_id = @viewer
       AND cr.conversation_id = sh.conversation_id
       AND cr.thread_root_id IS sh.thread_root_id
     WHERE sh.conversation_id = @conv
  ),
  unread_tail AS (
    SELECT sc.root AS root, m.seq AS seq
      FROM stream_cursor sc
      CROSS JOIN messages m
        ON m.conversation_id = @conv
       AND m.thread_root_id IS sc.root
       AND m.seq > sc.cursor_seq
     WHERE m.from_kind != 'system'
       AND NOT (m.from_kind = 'user'
                AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))
  ),
  per_stream AS (
    SELECT root,
           COUNT(*) AS unread_count,
           MIN(seq) AS first_unread_seq
      FROM unread_tail
     GROUP BY root
  )
  SELECT ps.root             AS root,
         m.id                AS first_unread_message_id,
         ps.first_unread_seq AS first_unread_seq,
         ps.unread_count     AS unread_count
    FROM per_stream ps
    JOIN messages m
      ON m.conversation_id = @conv AND m.seq = ps.first_unread_seq`;

/**
 * Per-stream read cursor (#task:1226). `conversation_reads` carries one cursor
 * per STREAM — mainline (thread_root_id IS NULL) and each reply-cluster
 * (thread_root_id = root id) — mirroring the per-stream `conversation_stream_heads`
 * freshness model. Two partial-unique indexes enforce uniqueness, so a given
 * (user, conversation) has MANY rows, not one; the full
 * (user_id, conversation_id, thread_root_id) index added in #task:1967 is the
 * ACCESS PATH for a dynamic-stream cursor probe and carries no uniqueness.
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
   *  stream (see {@link STREAM_UNREAD_FOR_CONVERSATION_SQL} for the access-path
   *  shape). Follow-AGNOSTIC: a thread's unread is independent of whether the
   *  viewer follows it (follow only gates the sidebar roll-up / Activity, never
   *  per-thread display). `threads` is sparse — a root appears only if it has
   *  >= 1 unread message; an absent root means 0. */
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
        STREAM_UNREAD_FOR_CONVERSATION_SQL,
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
    return {
      mainline,
      threads,
      followed_thread_unread: this.hasFollowedThreadUnread(conversationId, viewerUserId),
    };
  }

  /** Header Threads-icon dot signal (#task:1774): does the viewer have ANY unread
   *  reply in a thread they FOLLOW? EXISTS (boolean), not a count — the dot is a
   *  binary attention cue and a count here would be a needless full scan.
   *
   *  Uses {@link FOLLOWED_THREAD_UNREAD}, the SAME predicate the
   *  `?filter=followed-unread` threads view filters on, so the dot and the list
   *  can never disagree about which threads are "followed ∩ unread". Deliberately
   *  the followed-thread branch ONLY — mainline unread must not light this dot. */
  hasFollowedThreadUnread(conversationId: string, viewerUserId: string): boolean {
    const row = prepareObserved<{ conv: string; viewer: string }, { e: number }>(
        this.db,
        'reads.has_followed_thread_unread',
        `SELECT EXISTS (
           SELECT 1 FROM messages m
            WHERE m.conversation_id = @conv AND ${FOLLOWED_THREAD_UNREAD}
         ) AS e`,
      )
      .get({ conv: conversationId, viewer: viewerUserId });
    return (row?.e ?? 0) === 1;
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

  /** Per-conversation unread across ALL of the viewer's conversations
   *  (#task:1888) — the all-workspace twin of
   *  {@link unreadCountsByConversationForWorkspace}, for read faces that are
   *  themselves global. The global Favorites/STARRED list is one: its rows are
   *  conversations from any workspace, including workspaces the client is not
   *  currently fetching anything else for (a collapsed sidebar parent), so a
   *  per-workspace scan would mean one request per parent that happens to own a
   *  starred row. Same `ROLLUP_UNREAD` predicate and same per-row body as the
   *  scoped form, so a STARRED row's badge is provably the number its in-tree row
   *  would show. Counts only, no pointers: the pointer map is a jump-target
   *  concern of the per-workspace face, and nothing global needs it. */
  unreadCountsByConversation(viewerUserId: string): Record<string, number> {
    const rows = prepareObserved<{ viewer: string }, { conversation_id: string; c: number }>(
        this.db,
        'reads.unread_counts_by_conversation',
        `SELECT c.id AS conversation_id, COUNT(m.id) AS c
           FROM conversations c
           JOIN conversation_users cu
             ON cu.conversation_id = c.id AND cu.user_id = @viewer
           JOIN messages m
             ON m.conversation_id = c.id AND ${ROLLUP_UNREAD}
          GROUP BY c.id`,
      )
      .all({ viewer: viewerUserId });

    const byConversation: Record<string, number> = {};
    for (const row of rows) byConversation[row.conversation_id] = row.c;
    return byConversation;
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

// The unread predicates (roll-up + followed-thread-only) live in one shared
// module so every read-model — this repo's aggregates/counts, the header Threads
// dot, and the Unread threads view — embeds the SAME SQL (#task:1774).

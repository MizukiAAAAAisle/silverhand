import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  AttachmentSnapshot,
  FromKind,
  MessageDto,
  MessageRow,
  ReplyBadgeSummary,
  TaskAssigneeDto,
  ThreadReplier,
  ThreadSummary,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

/** Internal sentinel: thrown inside the per-stream conditional-insert
 *  transaction on a freshness CAS miss so the unconditional allocator
 *  `+1` rolls back with the savepoint (no burned global seq). Caught
 *  inside `insertForConversationIfFresh` and turned into an `{ ok:false }`
 *  result — it never escapes the repo. See docs/thread-reply-cluster-v1.md §6.4. */
class StreamCasMiss extends Error {}

export interface MessageWindow {
  messages: MessageDto[];
  reply_counts_by_root: Record<string, number>;
  has_more_before: boolean;
  has_more_after: boolean;
}

/** Sentinel thrown by `listWindowForConversation` when the caller
 *  passed `aroundMessageId` for a message that does not belong to
 *  this conversation (or does not exist). The route layer maps this
 *  to a 404 — the agent-facing read-history surface uses an inline
 *  result object for the same case. We use a class because repo
 *  callers are spread across user routes / agent routes / inbox
 *  formatters and a typed throw keeps the contract obvious without
 *  bleeding sentinel values into every call site. */
export class AnchorMessageNotInConversationError extends Error {
  constructor(
    public readonly conversationId: string,
    public readonly messageId: string,
  ) {
    super(
      `around_message_id ${messageId} does not belong to conversation ${conversationId}`,
    );
    this.name = 'AnchorMessageNotInConversationError';
  }
}

/** Max length of a thread row's plain-text preview (raw root content). The
 *  frontend adds the final ellipsis + renders mention sigils. */
const THREAD_PREVIEW_MAX_CHARS = 160;

/** Keyset position for the per-channel Threads list: the sort tuple of the
 *  last row on a page — (last_reply_at, root seq). Both components are
 *  needed because last_reply_at alone is not unique across clusters; root
 *  seq is the immutable tiebreak (matches the ORDER BY). */
interface ThreadsKeyset {
  /** epoch ms — `last_reply_at` of the boundary row. */
  at: number;
  /** the boundary root message's global `seq` (immutable tiebreak). */
  seq: number;
}

/** Thrown when an opaque `cursor` fails to decode. The route layer maps it
 *  to a 400 so a tampered / stale-format token is a clean client error
 *  rather than a 500. */
export class InvalidThreadsCursorError extends Error {
  constructor(public readonly cursor: string) {
    super(`invalid threads cursor: ${cursor}`);
    this.name = 'InvalidThreadsCursorError';
  }
}

function encodeThreadsCursor(keyset: ThreadsKeyset): string {
  return Buffer.from(
    JSON.stringify([keyset.at, keyset.seq]),
    'utf8',
  ).toString('base64url');
}

function decodeThreadsCursor(raw: string): ThreadsKeyset {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'number' &&
      Number.isFinite(parsed[0]) &&
      typeof parsed[1] === 'number' &&
      Number.isInteger(parsed[1])
    ) {
      return { at: parsed[0], seq: parsed[1] };
    }
  } catch {
    // fall through to the typed throw
  }
  throw new InvalidThreadsCursorError(raw);
}

/** A single page of the per-channel Threads list. */
export interface ChannelThreadsPage {
  threads: ThreadSummary[];
  next_cursor: string | null;
}

/** Raw joined row backing one Threads-list entry (root fields + the
 *  aggregated last-reply identity). */
interface ThreadRootRow {
  root_message_id: string;
  root_from_kind: FromKind;
  root_from_agent_id: string | null;
  root_from_user_id: string | null;
  root_content: string;
  root_created_at: number;
  root_seq: number;
  reply_count: number;
  last_reply_message_id: string;
  last_reply_at: number;
}

/** Storage `from_kind` → frontend author kind. 'user' is surfaced as
 *  'human' to match the principal-level vocabulary. */
function mapAuthorKind(fromKind: FromKind): 'agent' | 'human' | 'system' {
  if (fromKind === 'agent') return 'agent';
  if (fromKind === 'system') return 'system';
  return 'human';
}

function authorId(
  fromKind: FromKind,
  fromAgentId: string | null,
  fromUserId: string | null,
): string {
  if (fromKind === 'agent') return fromAgentId ?? '';
  return fromUserId ?? '';
}

/** Mutually-exclusive cursor anchors. The repo enforces "at most
 *  one is set"; the route layer additionally returns 400 when the
 *  HTTP query carries 2+ at once so we get a stable error on the
 *  wire. `null`/`undefined` for all three means "latest window". */
export interface ListWindowOpts {
  limit?: number;
  beforeSeq?: number | null;
  afterSeq?: number | null;
  aroundMessageId?: string | null;
}

type WindowScope =
  | { mode: 'all' }
  | { mode: 'main' }
  | { mode: 'cluster'; threadRootId: string };
type WindowScopeMode = WindowScope['mode'];

type MessageRowWithTaskAssignee = MessageRow & {
  task_assignee_name: string | null;
};

function messageRowWithTaskAssigneeToDto(
  row: MessageRowWithTaskAssignee,
): MessageDto {
  return messageRowToDto(row, { assigneeName: row.task_assignee_name });
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
  const metadata = row.metadata
    ? (JSON.parse(row.metadata) as Record<string, unknown>)
    : null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    from_kind: row.from_kind,
    from_agent_id: row.from_agent_id,
    from_user_id: row.from_user_id,
    content: row.content,
    metadata,
    attachments: extractAttachmentSnapshots(metadata),
    // Reactions are a viewer-scoped enrichment loaded separately (read-model
    // loadReactionAggregates); the bare row→DTO mapping is viewer-neutral, so
    // it defaults to null and the read route fills it for the human/agent
    // viewer (docs/reactions-design.md §3.5).
    reactions: null,
    seq: row.seq,
    created_at: row.created_at,
    thread_root_id: row.thread_root_id,
    task_number: row.task_number,
    task_status: row.task_status,
    task_title: row.task_title,
    task_workspace_id: row.task_workspace_id,
    task_closed_at: row.task_closed_at,
    task_assignee: assignee,
  };
}

/** Pull attachment snapshots out of message metadata, defensively. */
export function extractAttachmentSnapshots(
  metadata: Record<string, unknown> | null,
): AttachmentSnapshot[] | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const snapshots: AttachmentSnapshot[] = [];
  for (const item of raw) {
    if (
      item
      && typeof item === 'object'
      && typeof (item as { id?: unknown }).id === 'string'
      && typeof (item as { filename?: unknown }).filename === 'string'
      && typeof (item as { size?: unknown }).size === 'number'
      && typeof (item as { content_type?: unknown }).content_type === 'string'
    ) {
      const a = item as AttachmentSnapshot;
      snapshots.push({
        id: a.id,
        filename: a.filename,
        size: a.size,
        content_type: a.content_type,
      });
    }
  }
  return snapshots.length > 0 ? snapshots : null;
}

/** Convenience: parse-and-extract from a raw MessageRow, since callers
 *  outside the DTO mapper (e.g. the stdin formatters in
 *  `runtime/stdin-format.ts` that receive MessageRow from the inbox
 *  repo) want the typed list directly. */
export function extractAttachmentSnapshotsFromRow(
  row: { metadata: string | null },
): AttachmentSnapshot[] | null {
  const metadata = parseMessageMetadata(row.metadata);
  return extractAttachmentSnapshots(metadata);
}

export function extractSubtypeFromRow(
  row: { metadata: string | null },
): string | null {
  const metadata = parseMessageMetadata(row.metadata);
  const subtype = metadata?.subtype;
  return typeof subtype === 'string' ? subtype : null;
}

function parseMessageMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
  return parsed;
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  listForConversation(conversationId: string, limit = 200): MessageDto[] {
    return this.listWindowForConversation(conversationId, { limit }).messages;
  }

  listWindowForConversation(
    conversationId: string,
    opts: ListWindowOpts = {},
  ): MessageWindow {
    return this.listWindowForConversationScoped(conversationId, opts, {
      mode: 'all',
    });
  }

  listWindowForMainStream(
    conversationId: string,
    opts: ListWindowOpts = {},
  ): MessageWindow {
    return this.listWindowForConversationScoped(conversationId, opts, {
      mode: 'main',
    });
  }

  listWindowForThreadCluster(
    conversationId: string,
    threadRootId: string,
    opts: ListWindowOpts = {},
  ): MessageWindow {
    return this.listWindowForConversationScoped(conversationId, opts, {
      mode: 'cluster',
      threadRootId,
    });
  }

  private listWindowForConversationScoped(
    conversationId: string,
    opts: ListWindowOpts,
    scope: WindowScope,
  ): MessageWindow {
    const limit = Math.max(1, opts.limit ?? 200);
    const beforeSeq = opts.beforeSeq ?? null;
    const afterSeq = opts.afterSeq ?? null;
    const aroundMessageId = opts.aroundMessageId ?? null;

    // Mutex guard. The HTTP route already 400s on 2+ params before
    // reaching here; this defends programmatic callers and keeps the
    // semantics one-anchor-only. `latest` is the implicit zero-anchor
    // mode and never collides.
    const anchors = [
      beforeSeq !== null,
      afterSeq !== null,
      aroundMessageId !== null,
    ].filter(Boolean).length;
    if (anchors > 1) {
      throw new Error(
        'listWindowForConversation: beforeSeq / afterSeq / aroundMessageId are mutually exclusive',
      );
    }

    let rows: MessageRowWithTaskAssignee[];

    if (aroundMessageId !== null) {
      // Resolve anchor seq inside this conversation. We deliberately
      // require the anchor to belong to the same conversation: a
      // cross-conversation message id would otherwise leak a window
      // around a message the caller might not be allowed to see, and
      // the UX of "jump to message" is per-conversation anyway.
      const anchorSeq = this.anchorSeqFor(
        conversationId,
        aroundMessageId,
        scope,
      );
      if (anchorSeq === null) {
        throw new AnchorMessageNotInConversationError(
          conversationId,
          aroundMessageId,
        );
      }
      // Split: floor((limit - 1) / 2) before the anchor, then the
      // anchor row itself, then fill the remainder after. This mirrors
      // the agent-facing `buildReadHistoryDto` policy so user/agent
      // surfaces produce comparably shaped windows when they ever
      // need to be cross-checked in tests.
      const beforeCount = Math.floor((limit - 1) / 2);
      const beforeRows = this.fetchBeforeSeq(
        conversationId,
        anchorSeq,
        beforeCount,
        scope,
      );
      const anchorRow = this.fetchById(
        conversationId,
        aroundMessageId,
        scope,
      );
      const afterLimit = Math.max(
        0,
        limit - beforeRows.length - (anchorRow ? 1 : 0),
      );
      const afterRows = this.fetchAfterSeq(
        conversationId,
        anchorSeq,
        afterLimit,
        scope,
      );
      rows = [...beforeRows, ...(anchorRow ? [anchorRow] : []), ...afterRows];
    } else if (afterSeq !== null) {
      rows = this.fetchAfterSeq(conversationId, afterSeq, limit, scope);
    } else {
      // Both `latest` (beforeSeq === null) and explicit before_seq go
      // through the same DESC-then-ASC path; null acts as "no upper
      // bound", so the existing tail behaviour is preserved.
      rows = this.fetchBeforeSeq(conversationId, beforeSeq, limit, scope);
    }

    const minSeq = rows[0]?.seq ?? null;
    const maxSeq = rows.at(-1)?.seq ?? null;

    // For `latest` (no anchor at all), `has_more_after` must be false:
    // we always returned the tail-most rows, so by definition there is
    // nothing newer in the DB. We do NOT issue an extra DB probe in
    // that case — the absence of an anchor is itself the proof. For
    // every anchored mode (before/after/around) we probe by `seq >
    // maxSeq` so the answer reflects the actual rows we returned.
    const isLatest =
      beforeSeq === null && afterSeq === null && aroundMessageId === null;

    const hasMoreBefore =
      minSeq === null
        ? false
        : this.existsWithSeq(conversationId, '<', minSeq, scope);

    const hasMoreAfter =
      isLatest || maxSeq === null
        ? false
        : this.existsWithSeq(conversationId, '>', maxSeq, scope);

    return {
      messages: rows.map(r => messageRowWithTaskAssigneeToDto(r)),
      reply_counts_by_root: {},
      has_more_before: hasMoreBefore,
      has_more_after: hasMoreAfter,
    };
  }

  replyCountsByRoot(
    conversationId: string,
    rootMessageIds: readonly string[],
  ): Record<string, number> {
    const uniqueRootIds = [...new Set(rootMessageIds)];
    if (uniqueRootIds.length === 0) return {};
    const counts = Object.fromEntries(uniqueRootIds.map(id => [id, 0]));
    const placeholders = uniqueRootIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare<
        [string, ...string[]],
        { thread_root_id: string; reply_count: number }
      >(
        `SELECT thread_root_id, COUNT(*) AS reply_count
           FROM messages
          WHERE conversation_id = ?
            AND thread_root_id IN (${placeholders})
            AND from_kind != 'system'
          GROUP BY thread_root_id`,
      )
      .all(conversationId, ...uniqueRootIds);
    for (const row of rows) {
      counts[row.thread_root_id] = row.reply_count;
    }
    return counts;
  }

  /** P1 inline-badge enrichment (#task:1073): the per-root sibling of
   *  `replyCountsByRoot`. For each root in `rootMessageIds` that has >= 1
   *  non-system reply, returns the count + last-reply time + up to 3
   *  most-recent distinct repliers + the full distinct replier count. Keyed
   *  by root id; roots with no non-system reply are simply absent (the
   *  count-only badge already covers them). Scoped to the passed root set —
   *  it never widens beyond the window's `reply_counts_by_root` keys.
   *
   *  `reply_count` is identical to `replyCountsByRoot` by construction (same
   *  `from_kind != 'system'` rule), so the two never visibly diverge.
   *  `last_reply_at` is the max-`seq` non-system reply's `created_at` (seq is
   *  the recency authority — see `listChannelThreads`), shared with P2.
   *
   *  Also carries the viewer's per-thread unread sidecar (#task:1226:
   *  `unread_count` + first-unread id/seq), computed by the SAME
   *  `threadUnreadByRoots` the Threads list uses, so the inline reply chip
   *  ("3 replies · 2 new" + jump-to-first-unread) and the Threads list are one
   *  source of truth. Follow-agnostic. */
  replyBadgeSummariesByRoot(
    conversationId: string,
    rootMessageIds: readonly string[],
    viewerUserId: string,
  ): Record<string, ReplyBadgeSummary> {
    const result: Record<string, ReplyBadgeSummary> = {};
    const uniqueRootIds = [...new Set(rootMessageIds)];
    if (uniqueRootIds.length === 0) return result;
    const placeholders = uniqueRootIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare<
        [string, ...string[]],
        { root_id: string; reply_count: number; last_reply_at: number }
      >(
        `SELECT agg.root_id      AS root_id,
                agg.reply_count  AS reply_count,
                lr.created_at    AS last_reply_at
           FROM (
             SELECT thread_root_id AS root_id,
                    COUNT(*)       AS reply_count,
                    MAX(seq)       AS last_reply_seq
               FROM messages
              WHERE conversation_id = ?
                AND thread_root_id IN (${placeholders})
                AND from_kind != 'system'
              GROUP BY thread_root_id
           ) agg
           JOIN messages lr
             ON lr.conversation_id = ?
            AND lr.thread_root_id = agg.root_id
            AND lr.seq = agg.last_reply_seq`,
      )
      .all(conversationId, ...uniqueRootIds, conversationId);

    const repliersByRoot = this.repliersForRoots(conversationId, uniqueRootIds);
    // Same per-thread unread sidecar the Threads list uses (#task:1226), so the
    // inline reply chip and the Threads list read ONE source of truth. Batched,
    // follow-agnostic (a thread's unread doesn't depend on follow state).
    const unreadByRoot = this.threadUnreadByRoots(
      conversationId,
      uniqueRootIds,
      viewerUserId,
    );

    for (const row of rows) {
      const rep = repliersByRoot.get(row.root_id) ?? {
        repliers: [],
        total: 0,
      };
      const unread = unreadByRoot.get(row.root_id);
      result[row.root_id] = {
        reply_count: row.reply_count,
        last_reply_at: row.last_reply_at,
        repliers: rep.repliers,
        replier_total: rep.total,
        unread_count: unread?.unread_count ?? 0,
        first_unread_message_id: unread?.first_unread_message_id ?? null,
        first_unread_seq: unread?.first_unread_seq ?? null,
      };
    }
    return result;
  }

  /** Per-channel reply-cluster ("Threads") discovery list. A "thread" is any
   *  root message with >= 1 non-system reply in the same conversation
   *  (`thread_root_id = root.id`, `from_kind != 'system'`). Rows are ordered
   *  newest-activity-first — `last_reply_at DESC, root seq DESC` — and
   *  keyset-paginated over that same tuple (the opaque `cursor`). Operates
   *  purely on the reply-cluster spine (migration 43); it never resolves a
   *  legacy `kind='thread'` conversation.
   *
   *  `last_reply_at` / `last_reply_message_id` identify ONE row — the
   *  max-`seq` non-system reply (seq is the system's recency authority) —
   *  so the timestamp and the message id always agree. */
  listChannelThreads(
    conversationId: string,
    viewerUserId: string,
    opts: { limit?: number; cursor?: string | null } = {},
  ): ChannelThreadsPage {
    const limit = Math.min(50, Math.max(1, opts.limit ?? 30));
    const cursor = opts.cursor ? decodeThreadsCursor(opts.cursor) : null;

    // Fetch one extra row to decide whether a next page exists without a
    // second COUNT query.
    const rows = this.db
      .prepare<
        [string, string, string, number, number, number, number, number],
        ThreadRootRow
      >(
        `SELECT
           root.id            AS root_message_id,
           root.from_kind     AS root_from_kind,
           root.from_agent_id AS root_from_agent_id,
           root.from_user_id  AS root_from_user_id,
           root.content       AS root_content,
           root.created_at    AS root_created_at,
           root.seq           AS root_seq,
           agg.reply_count    AS reply_count,
           lr.id              AS last_reply_message_id,
           lr.created_at      AS last_reply_at
         FROM (
           SELECT thread_root_id AS root_id,
                  COUNT(*)       AS reply_count,
                  MAX(seq)       AS last_reply_seq
             FROM messages
            WHERE conversation_id = ?
              AND thread_root_id IS NOT NULL
              AND from_kind != 'system'
            GROUP BY thread_root_id
         ) agg
         JOIN messages lr
           ON lr.conversation_id = ?
          AND lr.thread_root_id = agg.root_id
          AND lr.seq = agg.last_reply_seq
         JOIN messages root
           ON root.id = agg.root_id
          AND root.conversation_id = ?
         WHERE (
                 ? = 0
                 OR lr.created_at < ?
                 OR (lr.created_at = ? AND root.seq < ?)
               )
         ORDER BY lr.created_at DESC, root.seq DESC
         LIMIT ?`,
      )
      .all(
        conversationId,
        conversationId,
        conversationId,
        cursor ? 1 : 0,
        cursor?.at ?? 0,
        cursor?.at ?? 0,
        cursor?.seq ?? 0,
        limit + 1,
      );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const repliersByRoot = this.repliersForRoots(
      conversationId,
      pageRows.map(r => r.root_message_id),
    );

    // Per-viewer read state (#task:1226). Both READ-ONLY w.r.t. delivery:
    // unread comes from the human per-thread `conversation_reads` cursor, and
    // `viewer_following` only READS human `thread_followers` rows — neither
    // writes follow / wake / delivery state.
    const rootIds = pageRows.map(r => r.root_message_id);
    const unreadByRoot = this.threadUnreadByRoots(conversationId, rootIds, viewerUserId);
    const followedRoots = this.followedRootsForViewer(conversationId, rootIds, viewerUserId);

    const threads: ThreadSummary[] = pageRows.map(r => {
      const rep = repliersByRoot.get(r.root_message_id) ?? {
        repliers: [],
        total: 0,
      };
      const unread = unreadByRoot.get(r.root_message_id);
      return {
        root_message_id: r.root_message_id,
        root_author: {
          kind: mapAuthorKind(r.root_from_kind),
          id: authorId(r.root_from_kind, r.root_from_agent_id, r.root_from_user_id),
        },
        root_preview: r.root_content.slice(0, THREAD_PREVIEW_MAX_CHARS),
        root_created_at: r.root_created_at,
        reply_count: r.reply_count,
        last_reply_at: r.last_reply_at,
        last_reply_message_id: r.last_reply_message_id,
        repliers: rep.repliers,
        replier_total: rep.total,
        unread_count: unread?.unread_count ?? 0,
        first_unread_message_id: unread?.first_unread_message_id ?? null,
        first_unread_seq: unread?.first_unread_seq ?? null,
        viewer_following: followedRoots.has(r.root_message_id),
      };
    });

    const boundary = pageRows.at(-1);
    const next_cursor =
      hasMore && boundary
        ? encodeThreadsCursor({
            at: boundary.last_reply_at,
            seq: boundary.root_seq,
          })
        : null;

    return { threads, next_cursor };
  }

  /** Distinct repliers per root, most-recent first (up to 3) plus the full
   *  distinct count. Distinct identity is (from_kind, actor id); ordering is
   *  by the replier's most-recent reply (`MAX(seq)`). Legacy rows with no
   *  resolvable actor id (pre-v26 null `from_user_id`) are skipped — they
   *  can't render an avatar — so `replier_total` counts identifiable
   *  repliers only. */
  private repliersForRoots(
    conversationId: string,
    rootIds: readonly string[],
  ): Map<string, { repliers: ThreadReplier[]; total: number }> {
    const result = new Map<
      string,
      { repliers: ThreadReplier[]; total: number }
    >();
    if (rootIds.length === 0) return result;
    const placeholders = rootIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare<
        [string, ...string[]],
        {
          root_id: string;
          from_kind: FromKind;
          actor_id: string | null;
          last_seq: number;
        }
      >(
        `SELECT thread_root_id AS root_id,
                from_kind      AS from_kind,
                CASE from_kind WHEN 'agent' THEN from_agent_id ELSE from_user_id END AS actor_id,
                MAX(seq)       AS last_seq
           FROM messages
          WHERE conversation_id = ?
            AND thread_root_id IN (${placeholders})
            AND from_kind != 'system'
          GROUP BY thread_root_id, from_kind, actor_id
          ORDER BY last_seq DESC`,
      )
      .all(conversationId, ...rootIds);

    // Rows arrive globally seq-DESC; per-root relative order is preserved, so
    // accumulating in iteration order yields most-recent-first repliers.
    for (const row of rows) {
      if (row.actor_id == null) continue;
      let entry = result.get(row.root_id);
      if (!entry) {
        entry = { repliers: [], total: 0 };
        result.set(row.root_id, entry);
      }
      entry.total += 1;
      if (entry.repliers.length < 3) {
        entry.repliers.push({
          kind: row.from_kind === 'agent' ? 'agent' : 'human',
          id: row.actor_id,
        });
      }
    }
    return result;
  }

  /** Per-thread unread + first-unread for a set of roots, for one viewer
   *  (#task:1226). Each thread is scored against ITS OWN per-thread cursor
   *  (`conversation_reads` row with thread_root_id = root) — NOT roll-up, NOT
   *  follow-gated: a thread's unread is the same whether or not the viewer
   *  follows it (follow only changes presentation). Roots with zero unread are
   *  absent from the map (caller defaults to 0 / null). */
  private threadUnreadByRoots(
    conversationId: string,
    rootIds: readonly string[],
    viewerUserId: string,
  ): Map<
    string,
    { unread_count: number; first_unread_message_id: string; first_unread_seq: number }
  > {
    const result = new Map<
      string,
      { unread_count: number; first_unread_message_id: string; first_unread_seq: number }
    >();
    if (rootIds.length === 0) return result;
    const placeholders = rootIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare<
        [string, ...string[]],
        {
          root_id: string;
          first_unread_message_id: string;
          first_unread_seq: number;
          unread_count: number;
        }
      >(
        `SELECT root_id, message_id AS first_unread_message_id, seq AS first_unread_seq, unread_count
           FROM (
             SELECT m.thread_root_id AS root_id,
                    m.id  AS message_id,
                    m.seq AS seq,
                    ROW_NUMBER() OVER (PARTITION BY m.thread_root_id ORDER BY m.seq ASC) AS rn,
                    COUNT(*)     OVER (PARTITION BY m.thread_root_id) AS unread_count
               FROM messages m
              WHERE m.conversation_id = ?
                AND m.thread_root_id IN (${placeholders})
                AND m.seq > COALESCE(
                  (SELECT cr.last_read_seq FROM conversation_reads cr
                    WHERE cr.user_id = ?
                      AND cr.conversation_id = ?
                      AND cr.thread_root_id = m.thread_root_id),
                  0
                )
                AND m.from_kind != 'system'
                AND NOT (m.from_kind = 'user' AND (m.from_user_id = ? OR m.from_user_id IS NULL))
           )
          WHERE rn = 1`,
      )
      .all(conversationId, ...rootIds, viewerUserId, conversationId, viewerUserId);

    for (const row of rows) {
      result.set(row.root_id, {
        unread_count: row.unread_count,
        first_unread_message_id: row.first_unread_message_id,
        first_unread_seq: row.first_unread_seq,
      });
    }
    return result;
  }

  /** Subset of `rootIds` the viewer FOLLOWS (`thread_followers`,
   *  principal_kind='human'). READ-ONLY: this never writes follow / delivery
   *  state (#task:1226 invariant 4). */
  private followedRootsForViewer(
    conversationId: string,
    rootIds: readonly string[],
    viewerUserId: string,
  ): Set<string> {
    const followed = new Set<string>();
    if (rootIds.length === 0) return followed;
    const placeholders = rootIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare<[string, string, ...string[]], { thread_root_id: string }>(
        `SELECT thread_root_id
           FROM thread_followers
          WHERE conversation_id = ?
            AND principal_kind = 'human'
            AND principal_id = ?
            AND thread_root_id IN (${placeholders})`,
      )
      .all(conversationId, viewerUserId, ...rootIds);
    for (const row of rows) followed.add(row.thread_root_id);
    return followed;
  }

  /** Fetch up to `limit` rows with `seq < beforeSeq` (or the tail
   *  when `beforeSeq` is null), returned in seq ASC. Shared by
   *  `latest` / `before_seq` / `around_message_id` paths so all of
   *  them produce identically shaped joined rows. */
  private fetchBeforeSeq(
    conversationId: string,
    beforeSeq: number | null,
    limit: number,
    scope: WindowScope,
  ): MessageRowWithTaskAssignee[] {
    return this.db
      .prepare<
        [
          string,
          number | null,
          number | null,
          WindowScopeMode,
          WindowScopeMode,
          WindowScopeMode,
          string | null,
          string | null,
          number,
        ],
        MessageRowWithTaskAssignee
      >(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM (
             SELECT *
               FROM messages
              WHERE conversation_id = ?
                AND (? IS NULL OR seq < ?)
                AND (
                  ? = 'all'
                  OR (? = 'main' AND thread_root_id IS NULL)
                  OR (? = 'cluster' AND (id = ? OR thread_root_id = ?))
                )
              ORDER BY seq DESC
              LIMIT ?
           ) m
          LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          ORDER BY m.seq ASC`,
      )
      .all(
        conversationId,
        beforeSeq,
        beforeSeq,
        ...this.scopeParams(scope),
        limit,
      );
  }

  /** Fetch up to `limit` rows with `seq > afterSeq`, returned in
   *  seq ASC. Used by `after_seq` and the post-anchor half of
   *  `around_message_id`. */
  private fetchAfterSeq(
    conversationId: string,
    afterSeq: number,
    limit: number,
    scope: WindowScope,
  ): MessageRowWithTaskAssignee[] {
    if (limit <= 0) return [];
    return this.db
      .prepare<
        [
          string,
          number,
          WindowScopeMode,
          WindowScopeMode,
          WindowScopeMode,
          string | null,
          string | null,
          number,
        ],
        MessageRowWithTaskAssignee
      >(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.seq > ?
            AND (
              ? = 'all'
              OR (? = 'main' AND m.thread_root_id IS NULL)
              OR (? = 'cluster' AND (m.id = ? OR m.thread_root_id = ?))
            )
          ORDER BY m.seq ASC
          LIMIT ?`,
      )
      .all(conversationId, afterSeq, ...this.scopeParams(scope), limit);
  }

  /** Fetch a single row by id, scoped to one conversation. Returns
   *  null when the id does not belong to the conversation; this is
   *  what gives `aroundMessageId` its 404 semantics. */
  private fetchById(
    conversationId: string,
    messageId: string,
    scope: WindowScope,
  ): MessageRowWithTaskAssignee | null {
    const row = this.db
      .prepare<
        [
          string,
          string,
          WindowScopeMode,
          WindowScopeMode,
          WindowScopeMode,
          string | null,
          string | null,
        ],
        MessageRowWithTaskAssignee
      >(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.id = ?
            AND (
              ? = 'all'
              OR (? = 'main' AND m.thread_root_id IS NULL)
              OR (? = 'cluster' AND (m.id = ? OR m.thread_root_id = ?))
            )`,
      )
      .get(conversationId, messageId, ...this.scopeParams(scope));
    return row ?? null;
  }

  /** Resolve a message id to its seq within a specific conversation,
   *  or null when the id does not belong to that conversation. */
  private anchorSeqFor(
    conversationId: string,
    messageId: string,
    scope: WindowScope,
  ): number | null {
    const row = this.db
      .prepare<
        [
          string,
          string,
          WindowScopeMode,
          WindowScopeMode,
          WindowScopeMode,
          string | null,
          string | null,
        ],
        { seq: number }
      >(
        `SELECT seq FROM messages
          WHERE conversation_id = ? AND id = ?
            AND (
              ? = 'all'
              OR (? = 'main' AND thread_root_id IS NULL)
              OR (? = 'cluster' AND (id = ? OR thread_root_id = ?))
            )`,
      )
      .get(conversationId, messageId, ...this.scopeParams(scope));
    return row?.seq ?? null;
  }

  /** Cheap "is there any row on the other side of `pivot`" probe.
   *  Used to populate `has_more_before` / `has_more_after`. */
  private existsWithSeq(
    conversationId: string,
    op: '<' | '>',
    pivot: number,
    scope: WindowScope,
  ): boolean {
    const sql =
      op === '<'
        ? `SELECT 1 AS found FROM messages
            WHERE conversation_id = ? AND seq < ?
              AND (
                ? = 'all'
                OR (? = 'main' AND thread_root_id IS NULL)
                OR (? = 'cluster' AND (id = ? OR thread_root_id = ?))
              )
            LIMIT 1`
        : `SELECT 1 AS found FROM messages
            WHERE conversation_id = ? AND seq > ?
              AND (
                ? = 'all'
                OR (? = 'main' AND thread_root_id IS NULL)
                OR (? = 'cluster' AND (id = ? OR thread_root_id = ?))
              )
            LIMIT 1`;
    return (
      this.db
        .prepare<
          [
            string,
            number,
            WindowScopeMode,
            WindowScopeMode,
            WindowScopeMode,
            string | null,
            string | null,
          ],
          { found: 1 }
        >(sql)
        .get(conversationId, pivot, ...this.scopeParams(scope)) !== undefined
    );
  }

  private scopeParams(
    scope: WindowScope,
  ): [
    WindowScopeMode,
    WindowScopeMode,
    WindowScopeMode,
    string | null,
    string | null,
  ] {
    const threadRootId = scope.mode === 'cluster' ? scope.threadRootId : null;
    return [scope.mode, scope.mode, scope.mode, threadRootId, threadRootId];
  }

  getById(id: string): MessageDto | null {
    const row = this.db
      .prepare<[string], MessageRowWithTaskAssignee>(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.id = ?`,
      )
      .get(id);
    return row ? messageRowWithTaskAssigneeToDto(row) : null;
  }

  /**
   * D4.d D3 round-1 P1.3 — return the first (lowest-`seq`) system
   * message in `conversationId` whose `metadata.subtype` equals
   * `subtype`. Used by `POST /api/agents` active-row idempotent
   * echo to reconstruct `onboarding_message_id` (the seed message
   * inserted in L3a's tx is identified by
   * `from_kind='system' AND metadata.subtype='onboarding'`).
   *
   * Returns `null` when no such message exists. Callers MUST treat
   * `null` as an invariant violation on a path that requires the
   * message to exist (the route returns 500 `internal_error`,
   * never a silent null fallback — Cindy refinement
   * `m-K0qV09mGuRqwtu` #2: an active agent row without its
   * onboarding seed is a corrupt dependent graph, not a permitted
   * state).
   *
   * Uses sqlite `json_extract` against the JSON-stringified
   * `metadata` column so the filter pushes down to the prepared
   * statement (zero deserialization in JS for non-matching rows).
   */
  findFirstSystemSubtypeInConversation(
    conversationId: string,
    subtype: string,
  ): MessageDto | null {
    const row = this.db
      .prepare<[string, string], MessageRowWithTaskAssignee>(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.from_kind = 'system'
            AND json_extract(m.metadata, '$.subtype') = ?
          ORDER BY m.seq ASC
          LIMIT 1`,
      )
      .get(conversationId, subtype);
    return row ? messageRowWithTaskAssigneeToDto(row) : null;
  }

  insertForConversation(params: {
    conversationId: string;
    fromKind: FromKind;
    fromAgentId?: string | null;
    fromUserId?: string | null;
    content: string;
    metadata?: Record<string, unknown> | null;
    /** Attachment snapshots to embed under `metadata.attachments`.
     *  Caller is responsible for resolving ids → snapshots and verifying
     *  channel ownership before passing them in. */
    attachments?: AttachmentSnapshot[] | null;
    /** Reply-cluster anchor (v43). NULL/omitted = main-line message; a
     *  root message id routes this message into that thread's stream.
     *  See docs/thread-reply-cluster-v1.md. */
    threadRootId?: string | null;
  }): MessageDto {
    return this.db.transaction(() => {
      const seq = this.reserveNextSeq(params.conversationId);
      const message = this.insertForConversationAtSeq(params, seq);
      // Stream-head maintenance invariant: EVERY insert advances its
      // stream's head (main when threadRootId is null), or the head drifts
      // behind messages.seq and the per-stream freshness CAS misfires.
      this.bumpStreamHead(params.conversationId, params.threadRootId ?? null, seq);
      return message;
    })();
  }

  insertForConversationIfFresh(params: {
    conversationId: string;
    seenUpToSeq: number;
    fromKind: FromKind;
    fromAgentId?: string | null;
    fromUserId?: string | null;
    content: string;
    metadata?: Record<string, unknown> | null;
    attachments?: AttachmentSnapshot[] | null;
    /** Reply-cluster anchor (v43); NULL/omitted = main-line stream. The
     *  freshness CAS is scoped to THIS stream's head, not the whole
     *  conversation. `seenUpToSeq` is the actor's last-observed seq in the
     *  same stream. See docs/thread-reply-cluster-v1.md §6.4. */
    threadRootId?: string | null;
  }): { ok: true; message: MessageDto } | { ok: false; currentSeq: number } {
    const threadRootId = params.threadRootId ?? null;
    try {
      return this.db.transaction(() => {
        // The conversation-global allocator (`+1`) and the per-stream
        // freshness CAS are two steps now (they used to be one guarded
        // UPDATE). They MUST share one transaction: on a CAS miss we throw
        // so the allocator `+1` rolls back with the savepoint — no burned
        // global seq. (doc §6.4 step 4)
        const seq = this.reserveNextSeq(params.conversationId);
        if (!this.casStreamHead(params.conversationId, threadRootId, params.seenUpToSeq, seq)) {
          throw new StreamCasMiss();
        }
        return {
          ok: true as const,
          message: this.insertForConversationAtSeq(params, seq),
        };
      })();
    } catch (err) {
      if (err instanceof StreamCasMiss) {
        return {
          ok: false as const,
          currentSeq: this.streamHeadLatestSeq(params.conversationId, threadRootId),
        };
      }
      throw err;
    }
  }

  latestSeqForConversation(conversationId: string): number {
    const row = this.db
      .prepare<[string], { latest_message_seq: number }>(
        `SELECT latest_message_seq
           FROM conversations
          WHERE id = ?`,
      )
      .get(conversationId);
    return row?.latest_message_seq ?? 0;
  }

  listAfterSeq(
    conversationId: string,
    afterSeq: number,
    limit = 10,
  ): MessageDto[] {
    return this.fetchAfterSeq(
      conversationId,
      afterSeq,
      Math.max(1, limit),
      { mode: 'all' },
    )
      .map(messageRowWithTaskAssigneeToDto);
  }

  /** Stream-scoped variant of `listAfterSeq`: only messages in the given
   *  stream (`threadRootId` NULL = main line). Used to build a
   *  freshness-stale `newer_messages` list that stays inside the actor's
   *  own target stream — a conversation-global list would leak replies from
   *  threads the actor never followed. (doc §6.4) */
  listAfterSeqInStream(
    conversationId: string,
    threadRootId: string | null,
    afterSeq: number,
    limit = 10,
  ): MessageDto[] {
    return this.db
      .prepare<
        [string, string | null, number, number],
        MessageRowWithTaskAssignee
      >(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.thread_root_id IS ?
            AND m.seq > ?
          ORDER BY m.seq ASC
          LIMIT ?`,
      )
      .all(conversationId, threadRootId, afterSeq, Math.max(1, limit))
      .map(messageRowWithTaskAssigneeToDto);
  }

  /** All messages in a thread stream with `seq < beforeSeq`, ordered ASC.
   *  Uncapped by design: backfilling a newly-followed agent must catch up the
   *  COMPLETE prior thread history (§6.1) — a `LIMIT` here would silently drop
   *  the replies nearest the current one (the most relevant context). If a
   *  thread ever grows large enough that full backfill is a problem, the
   *  answer is an explicit digest/truncation message in context, not a cap
   *  that drops context invisibly. (`threadRootId` is the root message id;
   *  the root itself carries NULL and is enqueued separately.) */
  listStreamBelowSeq(
    conversationId: string,
    threadRootId: string,
    beforeSeq: number,
  ): MessageDto[] {
    return this.db
      .prepare<[string, string, number], MessageRowWithTaskAssignee>(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.thread_root_id IS ?
            AND m.seq < ?
          ORDER BY m.seq ASC`,
      )
      .all(conversationId, threadRootId, beforeSeq)
      .map(messageRowWithTaskAssigneeToDto);
  }

  /** Fetch a message by id, scoped to one conversation. Returns null when
   *  the id does not belong to the conversation. Used by the send path to
   *  resolve a `--reply-to` target into its thread root. */
  getInConversation(
    conversationId: string,
    messageId: string,
  ): MessageDto | null {
    const row = this.fetchById(conversationId, messageId, { mode: 'all' });
    return row ? messageRowWithTaskAssigneeToDto(row) : null;
  }

  private reserveNextSeq(conversationId: string): number {
    const changed = this.db
      .prepare<[string]>(
        `UPDATE conversations
            SET latest_message_seq = latest_message_seq + 1
          WHERE id = ?`,
      )
      .run(conversationId).changes;
    if (changed !== 1) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    return this.latestSeqForConversation(conversationId);
  }

  /** Read a stream's freshness head (`threadRootId` NULL = main line).
   *  Returns 0 when no head row exists yet (a thread before its first
   *  reply). The main head always exists post-v43 (backfilled). */
  streamHeadLatestSeq(
    conversationId: string,
    threadRootId: string | null,
  ): number {
    const row = this.db
      .prepare<[string, string | null], { latest_seq: number }>(
        `SELECT latest_seq FROM conversation_stream_heads
          WHERE conversation_id = ? AND thread_root_id IS ?`,
      )
      .get(conversationId, threadRootId);
    return row?.latest_seq ?? 0;
  }

  /** Unconditionally advance a stream's head to `newSeq` (the largest seq
   *  by construction — the global allocator just minted it). UPDATE-or-INSERT
   *  with no ON CONFLICT target, which sidesteps the partial-index
   *  conflict-target rule. Used by every non-CAS insert path. */
  private bumpStreamHead(
    conversationId: string,
    threadRootId: string | null,
    newSeq: number,
  ): void {
    const updated = this.db
      .prepare<[number, string, string | null]>(
        `UPDATE conversation_stream_heads
            SET latest_seq = ?
          WHERE conversation_id = ? AND thread_root_id IS ?`,
      )
      .run(newSeq, conversationId, threadRootId).changes;
    if (updated === 0) {
      this.db
        .prepare<[string, string | null, number]>(
          `INSERT INTO conversation_stream_heads
             (conversation_id, thread_root_id, latest_seq)
           VALUES (?, ?, ?)`,
        )
        .run(conversationId, threadRootId, newSeq);
    }
  }

  /** Per-stream freshness CAS (doc §6.4). Advances the stream head from
   *  `seenStreamSeq` to `newSeq`; returns false (stale) when the head moved
   *  underneath the caller.
   *
   *  UPDATE-first (a refinement of the doc's plain branch-by-seen): the
   *  conditional UPDATE handles every case where the head row already exists
   *  — including the backfilled main head sitting at `latest_seq = 0`, which
   *  a bare `seen==0 → INSERT` branch would wrongly treat as a conflict and
   *  reject (a regression vs. the old conversation-level CAS). Only when the
   *  UPDATE matches no row AND `seenStreamSeq == 0` is the head genuinely
   *  absent (a thread's first reply) → INSERT, with ON CONFLICT DO NOTHING
   *  so a concurrent first reply loses the race (changes == 0 → stale). A
   *  `seen > 0` miss means the head was advanced or is missing → stale, never
   *  a wrongful insert. (No conflict target needed in either statement.) */
  private casStreamHead(
    conversationId: string,
    threadRootId: string | null,
    seenStreamSeq: number,
    newSeq: number,
  ): boolean {
    const advanced = this.db
      .prepare<[number, string, string | null, number]>(
        `UPDATE conversation_stream_heads
            SET latest_seq = ?
          WHERE conversation_id = ? AND thread_root_id IS ? AND latest_seq = ?`,
      )
      .run(newSeq, conversationId, threadRootId, seenStreamSeq).changes;
    if (advanced === 1) return true;
    if (seenStreamSeq !== 0) return false;
    const inserted = this.db
      .prepare<[string, string | null, number]>(
        `INSERT INTO conversation_stream_heads
           (conversation_id, thread_root_id, latest_seq)
         VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(conversationId, threadRootId, newSeq).changes;
    return inserted === 1;
  }

  private insertForConversationAtSeq(params: {
    conversationId: string;
    fromKind: FromKind;
    fromAgentId?: string | null;
    fromUserId?: string | null;
    content: string;
    metadata?: Record<string, unknown> | null;
    attachments?: AttachmentSnapshot[] | null;
    threadRootId?: string | null;
  }, seq: number): MessageDto {
    const id = newId();
    const now = Date.now();
    const mergedMetadata = mergeMetadataWithAttachments(
      params.metadata ?? null,
      params.attachments ?? null,
    );
    this.db
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, from_kind, from_agent_id, from_user_id,
          content, metadata, seq, created_at, thread_root_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.conversationId,
        params.fromKind,
        params.fromAgentId ?? null,
        params.fromUserId ?? null,
        params.content,
        mergedMetadata ? JSON.stringify(mergedMetadata) : null,
        seq,
        now,
        params.threadRootId ?? null,
      );
    const row = this.db
      .prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?')
      .get(id);
    if (!row) throw new Error('message insert failed');
    return messageRowToDto(row);
  }
}

function mergeMetadataWithAttachments(
  metadata: Record<string, unknown> | null,
  attachments: AttachmentSnapshot[] | null,
): Record<string, unknown> | null {
  if (!attachments || attachments.length === 0) return metadata;
  // Defensive copy: don't mutate caller's metadata object.
  return { ...(metadata ?? {}), attachments };
}

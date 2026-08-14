import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { decodeMessageSeq } from '@silverhand/shared';
import {
  THREAD_PREVIEW_MAX_CHARS,
  formatAttachmentLabel,
  normalizeThreadPreviewExcerpt,
  parseAttachmentLabel,
  readTaskSystemMetadataPartial,
  resolveAttachmentLabels,
} from '@silverhand/shared';
import type {
  AttachmentSnapshot,
  FromKind,
  LinkedTaskDto,
  MessageAuthorDto,
  MessageAuthorRow,
  MessageDto,
  MessageRow,
  ReplyBadgeSummary,
  TaskAssigneeDto,
  TaskStatus,
  ThreadReplyPreviewRow,
  ThreadSummary,
  ThreadSummaryInvariant,
} from '@silverhand/shared';
import {
  loadMessageAuthors,
  resolveOneMessageAuthor,
} from './message-author.js';
import {
  streamScopePredicate,
  streamScopeParams,
  type WindowScope,
  type WindowScopeMode,
} from './message-stream-scope.js';
import { FOLLOWED_THREAD_UNREAD } from './unread-predicates.js';
import { prepareObserved } from '../observability/observed-statement.js';

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

/** Threads-list scope (#task:1774). `'all'` (default) is every reply-cluster;
 *  `'followed-unread'` narrows to roots the viewer FOLLOWS and has unread replies
 *  in — the panel's "Unread" tab, sharing the header dot's predicate. */
export type ThreadsListFilter = 'all' | 'followed-unread';

/** Raw joined row backing one Threads-list entry (root fields + the
 *  aggregated last-reply identity). */
interface ThreadRootRow {
  root_message_id: string;
  root_from_kind: FromKind;
  root_from_agent_id: string | null;
  root_from_user_id: string | null;
  // Send-time author snapshot (survives ON DELETE SET NULL) — resolves the root
  // author to a stable identity even after the actor is hard-deleted (#task:1791).
  root_author_id: string | null;
  root_author_name: string | null;
  root_author_display_name: string | null;
  root_content: string;
  root_created_at: number;
  root_seq: number;
  reply_count: number;
  last_reply_message_id: string;
  last_reply_at: number;
}

/** The SELECT-list fragment projecting a root message's raw provenance + author
 *  snapshot columns (aliased `root`). Pair with {@link rootAuthorRow} to resolve
 *  the {@link MessageAuthorDto}. Kept as one constant so the two thread-root
 *  queries (list + single-entry) can't drift in which columns they project. */
const THREAD_ROOT_AUTHOR_SELECT = `root.from_kind     AS root_from_kind,
           root.from_agent_id AS root_from_agent_id,
           root.from_user_id  AS root_from_user_id,
           root.author_id           AS root_author_id,
           root.author_name         AS root_author_name,
           root.author_display_name AS root_author_display_name`;

/** Adapt a {@link ThreadRootRow} into the {@link MessageAuthorRow} the shared
 *  resolver consumes (root_* → the un-prefixed author-evidence fields). */
function rootAuthorRow(row: ThreadRootRow): MessageAuthorRow {
  return {
    from_kind: row.root_from_kind,
    from_agent_id: row.root_from_agent_id,
    from_user_id: row.root_from_user_id,
    author_id: row.root_author_id,
    author_name: row.root_author_name,
    author_display_name: row.root_author_display_name,
  };
}

/** SINGLE-SOURCE row→ThreadSummary projection for the VIEWER-INVARIANT subset.
 *  Both {@link MessageRepo.listChannelThreads} (per page row) and
 *  {@link MessageRepo.threadListEntryForRoot} (single root, S1 P2) map a
 *  `ThreadRootRow` + its resolved author/repliers into the same shape — keeping
 *  that in one place is the anti-drift guard: when `ThreadSummary` grows a
 *  viewer-invariant field it is added here once, and the two callers can't
 *  silently diverge. `rootAuthor` / `rep.repliers` are the SAME server-resolved
 *  {@link MessageAuthorDto} as `MessageDto.author` (#task:1791) — the caller
 *  resolves them (batch for the list, point for the single entry) so a
 *  hard-deleted actor keeps its snapshot identity. `viewer_following` is NOT set
 *  here — it is per-viewer (barred from the broadcast frame, S1 §3); the list
 *  layers it on top per viewer, the single-root entry omits it entirely. */
function rowToThreadSummaryInvariant(
  row: ThreadRootRow,
  rootAuthor: MessageAuthorDto | null,
  rep: { repliers: MessageAuthorDto[]; total: number },
): ThreadSummaryInvariant {
  return {
    root_message_id: row.root_message_id,
    root_author: rootAuthor,
    root_preview: row.root_content.slice(0, THREAD_PREVIEW_MAX_CHARS),
    root_created_at: row.root_created_at,
    root_seq: decodeMessageSeq(row.root_seq),
    reply_count: row.reply_count,
    last_reply_at: row.last_reply_at,
    last_reply_message_id: row.last_reply_message_id,
    repliers: rep.repliers,
    replier_total: rep.total,
  };
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

/** A message row joined with the task LINKED to it via that task's immutable
 *  source provenance (`tasks.source_message_id == messages.id`). The `lt_*`
 *  columns are the joined `tasks` fields; all null when the message is not a
 *  task's source. Replaces the retired flat `messages.task_*` "message IS task"
 *  projection. */
type MessageRowWithLinkedTask = MessageRow & LinkedTaskProjectionRow;

/** The joined `tasks` columns projected alongside a message row via
 *  `tasks.source_message_id == messages.id`. All null when the message is not a
 *  task's source. Shared across every message read path that carries
 *  `linked_task` (message-repo, saved-message-repo, agent-read) — pair it with
 *  {@link LINKED_TASK_SELECT} / {@link LINKED_TASK_JOINS} in the query and
 *  {@link linkedTaskFromRow} in the mapper so the projection never drifts. */
export interface LinkedTaskProjectionRow {
  lt_id: string | null;
  lt_task_number: number | null;
  lt_title: string | null;
  lt_status: TaskStatus | null;
  lt_assignee_agent_id: string | null;
  lt_assignee_user_id: string | null;
  lt_assignee_agent_name: string | null;
  lt_assignee_user_name: string | null;
}

/** SELECT-list fragment for the linked-task projection. Assumes the joined
 *  message table is aliased `m` and the joins from {@link LINKED_TASK_JOINS}
 *  are in scope (`lt` / `lta` / `ltu`). */
export const LINKED_TASK_SELECT = `lt.id AS lt_id, lt.task_number AS lt_task_number,
       lt.title AS lt_title, lt.status AS lt_status,
       lt.assignee_agent_id AS lt_assignee_agent_id,
       lt.assignee_user_id AS lt_assignee_user_id,
       lta.display_name AS lt_assignee_agent_name,
       ltu.display_name AS lt_assignee_user_name`;

/** LEFT JOINs that back {@link LINKED_TASK_SELECT}. Assumes the message table
 *  is aliased `m`. */
export const LINKED_TASK_JOINS = `LEFT JOIN tasks lt ON lt.source_message_id = m.id
       LEFT JOIN agents lta ON lta.id = lt.assignee_agent_id
       LEFT JOIN users ltu ON ltu.id = lt.assignee_user_id`;

/** Build the `LinkedTaskDto` from a joined message+task row, or null when no
 *  task sources this message. Viewer-invariant (task facts only — no per-viewer
 *  capability rides MessageDto). */
export function linkedTaskFromRow(row: LinkedTaskProjectionRow): LinkedTaskDto | null {
  if (row.lt_id === null || row.lt_task_number === null || row.lt_status === null) {
    return null;
  }
  let assignee: TaskAssigneeDto | null = null;
  if (row.lt_assignee_agent_id) {
    assignee = {
      type: 'agent',
      id: row.lt_assignee_agent_id,
      name: row.lt_assignee_agent_name ?? row.lt_assignee_agent_id,
    };
  } else if (row.lt_assignee_user_id) {
    assignee = {
      type: 'user',
      id: row.lt_assignee_user_id,
      name: row.lt_assignee_user_name ?? row.lt_assignee_user_id,
    };
  }
  return {
    task_id: row.lt_id,
    task_number: row.lt_task_number,
    title: row.lt_title ?? '',
    status: row.lt_status,
    assignee,
  };
}

function messageRowWithLinkedTaskToDto(
  row: MessageRowWithLinkedTask,
  author: MessageAuthorDto | null,
): MessageDto {
  return messageRowToDto(row, { author, linkedTask: linkedTaskFromRow(row) });
}

export function messageRowToDto(
  row: MessageRow,
  opts: { author: MessageAuthorDto | null; linkedTask?: LinkedTaskDto | null },
): MessageDto {
  const metadata = row.metadata
    ? (JSON.parse(row.metadata) as Record<string, unknown>)
    : null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    from_kind: row.from_kind,
    from_agent_id: row.from_agent_id,
    from_user_id: row.from_user_id,
    // Server-resolved display author (null for system rows). Raw provenance
    // above is retained for self-identification / permission logic.
    author: opts.author,
    content: row.content,
    metadata,
    attachments: extractAttachmentSnapshots(metadata),
    // Reactions are a viewer-scoped enrichment loaded separately (read-model
    // loadReactionAggregates); the bare row→DTO mapping is viewer-neutral, so
    // it defaults to null and the read route fills it for the human/agent
    // viewer (docs/reactions-design.md §3.5).
    reactions: null,
    seq: decodeMessageSeq(row.seq),
    created_at: row.created_at,
    thread_root_id: row.thread_root_id,
    // The task linked to this message via its source provenance, or null. A
    // fresh insert (no join, no opts) is never a task source → null.
    linked_task: opts?.linkedTask ?? null,
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
      const parsedLabel = parseAttachmentLabel(
        (item as { label?: unknown }).label as string | undefined,
      );
      snapshots.push({
        id: a.id,
        filename: a.filename,
        size: a.size,
        content_type: a.content_type,
        // Preserve only a canonical stored label; a legacy/tampered/non-canonical
        // label is dropped (treated as absent → positional fallback, never
        // echoed) so it can never reach the agent-facing suffix.
        ...(parsedLabel
          ? { label: formatAttachmentLabel(parsedLabel.kind, parsedLabel.ordinal) }
          : {}),
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

/** Task-header fields for the stdin meta suffix (`task=#<n> status=<status>`),
 *  derived from a task system-event's own metadata (`task_create` / `task_claim`
 *  / `task_unclaim` / `task_status`). Null when the row is not a task system
 *  event. Replaces the retired flat `messages.task_*` columns as the stdin
 *  header source (v60): a task is a first-class aggregate, so the header rides
 *  the immutable system-event snapshot, not message columns. Uses the partial
 *  reader so legacy pre-enrichment rows still yield the number+status. */
export function extractTaskHeaderFromRow(
  row: { metadata: string | null },
): { task_number: number; task_status: TaskStatus } | null {
  const partial = readTaskSystemMetadataPartial(parseMessageMetadata(row.metadata));
  return partial
    ? { task_number: partial.task_number, task_status: partial.task_status }
    : null;
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

    let rows: MessageRowWithLinkedTask[];

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

    const authors = loadMessageAuthors(this.db, rows);
    return {
      messages: rows.map(r => messageRowWithLinkedTaskToDto(r, authors.get(r) ?? null)),
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
    const rows = prepareObserved<
        [string, ...string[]],
        { thread_root_id: string; reply_count: number }
      >(
        this.db,
        'messages.reply_counts_by_root',
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
   *  Carries ONLY optimistically-maintainable reply metadata (count, repliers,
   *  last-reply) — never per-viewer unread. Unread is server-scored and lives in
   *  the dedicated `GET /api/conversations/:id/unread` read-model
   *  (`streamUnreadForConversation`) that the chip + Threads list both read, so
   *  the same fact never sits in this optimistically-patched window cache. */
  replyBadgeSummariesByRoot(
    conversationId: string,
    rootMessageIds: readonly string[],
  ): Record<string, ReplyBadgeSummary> {
    const result: Record<string, ReplyBadgeSummary> = {};
    const uniqueRootIds = [...new Set(rootMessageIds)];
    if (uniqueRootIds.length === 0) return result;
    const placeholders = uniqueRootIds.map(() => '?').join(', ');
    const rows = prepareObserved<
        [string, ...string[]],
        { root_id: string; reply_count: number; last_reply_at: number }
      >(
        this.db,
        'messages.reply_badge_summaries_by_root',
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

    for (const row of rows) {
      const rep = repliersByRoot.get(row.root_id) ?? {
        repliers: [],
        total: 0,
      };
      result[row.root_id] = {
        reply_count: row.reply_count,
        last_reply_at: row.last_reply_at,
        repliers: rep.repliers,
        replier_total: rep.total,
      };
    }
    return result;
  }

  /** Inline thread reply-PREVIEW sidecar (#task:1746): for each root in
   *  `rootMessageIds` that has >= 1 non-system reply, the tail-3 most-recent
   *  replies, returned time-ASCending (oldest of the 3 first) for one-line
   *  inline display under the root. Keyed by root id; a root with no non-system
   *  reply is simply absent (the count-only chip covers it) — mirrors
   *  `replyBadgeSummariesByRoot`. Scoped to the passed root set.
   *
   *  Eligibility is the SAME predicate as `replyCountsByRoot`
   *  (`from_kind != 'system'`), so the preview set is a subset of that count and
   *  the two never diverge. Selection is by `seq` alone: `seq` is the immutable
   *  monotonic insert order (there is no message edit/delete write path), so the
   *  top-3 highest `seq` per root ARE the 3 most-recent replies — no
   *  message_id de-dup / "highest-seq-wins" arbitration, which would only mask
   *  the impossible same-id/different-seq state. READ-INERT: this reads message
   *  rows only; it advances no cursor and touches no observed/unread/follow
   *  state. Carries only label-level attachment metadata (count + first
   *  canonical label via `resolveAttachmentLabels`), never attachment bytes.
   *
   *  MIRRORED SELECTION (#task:1749): the renderer re-selects this same tail
   *  incrementally on the committed-message apply seam —
   *  `convergeReplyPreviewTail` + `pageDisplaysEligibleRoot`
   *  (apps/desktop/src/renderer/features/channels/projection-cache.ts). The tail
   *  *content* is single-sourced (both sides call the same shared normalizer /
   *  `resolveAttachmentLabels`), but the *selection* rule (eligibility
   *  `from_kind != 'system'`, seq-only ordering, `rn <= 3`) is a mirror, NOT one
   *  implementation. Changing any selection boundary here (count, eligibility,
   *  sort key) MUST change the renderer mirror in the same batch, or a self-sent
   *  reply's optimistic tail diverges from this cold read. To truly converge,
   *  lift the selection into a shared pure function — do not make the renderer
   *  read this SQL's result. */
  replyPreviewsByRoot(
    conversationId: string,
    rootMessageIds: readonly string[],
  ): Record<string, ThreadReplyPreviewRow[]> {
    const result: Record<string, ThreadReplyPreviewRow[]> = {};
    const uniqueRootIds = [...new Set(rootMessageIds)];
    if (uniqueRootIds.length === 0) return result;
    const placeholders = uniqueRootIds.map(() => '?').join(', ');
    const rows = prepareObserved<
        [string, ...string[]],
        {
          root_id: string;
          message_id: string;
          seq: number;
          from_kind: FromKind;
          from_agent_id: string | null;
          from_user_id: string | null;
          author_id: string | null;
          author_name: string | null;
          author_display_name: string | null;
          content: string;
          metadata: string | null;
        }
      >(
        this.db,
        'messages.reply_previews_by_root',
        // ROW_NUMBER picks the 3 highest-seq (most-recent) replies per root; the
        // outer ORDER re-sorts them seq-ASC for time-ascending display.
        `SELECT root_id, message_id, seq, from_kind, from_agent_id,
                from_user_id, author_id, author_name, author_display_name,
                content, metadata
           FROM (
             SELECT thread_root_id AS root_id,
                    id             AS message_id,
                    seq            AS seq,
                    from_kind      AS from_kind,
                    from_agent_id  AS from_agent_id,
                    from_user_id   AS from_user_id,
                    author_id      AS author_id,
                    author_name    AS author_name,
                    author_display_name AS author_display_name,
                    content        AS content,
                    metadata       AS metadata,
                    ROW_NUMBER() OVER (
                      PARTITION BY thread_root_id ORDER BY seq DESC
                    ) AS rn
               FROM messages
              WHERE conversation_id = ?
                AND thread_root_id IN (${placeholders})
                AND from_kind != 'system'
           )
          WHERE rn <= 3
          ORDER BY root_id, seq ASC`,
      )
      .all(conversationId, ...uniqueRootIds);

    // Resolve each reply's author to the SAME MessageAuthorDto as MessageDto
    // (#task:1791) in the shared two-query batch. These rows are non-system
    // (WHERE above), so the resolver never returns null; a legacy row with no
    // snapshot resolves to `unresolved` (id=null) — still a valid DTO the
    // renderer shows as a neutral placeholder, keeping the preview set a subset
    // of the reply count (no row is dropped for author reasons).
    const authorRows: MessageAuthorRow[] = rows.map(row => ({
      from_kind: row.from_kind,
      from_agent_id: row.from_agent_id,
      from_user_id: row.from_user_id,
      author_id: row.author_id,
      author_name: row.author_name,
      author_display_name: row.author_display_name,
    }));
    const authors = loadMessageAuthors(this.db, authorRows);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const snapshots = extractAttachmentSnapshotsFromRow(row);
      const preview: ThreadReplyPreviewRow = {
        message_id: row.message_id,
        seq: decodeMessageSeq(row.seq),
        // Non-system ⇒ never null (see the batch note above).
        author: authors.get(authorRows[i]!)!,
        // Normalized Markdown SOURCE excerpt (Option A, ruled #task:1746) via
        // the shared `normalizeThreadPreviewExcerpt` SSOT — whitespace-compact +
        // trim + cap, shared byte-for-byte with the live WS-merge producer
        // (#task:1745). NO Markdown stripping here (grammar-aware stripping is
        // renderer-owned presentation; the read model does not grow a MD parser).
        // Literal syntax may show; the renderer displays single-line as text.
        preview: normalizeThreadPreviewExcerpt(row.content),
        attachment_count: snapshots?.length ?? 0,
        // Canonical display label of the FIRST attachment (`Image #N` /
        // `File #N`) via the shared SSOT — resolved over the WHOLE list (the
        // positional fallback depends on sibling ordinals) then take the first.
        // Matches the body / stdin-suffix references; never the raw filename.
        first_attachment_label:
          snapshots && snapshots.length > 0
            ? resolveAttachmentLabels(snapshots)[0] ?? null
            : null,
      };
      (result[row.root_id] ??= []).push(preview);
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
    opts: { limit?: number; cursor?: string | null; filter?: ThreadsListFilter } = {},
  ): ChannelThreadsPage {
    const limit = Math.min(50, Math.max(1, opts.limit ?? 30));
    const cursor = opts.cursor ? decodeThreadsCursor(opts.cursor) : null;
    const followedUnreadOnly = opts.filter === 'followed-unread';

    // `?filter=followed-unread` (#task:1774): the SAME collection / projection /
    // keyset as the default "All" list, narrowed to roots the viewer FOLLOWS and
    // has unread replies in. Expressed as ONE extra correlated EXISTS on the
    // SHARED predicate (byte-identical to the header Threads dot), so All vs
    // Unread differ by exactly this clause — the ORDER BY / keyset below stay
    // identical for both, and the two datasets can never disagree about what
    // "followed ∩ unread" means. All rows here have `viewer_following = true`.
    const filterClause = followedUnreadOnly
      ? `AND EXISTS (
                 SELECT 1 FROM messages m
                  WHERE m.thread_root_id = root.id AND ${FOLLOWED_THREAD_UNREAD}
               )`
      : '';

    // Fetch one extra row to decide whether a next page exists without a
    // second COUNT query.
    const rows = prepareObserved<
        {
          conv: string;
          hasCursor: number;
          cursorAt: number;
          cursorSeq: number;
          limit: number;
          viewer?: string;
        },
        ThreadRootRow
      >(
        this.db,
        followedUnreadOnly
          ? 'messages.list_channel_threads.followed_unread'
          : 'messages.list_channel_threads',
        `SELECT
           root.id            AS root_message_id,
           ${THREAD_ROOT_AUTHOR_SELECT},
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
            WHERE conversation_id = @conv
              AND thread_root_id IS NOT NULL
              AND from_kind != 'system'
            GROUP BY thread_root_id
         ) agg
         JOIN messages lr
           ON lr.conversation_id = @conv
          AND lr.thread_root_id = agg.root_id
          AND lr.seq = agg.last_reply_seq
         JOIN messages root
           ON root.id = agg.root_id
          AND root.conversation_id = @conv
         WHERE (
                 @hasCursor = 0
                 OR lr.created_at < @cursorAt
                 OR (lr.created_at = @cursorAt AND root.seq < @cursorSeq)
               )
               ${filterClause}
         ORDER BY lr.created_at DESC, root.seq DESC
         -- SOURCE-FENCE (#task:1279): this total order is the AUTHORITY. The client
         -- mirror is compareThreadSummary (apps/desktop .../useChannelThreads.ts) --
         -- keep the two byte-identical: (last_reply_at DESC, root_seq DESC).
         LIMIT @limit`,
      )
      .all({
        conv: conversationId,
        hasCursor: cursor ? 1 : 0,
        cursorAt: cursor?.at ?? 0,
        cursorSeq: cursor?.seq ?? 0,
        limit: limit + 1,
        // Bound ONLY when the filter clause references @viewer — better-sqlite3
        // rejects a named param the prepared SQL does not use.
        ...(followedUnreadOnly ? { viewer: viewerUserId } : {}),
      });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const repliersByRoot = this.repliersForRoots(
      conversationId,
      pageRows.map(r => r.root_message_id),
    );

    // Per-viewer follow state (#task:1226). READ-ONLY w.r.t. delivery:
    // `viewer_following` only READS human `thread_followers` rows — it never
    // writes follow / wake / delivery state. Per-thread unread is NOT carried
    // here anymore: it lives in the dedicated conversation-unread read-model
    // (`streamUnreadForConversation`) that the chip + Threads list both read,
    // so the same server-scored fact never sits in two places.
    const rootIds = pageRows.map(r => r.root_message_id);
    const followedRoots = this.followedRootsForViewer(conversationId, rootIds, viewerUserId);

    // Resolve root authors in one batch (two queries total, shared with the
    // reply-preview / repliers loaders below via `loadMessageAuthors`), so a
    // hard-deleted root author still names itself from its snapshot.
    const rootAuthorRows = pageRows.map(rootAuthorRow);
    const rootAuthors = loadMessageAuthors(this.db, rootAuthorRows);

    const threads: ThreadSummary[] = pageRows.map((r, i) => {
      const rep = repliersByRoot.get(r.root_message_id) ?? {
        repliers: [],
        total: 0,
      };
      return {
        ...rowToThreadSummaryInvariant(
          r,
          rootAuthors.get(rootAuthorRows[i]!) ?? null,
          rep,
        ),
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

  /** S1 P2 (docs/projection-recovery-s1-v1.md §5/§6): the VIEWER-INVARIANT
   *  threads-list entry for ONE root — the single-row analogue of
   *  {@link listChannelThreads}'s per-row projection, MINUS the per-viewer
   *  `viewer_following` (barred from the broadcast frame, §3). Computed in the
   *  SAME write transaction as a reply insert so `reply_count` / `last_reply_*`
   *  include the just-inserted reply (authoritative, never a future-seq value) —
   *  mirrors {@link replyCountsByRoot}'s authority (`from_kind != 'system'`), so
   *  live == replay == cold-open. Returns `null` when the root has no non-system
   *  reply (nothing to place; the client then keeps its refetch fallback). The
   *  aggregation is the exact `(reply_count, last_reply_seq)` shape the list uses,
   *  scoped to this root, so the entry's keyset values `(last_reply_at, root_seq)`
   *  match the list's ordering by construction. */
  threadListEntryForRoot(
    conversationId: string,
    rootId: string,
  ): ThreadSummaryInvariant | null {
    const row = prepareObserved<[string, string, string, string], ThreadRootRow>(
        this.db,
        'messages.thread_list_entry_for_root',
        `SELECT
           root.id            AS root_message_id,
           ${THREAD_ROOT_AUTHOR_SELECT},
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
              AND thread_root_id = ?
              AND from_kind != 'system'
            GROUP BY thread_root_id
         ) agg
         JOIN messages lr
           ON lr.conversation_id = ?
          AND lr.thread_root_id = agg.root_id
          AND lr.seq = agg.last_reply_seq
         JOIN messages root
           ON root.id = agg.root_id
          AND root.conversation_id = ?`,
      )
      .get(conversationId, rootId, conversationId, conversationId);
    if (!row) return null;

    const rep = this.repliersForRoots(conversationId, [rootId]).get(rootId) ?? {
      repliers: [],
      total: 0,
    };
    return rowToThreadSummaryInvariant(
      row,
      resolveOneMessageAuthor(this.db, rootAuthorRow(row)),
      rep,
    );
  }

  /** Distinct repliers per root, most-recent first (up to 3) plus the full
   *  distinct count. Distinct identity is the STABLE snapshot `author_id`
   *  (#task:1791) — NOT the live FK — so multiple hard-deleted repliers (whose
   *  `from_agent_id`/`from_user_id` are all nulled by ON DELETE SET NULL) do NOT
   *  collapse into one NULL byline; each keeps its own snapshot identity. Each
   *  replier is the SAME server-resolved {@link MessageAuthorDto} as
   *  `MessageDto.author`, resolved in the shared two-query batch. Ordering is by
   *  the replier's most-recent reply (`MAX(seq)`), which — as SQLite's sole
   *  min/max aggregate — also selects the bare columns (live FK + snapshot name)
   *  from that most-recent row. Rows with no stable identity (legacy pre-snapshot
   *  deleted actor → `author_id` null → resolver returns `unresolved`, `id=null`)
   *  are skipped: they can't render an avatar and are non-aggregating, so
   *  `replier_total` counts identifiable repliers only (unchanged semantics). */
  private repliersForRoots(
    conversationId: string,
    rootIds: readonly string[],
  ): Map<string, { repliers: MessageAuthorDto[]; total: number }> {
    const result = new Map<
      string,
      { repliers: MessageAuthorDto[]; total: number }
    >();
    if (rootIds.length === 0) return result;
    const placeholders = rootIds.map(() => '?').join(', ');
    const rows = prepareObserved<
        [string, ...string[]],
        {
          root_id: string;
          from_kind: FromKind;
          from_agent_id: string | null;
          from_user_id: string | null;
          author_id: string | null;
          author_name: string | null;
          author_display_name: string | null;
          last_seq: number;
        }
      >(
        this.db,
        'messages.repliers_for_roots',
        // Group by the STABLE author_id (survives delete); the bare live-FK and
        // snapshot-name columns come from the MAX(seq) row (SQLite's documented
        // "bare columns follow the single min/max aggregate" rule) so an active
        // replier resolves to its CURRENT identity and a deleted one to its most
        // recent send-time snapshot.
        `SELECT thread_root_id AS root_id,
                from_kind      AS from_kind,
                from_agent_id  AS from_agent_id,
                from_user_id   AS from_user_id,
                author_id      AS author_id,
                author_name    AS author_name,
                author_display_name AS author_display_name,
                MAX(seq)       AS last_seq
           FROM messages
          WHERE conversation_id = ?
            AND thread_root_id IN (${placeholders})
            AND from_kind != 'system'
          GROUP BY thread_root_id, from_kind, author_id
          ORDER BY last_seq DESC`,
      )
      .all(conversationId, ...rootIds);

    // Resolve every distinct-replier group to a MessageAuthorDto in the shared
    // batch (two queries total, deduped with the root/preview loaders).
    const authorRows: MessageAuthorRow[] = rows.map(row => ({
      from_kind: row.from_kind,
      from_agent_id: row.from_agent_id,
      from_user_id: row.from_user_id,
      author_id: row.author_id,
      author_name: row.author_name,
      author_display_name: row.author_display_name,
    }));
    const authors = loadMessageAuthors(this.db, authorRows);

    // Rows arrive globally seq-DESC; per-root relative order is preserved, so
    // accumulating in iteration order yields most-recent-first repliers.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const author = authors.get(authorRows[i]!) ?? null;
      // Skip unresolved (id=null): non-renderable + non-aggregating, matching
      // the prior legacy null-actor skip.
      if (!author || author.id === null) continue;
      let entry = result.get(row.root_id);
      if (!entry) {
        entry = { repliers: [], total: 0 };
        result.set(row.root_id, entry);
      }
      entry.total += 1;
      if (entry.repliers.length < 3) {
        entry.repliers.push(author);
      }
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
    const rows = prepareObserved<[string, string, ...string[]], { thread_root_id: string }>(
        this.db,
        'messages.followed_roots_for_viewer',
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
  ): MessageRowWithLinkedTask[] {
    return prepareObserved<
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
        MessageRowWithLinkedTask
      >(
        this.db,
        'messages.window_before_seq',
        `SELECT m.*, ${LINKED_TASK_SELECT}
           FROM (
             SELECT *
               FROM messages
              WHERE conversation_id = ?
                AND (? IS NULL OR seq < ?)
                AND ${streamScopePredicate()}
              ORDER BY seq DESC
              LIMIT ?
           ) m
          ${LINKED_TASK_JOINS}
          ORDER BY m.seq ASC`,
      )
      .all(
        conversationId,
        beforeSeq,
        beforeSeq,
        ...streamScopeParams(scope),
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
  ): MessageRowWithLinkedTask[] {
    if (limit <= 0) return [];
    return prepareObserved<
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
        MessageRowWithLinkedTask
      >(
        this.db,
        'messages.window_after_seq',
        `SELECT m.*, ${LINKED_TASK_SELECT}
           FROM messages m
           ${LINKED_TASK_JOINS}
          WHERE m.conversation_id = ?
            AND m.seq > ?
            AND ${streamScopePredicate('m.')}
          ORDER BY m.seq ASC
          LIMIT ?`,
      )
      .all(conversationId, afterSeq, ...streamScopeParams(scope), limit);
  }

  /** Fetch a single row by id, scoped to one conversation. Returns
   *  null when the id does not belong to the conversation; this is
   *  what gives `aroundMessageId` its 404 semantics. */
  private fetchById(
    conversationId: string,
    messageId: string,
    scope: WindowScope,
  ): MessageRowWithLinkedTask | null {
    const row = prepareObserved<
        [
          string,
          string,
          WindowScopeMode,
          WindowScopeMode,
          WindowScopeMode,
          string | null,
          string | null,
        ],
        MessageRowWithLinkedTask
      >(
        this.db,
        'messages.get_by_id_in_conversation',
        `SELECT m.*, ${LINKED_TASK_SELECT}
           FROM messages m
           ${LINKED_TASK_JOINS}
          WHERE m.conversation_id = ?
            AND m.id = ?
            AND ${streamScopePredicate('m.')}`,
      )
      .get(conversationId, messageId, ...streamScopeParams(scope));
    return row ?? null;
  }

  /** Resolve a message id to its seq within a specific conversation,
   *  or null when the id does not belong to that conversation. */
  private anchorSeqFor(
    conversationId: string,
    messageId: string,
    scope: WindowScope,
  ): number | null {
    const row = prepareObserved<
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
        this.db,
        'messages.anchor_seq_for_id',
        `SELECT seq FROM messages
          WHERE conversation_id = ? AND id = ?
            AND ${streamScopePredicate()}`,
      )
      .get(conversationId, messageId, ...streamScopeParams(scope));
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
              AND ${streamScopePredicate()}
            LIMIT 1`
        : `SELECT 1 AS found FROM messages
            WHERE conversation_id = ? AND seq > ?
              AND ${streamScopePredicate()}
            LIMIT 1`;
    return (
      prepareObserved<
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
        >(this.db, 'messages.exists_beyond_seq', sql)
        .get(conversationId, pivot, ...streamScopeParams(scope)) !== undefined
    );
  }

  getById(id: string): MessageDto | null {
    const row = prepareObserved<[string], MessageRowWithLinkedTask>(
        this.db,
        'messages.get_by_id',
        `SELECT m.*, ${LINKED_TASK_SELECT}
           FROM messages m
           ${LINKED_TASK_JOINS}
          WHERE m.id = ?`,
      )
      .get(id);
    return row
      ? messageRowWithLinkedTaskToDto(row, resolveOneMessageAuthor(this.db, row))
      : null;
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
    const row = prepareObserved<[string, string], MessageRowWithLinkedTask>(
        this.db,
        'messages.first_system_subtype_in_conversation',
        `SELECT m.*, ${LINKED_TASK_SELECT}
           FROM messages m
           ${LINKED_TASK_JOINS}
          WHERE m.conversation_id = ?
            AND m.from_kind = 'system'
            AND json_extract(m.metadata, '$.subtype') = ?
          ORDER BY m.seq ASC
          LIMIT 1`,
      )
      .get(conversationId, subtype);
    return row
      ? messageRowWithLinkedTaskToDto(row, resolveOneMessageAuthor(this.db, row))
      : null;
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
    /** Signal-only universe alignment (design doc §5.2): a TRUE value
     *  keeps this row OUT of the freshness universe — the stream head is
     *  not advanced, so agents are never CAS-blocked on it. Reserved for
     *  rows that are deliberately not delivered to every agent member
     *  (today: schedule_fire, an owner-scoped self-wake). Pairs with the
     *  `head <= seen` CAS relaxation: the exempt row's own delivery may
     *  push the recipient's observed PAST the head. */
    freshnessExempt?: boolean;
    /** The message this row is the mention CC copy OF (v71, §5). Set ONLY by
     *  the mention CC write, which runs inside the source message's own
     *  transaction; the partial UNIQUE `(cc_source_message_id, conversation_id)`
     *  turns a second copy per inbox into a constraint failure instead of a
     *  duplicate notification. */
    ccSourceMessageId?: string | null;
  }): MessageDto {
    return this.db.transaction(() => {
      const seq = this.reserveNextSeq(params.conversationId);
      const message = this.insertForConversationAtSeq(params, seq);
      // Stream-head maintenance invariant: every NON-EXEMPT insert
      // advances its stream's head (main when threadRootId is null), or
      // the head drifts behind messages.seq and the per-stream freshness
      // CAS misfires. Exempt rows deliberately leave the head behind —
      // they are outside the freshness universe (§5.2).
      if (params.freshnessExempt !== true) {
        this.bumpStreamHead(params.conversationId, params.threadRootId ?? null, seq);
      }
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
    const row = prepareObserved<[string], { latest_message_seq: number }>(
        this.db,
        'messages.latest_seq_for_conversation',
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
    const rows = this.fetchAfterSeq(
      conversationId,
      afterSeq,
      Math.max(1, limit),
      { mode: 'all' },
    );
    const authors = loadMessageAuthors(this.db, rows);
    return rows.map(r => messageRowWithLinkedTaskToDto(r, authors.get(r) ?? null));
  }

  /** Metadata-only stream window `(afterSeq, throughSeq]` (signal-only
   *  stale contract): the exact unseen set a freshness 409 refers to.
   *  Bounded above by the CAS-rejected `currentSeq` so the count/set is
   *  self-consistent with the 409's declared head. No bodies — bodies
   *  travel only through the normal delivery face. */
  listStreamWindowMeta(
    conversationId: string,
    threadRootId: string | null,
    afterSeq: number,
    throughSeq: number,
  ): Array<{
    id: string;
    seq: number;
    from_kind: string;
    from_agent_id: string | null;
  }> {
    return prepareObserved<
        [string, string | null, number, number],
        { id: string; seq: number; from_kind: string; from_agent_id: string | null }
      >(
        this.db,
        'messages.stream_window_meta',
        `SELECT id, seq, from_kind, from_agent_id
           FROM messages
          WHERE conversation_id = ?
            AND thread_root_id IS ?
            AND seq > ?
            AND seq <= ?
          ORDER BY seq ASC`,
      )
      .all(conversationId, threadRootId, afterSeq, throughSeq);
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
    const rows = prepareObserved<[string, string, number], MessageRowWithLinkedTask>(
        this.db,
        'messages.stream_below_seq',
        `SELECT m.*, ${LINKED_TASK_SELECT}
           FROM messages m
           ${LINKED_TASK_JOINS}
          WHERE m.conversation_id = ?
            AND m.thread_root_id IS ?
            AND m.seq < ?
          ORDER BY m.seq ASC`,
      )
      .all(conversationId, threadRootId, beforeSeq);
    const authors = loadMessageAuthors(this.db, rows);
    return rows.map(r => messageRowWithLinkedTaskToDto(r, authors.get(r) ?? null));
  }

  /** Fetch a message by id, scoped to one conversation. Returns null when
   *  the id does not belong to the conversation. Used by the send path to
   *  resolve a `--reply-to` target into its thread root. */
  getInConversation(
    conversationId: string,
    messageId: string,
  ): MessageDto | null {
    const row = this.fetchById(conversationId, messageId, { mode: 'all' });
    return row
      ? messageRowWithLinkedTaskToDto(row, resolveOneMessageAuthor(this.db, row))
      : null;
  }

  private reserveNextSeq(conversationId: string): number {
    const changed = prepareObserved<[string]>(
        this.db,
        'messages.reserve_next_seq',
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
    const row = prepareObserved<[string, string | null], { latest_seq: number }>(
        this.db,
        'messages.stream_head_latest_seq',
        `SELECT latest_seq FROM conversation_stream_heads
          WHERE conversation_id = ? AND thread_root_id IS ?`,
      )
      .get(conversationId, threadRootId);
    return row?.latest_seq ?? 0;
  }

  /** Every stream head in a conversation — the mainline row (`thread_root_id`
   *  NULL) plus one row per thread that has messages. Used to seed a new
   *  member's per-stream read baseline across ALL streams at join time
   *  (#task:1404): the mainline roll-up cursor is not enough because the
   *  thread-chip read model (`streamUnreadForConversation`) is follow-agnostic
   *  and would surface pre-join thread replies as `+n new` for a member with no
   *  thread cursors. */
  listStreamHeads(
    conversationId: string,
  ): Array<{ threadRootId: string | null; latestSeq: number }> {
    return prepareObserved<[string], { thread_root_id: string | null; latest_seq: number }>(
        this.db,
        'messages.list_stream_heads',
        `SELECT thread_root_id, latest_seq FROM conversation_stream_heads
          WHERE conversation_id = ?`,
      )
      .all(conversationId)
      .map(r => ({ threadRootId: r.thread_root_id, latestSeq: r.latest_seq }));
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
    const updated = prepareObserved<[number, string, string | null]>(
        this.db,
        'messages.bump_stream_head_update',
        `UPDATE conversation_stream_heads
            SET latest_seq = ?
          WHERE conversation_id = ? AND thread_root_id IS ?`,
      )
      .run(newSeq, conversationId, threadRootId).changes;
    if (updated === 0) {
      prepareObserved<[string, string | null, number]>(
          this.db,
          'messages.bump_stream_head_insert',
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
    // `latest_seq <= seen` (not `=`): freshness-exempt rows (§5.2, e.g.
    // schedule_fire) allocate seqs without bumping the head, and their
    // normal delivery legitimately advances the recipient's observed
    // cursor PAST the head. seen ≥ head still means "saw everything
    // freshness-relevant" — strictly more information, never less.
    const advanced = prepareObserved<[number, string, string | null, number]>(
        this.db,
        'messages.cas_stream_head_update',
        `UPDATE conversation_stream_heads
            SET latest_seq = ?
          WHERE conversation_id = ? AND thread_root_id IS ? AND latest_seq <= ?`,
      )
      .run(newSeq, conversationId, threadRootId, seenStreamSeq).changes;
    if (advanced === 1) return true;
    if (seenStreamSeq !== 0) return false;
    const inserted = prepareObserved<[string, string | null, number]>(
        this.db,
        'messages.cas_stream_head_insert',
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
    ccSourceMessageId?: string | null;
  }, seq: number): MessageDto {
    const id = newId();
    const now = Date.now();
    const mergedMetadata = mergeMetadataWithAttachments(
      params.metadata ?? null,
      params.attachments ?? null,
    );
    // Capture the send-time author snapshot from the live actor row so the
    // author stays identifiable after a hard delete (author_id has no FK, so
    // it survives ON DELETE SET NULL). System rows carry no snapshot.
    let authorId: string | null = null;
    let authorName: string | null = null;
    let authorDisplayName: string | null = null;
    if (params.fromKind === 'agent' && params.fromAgentId) {
      const a = prepareObserved<[string], { name: string; display_name: string }>(
          this.db,
          'messages.insert_author_agent',
          'SELECT name, display_name FROM agents WHERE id = ?',
        )
        .get(params.fromAgentId);
      if (a) {
        authorId = params.fromAgentId;
        authorName = a.name;
        authorDisplayName = a.display_name;
      }
    } else if (params.fromKind === 'user' && params.fromUserId) {
      const u = prepareObserved<[string], { name: string; display_name: string }>(
          this.db,
          'messages.insert_author_user',
          'SELECT name, display_name FROM users WHERE id = ?',
        )
        .get(params.fromUserId);
      if (u) {
        authorId = params.fromUserId;
        authorName = u.name;
        authorDisplayName = u.display_name;
      }
    }
    prepareObserved(
        this.db,
        'messages.insert_row',
        `INSERT INTO messages
         (id, conversation_id, from_kind, from_agent_id, from_user_id,
          content, metadata, seq, created_at, thread_root_id,
          author_id, author_name, author_display_name, cc_source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        authorId,
        authorName,
        authorDisplayName,
        params.ccSourceMessageId ?? null,
      );
    const row = prepareObserved<[string], MessageRow>(
        this.db,
        'messages.select_inserted_row',
        'SELECT * FROM messages WHERE id = ?',
      )
      .get(id);
    if (!row) throw new Error('message insert failed');
    return messageRowToDto(row, { author: resolveOneMessageAuthor(this.db, row) });
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

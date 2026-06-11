import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  AttachmentSnapshot,
  FromKind,
  MessageDto,
  MessageRow,
  TaskAssigneeDto,
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
    return this.listWindowForConversationScoped(conversationId, opts, null);
  }

  listWindowForThreadCluster(
    conversationId: string,
    threadRootId: string,
    opts: ListWindowOpts = {},
  ): MessageWindow {
    return this.listWindowForConversationScoped(conversationId, opts, threadRootId);
  }

  private listWindowForConversationScoped(
    conversationId: string,
    opts: ListWindowOpts,
    threadRootId: string | null,
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
        threadRootId,
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
        threadRootId,
      );
      const anchorRow = this.fetchById(
        conversationId,
        aroundMessageId,
        threadRootId,
      );
      const afterLimit = Math.max(
        0,
        limit - beforeRows.length - (anchorRow ? 1 : 0),
      );
      const afterRows = this.fetchAfterSeq(
        conversationId,
        anchorSeq,
        afterLimit,
        threadRootId,
      );
      rows = [...beforeRows, ...(anchorRow ? [anchorRow] : []), ...afterRows];
    } else if (afterSeq !== null) {
      rows = this.fetchAfterSeq(conversationId, afterSeq, limit, threadRootId);
    } else {
      // Both `latest` (beforeSeq === null) and explicit before_seq go
      // through the same DESC-then-ASC path; null acts as "no upper
      // bound", so the existing tail behaviour is preserved.
      rows = this.fetchBeforeSeq(conversationId, beforeSeq, limit, threadRootId);
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
        : this.existsWithSeq(conversationId, '<', minSeq, threadRootId);

    const hasMoreAfter =
      isLatest || maxSeq === null
        ? false
        : this.existsWithSeq(conversationId, '>', maxSeq, threadRootId);

    return {
      messages: rows.map(r => messageRowWithTaskAssigneeToDto(r)),
      has_more_before: hasMoreBefore,
      has_more_after: hasMoreAfter,
    };
  }

  /** Fetch up to `limit` rows with `seq < beforeSeq` (or the tail
   *  when `beforeSeq` is null), returned in seq ASC. Shared by
   *  `latest` / `before_seq` / `around_message_id` paths so all of
   *  them produce identically shaped joined rows. */
  private fetchBeforeSeq(
    conversationId: string,
    beforeSeq: number | null,
    limit: number,
    threadRootId: string | null,
  ): MessageRowWithTaskAssignee[] {
    return this.db
      .prepare<
        [
          string,
          number | null,
          number | null,
          string | null,
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
                AND (? IS NULL OR id = ? OR thread_root_id = ?)
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
        threadRootId,
        threadRootId,
        threadRootId,
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
    threadRootId: string | null,
  ): MessageRowWithTaskAssignee[] {
    if (limit <= 0) return [];
    return this.db
      .prepare<
        [string, number, string | null, string | null, string | null, number],
        MessageRowWithTaskAssignee
      >(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.seq > ?
            AND (? IS NULL OR m.id = ? OR m.thread_root_id = ?)
          ORDER BY m.seq ASC
          LIMIT ?`,
      )
      .all(conversationId, afterSeq, threadRootId, threadRootId, threadRootId, limit);
  }

  /** Fetch a single row by id, scoped to one conversation. Returns
   *  null when the id does not belong to the conversation; this is
   *  what gives `aroundMessageId` its 404 semantics. */
  private fetchById(
    conversationId: string,
    messageId: string,
    threadRootId: string | null,
  ): MessageRowWithTaskAssignee | null {
    const row = this.db
      .prepare<
        [string, string, string | null, string | null, string | null],
        MessageRowWithTaskAssignee
      >(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.id = ?
            AND (? IS NULL OR m.id = ? OR m.thread_root_id = ?)`,
      )
      .get(conversationId, messageId, threadRootId, threadRootId, threadRootId);
    return row ?? null;
  }

  /** Resolve a message id to its seq within a specific conversation,
   *  or null when the id does not belong to that conversation. */
  private anchorSeqFor(
    conversationId: string,
    messageId: string,
    threadRootId: string | null,
  ): number | null {
    const row = this.db
      .prepare<
        [string, string, string | null, string | null, string | null],
        { seq: number }
      >(
        `SELECT seq FROM messages
          WHERE conversation_id = ? AND id = ?
            AND (? IS NULL OR id = ? OR thread_root_id = ?)`,
      )
      .get(conversationId, messageId, threadRootId, threadRootId, threadRootId);
    return row?.seq ?? null;
  }

  /** Cheap "is there any row on the other side of `pivot`" probe.
   *  Used to populate `has_more_before` / `has_more_after`. */
  private existsWithSeq(
    conversationId: string,
    op: '<' | '>',
    pivot: number,
    threadRootId: string | null,
  ): boolean {
    const sql =
      op === '<'
        ? `SELECT 1 AS found FROM messages
            WHERE conversation_id = ? AND seq < ?
              AND (? IS NULL OR id = ? OR thread_root_id = ?)
            LIMIT 1`
        : `SELECT 1 AS found FROM messages
            WHERE conversation_id = ? AND seq > ?
              AND (? IS NULL OR id = ? OR thread_root_id = ?)
            LIMIT 1`;
    return (
      this.db
        .prepare<
          [string, number, string | null, string | null, string | null],
          { found: 1 }
        >(sql)
        .get(conversationId, pivot, threadRootId, threadRootId, threadRootId) !== undefined
    );
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
    return this.fetchAfterSeq(conversationId, afterSeq, Math.max(1, limit), null)
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
    const row = this.fetchById(conversationId, messageId, null);
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

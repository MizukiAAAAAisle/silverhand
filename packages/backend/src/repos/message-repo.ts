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
    task_number: row.task_number,
    task_status: row.task_status,
    task_title: row.task_title,
    task_workspace_id: row.task_workspace_id,
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
  if (!row.metadata) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
  return extractAttachmentSnapshots(parsed);
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
      const anchorSeq = this.anchorSeqFor(conversationId, aroundMessageId);
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
      );
      const anchorRow = this.fetchById(conversationId, aroundMessageId);
      const afterLimit = Math.max(
        0,
        limit - beforeRows.length - (anchorRow ? 1 : 0),
      );
      const afterRows = this.fetchAfterSeq(
        conversationId,
        anchorSeq,
        afterLimit,
      );
      rows = [...beforeRows, ...(anchorRow ? [anchorRow] : []), ...afterRows];
    } else if (afterSeq !== null) {
      rows = this.fetchAfterSeq(conversationId, afterSeq, limit);
    } else {
      // Both `latest` (beforeSeq === null) and explicit before_seq go
      // through the same DESC-then-ASC path; null acts as "no upper
      // bound", so the existing tail behaviour is preserved.
      rows = this.fetchBeforeSeq(conversationId, beforeSeq, limit);
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
        : this.existsWithSeq(conversationId, '<', minSeq);

    const hasMoreAfter =
      isLatest || maxSeq === null
        ? false
        : this.existsWithSeq(conversationId, '>', maxSeq);

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
  ): MessageRowWithTaskAssignee[] {
    return this.db
      .prepare<
        [string, number | null, number | null, number],
        MessageRowWithTaskAssignee
      >(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM (
             SELECT *
               FROM messages
              WHERE conversation_id = ?
                AND (? IS NULL OR seq < ?)
              ORDER BY seq DESC
              LIMIT ?
           ) m
          LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          ORDER BY m.seq ASC`,
      )
      .all(conversationId, beforeSeq, beforeSeq, limit);
  }

  /** Fetch up to `limit` rows with `seq > afterSeq`, returned in
   *  seq ASC. Used by `after_seq` and the post-anchor half of
   *  `around_message_id`. */
  private fetchAfterSeq(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): MessageRowWithTaskAssignee[] {
    if (limit <= 0) return [];
    return this.db
      .prepare<
        [string, number, number],
        MessageRowWithTaskAssignee
      >(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.seq > ?
          ORDER BY m.seq ASC
          LIMIT ?`,
      )
      .all(conversationId, afterSeq, limit);
  }

  /** Fetch a single row by id, scoped to one conversation. Returns
   *  null when the id does not belong to the conversation; this is
   *  what gives `aroundMessageId` its 404 semantics. */
  private fetchById(
    conversationId: string,
    messageId: string,
  ): MessageRowWithTaskAssignee | null {
    const row = this.db
      .prepare<[string, string], MessageRowWithTaskAssignee>(
        `SELECT m.*, aa.display_name AS task_assignee_name
           FROM messages m
           LEFT JOIN agents aa ON aa.id = m.task_assignee_agent_id
          WHERE m.conversation_id = ?
            AND m.id = ?`,
      )
      .get(conversationId, messageId);
    return row ?? null;
  }

  /** Resolve a message id to its seq within a specific conversation,
   *  or null when the id does not belong to that conversation. */
  private anchorSeqFor(
    conversationId: string,
    messageId: string,
  ): number | null {
    const row = this.db
      .prepare<[string, string], { seq: number }>(
        `SELECT seq FROM messages
          WHERE conversation_id = ? AND id = ?`,
      )
      .get(conversationId, messageId);
    return row?.seq ?? null;
  }

  /** Cheap "is there any row on the other side of `pivot`" probe.
   *  Used to populate `has_more_before` / `has_more_after`. */
  private existsWithSeq(
    conversationId: string,
    op: '<' | '>',
    pivot: number,
  ): boolean {
    const sql =
      op === '<'
        ? `SELECT 1 AS found FROM messages
            WHERE conversation_id = ? AND seq < ? LIMIT 1`
        : `SELECT 1 AS found FROM messages
            WHERE conversation_id = ? AND seq > ? LIMIT 1`;
    return (
      this.db
        .prepare<[string, number], { found: 1 }>(sql)
        .get(conversationId, pivot) !== undefined
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
  }): MessageDto {
    const id = newId();
    const now = Date.now();
    const seqRow = this.db
      .prepare<[string], { next_seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
           FROM messages
          WHERE conversation_id = ?`,
      )
      .get(params.conversationId);
    const seq = seqRow?.next_seq ?? 1;
    const mergedMetadata = mergeMetadataWithAttachments(
      params.metadata ?? null,
      params.attachments ?? null,
    );
    this.db
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, from_kind, from_agent_id, from_user_id,
          content, metadata, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

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
 *  outside the DTO mapper (e.g. the conversation-manager formatters that
 *  receive MessageRow from the inbox repo) want the typed list directly. */
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
    opts: { limit?: number; beforeSeq?: number | null } = {},
  ): MessageWindow {
    const limit = opts.limit ?? 200;
    const beforeSeq = opts.beforeSeq ?? null;
    const rows = this.db
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

    const minSeq = rows[0]?.seq ?? null;
    const hasMoreBefore =
      minSeq === null
        ? false
        : this.db
            .prepare<[string, number], { found: 1 }>(
              `SELECT 1 AS found
                 FROM messages
                WHERE conversation_id = ?
                  AND seq < ?
                LIMIT 1`,
            )
            .get(conversationId, minSeq) !== undefined;

    return {
      messages: rows.map(r => messageRowWithTaskAssigneeToDto(r)),
      has_more_before: hasMoreBefore,
    };
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

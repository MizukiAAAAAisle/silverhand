import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  AttachmentCreatorKind,
  AttachmentDto,
  AttachmentRow,
  AttachmentSnapshot,
  StorageKind,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

export interface InsertAttachmentInput {
  /** Channel-like conversation id (channel/dm_channel) — access boundary. */
  channelId: string;
  /** The conversation that originated this upload (channel or thread). */
  sourceConversationId: string | null;
  filename: string;
  size: number;
  contentType: string;
  storage: StorageKind;
  storageKey: string;
  createdByKind: AttachmentCreatorKind;
  createdById: string;
}

export class AttachmentRepo {
  constructor(private readonly db: Db) {}

  insert(input: InsertAttachmentInput): AttachmentDto {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO attachments
         (id, channel_id, source_conversation_id, filename, size, content_type,
          storage, storage_key, created_by_kind, created_by_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.sourceConversationId,
        input.filename,
        input.size,
        input.contentType,
        input.storage,
        input.storageKey,
        input.createdByKind,
        input.createdById,
        now,
      );
    const row = this.requireRow(id);
    return rowToDto(row);
  }

  getById(id: string): AttachmentRow | null {
    const row = this.db
      .prepare<[string], AttachmentRow>('SELECT * FROM attachments WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  /** Many-row variant for resolving message snapshots in a single query. */
  listByIds(ids: string[]): AttachmentRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db
      .prepare<string[], AttachmentRow>(
        `SELECT * FROM attachments WHERE id IN (${placeholders})`,
      )
      .all(...ids);
  }

  /** All blobs owned by a channel — used at channel-delete time so the
   *  application layer can sweep physical files (DB rows go via CASCADE). */
  listByChannel(channelId: string): AttachmentRow[] {
    return this.db
      .prepare<[string], AttachmentRow>(
        'SELECT * FROM attachments WHERE channel_id = ?',
      )
      .all(channelId);
  }

  /** True if any persisted message snapshot references this attachment id.
   *  Uses SQLite JSON1 to walk `metadata.attachments[*].id`. */
  isReferencedByMessage(id: string): boolean {
    const row = this.db
      .prepare<[string], { hit: number }>(
        `SELECT 1 AS hit
           FROM messages, json_each(json_extract(messages.metadata, '$.attachments'))
          WHERE json_extract(value, '$.id') = ?
          LIMIT 1`,
      )
      .get(id);
    return row !== undefined;
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  }

  private requireRow(id: string): AttachmentRow {
    const row = this.getById(id);
    if (!row) throw new Error(`attachment row missing after insert: ${id}`);
    return row;
  }
}

export function rowToDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    channel_id: row.channel_id,
    source_conversation_id: row.source_conversation_id,
    filename: row.filename,
    size: row.size,
    content_type: row.content_type,
    storage: row.storage,
    created_by_kind: row.created_by_kind,
    created_by_id: row.created_by_id,
    created_at: row.created_at,
  };
}

export function rowToSnapshot(row: AttachmentRow): AttachmentSnapshot {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    content_type: row.content_type,
  };
}

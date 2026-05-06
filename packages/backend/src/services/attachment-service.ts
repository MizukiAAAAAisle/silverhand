import type {
  AttachmentDto,
  AttachmentLocateDto,
  AttachmentRow,
  AttachmentSnapshot,
  ConversationKind,
  StorageKind,
} from '@silverhand/shared';
import {
  AttachmentRepo,
  rowToDto,
  rowToSnapshot,
} from '../repos/attachment-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type {
  BlobFileServeHeaders,
  BlobFileStorage,
  StoredFileRef,
} from '../storage/blob-file-storage.js';
import { BlobFileStorageError } from '../storage/blob-file-storage.js';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface AttachmentServiceOptions {
  storage: BlobFileStorage;
  attachments: AttachmentRepo;
  conversations: ConversationRepo;
  maxBytes?: number;
  /** Override for tests so `delete` can be stubbed cleanly. */
  now?: () => number;
}

export interface UploadInput {
  /** Conversation that received the upload (channel or thread). */
  sourceConversationId: string;
  filename: string;
  contentType: string | null;
  buffer: Buffer;
  /** Who uploaded — distinguishes user vs agent for audit. */
  createdByKind: 'user' | 'agent';
  createdById: string;
}

export type UploadFailure =
  | { kind: 'too_large'; size: number; max: number }
  | { kind: 'conversation_not_found' }
  | { kind: 'invalid_filename' }
  | { kind: 'invalid_buffer' };

export class AttachmentRejection extends Error {
  constructor(public readonly failure: UploadFailure) {
    super(describeFailure(failure));
    this.name = 'AttachmentRejection';
  }
}

function describeFailure(f: UploadFailure): string {
  switch (f.kind) {
    case 'too_large':
      return `attachment exceeds limit: ${f.size} > ${f.max} bytes`;
    case 'conversation_not_found':
      return 'conversation not found for attachment upload';
    case 'invalid_filename':
      return 'attachment filename is empty or invalid';
    case 'invalid_buffer':
      return 'attachment payload is empty';
  }
}

/**
 * Application layer that owns attachment business rules. The blob/file
 * storage infra below it is intentionally generic — only this service
 * knows about channels, threads, message snapshots, and access policy.
 */
export class AttachmentService {
  readonly maxBytes: number;
  private readonly storage: BlobFileStorage;
  private readonly attachments: AttachmentRepo;
  private readonly conversations: ConversationRepo;
  private readonly now: () => number;

  constructor(opts: AttachmentServiceOptions) {
    this.storage = opts.storage;
    this.attachments = opts.attachments;
    this.conversations = opts.conversations;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? (() => Date.now());
  }

  async upload(input: UploadInput): Promise<AttachmentDto> {
    if (input.buffer.length === 0) {
      throw new AttachmentRejection({ kind: 'invalid_buffer' });
    }
    if (input.buffer.length > this.maxBytes) {
      throw new AttachmentRejection({
        kind: 'too_large',
        size: input.buffer.length,
        max: this.maxBytes,
      });
    }
    const filename = sanitizeFilename(input.filename);
    if (!filename) {
      throw new AttachmentRejection({ kind: 'invalid_filename' });
    }

    const channelId = this.resolveChannelId(input.sourceConversationId);
    if (!channelId) {
      throw new AttachmentRejection({ kind: 'conversation_not_found' });
    }

    const contentType = detectContentType(input.contentType, input.buffer, filename);
    // Pre-allocate id so we can use it as the storage key — both stable
    // identifiers for the lifetime of the blob.
    const id = randomBlobId();
    const ref = await this.storage.put({
      namespace: `attachments/${channelId}`,
      id,
      filename,
      contentType,
      buffer: input.buffer,
    });

    const row = this.attachments.insert({
      channelId,
      sourceConversationId: input.sourceConversationId,
      filename,
      size: input.buffer.length,
      contentType,
      storage: ref.storage,
      storageKey: ref.storageKey,
      createdByKind: input.createdByKind,
      createdById: input.createdById,
    });
    return row;
  }

  /** Public download — caller has already passed channel-membership /
   *  viewer auth at the route layer. The storage backend streams. */
  async serve(id: string): Promise<Response | null> {
    const row = this.attachments.getById(id);
    if (!row) return null;
    return this.storage.serve(refOf(row), serveHeadersOf(row));
  }

  /** Internal locate — agent asks "where can I read this attachment?".
   *  Caller MUST verify the attachment's channel matches the agent's
   *  current conversation channel before returning. */
  async locateForAgent(
    attachmentId: string,
    callerConversationId: string,
  ): Promise<{ row: AttachmentRow; locate: AttachmentLocateDto } | null> {
    const row = this.attachments.getById(attachmentId);
    if (!row) return null;
    const callerChannelId = this.resolveChannelId(callerConversationId);
    if (callerChannelId !== row.channel_id) {
      // Cross-channel access: deny without leaking existence.
      return null;
    }
    if (row.storage === 'local') {
      const located = await this.storage.locate(refOf(row));
      if (!located) return null;
      return {
        row,
        locate: {
          storage: 'local',
          local_path: located.localPath,
          filename: row.filename,
          content_type: row.content_type,
        },
      };
    }
    // Remote storages return a download URL; the caller (chat-bridge) will
    // fetch + cache locally. The URL form is owned by the storage backend
    // when it lands.
    throw new BlobFileStorageError(
      'remote_locate_not_implemented',
      `locate for storage=${row.storage} not yet implemented`,
    );
  }

  /** Resolve an array of attachment ids → snapshots, validating that all
   *  belong to the destination channel. Returns either the snapshots or
   *  the first id that violated channel membership. */
  resolveSnapshotsForChannel(
    ids: string[],
    channelId: string,
  ): { ok: true; snapshots: AttachmentSnapshot[] } | { ok: false; offendingId: string } {
    if (ids.length === 0) return { ok: true, snapshots: [] };
    const rows = this.attachments.listByIds(ids);
    const found = new Map(rows.map(r => [r.id, r] as const));
    const snapshots: AttachmentSnapshot[] = [];
    for (const id of ids) {
      const row = found.get(id);
      if (!row || row.channel_id !== channelId) {
        return { ok: false, offendingId: id };
      }
      snapshots.push(rowToSnapshot(row));
    }
    return { ok: true, snapshots };
  }

  /** Channel-delete sweep: returns rows so the caller can remove the
   *  storage objects after the DB rows cascade. */
  async sweepForChannel(channelId: string): Promise<void> {
    const rows = this.attachments.listByChannel(channelId);
    await Promise.all(
      rows.map(async row => {
        try {
          await this.storage.delete(refOf(row));
        } catch {
          // Storage cleanup is best-effort — the DB CASCADE has already
          // removed the row by the time this runs.
        }
      }),
    );
  }

  /** Single-attachment delete, orphan-only.
   *
   *  Rejects when:
   *    - row missing → 'not_found'
   *    - the caller didn't upload it (user only deletes own uploads;
   *      agent-uploaded attachments are out of scope for this v1 path)
   *      → 'forbidden'
   *    - any persisted message snapshot still references it → 'in_use'
   *
   *  On success, deletes the DB row and best-effort removes the blob. */
  async deleteOrphan(
    id: string,
    viewer: { kind: 'user'; userId: string },
  ): Promise<
    | { ok: true }
    | { ok: false; error: 'not_found' | 'forbidden' | 'in_use' }
  > {
    const row = this.attachments.getById(id);
    if (!row) return { ok: false, error: 'not_found' };
    if (row.created_by_kind !== 'user' || row.created_by_id !== viewer.userId) {
      return { ok: false, error: 'forbidden' };
    }
    if (this.attachments.isReferencedByMessage(id)) {
      return { ok: false, error: 'in_use' };
    }
    this.attachments.deleteById(id);
    try {
      await this.storage.delete(refOf(row));
    } catch {
      // Best-effort: the row is already gone. A leaked blob will be
      // swept the next time the channel/workspace is deleted.
    }
    return { ok: true };
  }

  private resolveChannelId(conversationId: string): string | null {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;
    if (conv.kind === 'thread') {
      return conv.parent_conversation_id ?? null;
    }
    return isChannelLikeKind(conv.kind) ? conv.id : null;
  }
}

function isChannelLikeKind(kind: ConversationKind): boolean {
  return kind === 'channel' || kind === 'dm_channel';
}

function refOf(row: AttachmentRow): StoredFileRef {
  return { storage: row.storage, storageKey: row.storage_key };
}

function serveHeadersOf(row: AttachmentRow): BlobFileServeHeaders {
  return { filename: row.filename, contentType: row.content_type };
}

function randomBlobId(): string {
  // 22 base64url chars = 132 bits — more than enough collision space.
  const buf = Buffer.alloc(16);
  globalThis.crypto.getRandomValues(buf);
  return buf.toString('base64url');
}

const FILENAME_MAX = 255;

function sanitizeFilename(raw: string): string | null {
  // Strip path separators and control chars; cap at FILENAME_MAX bytes.
  const cleaned = raw
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1f]+/g, '')
    .trim()
    .slice(0, FILENAME_MAX);
  if (!cleaned) return null;
  return cleaned;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
  'application/zip': 'zip',
};

/** sniff order: explicit mime → magic bytes → extension map → fallback. */
export function detectContentType(
  explicit: string | null,
  buffer: Buffer,
  filename: string,
): string {
  if (explicit) {
    const norm = explicit.split(';')[0]?.trim().toLowerCase();
    if (norm && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(norm)) return norm;
  }
  const sniffed = sniffMagic(buffer);
  if (sniffed) return sniffed;
  const ext = extOf(filename);
  if (ext) {
    for (const [mime, mappedExt] of Object.entries(EXT_BY_CONTENT_TYPE)) {
      if (mappedExt === ext) return mime;
    }
  }
  return 'application/octet-stream';
}

function extOf(filename: string): string | null {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) return null;
  return filename.slice(idx + 1).toLowerCase();
}

function sniffMagic(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP
  if (
    buf.length >= 12
    && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  // PDF: %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }
  return null;
}

/** Helper for tests so they can craft ServiceFailure shapes without imports. */
export function attachmentRejection(failure: UploadFailure): AttachmentRejection {
  return new AttachmentRejection(failure);
}

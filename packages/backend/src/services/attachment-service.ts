import type {
  AttachmentDto,
  AttachmentLocateDto,
  AttachmentRefInput,
  AttachmentRow,
  AttachmentSnapshot,
  ConversationKind,
  StorageKind,
} from '@silverhand/shared';
import {
  isGenericMimeHint,
  mimeFromFilename,
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

  /** Public download with route-supplied ACL.
   *
   *  Missing rows and ACL denials are both folded to null so callers can
   *  return the same 404 shape and avoid an existence oracle. */
  async serveForViewer(
    id: string,
    canView: (row: AttachmentRow) => boolean,
  ): Promise<Response | null> {
    const row = this.attachments.getById(id);
    if (!row) return null;
    if (!canView(row)) return null;
    return this.storage.serve(refOf(row), serveHeadersOf(row));
  }

  /** Internal download after the caller has already resolved/authorized
   *  the row through `locateForAgent`. This keeps agent file-view fallback
   *  on the internal token surface instead of borrowing public user routes. */
  async serveForAgentLocated(row: AttachmentRow): Promise<Response | null> {
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
    // TODO(remote-blob): when s3/oss storage lands, return an
    // `AttachmentLocateDto` of `{ storage, download_url, filename,
    // content_type }` here instead of throwing, and wrap the agent
    // locate route (`routes/internal-agent.ts` agentLocateAttachment)
    // in a try/catch so this no longer surfaces as an uncaught 500.
    // Currently UNREACHABLE: the only wired storage is
    // `LocalBlobFileStorage` (kind='local'), so every uploaded row has
    // `storage='local'` and never reaches this branch. Audited #task:1133.
    throw new BlobFileStorageError(
      'remote_locate_not_implemented',
      `locate for storage=${row.storage} not yet implemented`,
    );
  }

  /** Resolve attachment refs (id + optional compose-time label) → snapshots,
   *  validating that all belong to the destination channel. The sender's label
   *  is stamped onto the snapshot (the label is a per-message-reference identity,
   *  not a property of the stored row). Returns either the snapshots or the
   *  first id that violated channel membership. */
  resolveSnapshotsForChannel(
    refs: AttachmentRefInput[],
    channelId: string,
  ): { ok: true; snapshots: AttachmentSnapshot[] } | { ok: false; offendingId: string } {
    if (refs.length === 0) return { ok: true, snapshots: [] };
    const rows = this.attachments.listByIds(refs.map(r => r.id));
    const found = new Map(rows.map(r => [r.id, r] as const));
    const snapshots: AttachmentSnapshot[] = [];
    for (const ref of refs) {
      const row = found.get(ref.id);
      if (!row || row.channel_id !== channelId) {
        return { ok: false, offendingId: ref.id };
      }
      const snapshot = rowToSnapshot(row);
      snapshots.push(
        ref.label !== undefined ? { ...snapshot, label: ref.label } : snapshot,
      );
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

/**
 * Recognise the canonical Content-Type for an upload.
 *
 * Order is fixed (see also `docs/cli-system.md` "Attachment MIME
 * contract" and `packages/shared/src/mime.ts`):
 *
 *   1. `explicit` — only if it carries useful information. Generic
 *      hints (`application/octet-stream`, empty, malformed) are
 *      treated as "no hint" because every common upload pipeline
 *      defaults to them; trusting them as authoritative would let
 *      `.html` files be permanently mis-typed as opaque binaries.
 *   2. Magic bytes — PNG/JPEG/GIF/WebP/PDF/ZIP. Sniffing always wins
 *      over suffix so a renamed `.txt` PNG still resolves to `image/png`.
 *   3. Suffix whitelist — text-like types with no stable magic
 *      (`.html/.htm/.svg/.json/.md/.txt/.csv`).
 *   4. Fallback `application/octet-stream`.
 */
export function detectContentType(
  explicit: string | null,
  buffer: Buffer,
  filename: string,
): string {
  if (!isGenericMimeHint(explicit)) {
    return explicit!.split(';')[0]!.trim().toLowerCase();
  }
  const sniffed = sniffMagic(buffer);
  if (sniffed) return sniffed;
  const fromSuffix = mimeFromFilename(filename);
  if (fromSuffix) return fromSuffix;
  return 'application/octet-stream';
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
  // ZIP: PK\x03\x04 (also covers .docx/.xlsx/.pptx; surface as zip for now).
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return 'application/zip';
  }
  return null;
}

/** Helper for tests so they can craft ServiceFailure shapes without imports. */
export function attachmentRejection(failure: UploadFailure): AttachmentRejection {
  return new AttachmentRejection(failure);
}

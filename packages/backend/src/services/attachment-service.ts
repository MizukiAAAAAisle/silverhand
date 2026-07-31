import type {
  AttachmentCreatorKind,
  AttachmentDto,
  AttachmentLocateDto,
  AttachmentRefInput,
  AttachmentRow,
  AttachmentSnapshot,
  ConversationKind,
} from '@silverhand/shared';
import {
  attachmentLabelKind,
  isGenericMimeHint,
  mimeFromFilename,
  parseAttachmentLabel,
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
}

export interface UploadInput {
  /** Channel-like conversation (channel/dm_channel) that received the upload; a reply-cluster upload shares its parent channel. */
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
  | { kind: 'invalid_buffer' }
  | { kind: 'content_type_mismatch'; expected: string; detected: string };

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
    case 'content_type_mismatch':
      return `attachment update payload type ${f.detected} does not match its locked content type ${f.expected}`;
  }
}

/** What a best-effort blob sweep actually did. Returned rather than logged so
 *  the caller can attribute the residue to its own delete (workspace / agent /
 *  computer) — the service has no logger and no idea whose sweep this is. */
export interface BlobSweepOutcome {
  attempted: number;
  failed: number;
  /** First storage error, for the caller's log line. */
  firstError?: unknown;
}

/** Best-effort maintenance outcome of a content update (pointer-swap). The
 *  authoritative update — the DB repoint — already succeeded when this is
 *  returned; these two are the post-commit tidy-up whose failure leaks a blob
 *  or leaves the stable alias resolving to the old bytes until the next locate
 *  self-heals, never corrupting state. Returned (not logged) because the
 *  service has no logger; the route adapter owns one and records a miss. */
export interface AttachmentUpdateMaintenance {
  /** The stable alias is CONFIRMED pointing at the new physical blob (the relink
   *  returned a local path). False on either a throw OR a `null` return (bytes
   *  absent / no local alias) — a resolved `null` is never read as confirmed. When
   *  false, the GC of the old blob is deliberately SKIPPED so the alias stays readable. */
  aliasRelinked: boolean;
  /** The old physical blob was GC'd (only attempted after a successful relink). */
  oldBlobDeleted: boolean;
  /** First relink/GC error, for the adapter's log line. */
  error?: unknown;
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

  constructor(opts: AttachmentServiceOptions) {
    this.storage = opts.storage;
    this.attachments = opts.attachments;
    this.conversations = opts.conversations;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
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
    // The physical blob key is a throwaway random id — deliberately NOT the
    // attachment id. The attachment id (assigned by the repo insert below) is
    // the stable identity; the physical key is free to move on every content
    // update (pointer-swap writes a fresh blob), while the stable local path is
    // held by a separate alias keyed on the attachment id (see `update`). The
    // two id-spaces never overlap, so the alias can never collide with a
    // physical key.
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

  /**
   * In-place content update, creator-only, via POINTER-SWAP.
   *
   * The whole point of this path is that the attachment id (and therefore the
   * reviewer's stable local address) stays fixed while the bytes change — an
   * agent iterating a mockup re-runs `file update` each round instead of
   * uploading a new id. No versioning, no history: the previous bytes are GC'd.
   *
   * Protocol (correctness-mandated — see `docs/attachments-design.md`):
   *   1. Write the new bytes at a FRESH blob key. Unreferenced by any row, so
   *      invisible to every reader until step 2.
   *   2. One atomic DB UPDATE repoints storage_key + size and bumps
   *      content_revision — the SOLE visibility switch. A crash before this
   *      commit leaves an unreferenced orphan (row still on old bytes); a crash
   *      after leaves the row cleanly on the new bytes. Never a durable
   *      failed-write-that-took-effect.
   *   3. Eager alias relink so an already-open zero-copy viewer refreshes.
   *   4. GC the old blob — best-effort, ONLY after the alias is confirmed on the
   *      new bytes. A failed relink SKIPS the GC so the alias keeps resolving to
   *      the old blob (readable-stale) rather than dangling; the next locate
   *      self-heals. The relink/GC outcome is returned for the adapter to log.
   *
   * `filename` and `content_type` are LOCKED (identity + type never drift from a
   * message snapshot) — and the lock is ENFORCED, not just assumed: the new
   * payload is magic-sniffed and must be the same binary family as the stored
   * type, so an update can refresh a PNG mockup but can't smuggle PDF/HTML bytes
   * into a slot the renderer will decode as `image/png`. The caller's declared
   * content type is never trusted for this — only the bytes. A real type change
   * means a new attachment. The caller is responsible for the membership +
   * creator ACL (`canUpdateAttachment`); the creator re-check here is
   * defense-in-depth. `opts.requireCallerChannelOf` scopes the update to the
   * caller's own channel (the agent path, whose membership is
   * conversation-derived rather than channel-explicit) — a mismatch folds to
   * `not_found` so it never leaks existence across channels, mirroring
   * {@link locateForAgent}. Byte validation mirrors `upload` (throws
   * `AttachmentRejection`, including the type-mismatch reject).
   */
  async update(
    attachmentId: string,
    buffer: Buffer,
    updater: { kind: AttachmentCreatorKind; id: string },
    opts: { requireCallerChannelOf?: string } = {},
  ): Promise<
    | { ok: true; dto: AttachmentDto; maintenance: AttachmentUpdateMaintenance }
    | { ok: false; error: 'not_found' | 'forbidden' }
  > {
    if (buffer.length === 0) {
      throw new AttachmentRejection({ kind: 'invalid_buffer' });
    }
    if (buffer.length > this.maxBytes) {
      throw new AttachmentRejection({
        kind: 'too_large',
        size: buffer.length,
        max: this.maxBytes,
      });
    }

    const row = this.attachments.getById(attachmentId);
    if (!row) return { ok: false, error: 'not_found' };
    if (opts.requireCallerChannelOf !== undefined) {
      // Agent path: only attachments in the caller's own channel are reachable.
      const callerChannelId = this.resolveChannelId(opts.requireCallerChannelOf);
      if (callerChannelId !== row.channel_id) return { ok: false, error: 'not_found' };
    }
    if (row.created_by_kind !== updater.kind || row.created_by_id !== updater.id) {
      return { ok: false, error: 'forbidden' };
    }

    // Content type is LOCKED and ENFORCED: the new payload must be the same
    // magic family as the stored type (sniffed from the BYTES, never the
    // caller's declared type). Rejects before any blob is written.
    assertPayloadMatchesLockedType(buffer, row.content_type);

    // 1) New bytes at a fresh key — unreferenced, invisible until the commit.
    const oldRef = refOf(row);
    const newRef = await this.storage.put({
      namespace: `attachments/${row.channel_id}`,
      id: randomBlobId(),
      filename: row.filename, // locked
      contentType: row.content_type, // locked
      buffer,
    });

    // 2) The sole visibility switch. If it fails/crashes, newRef is an orphan.
    let revision: number | null;
    try {
      revision = this.attachments.repointContent(attachmentId, {
        storageKey: newRef.storageKey,
        size: buffer.length,
      });
    } catch (err) {
      await this.storage.delete(newRef).catch(() => {});
      throw err;
    }
    if (revision === null) {
      // Row vanished (concurrent delete) between the read and the repoint — the
      // new blob is an orphan; drop it and report gone.
      await this.storage.delete(newRef).catch(() => {});
      return { ok: false, error: 'not_found' };
    }

    // 3) Eager alias relink. Best-effort, but its result GATES the GC below:
    //    a relink that did NOT confirm the new bytes leaves the alias resolving
    //    to the old blob, so we must NOT delete that blob (it'd dangle) — keep
    //    it readable-stale until the next locate self-heals. "Did not confirm"
    //    is BOTH a throw AND a `null` return: `materializeAlias`'s contract is
    //    `{localPath} | null`, and `null` means the physical bytes are absent /
    //    the backend has no local alias — fail closed on it exactly like a
    //    throw, never read a resolved `null` as "confirmed on the new bytes".
    //    The outcome is surfaced, never swallowed.
    let maintenanceError: unknown;
    const aliasRelinked = await this.storage
      .materializeAlias(newRef, row.id)
      .then(located => located !== null)
      .catch((err: unknown) => {
        maintenanceError = err;
        return false;
      });

    // 4) GC the old blob — ONLY after a confirmed relink, and only if the key
    //    actually moved. A failure here leaks a blob, never corrupts state.
    let oldBlobDeleted = false;
    if (aliasRelinked && oldRef.storageKey !== newRef.storageKey) {
      try {
        await this.storage.delete(oldRef);
        oldBlobDeleted = true;
      } catch (err) {
        maintenanceError ??= err;
      }
    }

    const updated = this.attachments.getById(attachmentId);
    if (!updated) return { ok: false, error: 'not_found' };
    return {
      ok: true,
      dto: rowToDto(updated),
      maintenance: {
        aliasRelinked,
        oldBlobDeleted,
        ...(maintenanceError !== undefined ? { error: maintenanceError } : {}),
      },
    };
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
      // Return the STABLE alias path, not the raw physical path. The physical
      // key moves on every content update (pointer-swap), but the embedded CLI
      // handed this path to a viewer that expects it fixed — the alias keeps it
      // so the reviewer's local address survives every mockup iteration. Lazy +
      // self-healing: created on first locate, repointed on update.
      const located = await this.storage.materializeAlias(refOf(row), row.id);
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
   *  validating that all belong to the destination channel AND that a declared
   *  label kind (`Image`/`File`) matches the row's real content type — the
   *  label is agent-visible, so a `{pdf, "Image #1"}` claim is a trust-boundary
   *  lie, not a renderer concern. The sender's label is stamped onto the
   *  snapshot (a per-message-reference identity, not a property of the stored
   *  row). Returns the snapshots, or the first id that violated a rule with a
   *  discriminated reason. */
  resolveSnapshotsForChannel(
    refs: AttachmentRefInput[],
    channelId: string,
  ):
    | { ok: true; snapshots: AttachmentSnapshot[] }
    | { ok: false; offendingId: string; reason: 'outside_channel' | 'label_kind_mismatch' } {
    if (refs.length === 0) return { ok: true, snapshots: [] };
    const rows = this.attachments.listByIds(refs.map(r => r.id));
    const found = new Map(rows.map(r => [r.id, r] as const));
    const snapshots: AttachmentSnapshot[] = [];
    for (const ref of refs) {
      const row = found.get(ref.id);
      if (!row || row.channel_id !== channelId) {
        return { ok: false, offendingId: ref.id, reason: 'outside_channel' };
      }
      if (ref.label !== undefined) {
        // ref.label is wire-validated to the canonical form, so parse is
        // non-null; reject when the declared kind contradicts the real type.
        const parsed = parseAttachmentLabel(ref.label);
        if (!parsed || parsed.kind !== attachmentLabelKind(row.content_type)) {
          return { ok: false, offendingId: ref.id, reason: 'label_kind_mismatch' };
        }
      }
      const snapshot = rowToSnapshot(row);
      snapshots.push(
        ref.label !== undefined ? { ...snapshot, label: ref.label } : snapshot,
      );
    }
    return { ok: true, snapshots };
  }

  /**
   * The storage objects a channel delete must remove, captured while the
   * `attachments` rows still exist.
   *
   * SYNCHRONOUS and read-only on purpose: a caller that deletes its rows inside
   * a `db.transaction` (delete-computer's cascade) has to capture the refs
   * BEFORE the commit, because after the FK cascade there is no row left to
   * derive a `storageKey` from — a post-commit `listByChannel` returns empty and
   * the blobs leak forever. Pair it with {@link deleteBlobs} after the commit.
   */
  collectChannelBlobRefs(channelIds: readonly string[]): StoredFileRef[] {
    const refs: StoredFileRef[] = [];
    for (const channelId of channelIds) {
      for (const row of this.attachments.listByChannel(channelId)) {
        refs.push(refOf(row));
      }
    }
    return refs;
  }

  /** Remove captured storage objects. Best-effort by contract: the DB rows are
   *  already gone (or about to be), so a storage failure must never reverse the
   *  delete — it leaves a leaked blob, not a dangling row.
   *
   *  Best-effort is not the same as unobservable: a swallowed failure means bytes
   *  stay on disk with no row left to name them, so the outcome is RETURNED
   *  (attempted/failed + the first error) and the caller — which owns a logger —
   *  reports it. Never throws. */
  async deleteBlobs(refs: readonly StoredFileRef[]): Promise<BlobSweepOutcome> {
    const errors: unknown[] = [];
    await Promise.all(
      refs.map(async ref => {
        try {
          await this.storage.delete(ref);
        } catch (err) {
          // Best-effort — see the contract above; counted, not rethrown.
          errors.push(err);
        }
      }),
    );
    return {
      attempted: refs.length,
      failed: errors.length,
      ...(errors.length > 0 ? { firstError: errors[0] } : {}),
    };
  }

  /** Channel-delete sweep for callers whose rows still exist at call time
   *  (single-object deletes). Capture-then-delete in one step; a transactional
   *  caller must split the two halves around its commit instead. */
  async sweepForChannel(channelId: string): Promise<BlobSweepOutcome> {
    return this.deleteBlobs(this.collectChannelBlobRefs([channelId]));
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
      // Drop the stable alias too so it doesn't dangle. Symlink-only, so this
      // never affected the physical blob's lifecycle — purely tidy-up.
      await this.storage.deleteAlias(refOf(row), row.id);
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

/**
 * Enforce the content-type lock on a content update: the new payload must be
 * the same MAGIC FAMILY as the attachment's stored (locked) type, decided from
 * the BYTES — the caller's declared type is never consulted, since trusting it
 * is exactly the impersonation vector (`--content-type image/png` + PDF bytes).
 *
 * The families are the ones {@link sniffMagic} can assert: png/jpeg/gif/webp/
 * pdf are their own family; every zip container (`application/zip`, `*+zip`,
 * OpenXML/OpenDocument office types) is the `zip` family, so a real docx→docx
 * update passes while docx→png is rejected. A magic-backed binary slot is
 * FAIL-CLOSED: an unrecognizable payload (no magic) landing in an image/pdf/zip
 * slot is rejected, not waved through as "same type". text-like / octet slots
 * have no magic to compare, so a text↔text swap is allowed (an acknowledged
 * residual — bytes can't disambiguate `text/markdown` from `text/plain`); only
 * a DEFINITE binary family sniffed into such a slot is rejected.
 */
function assertPayloadMatchesLockedType(buffer: Buffer, lockedType: string): void {
  const sniffed = sniffMagic(buffer);
  const detectedFamily = sniffed === 'application/zip' ? 'zip' : sniffed;
  const expectedFamily = expectedMagicFamily(lockedType);
  const compatible =
    expectedFamily !== null
      ? detectedFamily === expectedFamily // binary slot: must match, fail-closed on null
      : detectedFamily === null; // text/octet slot: reject a definite binary family
  if (!compatible) {
    throw new AttachmentRejection({
      kind: 'content_type_mismatch',
      expected: lockedType,
      detected: sniffed ?? 'unrecognized',
    });
  }
}

/** The magic family a stored content type is expected to sniff to, or null when
 *  the type has no stable magic (text-like, octet-stream, legacy OLE office). */
function expectedMagicFamily(contentType: string): string | null {
  switch (contentType) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
    case 'application/pdf':
      return contentType;
  }
  if (
    contentType === 'application/zip'
    || contentType.endsWith('+zip')
    || contentType.startsWith('application/vnd.openxmlformats-officedocument.')
    || contentType.startsWith('application/vnd.oasis.opendocument.')
  ) {
    return 'zip';
  }
  return null;
}

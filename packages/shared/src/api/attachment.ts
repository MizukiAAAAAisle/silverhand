// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: attachment. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  AttachmentCreatorKindSchema,
  StorageKindSchema,
} from '../db/schema.js';

//
// Two shapes:
//   - AttachmentDto: full row, returned by upload/get-by-id endpoints.
//   - AttachmentSnapshot: the immutable subset embedded into a message
//     when the message references the attachment. Lives under
//     `metadata.attachments` so renderers can render image/file cells
//     without an extra round-trip.
//
// No de-duplication: every upload creates a new row + new blob, so the
// snapshot/source row never drift.

export const AttachmentDtoSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  source_conversation_id: z.string().nullable(),
  filename: z.string(),
  size: z.number(),
  content_type: z.string(),
  storage: StorageKindSchema,
  created_by_kind: AttachmentCreatorKindSchema,
  created_by_id: z.string(),
  created_at: z.number(),
});
export type AttachmentDto = z.infer<typeof AttachmentDtoSchema>;

// ── Attachment display label (`Image #N` / `File #N`) ──────────────────────
//
// The label is rendered VERBATIM into the agent-facing stdin suffix, so it is
// untrusted-content territory: an unconstrained string would be a prompt-
// injection / suffix-forgery surface (a `\n`-bearing label could forge a second
// attachment line pointing at a fake id). It is therefore constrained to a
// canonical closed form at every boundary — the wire (400 on violation), the
// stored snapshot, and the read path (`extractAttachmentSnapshots` drops a
// non-canonical legacy/tampered label rather than echoing it).

export type AttachmentLabelKind = 'Image' | 'File';

/** The one canonical label form. Digits capped at 4 (≤ `#9999`) to bound length
 *  — a message carries at most 20 attachments, so this is slack, not a limit. */
export const ATTACHMENT_LABEL_PATTERN = /^(Image|File) #([1-9]\d{0,3})$/;

export const AttachmentLabelSchema = z
  .string()
  .trim()
  .regex(ATTACHMENT_LABEL_PATTERN, 'label must be "Image #N" or "File #N"');

/** The label kind for a content-type (`Image` for `image/*`, else `File`). */
export function attachmentLabelKind(contentType: string): AttachmentLabelKind {
  return contentType.startsWith('image/') ? 'Image' : 'File';
}

/** True when a content-type denotes an image. */
export function isImageAttachment(contentType: string): boolean {
  return attachmentLabelKind(contentType) === 'Image';
}

/** The single generator of the label form — composer, resolver fallback, and
 *  tests build labels through this so they never drift from the pattern. */
export function formatAttachmentLabel(
  kind: AttachmentLabelKind,
  ordinal: number,
): string {
  return `${kind} #${ordinal}`;
}

/** Parse a canonical label into kind + ordinal, or null if it is not the
 *  canonical form. Defensive: callers treat a non-canonical label as absent
 *  rather than trusting it. */
export function parseAttachmentLabel(
  label: string | null | undefined,
): { kind: AttachmentLabelKind; ordinal: number } | null {
  if (typeof label !== 'string') return null;
  const m = ATTACHMENT_LABEL_PATTERN.exec(label.trim());
  return m ? { kind: m[1] as AttachmentLabelKind, ordinal: Number(m[2]) } : null;
}

/** Minimal immutable subset embedded into a message's metadata. */
export const AttachmentSnapshotSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  content_type: z.string(),
  /** Sender-assigned display identity captured at compose time (canonical
   *  `Image #N` / `File #N`). Stable per attachment instance from paste through
   *  send, so a body reference the user typed never renumbers on the receiver.
   *  Carried verbatim; the backend echoes it, never recomputes. Absent for
   *  bare-id callers (agent CLI `--attachment <id>`, daemon relay) that have no
   *  compose-time labelling — those fall back to a positional label derived by
   *  `resolveAttachmentLabels`. */
  label: AttachmentLabelSchema.optional(),
});
export type AttachmentSnapshot = z.infer<typeof AttachmentSnapshotSchema>;

/** One attachment reference in a send payload. The id is the sole required
 *  handle; `label` is the compose-time display identity when the sender has
 *  one (the composer), omitted by bare-id callers (agent CLI / daemon). The
 *  wire accepts either a bare id string or this object (see
 *  `MessageAttachmentIdsInputSchema`); both normalize to this shape at the
 *  route boundary via `normalizeAttachmentRefs`. */
export const AttachmentRefInputSchema = z.object({
  id: z.string().min(1),
  label: AttachmentLabelSchema.optional(),
});
export type AttachmentRefInput = z.infer<typeof AttachmentRefInputSchema>;

/** Normalize a wire attachment list (mixed bare ids / {id,label} refs) into a
 *  uniform ref list. The union lives only at the wire edge; internal code sees
 *  one shape. */
export function normalizeAttachmentRefs(
  input: ReadonlyArray<string | AttachmentRefInput> | null | undefined,
): AttachmentRefInput[] {
  if (!input) return [];
  return input.map(entry =>
    typeof entry === 'string'
      ? { id: entry }
      : entry.label !== undefined
        ? { id: entry.id, label: entry.label }
        : { id: entry.id },
  );
}

/** Effective display label for each attachment, aligned to the input order.
 *  A valid stored label is emitted verbatim (never renumbered); the rest get a
 *  positional `Image #N` / `File #N` fallback that is guaranteed NOT to collide
 *  with any stored ordinal in the same kind (a mixed labeled+unlabeled list —
 *  a compatibility / read-path case — must never emit two identical labels).
 *  A non-canonical stored label is treated as absent. Single source of truth
 *  shared by the agent-facing stdin suffix and the renderer chip. Pure. */
export function resolveAttachmentLabels(
  attachments: ReadonlyArray<Pick<AttachmentSnapshot, 'label' | 'content_type'>>,
): string[] {
  // Pass 1: reserve every ordinal a valid stored label already occupies, per
  // kind, so positional fallbacks below never collide with a stored label.
  const used: Record<AttachmentLabelKind, Set<number>> = {
    Image: new Set(),
    File: new Set(),
  };
  const stored = attachments.map(a => {
    const parsed = parseAttachmentLabel(a.label);
    if (parsed) used[parsed.kind].add(parsed.ordinal);
    return parsed;
  });
  // Pass 2: emit a valid stored label verbatim; otherwise assign the next
  // ordinal in the attachment's own kind that is not already taken.
  const next: Record<AttachmentLabelKind, number> = { Image: 1, File: 1 };
  return attachments.map((a, i) => {
    const parsed = stored[i];
    if (parsed) return formatAttachmentLabel(parsed.kind, parsed.ordinal);
    const kind = attachmentLabelKind(a.content_type);
    while (used[kind].has(next[kind])) next[kind] += 1;
    const ordinal = next[kind];
    used[kind].add(ordinal);
    next[kind] += 1;
    return formatAttachmentLabel(kind, ordinal);
  });
}

/** Upload endpoint response — same shape as AttachmentDto today. */
export const AttachmentUploadResponseSchema = AttachmentDtoSchema;
export type AttachmentUploadResponse = z.infer<typeof AttachmentUploadResponseSchema>;

/** `silverhand file view` locate response. */
export const AttachmentLocateDtoSchema = z.union([
  z.object({
    storage: z.literal('local'),
    local_path: z.string(),
    filename: z.string(),
    content_type: z.string(),
  }),
  z.object({
    storage: z.enum(['s3', 'oss']),
    download_url: z.string(),
    filename: z.string(),
    content_type: z.string(),
  }),
]);
export type AttachmentLocateDto = z.infer<typeof AttachmentLocateDtoSchema>;

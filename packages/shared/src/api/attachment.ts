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

/** Minimal immutable subset embedded into a message's metadata. */
export const AttachmentSnapshotSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  content_type: z.string(),
  /** Sender-assigned display identity captured at compose time (e.g.
   *  `Image #1`). Stable per attachment instance from paste through send, so a
   *  body reference the user typed never renumbers on the receiver. Carried
   *  verbatim; the backend echoes it, never recomputes. Absent for bare-id
   *  callers (agent CLI `--attachment <id>`, daemon relay) that have no
   *  compose-time labelling — those fall back to a positional label derived by
   *  `resolveAttachmentLabels`. */
  label: z.string().optional(),
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
  label: z.string().min(1).optional(),
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

/** True when a content-type denotes an image (drives the `Image #N` vs
 *  `File #N` label family). */
export function isImageAttachment(contentType: string): boolean {
  return contentType.startsWith('image/');
}

/** Effective display label for each attachment, aligned to the input order.
 *  Uses the sender's stored `label` when present; otherwise derives a
 *  positional fallback (`Image #N` / `File #N`, N = 1-based position within its
 *  kind). Single source of truth shared by the agent-facing stdin suffix and
 *  the renderer chip so the two never drift. Pure. */
export function resolveAttachmentLabels(
  attachments: ReadonlyArray<Pick<AttachmentSnapshot, 'label' | 'content_type'>>,
): string[] {
  let imageCount = 0;
  let fileCount = 0;
  return attachments.map(a => {
    const image = isImageAttachment(a.content_type);
    const ordinal = image ? (imageCount += 1) : (fileCount += 1);
    if (a.label !== undefined && a.label.trim().length > 0) return a.label;
    return image ? `Image #${ordinal}` : `File #${ordinal}`;
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

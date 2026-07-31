// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: attachment. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  AttachmentCreatorKindSchema,
  FromKindSchema,
  StorageKindSchema,
} from '../db/schema.js';
import { MessageSeqSchema } from '../seq.js';

//
// Two shapes:
//   - AttachmentDto: full row, returned by upload/get-by-id endpoints.
//   - AttachmentSnapshot: the immutable subset embedded into a message
//     when the message references the attachment. Lives under
//     `metadata.attachments` so renderers can render image/file cells
//     without an extra round-trip.
//
// No de-duplication: every upload creates a new row + new blob. The snapshot
// captures {id, filename, size, content_type} at compose time and is NEVER
// rewritten. Content update (creator-only, in place) locks `filename` and
// `content_type` for the row's life, so those never drift from a snapshot;
// `size` and `content_revision` DO advance on update, so a snapshot's `size`
// is a point-in-time value that may lag the row's current bytes — intentional,
// the snapshot is a historical capture, the DTO is the live row. The snapshot
// deliberately does NOT carry `content_revision` (it is not an authority for
// current freshness; the renderer resolves latest via the DTO + the
// `attachment_changed` event).

export const AttachmentDtoSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  source_conversation_id: z.string().nullable(),
  filename: z.string(),
  size: z.number(),
  content_type: z.string(),
  storage: StorageKindSchema,
  /** Monotonic freshness/cache-bust token, bumped on every content update
   *  (starts at 1). NOT a version number and NOT an HTTP validator — the
   *  renderer keys its blob generation on it; see `docs/attachments-design.md`. */
  content_revision: z.number(),
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

// ── attachment_changed event (content update cache-bust) ────────────────────
//
// Emitted after a successful in-place content update (`AttachmentService.update`
// → pointer-swap commit → alias relink), on the CHANNEL SIDE CHANNEL
// (`conversation-side:{channelId}`), NOT the message stream. Rationale: an
// attachment update must never advance message seq / stream head / read cursor
// (`docs/attachments-design.md` §4.3 freshness exclusion), and the side channel is
// cursor-inert and self-healing — exactly a fire-and-forget cache-bust. The
// payload is intentionally minimal: it names WHAT got fresher, not the new
// bytes. The renderer keys its blob generation on `content_revision` and refetches
// the authoritative DTO/bytes; the event is a bust signal, not a data carrier.
export const AttachmentChangedEventSchema = z.object({
  attachment_id: z.string(),
  /** The post-update revision — strictly greater than the client's last-seen
   *  value for this id; monotonic, so a client can ignore a stale replay. */
  content_revision: z.number(),
});
export type AttachmentChangedEvent = z.infer<typeof AttachmentChangedEventSchema>;
export const ATTACHMENT_CHANGED_EVENT = 'attachment_changed';

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

// ── Channel Attachments list (#task:1481) ──────────────────────────────────
//
// Scope: attachments referenced by persisted messages in a channel. Orphans
// (uploaded but never sent) are excluded — a channel Attachments panel shows
// blobs that actually appear in the conversation, not the composer drafts
// awaiting send. Thread replies live under the parent channel's conversation_id
// (docs/thread-reply-cluster-v1.md), so a single `conversation_id = channel_id`
// scan covers main-line + thread references.
//
// De-duplication: one row per attachment id. When the same blob is referenced
// by multiple messages, the panel shows the earliest persisted reference as
// the source, chosen deterministically by (message.created_at ASC, message.id
// ASC) — never `MIN(created_at)` + independent field pick (ties would drift
// message_id / thread_root_id across rows).
//
// Source actor is the earliest reference message's sender, NOT the attachment
// uploader — `AttachmentDto.created_by_*` is the blob's originator (may be an
// agent that never sends the message), which is a separate axis. The panel row
// renders sender identity from `source.from_*`, avoiding an N+1 lookup.

/** Earliest persisted-message reference for an attachment in the channel. */
export const AttachmentListItemSourceSchema = z.object({
  message_id: z.string(),
  /** Always the channel id — thread reply messages store the parent channel
   *  here, with `thread_root_id` distinguishing them. */
  conversation_id: z.string(),
  thread_root_id: z.string().nullable(),
  message_seq: MessageSeqSchema,
  from_kind: FromKindSchema,
  from_user_id: z.string().nullable(),
  from_agent_id: z.string().nullable(),
  /** The reference message's `created_at`. Doubles as the list's sort key —
   *  panel rows are `appeared_at DESC`. */
  appeared_at: z.number(),
});
export type AttachmentListItemSource = z.infer<
  typeof AttachmentListItemSourceSchema
>;

export const AttachmentListItemSchema = z.object({
  attachment: AttachmentDtoSchema,
  source: AttachmentListItemSourceSchema,
});
export type AttachmentListItem = z.infer<typeof AttachmentListItemSchema>;

export const AttachmentListPageSchema = z.object({
  items: z.array(AttachmentListItemSchema),
  /** Opaque; base64url JSON `[appeared_at, attachment_id]`. Null when the
   *  page reaches the tail. */
  next_cursor: z.string().nullable(),
});
export type AttachmentListPage = z.infer<typeof AttachmentListPageSchema>;

// ── Channel Attachments filter facets ──────────────────────────────────────
//
// The list supports two filter axes, both applied to the CANONICAL row (the
// earliest reference chosen by the dedup) — never to raw references. Filtering
// raw refs then deduping would drift an attachment's displayed source / jump
// target between filter states; the canonical source is a stable property of
// the attachment, so the filter reads the same `from_*` / `appeared_at` the
// panel renders (WYSIWYG). Time bounds are a half-open `[since, until)` window
// on the canonical `appeared_at`, which is also the sort + cursor key, so they
// compose with keyset pagination (a viewer-local calendar day stays correct
// across DST because the caller passes the two local-midnight instants).
//
// The sender facet set is the DISTINCT canonical-source actors — the same
// dedup set the list filters over, NOT "every actor that ever referenced an
// attachment". A re-share-only actor (never the earliest reference) is not a
// canonical source, so offering them in the dropdown would be a dead option
// (selecting yields zero rows).
//
// Every facet MUST be selectable by the list's sender wire, so the set carries
// only actors the wire can name: `sender_kind=user|agent` requires a non-empty
// id. `messages.from_{user,agent}_id` are ON DELETE SET NULL and a hard-deleted
// actor physically drops its row, so a canonical source whose actor was hard-
// deleted survives as a `from_kind` with a NULL id. That dangling actor is not
// wire-expressible and is excluded from the facet set — the attachment still
// appears in the unfiltered list, so no data is hidden, only an unusable filter
// option is withheld. The facet is therefore a precise discriminated union: a
// `user` carries only its user id, an `agent` only its agent id, `system`
// neither. Identity only — no display_name / avatar; the renderer resolves
// those via its member maps and, for an actor removed FROM THE ROSTER but still
// present in the DB, falls back to the raw id. (A hard delete leaves no id in
// the DB, which is exactly why the dangling case is filtered above rather than
// surfaced as a raw-id facet.) The set is time-independent: a sender ∩ time
// intersection that comes back empty is an honest "no results", not the
// pagination-window illusion the list itself guards.

export const AttachmentSenderFacetSchema = z.discriminatedUnion('from_kind', [
  z.object({
    from_kind: z.literal('user'),
    from_user_id: z.string().min(1),
    from_agent_id: z.null(),
  }),
  z.object({
    from_kind: z.literal('agent'),
    from_user_id: z.null(),
    from_agent_id: z.string().min(1),
  }),
  z.object({
    from_kind: z.literal('system'),
    from_user_id: z.null(),
    from_agent_id: z.null(),
  }),
]);
export type AttachmentSenderFacet = z.infer<typeof AttachmentSenderFacetSchema>;

export const AttachmentSenderFacetsSchema = z.object({
  senders: z.array(AttachmentSenderFacetSchema),
});
export type AttachmentSenderFacets = z.infer<typeof AttachmentSenderFacetsSchema>;

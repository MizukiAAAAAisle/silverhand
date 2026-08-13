/**
 * Attachment snapshot resolution — the PURE decision half of "may this
 * message carry these attachments, and what gets stamped into its metadata".
 *
 * Driver-free leaf on purpose: the send path resolves snapshots INSIDE its
 * transaction (through `MessageTxScope.attachments`) while `AttachmentService`
 * resolves them outside one, and both must apply the identical rules. The rules
 * therefore live here, taking their facts as an explicit minimal input type —
 * not an `AttachmentRow`, which would drag physical storage columns and the DB
 * schema into the message domain (#task:1981 R4).
 */
import {
  attachmentLabelKind,
  parseAttachmentLabel,
  type AttachmentRefInput,
  type AttachmentSnapshot,
} from '@silverhand/shared';

/**
 * The attachment facts the decision needs: identity, channel ownership, and
 * the fields that end up in the snapshot. `AttachmentRow` is a structural
 * superset, so a persistence adapter can satisfy this without a projection
 * step — but nothing here may grow a physical column (`storage`,
 * `storage_key`, `content_revision`).
 */
export interface AttachmentSnapshotSource {
  id: string;
  channel_id: string;
  filename: string;
  size: number;
  content_type: string;
}

export type SnapshotResolution =
  | { ok: true; snapshots: AttachmentSnapshot[] }
  | {
      ok: false;
      offendingId: string;
      reason: 'outside_channel' | 'label_kind_mismatch';
    };

/**
 * Resolve `refs` against `sources` (the rows fetched for `refs`' ids, in any
 * order) for a message being sent into `channelId`:
 *  - a ref whose attachment is missing or belongs to another channel is
 *    `outside_channel` — cross-channel reuse is not a permission the sender
 *    has, and "missing" is indistinguishable from "not yours" on purpose;
 *  - a declared label whose kind contradicts the real `content_type` is
 *    `label_kind_mismatch`;
 *  - otherwise the snapshot is stamped, carrying the caller's label verbatim.
 * Fails at the FIRST offending ref (the caller turns it into one 4xx).
 */
export function resolveSnapshotsFromSources(
  refs: readonly AttachmentRefInput[],
  channelId: string,
  sources: readonly AttachmentSnapshotSource[],
): SnapshotResolution {
  if (refs.length === 0) return { ok: true, snapshots: [] };
  const found = new Map(sources.map(s => [s.id, s] as const));
  const snapshots: AttachmentSnapshot[] = [];
  for (const ref of refs) {
    const source = found.get(ref.id);
    if (!source || source.channel_id !== channelId) {
      return { ok: false, offendingId: ref.id, reason: 'outside_channel' };
    }
    if (ref.label !== undefined) {
      // ref.label is wire-validated to the canonical form, so parse is
      // non-null; reject when the declared kind contradicts the real type.
      const parsed = parseAttachmentLabel(ref.label);
      if (!parsed || parsed.kind !== attachmentLabelKind(source.content_type)) {
        return { ok: false, offendingId: ref.id, reason: 'label_kind_mismatch' };
      }
    }
    const snapshot: AttachmentSnapshot = {
      id: source.id,
      filename: source.filename,
      size: source.size,
      content_type: source.content_type,
    };
    snapshots.push(
      ref.label !== undefined ? { ...snapshot, label: ref.label } : snapshot,
    );
  }
  return { ok: true, snapshots };
}

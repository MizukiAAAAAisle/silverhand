import type { LogicalSend } from "@/features/channels/logical-send";
import type { AttachmentDto } from "@silverhand/shared";
import {
  apiPaths,
  attachmentLabelKind,
  formatAttachmentLabel,
  parseAttachmentLabel,
} from "@silverhand/shared";
import { apiUpload, deleteAttachmentBestEffort } from "../../lib/api";
import {
  releaseAttachmentPreview,
  setAttachmentBlobUrl,
} from "../attachments/attachment-blob-cache";

export const MAX_DRAFTS = 10;

export type CachedPendingAttachment = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  state: "uploading" | "done" | "error";
  file?: File;
  previewUrl?: string;
  attachment?: AttachmentDto;
  error?: string;
  /** Compose-time display identity (`Image #N` / `File #N`), assigned the
   *  moment the attachment enters this draft and STABLE for the draft's whole
   *  lifetime. Never renumbers when other attachments are removed
   *  or reordered — so a body reference the user typed (`Image #1`) can never
   *  silently rebind to a different file. Carried into the send payload and
   *  echoed by the backend. */
  label?: string;
};

/** Per-kind high-water counters for a draft's attachment labels. Monotonic:
 *  a number, once handed out, is never reused for that draft even after the
 *  attachment that held it is removed — hence gaps are allowed (a visible
 *  dangling reference is far safer than a silent rebind). Reset only when the
 *  draft is cleared/sent (a fresh message starts at #1). */
export type ComposerLabelSeq = { image: number; file: number };

/**
 * Does this pending set block a send? An `uploading` item is not ready yet, and
 * an `error` item would be dropped WITHOUT NOTICE — the send payload carries
 * only `state === 'done'` items, so a failed upload used to leave the composer
 * looking normal, disappear from the sent message, and take its typed
 * `Image #N` reference with it.
 *
 * One predicate for both gates on purpose. The Send button's `disabled` and
 * `submit()`'s own guard each spelled out `uploading` separately, which is
 * exactly how `error` ended up gated in neither: two copies of a rule drift the
 * moment a third state exists. The escape hatch is the chip's own remove
 * button — there is no retry path today, so blocking means "resolve it or drop
 * it deliberately", never a dead end.
 */
export function pendingAttachmentsBlockSend(
  pending: ReadonlyArray<CachedPendingAttachment>,
): boolean {
  return pending.some((item) => item.state === "uploading" || item.state === "error");
}

export type ComposerDraftSnapshot = {
  /** Shared in-memory attempt identity; cloning the draft must preserve confirmation. */
  sendAttempt?: LogicalSend;
  conversationId: string;
  text: string;
  caret: number;
  pending: CachedPendingAttachment[];
  /** Monotonic label counters for this draft (see {@link ComposerLabelSeq}).
   *  Optional so older snapshots / callers that don't manage labels round-trip
   *  unchanged; {@link writeComposerDraft} reconciles it with the live entry so
   *  it never regresses. */
  labelSeq?: ComposerLabelSeq;
  updatedAt: number;
};

export type ComposerDraftEvent =
  | {
      type: "attachment-patch";
      attachmentKey: string;
      patch: Partial<CachedPendingAttachment>;
    }
  | { type: "attachment-remove"; attachmentKey: string }
  | { type: "clear" };

type ComposerDraftEntry = ComposerDraftSnapshot;
type DraftListener = (event: ComposerDraftEvent) => void;

const drafts = new Map<string, ComposerDraftEntry>();
const inFlightUploads = new Map<string, Promise<void>>();
const abandonedUploads = new Set<string>();
const listeners = new Map<string, Set<DraftListener>>();

export function clearComposerSendAttempt(conversationId: string): void {
  const entry = drafts.get(conversationId);
  if (entry) delete entry.sendAttempt;
}

export function readComposerDraft(conversationId: string): ComposerDraftSnapshot | null {
  const entry = drafts.get(conversationId);
  return entry ? cloneSnapshot(entry) : null;
}

export function writeComposerDraft(snapshot: ComposerDraftSnapshot): void {
  const existing = drafts.get(snapshot.conversationId);
  const pending = mergePending(snapshot.conversationId, snapshot.pending, existing);
  const entry = {
    ...snapshot,
    pending,
    // Never let a snapshot that omits labelSeq (e.g. the unmount write built
    // from Composer state) wipe the monotonic counter — reconcile against the
    // live entry AND the surviving labels so it can only move forward.
    labelSeq: reconcileLabelSeq(existing?.labelSeq, snapshot.labelSeq, pending),
    updatedAt: Date.now(),
  };
  if (isEmptySnapshot(entry)) {
    cleanupEntry(snapshot.conversationId);
    emit(snapshot.conversationId, { type: "clear" });
    return;
  }
  drafts.set(snapshot.conversationId, entry);
  evictIfNeeded();
}

/**
 * Assign the next stable label for an attachment entering this draft.
 * Called the instant a file is pasted/dropped/picked, so what
 * the user sees in the chip is exactly what will be sent to the agent.
 *
 * The ordinal is a per-kind monotonic counter: `max(persisted high-water,
 * highest live ordinal) + 1`. It never reuses a number for the draft, so
 * deleting the most-recent attachment and adding another yields the NEXT
 * number, not the freed one — otherwise a body reference the user already
 * typed could silently rebind to the new file.
 */
export function assignAttachmentLabel(conversationId: string, contentType: string): string {
  const entry = ensureEntry(conversationId);
  const kind = attachmentLabelKind(contentType);
  const image = kind === "Image";
  const seq = entry.labelSeq ?? { image: 0, file: 0 };
  const base = Math.max(image ? seq.image : seq.file, maxLiveOrdinal(entry.pending, image));
  const next = base + 1;
  entry.labelSeq = image ? { image: next, file: seq.file } : { image: seq.image, file: next };
  entry.updatedAt = Date.now();
  drafts.set(conversationId, entry);
  // Build through the shared generator so the composer's label form can never
  // drift from the backend schema / resolver.
  return formatAttachmentLabel(kind, next);
}

export function clearComposerDraft(
  conversationId: string,
  options: { sentAttachmentIds?: string[] } = {},
): void {
  cleanupEntry(conversationId, new Set(options.sentAttachmentIds ?? []));
  emit(conversationId, { type: "clear" });
}

export function dropSentAttachmentsFromDraft(
  conversationId: string,
  sentAttachmentKeys: string[],
): void {
  const entry = drafts.get(conversationId);
  if (!entry || sentAttachmentKeys.length === 0) return;
  const sentKeys = new Set(sentAttachmentKeys);
  entry.pending = entry.pending.filter((item) => !sentKeys.has(item.key));
  // A send is a draft boundary: the label counter resets so the NEXT message
  // starts at #1. detach alone is not enough — without this the
  // counter (e.g. 2 after sending Image #1, Image #2) would carry into the new
  // message. Floor at the highest surviving live label so an attachment the
  // user added while the prior send was still in flight keeps a unique number.
  entry.labelSeq = {
    image: maxLiveOrdinal(entry.pending, true),
    file: maxLiveOrdinal(entry.pending, false),
  };
  entry.updatedAt = Date.now();
  if (isEmptySnapshot(entry)) {
    drafts.delete(conversationId);
    return;
  }
  drafts.set(conversationId, entry);
  evictIfNeeded();
}

export function patchComposerDraftText(conversationId: string, text: string, caret: number): void {
  const entry = ensureEntry(conversationId);
  if (entry.text !== text) delete entry.sendAttempt;
  entry.text = text;
  entry.caret = caret;
  entry.updatedAt = Date.now();
  if (isEmptySnapshot(entry)) {
    cleanupEntry(conversationId);
  } else {
    drafts.set(conversationId, entry);
    evictIfNeeded();
  }
}

export function upsertComposerDraftAttachment(
  conversationId: string,
  attachment: CachedPendingAttachment,
): void {
  upsertAttachment(conversationId, attachment, true);
}

export function removeComposerDraftAttachment(conversationId: string, attachmentKey: string): void {
  const entry = drafts.get(conversationId);
  if (!entry) return;
  const target = entry.pending.find((p) => p.key === attachmentKey);
  if (!target) return;
  cleanupAttachment(conversationId, target);
  entry.pending = entry.pending.filter((p) => p.key !== attachmentKey);
  entry.updatedAt = Date.now();
  if (isEmptySnapshot(entry)) {
    drafts.delete(conversationId);
  } else {
    drafts.set(conversationId, entry);
  }
  emit(conversationId, { type: "attachment-remove", attachmentKey });
}

export function hasComposerDraftInFlightUpload(
  conversationId: string,
  attachmentKey: string,
): boolean {
  return inFlightUploads.has(uploadKey(conversationId, attachmentKey));
}

export function startComposerDraftAttachmentUpload(input: {
  conversationId: string;
  attachmentKey: string;
  file: File;
  previewUrl?: string;
  /** Stable compose-time label assigned by {@link assignAttachmentLabel},
   *  persisted on the cached attachment so it survives draft save/restore. */
  label?: string;
  /** Channel id used to build the upload network path, when it differs
   *  from `conversationId` (the draft identity key). Reply-cluster drafts
   *  key the draft by a composite `${channelId}#cluster#${rootId}` so they
   *  don't collide with the channel's main draft, but their attachments
   *  must still POST to the real channel. Defaults to `conversationId`. */
  uploadChannelId?: string;
}): Promise<void> {
  const key = uploadKey(input.conversationId, input.attachmentKey);
  const existing = inFlightUploads.get(key);
  if (existing) return existing;
  const current = drafts
    .get(input.conversationId)
    ?.pending.find((item) => item.key === input.attachmentKey);
  if (current?.state === "done") {
    return Promise.resolve();
  }
  abandonedUploads.delete(key);

  upsertAttachment(
    input.conversationId,
    {
      key: input.attachmentKey,
      filename: input.file.name,
      size: input.file.size,
      contentType: input.file.type || "application/octet-stream",
      state: "uploading",
      file: input.file,
      previewUrl: input.previewUrl,
      label: input.label ?? current?.label,
      error: undefined,
    },
    true,
  );

  const promise = uploadAttachment(input, key);
  inFlightUploads.set(key, promise);
  return promise;
}

export function cleanupAllComposerDrafts(): void {
  for (const conversationId of Array.from(drafts.keys())) {
    cleanupEntry(conversationId);
    emit(conversationId, { type: "clear" });
  }
}

export function subscribeComposerDraft(
  conversationId: string,
  listener: DraftListener,
): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(conversationId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(conversationId);
  };
}

export function __resetComposerDraftCacheForTests(): void {
  cleanupAllComposerDrafts();
  drafts.clear();
  inFlightUploads.clear();
  abandonedUploads.clear();
  listeners.clear();
}

async function uploadAttachment(
  input: {
    conversationId: string;
    attachmentKey: string;
    file: File;
    previewUrl?: string;
    uploadChannelId?: string;
  },
  key: string,
): Promise<void> {
  try {
    const channelId = input.uploadChannelId ?? input.conversationId;
    const path = apiPaths.channelAttachments(channelId);
    const form = new FormData();
    form.append("file", input.file, input.file.name);
    const dto = await apiUpload<AttachmentDto>(path, form);
    if (abandonedUploads.has(key) || !hasAttachment(input.conversationId, input.attachmentKey)) {
      void deleteAttachmentBestEffort(dto.id);
      return;
    }
    if (input.previewUrl) {
      // Seed the local preview under the server's revision so a redelivered
      // `attachment_changed` for this same revision is a no-op (#task:1769).
      setAttachmentBlobUrl(dto.id, input.previewUrl, dto.content_revision);
    }
    patchAttachment(
      input.conversationId,
      input.attachmentKey,
      {
        state: "done",
        attachment: dto,
        error: undefined,
      },
      true,
    );
  } catch (err) {
    if (!abandonedUploads.has(key) && hasAttachment(input.conversationId, input.attachmentKey)) {
      patchAttachment(
        input.conversationId,
        input.attachmentKey,
        {
          state: "error",
          error: err instanceof Error ? err.message : String(err),
        },
        true,
      );
    }
  } finally {
    inFlightUploads.delete(key);
    abandonedUploads.delete(key);
  }
}

function ensureEntry(conversationId: string): ComposerDraftEntry {
  const existing = drafts.get(conversationId);
  if (existing) return existing;
  const entry: ComposerDraftEntry = {
    conversationId,
    text: "",
    caret: 0,
    pending: [],
    updatedAt: Date.now(),
  };
  drafts.set(conversationId, entry);
  return entry;
}

function upsertAttachment(
  conversationId: string,
  attachment: CachedPendingAttachment,
  shouldEmit: boolean,
): void {
  const entry = ensureEntry(conversationId);
  const idx = entry.pending.findIndex((p) => p.key === attachment.key);
  if (idx === -1) {
    entry.pending = [...entry.pending, cloneAttachment(attachment)];
  } else {
    entry.pending = entry.pending.map((p) =>
      p.key === attachment.key ? mergeAttachment(p, attachment) : p,
    );
  }
  entry.updatedAt = Date.now();
  drafts.set(conversationId, entry);
  evictIfNeeded();
  if (shouldEmit) {
    emit(conversationId, {
      type: "attachment-patch",
      attachmentKey: attachment.key,
      patch: cloneAttachment(attachment),
    });
  }
}

function patchAttachment(
  conversationId: string,
  attachmentKey: string,
  patch: Partial<CachedPendingAttachment>,
  shouldEmit: boolean,
): void {
  const entry = drafts.get(conversationId);
  if (!entry) return;
  let changed = false;
  entry.pending = entry.pending.map((item) => {
    if (item.key !== attachmentKey) return item;
    changed = true;
    return mergeAttachment(item, { ...item, ...patch });
  });
  if (!changed) return;
  entry.updatedAt = Date.now();
  drafts.set(conversationId, entry);
  evictIfNeeded();
  if (shouldEmit) {
    emit(conversationId, { type: "attachment-patch", attachmentKey, patch });
  }
}

function mergePending(
  conversationId: string,
  incoming: CachedPendingAttachment[],
  existing: ComposerDraftEntry | undefined,
): CachedPendingAttachment[] {
  const existingByKey = new Map((existing?.pending ?? []).map((item) => [item.key, item] as const));
  const incomingKeys = new Set(incoming.map((item) => item.key));
  for (const item of existing?.pending ?? []) {
    if (!incomingKeys.has(item.key)) cleanupAttachment(conversationId, item);
  }
  return incoming.map((item) => {
    const previous = existingByKey.get(item.key);
    return previous ? mergeAttachment(previous, item) : cloneAttachment(item);
  });
}

function mergeAttachment(
  previous: CachedPendingAttachment,
  incoming: CachedPendingAttachment,
): CachedPendingAttachment {
  // Upload completion is terminal for a chip. A later stale Composer
  // snapshot or accidental retry must not downgrade it back to
  // uploading/error, otherwise the already-uploaded attachment id would
  // be orphaned and the user would see a false pending state.
  if (previous.state === "done" && incoming.state !== "done") {
    return cloneAttachment(previous);
  }
  return {
    ...previous,
    ...incoming,
    file: incoming.file ?? previous.file,
    previewUrl: incoming.previewUrl ?? previous.previewUrl,
    attachment: incoming.attachment ?? previous.attachment,
    // Label is compose-time identity: once assigned it must survive every
    // later patch (upload done, snapshot round-trip), never be nulled out.
    label: incoming.label ?? previous.label,
  };
}

function cleanupEntry(conversationId: string, sentAttachmentIds: Set<string> = new Set()): void {
  const entry = drafts.get(conversationId);
  if (!entry) return;
  for (const item of entry.pending) {
    cleanupAttachment(conversationId, item, sentAttachmentIds);
  }
  drafts.delete(conversationId);
}

function cleanupAttachment(
  conversationId: string,
  item: CachedPendingAttachment,
  sentAttachmentIds: Set<string> = new Set(),
): void {
  const key = uploadKey(conversationId, item.key);
  if (item.state === "uploading" && inFlightUploads.has(key)) {
    abandonedUploads.add(key);
  }
  const attachmentId = item.attachment?.id;
  if (attachmentId) {
    if (!sentAttachmentIds.has(attachmentId)) {
      releaseAttachmentPreview(attachmentId);
      void deleteAttachmentBestEffort(attachmentId);
    }
    return;
  }
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function evictIfNeeded(): void {
  while (drafts.size > MAX_DRAFTS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of drafts) {
      if (entry.updatedAt < oldestTime) {
        oldestTime = entry.updatedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    cleanupEntry(oldestKey);
    emit(oldestKey, { type: "clear" });
  }
}

function isEmptySnapshot(snapshot: ComposerDraftSnapshot): boolean {
  return snapshot.text.trim().length === 0 && snapshot.pending.length === 0;
}

function hasAttachment(conversationId: string, attachmentKey: string): boolean {
  return drafts.get(conversationId)?.pending.some((item) => item.key === attachmentKey) ?? false;
}

function emit(conversationId: string, event: ComposerDraftEvent): void {
  const set = listeners.get(conversationId);
  if (!set) return;
  for (const listener of Array.from(set)) listener(event);
}

function uploadKey(conversationId: string, attachmentKey: string): string {
  return `${conversationId}:${attachmentKey}`;
}

/** Highest ordinal currently held by a live attachment of the given kind, or 0.
 *  A secondary floor for the counter so it can't regress below a surviving
 *  label even if the persisted counter were somehow lost. Parses via the shared
 *  canonical parser so a non-canonical label is ignored, not misread. */
function maxLiveOrdinal(pending: ReadonlyArray<CachedPendingAttachment>, image: boolean): number {
  const kind = image ? "Image" : "File";
  let max = 0;
  for (const item of pending) {
    const parsed = parseAttachmentLabel(item.label);
    if (parsed && parsed.kind === kind) max = Math.max(max, parsed.ordinal);
  }
  return max;
}

/** Fold a snapshot's label counter into the live one so it only moves forward:
 *  the max of the persisted counter, the incoming snapshot's counter, and the
 *  highest live label. Guarantees monotonicity across every persistence path. */
function reconcileLabelSeq(
  existing: ComposerLabelSeq | undefined,
  incoming: ComposerLabelSeq | undefined,
  pending: ReadonlyArray<CachedPendingAttachment>,
): ComposerLabelSeq {
  return {
    image: Math.max(existing?.image ?? 0, incoming?.image ?? 0, maxLiveOrdinal(pending, true)),
    file: Math.max(existing?.file ?? 0, incoming?.file ?? 0, maxLiveOrdinal(pending, false)),
  };
}

function cloneSnapshot(snapshot: ComposerDraftSnapshot): ComposerDraftSnapshot {
  return {
    ...snapshot,
    pending: snapshot.pending.map(cloneAttachment),
    // Clone the mutable label counter too so a reader can't mutate the live
    // entry's state through the returned snapshot (keeps the cache read boundary
    // clean — Cindy's #1324 nit).
    labelSeq: snapshot.labelSeq ? { ...snapshot.labelSeq } : undefined,
  };
}

function cloneAttachment(attachment: CachedPendingAttachment): CachedPendingAttachment {
  return { ...attachment };
}

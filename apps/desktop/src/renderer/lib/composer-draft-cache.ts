import type { AttachmentDto } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { apiUpload, deleteAttachmentBestEffort } from './api';
import {
  releaseAttachmentPreview,
  setAttachmentBlobUrl,
} from './attachment-blob-cache';

export const MAX_DRAFTS = 10;

export type ComposerDraftRouteKind = 'channel' | 'thread';

export type CachedPendingAttachment = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  state: 'uploading' | 'done' | 'error';
  file?: File;
  previewUrl?: string;
  attachment?: AttachmentDto;
  error?: string;
};

export type ComposerDraftSnapshot = {
  conversationId: string;
  routeKind: ComposerDraftRouteKind;
  text: string;
  caret: number;
  pending: CachedPendingAttachment[];
  updatedAt: number;
};

export type ComposerDraftEvent =
  | {
      type: 'attachment-patch';
      attachmentKey: string;
      patch: Partial<CachedPendingAttachment>;
    }
  | { type: 'attachment-remove'; attachmentKey: string }
  | { type: 'clear' };

type ComposerDraftEntry = ComposerDraftSnapshot;
type DraftListener = (event: ComposerDraftEvent) => void;

const drafts = new Map<string, ComposerDraftEntry>();
const inFlightUploads = new Map<string, Promise<void>>();
const abandonedUploads = new Set<string>();
const listeners = new Map<string, Set<DraftListener>>();

export function readComposerDraft(
  conversationId: string,
): ComposerDraftSnapshot | null {
  const entry = drafts.get(conversationId);
  return entry ? cloneSnapshot(entry) : null;
}

export function writeComposerDraft(snapshot: ComposerDraftSnapshot): void {
  const existing = drafts.get(snapshot.conversationId);
  const pending = mergePending(snapshot.conversationId, snapshot.pending, existing);
  const entry = {
    ...snapshot,
    pending,
    updatedAt: Date.now(),
  };
  if (isEmptySnapshot(entry)) {
    cleanupEntry(snapshot.conversationId);
    emit(snapshot.conversationId, { type: 'clear' });
    return;
  }
  drafts.set(snapshot.conversationId, entry);
  evictIfNeeded();
}

export function clearComposerDraft(
  conversationId: string,
  options: { sentAttachmentIds?: string[] } = {},
): void {
  cleanupEntry(conversationId, new Set(options.sentAttachmentIds ?? []));
  emit(conversationId, { type: 'clear' });
}

export function dropSentAttachmentsFromDraft(
  conversationId: string,
  sentAttachmentKeys: string[],
): void {
  const entry = drafts.get(conversationId);
  if (!entry || sentAttachmentKeys.length === 0) return;
  const sentKeys = new Set(sentAttachmentKeys);
  entry.pending = entry.pending.filter(item => !sentKeys.has(item.key));
  entry.updatedAt = Date.now();
  if (isEmptySnapshot(entry)) {
    drafts.delete(conversationId);
    return;
  }
  drafts.set(conversationId, entry);
  evictIfNeeded();
}

export function patchComposerDraftText(
  conversationId: string,
  routeKind: ComposerDraftRouteKind,
  text: string,
  caret: number,
): void {
  const entry = ensureEntry(conversationId, routeKind);
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

export function patchComposerDraftAttachment(
  conversationId: string,
  attachmentKey: string,
  patch: Partial<CachedPendingAttachment>,
): void {
  patchAttachment(conversationId, attachmentKey, patch, true);
}

export function upsertComposerDraftAttachment(
  conversationId: string,
  routeKind: ComposerDraftRouteKind,
  attachment: CachedPendingAttachment,
): void {
  upsertAttachment(conversationId, routeKind, attachment, true);
}

export function removeComposerDraftAttachment(
  conversationId: string,
  attachmentKey: string,
): void {
  const entry = drafts.get(conversationId);
  if (!entry) return;
  const target = entry.pending.find(p => p.key === attachmentKey);
  if (!target) return;
  cleanupAttachment(conversationId, target);
  entry.pending = entry.pending.filter(p => p.key !== attachmentKey);
  entry.updatedAt = Date.now();
  if (isEmptySnapshot(entry)) {
    drafts.delete(conversationId);
  } else {
    drafts.set(conversationId, entry);
  }
  emit(conversationId, { type: 'attachment-remove', attachmentKey });
}

export function hasComposerDraftInFlightUpload(
  conversationId: string,
  attachmentKey: string,
): boolean {
  return inFlightUploads.has(uploadKey(conversationId, attachmentKey));
}

export function startComposerDraftAttachmentUpload(input: {
  conversationId: string;
  routeKind: ComposerDraftRouteKind;
  attachmentKey: string;
  file: File;
  previewUrl?: string;
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
    ?.pending.find(item => item.key === input.attachmentKey);
  if (current?.state === 'done') {
    return Promise.resolve();
  }
  abandonedUploads.delete(key);

  upsertAttachment(input.conversationId, input.routeKind, {
    key: input.attachmentKey,
    filename: input.file.name,
    size: input.file.size,
    contentType: input.file.type || 'application/octet-stream',
    state: 'uploading',
    file: input.file,
    previewUrl: input.previewUrl,
    error: undefined,
  }, true);

  const promise = uploadAttachment(input, key);
  inFlightUploads.set(key, promise);
  return promise;
}

export function cleanupAllComposerDrafts(): void {
  for (const conversationId of Array.from(drafts.keys())) {
    cleanupEntry(conversationId);
    emit(conversationId, { type: 'clear' });
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
    routeKind: ComposerDraftRouteKind;
    attachmentKey: string;
    file: File;
    previewUrl?: string;
    uploadChannelId?: string;
  },
  key: string,
): Promise<void> {
  try {
    const channelId = input.uploadChannelId ?? input.conversationId;
    const path =
      input.routeKind === 'thread'
        ? apiPaths.threadAttachments(channelId)
        : apiPaths.channelAttachments(channelId);
    const form = new FormData();
    form.append('file', input.file, input.file.name);
    const dto = await apiUpload<AttachmentDto>(path, form);
    if (abandonedUploads.has(key) || !hasAttachment(input.conversationId, input.attachmentKey)) {
      void deleteAttachmentBestEffort(dto.id);
      return;
    }
    if (input.previewUrl) {
      setAttachmentBlobUrl(dto.id, input.previewUrl);
    }
    patchAttachment(
      input.conversationId,
      input.attachmentKey,
      {
        state: 'done',
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
          state: 'error',
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

function ensureEntry(
  conversationId: string,
  routeKind: ComposerDraftRouteKind,
): ComposerDraftEntry {
  const existing = drafts.get(conversationId);
  if (existing) return existing;
  const entry: ComposerDraftEntry = {
    conversationId,
    routeKind,
    text: '',
    caret: 0,
    pending: [],
    updatedAt: Date.now(),
  };
  drafts.set(conversationId, entry);
  return entry;
}

function upsertAttachment(
  conversationId: string,
  routeKind: ComposerDraftRouteKind,
  attachment: CachedPendingAttachment,
  shouldEmit: boolean,
): void {
  const entry = ensureEntry(conversationId, routeKind);
  const idx = entry.pending.findIndex(p => p.key === attachment.key);
  if (idx === -1) {
    entry.pending = [...entry.pending, cloneAttachment(attachment)];
  } else {
    entry.pending = entry.pending.map(p =>
      p.key === attachment.key ? mergeAttachment(p, attachment) : p,
    );
  }
  entry.updatedAt = Date.now();
  drafts.set(conversationId, entry);
  evictIfNeeded();
  if (shouldEmit) {
    emit(conversationId, {
      type: 'attachment-patch',
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
  entry.pending = entry.pending.map(item => {
    if (item.key !== attachmentKey) return item;
    changed = true;
    return mergeAttachment(item, { ...item, ...patch });
  });
  if (!changed) return;
  entry.updatedAt = Date.now();
  drafts.set(conversationId, entry);
  evictIfNeeded();
  if (shouldEmit) {
    emit(conversationId, { type: 'attachment-patch', attachmentKey, patch });
  }
}

function mergePending(
  conversationId: string,
  incoming: CachedPendingAttachment[],
  existing: ComposerDraftEntry | undefined,
): CachedPendingAttachment[] {
  const existingByKey = new Map(
    (existing?.pending ?? []).map(item => [item.key, item] as const),
  );
  const incomingKeys = new Set(incoming.map(item => item.key));
  for (const item of existing?.pending ?? []) {
    if (!incomingKeys.has(item.key)) cleanupAttachment(conversationId, item);
  }
  return incoming.map(item => {
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
  if (previous.state === 'done' && incoming.state !== 'done') {
    return cloneAttachment(previous);
  }
  return {
    ...previous,
    ...incoming,
    file: incoming.file ?? previous.file,
    previewUrl: incoming.previewUrl ?? previous.previewUrl,
    attachment: incoming.attachment ?? previous.attachment,
  };
}

function cleanupEntry(
  conversationId: string,
  sentAttachmentIds: Set<string> = new Set(),
): void {
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
  if (item.state === 'uploading' && inFlightUploads.has(key)) {
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
    emit(oldestKey, { type: 'clear' });
  }
}

function isEmptySnapshot(snapshot: ComposerDraftSnapshot): boolean {
  return snapshot.text.trim().length === 0 && snapshot.pending.length === 0;
}

function hasAttachment(conversationId: string, attachmentKey: string): boolean {
  return drafts
    .get(conversationId)
    ?.pending.some(item => item.key === attachmentKey) ?? false;
}

function emit(conversationId: string, event: ComposerDraftEvent): void {
  const set = listeners.get(conversationId);
  if (!set) return;
  for (const listener of Array.from(set)) listener(event);
}

function uploadKey(conversationId: string, attachmentKey: string): string {
  return `${conversationId}:${attachmentKey}`;
}

function cloneSnapshot(snapshot: ComposerDraftSnapshot): ComposerDraftSnapshot {
  return {
    ...snapshot,
    pending: snapshot.pending.map(cloneAttachment),
  };
}

function cloneAttachment(
  attachment: CachedPendingAttachment,
): CachedPendingAttachment {
  return { ...attachment };
}

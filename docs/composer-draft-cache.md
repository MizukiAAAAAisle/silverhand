# Composer Draft Cache

> **Status**: Spec. This document captures the agreed implementation plan for
> preserving unsent composer text and attachments while the user switches
> between channels and threads.

This doc is intentionally renderer-focused. Attachment storage, HTTP routes, and
message snapshot semantics remain defined in
[`attachments-design.md`](./attachments-design.md).

---

## 1. Goal

When a user types in the chat composer but has not sent the message yet, moving
between channels, threads, Search, Saved, or other panels should not lose that
draft. The cache must preserve:

- text content
- caret position
- pending attachment chips
- local image preview URLs
- uploaded attachment ids that have not been sent in a message yet
- in-flight upload state

The cache key is the current `conversationId`. Channel and thread ids already
come from the same `conversations` namespace, so no extra prefix is required.

`MAX_DRAFTS = 10`.

---

## 2. Non-Goals

v1 does **not** persist drafts across app restart. The cache is renderer-memory
only.

v1 does **not** mirror text to `localStorage`. Text-only persistence can be a
small later layer, but attachment state cannot safely live there because it
contains `File` references, object URLs, and upload side effects.

v1 does **not** sync drafts across devices or store drafts in the backend.

---

## 3. Current Problem

`Composer` currently owns all draft and attachment state:

- `draft`
- `caret`
- `pending`
- `pendingUrls`
- `uploadedIds`
- `useUploadAttachment(...)` mutation callbacks

It also cleans up attachment resources on unmount by revoking local object URLs
and deleting uploaded-but-unsent attachment ids.

That lifecycle is wrong once draft restore is required. Switching away from a
conversation should transfer ownership to a draft cache, not destroy the draft's
attachment resources.

There is also a state boundary issue: `ChannelView` currently renders one
`Composer` instance while changing `conversationId`. That makes draft state easy
to leak across conversations unless every state field is manually synchronized.
The simpler invariant is:

```tsx
<Composer key={conversation.id} conversationId={conversation.id} ... />
```

Each conversation gets a fresh Composer instance. Mount hydrates from cache;
unmount flushes to cache.

---

## 4. Ownership Model

The draft cache is the single owner of cross-conversation draft state.

`Composer` owns state only while it is mounted for the active conversation. When
it unmounts, it writes a snapshot to the cache and gives the cache ownership of
attachment side effects. It must not revoke preview URLs or delete uploaded ids
during normal conversation switches.

The cache owns:

- LRU entries
- preview URL cleanup
- uploaded-but-unsent attachment cleanup
- in-flight upload registration
- upload success/error patching

This avoids relying on React Query mutation callbacks after `Composer` unmounts.
The cache layer starts and tracks upload promises directly.

---

## 5. Cache Module

Add:

```text
apps/desktop/src/renderer/lib/composer-draft-cache.ts
```

Suggested public API:

```ts
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

export function readComposerDraft(
  conversationId: string,
): ComposerDraftSnapshot | null;

export function writeComposerDraft(
  snapshot: ComposerDraftSnapshot,
): void;

export function clearComposerDraft(
  conversationId: string,
  options?: { sentAttachmentIds?: string[] },
): void;

export function dropSentAttachmentsFromDraft(
  conversationId: string,
  sentAttachmentKeys: string[],
): void;

export function patchComposerDraftText(
  conversationId: string,
  routeKind: ComposerDraftRouteKind,
  text: string,
  caret: number,
): void;

export function patchComposerDraftAttachment(
  conversationId: string,
  attachmentKey: string,
  patch: Partial<CachedPendingAttachment>,
): void;

export function upsertComposerDraftAttachment(
  conversationId: string,
  routeKind: ComposerDraftRouteKind,
  attachment: CachedPendingAttachment,
): void;

export function removeComposerDraftAttachment(
  conversationId: string,
  attachmentKey: string,
): void;

export function hasComposerDraftInFlightUpload(
  conversationId: string,
  attachmentKey: string,
): boolean;

export function startComposerDraftAttachmentUpload(input: {
  conversationId: string;
  routeKind: ComposerDraftRouteKind;
  attachmentKey: string;
  file: File;
  previewUrl?: string;
}): Promise<void>;

export function cleanupAllComposerDrafts(): void;

export function subscribeComposerDraft(
  conversationId: string,
  listener: (event: ComposerDraftEvent) => void,
): () => void;
```

The module may keep extra private structures, for example:

```ts
const drafts = new Map<string, ComposerDraftEntry>();
const inFlightUploads = new Map<string, Promise<void>>();
```

Use a composite private upload key such as
`${conversationId}:${attachmentKey}`.

Subscriptions should emit granular events, not whole-entry replacement events.
The mounted Composer should receive an attachment patch such as
`{ type: 'attachment-patch', attachmentKey, patch }` when upload state changes.
That prevents cache-side upload completion from overwriting text/caret edits the
user made while the Composer was mounted.

`writeComposerDraft` must merge with any newer attachment state already in the
cache. A stale Composer unmount must not downgrade an attachment that the cache
has already patched to `done` or `error`. Text/caret can be replaced by the
latest Composer snapshot, but pending attachment rows should merge by `key` and
prefer the cache row when it has a terminal upload state.

---

## 6. Upload Lifecycle

Upload ownership moves out of React Query and into
`composer-draft-cache.ts`.

`startComposerDraftAttachmentUpload` should:

1. Insert or patch the attachment row to `state: 'uploading'`.
2. Register an in-flight promise before starting the network request.
3. Build the upload path from `routeKind`:
   - `apiPaths.channelAttachments(conversationId)`
   - `apiPaths.threadAttachments(conversationId)`
4. Call `apiUpload<AttachmentDto>(path, formData)` directly.
5. On success:
   - if there is a `previewUrl`, call `setAttachmentBlobUrl(dto.id, previewUrl)`
   - patch the attachment to `state: 'done'`
   - store `attachment: dto`
   - keep enough metadata for orphan cleanup if the draft is later removed
6. On error:
   - patch the attachment to `state: 'error'`
   - keep `file` so the user can retry without reselecting it
   - keep `previewUrl` if it exists, because the chip still belongs to the draft
7. In `finally`, unregister the in-flight promise.

Do not rely on a mounted Composer for success/error handling. If the user
switches away while an upload is in progress, the promise must still update the
cache. When the user returns, the hydrated draft should show the final state.

---

## 7. Composer Integration

`ChannelView` must force a conversation-scoped Composer instance:

```tsx
<Composer
  key={conversation.id}
  conversationId={conversation.id}
  routeKind={routeKind}
  disabled={closed}
/>
```

`Composer` mount:

1. `readComposerDraft(conversationId)`.
2. Initialize `draft`, `caret`, and `pending` from the snapshot if present.
3. Subscribe with `subscribeComposerDraft(...)` so cache-side upload completion
   can update the mounted UI without depending on React Query callbacks.
4. For each pending attachment:
   - `state === 'done'`: render directly from `attachment`
   - `state === 'uploading'` and `hasInFlight(...)`: render uploading and wait
   - `state === 'uploading'` with `file` but no in-flight promise: restart upload
   - `state === 'error'`: render error and let user retry/remove

`Composer` updates:

- Text changes patch local React state and cache text/caret.
- File add creates the local chip and calls
  `startComposerDraftAttachmentUpload`.
- Remove chip calls `removeComposerDraftAttachment`.
- Retry error calls `startComposerDraftAttachmentUpload` again.

`Composer` unmount:

- Write the latest snapshot to cache.
- Do **not** revoke preview URLs.
- Do **not** delete uploaded attachment ids.

Submit success:

- Clear local state.
- Call `clearComposerDraft(conversationId, { sentAttachmentIds })`.
- `sentAttachmentIds` are now owned by the message and must be skipped by orphan
  cleanup.
- While the send request is in flight, `Composer` must keep a private
  submitting snapshot. If the user switches away before the request settles,
  unmount writes this snapshot to cache instead of the now-empty local composer
  refs. This prevents uploaded attachments that are being sent from being
  treated as abandoned drafts and deleted.

Submit error:

- Restore the local snapshot.
- Patch the restored text/caret and attachment rows back to cache. Do not call
  whole-entry `writeComposerDraft` from the submit error path, because another
  attachment upload may have completed and patched the cache while the send was
  in flight. Use `patchComposerDraftText` plus
  `upsertComposerDraftAttachment` for each restored chip.
- If the user starts a new edit while a previous send is still in flight, detach
  the submitting snapshot first by calling `dropSentAttachmentsFromDraft` with
  the submitted chip keys. This removes already-submitted rows from the draft
  without revoking preview URLs, deleting uploaded ids, emitting `clear`, or
  touching any new attachments the user added after submitting.

---

## 8. Cleanup Rules

The cache is responsible for cleanup whenever a draft entry leaves the cache:

- explicit `clearComposerDraft(conversationId)`
- submit success `clearComposerDraft(conversationId, { sentAttachmentIds })`
- LRU eviction
- `cleanupAllComposerDrafts()` on app unload
- attachment chip removal

Cleanup must:

1. Revoke preview URLs still owned by the draft.
2. For uploaded-but-unsent attachment ids:
   - call `releaseAttachmentPreview(id)`
   - call `deleteAttachmentBestEffort(id)` fire-and-forget
3. Leave `sentAttachmentIds` alone.

Empty snapshots should not consume LRU slots. If `text.trim()` is empty and
there are no pending attachments, remove the entry instead of storing it.

LRU eviction is based on `updatedAt`. After every write/patch, bump `updatedAt`
and evict until `drafts.size <= MAX_DRAFTS`.

---

## 9. Split View Behavior

Parent channel and thread split panes can both have mounted Composers. They use
different `conversationId` keys and therefore separate draft entries.

Switching the parent channel should flush the old parent Composer and hydrate the
new one. Switching the open thread should do the same for the thread Composer.

Directly opening a thread as the main view uses the thread's own
`conversationId`, same as split-pane thread mode.

---

## 10. Verification

Unit-test the cache module with mocked `apiUpload`, `setAttachmentBlobUrl`,
`releaseAttachmentPreview`, and `deleteAttachmentBestEffort`:

1. write/read restores text and caret
2. `MAX_DRAFTS = 10` evicts oldest entries
3. eviction cleans preview URLs and orphan uploaded ids
4. upload success patches a cached entry after the Composer would have unmounted
5. upload error preserves `file` and `previewUrl`
6. clear removes an entry and runs cleanup
7. empty snapshots are not stored

Manual checks:

1. Type text in channel A, switch to channel B, switch back to A: text and caret
   restore.
2. Attach an image, switch away after upload succeeds, switch back: chip and
   preview restore without re-uploading.
3. Attach a large image and switch away while uploading: returning later shows
   done or error, not a lost chip.
4. Parent channel and thread split drafts do not overwrite each other.
5. Sending a message clears only that conversation's draft.
6. Removing an uploaded unsent chip deletes the orphan attachment.

---

## 11. Implementation Order

1. Add `composer-draft-cache.ts` and cache unit tests.
2. Add `key={conversation.id}` at the `ChannelView` Composer boundary.
3. Hydrate/flush text and caret.
4. Remove `useUploadAttachment` from `Composer`; Composer should no longer own
   `pendingUrls` or `uploadedIds` refs.
5. Move attachment add/remove/retry ownership into the cache.
6. Move upload start/success/error handling into the cache.
7. Add app unload cleanup.
8. Run typecheck and targeted tests.

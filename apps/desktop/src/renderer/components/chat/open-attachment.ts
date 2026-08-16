import { toast } from 'sonner';
import type { AttachmentSnapshot } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { fetchAttachmentBytes, fetchBackendBytes } from '@/lib/api';

/**
 * Open-with-OS flow for a non-image chat attachment. Fetches bytes through
 * the authenticated backend proxy (no `URL.createObjectURL` in the chain —
 * `shell.openExternal` can't resolve a renderer-scoped `blob:` URL), hands
 * them to main over the `attachment:openExternal` IPC (which owns the
 * safe-extension allowlist + temp write + `shell.openPath`), and toasts /
 * inline-reports on failure. Image attachments open in the in-app Lightbox
 * instead and must NOT be routed here.
 *
 * Single source of truth shared between `MessageItem` (attachment tile),
 * `ChannelAttachmentsPanel` (Attachments list row), and the owner-audit
 * Chats pane ({@link openAuditAttachmentExternally}): all surfaces use the
 * same reason → user-facing string mapping and the same safe main-process
 * boundary, and all fail-visible rather than swallow errors silently.
 *
 * Errors surface through:
 *   1. `onInlineError(msg)` if provided — panels that carry their own
 *      inline error slot pass it (a per-row hint keeps the toast lane
 *      quiet in dense lists).
 *   2. `toast.error(msg)` otherwise — used by the message tile.
 *
 * Exported for testing.
 */
export async function openAttachmentExternally(
  attachment: Pick<AttachmentSnapshot, 'id' | 'filename'>,
  opts: OpenAttachmentOptions = {},
  deps: OpenAttachmentDeps = defaultDeps,
): Promise<void> {
  await openBytesExternally(
    () => deps.fetchBytes(attachment.id),
    attachment.filename,
    opts,
    deps,
  );
}

/**
 * Owner-audit variant (#task:2036 part ②): open an attachment that lives in a
 * conversation the owner is AUDITING (a third party's DM), not participating
 * in. Bytes come from the dedicated compound-gated audit face
 * (`agentChatAttachment`), NOT the membership-scoped `GET /api/attachments/:id`
 * (which would deny the owner on a third-party DM). The open action itself
 * reuses the exact same safe main-process boundary and failure mapping as the
 * membership path — the only difference is which bytes face is read. The
 * `filename` is the server/DTO-provided name (from the transcript snapshot);
 * no object URL is created anywhere in this chain.
 */
export async function openAuditAttachmentExternally(
  input: {
    agentId: string;
    conversationId: string;
    attachmentId: string;
    filename: string;
  },
  opts: OpenAttachmentOptions = {},
  deps: OpenAttachmentCoreDeps = defaultDeps,
): Promise<void> {
  const path = apiPaths.agentChatAttachment(
    input.agentId,
    input.conversationId,
    input.attachmentId,
  );
  await openBytesExternally(
    async () => fetchBackendBytes(path),
    input.filename,
    opts,
    deps,
  );
}

/** Shared core: obtain bytes (however the caller sources them), hand them to
 *  the safe main-process open boundary, and map any failure to a user-facing
 *  string. The membership and owner-audit entry points differ ONLY in the
 *  `fetchBytes` thunk they pass here. */
async function openBytesExternally(
  fetchBytes: () => Promise<{ bytes: Uint8Array }>,
  filename: string,
  opts: OpenAttachmentOptions,
  deps: OpenAttachmentCoreDeps,
): Promise<void> {
  try {
    const { bytes } = await fetchBytes();
    const result = await deps.open({ filename, bytes });
    if (result.ok) return;
    reportFailure(describeOpenFailure(result.reason), opts, deps);
  } catch (err) {
    reportFailure(formatOpenException(err), opts, deps);
  }
}

/** Translate a THROWN exception from the open path (fetch failed, IPC
 *  reject, etc.) into a user-facing string. Distinct from
 *  {@link describeOpenFailure}, which maps a canonical IPC `reason` code
 *  from main — a thrown error carries its own message and doesn't fit
 *  into the reason-code table. Kept exported so any attachment surface
 *  (row click, lightbox host, preview refetch) formats blob-fetch
 *  exceptions identically. */
export function formatOpenException(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Can't open the attachment: ${msg}`;
}

/** Translate the IPC failure reason into a user-facing string. Kept short —
 *  used both as a toast body and a tile's `title` hint. */
export function describeOpenFailure(reason: string): string {
  if (reason === 'unsafe_extension') {
    return "This file type can't be opened from Silverhand.";
  }
  if (reason.startsWith('open_failed')) {
    return 'macOS could not open this file.';
  }
  if (reason === 'empty_payload' || reason === 'invalid_payload') {
    return 'The attachment data is invalid.';
  }
  return reason;
}

function reportFailure(
  msg: string,
  opts: OpenAttachmentOptions,
  deps: OpenAttachmentCoreDeps,
): void {
  if (opts.onInlineError) {
    opts.onInlineError(msg);
    return;
  }
  deps.toastError(msg);
}

export interface OpenAttachmentOptions {
  /** Consumed by callers that render their own inline error slot (the
   *  message tile keeps this; the panel currently opts out and lets the
   *  toast fire). When absent the failure surfaces as a toast. */
  onInlineError?: (message: string) => void;
}

/** The half of the seam every open path shares: the safe OS boundary and the
 *  failure surface. The owner-audit path sources its own bytes and needs only
 *  this. */
export interface OpenAttachmentCoreDeps {
  open: (input: {
    filename: string;
    bytes: Uint8Array;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  toastError: (message: string) => void;
}

/** Injectable seam — production wiring below, tests supply mocks. The
 *  membership path additionally sources bytes by attachment id. */
export interface OpenAttachmentDeps extends OpenAttachmentCoreDeps {
  fetchBytes: (id: string) => Promise<{ bytes: Uint8Array }>;
}

const defaultDeps: OpenAttachmentDeps = {
  fetchBytes: id => fetchAttachmentBytes(id),
  open: input => window.silverhand.openAttachmentExternal(input),
  toastError: msg => {
    toast.error(msg);
  },
};

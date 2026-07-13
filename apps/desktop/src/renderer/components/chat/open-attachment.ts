import { toast } from 'sonner';
import type { AttachmentSnapshot } from '@silverhand/shared';
import { fetchAttachmentBytes } from '@/lib/api';

/**
 * Open-with-OS flow for a non-image chat attachment. Fetches bytes through
 * the authenticated backend proxy (no `URL.createObjectURL` in the chain —
 * `shell.openExternal` can't resolve a renderer-scoped `blob:` URL), hands
 * them to main over the `attachment:openExternal` IPC (which owns the
 * safe-extension allowlist + temp write + `shell.openPath`), and toasts /
 * inline-reports on failure. Image attachments open in the in-app Lightbox
 * instead and must NOT be routed here.
 *
 * Single source of truth shared between `MessageItem` (attachment tile) and
 * `ChannelAttachmentsPanel` (Attachments list row): both surfaces use the
 * same reason → user-facing string mapping, and both fail-visible rather
 * than swallow errors silently.
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
  try {
    const { bytes } = await deps.fetchBytes(attachment.id);
    const result = await deps.open({
      filename: attachment.filename,
      bytes,
    });
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
  return `打开失败：${msg}`;
}

/** Translate the IPC failure reason into a user-facing string. Kept short —
 *  used both as a toast body and a tile's `title` hint. */
export function describeOpenFailure(reason: string): string {
  if (reason === 'unsafe_extension') {
    return '该类型的文件不能直接在应用内打开（出于安全考虑）。';
  }
  if (reason.startsWith('open_failed')) {
    return '系统未能打开此文件。';
  }
  if (reason === 'empty_payload' || reason === 'invalid_payload') {
    return '附件数据无效。';
  }
  return reason;
}

function reportFailure(
  msg: string,
  opts: OpenAttachmentOptions,
  deps: OpenAttachmentDeps,
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

/** Injectable seam — production wiring below, tests supply mocks. */
export interface OpenAttachmentDeps {
  fetchBytes: (id: string) => Promise<{ bytes: Uint8Array }>;
  open: (input: {
    filename: string;
    bytes: Uint8Array;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  toastError: (message: string) => void;
}

const defaultDeps: OpenAttachmentDeps = {
  fetchBytes: id => fetchAttachmentBytes(id),
  open: input => window.agentHub.openAttachmentExternal(input),
  toastError: msg => {
    toast.error(msg);
  },
};

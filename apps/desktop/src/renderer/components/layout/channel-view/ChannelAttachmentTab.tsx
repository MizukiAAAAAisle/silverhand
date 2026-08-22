import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Download, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fetchAttachmentBytes } from '@/lib/api';
import { useAttachmentBlobToken } from '@/lib/attachment-blob-cache';
import { attachmentPreviewKind } from '@/lib/attachment-preview';
import { Markdown } from '@/components/chat/Markdown';
import { AttachmentHtmlPreview } from '@/components/chat/AttachmentHtmlPreview';
import { openAttachmentExternally } from '@/components/chat/open-attachment';
import { saveAttachmentToDisk } from '@/components/chat/save-attachment';

/**
 * The in-app previewer tab for a `.md` / `.html` attachment, keyed on the
 * attachment id so re-opening the same attachment focuses this tab rather than
 * minting another (dedupe lives in `conversation-tabs.ts`). The header's two
 * actions route through the trusted host IPC helpers (`openAttachmentExternally`
 * / `saveAttachmentToDisk`); the sandboxed HTML frame never receives those
 * capabilities.
 *
 * Bytes are fetched through the authenticated backend route on mount and again
 * whenever `useAttachmentBlobToken` bumps, so the id only locates and the
 * preview follows the current bytes. A same-attachment refetch keeps the shown
 * content until the new bytes are ready, and keeps it on failure, so only a
 * first mount shows the loader or an error pane. Markdown renders through
 * `Markdown`; HTML renders in the opaque-origin sandbox iframe
 * (`AttachmentHtmlPreview`).
 */
export interface ChannelAttachmentTabProps {
  attachmentId: string;
  filename: string;
  /** The `content_type` captured when the tab was opened. Used as the
   *  classification fallback; the freshly fetched type wins when present. */
  contentType: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; text: string; contentType: string }
  | { status: 'error'; message: string };

export function ChannelAttachmentTab({
  attachmentId,
  filename,
  contentType,
}: ChannelAttachmentTabProps): JSX.Element {
  const token = useAttachmentBlobToken(attachmentId);
  const revision = Number(token.split(':')[1] ?? 0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const shownRef = useRef<{ attachmentId: string; revision: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const shown = shownRef.current;
    const isRefresh = shown !== null && shown.attachmentId === attachmentId;
    // First mount (or a switch to a different attachment) shows the loader; a
    // same-attachment refetch keeps the shown content, so an in-place revision
    // never flashes a spinner.
    if (!isRefresh) setState({ status: 'loading' });
    fetchAttachmentBytes(attachmentId)
      .then(({ bytes, contentType: fetchedType }) => {
        if (cancelled) return;
        // Not `fatal` — a stray non-UTF-8 byte degrades to U+FFFD rather than
        // blanking the whole preview.
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        // Toast only on a genuine content revision — the revision segment rising,
        // not the reconnect epoch — so a bare reconnect never claims an update.
        const isRevisionBump =
          isRefresh &&
          shown !== null &&
          Number.isFinite(revision) &&
          revision > shown.revision;
        shownRef.current = { attachmentId, revision };
        setState({ status: 'ready', text, contentType: fetchedType });
        if (isRevisionBump) toast('Attachment auto-updated');
      })
      .catch(err => {
        if (cancelled) return;
        // A failed refetch keeps the content already on screen; only a first load
        // has nothing to fall back to, so only it surfaces the error.
        if (isRefresh) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [attachmentId, token]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-base">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary" title={filename}>
          {filename}
        </span>
        <button
          type="button"
          onClick={() => void openAttachmentExternally({ id: attachmentId, filename })}
          data-sticker
          data-sticker-size="md"
          data-sticker-tone="neutral"
          className="flex shrink-0 items-center gap-1.5 rounded-[var(--chip-radius)] px-2 py-1 text-xs text-text-secondary hover:text-text-primary focus-outline"
          title="Open in default app"
        >
          <ExternalLink className="size-3.5" />
          Open
        </button>
        <button
          type="button"
          onClick={() => void saveAttachmentToDisk({ id: attachmentId, filename })}
          data-sticker
          data-sticker-size="md"
          data-sticker-tone="neutral"
          className="flex shrink-0 items-center gap-1.5 rounded-[var(--chip-radius)] px-2 py-1 text-xs text-text-secondary hover:text-text-primary focus-outline"
          title="Download"
        >
          <Download className="size-3.5" />
          Download
        </button>
      </div>
      <AttachmentTabBody
        state={state}
        filename={filename}
        fallbackContentType={contentType}
      />
    </div>
  );
}

function AttachmentTabBody({
  state,
  filename,
  fallbackContentType,
}: {
  state: LoadState;
  filename: string;
  fallbackContentType: string;
}): JSX.Element {
  if (state.status === 'loading') {
    return <TabStatus>Loading…</TabStatus>;
  }
  if (state.status === 'error') {
    return <TabStatus>{state.message}</TabStatus>;
  }
  const kind = attachmentPreviewKind(state.contentType || fallbackContentType, filename);
  if (kind === 'html') {
    return (
      <div className="min-h-0 flex-1">
        <AttachmentHtmlPreview html={state.text} title={filename} />
      </div>
    );
  }
  if (kind === 'markdown') {
    return (
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <Markdown content={state.text} />
      </div>
    );
  }
  // Unreachable in normal flow — only md/html mint a previewer tab — but a
  // revised attachment could change type under a persisted tab; degrade to a
  // plain note rather than a blank pane (the header still offers open/download).
  return <TabStatus>No in-app preview for this file.</TabStatus>;
}

function TabStatus({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className={cn('flex min-h-0 flex-1 items-center justify-center p-6 text-xs text-text-muted')}>
      {children}
    </div>
  );
}

import { useEffect, useState } from 'react';
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
 * The previewer TAB for a `.md` / `.html` attachment (#task:2122) — the in-app
 * destination the member-main-pane MESSAGE CARD routes these two types to
 * instead of open-with-OS. Not an app-wide single destination: the Attachments
 * panel and the thread pane still OS-open md/html. Mounted per conversation from
 * `ChannelView`, keyed on the attachment id so re-opening the same attachment
 * focuses this same tab (dedupe lives in `conversation-tabs.ts`; this component
 * only renders one already-resolved tab).
 *
 * SHELL: a header (filename + open-in-default-app + download) over the rendered
 * body. The two header actions go through the SAME trusted host IPC helpers the
 * message card uses (`openAttachmentExternally` / `saveAttachmentToDisk`) — the
 * sandboxed HTML frame never gets those capabilities (B boundary, 2026-08-21).
 *
 * BODY: bytes are fetched through the authenticated backend route every mount —
 * the persisted attachment id only LOCATES; it is never pinned to first bytes.
 * `useAttachmentBlobToken` bumps on in-place revision (or a reconnect epoch),
 * re-running the fetch so the preview follows the current bytes. Markdown
 * renders through the shared `Markdown`; HTML renders in the opaque-origin
 * sandbox iframe (`AttachmentHtmlPreview`).
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
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchAttachmentBytes(attachmentId)
      .then(({ bytes, contentType: fetchedType }) => {
        if (cancelled) return;
        // Not `fatal` — a stray non-UTF-8 byte degrades to U+FFFD rather than
        // blanking the whole preview.
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        setState({ status: 'ready', text, contentType: fetchedType });
      })
      .catch(err => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
    // `token` re-runs the fetch when the bytes are revised in place (#task:1769).
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

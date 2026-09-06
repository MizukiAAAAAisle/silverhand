import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Download, ExternalLink, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fetchAttachmentBytes } from '@/lib/api';
import { useAttachmentBlobToken } from '@/lib/attachment-blob-cache';
import { attachmentPreviewKind } from '@/lib/attachment-preview';
import { usePinchZoomLease } from '@/lib/pinch-zoom-lease';
import { toastIcon } from '@/lib/toast-icons';
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

// Continuous host zoom for the HTML preview. Min below 100% so a fixed-size
// author page can shrink into the pane; the slider and pinch move it
// continuously, the buttons step it by a fixed multiplier.
const HTML_ZOOM_MIN = 0.25;
const HTML_ZOOM_MAX = 2;
const HTML_ZOOM_STEP = 1.25;
const clampHtmlZoom = (value: number): number =>
  Math.min(HTML_ZOOM_MAX, Math.max(HTML_ZOOM_MIN, value));

/**
 * Zoom last used for each attachment, so reopening one resumes where you left
 * it instead of snapping back to 100% (#task:2163). Keyed by attachment id and
 * scoped to the renderer session — the id only locates, so a revised attachment
 * keeps the zoom the reader chose for it. Deliberately NOT persisted to disk:
 * a stale ratio surviving a restart is more surprising than re-setting it once.
 */
const htmlZoomByAttachment = new Map<string, number>();
const storedHtmlZoom = (attachmentId: string): number =>
  htmlZoomByAttachment.get(attachmentId) ?? 1;

export function ChannelAttachmentTab({
  attachmentId,
  filename,
  contentType,
}: ChannelAttachmentTabProps): JSX.Element {
  const token = useAttachmentBlobToken(attachmentId);
  const revision = Number(token.split(':')[1] ?? 0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [htmlZoom, setHtmlZoom] = useState(() => storedHtmlZoom(attachmentId));
  const shownRef = useRef<{ attachmentId: string; revision: number } | null>(null);
  // Read during render so a zoom committed in the same tick keys off the
  // attachment on screen, not the one a stale closure captured.
  const attachmentIdRef = useRef(attachmentId);
  attachmentIdRef.current = attachmentId;

  // Single commit path for every zoom source (slider, buttons, pinch): clamp,
  // remember it for this attachment, then render it.
  const zoomTo = useCallback((raw: number): void => {
    const next = clampHtmlZoom(raw);
    htmlZoomByAttachment.set(attachmentIdRef.current, next);
    setHtmlZoom(next);
  }, []);

  // Trackpad pinch arrives as a merged `deltaY`; the exponential maps it to a
  // multiplicative factor (pinch-out sends deltaY negative → factor > 1). The
  // current zoom comes from the store rather than a closure, so the callback
  // stays stable for the preview's listener.
  const onPinch = useCallback(
    (deltaY: number): void => {
      zoomTo(storedHtmlZoom(attachmentIdRef.current) * Math.exp(-deltaY / 100));
    },
    [zoomTo],
  );

  useEffect(() => {
    setHtmlZoom(storedHtmlZoom(attachmentId));
  }, [attachmentId]);

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
        if (isRevisionBump)
          toast('Attachment auto-updated', { icon: toastIcon('attachment') });
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

  const readyKind =
    state.status === 'ready'
      ? attachmentPreviewKind(state.contentType || contentType, filename)
      : null;
  const atMinZoom = htmlZoom <= HTML_ZOOM_MIN + 1e-3;
  const atMaxZoom = htmlZoom >= HTML_ZOOM_MAX - 1e-3;
  usePinchZoomLease(readyKind === 'html');

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-base">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary" title={filename}>
          {filename}
        </span>
        {readyKind === 'html' ? (
          <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Zoom">
            <button
              type="button"
              data-sticker
              data-sticker-size="md"
              data-sticker-tone="neutral"
              className="flex size-7 shrink-0 items-center justify-center rounded-[var(--chip-radius)] text-text-secondary hover:text-text-primary focus-outline disabled:opacity-40"
              onClick={() => zoomTo(htmlZoom / HTML_ZOOM_STEP)}
              disabled={atMinZoom}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <ZoomOut className="size-3.5" />
            </button>
            <input
              type="range"
              data-settings-slider
              className="settings-font-size-slider w-24"
              min={HTML_ZOOM_MIN * 100}
              max={HTML_ZOOM_MAX * 100}
              step="any"
              value={htmlZoom * 100}
              aria-label="Zoom level"
              onChange={e => zoomTo(Number(e.target.value) / 100)}
            />
            <button
              type="button"
              data-sticker
              data-sticker-size="md"
              data-sticker-tone="neutral"
              className="flex size-7 shrink-0 items-center justify-center rounded-[var(--chip-radius)] text-text-secondary hover:text-text-primary focus-outline disabled:opacity-40"
              onClick={() => zoomTo(htmlZoom * HTML_ZOOM_STEP)}
              disabled={atMaxZoom}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <ZoomIn className="size-3.5" />
            </button>
            <span className="min-w-[2.75rem] text-center text-xs tabular-nums text-text-secondary">
              <span className="sr-only">Zoom </span>
              {Math.round(htmlZoom * 100)}%
            </span>
          </div>
        ) : null}
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
        htmlZoom={htmlZoom}
        onPinch={onPinch}
      />
    </div>
  );
}

function AttachmentTabBody({
  state,
  filename,
  fallbackContentType,
  htmlZoom,
  onPinch,
}: {
  state: LoadState;
  filename: string;
  fallbackContentType: string;
  htmlZoom: number;
  onPinch: (deltaY: number) => void;
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
        <AttachmentHtmlPreview html={state.text} title={filename} zoom={htmlZoom} onPinch={onPinch} />
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

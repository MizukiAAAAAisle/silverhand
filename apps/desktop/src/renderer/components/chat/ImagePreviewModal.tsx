import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { toPng } from 'html-to-image';
import { toast } from 'sonner';
import type { AgentDto, MessageDto, UserDto } from '@silverhand/shared';
import { MessageScreenshotView } from './MessageScreenshotView';
import { suggestImageFilename } from './markdownTranscript';
import { SelectionActionButton } from './SelectionToolbar';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';

/** 1×1 transparent PNG. Used as html-to-image's `imagePlaceholder` so a
 *  single failed avatar doesn't abort the whole screenshot. */
const TRANSPARENT_PIXEL_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

/** html-to-image rejects from its image-embed step with the raw DOM
 *  `Event` (the one passed to `<img>.onerror`). Decode it into a
 *  message that names the failing source so the user sees something
 *  useful instead of "[object Event]". Anything we can't decode falls
 *  back to a stable label rather than the toString shape. */
function formatCaptureFailure(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const target = err.target as HTMLImageElement | null;
    const src = target && 'src' in target ? target.src : '';
    if (src) return `图像加载失败：${truncate(src, 96)}`;
    return `图像加载失败 (${err.type})`;
  }
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; type?: unknown };
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
    if (typeof e.type === 'string') return `事件 ${e.type}`;
  }
  return 'unknown_error';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Image-export preview modal.
 *
 * On mount we render a hidden `MessageScreenshotView` for the selected
 * messages, run html-to-image once, and stash both:
 *   - `pngBytes: Uint8Array` — the IPC payload for save / copy
 *   - `dataUrl: string` — the `<img src>` attribute used for the visible
 *     preview
 *
 * Copy and Save reuse the SAME bytes (Cindy review #4): we never
 * re-capture, so what the user sees in the preview is exactly what
 * lands on disk / clipboard.
 *
 * The visible scroller shows a downscaled copy of the dataUrl so the
 * preview fits the modal even for tall transcripts. The captured PNG
 * itself is at the screenshot view's natural width (760px container).
 */
export function ImagePreviewModal({
  open,
  onOpenChange,
  onExportComplete,
  messages,
  channelTitle,
  channelKind,
  agentsById,
  agentsByName,
  humansByName,
  channelsByName,
  conversationRefsById,
  agentAvatarUrls,
  viewer,
  viewerAvatarObjectUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful export (Copy or Save). The parent
   *  uses this to exit selection mode — shiki `el2J5BByCR02Cy07`:
   *  完成 export 后需要主动取消多选回到正常状态。Cancel and the
   *  Save dialog's user-cancel path do NOT fire this callback so
   *  retrying stays cheap. */
  onExportComplete?: () => void;
  messages: readonly MessageDto[];
  channelTitle: string | null;
  channelKind: 'channel' | 'dm' | null;
  agentsById: ReadonlyMap<string, AgentDto>;
  agentsByName: ReadonlyMap<string, AgentDto>;
  humansByName?: ReadonlyMap<string, UserDto>;
  channelsByName?: ReadonlyMap<string, ChannelReference | null>;
  conversationRefsById?: ReadonlyMap<string, ConversationReference>;
  agentAvatarUrls?: ReadonlyMap<string, string | null>;
  viewer?: UserDto;
  viewerAvatarObjectUrl?: string | null;
}): JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'rendering' | 'ready' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [pngBytes, setPngBytes] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState(false);
  // Offscreen container ref — html-to-image runs against this DOM
  // subtree. We position it offscreen rather than `display:none` so
  // layout actually computes (display:none zeroes intrinsic sizes).
  const offscreenRef = useRef<HTMLDivElement | null>(null);

  // Run capture once per open. We deliberately depend on `open` not on
  // `messages` because messages identity is stable for the lifetime of
  // a single open request (selection is frozen at toolbar-click time).
  useEffect(() => {
    if (!open) {
      setPhase('idle');
      setError(null);
      setDataUrl(null);
      setPngBytes(null);
      return;
    }
    setPhase('rendering');
    setError(null);

    // Wait one frame so React has actually committed the offscreen
    // node + Markdown rendered its content; toPng on an empty tree
    // produces a blank PNG.
    let cancelled = false;
    const runCapture = (): void => {
      const node = offscreenRef.current;
      if (!node) {
        if (!cancelled) setError('screenshot_root_missing');
        return;
      }
      toPng(node, {
        pixelRatio: 2,
        // `cacheBust: true` appends `?cb=<ts>` to every <img> src so the
        // embed pass re-fetches a clean copy. That breaks blob: URLs
        // (avatars come through `URL.createObjectURL`) — querystrings on
        // blob URLs make the resource non-findable. shiki
        // `cKM3NLjAQU-idOWD` saw "渲染失败：[object Event]" because an
        // <img> ended up with `blob:...?cb=...` and fired `onerror`.
        // Static React tree → cache-busting buys us nothing anyway.
        cacheBust: false,
        // 1×1 transparent PNG. When an individual <img> still fails to
        // load (revoked object URL, denied CORS, missing file), the
        // embed pass swaps in this placeholder rather than rejecting
        // the whole capture. We'd rather ship a screenshot with one
        // gap than zero screenshot at all — single-avatar failures
        // should not block the user's share flow.
        imagePlaceholder: TRANSPARENT_PIXEL_DATA_URL,
        // The offscreen container's background is already token-driven
        // via Tailwind, but html-to-image renders transparent areas as
        // alpha by default. Force an explicit canvas color so themes
        // with a non-white bg-floating still produce a sensible PNG.
        backgroundColor: '#ffffff',
      })
        .then(async url => {
          if (cancelled) return;
          // Strip the `data:image/png;base64,` prefix and decode to raw
          // bytes. We keep both forms: dataUrl for the preview <img>,
          // bytes for the IPC save / copy handlers.
          const base64 = url.split(',', 2)[1] ?? '';
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          setDataUrl(url);
          setPngBytes(bytes);
          setPhase('ready');
        })
        .catch(err => {
          if (cancelled) return;
          // html-to-image's image-embed phase rejects with the raw DOM
          // `Event` from `<img>.onerror` rather than an `Error`. A
          // naive `String(err)` would surface "[object Event]" to the
          // user (shiki `cKM3NLjAQU-idOWD`). Decode the event so the
          // toast / error banner reports something actionable.
          setError(formatCaptureFailure(err));
          setPhase('error');
        });
    };
    const raf = requestAnimationFrame(() => {
      // One more frame — the first commit only mounts the JSX; React
      // 18 with concurrent rendering may still be flushing styles.
      requestAnimationFrame(runCapture);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const suggestedName = suggestImageFilename(messages, channelTitle);

  const onCopy = async (): Promise<void> => {
    if (!pngBytes || busy) return;
    setBusy(true);
    try {
      const result = await window.agentHub.copyPngExport({ pngBytes });
      if (result.ok) {
        toast.success('图片已复制到剪贴板');
        onExportComplete?.();
        onOpenChange(false);
      } else {
        toast.error('复制失败：' + result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const onSave = async (): Promise<void> => {
    if (!pngBytes || busy) return;
    setBusy(true);
    try {
      const result = await window.agentHub.savePngExport({
        pngBytes,
        suggestedName,
      });
      if (result.ok) {
        toast.success('已保存：' + result.path);
        onExportComplete?.();
        onOpenChange(false);
      } else if ('canceled' in result && result.canceled) {
        // user dismissed dialog — silent, keep selection so they can retry
      } else if ('error' in result) {
        toast.error('保存失败：' + result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] flex max-h-[80vh] w-[820px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--floating-radius,var(--radius-md))] border-[length:var(--control-border-width)] border-[color:var(--border-row-selected)] bg-bg-floating p-4 shadow-xl">
          <Dialog.Title className="text-sm font-semibold text-text-primary">
            图片预览
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-text-muted">
            {messages.length === 0 ? '请选择至少一条消息' : ''}
          </Dialog.Description>

          <div className="mt-3 min-h-[200px] flex-1 overflow-auto rounded-[var(--control-radius)] border border-border-subtle bg-bg-elevated p-2">
            {phase === 'rendering' || phase === 'idle' ? (
              <div className="flex h-full items-center justify-center text-xs text-text-muted">
                渲染中…
              </div>
            ) : phase === 'error' ? (
              <div className="flex h-full items-center justify-center text-xs text-error">
                渲染失败：{error}
              </div>
            ) : dataUrl ? (
              <img
                src={dataUrl}
                alt="export preview"
                className="block max-w-full"
              />
            ) : null}
          </div>

          <div className="mt-3 flex items-center justify-end gap-2 text-xs">
            <SelectionActionButton
              variant="neutral"
              label="Cancel"
              onClick={() => onOpenChange(false)}
            />
            <SelectionActionButton
              variant="primary"
              label="Copy"
              disabled={phase !== 'ready' || busy}
              onClick={onCopy}
            />
            <SelectionActionButton
              variant="primary"
              label="Save"
              disabled={phase !== 'ready' || busy}
              onClick={onSave}
            />
          </div>

          {/* Offscreen render target. Positioned far off-canvas so the
              layout still computes (display:none would zero the
              intrinsic height) without paint cost or visual noise.
              html-to-image walks this subtree once per open. */}
          <div
            aria-hidden
            style={{
              position: 'fixed',
              top: '-99999px',
              left: '-99999px',
              pointerEvents: 'none',
            }}
          >
            <div ref={offscreenRef}>
              <MessageScreenshotView
                messages={messages}
                channelTitle={channelTitle}
                channelKind={channelKind}
                agentsById={agentsById}
                agentsByName={agentsByName}
                humansByName={humansByName}
                channelsByName={channelsByName}
                conversationRefsById={conversationRefsById}
                agentAvatarUrls={agentAvatarUrls}
                viewer={viewer}
                viewerAvatarObjectUrl={viewerAvatarObjectUrl}
              />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

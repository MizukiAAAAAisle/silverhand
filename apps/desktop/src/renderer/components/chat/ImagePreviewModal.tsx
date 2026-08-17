import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { toPng } from 'html-to-image';
import { toast } from 'sonner';
import type {
  AgentDto,
  MessageDto,
  TaskSummaryDto,
  UserDto,
} from '@silverhand/shared';
import { loadAttachmentBlobUrl } from '@/lib/attachment-blob-cache';
import {
  taskBoardCacheScope,
  taskByNumberKey,
  type TaskRefCoord,
} from '@/features/tasks/useTaskByNumber';
import { MessageScreenshotView } from './MessageScreenshotView';
import {
  extractMermaidSources,
  isDarkTheme,
  renderMermaidSvg,
} from './MermaidDiagram';
import { suggestImageFilename } from './markdownTranscript';
import { SelectionActionButton } from './SelectionToolbar';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';
import type { StaticTaskRefSummary } from './TaskRef';

/** 1×1 transparent PNG. Used as html-to-image's `imagePlaceholder` so a
 *  single failed avatar doesn't abort the whole screenshot. */
const TRANSPARENT_PIXEL_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

/** Per-diagram pre-render budget (#task:1322). A diagram that doesn't settle
 *  within this bound is treated as failed → falls back to source, so a single
 *  stuck mermaid render can never hang the whole "share as image" flow. This
 *  is what makes "always produces an image" bounded rather than a bet that
 *  every diagram resolves promptly (Alice's review point). */
const MERMAID_PRERENDER_TIMEOUT_MS = 4000;

/**
 * Pre-render every Mermaid diagram in the selected messages to SVG, off-screen
 * and BEFORE the html-to-image capture (#task:1322). Reuses the live render
 * entry (`renderMermaidSvg`) + the active theme so the exported diagram matches
 * what's on screen. Returns a map (trimmed source → SVG) of only the diagrams
 * that succeeded within the timeout; any that fail or time out are simply
 * absent, so the export tree falls back to source for them. Never rejects —
 * the share flow must always reach capture.
 */
async function prerenderMermaidSvgs(
  messages: readonly MessageDto[],
): Promise<Map<string, string>> {
  const sources = Array.from(
    new Set(messages.flatMap(m => extractMermaidSources(m.content))),
  );
  const map = new Map<string, string>();
  if (sources.length === 0) return map;
  const dark = isDarkTheme();
  const results = await Promise.allSettled(
    sources.map(src =>
      Promise.race([
        renderMermaidSvg(src, dark),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('mermaid pre-render timeout')),
            MERMAID_PRERENDER_TIMEOUT_MS,
          ),
        ),
      ]),
    ),
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') map.set(sources[i]!, r.value);
  });
  return map;
}

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
    if (src) return `The image failed to load: ${truncate(src, 96)}`;
    return `The image failed to load (${err.type})`;
  }
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; type?: unknown };
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
    if (typeof e.type === 'string') return `Event ${e.type}`;
  }
  return 'unknown_error';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function screenshotCanvasBackground(node: HTMLElement): string {
  const screenshotRoot =
    node.querySelector<HTMLElement>('[data-screenshot-root]') ?? node;
  const foreground = parseRgbColor(
    window.getComputedStyle(screenshotRoot).backgroundColor,
  );
  if (!foreground) return '#ffffff';
  const base =
    parseRgbColor(resolveBackgroundColor(screenshotRoot, 'var(--bg-base)')) ??
    parseRgbColor(window.getComputedStyle(document.body).backgroundColor) ??
    { r: 255, g: 255, b: 255, a: 1 };
  const opaqueBase =
    base.a >= 1 ? base : compositeOver(base, { r: 255, g: 255, b: 255, a: 1 });
  const out =
    foreground.a >= 1 ? foreground : compositeOver(foreground, opaqueBase);
  return `rgb(${out.r}, ${out.g}, ${out.b})`;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function resolveBackgroundColor(context: HTMLElement, value: string): string {
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.pointerEvents = 'none';
  probe.style.backgroundColor = value;
  context.appendChild(probe);
  const resolved = window.getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}

function parseRgbColor(value: string): Rgba | null {
  const s = value.trim();
  if (!s || s === 'transparent') return null;
  const match = /^rgba?\((.+)\)$/i.exec(s);
  if (!match) return null;
  const parts = match[1]!
    .split(/[,\s/]+/)
    .map(part => part.trim())
    .filter(Boolean);
  const [rRaw, gRaw, bRaw, aRaw] = parts;
  const r = Number(rRaw);
  const g = Number(gRaw);
  const b = Number(bRaw);
  if (![r, g, b].every(Number.isFinite)) return null;
  const a = aRaw === undefined ? 1 : Number(aRaw);
  return {
    r: clampByte(r),
    g: clampByte(g),
    b: clampByte(b),
    a: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1,
  };
}

function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 255, g: 255, b: 255, a: 1 };
  return {
    r: clampByte((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a),
    g: clampByte((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a),
    b: clampByte((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a),
    a,
  };
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
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
  workspaceId,
  conversationId,
  channelTitle,
  agentsByName,
  humansByName,
  channelsByName,
  conversationRefsById,
  agentAvatarUrls,
  authorAgentAvatarUrls,
  authorUserAvatarUrls,
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
  /** The workspace the exported messages belong to, or `null` for a DirectPair
   *  (which has no workspace). Required — not optional — so the sole production
   *  chain always names the placement and the snapshot can never silently fall
   *  back to a wrong cache scope. */
  workspaceId: string | null;
  /** The conversation the exported messages belong to (all share one). `string`,
   *  not `string | null`: every pane that can open this modal is looking at a
   *  conversation, so "no conversation" is not a production state and must not
   *  survive in the type (@Cindy, #task:2041 B3). With `workspaceId` — the only
   *  legitimately nullable half — it projects the by-number cache scope so the
   *  static snapshot reads the SAME cell the live chip did; a DM (workspaceId
   *  null) keys on the pair conversation instead of dropping every task title. */
  conversationId: string;
  channelTitle: string | null;
  agentsByName: ReadonlyMap<string, AgentDto>;
  humansByName?: ReadonlyMap<string, UserDto>;
  channelsByName?: ReadonlyMap<string, ChannelReference | null>;
  conversationRefsById?: ReadonlyMap<string, ConversationReference>;
  /** Directory avatar batch — feeds only the Markdown body's inline
   *  @-mention pills (a separate axis from the row's own author). */
  agentAvatarUrls?: ReadonlyMap<string, string | null>;
  /** Byline avatar bytes derived from each row's own author DTO
   *  (#task:1792 B2), split by kind. */
  authorAgentAvatarUrls?: ReadonlyMap<string, string | null>;
  authorUserAvatarUrls?: ReadonlyMap<string, string | null>;
  viewer?: UserDto;
  viewerAvatarObjectUrl?: string | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'rendering' | 'ready' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [pngBytes, setPngBytes] = useState<Uint8Array | null>(null);
  const [attachmentImageUrls, setAttachmentImageUrls] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [taskRefsByNumber, setTaskRefsByNumber] = useState<
    ReadonlyMap<number, StaticTaskRefSummary>
  >(() => new Map());
  const [mermaidSvgByCode, setMermaidSvgByCode] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
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
      setAttachmentImageUrls(new Map());
      setTaskRefsByNumber(new Map());
      setMermaidSvgByCode(new Map());
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
      const backgroundColor = screenshotCanvasBackground(node);
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
        // Match the rendered screenshot root instead of hard-coding
        // white. The root itself uses theme tokens (`bg-bg-floating`);
        // this option only fills transparent canvas edges / gaps.
        backgroundColor,
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
    const rafs: number[] = [];
    const taskRefs = snapshotStaticTaskRefs(
      messages,
      { workspaceId, conversationId },
      queryClient,
    );
    void Promise.all([
      preloadImageAttachments(messages),
      // Pre-render Mermaid diagrams to SVG off-screen and wait for ALL of them
      // to settle (ok/error/timeout) before capture, so the static tree html-
      // to-image walks already contains the finished diagrams (#task:1322).
      // Never rejects — failures/timeouts just fall back to source.
      prerenderMermaidSvgs(messages),
    ]).then(([urls, mermaidSvgs]) => {
      if (cancelled) return;
      setAttachmentImageUrls(urls);
      setTaskRefsByNumber(taskRefs);
      setMermaidSvgByCode(mermaidSvgs);
      rafs.push(
        requestAnimationFrame(() => {
          // One more frame — the first commit only mounts the JSX; React
          // 18 with concurrent rendering may still be flushing styles.
          rafs.push(requestAnimationFrame(runCapture));
        }),
      );
    });
    return () => {
      cancelled = true;
      for (const raf of rafs) cancelAnimationFrame(raf);
    };
  }, [open]);

  const suggestedName = suggestImageFilename(messages, channelTitle);

  const onCopy = async (): Promise<void> => {
    if (!pngBytes || busy) return;
    setBusy(true);
    try {
      const result = await window.silverhand.copyPngExport({ pngBytes });
      if (result.ok) {
        toast.success('Image copied to clipboard');
        onExportComplete?.();
        onOpenChange(false);
      } else {
        toast.error("Couldn't copy: " + result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const onSave = async (): Promise<void> => {
    if (!pngBytes || busy) return;
    setBusy(true);
    try {
      const result = await window.silverhand.savePngExport({
        pngBytes,
        suggestedName,
      });
      if (result.ok) {
        toast.success('Saved to ' + result.path);
        onExportComplete?.();
        onOpenChange(false);
      } else if ('canceled' in result && result.canceled) {
        // user dismissed dialog — silent, keep selection so they can retry
      } else if ('error' in result) {
        toast.error("Couldn't save: " + result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-lightbox)] bg-black/40" />
        <Dialog.Content data-modal-shell className="fixed left-1/2 top-1/2 z-[var(--z-lightbox-chrome)] flex max-h-[80vh] w-[820px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--floating-radius,var(--radius-md))] bg-bg-floating p-4 shadow-xl">
          <div className="flex items-center gap-2">
            <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              Image Preview
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              data-sticker-close
              className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted hover:bg-bg-hover hover:text-text-primary focus-outline"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 text-xs text-text-muted">
            {messages.length === 0 ? 'Select at least one message' : ''}
          </Dialog.Description>

          <div className="mt-3 min-h-[200px] flex-1 overflow-auto rounded-[var(--control-radius)] border border-border-subtle bg-bg-elevated p-2">
            {phase === 'rendering' || phase === 'idle' ? (
              <div className="flex h-full items-center justify-center text-xs text-text-muted">
                Rendering…
              </div>
            ) : phase === 'error' ? (
              <div className="flex h-full items-center justify-center text-xs text-error">
                Couldn't render: {error}
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
              rank="secondary"
              label="Copy"
              disabled={phase !== 'ready' || busy}
              onClick={onCopy}
            />
            <SelectionActionButton
              rank="primary"
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
                agentsByName={agentsByName}
                humansByName={humansByName}
                channelsByName={channelsByName}
                conversationRefsById={conversationRefsById}
                taskRefsByNumber={taskRefsByNumber}
                agentAvatarUrls={agentAvatarUrls}
                authorAgentAvatarUrls={authorAgentAvatarUrls}
                authorUserAvatarUrls={authorUserAvatarUrls}
                attachmentImageUrls={attachmentImageUrls}
                viewer={viewer}
                viewerAvatarObjectUrl={viewerAvatarObjectUrl}
                mermaidSvgByCode={mermaidSvgByCode}
              />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const TASK_REF_RE = /#task:([1-9]\d*)(?!\w)/g;

function extractTaskNumbers(messages: readonly MessageDto[]): number[] {
  const numbers = new Set<number>();
  for (const message of messages) {
    let match: RegExpExecArray | null;
    TASK_REF_RE.lastIndex = 0;
    while ((match = TASK_REF_RE.exec(message.content)) !== null) {
      const n = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(n) && n > 0) numbers.add(n);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * The pure snapshot seam behind the image export: freeze the CURRENT resolved
 * title of every `#task:<n>` in the selected messages, read from the by-number
 * cache under the conversation's own board scope.
 *
 * Exported so the scope decision is falsifiable WITHOUT a DOM capture: the
 * `MessageScreenshotView` render test only proves how a given title draws, not
 * which cache cell the title came from. The bug this guards is silent — a wrong
 * scope reads an empty cell and every task ref exports as a bare number with no
 * title, which no pixel test would flag.
 *
 * Scope is projected by `taskBoardCacheScope`, exactly as the live `TaskRef`
 * does: a workspace-placed conversation keys on `workspace:<workspaceId>` (NOT
 * on its conversation id), a DirectPair — with no workspace — keys on
 * `direct_pair:<conversationId>`.
 *
 * It takes the whole `TaskRefCoord`, whose `conversationId` is nullable, because
 * this is the general seam over that shared coordinate type and a coordinate that
 * names no board has exactly one right answer: snapshot nothing. That is a
 * property OF THE SEAM, not a state the modal above can be in — its own prop is
 * `string`, so a caller cannot reach the empty-scope arm from production
 * (@Cindy, #task:2041 B3).
 */
export function snapshotStaticTaskRefs(
  messages: readonly MessageDto[],
  coord: TaskRefCoord,
  queryClient: QueryClient,
): ReadonlyMap<number, StaticTaskRefSummary> {
  const scope = taskBoardCacheScope(coord);
  if (!scope) return new Map();
  const taskNumbers = extractTaskNumbers(messages);
  if (taskNumbers.length === 0) return new Map();
  const out = new Map<number, StaticTaskRefSummary>();
  for (const taskNumber of taskNumbers) {
    const task = queryClient.getQueryData<TaskSummaryDto | null>(
      taskByNumberKey(scope, taskNumber),
    );
    if (!task) continue;
    out.set(taskNumber, {
      task_number: task.task_number,
      title: task.title,
    });
  }
  return out;
}

async function preloadImageAttachments(
  messages: readonly MessageDto[],
): Promise<ReadonlyMap<string, string>> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.content_type.startsWith('image/')) ids.add(attachment.id);
    }
  }
  if (ids.size === 0) return new Map();
  const entries = await Promise.all(
    Array.from(ids, async id => {
      try {
        return [id, await loadAttachmentBlobUrl(id)] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [string, string] => entry !== null,
    ),
  );
}

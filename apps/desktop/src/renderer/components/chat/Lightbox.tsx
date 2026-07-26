import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Download, X, ZoomIn, ZoomOut } from 'lucide-react';
import { toast } from 'sonner';
import { SelectionActionButton } from './SelectionToolbar';

interface LightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  alt: string;
  /**
   * Optional save-as callback. When provided, the footer shows a
   * "Download" action alongside "Copy". Omitted for the composer's
   * pre-send preview (the file is on the user's disk already, so
   * save-as is not a meaningful action there).
   */
  onDownload?: () => void | Promise<void>;
}

/** Zoom baseline = fit-to-window (100%). Zoom only grows the image above
 *  fit — below fit is just a tiny image in an empty box, no use — so
 *  MIN is the fit and "zoom out" walks back down toward it. */
const MIN_SCALE = 1;
const MAX_SCALE = 5;
/** Per-click multiplier for the +/− buttons and the +/− keys. */
const STEP = 1.25;
/** Horizontal + vertical padding of the image well (`p-3` = 12px each side),
 *  subtracted from the container's client box to get the fit area. */
const WELL_PADDING = 24;

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/**
 * Image preview modal. A framed modal shell (forza6 picks up the poster
 * `data-modal-shell` chrome — 2px ink frame + hard drop shadow — exactly
 * like the export preview modal) with a header ("Image Preview" title +
 * a close icon on the right), the image well, and a bottom action bar
 * (zoom controls left, Copy/Download right).
 *
 * The shell is a FIXED `min(920px, 88vw)` × `82vh` viewport (it does not
 * grow with the image). At rest the image is fit-to-window inside the well.
 * Zoom (pinch / slider / `+` `−` buttons / `+` `−` `0` keys) sets the image's
 * *actual* rendered size to `fit × scale`, so past 100% it overflows the
 * `overflow-auto` well and the user scrolls both axes (or drags) to inspect
 * detail (shiki 2026-07-22). Zoom keeps the viewport centre fixed. Trackpad
 * pinch is enabled per-frame only while open (macOS Electron disables it by
 * default); a plain wheel / swipe is left to scroll the well. Backdrop click +
 * Escape close (Radix defaults).
 *
 * Copy reuses the `export:copyPng` IPC (`copyPngExport`): we fetch the
 * blob bytes behind `src` and let main build an NSImage + write the OS
 * pasteboard — the same path the screenshot export uses, which is far
 * more reliable than renderer-side `navigator.clipboard.write` for
 * images on Electron/macOS. nativeImage decodes PNG/JPEG; an
 * undecodable format surfaces a toast rather than failing silently.
 */
export function Lightbox({
  open,
  onOpenChange,
  src,
  alt,
  onDownload,
}: LightboxProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // `scale` = 1 is fit-to-window. `fit` is the on-screen size the image
  // takes at scale 1 (computed from its natural size + the well): the
  // rendered size is `fit × scale`, so at scale 1 it fits exactly and above
  // it overflows into native scroll. `dragging` toggles the grab cursor.
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const wellRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const scaleRef = useRef(1);
  // Viewport-centre fraction captured just before a zoom, re-applied after
  // the image resizes so zoom stays anchored on the middle of the view.
  const pendingCenterRef = useRef<{ fx: number; fy: number } | null>(null);
  // Drag-to-pan origin: pointer + scroll offset captured at pointerdown.
  const dragRef = useRef<{ px: number; py: number; sl: number; st: number } | null>(null);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // Reset zoom whenever the modal opens or the image changes — a stale zoom
  // carried into a different image would open it mid-scroll.
  useEffect(() => {
    setScale(1);
    setFit(null);
    pendingCenterRef.current = null;
  }, [open, src]);

  // Fit = the image's natural size scaled down (never up) to sit inside the
  // well. Recomputed on load + on well resize so it tracks the window. macOS
  // overlay scrollbars don't consume layout width, so a zoomed-in scrollbar
  // doesn't shrink the well and feed back into fit.
  const computeFit = useCallback((): void => {
    const c = wellRef.current;
    const im = imgRef.current;
    if (!c || !im || !im.naturalWidth || !im.naturalHeight) return;
    const availW = Math.max(1, c.clientWidth - WELL_PADDING);
    const availH = Math.max(1, c.clientHeight - WELL_PADDING);
    const k = Math.min(availW / im.naturalWidth, availH / im.naturalHeight, 1);
    setFit({ w: im.naturalWidth * k, h: im.naturalHeight * k });
  }, []);

  useEffect(() => {
    const c = wellRef.current;
    if (!c) return;
    computeFit(); // cover an already-cached image whose onLoad won't refire
    const ro = new ResizeObserver(() => computeFit());
    ro.observe(c);
    return () => ro.disconnect();
  }, [open, computeFit]);

  const setZoom = useCallback((raw: number): void => {
    const c = wellRef.current;
    if (c) {
      const sw = c.scrollWidth || 1;
      const sh = c.scrollHeight || 1;
      pendingCenterRef.current = {
        fx: (c.scrollLeft + c.clientWidth / 2) / sw,
        fy: (c.scrollTop + c.clientHeight / 2) / sh,
      };
    }
    setScale(clamp(raw, MIN_SCALE, MAX_SCALE));
  }, []);

  // After the image resizes (scale or fit changed), re-centre the scroll on
  // the fraction captured before the zoom. The browser clamps out-of-range
  // scroll offsets, so shrinking back to fit lands at 0/0 (centred by the
  // flex `m-auto`).
  useLayoutEffect(() => {
    const c = wellRef.current;
    const p = pendingCenterRef.current;
    if (!c || !p) return;
    pendingCenterRef.current = null;
    c.scrollLeft = p.fx * c.scrollWidth - c.clientWidth / 2;
    c.scrollTop = p.fy * c.scrollHeight - c.clientHeight / 2;
  }, [scale, fit]);

  // Trackpad pinch, bound through a callback ref (not a useEffect keyed off
  // the ref) so the native, non-passive listener attaches the instant the
  // node mounts — no window where a missed effect run leaves pinch dead.
  // Non-passive is required to `preventDefault`. Only pinch (`wheel` +
  // `ctrlKey`, which macOS emits once pinch is enabled below) zooms; a plain
  // wheel / two-finger swipe is left untouched so it scrolls the well.
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const attachWell = useCallback(
    (node: HTMLDivElement | null): void => {
      wellRef.current = node;
      wheelCleanupRef.current?.();
      wheelCleanupRef.current = null;
      if (!node) return;
      const onWheel = (e: WheelEvent): void => {
        if (!e.ctrlKey) return; // plain scroll → let the well scroll
        e.preventDefault();
        setZoom(scaleRef.current * Math.exp(-e.deltaY / 100));
      };
      node.addEventListener('wheel', onWheel, { passive: false });
      wheelCleanupRef.current = () => node.removeEventListener('wheel', onWheel);
    },
    [setZoom],
  );

  // Enable trackpad pinch only while open (preload `setPinchZoom` →
  // `webFrame.setVisualZoomLevelLimits`). macOS Electron disables pinch by
  // default, and a disabled pinch is never dispatched to the page as
  // `ctrl+wheel` at all. Restore on close. Optional-chained so a renderer on
  // a not-yet-restarted preload can't throw.
  useEffect(() => {
    if (!open) return;
    window.silverhand.setPinchZoom?.(true);
    return () => window.silverhand.setPinchZoom?.(false);
  }, [open]);

  // Drag-to-pan: when the image overflows the well, grabbing it scrolls the
  // well (the hand-tool idiom), complementing native scroll. Capture the
  // pointer so a drag that leaves the image keeps panning.
  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>): void => {
    const c = wellRef.current;
    if (!c) return;
    const overflowing = c.scrollWidth > c.clientWidth || c.scrollHeight > c.clientHeight;
    if (!overflowing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, sl: c.scrollLeft, st: c.scrollTop };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>): void => {
    const c = wellRef.current;
    const d = dragRef.current;
    if (!c || !d) return;
    c.scrollLeft = d.sl - (e.clientX - d.px);
    c.scrollTop = d.st - (e.clientY - d.py);
  };
  const endDrag = (e: React.PointerEvent<HTMLImageElement>): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone (e.g. pointercancel) */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(scale * STEP);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setZoom(scale / STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      setZoom(1);
    }
  };

  const onCopy = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await fetch(src).then(r => r.blob());
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await window.silverhand.copyPngExport({ pngBytes: bytes });
      if (result.ok) {
        toast.success('Image copied to clipboard');
      } else {
        toast.error("Couldn't copy: " + result.error);
      }
    } catch (err) {
      toast.error("Couldn't copy: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const onSave = async (): Promise<void> => {
    if (downloading || !onDownload) return;
    setDownloading(true);
    try {
      await onDownload();
    } finally {
      setDownloading(false);
    }
  };

  const zoomed = scale > MIN_SCALE;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[90] bg-overlay-backdrop data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-modal-shell
          onKeyDown={onKeyDown}
          // FIXED-size viewport (not `h-fit w-fit` hugging the image): the
          // previewer stays one stable size, and zoom overflows the well into
          // scroll rather than growing the shell (shiki 2026-07-22 — hugging
          // made the whole modal grow with the image, then stall once it hit
          // the cap). Centered with `fixed inset-0 + margin:auto` (not
          // translate-50%): margin-auto keeps the box on whole device pixels so
          // the raster image stays crisp, whereas a 50% translate on an odd
          // size lands mid-pixel and blurs it (shiki "有时候图片不清晰").
          className="fixed inset-0 z-[91] m-auto flex flex-col overflow-hidden rounded-[var(--floating-radius,var(--radius-md))] border-[length:var(--control-border-width)] border-[color:var(--border-row-selected)] bg-bg-floating shadow-xl focus:outline-none"
          style={{ width: 'min(920px, 88vw)', height: '82vh' }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              Image Preview
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              data-sticker-close
              className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          {/* Image well. `flex` + child `m-auto` (NOT justify/items-center)
              centers the image in both axes when it fits, yet lets scroll
              reach every edge once it overflows — the standard fix for
              "flex centering clips overflow". The well itself is sized by
              the shell caps; only the image grows past it. */}
          <div
            ref={attachWell}
            className="flex min-h-0 flex-1 overflow-auto bg-bg-elevated p-3"
          >
            <img
              ref={imgRef}
              src={src}
              alt={alt}
              draggable={false}
              onLoad={computeFit}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              // Explicit `fit × scale` size (once measured) so the image
              // genuinely overflows the well past 100% and native scroll
              // engages. Before the first measure, fall back to the viewport
              // caps + object-contain so the first paint already fits (the
              // caps subtract the modal chrome from the 82vh / min(920,88vw)
              // shell — this is also what keeps a tall image fully visible).
              className="m-auto block shrink-0 select-none object-contain"
              style={
                fit
                  ? {
                      width: `${fit.w * scale}px`,
                      height: `${fit.h * scale}px`,
                      // Override Tailwind Preflight's `img { max-width: 100% }`
                      // — without this the explicit width is clamped to the
                      // well's width, so zoom past fit couldn't widen the image
                      // (it just stalled at 100% width; shiki 2026-07-22).
                      maxWidth: 'none',
                      maxHeight: 'none',
                      cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : 'default',
                    }
                  : {
                      maxWidth: 'calc(min(920px, 88vw) - 1.5rem)',
                      maxHeight: 'calc(82vh - 7rem)',
                    }
              }
            />
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={scale <= MIN_SCALE}
                onClick={() => setZoom(scale / STEP)}
                className="flex size-7 items-center justify-center rounded-[var(--control-radius)] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
              >
                <ZoomOut className="size-4" />
              </button>
              {/* Drag-to-zoom slider — reuses the Settings→Appearance font-size
                  slider chrome (both the `.settings-font-size-slider` base class
                  and the `data-settings-slider` forza6 hook) so the thumb/track
                  read identically across themes. `step="any"` = continuous
                  scaling; value/onChange are in percent to match the readout. */}
              <input
                type="range"
                data-settings-slider
                className="settings-font-size-slider w-28"
                min={MIN_SCALE * 100}
                max={MAX_SCALE * 100}
                step="any"
                value={scale * 100}
                aria-label="Zoom level"
                onChange={e => setZoom(Number(e.target.value) / 100)}
              />
              <button
                type="button"
                aria-label="Zoom in"
                disabled={scale >= MAX_SCALE}
                onClick={() => setZoom(scale * STEP)}
                className="flex size-7 items-center justify-center rounded-[var(--control-radius)] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
              >
                <ZoomIn className="size-4" />
              </button>
              {/* Percentage readout doubles as reset-to-fit. */}
              <button
                type="button"
                aria-label="Reset zoom to fit"
                disabled={scale === MIN_SCALE}
                onClick={() => setZoom(1)}
                className="flex h-7 min-w-[3.25rem] items-center justify-center rounded-[var(--control-radius)] px-1.5 tabular-nums text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
              >
                {Math.round(scale * 100)}%
              </button>
            </div>
            <div className="flex items-center gap-2">
              <SelectionActionButton
                rank={onDownload ? 'secondary' : 'primary'}
                label="Copy"
                disabled={busy}
                onClick={onCopy}
              />
              {onDownload ? (
                <SelectionActionButton
                  rank="primary"
                  icon={<Download className="size-3.5" />}
                  label="Download"
                  disabled={downloading}
                  onClick={() => void onSave()}
                />
              ) : null}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

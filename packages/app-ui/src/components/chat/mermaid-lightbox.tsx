import { RangeInput } from "@/components/ui/range-input";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePinchZoomLease } from "@/lib/pinch-zoom-lease";

interface MermaidLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The already-rendered, DOMPurify-sanitized SVG string (mermaid
   *  `securityLevel:'strict'`). The SAME string on screen — the modal never
   *  re-renders, so it can never drift from the inline diagram. */
  svg: string;
}

/** Same zoom idiom as {@link Lightbox}: fit-to-window is 1, zoom only grows
 *  above it, continuous slider + stepped buttons/keys. */
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const STEP = 1.25;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/**
 * Fullscreen Mermaid viewer. A read-only sibling of {@link Lightbox}
 * for a diagram: the same shell (`data-modal-shell` → forza6 poster drop shadow
 * + ink frame, elevation-only otherwise), the same zoom controls (−/slider/+ and `+` `−` `0`
 * keys, trackpad pinch), and the same drag-to-pan-plus-native-scroll well. It is
 * read-only on purpose — the inline block already owns Copy (source) and the
 * export path owns the image, so a diagram inspector adds only reach, not a
 * third copy surface.
 *
 * Unlike the image Lightbox the content is an SVG string, not a raster, so there
 * is no natural-size fit to measure and no crispness/whole-pixel concern: the
 * canvas fits the well at scale 1 (`max-width/height: 100%`) and CSS `transform`
 * scales it above, which is the SAME zoom mechanism the inline
 * `.mermaid-block__canvas` uses — the well is the pan viewport once
 * the diagram overflows. The shell is a fixed large viewport rather than the
 * image modal's hug-the-content box: a diagram has no "natural" on-screen size a
 * reader recognises, so a stable inspector frame reads better than one that
 * resizes per diagram.
 */
export function MermaidLightbox({ open, onOpenChange, svg }: MermaidLightboxProps): JSX.Element {
  const [scale, setScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const wellRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(1);
  // Viewport-centre fraction captured just before a zoom, re-applied after the
  // canvas resizes so zoom stays anchored on the middle of the view.
  const pendingCenterRef = useRef<{ fx: number; fy: number } | null>(null);
  // Drag-to-pan origin: pointer + scroll offset captured at pointerdown.
  const dragRef = useRef<{ px: number; py: number; sl: number; st: number } | null>(null);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // Reset zoom whenever the modal opens or the diagram changes — a stale zoom
  // carried in would open mid-scroll.
  useEffect(() => {
    setScale(1);
    pendingCenterRef.current = null;
  }, [open, svg]);

  const setZoom = useCallback((raw: number): void => {
    const next = clamp(raw, MIN_SCALE, MAX_SCALE);
    const c = wellRef.current;
    if (c) {
      const sw = c.scrollWidth || 1;
      const sh = c.scrollHeight || 1;
      pendingCenterRef.current = {
        fx: (c.scrollLeft + c.clientWidth / 2) / sw,
        fy: (c.scrollTop + c.clientHeight / 2) / sh,
      };
    }
    setScale(next);
  }, []);

  // After the canvas resizes, re-centre the scroll on the fraction captured
  // before the zoom. The browser clamps out-of-range offsets, so shrinking back
  // to fit lands centred.
  useLayoutEffect(() => {
    const c = wellRef.current;
    const p = pendingCenterRef.current;
    if (!c || !p) return;
    pendingCenterRef.current = null;
    c.scrollLeft = p.fx * c.scrollWidth - c.clientWidth / 2;
    c.scrollTop = p.fy * c.scrollHeight - c.clientHeight / 2;
  }, [scale]);

  // Trackpad pinch, attached through a callback ref so the native non-passive
  // listener is live the instant the well mounts. Only pinch (`wheel` +
  // `ctrlKey`) zooms; a plain wheel is left to scroll the well.
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const attachWell = useCallback(
    (node: HTMLDivElement | null): void => {
      wellRef.current = node;
      wheelCleanupRef.current?.();
      wheelCleanupRef.current = null;
      if (!node) return;
      const onWheel = (e: WheelEvent): void => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        setZoom(scaleRef.current * Math.exp(-e.deltaY / 100));
      };
      node.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanupRef.current = () => node.removeEventListener("wheel", onWheel);
    },
    [setZoom],
  );

  // Enable trackpad pinch only while open (macOS Electron disables it by
  // default, so `ctrl+wheel` is never dispatched otherwise). Refcounted so a
  // peer previewer mounted underneath keeps pinch alive when this one closes.
  usePinchZoomLease(open);

  // Drag-to-pan: when the diagram overflows the well, grabbing it scrolls the
  // well (the hand-tool idiom). Capture the pointer so a drag that leaves the
  // canvas keeps panning.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = wellRef.current;
    if (!c) return;
    const overflowing = c.scrollWidth > c.clientWidth || c.scrollHeight > c.clientHeight;
    if (!overflowing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, sl: c.scrollLeft, st: c.scrollTop };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = wellRef.current;
    const d = dragRef.current;
    if (!c || !d) return;
    c.scrollLeft = d.sl - (e.clientX - d.px);
    c.scrollTop = d.st - (e.clientY - d.py);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
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
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setZoom(scale * STEP);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      setZoom(scale / STEP);
    } else if (e.key === "0") {
      e.preventDefault();
      setZoom(1);
    }
  };

  const zoomed = scale > MIN_SCALE;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-lightbox) bg-overlay-backdrop data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-modal-shell
          onKeyDown={onKeyDown}
          aria-label="Diagram preview"
          className="fixed inset-0 z-(--z-lightbox-chrome) m-auto flex flex-col overflow-hidden rounded-(--floating-radius,var(--radius-md)) bg-bg-floating shadow-xl focus:outline-none"
          style={{ width: "min(1100px, 92vw)", height: "86vh" }}
        >
          <div
            data-modal-divider
            className="flex shrink-0 items-center gap-2 border-b-(length:--control-border-width) border-border-subtle px-3 py-2"
          >
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              Diagram
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              data-sticker-close
              data-sticker
              data-sticker-size="md"
              data-sticker-tone="neutral"
              className="flex size-7 shrink-0 items-center justify-center rounded-(--control-radius) text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-outline"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          {/* Diagram well. `flex` + child `m-auto` centres the diagram when it
              fits, yet lets scroll reach every edge once it overflows past 100%
              — the same "flex centering clips overflow" fix the image Lightbox
              uses. */}
          <div
            ref={attachWell}
            className="flex flex-1 overflow-auto p-4 scrollbar-hide"
            // The diagram surface reads the theme's diagram ground (forza6 is
            // white, not its dark code island); other themes fall back to the
            // modal's elevated surface.
            style={{ background: "var(--mermaid-diagram-bg, var(--bg-elevated))" }}
          >
            <div
              className="m-auto shrink-0"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              // transform-origin top-left + `overflow:auto` well = a pan surface
              // once scaled; `width:max-content` stops the pre-transform box from
              // being capped at the well width so the scrollable area grows.
              style={{
                width: "max-content",
                maxWidth: "100%",
                maxHeight: "100%",
                transformOrigin: "top left",
                transform: zoomed ? `scale(${scale})` : undefined,
                cursor: zoomed ? (dragging ? "grabbing" : "grab") : "default",
              }}
              // SVG is mermaid's `securityLevel:'strict'` (DOMPurify) output.
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
          <div
            data-modal-divider
            className="flex shrink-0 items-center gap-2 border-t-(length:--control-border-width) border-border-subtle px-3 py-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="neutral"
                size="icon"
                className="size-[22px] shrink-0"
                aria-label="Zoom out"
                disabled={scale <= MIN_SCALE}
                onClick={() => setZoom(scale / STEP)}
                data-zoom-stepper
              >
                <ZoomOut className="size-4" />
              </Button>
              {/* Same slider chrome as the image Lightbox / Settings font-size
                  slider so the thumb/track read identically across themes. */}
              <RangeInput
                className="w-28"
                min={MIN_SCALE * 100}
                max={MAX_SCALE * 100}
                step="any"
                value={scale * 100}
                aria-label="Zoom level"
                onChange={(e) => setZoom(Number(e.target.value) / 100)}
              />
              <Button
                type="button"
                variant="neutral"
                size="icon"
                className="size-[22px] shrink-0"
                aria-label="Zoom in"
                disabled={scale >= MAX_SCALE}
                onClick={() => setZoom(scale * STEP)}
                data-zoom-stepper
              >
                <ZoomIn className="size-4" />
              </Button>
              {/* Zoom level is a READOUT, not a control: no click / reset, no
                  button or sticker chrome. Reset is the `0` key (and stepping
                  with −). A visually-hidden "Zoom " prefix gives screen readers
                  "Zoom 150%", not a bare percentage. */}
              <span className="flex h-7 min-w-13 items-center justify-center px-1.5 tabular-nums text-text-secondary">
                <span className="sr-only">Zoom </span>
                {Math.round(scale * 100)}%
              </span>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

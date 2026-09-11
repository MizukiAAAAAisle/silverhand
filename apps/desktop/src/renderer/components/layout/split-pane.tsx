import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { AnimatedPanel } from "./animated-panel";
import { PANE_RADIUS } from "./pane-chrome";
import { SplitterTrack } from "./splitter-track";

interface SplitPaneProps {
  left: ReactNode;
  right?: ReactNode | null;
  /** Initial ratio of the left pane (0..1). Default 0.5. */
  defaultRatio?: number;
  /** localStorage key for persisting the user's drag position. */
  storageKey?: string;
  /** Bounds in absolute ratio. */
  minRatio?: number;
  maxRatio?: number;
}

export function SplitPane({
  left,
  right,
  defaultRatio = 0.5,
  storageKey,
  minRatio = 0.25,
  maxRatio = 0.75,
}: SplitPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const hasRight = right !== null && right !== undefined;
  // Let the shell paint before mounting heavy content, without retaining a closed pane.
  const contentReady = useDeferredValue(hasRight);

  const initialRatioRef = useRef<number>(
    (() => {
      if (!storageKey) {
        return defaultRatio;
      }
      try {
        const v = localStorage.getItem(storageKey);
        const n = v !== null ? Number(v) : NaN;
        if (Number.isFinite(n) && n >= minRatio && n <= maxRatio) {
          return n;
        }
      } catch {
        /* ignore */
      }
      return defaultRatio;
    })(),
  );

  const ratioRef = useRef(initialRatioRef.current);
  const dragFrameRef = useRef<number | null>(null);

  const updateGeometry = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const width = container.clientWidth;
    container.style.setProperty("--split-container-width", `${width}px`);
    container.style.setProperty("--split-left-width", `${width * ratioRef.current}px`);
  }, []);

  useLayoutEffect(() => {
    updateGeometry();
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateGeometry]);

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const persistRatio = useCallback(
    (next: number): void => {
      if (!storageKey) {
        return;
      }
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* quota or private mode — fall back to in-memory */
      }
    },
    [storageKey],
  );

  const scheduleRatio = useCallback(
    (next: number): void => {
      ratioRef.current = next;
      if (dragFrameRef.current !== null) {
        return;
      }
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = null;
        updateGeometry();
      });
    },
    [updateGeometry],
  );

  const flushRatio = useCallback((): void => {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    updateGeometry();
  }, [updateGeometry]);

  const dragging = useRef(false);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    dividerRef.current?.setAttribute("data-active", "true");
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) {
        return;
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) {
        return;
      }
      const next = (e.clientX - rect.left) / rect.width;
      const clamped = Math.min(maxRatio, Math.max(minRatio, next));
      scheduleRatio(clamped);
    },
    [minRatio, maxRatio, scheduleRatio],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) {
        return;
      }
      dragging.current = false;
      dividerRef.current?.removeAttribute("data-active");
      flushRatio();
      const next = ratioRef.current;
      persistRatio(next);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [flushRatio, persistRatio],
  );

  return (
    <div
      ref={containerRef}
      className="flex h-full min-w-0 flex-1 overflow-hidden"
      style={
        {
          // Match the previous left-pane ratio; the gutter is deducted from the right.
          "--split-right-width":
            "max(0px, calc(var(--split-container-width, 0px) - var(--split-left-width, 0px) - var(--pane-gap)))",
        } as React.CSSProperties
      }
    >
      <div className="flex h-full min-w-0 flex-1 overflow-hidden">
        <div
          className="flex h-full shrink-0 overflow-hidden"
          style={{
            width: hasRight ? "var(--split-left-width)" : "var(--split-container-width)",
            contain: "layout paint",
          }}
        >
          {left}
        </div>
      </div>
      <AnimatedPanel
        open={hasRight}
        width="calc(var(--split-right-width) + var(--pane-gap))"
        overlay={
          <div className="absolute inset-y-0 flex w-0" style={{ left: "var(--pane-gap)" }}>
            <SplitterTrack
              ref={dividerRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
        }
      >
        {() => (
          <div className="flex h-full min-w-0 flex-1" style={{ paddingLeft: "var(--pane-gap)" }}>
            <div
              style={{ contain: "layout paint", borderRadius: PANE_RADIUS }}
              className="flex h-full min-w-0 flex-1 overflow-hidden bg-bg-base"
            >
              {hasRight && contentReady ? right : null}
            </div>
          </div>
        )}
      </AnimatedPanel>
    </div>
  );
}

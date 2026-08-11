import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PANE_RADIUS } from './pane-chrome';

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

/** Width transition duration. Kept in sync with the CSS `transition`
 *  string on the left pane below. Two-stage mount uses it to time when
 *  the heavy `right` content lands. */
const TRANSITION_MS = 220;
const TRANSITION_CSS = '220ms cubic-bezier(0.4, 0, 0.2, 1)';

/**
 * Vertical split pane (two panes side-by-side, draggable divider).
 *
 * Open / close is two-stage to avoid jank when the right side is heavy
 * (e.g. opening a thread mounts a fresh ChannelView that fires 4+ react
 * queries on mount): the shell mounts first and the width animates,
 * then — after the width transition completes — the actual `right`
 * content mounts into the now-stable pane. Closing is the mirror: drop
 * heavy content first, animate the left pane back, then unmount shell.
 *
 * Width is driven by a single CSS custom property `--split-left-width`
 * that we write directly via `setProperty` — we deliberately do NOT
 * keep it in React `style` props, because re-renders would clobber
 * mid-transition values and prevent the CSS transition from firing at
 * all. The initial value is seeded via `useLayoutEffect` so first
 * paint is correct without any visible jump.
 *
 * Drag pathway: pointer move drives the same CSS variable via rAF +
 * `setProperty`. The width transition is suppressed for the duration
 * of the drag by writing `transition: none` directly on the left pane
 * so the divider tracks the cursor 1:1.
 */
export function SplitPane({
  left,
  right,
  defaultRatio = 0.5,
  storageKey,
  minRatio = 0.25,
  maxRatio = 0.75,
}: SplitPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const hasRight = right !== null && right !== undefined;

  const initialRatioRef = useRef<number>(
    (() => {
      if (!storageKey) return defaultRatio;
      try {
        const v = localStorage.getItem(storageKey);
        const n = v !== null ? Number(v) : NaN;
        if (Number.isFinite(n) && n >= minRatio && n <= maxRatio) return n;
      } catch {
        /* ignore */
      }
      return defaultRatio;
    })(),
  );

  const ratioRef = useRef(initialRatioRef.current);
  const dragFrameRef = useRef<number | null>(null);

  // Lagging visibility state. `shellOpen` controls whether the divider
  // and right-pane wrapper are mounted; `contentMounted` controls
  // whether the actual `right` payload is rendered inside that wrapper.
  // Initial mount with hasRight=true skips the animation so first paint
  // doesn't slide in from nothing.
  const [shellOpen, setShellOpen] = useState(hasRight);
  const [contentMounted, setContentMounted] = useState(hasRight);

  const openRafRef = useRef<number | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearOpenScheduled = useCallback(() => {
    if (openRafRef.current !== null) {
      cancelAnimationFrame(openRafRef.current);
      openRafRef.current = null;
    }
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const clearCloseScheduled = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const setLeftWidthVar = useCallback((value: string) => {
    containerRef.current?.style.setProperty('--split-left-width', value);
  }, []);

  // Seed the CSS variable before first paint. useLayoutEffect runs
  // synchronously between commit and paint, so the very first frame
  // already has the right width — no inline style on the container,
  // which means React re-renders cannot clobber animated values.
  useLayoutEffect(() => {
    setLeftWidthVar(
      hasRight ? `${ratioRef.current * 100}%` : '100%',
    );
    // Intentional: this runs once at mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive shell / content mount lifecycle from `hasRight`.
  // First render's states already match `hasRight`, so this effect
  // only does work on real transitions (skipped on initial mount).
  const prevHasRightRef = useRef(hasRight);
  useEffect(() => {
    if (prevHasRightRef.current === hasRight) return;
    prevHasRightRef.current = hasRight;

    if (hasRight) {
      // OPEN: at this point shellOpen/contentMounted are false from
      // the previous close. The current DOM `--split-left-width` is
      // already '100%' (close path set it). Mount the shell, then on
      // the next frame flip the width — that gap is what lets the CSS
      // transition pick up the change instead of folding both
      // mutations into a single commit.
      clearCloseScheduled();
      setShellOpen(true);

      clearOpenScheduled();
      openRafRef.current = requestAnimationFrame(() => {
        openRafRef.current = null;
        setLeftWidthVar(`${ratioRef.current * 100}%`);
        openTimerRef.current = window.setTimeout(() => {
          openTimerRef.current = null;
          // `startTransition` lets React interrupt the heavy
          // ChannelView mount if the user keeps interacting, so the
          // splitter remains responsive even mid-mount.
          startTransition(() => {
            setContentMounted(true);
          });
        }, TRANSITION_MS);
      });
      return;
    }

    // CLOSE: unmount the heavy payload immediately so the main thread
    // is free to animate, flip the width target back to 100% so the
    // CSS transition fires, then unmount the shell after the
    // animation completes.
    clearOpenScheduled();
    setContentMounted(false);
    setLeftWidthVar('100%');

    clearCloseScheduled();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setShellOpen(false);
    }, TRANSITION_MS);
  }, [
    hasRight,
    clearOpenScheduled,
    clearCloseScheduled,
    setLeftWidthVar,
  ]);

  // Cleanup pending timers + drag styles on unmount.
  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
      }
      clearOpenScheduled();
      clearCloseScheduled();
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [clearOpenScheduled, clearCloseScheduled]);

  const persistRatio = useCallback((next: number): void => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* quota or private mode — fall back to in-memory */
    }
  }, [storageKey]);

  const scheduleRatio = useCallback((next: number): void => {
    ratioRef.current = next;
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      setLeftWidthVar(`${ratioRef.current * 100}%`);
    });
  }, [setLeftWidthVar]);

  const flushRatio = useCallback((): void => {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    setLeftWidthVar(`${ratioRef.current * 100}%`);
  }, [setLeftWidthVar]);

  const dragging = useRef(false);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    dividerRef.current?.setAttribute('data-active', 'true');
    // Suppress the width transition for the duration of the drag so
    // the pane tracks the cursor 1:1 instead of trailing behind.
    if (leftPaneRef.current) {
      leftPaneRef.current.style.transition = 'none';
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = (e.clientX - rect.left) / rect.width;
      const clamped = Math.min(maxRatio, Math.max(minRatio, next));
      scheduleRatio(clamped);
    },
    [minRatio, maxRatio, scheduleRatio],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      dividerRef.current?.removeAttribute('data-active');
      // Restore the width transition that onPointerDown suppressed.
      if (leftPaneRef.current) {
        leftPaneRef.current.style.transition = `width ${TRANSITION_CSS}`;
      }
      flushRatio();
      const next = ratioRef.current;
      persistRatio(next);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [flushRatio, persistRatio],
  );

  return (
    <div
      ref={containerRef}
      className="flex h-full min-w-0 flex-1 overflow-hidden"
      // The gutter between left | right is `--pane-gap`, same token the
      // section sheet uses between sidebar | page — so the two seams a user
      // sees side by side (sidebar↔conversation via VerticalSplitter, and
      // conversation↔thread here) are always the SAME width. Without this the
      // divider was a bare 4px flex item flush against both panes: an 8px
      // gutter on the left, a 4px lane in the middle (#task:1965 residual,
      // #task:1971). The divider straddles the gap with a negative margin
      // (see below), so the VISIBLE distance stays exactly `--pane-gap`.
      style={{ gap: 'var(--pane-gap, var(--frame-padding, 0px))' }}
    >
      <div
        ref={leftPaneRef}
        // `contain: layout paint` isolates the left pane's layout from
        // the right pane's reconciliation, so opening a thread doesn't
        // ripple a reflow through the message list.
        style={{
          width: 'var(--split-left-width)',
          transition: `width ${TRANSITION_CSS}`,
          contain: 'layout paint',
        }}
        className="flex h-full min-w-0 overflow-hidden"
      >
        {left}
      </div>
      {shellOpen ? (
        <>
          <div
            ref={dividerRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // Same paint vocabulary as VerticalSplitter — the track is
            // transparent by default (themes set --splitter-bg: transparent),
            // tints with --splitter-hover-bg (neutral safety-net fallback
            // `--border`, never `--accent`) on hover, and stays that colour for
            // the duration of an active drag. `transition-colors` smooths the
            // hover fade so the divider doesn't pop in/out. Every theme sets
            // --splitter-hover-bg (fence-enforced) — see VerticalSplitter.tsx
            // for the full rationale.
            //
            // GEOMETRY mirrors VerticalSplitter exactly: the container sets a
            // `--pane-gap` gap, and this negative inline margin pulls the 4px
            // track back so the VISIBLE distance between panes stays that gap
            // with the track centred in it. `zIndex` keeps a later positioned
            // sibling from painting over the track's half at gap 0 (where it
            // straddles the seam ±2px). Derived from `--pane-gap` so a theme
            // changing its gap gets a matching seam here for free.
            style={{
              marginInline:
                'calc((var(--pane-gap, var(--frame-padding, 0px)) + 4px) / -2)',
              zIndex: 1,
            }}
            className={
              'group/split relative w-1 shrink-0 cursor-col-resize bg-[var(--splitter-bg,var(--border-subtle))] transition-colors hover:bg-[var(--splitter-hover-bg,var(--border))] data-[active=true]:bg-[var(--splitter-hover-bg,var(--border))]'
            }
            role="separator"
            aria-orientation="vertical"
          >
            {/* Wider invisible hit-target so users don't need pixel-perfect aim. */}
            <div className="absolute -inset-x-1.5 inset-y-0" />
          </div>
          <div
            // Same containment for the right pane — and we deliberately
            // delay rendering `right` until after the width transition
            // completes so the heavy mount (queries, message list,
            // etc.) doesn't compete with the animation for the main
            // thread. While `right` is unmounted, the wrapper paints
            // `bg-bg-chat` so the 220ms gap matches the destination
            // ChannelView's background instead of revealing the App's
            // `bg-bg-base` underneath.
            //
            // `borderRadius` mirrors the inner card chrome
            // (`--card-radius`) so the same-coloured filler doesn't
            // square off the inner ChannelView's rounded corners. Without
            // this, the wrapper's sharp rectangle paints into the corner
            // area that the inner card visually rounds away — producing
            // asymmetric header radii (left pane keeps its rounded
            // corners against App `bg-bg-base`, right pane looks square).
            // Radius only — deliberately NOT the full `paneChrome`: this
            // wrapper is a filler behind a real pane, and lifting it too
            // would double the shadow under the inner one.
            style={{
              contain: 'layout paint',
              borderRadius: PANE_RADIUS,
            }}
            className="flex h-full min-w-0 flex-1 overflow-hidden bg-bg-chat"
          >
            {contentMounted ? right : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

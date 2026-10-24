import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { hasCollapsibleSidebar } from "./sidebar-slot";
import type { AppSection } from "./nav-rail";

const CLOSE_DELAY_MS = 200;
// How long a pointer may rest on another rail item, while it was heading for
// the open sidebar, before that item takes over.
const SWITCH_DELAY_MS = 150;

interface Point {
  x: number;
  y: number;
}

/** Whether the last pointer step points into the sidebar's leading edge: the
 *  step's end lies inside the triangle formed by its start and the edge's two
 *  ends. A purely vertical step has no area there, so it switches at once. */
export function headingForEdge(
  from: Point,
  to: Point,
  edge: { x: number; top: number; bottom: number },
): boolean {
  const a = { x: edge.x, y: edge.top };
  const b = { x: edge.x, y: edge.bottom };
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(from, a, to);
  const d2 = side(a, b, to);
  const d3 = side(b, from, to);
  return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
}

export interface SidebarPeek {
  /** Section whose sidebar is floating, or null while closed. */
  section: AppSection | null;
  /** Last peeked section; its sidebar stays mounted after close so dialogs it
   *  opened survive the pointer leaving. */
  mountedSection: AppSection | null;
  /** Rail item hover. A section without a browse sidebar closes the peek. */
  hover: (section: AppSection) => void;
  /** Pointer is over the floating sidebar. */
  hold: () => void;
  /** Pointer left the rail or the floating sidebar. */
  leave: () => void;
  /** The floating surface, measured for the safe triangle. */
  surfaceRef: RefObject<HTMLDivElement>;
}

/** Hover peek of the hidden browse sidebar from the nav rail (regular layout,
 *  a hover-capable pointer attached; touch-generated hovers are ignored by the
 *  callers). The peek floats over the page and never takes width.
 *
 *  While a sidebar is open, a pointer travelling diagonally from its rail item
 *  to it crosses neighbouring items. Those hovers are deferred while the
 *  pointer keeps heading for the sidebar (the menu "safe triangle"), and take
 *  over once it rests or turns away. */
export function useSidebarPeek(enabled: boolean): SidebarPeek {
  const [section, setSection] = useState<AppSection | null>(null);
  const [mountedSection, setMountedSection] = useState<AppSection | null>(null);
  const timer = useRef<number | null>(null);
  const switchTimer = useRef<number | null>(null);
  const pending = useRef<AppSection | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const points = useRef<{ from: Point | null; to: Point | null }>({ from: null, to: null });

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const clearPending = useCallback(() => {
    if (switchTimer.current !== null) {
      clearTimeout(switchTimer.current);
      switchTimer.current = null;
    }
    pending.current = null;
  }, []);

  const show = useCallback(
    (next: AppSection) => {
      clearTimer();
      clearPending();
      if (!hasCollapsibleSidebar(next)) {
        setSection(null);
        return;
      }
      setSection(next);
      setMountedSection(next);
    },
    [clearTimer, clearPending],
  );

  const headingForSidebar = useCallback(() => {
    const { from, to } = points.current;
    const surface = surfaceRef.current?.getBoundingClientRect();
    if (!from || !to || !surface) {
      return false;
    }
    return headingForEdge(from, to, { x: surface.left, top: surface.top, bottom: surface.bottom });
  }, []);

  const deferSwitch = useCallback(
    (next: AppSection) => {
      if (switchTimer.current !== null) {
        clearTimeout(switchTimer.current);
      }
      pending.current = next;
      switchTimer.current = window.setTimeout(() => show(next), SWITCH_DELAY_MS);
    },
    [show],
  );

  const hover = useCallback(
    (next: AppSection) => {
      if (section !== null && next !== section && headingForSidebar()) {
        clearTimer();
        deferSwitch(next);
        return;
      }
      show(next);
    },
    [section, headingForSidebar, clearTimer, deferSwitch, show],
  );

  useEffect(() => {
    if (!enabled || section === null) {
      points.current = { from: null, to: null };
      return;
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        return;
      }
      points.current = { from: points.current.to, to: { x: event.clientX, y: event.clientY } };
      const next = pending.current;
      if (next !== null) {
        if (headingForSidebar()) {
          deferSwitch(next);
        } else {
          show(next);
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [enabled, section, headingForSidebar, deferSwitch, show]);

  const hold = useCallback(() => {
    clearTimer();
    clearPending();
  }, [clearTimer, clearPending]);

  const leave = useCallback(() => {
    clearTimer();
    clearPending();
    const close = () => {
      // A menu opened from a sidebar row is portaled outside it; keep the
      // sidebar under the menu until it closes.
      if (document.querySelector('[role="menu"]')) {
        timer.current = window.setTimeout(close, CLOSE_DELAY_MS);
        return;
      }
      timer.current = null;
      setSection(null);
    };
    timer.current = window.setTimeout(close, CLOSE_DELAY_MS);
  }, [clearTimer, clearPending]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      clearPending();
      setSection(null);
    }
  }, [enabled, clearTimer, clearPending]);

  useEffect(
    () => () => {
      clearTimer();
      clearPending();
    },
    [clearTimer, clearPending],
  );

  return useMemo(
    () => ({
      section: enabled ? section : null,
      mountedSection: enabled ? mountedSection : null,
      hover: enabled ? hover : noop,
      hold,
      leave,
      surfaceRef,
    }),
    [enabled, section, mountedSection, hover, hold, leave],
  );
}

function noop(): void {}

/**
 * The floating sidebar, positioned over the section sheet's left edge at the
 * shared `--sidebar-width`. Absolutely positioned inside the app frame, so the
 * page underneath keeps its full width.
 */
export function SidebarPeekLayer({
  peek,
  children,
}: {
  peek: SidebarPeek;
  children: ReactNode;
}): JSX.Element | null {
  if (!peek.mountedSection) {
    return null;
  }
  const open = peek.section !== null;

  return (
    <div className="sidebar-peek" data-state={open ? "open" : "closed"}>
      <div
        ref={peek.surfaceRef}
        className="sidebar-surface"
        data-state={open ? "open" : "closed"}
        style={{ width: "var(--sidebar-width)" }}
        onPointerEnter={open ? (event) => event.pointerType !== "touch" && peek.hold() : undefined}
        onPointerLeave={open ? (event) => event.pointerType !== "touch" && peek.leave() : undefined}
        {...(open ? {} : { inert: "" })}
        aria-hidden={open ? undefined : true}
      >
        {children}
      </div>
    </div>
  );
}

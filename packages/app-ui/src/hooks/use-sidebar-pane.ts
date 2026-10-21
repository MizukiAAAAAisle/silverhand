import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Sidebar visibility with a slide transition. The surface stays mounted while
 * hidden, so both directions are a plain CSS transition on `data-state`.
 * `transitioning` covers the slide only: consumers gate layout transitions on
 * it so a drag-resize of `--sidebar-width` is not animated.
 */

const SIDEBAR_ANIM_MS = 220;

interface UseSidebarPaneOptions {
  /** localStorage key for the user's persisted visible intent. */
  storageKey: string;
  /** Default visible value when storage is empty or unreadable. */
  defaultVisible: boolean;
}

export interface SidebarPane {
  /** User's persisted visible intent. */
  visible: boolean;
  /** Drives the surface's `data-state`. */
  surfaceState: "open" | "closed";
  /** True only while the open/close transition is in flight. */
  transitioning: boolean;
  setVisible: (next: boolean) => void;
  toggle: () => void;
}

function readVisible(key: string, defaultVisible: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") {
      return true;
    }
    if (raw === "0") {
      return false;
    }
    return defaultVisible;
  } catch {
    return defaultVisible;
  }
}

function persistVisible(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* private mode / quota — in-memory state still wins */
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useSidebarPane({ storageKey, defaultVisible }: UseSidebarPaneOptions): SidebarPane {
  const [visible, setVisibleState] = useState(() => readVisible(storageKey, defaultVisible));
  const [transitioning, setTransitioning] = useState(false);

  const settleTimer = useRef<number | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    return () => {
      if (settleTimer.current !== null) {
        clearTimeout(settleTimer.current);
      }
    };
  }, []);

  const setVisible = useCallback(
    (next: boolean) => {
      persistVisible(storageKey, next);
      setVisibleState(next);

      if (settleTimer.current !== null) {
        clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }

      if (prefersReducedMotion()) {
        setTransitioning(false);
        return;
      }

      setTransitioning(true);
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        setTransitioning(false);
      }, SIDEBAR_ANIM_MS);
    },
    [storageKey],
  );

  const toggle = useCallback(() => {
    setVisible(!visibleRef.current);
  }, [setVisible]);

  return {
    visible,
    surfaceState: visible ? "open" : "closed",
    transitioning,
    setVisible,
    toggle,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hasCollapsibleSidebar } from "./sidebar-slot";
import type { AppSection } from "./nav-rail";

const CLOSE_DELAY_MS = 200;

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
}

/** Hover peek of the hidden browse sidebar from the nav rail (regular layout,
 *  fine pointer). The peek floats over the page and never takes width. */
export function useSidebarPeek(enabled: boolean): SidebarPeek {
  const [section, setSection] = useState<AppSection | null>(null);
  const [mountedSection, setMountedSection] = useState<AppSection | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const hover = useCallback(
    (next: AppSection) => {
      clearTimer();
      if (!hasCollapsibleSidebar(next)) {
        setSection(null);
        return;
      }
      setSection(next);
      setMountedSection(next);
    },
    [clearTimer],
  );

  const leave = useCallback(() => {
    clearTimer();
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
  }, [clearTimer]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      setSection(null);
    }
  }, [enabled, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return useMemo(
    () => ({
      section: enabled ? section : null,
      mountedSection: enabled ? mountedSection : null,
      hover: enabled ? hover : noop,
      hold: clearTimer,
      leave,
    }),
    [enabled, section, mountedSection, hover, clearTimer, leave],
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
        className="sidebar-surface"
        data-state={open ? "open" : "closed"}
        style={{ width: "var(--sidebar-width)" }}
        onPointerEnter={open ? peek.hold : undefined}
        onPointerLeave={open ? peek.leave : undefined}
        {...(open ? {} : { inert: "" })}
        aria-hidden={open ? undefined : true}
      >
        {children}
      </div>
    </div>
  );
}
